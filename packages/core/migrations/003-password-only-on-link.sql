-- =============================================================================
-- 003 — a password is refused where it was never enforced
-- =============================================================================
-- entry:          MIGRATIONS.md Entry 3
-- from:           0.4.x
-- to:             0.5.0
-- transactional:  yes
-- decision:       YES — read the next paragraph before running this.
--
-- THE DEFECT. A `password` could be set on a grant whose subject was not a
-- link. Nothing enforced it on the read path, so the hash sat there inert and
-- the file was readable without it. Anything this migration finds was published
-- without the protection its creator intended.
--
-- THE DECISION THIS FILE MAKES FOR YOU. It REVOKES those grants, which is the
-- recommended answer and the safe one: a grant whose protection never worked is
-- a grant nobody consented to. The alternative -- keep them readable and drop
-- the inert hash -- is at the bottom of this file, commented out. Take it only
-- if you have confirmed, file by file, that each one is genuinely meant to be
-- open. MIGRATIONS.md Entry 3 presented both as consecutive statements, so a
-- runner executing that block did both: revoked them AND stripped the hashes.
--
-- BEFORE YOU RUN IT, see what it will touch:
--
--   SELECT id, file_id, org_id, subject_type, created_at
--     FROM file_grant
--    WHERE password_hash IS NOT NULL
--      AND subject_type <> 'link';
-- =============================================================================

BEGIN;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conname = 'grant_password_only_on_link') THEN
        RAISE EXCEPTION
            'filelayer migration 003: already applied (constraint grant_password_only_on_link exists). Nothing to do.'
            USING ERRCODE = 'duplicate_object';
    END IF;
    IF to_regclass('file_grant') IS NULL THEN
        RAISE EXCEPTION
            'filelayer migration 003: no file_grant table. This database does not hold a filelayer schema; apply schema.sql to an empty database instead.'
            USING ERRCODE = 'undefined_table';
    END IF;
END $$;

-- The grants whose password never protected anything.
UPDATE file_grant
   SET revoked_at = now()
 WHERE password_hash IS NOT NULL
   AND subject_type <> 'link'
   AND revoked_at IS NULL;

-- Now the constraint can be added, because nothing violates it.
ALTER TABLE file_grant
  ADD CONSTRAINT grant_password_only_on_link
  CHECK (password_hash IS NULL OR subject_type = 'link');

COMMIT;

-- -----------------------------------------------------------------------------
-- THE ALTERNATIVE, if you have confirmed each affected file is meant to be open.
-- Run this INSTEAD OF the UPDATE above, not after it. The constraint still
-- applies either way.
-- -----------------------------------------------------------------------------
-- UPDATE file_grant
--    SET password_hash = NULL
--  WHERE password_hash IS NOT NULL AND subject_type <> 'link';
