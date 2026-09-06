# Migrations and the compatibility promise

How schema changes reach you, what upgrading costs, and what we do and do not
promise before 1.0.

---

## 1. The promise, stated narrowly

Filelayer is `0.x`. The version is `0.MINOR.PATCH` and it means:

| Change | Version bump | What you must do |
|---|---|---|
| Breaking API change, breaking schema change, or both | **MINOR** (`0.3.x` → `0.4.0`) | Read the entry in this file. Run its SQL. Possibly edit call sites. |
| Additive API, bug fix, doc fix, new optional column with a default | **PATCH** (`0.3.0` → `0.3.1`) | `npm update`. Nothing else. |

There is no long-term support branch, no backporting, and no deprecation period
before 1.0. A minor bump may remove a method in the same release that replaces
it. That is what `0.x` means and it is why this file exists: the compensation
for moving fast is that every break is written down, with the SQL, before it
ships.

At 1.0 this changes to ordinary semantic versioning, and schema changes become
additive-with-a-deprecation-window rather than replace-in-place.

**Nothing has been published to npm yet.** At the time of writing there are no
installs, so no migration in this file has ever been executed by anyone other
than us. Entry 1 below is written as if it had been, because the next one will
be.

---

## 2. How a schema change is delivered

There is no migration framework and there is not going to be one. Filelayer
owns a schema; your application owns a migration runner. Wrapping ours in a tool
that competes with yours would be the wrong kind of opinionated.

What we ship instead:

1. **`schema.sql` is the whole, current, canonical schema.** It is idempotent
   only in the sense that it creates a database from nothing. It is not a
   sequence of migrations and it will not upgrade an existing database.
   Programmatic access, so a runner does not hardcode a path:

   ```ts
   import { SCHEMA_PATH, loadSchemaSql } from '@filelayer/core';
   ```

2. **Every breaking schema change gets a numbered entry in this file** with the
   forward SQL, written to be pasted into your own migration tool, plus what it
   costs and what it breaks in the API.

3. **The version in `package.json` is the contract.** If your installed schema
   was applied from `0.3.x`, entries above `0.3` apply to you in order.

### Recording which version your database is at

There is no `schema_version` table today, and that is a gap we are naming rather
than hiding: right now you have to know which release you applied. If you have
just deployed, record it yourself:

```sql
COMMENT ON SCHEMA public IS 'filelayer schema 0.3.0';
```

A real version table lands before 1.0.

### The order that is safe

Schema changes below are written to be applied **before** the new library
version is deployed, not after. Every one of them is designed so that the
previous library version keeps working against the new schema for the length of
a deploy — which means the safe sequence is always:

1. apply the SQL,
2. verify the old processes are still healthy,
3. roll the new library version out,
4. run any backfill the entry mentions.

Where an entry cannot honour that, it says so in bold at the top.

---

## 3. Migrations

### Entry 1 — `0.2.x` → `0.3.0`: identifiers become per-project

**Breaking. Schema and API. This is a security fix; do not skip it.**

#### What was wrong

`org.external_id` and `actor.external_id` were **globally unique**. That is
correct for a library where each customer runs their own database, and it is a
cross-customer data breach the moment more than one application shares one.

The failure was not a collision error. It was a silent success:

- The identity resolver upserts a customer's own org id with
  `INSERT ... ON CONFLICT (external_id) DO UPDATE ... RETURNING id`. Under a
  global unique index, application B calling `put({ org: 'acme' })` did not get
  an error — it got application A's org id, and then the resolver helpfully
  added B's user to A's tenant as a `member`.
- Actor resolution had the same shape, so `as: 'alice'` in application B
  resolved to application A's Alice.

A complete cross-tenant compromise, reachable from the most ergonomic entry
point in the library, requiring no attacker skill beyond picking a common org
name.

#### What changed

A scope above the tenant: the **project**, which is one customer application.
`external_id` is the customer's id space, so it is unique *within* a project and
meaningless across projects.

- New table `project`, plus a default project row
  (`00000000-0000-0000-0000-0000000f11e1`) so that a single-application
  deployment needs no project vocabulary at all.
- `org` and `actor` gain `project_id`, and their unique constraints become
  `UNIQUE (project_id, external_id)`.
- Every table that can name an actor carries `project_id` under a composite
  foreign key, so a cross-project membership, ownership, grant subject or grant
  issuer is *unrepresentable* — the same standard cross-tenant access is held
  to, one level up.
- `project_id` is **derived, never supplied**: a trigger overwrites whatever a
  writer passed with the value read from the owning org.

#### The migration

For a deployment that has data. Every existing row lands in one project, which
is exactly what a pre-project deployment was.

```sql
BEGIN;

-- 1. The project table, and the default project every existing row belongs to.
CREATE TABLE project (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key         text NOT NULL UNIQUE,
    name        text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

INSERT INTO project (id, key, name)
VALUES ('00000000-0000-0000-0000-0000000f11e1',
        '__filelayer_default_project__',
        'Default project');

-- 2. Drop the global uniqueness that was the defect.
ALTER TABLE org   DROP CONSTRAINT org_external_id_key;
ALTER TABLE actor DROP CONSTRAINT actor_external_id_key;

-- 3. Scope both id spaces to a project.
ALTER TABLE org   ADD COLUMN project_id uuid NOT NULL
                  DEFAULT '00000000-0000-0000-0000-0000000f11e1'
                  REFERENCES project(id) ON DELETE CASCADE;
ALTER TABLE actor ADD COLUMN project_id uuid NOT NULL
                  DEFAULT '00000000-0000-0000-0000-0000000f11e1'
                  REFERENCES project(id) ON DELETE CASCADE;

ALTER TABLE org   ADD CONSTRAINT org_project_external_key   UNIQUE (project_id, external_id);
ALTER TABLE actor ADD CONSTRAINT actor_project_external_key UNIQUE (project_id, external_id);

-- 4. The composite keys that make a cross-project row unrepresentable.
ALTER TABLE org   ADD CONSTRAINT org_id_project_key   UNIQUE (id, project_id);
ALTER TABLE actor ADD CONSTRAINT actor_id_project_key UNIQUE (id, project_id);

COMMIT;
```

Then apply, from the `0.3.0` `schema.sql`, in this order:

1. the `project_id` columns and composite foreign keys on `membership`, `file`
   and `grant`;
2. the `project_from_org()` trigger function and its triggers;
3. the updated `grant_scope_is_live()` — it now also requires the owning
   project to be live.

Copy those blocks verbatim from `schema.sql`; they are commented at the
constraint that enforces each property. Doing it by hand from this file would be
transcription, and transcription is how a security migration goes wrong.

#### If you would rather not migrate

There were no installs at `0.2.x`, so the supported answer is: **drop and
recreate.** If your data is disposable, that is one command and it is the path
we took.

#### What it costs

- Three new columns, three new unique indexes, one trigger per affected table.
  Negligible at any size we can currently defend claims about.
- The composite foreign keys are validated on `ALTER TABLE`, which takes an
  `ACCESS EXCLUSIVE` lock. On a large `grant` table, add them `NOT VALID` first
  and `VALIDATE CONSTRAINT` afterwards.

#### What it breaks in the API

Nothing, for a single-application deployment. `Filelayer.quickstart()` and the
`fl.files` / `fl.orgs` / `fl.shares` facades resolve into the default project
and read exactly as before. If you run more than one application against one
database, you must name a project — and before this change you could not, which
was the whole problem.

#### The secondary effect worth knowing

Project scoping is also what bounds unauthenticated audit-chain growth. A caller
probing org ids can only reach a tenant chain inside a project they are already
authenticated for; probes at every other id land on the system chain. That turns
"any internet caller can degrade any tenant" into "an authenticated customer can
degrade their own tenant" — a quota question rather than a security one. Ingest
rate limiting is still required; see `SEMANTICS.md`.

---

### Entry 2 — `0.3.0` → `0.4.0`: group grant subjects (RFC-001)

#### What was missing

`grant_subject` was `actor | link | anonymous`. Org-wide access existed only as
`file.visibility = 'org'`, which applies only to the file's **own** org. So
"every member of *that* organization may read this file" had no representation
at all, and "all admins of this org" had none either. Both were being worked
around with per-user fan-out, which makes membership changes only *eventually*
consistent with access — the opposite of the property the product sells.

#### What changed

`grant_subject := actor | org | role | link | anonymous`, plus two columns on
`file_grant`. Resolution is a join against `membership`, never a
materialization. See `SEMANTICS.md` §1a and §7b.

**This is a breaking schema change and an additive API change.** No existing
call site changes; `ShareInput.subject` gains two variants and
`shares.create` gains `withOrg` / `minRole`.

#### The migration

```sql
BEGIN;

-- 1. Two new subject types. They must be added in breadth order for the
--    enum's declaration order to remain meaningful to a reader; nothing in
--    the code depends on it (the role threshold is generated from
--    ROLE_RANK in authz.ts, never from the enum's ordinals).
ALTER TYPE grant_subject ADD VALUE IF NOT EXISTS 'org'  AFTER 'actor';
ALTER TYPE grant_subject ADD VALUE IF NOT EXISTS 'role' AFTER 'org';

COMMIT;   -- an added enum value must commit before it can be used

BEGIN;

-- 2. The subject columns. Both nullable; every existing row is unaffected.
ALTER TABLE file_grant ADD COLUMN subject_org_id   uuid;
ALTER TABLE file_grant ADD COLUMN subject_min_role org_role;

-- 3. I1/P8: the subject org must be in the same PROJECT as the file.
--    `project_id` is derived from the file's org by trigger, so this is
--    what makes a cross-project group grant unrepresentable.
--    NOT VALID first on a large table, then VALIDATE, to avoid holding
--    ACCESS EXCLUSIVE for the scan.
ALTER TABLE file_grant
  ADD CONSTRAINT file_grant_subject_org_id_project_id_fkey
  FOREIGN KEY (subject_org_id, project_id) REFERENCES org (id, project_id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE file_grant VALIDATE CONSTRAINT file_grant_subject_org_id_project_id_fkey;

-- 4. Subject coherence, replaced wholesale. Copy the new constraint body
--    verbatim from schema.sql rather than transcribing it.
ALTER TABLE file_grant DROP CONSTRAINT grant_subject_coherent;
-- ...then the five-branch CHECK from schema.sql.

CREATE INDEX CONCURRENTLY grant_subject_org_idx ON file_grant (file_id, subject_org_id)
  WHERE revoked_at IS NULL AND subject_org_id IS NOT NULL;

COMMIT;
```

Then replace, verbatim from the `0.4.0` `schema.sql`:

1. `grant_scope_is_live()` — it takes a fourth argument, `p_subject_org_id`, and
   gains the I2 term. **Its five call sites must be updated together**:
   `grant_is_live()` (twice), `live_grant_recursive` (twice) and
   `consume_download()`. Missing one leaves a group grant alive after its
   subject org is deleted.
2. `file_grant_attenuate()` — it gains the **I6** check, and its trigger's
   `UPDATE OF` list gains the four subject columns. Without the trigger change,
   a delegated grant can be widened to an entire organization by a second
   `UPDATE` statement.

#### What it costs

Two nullable columns, one partial index, one foreign key. The added subject-org
liveness term costs **+6.5%** on an eight-deep grant lookup, and the two extra
columns account for a further low-single-digit percentage through row width.
A group-grant decision is **~1.9 ms** against **~1.3 ms** for an actor-grant
decision on PGlite — one extra query, one join, and **independent of the size of
the named org**: the figure is measured against a 200-member org holding two
grant rows in total. Reproduce the timings with `npm run dev:bench` from the
repository root of a clone.

Authorization via an **org role** is unchanged (0.61 ms before and after):
standing resolution reaches the role first and returns before the group lookup
is issued.

#### What it does not do

No custom groups, no nested orgs, no configurable inheritance, no deny rules.
`file.visibility = 'org'` is retained and is unchanged.

---

## 4. What is not covered here

- **Data migration between storage adapters.** Moving objects from one bucket to
  another is outside the library. `file.storage_provider` and
  `file.storage_key` form a unique pair and are half of an object's identity, so
  changing `provider` on an existing deployment repoints every row at a store
  that does not have the bytes. There is no supported path for this yet.
- **Downgrades.** None of the entries above has a reverse script. Restore from a
  backup.
- **Audit chain rewriting.** By construction there is none: `audit_event` has
  rules that make `UPDATE` and `DELETE` no-ops, and the chain is verified by
  recomputation. A migration that needed to rewrite history would invalidate
  every subsequent hash, and we would rather that be impossible than
  documented.
