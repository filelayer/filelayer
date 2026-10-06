-- =============================================================================
-- 012 — the index that lets a grant lookup stop at the first row
-- =============================================================================
--
-- Schema version 11 -> 12. Introduced in 0.17.0.
--
-- ONE INDEX, AND IT MUST NOT RUN INSIDE A TRANSACTION. `CREATE INDEX
-- CONCURRENTLY` is refused inside one, and most migration runners wrap each
-- file by default, so this file is declared `transactional: false` in
-- `manifest.json` and carries no BEGIN. If your runner wraps it anyway, it will
-- fail on the CONCURRENTLY statement and you have to run it by hand.
--
-- CONCURRENTLY is worth the awkwardness: `file_grant` is on the path of every
-- authorized read, and a plain CREATE INDEX takes a lock that blocks writes to
-- it for the duration.
--
-- -----------------------------------------------------------------------------
-- WHAT IT IS FOR
-- -----------------------------------------------------------------------------
--
-- `live_grant` applies `grant_is_live(id)`, a recursive function declared
-- COST 100, ONCE PER MATCHING ROW. The engine only ever wants the FIRST live
-- grant of one subject on one file, in `created_at, id` order, that supplies
-- the capability being asked for -- `resolveStanding` has always stopped there.
-- It stopped in application code, after the database had evaluated every row.
--
-- Measured with `benchmark/load/grant-depth.mjs`, on one machine, delegated
-- read, before and after the matching change in `getActorGrantSupplying`:
--
--     grants    before      after
--          5    0.88 ms     0.81 ms
--        100    3.10 ms     0.63 ms
--        500    9.75 ms     0.67 ms
--       2000   38.10 ms     1.04 ms
--
-- `share()` does not dedupe, by design, so a retry loop or a nightly re-sync
-- accumulates duplicate grants and anyone holding `share` on a file can do it
-- to one specific reader through the documented API.
--
-- -----------------------------------------------------------------------------
-- THE INDEX IS HALF OF IT. RUN ANALYZE.
-- -----------------------------------------------------------------------------
--
-- Without statistics the planner estimates one row, concludes that sorting one
-- row is free, and never considers this index at all: 10.2 ms at 500 grants
-- with the index present and unused, 0.21 ms once it is used. Autovacuum gets
-- there on its own, eventually. After applying this, do not wait:
--
--     ANALYZE file_grant;
--
-- It is at the end of this file for exactly that reason.

DO $$
BEGIN
    IF to_regclass('file_grant') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 012: no file_grant table. This database does not hold a filelayer schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_indexes
                WHERE schemaname = 'public' AND indexname = 'grant_subject_order_idx') THEN
        RAISE EXCEPTION
            'filelayer migration 012 is already applied: grant_subject_order_idx exists. Nothing to do.';
    END IF;
END;
$$;

-- `subject_id` is in the key rather than the predicate because this lookup
-- always names one subject; `created_at, id` are there to make the ORDER BY
-- free, which is the whole point; and the partial predicate keeps revoked rows
-- out of the walk.
CREATE INDEX CONCURRENTLY grant_subject_order_idx
    ON file_grant (file_id, subject_type, subject_id, created_at, id)
    WHERE revoked_at IS NULL;

-- A CONCURRENTLY build that fails leaves an INVALID index behind, which is not
-- an error anybody sees and which the planner will not use. Check rather than
-- assume, the same way migration 005 does.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                WHERE c.relname = 'grant_subject_order_idx' AND NOT i.indisvalid) THEN
        RAISE EXCEPTION
            'filelayer migration 012: grant_subject_order_idx was built but is INVALID. '
            'A concurrent build failed. Drop it and re-run: DROP INDEX CONCURRENTLY grant_subject_order_idx;';
    END IF;
END;
$$;

ANALYZE file_grant;

INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (12, '0.17.0', 'grant_subject_order_idx: the first live grant supplying a capability, without evaluating the rest');
