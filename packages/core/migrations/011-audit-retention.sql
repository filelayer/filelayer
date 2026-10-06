-- =============================================================================
-- 011 — audit retention: checkpoints, a trimmable chain, and a deletable tenant
-- =============================================================================
--
-- Schema version 10 -> 11. Introduced in 0.16.0.
--
-- Run this inside a transaction. It is all DDL on one table plus one new table,
-- and partial application would leave a chain that can be deleted from with
-- nothing to record the deletion, which is the one state worse than the one
-- this fixes.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS CHANGES, AND WHY EACH PART IS HERE
-- -----------------------------------------------------------------------------
--
-- 1. DROPS THE FOREIGN KEY ON `audit_event.org_id`.
--
--    It was `REFERENCES org(id) ON DELETE CASCADE`. A cascade is a DELETE,
--    `audit_no_delete` rewrote that DELETE to nothing, and Postgres then found
--    its own referential-integrity check had returned something impossible:
--
--        referential integrity query on "org" from constraint
--        "audit_event_org_id_fkey" on "audit_event" gave unexpected result
--
--    So a tenant that had ever been audited could not be deleted. That is every
--    tenant, because creating one is an audited action. The column keeps its
--    meaning and loses the constraint, exactly as `actor_id`, `file_id` and
--    `grant_id` did before it and for the same stated reason: an audit log that
--    forgets what happened when its subject goes away is not an audit log.
--
--    AFTER THIS RUNS, deleting an org no longer deletes its audit history. If
--    you were relying on the cascade to erase a tenant, you were not: it raised.
--    Erasure is now `trimAuditChain(org, { keepLast: 0 })` followed by the org
--    delete, and it leaves a checkpoint saying it happened.
--
-- 2. MAKES THE DELETE RULE CONDITIONAL on a session declaration.
--
--    `SET LOCAL filelayer.audit_trim = 'on'` inside a transaction lifts it for
--    that transaction only. Without the declaration the behaviour is exactly
--    what it was: the DELETE is rewritten to nothing, silently. This is not a
--    privilege boundary and never was; it stops an accident and an application
--    bug.
--
-- 3. ADDS `audit_checkpoint`, which is what makes a trimmed chain verifiable.
--    Cutting a hash chain from the front leaves a remainder indistinguishable
--    from a tampered one. A checkpoint records the hash the chain had reached
--    at the cut, so verification can tell a recorded trim from a deletion
--    nobody admits to. An unattested gap is still reported as tampering, which
--    is the property that makes the rest of this safe.
--
-- 4. REWRITES `audit_no_truncate()` to name the table from `TG_TABLE_NAME`,
--    because the same guard is now attached to two tables and a message naming
--    the wrong one sends the reader to the wrong place.

BEGIN;

-- Refuse a database that is not where this migration expects to start.
DO $$
BEGIN
    IF to_regclass('public.audit_checkpoint') IS NOT NULL THEN
        RAISE EXCEPTION
            'migration 011 is already applied: audit_checkpoint exists. Nothing to do.';
    END IF;
    IF to_regclass('public.audit_event') IS NULL THEN
        RAISE EXCEPTION
            'migration 011 expects schema version 10, and audit_event does not exist. '
            'Apply schema.sql to create the schema whole instead.';
    END IF;
END;
$$;

-- --- 1. the cascade that made a tenant undeletable ---------------------------
ALTER TABLE audit_event DROP CONSTRAINT IF EXISTS audit_event_org_id_fkey;

-- --- 2. the delete rule becomes a declaration --------------------------------
DROP RULE audit_no_delete ON audit_event;
CREATE RULE audit_no_delete AS ON DELETE TO audit_event
    WHERE coalesce(current_setting('filelayer.audit_trim', true), 'off') <> 'on'
    DO INSTEAD NOTHING;

-- --- 3. the checkpoints -------------------------------------------------------
CREATE TABLE audit_checkpoint (
    id                bigserial PRIMARY KEY,
    org_id            uuid,
    kind              text NOT NULL CHECK (kind IN ('trim', 'seal')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    through_event_id  bigint NOT NULL,
    through_hash      text NOT NULL,
    removed_count     bigint NOT NULL DEFAULT 0 CHECK (removed_count >= 0),
    removed_from      timestamptz,
    removed_to        timestamptz,
    note              text NOT NULL,
    CONSTRAINT checkpoint_seal_removes_nothing CHECK (
        kind <> 'seal' OR (removed_count = 0 AND removed_from IS NULL AND removed_to IS NULL)
    ),
    CONSTRAINT checkpoint_trim_removes_something CHECK (
        kind <> 'trim' OR (removed_count > 0 AND removed_from IS NOT NULL AND removed_to IS NOT NULL)
    )
);

CREATE INDEX audit_checkpoint_org_idx  ON audit_checkpoint (org_id, id DESC);
CREATE INDEX audit_checkpoint_hash_idx ON audit_checkpoint (through_hash);

-- --- 4. one truncate guard, two tables ---------------------------------------
CREATE OR REPLACE FUNCTION audit_no_truncate() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: TRUNCATE is refused', TG_TABLE_NAME
        USING ERRCODE = 'raise_exception';
END;
$$;

CREATE RULE checkpoint_no_update AS ON UPDATE TO audit_checkpoint DO INSTEAD NOTHING;
CREATE RULE checkpoint_no_delete AS ON DELETE TO audit_checkpoint DO INSTEAD NOTHING;

CREATE TRIGGER checkpoint_no_truncate
    BEFORE TRUNCATE ON audit_checkpoint
    FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();

-- --- the stamp ---------------------------------------------------------------
INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (11, '0.16.0', 'audit retention: checkpoints, a conditional delete rule, and audit_event.org_id without its cascade');

COMMIT;
