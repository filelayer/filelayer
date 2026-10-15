-- =============================================================================
-- 015 — job_run, so "the sweeper did not run" is an absence and not silence
-- =============================================================================
--
-- Schema version 14 -> 15. Introduced in 0.33.0.
--
-- Run this inside a transaction. One table, its index, and the three guards
-- that make it append-only; a partial application would leave a table that
-- accepts a DELETE, and a failed run that can be deleted is a failed run that
-- gets deleted.
--
-- Additive. Nothing reads or writes this table before this migration, no
-- existing column changes, and nothing needs backfilling: a deployment that has
-- never recorded a run reads as "never ran", which is the truth.
--
-- -----------------------------------------------------------------------------
-- WHAT IT IS FOR
-- -----------------------------------------------------------------------------
--
-- Three of the four jobs this library asks an operator to schedule are
-- published limitations in their own right -- entry 9 (storage orphans),
-- entry 4 (upload reservations), entry 12 (audit trim and seal) -- and each one
-- says that nothing calls it for you.
--
-- The gap is the same shape as limitation 11. Truncation of the most recent
-- audit events is undetectable because nothing records where the chain was
-- supposed to end, so what remains verifies cleanly. A maintenance job has
-- exactly that problem: A JOB THAT NEVER REPORTS IS INDISTINGUISHABLE FROM ONE
-- THAT RAN AND FOUND NOTHING TO DO. Both are silence. An operator whose cron
-- has been failing for six weeks has no signal at all, and the first symptom is
-- a storage bill or a table nobody can query.
--
-- So every run leaves a row, INCLUDING ONE THAT FAILED, and `jobStatus()`
-- enumerates the four jobs rather than summarising the rows -- because "no
-- rows" has to read as "none of this has ever happened" and not as "nothing to
-- report".
--
-- -----------------------------------------------------------------------------
-- NO FOREIGN KEY ON org_id, AND THAT IS A LESSON
-- -----------------------------------------------------------------------------
--
-- Migration 011 had to DROP the foreign key on `audit_event.org_id`: with
-- `ON DELETE CASCADE` and the append-only rule, Postgres found its own
-- referential-integrity check returning something impossible and every audited
-- tenant became undeletable. A record of work done must survive its subject
-- going away, for the same reason an audit event must.
--
-- -----------------------------------------------------------------------------
-- APPEND-ONLY, AND NOT HASH-CHAINED
-- -----------------------------------------------------------------------------
--
-- The same two rules and truncate guard as `audit_checkpoint`. Not chained, and
-- that is the honest line: this is an operational record and not evidence, and
-- chaining it would claim a property it does not have.
--
-- It has no retention job of its own and does not need one: one row per job
-- execution is on the order of four rows a day, so a year is under two
-- thousand.
--
-- `mode` IS TEXT AND NOT A BOOLEAN. `security.test.ts` asserts that no boolean
-- column exists anywhere in this schema -- that is how P1's "there is no
-- `public` flag" is enforced rather than merely stated -- and it refused the
-- first draft of this table. `'live'` also reads correctly in a query result,
-- where `dry_run = false` needs the reader to remember the polarity.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('audit_checkpoint') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 015: no audit_checkpoint table, so this database is older than 0.16.0. Apply the outstanding migrations first; schemaStatus(db) lists them.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF to_regclass('job_run') IS NOT NULL THEN
        RAISE EXCEPTION
            'filelayer migration 015 is already applied: job_run exists. Nothing to do.';
    END IF;
    -- `audit_no_truncate()` is created by migration 006 and reused here. If it
    -- is absent, the truncate guard below would be created against nothing.
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'audit_no_truncate') THEN
        RAISE EXCEPTION
            'filelayer migration 015: the audit_no_truncate() function is absent, so the truncate guard on job_run cannot be created. Apply migration 006 first.'
            USING ERRCODE = 'undefined_function';
    END IF;
END;
$$;

CREATE TABLE job_run (
    id           bigserial PRIMARY KEY,
    job          text NOT NULL CHECK (job IN (
                     'storage_orphans', 'upload_reservations',
                     'audit_trim', 'audit_seal'
                 )),
    org_id       uuid,
    started_at   timestamptz NOT NULL,
    finished_at  timestamptz NOT NULL DEFAULT now(),
    outcome      text NOT NULL CHECK (outcome IN ('ok', 'failed')),
    mode         text NOT NULL CHECK (mode IN ('dry', 'live')),
    scanned      bigint,
    acted        bigint,
    detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
    error        text,

    CONSTRAINT job_run_error_iff_failed CHECK ((outcome = 'failed') = (error IS NOT NULL)),
    CONSTRAINT job_run_counts_iff_ok CHECK (
        outcome <> 'ok' OR (scanned IS NOT NULL AND acted IS NOT NULL)
    ),
    CONSTRAINT job_run_finished_after_started CHECK (finished_at >= started_at)
);

CREATE INDEX job_run_latest_idx ON job_run (job, org_id, id DESC);

CREATE RULE job_run_no_update AS ON UPDATE TO job_run DO INSTEAD NOTHING;
CREATE RULE job_run_no_delete AS ON DELETE TO job_run DO INSTEAD NOTHING;

CREATE TRIGGER job_run_no_truncate
    BEFORE TRUNCATE ON job_run
    FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();

INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (15, '0.33.0', 'job_run: every maintenance job leaves a row, including a failed one, so a job that never ran is an absence rather than silence')
ON CONFLICT (version) DO NOTHING;

COMMIT;
