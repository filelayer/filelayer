-- =============================================================================
-- 010 — the schema version table
-- =============================================================================
-- entry:          MIGRATIONS.md Entry 10
-- from:           0.14.0
-- to:             0.15.0
-- transactional:  yes
-- decision:       no
--
-- MIGRATIONS.md named the absence of this table as a gap and promised it
-- "before 1.0". Three independent evaluations of the published package, given
-- nothing but the tarball, each wrote the same sentence back: there is no
-- version table, so you cannot tell which version a database is at. This is
-- that table.
--
-- RUN THIS ONLY ON A DATABASE THAT IS ALREADY AT THE 0.14.0 SCHEMA. The guard
-- below enforces it, because the one thing worse than no version row is a wrong
-- one: a database stamped `10` that is actually missing migration 008 would
-- then be skipped by every later check, and the next upgrade would fail
-- somewhere unrelated.
--
-- WHAT IT RECORDS, AND WHAT IT DOES NOT. One row, for version 10. Migrations 1
-- through 8 ran against this database before this table existed, so there are
-- no rows for them and inventing nine `applied_at` timestamps would be a
-- fabricated history in the one table whose entire value is being believed.
-- The note says so in words.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('filelayer_schema_version') IS NOT NULL THEN
        RAISE EXCEPTION
            'filelayer migration 010: already applied (filelayer_schema_version exists). Nothing to do.'
            USING ERRCODE = 'duplicate_object';
    END IF;
    IF to_regclass('project') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 010: no filelayer schema here. For an empty database apply schema.sql, which creates this table and stamps it as part of the schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
    -- The marker for migration 008, which is the newest schema change before
    -- this one. Anything older than that must be brought forward first.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'file_upload_reservation_complete') THEN
        RAISE EXCEPTION
            'filelayer migration 010: this database is older than 0.10.0 -- constraint file_upload_reservation_complete is absent, so migration 008 has not been applied. Apply the outstanding migrations first; `schemaStatus(db)` lists them. Stamping a version this database has not reached would make every later check wrong.'
            USING ERRCODE = 'invalid_table_definition';
    END IF;
END $$;

CREATE TABLE filelayer_schema_version (
    version         integer PRIMARY KEY,
    introduced_in   text NOT NULL,
    applied_at      timestamptz NOT NULL DEFAULT now(),
    note            text NOT NULL
);

INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (10, '0.15.0', 'stamped on an existing database that already held the 0.14.0 schema; migrations 1-8 were applied before this table existed, so they have no rows here');

COMMIT;
