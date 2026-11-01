-- =============================================================================
-- 016 — filelayer_install, one random id for the local usage report
-- =============================================================================
--
-- Schema version 15 -> 16. Introduced in 0.35.0.
--
-- Run this inside a transaction. Additive: one table and one index. Nothing
-- reads or writes it before this migration, and it starts empty; the first
-- usage report writes its single row.
--
-- -----------------------------------------------------------------------------
-- WHAT IT IS FOR
-- -----------------------------------------------------------------------------
--
-- `buildUsageReport()` and `filelayer usage-report` produce a file describing
-- one week of a deployment, which the operator may choose to share. Two
-- reports from the same deployment weeks apart have to be recognisable as one
-- deployment, or "still running fourteen days later" cannot be shown. So the
-- first report stores a random id here and every later report repeats it.
--
-- It is linked to nothing: no org, no actor, no host name. Deleting the row is
-- allowed and gives the deployment a new identity on the next report. One row
-- at most, enforced by a unique index on a constant expression.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('job_run') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 016: no job_run table, so this database is older than 0.33.0. Apply the outstanding migrations first; schemaStatus(db) lists them.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF to_regclass('filelayer_install') IS NOT NULL THEN
        RAISE EXCEPTION
            'filelayer migration 016 is already applied: filelayer_install exists. Nothing to do.';
    END IF;
END;
$$;

CREATE TABLE filelayer_install (
    id          uuid PRIMARY KEY,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX filelayer_install_one_row ON filelayer_install ((1));

INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (16, '0.35.0', 'filelayer_install: one random id, written by the first local usage report, linked to nothing')
ON CONFLICT (version) DO NOTHING;

COMMIT;
