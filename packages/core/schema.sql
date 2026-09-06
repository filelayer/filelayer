-- =============================================================================
-- FILELAYER CORE SCHEMA
-- Multi-tenant file authorization + lifecycle
-- =============================================================================
--
-- DESIGN PRINCIPLES (each of these is a security property we sell):
--
-- P1. DENY BY DEFAULT. There is no row that grants access implicitly. Access
--     exists only as an explicit row in `membership` or `grant`. Absence of a
--     row is denial. There is no "public" boolean anywhere in this schema --
--     public delivery is a *separate, explicitly created* grant with
--     subject_type='anonymous'. This is the single most important decision in
--     the file: the Fiverr/Cloudinary tax-return leak and the entire "the
--     bucket was public" class of incident are impossible to express here.
--
--     P1 now holds at the FILE boundary as well as the tenant boundary. A file
--     is created `private` unless the creator explicitly asks for org-wide
--     visibility (see `file.visibility`). Previously every viewer in an org
--     could read every file in it; that defect is fixed.
--
-- P2. NO AMBIENT AUTHORITY. Every authorization answer is derived from
--     (actor, file) -> traversal of membership + grants. Storage location is
--     never an input to an access decision. Knowing an object key, a URL, or a
--     file id grants nothing.
--
-- P3. CROSS-TENANT GRANTS ARE STRUCTURALLY IMPOSSIBLE TO WRITE. Every
--     access-bearing table carries org_id, and every uniqueness/foreign-key
--     constraint is org-scoped, so a grant's org_id must equal its file's
--     org_id (composite FK, see `grant` table). No writer -- including a
--     migration or a psql session -- can create such a row. This is a
--     write-side integrity constraint, not a read filter: there is no RLS
--     policy in this file, and reads are scoped by authz.ts, which only sees
--     calls made through the library.
--
-- P4. A SIGNED URL MAY NEVER OUTLIVE THE PERMISSION THAT CREATED IT.
--     This is the defect in Convex ("the only way to revoke a file URL is by
--     deleting the file"), Cloudinary ("once a URL is exposed, anyone with it
--     can access the asset"), and raw S3 presigning. Here, every signed URL
--     embeds a grant_id; delivery re-validates the grant on every request.
--     Revocation is therefore immediate and beats a live URL. This property is
--     the product. If we ever relax it for performance, we have no product.
--
--     P4 IS NOW TRANSITIVE. A grant may be delegated (see `parent_grant_id`),
--     and liveness is evaluated over the whole ancestor chain: a grant is live
--     only if it AND every ancestor is unrevoked, unexpired and under cap.
--     Revoking a grant kills everything ever delegated from it, at any depth,
--     with no cascading write. Previously a delegated grant survived revocation
--     of its parent, which was the reason P4 was only true for
--     directly-issued grants. That is fixed here, in the schema, because it is
--     a data-model property and cannot be a convention.
--
-- P5. EVERY ACCESS DECISION IS AUDITED, INCLUDING DENIALS. Denials are the
--     security-relevant events. A trail that only records successes cannot
--     evidence an attempted breach. Decisions that cannot be attributed to a
--     tenant (a probe against a file id that does not exist, a sweep against
--     link secrets) are written to the SYSTEM chain, `org_id IS NULL`, which no
--     tenant can read. Attributing them to a guessed org would itself be an
--     existence oracle; dropping them, which is what we used to do, made
--     enumeration invisible.
--
-- P6. COUNTERS ARE ATOMIC. Download caps are enforced by a conditional UPDATE
--     that is itself the reservation. Read-then-write is a bypass under
--     concurrency and would make "max 3 downloads" a lie. A download now
--     consumes the budget of the whole ancestor chain, so a delegated link
--     cannot spend more than its parent had left.
--
--     P6 NOW COVERS EVERY DELIVERY, NOT JUST REDEMPTIONS. The cap used
--     to be charged only by the share-link path, so an actor grant carrying
--     `max_downloads = 1` permitted unlimited direct reads: the dimension was
--     enforced on one path and decorative on the other, while being named and
--     documented as a download cap. A download is now charged whenever bytes
--     leave through a GRANT, by any principal, on any path. Authority from an
--     org role is not charged -- it is not a metered credential -- and metadata
--     reads are not charged, because no bytes leave. See `Filelayer.deliver()`.
--
-- P7. DELETION IS A PREDICATE, NOT A CASCADE. A grant is live only while
--     its whole SCOPE exists: its file, that file's org, that org's project,
--     the actor it was issued to, THE ORG WHOSE MEMBERS IT NAMES (for a group
--     grant), and the actor who issued it. Delete any of
--     them and every grant beneath dies on the next request, at any delegation
--     depth, with no cascading write -- and restoring it revives exactly what
--     it killed, because nothing was written. Deleting a tenant that leaves its
--     share links serving bytes is not a deletion. See `grant_scope_is_live`.
--
--     Soft delete SUSPENDS ACCESS; it does not erase. It touches no row a
--     retention hold protects and it leaves the tenant's audit chain intact and
--     verifiable, so it cannot be used to destroy records under legal hold.
--
-- P8. THE CUSTOMER'S ID SPACE IS THE CUSTOMER'S. In a hosted deployment,
--     every customer application shares this database, so `external_id` is
--     unique WITHIN a project and meaningless across projects. Every table that
--     can name an actor carries `project_id` under a composite foreign key, so
--     a cross-project membership, ownership, grant subject or grant issuer is
--     unrepresentable -- P3, one level up.
--
-- Target: PostgreSQL 15+ (`ON DELETE SET NULL (column)`). Runs on PGlite for
-- test/CI, which is PostgreSQL 17 (real planner, constraints, enums, arrays,
-- rules, advisory locks and transactional semantics).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- PROJECT -- the customer's application (P8)
-- -----------------------------------------------------------------------------
--
-- A HOSTED, SHARED DATABASE MADE THIS NECESSARY, AND IT IS A BREAKING CHANGE.
--
-- `org.external_id` and `actor.external_id` used to be GLOBALLY unique. That is
-- correct for a library each customer runs against their own database, and it
-- is a cross-customer data breach the moment Filelayer owns the database and
-- every customer's application shares it. Two facts made it worse than a
-- collision:
--
--   * `Identities.org()` resolves a customer's own org id with
--     `INSERT ... ON CONFLICT (external_id) DO UPDATE ... RETURNING id`. Under
--     a global unique index, customer B calling `put({ org: 'acme' })` does not
--     get an error -- it gets customer A's org id, and then `Identities`
--     helpfully adds B's user to A's tenant as a `member`. That is a complete
--     cross-tenant compromise reachable from the most ergonomic entry point we
--     ship, with no attacker skill required beyond picking a common org name.
--   * `Identities.actor()` is the same shape, so `as: 'alice'` in customer B's
--     app resolves to customer A's Alice.
--
-- The fix is a scope above the tenant: the PROJECT, which is one customer
-- application. `external_id` is the customer's id space, so it is unique
-- WITHIN a project and meaningless across projects.
--
-- A project is also the unit an API key authenticates (see SEMANTICS.md, "The
-- ingest boundary"), which is what turns audit-chain flooding from "any
-- internet caller can flood any tenant's audit chain" into "an authenticated
-- customer can flood their own tenant's chain", i.e. a quota problem rather
-- than a security one.
--
-- MIGRATION: there are no customers, so the migration is a drop and recreate.
-- For a deployment that had data:
--   ALTER TABLE org   DROP CONSTRAINT org_external_id_key;
--   ALTER TABLE actor DROP CONSTRAINT actor_external_id_key;
--   INSERT INTO project (id, key, name) VALUES (DEFAULT_PROJECT_ID, ...);
--   ALTER TABLE org   ADD COLUMN project_id uuid NOT NULL DEFAULT <that id>;
--   ALTER TABLE actor ADD COLUMN project_id uuid NOT NULL DEFAULT <that id>;
--   ...then the unique/foreign keys below. Every existing row lands in one
--   project, which is exactly what a pre-hosted deployment was.

CREATE TABLE project (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key             text NOT NULL UNIQUE,    -- OUR id for the customer app
    name            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

-- The project every row lands in when nobody named one. It exists so that a
-- single-project deployment (self-hosted, CI, the examples) needs no project
-- vocabulary at all, and so that the migration above is a one-liner. It is NOT
-- a hole in the model: it is a real project row with a real id, exactly as
-- DEFAULT_WORKSPACE is a real org. The hosted API layer always names a project
-- explicitly, because it resolves one from the request's API key.
INSERT INTO project (id, key, name)
VALUES ('00000000-0000-0000-0000-0000000f11e1', '__filelayer_default_project__', 'Default project');

-- -----------------------------------------------------------------------------
-- TENANCY
-- -----------------------------------------------------------------------------

CREATE TABLE org (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL DEFAULT '00000000-0000-0000-0000-0000000f11e1'
                         REFERENCES project(id) ON DELETE CASCADE,
    external_id     text NOT NULL,           -- the customer's own org id
    name            text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,

    -- P8. The customer's id space is scoped to the customer.
    UNIQUE (project_id, external_id),
    -- ...and this is what lets every access-bearing table below carry a
    -- project_id that is PROVABLY the org's, by composite foreign key, in the
    -- same way P3 makes a grant's org provably its file's.
    UNIQUE (id, project_id)
);

CREATE TABLE actor (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      uuid NOT NULL DEFAULT '00000000-0000-0000-0000-0000000f11e1'
                         REFERENCES project(id) ON DELETE CASCADE,
    external_id     text NOT NULL,           -- the customer's own user id
    created_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    UNIQUE (project_id, external_id),
    UNIQUE (id, project_id)
);

-- P3, ONE LEVEL UP. Every table that can name an actor also carries the
-- project, and the pair (actor_id, project_id) is a foreign key into
-- actor(id, project_id). A membership, a file ownership, a grant subject or a
-- grant issuer that crosses a project boundary is therefore UNREPRESENTABLE,
-- not merely unlikely -- the same standard the cross-tenant case is held to.
--
-- The project column is DERIVED, never supplied: this trigger overwrites
-- whatever a writer passed with the value read from the org. So there is no
-- way to write a row whose project_id disagrees with its org, and the foreign
-- keys then do the rest. A writer that supplies a wrong actor gets a foreign
-- key violation rather than a silently cross-project row.
CREATE FUNCTION project_from_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    SELECT o.project_id INTO NEW.project_id FROM org o WHERE o.id = NEW.org_id;
    IF NEW.project_id IS NULL THEN
        RAISE EXCEPTION 'project_unresolved: org % does not exist', NEW.org_id;
    END IF;
    RETURN NEW;
END;
$$;

-- Roles are fixed and ordered. We deliberately do NOT ship custom roles in v1:
-- an unbounded role system is the fastest way to reintroduce the complexity we
-- claim to remove, and it makes the claim unfalsifiable.
CREATE TYPE org_role AS ENUM ('viewer', 'member', 'admin', 'owner');

CREATE TABLE membership (
    org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
    actor_id        uuid NOT NULL,
    project_id      uuid NOT NULL,           -- derived from org, see trigger
    role            org_role NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, actor_id),
    FOREIGN KEY (org_id, project_id)   REFERENCES org (id, project_id)   ON DELETE CASCADE,
    FOREIGN KEY (actor_id, project_id) REFERENCES actor (id, project_id) ON DELETE CASCADE
);

CREATE TRIGGER membership_project
    BEFORE INSERT OR UPDATE OF org_id ON membership
    FOR EACH ROW EXECUTE FUNCTION project_from_org();

CREATE INDEX membership_actor_idx ON membership (actor_id);

-- -----------------------------------------------------------------------------
-- FILES
-- -----------------------------------------------------------------------------

CREATE TYPE file_state AS ENUM ('pending', 'ready', 'deleted');

-- Who, inside the owning org, can see a file at all before anybody shares
-- it. This is a product decision made explicit rather than an emergent property
-- of the role table:
--
--   'private' (DEFAULT) -- the file exists for its owner and for org
--                          admins/owners only. Every other member of the org,
--                          at any role, needs an explicit grant. This is P1 at
--                          the file boundary.
--   'org'               -- every member of the org may read it, as before.
--                          Correct for a genuinely shared workspace; wrong for
--                          HR, legal and finance documents, which is the Vault
--                          scenario.
--
-- The default is the restrictive one on purpose: the failure mode of the wrong
-- default in this direction is "someone has to ask for access", and in the
-- other direction it is a disclosure. Org admins/owners keep access under both
-- settings, because a file no administrator can reach cannot be retained,
-- deleted, or produced under legal hold -- and a compliance control that the
-- accountable party cannot exercise is not a control.
--
-- RELATIONSHIP TO GROUP GRANTS (RFC-001). Now that `subject_type = 'org'`
-- exists, `visibility = 'org'` is exactly describable as an IMPLICIT ORG GRANT:
-- a read grant whose subject org is the file's own org. It is RETAINED as sugar
-- for that one case, deliberately, for two reasons. It is the case that needs
-- no vocabulary at all ("this document is for the team"), and it is a column on
-- the file rather than a row, which is what lets the role matrix stay a total
-- function over 4 roles x 2 ownerships x 2 visibilities -- the enumeration the
-- listing predicate is DERIVED from. It does not violate P1: it is still not a
-- boolean that opens a file to a population beyond the tenant that owns it, and
-- every wider audience is still an explicit, revocable, auditable grant row.
CREATE TYPE file_visibility AS ENUM ('private', 'org');

CREATE TABLE file (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
    project_id      uuid NOT NULL,            -- derived from org, see trigger
    owner_id        uuid,

    name            text NOT NULL,
    content_type    text NOT NULL,
    size_bytes      bigint,
    checksum_sha256 text,

    -- Storage is an implementation detail and is never an access input (P2).
    storage_provider text NOT NULL DEFAULT 'r2',
    storage_key      text NOT NULL,

    state           file_state NOT NULL DEFAULT 'pending',
    visibility      file_visibility NOT NULL DEFAULT 'private',

    -- Lifecycle
    expires_at      timestamptz,              -- hard lifecycle expiry
    retain_until    timestamptz,              -- retention floor: blocks deletion
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,

    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- P3: this composite unique is what makes cross-tenant grants
    -- unrepresentable. `grant` references (file_id, org_id) as a pair, so a
    -- grant can never point at a file in a different org.
    UNIQUE (id, org_id),

    -- P8: the owner must be an identity from the SAME project as the file's
    -- org. `ON DELETE SET NULL (owner_id)` names the column explicitly (PG 15+)
    -- so that a hard actor delete nulls the owner without also trying to null
    -- project_id, which is NOT NULL. Hard deletes are not the model -- see
    -- SEMANTICS.md, actors are soft-deleted -- but the constraint must still be
    -- coherent if one happens.
    FOREIGN KEY (org_id, project_id)   REFERENCES org (id, project_id)   ON DELETE CASCADE,
    FOREIGN KEY (owner_id, project_id) REFERENCES actor (id, project_id) ON DELETE SET NULL (owner_id),

    CONSTRAINT file_retention_before_expiry
        CHECK (retain_until IS NULL OR expires_at IS NULL OR retain_until <= expires_at)
);

CREATE TRIGGER file_project
    BEFORE INSERT OR UPDATE OF org_id ON file
    FOR EACH ROW EXECUTE FUNCTION project_from_org();

CREATE INDEX file_org_idx      ON file (org_id) WHERE deleted_at IS NULL;
CREATE INDEX file_owner_idx    ON file (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX file_expiry_idx   ON file (expires_at) WHERE deleted_at IS NULL AND expires_at IS NOT NULL;
CREATE UNIQUE INDEX file_storage_key_idx ON file (storage_provider, storage_key);

-- -----------------------------------------------------------------------------
-- GRANTS -- the core of the product
-- -----------------------------------------------------------------------------
--
-- A grant is a first-class, revocable, queryable resource. This is the central
-- difference from every competitor, all of whom represent sharing as an opaque
-- signed string that the system cannot subsequently see, list, or revoke.
--
-- Because a grant is a row:
--   - it can be listed  ("what have we shared, with whom?")
--   - it can be revoked (immediately, even for URLs already in the wild)
--   - it can be capped  (download limits, atomically)
--   - it can be audited (it has an id that appears in every access event)
--   - it can expire     (server-side, not merely encoded in a token)
--   - it can be DELEGATED, and the delegation is a row too, pointing at its
--     parent -- which is what makes revocation transitive (P4).

-- A GRANT'S SUBJECT IS A PRINCIPAL SET (RFC-001).
--
-- The three original subject types were already sets; we simply never said so:
--
--   actor      exactly one principal
--   link       whoever holds the secret (bearer, not identity)
--   anonymous  everyone
--
-- The gap was that nothing sat between "one" and "everyone" except a bearer
-- token, so "every member of this organization may read this file" had no
-- representation at all. Two subject types close it:
--
--   org        every member of `subject_org_id`, at ANY role
--   role       every member of `subject_org_id` at role >= `subject_min_role`
--
-- `org` is `role` with the floor at 'viewer'. Both exist because the common
-- case should not require naming a role.
--
-- BREADTH ORDERING (this is what invariant I6, below, attenuates over):
--
--     actor  <  role  <=  org  <  anonymous
--     link   -- orthogonal: a bearer credential, not an identity
--
-- WHAT THIS DELIBERATELY IS NOT. There are no custom groups, no nested orgs, no
-- configurable inheritance and no arbitrary permission sets. A group IS an org,
-- and `subject_min_role` is ONLY a threshold over the existing four-value
-- `org_role` enum. A general group table is the road to the unauditable
-- permission model this schema exists to refuse.
--
-- RESOLUTION IS A JOIN, NEVER A MATERIALIZATION. There is no fan-out table and
-- no per-member row. A `role`/`org` grant matches a principal iff that
-- principal has a live `membership` row in `subject_org_id` at a sufficient
-- role, evaluated at read time. THAT IS THE POINT: adding or removing a member
-- changes access on the very next request, with no recomputation and no write
-- to any grant -- the same property that makes revocation immediate. Fan-out
-- would make membership eventually-consistent with access, which is the
-- property we sell.
CREATE TYPE grant_subject AS ENUM ('actor', 'org', 'role', 'link', 'anonymous');
CREATE TYPE grant_capability AS ENUM ('read', 'write', 'delete', 'share');

CREATE TABLE file_grant (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    file_id         uuid NOT NULL,
    org_id          uuid NOT NULL,
    project_id      uuid NOT NULL,            -- derived from org, see trigger

    -- P4, transitive. NULL means "issued directly from an org role", i.e. this
    -- grant is a root of a delegation tree. Non-NULL means the issuer's own
    -- authority was itself a grant, and this grant can never be more than that
    -- grant was: not in capability, not in lifetime, not in download budget.
    parent_grant_id uuid REFERENCES file_grant(id) ON DELETE CASCADE,

    subject_type    grant_subject NOT NULL,
    subject_id      uuid,                     -- when subject_type='actor'

    -- I1 / P3 / P8, ONE LEVEL UP AGAIN. The org whose members are the subject,
    -- when subject_type is 'org' or 'role'. It is NOT required to equal
    -- `org_id`: a cross-ORG group grant inside one project is exactly the case
    -- this exists for ("the company that posted this job may read this CV").
    -- What is unrepresentable is a cross-PROJECT one, and it is unrepresentable
    -- structurally -- see the composite foreign key below -- not by a WHERE
    -- clause somebody has to remember.
    subject_org_id  uuid,

    -- The role FLOOR, when subject_type='role'. A threshold over the existing
    -- `org_role` enum and nothing else: there are no custom roles, no nested
    -- roles and no configurable inheritance here. 'org' leaves it NULL, which
    -- reads as the floor being 'viewer'.
    subject_min_role org_role,

    capabilities    grant_capability[] NOT NULL,

    -- Link-type grants: the secret is stored ONLY as a hash. A database dump
    -- does not yield working share links.
    secret_hash     text,

    -- Optional password on top of the link secret (two-factor for a share).
    password_hash   text,

    -- Lifecycle of the grant itself
    expires_at      timestamptz,
    max_downloads   integer CHECK (max_downloads IS NULL OR max_downloads > 0),
    download_count  integer NOT NULL DEFAULT 0,

    revoked_at      timestamptz,
    created_by      uuid,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- P3: cross-tenant grants are structurally unrepresentable.
    FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id) ON DELETE CASCADE,

    -- P8: and so are cross-PROJECT grants. Neither the subject of a grant nor
    -- its issuer may be an identity belonging to a different customer
    -- application. `subject_id` and `created_by` are nullable and these are
    -- MATCH SIMPLE foreign keys, so a link or anonymous grant (subject_id NULL)
    -- and a grant issued by the control plane (created_by NULL) are unaffected.
    FOREIGN KEY (org_id, project_id)     REFERENCES org (id, project_id)   ON DELETE CASCADE,
    FOREIGN KEY (subject_id, project_id) REFERENCES actor (id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by, project_id) REFERENCES actor (id, project_id) ON DELETE SET NULL (created_by),

    -- I1. THE GROUP SUBJECT IS HELD TO THE SAME STANDARD AS EVERY OTHER
    -- IDENTITY IN THIS TABLE. `project_id` is DERIVED FROM THE FILE'S ORG by
    -- the trigger below and can therefore never be supplied by a writer, so
    -- this composite key says exactly: the subject org must live in the same
    -- PROJECT as the file. A cross-project group grant is unrepresentable --
    -- P8, and the same standard P3 already holds cross-tenant grants to.
    -- Cross-ORG group grants within a project remain legal, which is the point
    -- of the feature.
    FOREIGN KEY (subject_org_id, project_id) REFERENCES org (id, project_id) ON DELETE CASCADE,

    -- ...and so is delegation ACROSS files. A child grant must concern the same
    -- file as its parent. This is the confused-deputy check for delegation, and
    -- like the tenant one it is a foreign key rather than a rule someone has to
    -- remember: (parent_grant_id, file_id) must be an existing (id, file_id).
    UNIQUE (id, file_id),
    FOREIGN KEY (parent_grant_id, file_id) REFERENCES file_grant (id, file_id),

    CONSTRAINT grant_no_self_parent CHECK (parent_grant_id IS NULL OR parent_grant_id <> id),

    -- A grant must have a subject appropriate to its type. Total over the enum:
    -- every subject type appears exactly once and pins EVERY subject column, so
    -- a row carrying, say, both a `subject_id` and a `subject_org_id` -- which
    -- would be a grant with two different meanings depending on which query read
    -- it -- cannot be written at all.
    CONSTRAINT grant_subject_coherent CHECK (
        (subject_type = 'actor'     AND subject_id IS NOT NULL AND secret_hash IS NULL
                                    AND subject_org_id IS NULL     AND subject_min_role IS NULL)
     OR (subject_type = 'link'      AND subject_id IS NULL     AND secret_hash IS NOT NULL
                                    AND subject_org_id IS NULL     AND subject_min_role IS NULL)
     OR (subject_type = 'anonymous' AND subject_id IS NULL     AND secret_hash IS NULL
                                    AND subject_org_id IS NULL     AND subject_min_role IS NULL)
     OR (subject_type = 'org'       AND subject_id IS NULL     AND secret_hash IS NULL
                                    AND subject_org_id IS NOT NULL AND subject_min_role IS NULL)
     OR (subject_type = 'role'      AND subject_id IS NULL     AND secret_hash IS NULL
                                    AND subject_org_id IS NOT NULL AND subject_min_role IS NOT NULL)
    ),

    -- Capability escalation guard: an anonymous grant may only ever read.
    CONSTRAINT grant_anonymous_read_only CHECK (
        subject_type <> 'anonymous' OR capabilities = ARRAY['read']::grant_capability[]
    ),

    -- Same rule for link grants. A share link is a bearer credential that
    -- travels through mail clients, chat logs and browser history; anything it
    -- carries beyond `read` turns a disclosure into a destruction. "Share link"
    -- reads as read-only to everyone who will ever use this API, so the schema
    -- now says so. Delegation onward from a link is likewise not possible,
    -- because `share` is not an available capability here: only a named actor
    -- can be trusted to pass authority on, and a named actor is revocable and
    -- attributable.
    CONSTRAINT grant_link_read_only CHECK (
        subject_type <> 'link' OR capabilities = ARRAY['read']::grant_capability[]
    ),

    CONSTRAINT grant_capabilities_nonempty CHECK (cardinality(capabilities) > 0),

    CONSTRAINT grant_downloads_within_cap CHECK (
        max_downloads IS NULL OR download_count <= max_downloads
    )
);

CREATE TRIGGER file_grant_project
    BEFORE INSERT OR UPDATE OF org_id ON file_grant
    FOR EACH ROW EXECUTE FUNCTION project_from_org();

CREATE INDEX grant_file_idx    ON file_grant (file_id) WHERE revoked_at IS NULL;
CREATE INDEX grant_subject_idx ON file_grant (subject_id) WHERE revoked_at IS NULL AND subject_id IS NOT NULL;
CREATE INDEX grant_secret_idx  ON file_grant (secret_hash) WHERE revoked_at IS NULL AND secret_hash IS NOT NULL;
CREATE INDEX grant_org_idx     ON file_grant (org_id);
CREATE INDEX grant_parent_idx  ON file_grant (parent_grant_id) WHERE parent_grant_id IS NOT NULL;
-- The group-grant path: (file, subject org) is what the membership join keys on,
-- and it is what keeps a group grant one index probe rather than a scan.
CREATE INDEX grant_subject_org_idx ON file_grant (file_id, subject_org_id)
    WHERE revoked_at IS NULL AND subject_org_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- GRANT LINEAGE AND LIVENESS (P4, transitive)
-- -----------------------------------------------------------------------------
--
-- The delegation chain, root last. Walks UP from a grant through its parents.
-- Depth is bounded by GRANT_MAX_DEPTH below and by the attenuation trigger, so
-- this terminates even if a cycle were somehow written.

CREATE FUNCTION grant_ancestry(p_grant_id uuid)
RETURNS TABLE (id uuid, depth integer)
LANGUAGE sql STABLE AS $$
    WITH RECURSIVE chain AS (
        SELECT g.id, g.parent_grant_id, 1 AS depth
          FROM file_grant g
         WHERE g.id = p_grant_id
        UNION ALL
        SELECT p.id, p.parent_grant_id, c.depth + 1
          FROM chain c
          JOIN file_grant p ON p.id = c.parent_grant_id
         WHERE c.depth < 64
    )
    SELECT chain.id, chain.depth FROM chain;
$$;

-- -----------------------------------------------------------------------------
-- GRANT SCOPE LIVENESS (P7) -- what a soft delete means
-- -----------------------------------------------------------------------------
--
-- THE DEFECT. `getMembership()` joined `org` on `deleted_at IS NULL`, so
-- soft-deleting a tenant removed every membership-derived access. Nothing
-- touched grants. So revoking an organization removed the OWNER's access and
-- left the CONTRACTOR's share links serving bytes, indefinitely. Nobody chose
-- that; it was an emergent asymmetry between two store methods, and it was a
-- silent ambiguity in the one property we sell hardest.
--
-- THE DECISION. A grant is live only while its SCOPE exists. Scope is the
-- transitive containment of the grant: its file, that file's org, that org's
-- project -- and the identities the grant is about: its subject and its issuer.
-- Delete any of them and every grant in that scope is dead on the next request,
-- at any delegation depth, with no cascading write.
--
--   project deleted -> every grant in every org of that project dies
--   org deleted     -> every grant on every file of that org dies
--   file deleted    -> every grant on that file dies
--   subject deleted -> every grant TO that actor dies
--   SUBJECT ORG deleted -> every group grant naming that org dies
--   issuer deleted  -> every grant THAT actor minted dies
--
-- WHY EACH, BRIEFLY (the long form is in SEMANTICS.md):
--
--  * ORG. A tenant whose deletion leaves its share links working is not
--    deleted. This case is indefensible on its face: "we
--    offboarded that customer" must mean the URLs stop.
--  * SUBJECT. Offboarding a person must end that person's access. This is the
--    least surprising rule in the file and it did not exist.
--  * SUBJECT ORG (I2, RFC-001). A group grant's subject is "the members of org
--    O". Delete O and that set is not empty, it is GONE -- there is no longer a
--    tenant whose members the grant could mean. The rule already says a deleted
--    org kills the grants ON its files; symmetry (and the plain reading of "we
--    offboarded that customer") requires it to kill the grants HELD BY its
--    members too. Without this term, soft-deleting a partner org would leave
--    its former members reading the other tenant's documents, which is the
--    org-deletion defect P7 exists to close, re-opened on a new axis.
--  * ISSUER. This is the one that is a judgement call, and the call is P4:
--    "a signed URL may never outlive the permission that created it". A root
--    grant is minted from the issuer's org-role authority. Delete the identity
--    and that authority is gone, so the grant must go with it. The alternative
--    -- links outliving the person who made them -- is the "the intern left
--    two years ago and their Dropbox link still works" failure, which is the
--    failure this product exists to remove. Note the deliberate asymmetry with
--    REMOVING A MEMBERSHIP, which does NOT kill issued grants: membership
--    removal is a role change inside a living tenant (duties get transferred),
--    identity deletion is erasure. See SEMANTICS.md.
--
-- WHY IT IS HERE AND NOT IN authz.ts. Exactly the reason transitive liveness is
-- here: a rule that lives in application code binds only the application. This
-- one predicate is what `live_grant`, `consume_download` and the attenuation
-- trigger all read, so there is no query that can opt out of it.
--
-- REVERSIBLE, BY CONSTRUCTION. Nothing is written when a scope is deleted, so
-- clearing `deleted_at` restores exactly the grants that were live before and
-- no others. Undelete is free precisely because delete was derived. That is
-- also why soft delete cannot be used to defeat RETENTION: it changes no row a
-- retention hold protects, and `retain_until` still blocks the hard delete.
--
-- NOT INCLUDED, DELIBERATELY: file EXPIRY. Expiry is a time gate, it is
-- extendable, and it is already evaluated by `lifecycleDenial()` on every
-- access and by the listing predicate. Scope liveness is about EXISTENCE. Two
-- different questions kept as two different mechanisms.
CREATE FUNCTION grant_scope_is_live(
    p_file_id       uuid,
    p_subject_id    uuid,
    p_created_by    uuid,
    p_subject_org_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
             SELECT 1
               FROM file f
               JOIN org o      ON o.id  = f.org_id
               JOIN project pr ON pr.id = o.project_id
              WHERE f.id = p_file_id
                AND f.deleted_at IS NULL
                AND f.state <> 'deleted'
                AND o.deleted_at  IS NULL
                AND pr.deleted_at IS NULL
           )
       AND NOT EXISTS (
             SELECT 1 FROM actor a WHERE a.id = p_subject_id AND a.deleted_at IS NOT NULL
           )
       AND NOT EXISTS (
             SELECT 1 FROM actor a WHERE a.id = p_created_by AND a.deleted_at IS NOT NULL
           )
       -- I2: the SUBJECT ORG of a group grant. Written as NOT EXISTS(deleted),
       -- exactly like the two actor terms above, so a NULL argument -- every
       -- actor, link and anonymous grant -- passes without touching `org`. The
       -- project half is already covered: the composite FK pins the subject org
       -- to the file's project, and the file's project is checked in the first
       -- term. So this term is exactly "is that tenant still there".
       --
       -- MEASURED COST, because this runs for EVERY grant on EVERY liveness
       -- check and most grants are not group grants: +6.5% on an
       -- eight-deep actor-grant lookup (0.848ms -> 0.902ms, PGlite, 400
       -- samples, same database, term removed vs present). An
       -- `p_subject_org_id IS NULL OR ...` short-circuit was tried and measured
       -- SLOWER (0.913ms) -- the planner already resolves the NULL probe
       -- without a scan -- so the simpler form is the one that ships. See the
       -- measurement section of the RFC-001 report.
       AND NOT EXISTS (
             SELECT 1 FROM org g WHERE g.id = p_subject_org_id AND g.deleted_at IS NOT NULL
           );
$$;

-- A grant is LIVE iff it, and every one of its ancestors, is unrevoked,
-- unexpired, under its download cap, AND within a scope that still exists.
--
-- WHY A FUNCTION AND NOT A TOP-DOWN RECURSIVE VIEW:
-- the obvious formulation is a view that recurses downward from live roots.
-- It is correct and it is also unusable: Postgres cannot push a predicate into
-- a recursive CTE, so `SELECT * FROM live_grant WHERE file_id = $1` would walk
-- every delegation tree in the entire database on every authorization check.
-- Packaging the recursion as a per-grant function keeps the predicate exactly
-- once (this function IS the definition; the view below is written in terms of
-- it) while letting the planner use grant_file_idx / grant_secret_idx first and
-- evaluate liveness only for the handful of rows that survive. COST 100 tells
-- the planner to order it last among the quals.
--
-- FAILS CLOSED: an unknown id, a chain longer than GRANT_MAX_DEPTH, or a cycle
-- all return false.
CREATE FUNCTION grant_is_live(p_grant_id uuid)
RETURNS boolean
LANGUAGE sql STABLE COST 100 AS $$
    WITH RECURSIVE chain AS (
        SELECT g.id,
               g.parent_grant_id,
               1 AS depth,
               (    g.revoked_at IS NULL
                AND (g.expires_at IS NULL OR g.expires_at > now())
                AND (g.max_downloads IS NULL OR g.download_count < g.max_downloads)
                AND grant_scope_is_live(g.file_id, g.subject_id, g.created_by, g.subject_org_id)
               ) AS self_live
          FROM file_grant g
         WHERE g.id = p_grant_id
        UNION ALL
        SELECT p.id,
               p.parent_grant_id,
               c.depth + 1,
               (    p.revoked_at IS NULL
                AND (p.expires_at IS NULL OR p.expires_at > now())
                AND (p.max_downloads IS NULL OR p.download_count < p.max_downloads)
                -- Scope is checked for every ANCESTOR too, not just the leaf.
                -- Delegation is same-file by foreign key, so the file/org/
                -- project half is redundant here -- but the SUBJECT and ISSUER
                -- halves are not: deleting the person a parent grant was issued
                -- to, or the person who minted it, must kill everything
                -- delegated below it. That is P7 obeying P4 transitively.
                AND grant_scope_is_live(p.file_id, p.subject_id, p.created_by, p.subject_org_id)
               )
          FROM chain c
          JOIN file_grant p ON p.id = c.parent_grant_id
         WHERE c.depth < 64
           AND c.self_live          -- stop as soon as an ancestor is dead
    )
    SELECT coalesce(bool_and(chain.self_live), false)
           -- If we stopped because of the depth bound rather than because we
           -- ran out of ancestors, we have not proven liveness. Deny.
           AND NOT EXISTS (
               SELECT 1 FROM chain d
                WHERE d.depth >= 64 AND d.parent_grant_id IS NOT NULL
           )
      FROM chain;
$$;

-- The liveness predicate, expressed once, so no caller can get it subtly wrong.
-- Every grant lookup in store.ts reads through this view.
CREATE VIEW live_grant AS
SELECT * FROM file_grant WHERE grant_is_live(id);

-- An INDEPENDENT, top-down formulation of the same property, used only by the
-- test suite as a cross-check on `grant_is_live`. Two implementations that must
-- agree on every row is a much stronger statement than one implementation
-- agreeing with itself. Not used on any hot path -- see the comment above for
-- why it must not be.
CREATE VIEW live_grant_recursive AS
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

-- -----------------------------------------------------------------------------
-- ATTENUATION -- enforced by trigger, and why it must be
-- -----------------------------------------------------------------------------
--
-- The rule: a delegated grant may never exceed its parent in ANY dimension --
-- capability set, expiry, or remaining download budget.
--
-- WHY NOT A CHECK CONSTRAINT: a CHECK may only reference columns of the row
-- being written. This invariant is inter-row (child vs parent), and Postgres
-- rejects subqueries in CHECK. So a CHECK is not merely weaker here, it is
-- impossible to express.
--
-- WHY NOT APPLICATION CODE: it was application code (`filelayer.share()`), and
-- that is precisely the defect -- any second writer, including
-- a psql session, a migration, an admin tool or a future endpoint, bypasses it.
--
-- A BEFORE ROW trigger is therefore the strongest enforcement Postgres offers
-- for this shape of invariant: it binds every writer, it runs inside the same
-- transaction as the INSERT, and it can normalise as well as reject.
--
-- Capabilities are REJECTED when they exceed the parent (silently narrowing an
-- authority someone asked for would hide a bug). Lifetime and budget are
-- CLAMPED to the parent's, because "inherit the parent's expiry" is the correct
-- and expected behaviour for a delegation with no expiry of its own -- and the
-- API returns the effective values, so the clamp is visible rather than silent.
--
-- -----------------------------------------------------------------------------
-- I6 -- SUBJECT BREADTH MAY NOT BE AMPLIFIED BY DELEGATION (RFC-001)
-- -----------------------------------------------------------------------------
--
-- THE RULE:
--
--   An issuer whose authority is ROLE-DERIVED (admin/owner of the file's org,
--   or the file's owner) may create ANY subject type.
--
--   An issuer whose authority is GRANT-DERIVED may delegate only to `actor`
--   or `link`. Never `org`, never `role`, never `anonymous`.
--
-- WHY. Capability attenuation already prevents a delegate from DOING MORE than
-- the authority they were handed. It says nothing at all about REACHING MORE
-- PEOPLE. Without I6, a contractor holding a single `{read, share}` grant --
-- the narrowest useful authority we issue -- could re-grant to an entire
-- organization, or to `anonymous`, and every capability check would still pass
-- because the child's capability set is a subset of the parent's. One
-- consultant's read access becomes a public link, and attenuation is satisfied
-- the whole way. Both dimensions have to be attenuated or neither is.
--
-- WHY IT IS ENFORCED HERE, IN THE KERNEL, AND NOT ONLY IN authz.ts. Precisely
-- the argument that put capability attenuation in this trigger: a rule that
-- lives in application code binds only the application. A psql session, a
-- migration, an admin tool or a future endpoint that writes `file_grant`
-- directly would otherwise bypass I6 completely. `parent_grant_id IS NOT NULL`
-- IS the definition of "this authority was grant-derived" -- it is the column
-- the engine sets from `decision.grantId`, and it is the same column the whole
-- of P4 is already built on -- so the invariant is expressible against the row
-- being written and needs no knowledge of the caller.
--
-- WHY NOT A CHECK CONSTRAINT: it could be one, since it only reads columns of
-- NEW. It lives in the trigger anyway so that the two halves of attenuation --
-- what you may DO and who you may REACH -- are stated, and refused, in one
-- place, with one vocabulary of `grant_*` refusal names that `schemaRefusal()`
-- in authz.ts already mirrors.

CREATE FUNCTION file_grant_attenuate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    p          file_grant%ROWTYPE;
    v_remain   integer;
    v_depth    integer;
BEGIN
    -- Re-parenting is how a cycle would be created, and a cycle in a liveness
    -- graph is a denial-of-service at best. Lineage is immutable.
    IF TG_OP = 'UPDATE' AND NEW.parent_grant_id IS DISTINCT FROM OLD.parent_grant_id THEN
        RAISE EXCEPTION 'grant_lineage_immutable: parent_grant_id cannot be changed';
    END IF;

    IF NEW.parent_grant_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- I6. SUBJECT BREADTH. Checked FIRST, and before the parent is even read,
    -- because it is the one attenuation dimension that does not depend on the
    -- parent's contents: grant-derived authority may name a person or mint a
    -- bearer link, and nothing wider, whatever the parent happens to hold.
    IF NEW.subject_type NOT IN ('actor', 'link') THEN
        RAISE EXCEPTION
            'grant_subject_amplification: a delegated grant may only name an actor or a link, not % (I6)',
            NEW.subject_type;
    END IF;

    SELECT * INTO p FROM file_grant WHERE id = NEW.parent_grant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'grant_parent_missing: parent grant % does not exist', NEW.parent_grant_id;
    END IF;

    -- Delegation depth is bounded so that liveness evaluation is bounded.
    SELECT count(*) INTO v_depth FROM grant_ancestry(NEW.parent_grant_id);
    IF v_depth >= 32 THEN
        RAISE EXCEPTION 'grant_delegation_too_deep: delegation chain would exceed 32';
    END IF;

    -- You cannot delegate an authority you no longer have. (Belt; the recursive
    -- liveness check is the braces -- a child minted in a race with the
    -- parent's revocation is born dead rather than orphaned.)
    IF NOT grant_is_live(p.id) THEN
        RAISE EXCEPTION 'grant_parent_not_live: cannot delegate from a dead grant';
    END IF;

    -- Capability attenuation. The child's set must be a subset.
    IF NOT (NEW.capabilities <@ p.capabilities) THEN
        RAISE EXCEPTION 'grant_capability_amplification: % exceeds parent %',
            NEW.capabilities, p.capabilities;
    END IF;

    -- Lifetime attenuation. A child may be shorter-lived, never longer.
    IF p.expires_at IS NOT NULL
       AND (NEW.expires_at IS NULL OR NEW.expires_at > p.expires_at) THEN
        NEW.expires_at := p.expires_at;
    END IF;

    -- Budget attenuation, against the parent's REMAINING budget.
    IF p.max_downloads IS NOT NULL THEN
        v_remain := p.max_downloads - p.download_count;
        IF v_remain <= 0 THEN
            RAISE EXCEPTION 'grant_parent_exhausted: parent has no downloads left to delegate';
        END IF;
        IF NEW.max_downloads IS NULL OR NEW.max_downloads > v_remain THEN
            NEW.max_downloads := v_remain;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- `UPDATE OF` matters: this must NOT fire for `consume_download` (which touches
-- only download_count) or for revocation (revoked_at), both of which can make a
-- parent legitimately non-live while its children are being updated.
--
-- The subject columns are in the list for I6. Attenuation that binds only at
-- INSERT is attenuation a second statement walks around: without them,
-- `UPDATE file_grant SET subject_type='org', subject_org_id=... WHERE id=<child>`
-- would widen a delegated grant from one person to an entire organization and
-- never touch this function.
CREATE TRIGGER file_grant_attenuation
    BEFORE INSERT OR UPDATE OF parent_grant_id, capabilities, expires_at, max_downloads,
                               subject_type, subject_id, subject_org_id, subject_min_role
    ON file_grant
    FOR EACH ROW EXECUTE FUNCTION file_grant_attenuate();

-- -----------------------------------------------------------------------------
-- ATOMIC DOWNLOAD RESERVATION (P6)
-- -----------------------------------------------------------------------------
-- The reservation is the write. There is no window between checking and
-- consuming, so N concurrent requests against max_downloads=1 yield exactly 1
-- success.
--
-- A download now consumes the budget of the ENTIRE ancestor chain. Without
-- that, "a child's cap may not exceed the parent's remaining budget" is true
-- only at the instant of creation: mint three children from a parent with 5
-- downloads left and you have sold 15. Charging every ancestor makes the
-- parent's cap a real budget over the whole delegation tree, and it makes
-- exhaustion propagate downward for free through `grant_is_live`.
--
-- Rows are locked in id order, which is what makes concurrent redemptions of
-- two siblings deadlock-free.
--
-- This ALWAYS returns exactly one row. Denial is `(false, 0)`, not the
-- absence of a row, so the plausible caller mistake `rows[0]?.granted ?? true`
-- can no longer fail open.
CREATE FUNCTION consume_download(p_grant_id uuid)
RETURNS TABLE (granted boolean, remaining integer)
LANGUAGE plpgsql AS $$
DECLARE
    v_ids       uuid[];
    v_id        uuid;
    v_ok        boolean;
    v_remaining integer;
BEGIN
    SELECT array_agg(a.id ORDER BY a.id) INTO v_ids FROM grant_ancestry(p_grant_id) a;
    IF v_ids IS NULL THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    -- Deterministic lock order over the whole chain.
    FOREACH v_id IN ARRAY v_ids LOOP
        PERFORM 1 FROM file_grant g WHERE g.id = v_id FOR UPDATE;
    END LOOP;

    -- The same four dimensions `grant_is_live` uses, re-evaluated here UNDER THE
    -- ROW LOCKS rather than trusted from the caller's earlier check. Scope
    -- liveness (P7) adds
    -- the fourth: a grant whose org, project, file, subject or issuer has been
    -- deleted may not spend a download, even in the window between the
    -- authorization decision and the reservation.
    SELECT bool_and(
               g.revoked_at IS NULL
               AND (g.expires_at IS NULL OR g.expires_at > now())
               AND (g.max_downloads IS NULL OR g.download_count < g.max_downloads)
               AND grant_scope_is_live(g.file_id, g.subject_id, g.created_by, g.subject_org_id)
           )
      INTO v_ok
      FROM file_grant g
     WHERE g.id = ANY (v_ids);

    IF NOT coalesce(v_ok, false) THEN
        RETURN QUERY SELECT false, 0;
        RETURN;
    END IF;

    UPDATE file_grant g
       SET download_count = g.download_count + 1
     WHERE g.id = ANY (v_ids);

    -- The binding constraint is the tightest remaining budget in the chain.
    SELECT min(g.max_downloads - g.download_count)
      INTO v_remaining
      FROM file_grant g
     WHERE g.id = ANY (v_ids) AND g.max_downloads IS NOT NULL;

    RETURN QUERY SELECT true, v_remaining;
END;
$$;

-- -----------------------------------------------------------------------------
-- AUDIT (P5)
-- -----------------------------------------------------------------------------
-- Append-only. Records denials as well as successes. Hash-chained per org so
-- that deletion or alteration of history is detectable -- this is what makes
-- the log a compliance artifact rather than a convenience.
--
-- org_id IS NULLABLE, and that is a security feature, not laxity. A probe
-- against a file id that does not exist, or a sweep against link secrets, has
-- no tenant to charge it to. Guessing one would leak existence; dropping the
-- event, which is what we did before, made the single most characteristic
-- reconnaissance pattern against an object store completely invisible.
-- Such events go to the SYSTEM chain (org_id IS NULL), which is chained
-- and verifiable like any other and which no tenant-facing API can read.

CREATE TABLE audit_event (
    id              bigserial PRIMARY KEY,
    org_id          uuid REFERENCES org(id) ON DELETE CASCADE,   -- NULL = system chain

    occurred_at     timestamptz NOT NULL DEFAULT now(),
    action          text NOT NULL,          -- file.read, grant.revoke, member.add, ...
    decision        text NOT NULL CHECK (decision IN ('allow', 'deny')),
    reason          text,                   -- why denied; null when allowed

    -- These three carry NO foreign key, and that is deliberate.
    --
    -- `actor_id` used to be `REFERENCES actor(id) ON DELETE SET NULL`, and it
    -- was a serious defect in two directions at once:
    --
    --  (a) A caller presenting a WELL-FORMED BUT UNREGISTERED actor id could
    --      not be audited at all: the INSERT raised a foreign-key violation,
    --      the exception propagated out of `authorize()`, the denial was never
    --      recorded, and the caller received a 500 instead of the uniform 404.
    --      A registered actor with no access got 404 and an unregistered one
    --      got 500, so the error surface was an ACTOR-EXISTENCE ORACLE -- the
    --      existence oracle reopened on a different axis -- and an actor-id
    --      sweep left no trace, which is exactly the invisible-enumeration
    --      defect this table exists to prevent.
    --  (b) `ON DELETE SET NULL` erased attribution from history when an actor
    --      was deleted. An audit log that forgets who did something is not an
    --      audit log; deleting a user must not rewrite what they did.
    --
    -- `file_id` and `grant_id` were already FK-free for reason (a). The audit
    -- log must be able to record an identifier that does not exist, because
    -- recording probes at identifiers that do not exist is its job.
    actor_id        uuid,
    file_id         uuid,
    grant_id        uuid,

    ip              inet,
    user_agent      text,
    context         jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Tamper evidence: each event chains to the previous event in its org.
    -- The chain now commits to every forensically relevant column, not
    -- just the seven that used to be covered.
    prev_hash       text,
    hash            text NOT NULL
);

CREATE INDEX audit_org_time_idx ON audit_event (org_id, occurred_at DESC);
CREATE INDEX audit_file_idx     ON audit_event (file_id) WHERE file_id IS NOT NULL;
CREATE INDEX audit_actor_idx    ON audit_event (actor_id) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_deny_idx     ON audit_event (org_id, occurred_at DESC) WHERE decision = 'deny';
CREATE INDEX audit_system_idx   ON audit_event (occurred_at DESC) WHERE org_id IS NULL;

-- Append-only enforcement. Audit rows cannot be updated or deleted through
-- normal privileges; retention trimming is a separate privileged path.
CREATE RULE audit_no_update AS ON UPDATE TO audit_event DO INSTEAD NOTHING;
CREATE RULE audit_no_delete AS ON DELETE TO audit_event DO INSTEAD NOTHING;

-- -----------------------------------------------------------------------------
-- THE CHAIN CANNOT FORK
-- -----------------------------------------------------------------------------
--
-- THE DEFECT. The chain was appended by a SELECT (read the last hash) followed
-- by an INSERT, in application code, in two separate statements. That is atomic
-- only if there is exactly one writer. With two, both read the same `prev_hash`
-- and both insert: the chain FORKS. `verifyAuditChain` then reports
-- `prev_hash_mismatch` at the second of the two -- so a perfectly honest log
-- looks tampered with, and, worse, a genuinely tampered log is no longer
-- distinguishable from routine concurrency. Tamper evidence that cries wolf is
-- not tamper evidence.
--
-- It was documented as a single-writer limitation. A hosted deployment WILL
-- have concurrent writers -- one per API process, many per box -- so the
-- limitation is now a defect.
--
-- THE FIX, AND WHY IT IS ONE STATEMENT. `pg_advisory_xact_lock` is held until
-- the end of the TRANSACTION. In autocommit -- which is how the store issues
-- queries, and how `pg.Pool.query` behaves -- each statement is its own
-- transaction, so taking the lock in one statement and inserting in the next
-- releases it in between and buys nothing at all. The lock, the read of the
-- predecessor, the hash and the insert must therefore be ONE statement. They
-- are: this function. `SELECT * FROM audit_append(...)` is a single statement,
-- so the lock is held from the moment it is taken until the row is committed,
-- and a second writer on the same chain waits.
--
-- It also means the chain construction is no longer something a caller can get
-- wrong or skip: there is no supported path that writes `audit_event` without
-- coming through here.
--
-- WHY THE HASH IS COMPUTED IN SQL, AND WHY THAT IS NOT A SECOND IMPLEMENTATION.
-- The digest input is `JSON.stringify([prevHash, orgId, ...])`, and `prevHash`
-- is the FIRST element -- deliberately, so that everything AFTER it can be
-- serialized by the caller and passed in as `p_hash_tail`. This function only
-- prepends the predecessor it just read under the lock. So the canonical
-- encoding still exists in exactly one place (store.ts, `auditHashTail`), and
-- this function performs one string concatenation, not a re-implementation.
-- `verifyAuditChain` recomputes the whole digest in TypeScript on read, so
-- every write is cross-checked against an independent implementation by every
-- test that verifies a chain.
--
-- WHAT PGlite CANNOT PROVE: PGlite has ONE backend. Two transactions cannot
-- exist at the same instant, so no test in this repository can demonstrate lock
-- contention, a waiting writer, or a fork prevented. What the tests DO prove is
-- stated in test/semantics.test.ts: that the lock is taken on the write
-- path, that the key is per-chain, that the SQL digest equals the TypeScript
-- digest, and -- by simulating the fork the old code would have produced -- that
-- a forked chain is detected. Proving serialization requires a real
-- multi-connection Postgres and belongs in the deployment test suite.

-- One lock namespace, so that Filelayer's chain lock cannot collide with an
-- advisory lock taken by anything else sharing the database. The system chain
-- (org_id IS NULL) is its own chain and gets its own key.
CREATE FUNCTION audit_chain_lock_key(p_org_id uuid) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
    SELECT (hashtext('filelayer.audit_chain')::bigint << 32)
         | (hashtext(coalesce(p_org_id::text, '__system__'))::bigint & x'ffffffff'::bigint);
$$;

CREATE FUNCTION audit_append(
    p_org_id      uuid,
    p_occurred_at timestamptz,
    p_action      text,
    p_decision    text,
    p_reason      text,
    p_actor_id    uuid,
    p_file_id     uuid,
    p_grant_id    uuid,
    p_ip          inet,
    p_user_agent  text,
    p_context     jsonb,
    p_hash_tail   text        -- JSON.stringify([...everything after prev_hash])
)
RETURNS TABLE (id bigint, prev_hash text, hash text)
LANGUAGE plpgsql AS $$
DECLARE
    v_prev text;
    v_hash text;
BEGIN
    -- Serializes every writer on this chain for the rest of the transaction.
    -- Because this function is invoked as one statement, "the rest of the
    -- transaction" is "until this row is committed".
    PERFORM pg_advisory_xact_lock(audit_chain_lock_key(p_org_id));

    SELECT a.hash INTO v_prev
      FROM audit_event a
     WHERE a.org_id IS NOT DISTINCT FROM p_org_id
     ORDER BY a.id DESC
     LIMIT 1;

    v_hash := encode(
        digest(
            convert_to(
                '[' || coalesce(to_json(v_prev)::text, 'null') || ',' || p_hash_tail,
                'utf8'),
            'sha256'),
        'hex');

    RETURN QUERY
    INSERT INTO audit_event
        (org_id, occurred_at, action, decision, reason, actor_id, file_id,
         grant_id, ip, user_agent, context, prev_hash, hash)
    VALUES
        (p_org_id, p_occurred_at, p_action, p_decision, p_reason, p_actor_id,
         p_file_id, p_grant_id, p_ip, p_user_agent, p_context, v_prev, v_hash)
    RETURNING audit_event.id, audit_event.prev_hash, audit_event.hash;
END;
$$;

-- -----------------------------------------------------------------------------
-- METERING
-- -----------------------------------------------------------------------------
-- Two per-tenant, per-day rollups an operator needs and cannot reconstruct
-- after the fact, because neither is derivable from the object store and the
-- audit trail is an append-only record of decisions rather than a counter.
--
-- The work this system does is dominated by the authorization decision, not by
-- the bytes. Every read, every share redemption and every listing walks
-- membership, roles and grants; that walk scales with the number of distinct
-- people who hold files, not with how much they hold. A deployment that only
-- watches stored bytes therefore has no signal for the load it is carrying and
-- no way to answer "which tenant is driving this?" when latency moves.
--
-- These counters are written best-effort and outside the delivery transaction:
-- a metering failure must never fail a request that was already authorized and
-- audited. Treat them as a capacity and attribution signal. The audit trail,
-- not this, is the record of what happened.

CREATE TABLE usage_daily (
    org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
    day             date NOT NULL,
    authz_checks    bigint NOT NULL DEFAULT 0,
    file_reads      bigint NOT NULL DEFAULT 0,
    file_writes     bigint NOT NULL DEFAULT 0,
    bytes_stored    bigint NOT NULL DEFAULT 0,
    bytes_egressed  bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, day)
);

-- Distinct actors who owned or accessed a file on a given day. `usage_daily`
-- tells you how much work happened; this tells you how many distinct people it
-- was spread across, which is the quantity authorization load actually tracks.
-- The primary key makes it idempotent: one row per actor per day, however many
-- files that actor touches.
CREATE TABLE file_owning_user_daily (
    org_id          uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
    day             date NOT NULL,
    actor_id        uuid NOT NULL REFERENCES actor(id) ON DELETE CASCADE,
    PRIMARY KEY (org_id, day, actor_id)
);
