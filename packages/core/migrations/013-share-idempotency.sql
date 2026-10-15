-- =============================================================================
-- 013 — an idempotency key on a share, so a retry is not a second share
-- =============================================================================
--
-- Schema version 12 -> 13. Introduced in 0.32.0.
--
-- ONE COLUMN AND ONE UNIQUE INDEX, AND THE INDEX MUST NOT RUN INSIDE A
-- TRANSACTION. `CREATE UNIQUE INDEX CONCURRENTLY` is refused inside one, and
-- most runners wrap each file by default, so this file is declared
-- `transactional: false` in `manifest.json` and carries no BEGIN. If your runner
-- wraps it anyway it will fail on the CONCURRENTLY statement, and you will have
-- to run that statement by hand.
--
-- CONCURRENTLY is worth the awkwardness for the same reason migration 012 used
-- it: `file_grant` is on the path of every authorized read, and a plain
-- CREATE INDEX takes a lock that blocks writes to it for the duration.
--
-- -----------------------------------------------------------------------------
-- WHAT IT IS FOR
-- -----------------------------------------------------------------------------
--
-- `share()` inserts a grant row on every call, deliberately: two calls carrying
-- `expiresIn` are two legitimately different windows, and nothing in the engine
-- can tell those apart from a double-clicked button. LIMITATIONS entry 2 has
-- said so from the beginning -- "a grant id is not a person's access" -- and
-- disclosing it did not stop it being a trap. A share endpoint that inserts on
-- every click gives one reader several grants, and then `revoke(grantId)` on the
-- id the caller happens to be holding leaves the others live. The caller
-- believes access was withdrawn. It was not.
--
-- The key is the caller's own name for ONE act of sharing. Supplying it is
-- optional and the engine never invents one, because inventing one would mean
-- choosing an expiry policy on the caller's behalf.
--
-- THE CONSTRAINT IS THE MECHANISM, not a lookup in TypeScript. Two concurrent
-- retries race to insert; one wins, the loser catches the unique violation and
-- reads the winner's row back. A SELECT-then-INSERT in application code has a
-- window between the two statements, and a double-clicked button is exactly the
-- traffic that finds it.
--
-- -----------------------------------------------------------------------------
-- WHY THE INDEX INCLUDES REVOKED ROWS
-- -----------------------------------------------------------------------------
--
-- Most indexes on this table are partial on `revoked_at IS NULL`, because a
-- revoked grant is dead forever and authorization never wants it. This one is
-- not, and that is the point: a key that stopped applying once its grant was
-- revoked would mean a retry arriving after a revoke silently mints access the
-- caller has already taken away. The key says "this act of sharing happened
-- once", and revoking it does not make it un-happen.
--
-- -----------------------------------------------------------------------------
-- WHY IT IS SCOPED TO THE FILE AND NOT TO (FILE, SUBJECT)
-- -----------------------------------------------------------------------------
--
-- So that the same key arriving with a DIFFERENT subject is a conflict the
-- database refuses rather than something the engine resolves. Returning the
-- stored grant because its key matched would tell a caller that Bob has access
-- when the row says Alice does -- a worse defect than the duplicate this
-- prevents. The engine turns that unique violation into
-- `idempotency_key_reused`.
--
-- -----------------------------------------------------------------------------
-- BACKWARD COMPATIBILITY
-- -----------------------------------------------------------------------------
--
-- Additive. The column is nullable with no default, so every existing grant
-- reads as "no key", every existing caller keeps the previous behaviour, and
-- nothing needs backfilling. The index covers only rows that have a key, so it
-- is empty immediately after this migration.
--
-- Safe to run against a live database. The ADD COLUMN takes a brief
-- ACCESS EXCLUSIVE lock and rewrites nothing (nullable, no default, Postgres 11
-- and later); the index build takes none that blocks writes.
-- =============================================================================

-- REFUSE A DATABASE THAT IS NOT IN THE STATE THIS FILE EXPECTS, the way every
-- migration here does. `IF NOT EXISTS` alone would make this file succeed
-- against a database that already has the column and report nothing, which is
-- indistinguishable from having applied it.
DO $$
BEGIN
    IF to_regclass('file_grant') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 013: no file_grant table. This database does not hold a filelayer schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'grant_idempotency_idx') THEN
        RAISE EXCEPTION
            'filelayer migration 013 is already applied: grant_idempotency_idx exists. Nothing to do.';
    END IF;
END;
$$;

ALTER TABLE file_grant
    ADD COLUMN IF NOT EXISTS idempotency_key text;

-- Matches the CHECK in schema.sql. Named so a failure says which rule it broke.
-- `btrim` equality rejects a key that differs from another only by surrounding
-- whitespace, which would otherwise be two keys for one intent.
ALTER TABLE file_grant
    DROP CONSTRAINT IF EXISTS file_grant_idempotency_key_check;

ALTER TABLE file_grant
    ADD CONSTRAINT file_grant_idempotency_key_check CHECK (
        idempotency_key IS NULL
        OR (length(idempotency_key) BETWEEN 1 AND 200
            AND idempotency_key = btrim(idempotency_key))
    );

-- THE VIEWS HAVE TO BE RECREATED, and this is the part that is easy to miss.
--
-- `live_grant` and `live_grant_recursive` are both `SELECT * FROM file_grant`,
-- and a view FREEZES its column list at creation time. `ALTER TABLE ADD COLUMN`
-- does not reach into them. So without these two statements an upgraded
-- database ends up with `file_grant.idempotency_key` present and
-- `live_grant.idempotency_key` absent, while a database created fresh from
-- schema.sql has both -- two schemas that are supposed to be the same one.
--
-- Nothing today reads the column through a view, so this would have broken
-- nothing on the day it shipped. It would have broken the next query that did,
-- on upgraded databases only, which is the worst shape a schema defect can
-- have. `check:migrations` is what caught it: it applies this file to the
-- v0.31.0 schema and diffs the result against a fresh HEAD, and it reported
-- exactly these two columns as `only in a FRESH HEAD`.
--
-- CREATE OR REPLACE rather than DROP and recreate: other objects depend on
-- these views, so a DROP would need CASCADE and would take them with it.
-- Replacing is allowed here because the change only APPENDS a column at the
-- end, which is the one shape CREATE OR REPLACE VIEW accepts.
CREATE OR REPLACE VIEW live_grant AS
SELECT * FROM file_grant WHERE revoked_at IS NULL AND grant_is_live(id);

CREATE OR REPLACE VIEW live_grant_recursive AS
WITH RECURSIVE live AS (
        SELECT g.*
          FROM file_grant g
         WHERE g.parent_grant_id IS NULL
           AND g.revoked_at IS NULL
           AND (g.expires_at IS NULL OR g.expires_at > now())
           AND (g.max_downloads IS NULL OR g.download_count < g.max_downloads)
           AND grant_scope_is_live(g.file_id, g.subject_id, g.created_by, g.subject_org_id)
        UNION ALL
        SELECT c.*
          FROM live p
          JOIN file_grant c ON c.parent_grant_id = p.id
         WHERE c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR c.expires_at > now())
           AND (c.max_downloads IS NULL OR c.download_count < c.max_downloads)
           AND grant_scope_is_live(c.file_id, c.subject_id, c.created_by, c.subject_org_id)
    )
SELECT * FROM live;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS grant_idempotency_idx
    ON file_grant (file_id, idempotency_key)
 WHERE idempotency_key IS NOT NULL;

-- A CONCURRENTLY build that fails leaves an INVALID index behind, which is not
-- an error anybody sees and which the planner will not use -- and for a UNIQUE
-- index it is worse than for the others: an invalid unique index does not
-- enforce uniqueness, so the idempotency guarantee would be silently absent.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                WHERE c.relname = 'grant_idempotency_idx' AND NOT i.indisvalid) THEN
        RAISE EXCEPTION
            'filelayer migration 013: grant_idempotency_idx was built but is INVALID. '
            'A concurrent build failed, and an invalid UNIQUE index enforces nothing. '
            'Drop it and re-run: DROP INDEX CONCURRENTLY grant_idempotency_idx;';
    END IF;
END;
$$;

INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (13, '0.33.0', 'an idempotency key on file_grant, so a retried share returns the same grant instead of minting a second one')
ON CONFLICT (version) DO NOTHING;
