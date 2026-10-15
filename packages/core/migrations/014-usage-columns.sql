-- =============================================================================
-- 014 — the metering columns say what they hold
-- =============================================================================
--
-- Schema version 13 -> 14. Introduced in 0.33.0.
--
-- Run this inside a transaction. Two renames and a drop, all on one table, and
-- a partial application would leave a table whose columns half mean one thing
-- and half another.
--
-- NO DATA IS LOST THAT WAS WORTH KEEPING, and that is checkable rather than
-- asserted: the dropped column has only ever contained zero. See below.
--
-- -----------------------------------------------------------------------------
-- 1. `bytes_stored` -> `bytes_written`, because it is a FLOW, not a STOCK
-- -----------------------------------------------------------------------------
--
-- It accumulates bytes WRITTEN on that day. It is not bytes held. Read as a
-- level -- which the name invites -- it reports a rate as though it were a
-- quantity, and the one use this table has is pricing arithmetic, where that
-- error is a wrong invoice rather than a wrong dashboard.
--
-- Bytes currently held is `SUM(size_bytes)` over live files, which is a query
-- and not a row here.
--
-- -----------------------------------------------------------------------------
-- 2. `authz_checks` is DROPPED, and not wired up
-- -----------------------------------------------------------------------------
--
-- It was declared when this table was created and nothing has ever incremented
-- it, so every row holds zero. Two candidate fixes were considered and both
-- rejected:
--
--   Wiring it needs the tenant at the moment of the decision, and that is
--   precisely where it is not available: `authorize()` answers without
--   resolving an org. Resolving one would add a query to the hot path of every
--   authorized read, to fill a counter. Metering only the ALLOWS, where the org
--   is already in hand, yields a numerator that silently omits every denial,
--   which is useless for the only ratio it was wanted for.
--
--   Counting decisions off `audit_event` instead -- which was briefly the
--   decision here -- does not work for BILLING: a delivered read writes more
--   than one event, and `trimAuditChain()` lets the payer delete the record.
--   It works perfectly for ANALYSIS over a recent window, which is what
--   "decisions per delivered read" actually is, and since 0.31.0 that read
--   takes `{ since, until }`.
--
-- So the ratio is a query across both tables and this column is a number that
-- could only ever disagree with the record. A weaker second measurement of
-- something already measured exactly is not coverage.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS TABLE IS AND IS NOT, now written in the schema
-- -----------------------------------------------------------------------------
--
-- Writes are metered INSIDE the upload transaction and are exact. Reads are
-- metered outside it with the error swallowed, because a metering failure must
-- never fail a delivery that was already authorized, charged against its cap
-- and audited -- so reads UNDERCOUNT, always in the payer's favour. Good enough
-- for a ratio. Not an invoice.
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF to_regclass('usage_daily') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 014: no usage_daily table. This database does not hold a filelayer schema.'
            USING ERRCODE = 'undefined_table';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'usage_daily' AND column_name = 'bytes_stored') THEN
        RAISE EXCEPTION
            'filelayer migration 014 is already applied: usage_daily.bytes_stored is gone. Nothing to do.';
    END IF;
    -- The claim this migration rests on, verified rather than trusted. If any
    -- row ever counted a decision, dropping the column would lose real data and
    -- somebody has to decide that on purpose instead of reading it here.
    IF EXISTS (SELECT 1 FROM usage_daily WHERE authz_checks <> 0) THEN
        RAISE EXCEPTION
            'filelayer migration 014: usage_daily.authz_checks is NOT all zero on this database, so dropping it would discard measurements this migration assumes never existed. Export the column first, then drop it by hand.'
            USING ERRCODE = 'invalid_table_definition';
    END IF;
END;
$$;

ALTER TABLE usage_daily RENAME COLUMN bytes_stored TO bytes_written;
ALTER TABLE usage_daily DROP COLUMN authz_checks;

-- AND THE NOT NULL CONSTRAINT'S NAME, which `RENAME COLUMN` does not carry.
--
-- PostgreSQL 17 and later catalogue NOT NULL constraints with a generated name,
-- `<table>_<column>_not_null`. Renaming the column leaves that name pointing at
-- a column that no longer exists by that name, so a migrated database ends up
-- with `usage_daily_bytes_stored_not_null` where a database created fresh from
-- schema.sql has `usage_daily_bytes_written_not_null`. Both enforce exactly the
-- same rule on the same column; the two schemas are nonetheless not the same
-- schema, and `check:migrations` compares catalogues rather than behaviour --
-- correctly, because a cosmetic drift today is a confusing diff in somebody's
-- incident tomorrow.
--
-- CONDITIONAL, because the constraint only has a name to rename on 17+. On an
-- older server there is nothing catalogued, nothing to rename, and nothing that
-- would have differed.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'usage_daily_bytes_stored_not_null') THEN
        ALTER TABLE usage_daily
            RENAME CONSTRAINT usage_daily_bytes_stored_not_null
                           TO usage_daily_bytes_written_not_null;
    END IF;
END;
$$;

INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES
    (14, '0.33.0', 'usage_daily: bytes_stored renamed to bytes_written (it is a flow), and the never-incremented authz_checks dropped')
ON CONFLICT (version) DO NOTHING;

COMMIT;
