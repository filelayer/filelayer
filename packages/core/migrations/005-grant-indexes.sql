-- =============================================================================
-- 005 — every index on file_grant becomes reachable
-- =============================================================================
-- entry:          MIGRATIONS.md Entry 5
-- from:           0.5.0
-- to:             0.5.1
-- transactional:  NO -- see below
-- decision:       no
--
-- The authorization hot path was sequential-scanning `file_grant`, because
-- `grant_is_live(id)` is an opaque function call and the planner could not see
-- the cheap conjunct beside it. Three index changes fix it.
--
-- THIS FILE CANNOT RUN INSIDE A TRANSACTION, and that is not a style choice:
-- `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` are refused inside
-- one by Postgres. There is no BEGIN/COMMIT below for that reason. If your
-- migration runner wraps each file in a transaction -- most do, by default --
-- this file will fail on the first CONCURRENTLY statement and you have to run
-- it outside that wrapper. `manifest.json` carries `"transactional": false`
-- so a runner can branch on it without reading this comment.
--
-- CONCURRENTLY is worth the awkwardness: these indexes are on the table every
-- authorization decision reads, and the non-concurrent form takes a lock that
-- blocks every one of them for the length of the build.
--
-- NOT ATOMIC, therefore. If it fails part-way, re-run it: each step below is
-- guarded individually and skips what is already done. A failed
-- CONCURRENTLY build leaves an INVALID index behind, which the guard detects
-- and drops rather than tripping over.
-- =============================================================================

-- 0. Preconditions, and the refusal if this was already applied.
DO $$
BEGIN
    IF to_regclass('file_grant') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 005: no file_grant table. This database does not hold a filelayer schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'grant_file_subject_type_idx')
       AND EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'grant_secret_idx'
                  AND indexdef LIKE '%secret_hash IS NOT NULL%') THEN
        RAISE EXCEPTION
            'filelayer migration 005: already applied. Nothing to do.'
            USING ERRCODE = 'duplicate_object';
    END IF;
END $$;

-- 1. Drop any INVALID leftovers from a previous failed run of this file.
DO $$
DECLARE bad text;
BEGIN
    FOR bad IN
        SELECT c.relname FROM pg_class c
          JOIN pg_index i ON i.indexrelid = c.oid
         WHERE NOT i.indisvalid
           AND c.relname IN ('grant_secret_all_idx', 'grant_file_subject_type_idx')
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', bad);
    END LOOP;
END $$;

-- 2. Make the cheap conjunct visible to the planner. Changes no result.
CREATE OR REPLACE VIEW live_grant AS
SELECT * FROM file_grant WHERE revoked_at IS NULL AND grant_is_live(id);

-- 3. The pre-authorization secret lookup must reach REVOKED grants, so the
--    partial index cannot carry `revoked_at IS NULL`. Built under a new name,
--    then swapped, so the old index serves queries until the new one is ready.
CREATE INDEX CONCURRENTLY IF NOT EXISTS grant_secret_all_idx
    ON file_grant (secret_hash) WHERE secret_hash IS NOT NULL;
DROP INDEX CONCURRENTLY IF EXISTS grant_secret_idx;
ALTER INDEX grant_secret_all_idx RENAME TO grant_secret_idx;

-- 4. The subject-type lookups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS grant_file_subject_type_idx
    ON file_grant (file_id, subject_type) WHERE revoked_at IS NULL;

-- 5. The planner needs statistics to choose any of this. Without this step the
--    indexes exist and are not used, which looks exactly like the defect.
ANALYZE file_grant;
