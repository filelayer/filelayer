-- =============================================================================
-- 006 — TRUNCATE on the audit log is refused
-- =============================================================================
-- entry:          MIGRATIONS.md Entry 6
-- from:           0.6.0
-- to:             0.7.0
-- transactional:  yes
-- decision:       no
--
-- The rules on `audit_event` already made UPDATE and DELETE no-ops. TRUNCATE
-- goes around a rule, so one statement emptied an append-only table. A
-- statement-level BEFORE TRUNCATE trigger refuses it.
--
-- THE REVOKE IS NOT PART OF THIS FILE. Entry 6's second block is
-- `REVOKE TRUNCATE, DELETE, UPDATE ON audit_event FROM <your_app_role>`, which
-- carries a placeholder only you can fill and is a hardening recommendation
-- rather than a schema change. It belongs in your own grants management. Do it:
-- a trigger refuses the statement, and a privilege means the statement is never
-- reached. The trigger's owner can also drop the trigger, which is stated in
-- the README's limitations and is why the privilege matters.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger t
                 JOIN pg_class c ON c.oid = t.tgrelid
                WHERE c.relname = 'audit_event'
                  AND t.tgname = 'audit_no_truncate') THEN
        RAISE EXCEPTION
            'filelayer migration 006: already applied (trigger audit_no_truncate exists). Nothing to do.'
            USING ERRCODE = 'duplicate_object';
    END IF;
    IF to_regclass('audit_event') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 006: no audit_event table. This database does not hold a filelayer schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
END $$;

CREATE FUNCTION audit_no_truncate() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_event is append-only: TRUNCATE is refused'
        USING ERRCODE = 'raise_exception';
END;
$$;

CREATE TRIGGER audit_no_truncate
    BEFORE TRUNCATE ON audit_event
    FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();

COMMIT;
