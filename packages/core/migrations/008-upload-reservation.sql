-- =============================================================================
-- 008 — two columns, an index and a constraint, for pre-authorized upload
-- =============================================================================
-- entry:          MIGRATIONS.md Entry 8
-- from:           0.9.0
-- to:             0.10.0
-- transactional:  NO -- see below
-- decision:       no
--
-- Direct browser-to-bucket upload needs to remember two things about a
-- reservation between issuing it and the bytes arriving. Both columns are
-- nullable and both are NULL for every file created by the ordinary `upload()`,
-- so EXISTING ROWS NEED NO BACKFILL.
--
-- ONE PATH, NOT THREE. MIGRATIONS.md Entry 8 carries four blocks, and three of
-- them are three formulations of the same change -- the plain one, the
-- `CONCURRENTLY` index, and the `NOT VALID` + `VALIDATE` constraint -- offered
-- so you could pick by table size. Pasted in sequence they try to create the
-- same index twice. This file takes the online-safe formulation throughout,
-- which is correct on an empty table as well as a large one, so there is
-- nothing to choose.
--
-- NOT TRANSACTIONAL, because of `CREATE INDEX CONCURRENTLY`. See 005.
-- The two ALTERs below are each atomic on their own and the whole file is
-- re-runnable: every step is guarded.
-- =============================================================================

DO $$
BEGIN
    IF to_regclass('file') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 008: no file table. This database does not hold a filelayer schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'file_upload_reservation_complete') THEN
        RAISE EXCEPTION
            'filelayer migration 008: already applied (constraint file_upload_reservation_complete exists). Nothing to do.'
            USING ERRCODE = 'duplicate_object';
    END IF;
END $$;

-- 1. The columns. `ADD COLUMN` of a nullable column with no default is a
--    catalogue-only change in PostgreSQL 11+, so this does not rewrite the
--    table however many rows it has.
ALTER TABLE file
    ADD COLUMN IF NOT EXISTS upload_expires_at     timestamptz,
    ADD COLUMN IF NOT EXISTS upload_expected_bytes bigint;

-- 2. The per-column check, separately, so its name matches what `schema.sql`
--    produces (`file_upload_expected_bytes_check`) rather than an inline one.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname = 'file_upload_expected_bytes_check') THEN
        ALTER TABLE file
            ADD CONSTRAINT file_upload_expected_bytes_check
            CHECK (upload_expected_bytes IS NULL OR upload_expected_bytes >= 0);
    END IF;
END $$;

-- 3. The index the reservation sweeper reads. CONCURRENTLY: `file` is the table
--    every delivery touches.
CREATE INDEX CONCURRENTLY IF NOT EXISTS file_upload_deadline_idx
    ON file (upload_expires_at)
    WHERE state = 'pending' AND upload_expires_at IS NOT NULL;

-- 4. The pairing constraint. NOT VALID first so the ACCESS EXCLUSIVE lock is
--    held for a catalogue write rather than for a full scan, then VALIDATE,
--    which takes only a SHARE UPDATE EXCLUSIVE and does not block reads or
--    writes. On an empty table the two steps cost nothing; on a large one this
--    is the difference between a blip and an outage.
ALTER TABLE file
    ADD CONSTRAINT file_upload_reservation_complete
    CHECK ((upload_expires_at IS NULL) = (upload_expected_bytes IS NULL)) NOT VALID;
ALTER TABLE file VALIDATE CONSTRAINT file_upload_reservation_complete;
