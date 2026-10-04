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

**No migration in this file has been executed by anyone other than us.** The
package is published — `0.3.0` onward are on npm — but there are no known
deployments, so every entry below is written as if it had run somewhere, because
sooner or later one will and that is not the moment to start being careful.

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

### Entry 3 — `0.4.x` → `0.5.0`: a password is refused where it was never enforced

#### The defect

`share()` hashed and stored `password` for **every** subject type, but
`authorize()` consults `password_hash` on the **link** branch alone. A hash
stored on any other subject type was therefore a hash nothing ever read.

The consequence was not cosmetic. This call:

```ts
await fl.share(principal, fileId, {
  subject: { type: 'anonymous' },
  capabilities: ['read'],
  password: 'hunter2',
});
```

was accepted, stored the hash, and published the file to **anyone, with no
password at all**. There was no error, no warning, and nothing in the audit log
to notice, and at the call site it looked exactly like publishing behind a
password. The link path enforced the same option correctly, which is what made
the mistake plausible.

Found by internal audit on 2026-09-29, in the published `0.4.4`. No known
deployment was affected, because there are no known deployments — we are
recording it here anyway, per `SECURITY.md`.

#### What changed

Two independent refusals, because one `if` is a thing a refactor can drop:

- `share()` raises `400 password_requires_link_subject` when `password` is
  supplied with a subject that is not `link`.
- `file_grant` gains `CONSTRAINT grant_password_only_on_link`, so the row is
  refused from any writer, including `psql`.

`ShareInput.password` keeps its type and its meaning on links. Nothing else
changes.

**This is a breaking change** in the narrow sense that a call which previously
returned a grant now raises. If you were passing `password` with a non-link
subject, that call was not doing what it appeared to do, and the fix is to
remove the argument or to switch the subject to `link`.

#### The migration

The constraint will refuse to apply if any offending row exists. Find them
first — and treat each one as a file that has been publicly readable:

```sql
-- 1. Anything here was published without the protection its creator intended.
SELECT id, file_id, org_id, subject_type, created_at
  FROM file_grant
 WHERE password_hash IS NOT NULL
   AND subject_type <> 'link';
```

Decide per row: revoke it, or clear the hash that was never doing anything.
Revoking is the safer default, because the grant is not what its author asked
for.

```sql
BEGIN;

-- 2a. Revoke them (recommended), OR
UPDATE file_grant
   SET revoked_at = now()
 WHERE password_hash IS NOT NULL AND subject_type <> 'link';

-- 2b. ...keep them open and drop the inert hash. Only if you have confirmed
--     each file is genuinely meant to be public.
UPDATE file_grant
   SET password_hash = NULL
 WHERE password_hash IS NOT NULL AND subject_type <> 'link';

-- 3. Now the constraint applies.
ALTER TABLE file_grant
  ADD CONSTRAINT grant_password_only_on_link
  CHECK (password_hash IS NULL OR subject_type = 'link');

COMMIT;
```

Note that 2a alone is not enough to let step 3 succeed: a revoked grant still
has its `password_hash`. Run 2a **and** 2b if you revoke.

---

### Entry 4 — `0.4.x` → `0.5.0`: client addresses are canonicalised before hashing

#### The defect

`auditHashTail()` builds the audit digest in the application process from the
submitted address string. The column is `inet`, which Postgres canonicalises on
the way in, and `verifyAuditChain()` recomputes the digest from `host(ip)`.
`normalizeIp()` validated the shape and returned the string **unchanged**.

So `2001:0db8::1` — one leading zero, which plenty of clients emit — hashed one
value and verified against another, and that tenant's chain read as
`hash_mismatch` from that row onward. Permanently, because `audit_event` is
append-only. `X-Forwarded-For` is attacker-controlled, so this was one header
away from anybody.

#### What changed

`normalizeIp()` now returns the address in exactly the form `host(inet)` reads
back — the `inet_ntop` algorithm, not an approximation of it. It is
differentially tested against Postgres over a randomised corpus in
`test/persistence.test.ts`, because "matches libc" is a claim that has to be
checked against libc.

No schema change. No API change.

#### The migration

**None for new events.** Existing chains that were already broken by this cannot
be repaired — the rows are append-only and the digest is over data that was
never stored. To find out whether you are affected:

```sql
SELECT DISTINCT org_id
  FROM audit_event
 WHERE family(ip) = 6
   AND host(ip) <> text(ip);
```

If that returns nothing, no chain was ever broken by this. If it returns rows,
`verifyAuditChain()` will report `hash_mismatch` at the first of them for those
tenants, and will verify cleanly for every event appended after upgrading.

---

### Entry 5 — `0.5.0` → `0.5.1`: every index on `file_grant` becomes reachable

#### The defect

Not a correctness defect. Every authorization decision read `file_grant` without
using any of its indexes, and the cost grew with the number of grants in the
database.

`file_grant` carries six indexes, five of them partial on `revoked_at IS NULL`. A
partial index is only usable by a query whose predicate the planner can prove
implies the index predicate — and no query in `store.ts` did.

Two separate reasons, same symptom. Every grant lookup reads `live_grant`, which
was `SELECT * FROM file_grant WHERE grant_is_live(id)`; a function call is opaque
to the planner, so `revoked_at IS NULL` was unprovable. And
`findGrantBySecret()`, which reads `file_grant` directly, never stated it.

The consequence was worse than a sequential scan. On the `live_grant` paths the
planner evaluated `grant_is_live(id)` — a recursive CTE declared `COST 100` —
once per candidate row. `getActorGrants()` was not even a scan: it used the
composite unique key, read every grant on the file, and called the function on
all of them.

Which request paid for it matters. `redeemStream()` resolves a link secret to a
file **before** authorizing anything, because a revoked link has to reach the
engine for its denial to be attributed to the right tenant. So the table scan sat
on the one path an unauthenticated caller reaches with `GET /d/<secret>`.

Measured on 6,001 grants with a tenth revoked, before → after:

| lookup | before | after |
|---|---|---|
| `findGrantBySecret` | Seq Scan, 6001 rows filtered | `grant_secret_idx`, 0 |
| `findLiveGrantBySecret` | Seq Scan, 6001 rows filtered | `grant_secret_idx`, 0 |
| `getActorGrants` | 6001 rows filtered | `grant_subject_idx`, 0 |
| `getAnonymousGrant` | 6000 rows filtered | `grant_file_subject_type_idx`, 0 |

#### What changed

`live_grant` now states `revoked_at IS NULL` alongside `grant_is_live(id)`. That
conjunct is **logically redundant** — `grant_is_live` already requires it of the
row itself — so the view returns exactly the rows it returned before. Asserted
both ways in `test/performance.test.ts`, including against
`live_grant_recursive`, the independent formulation that shares no code with
`grant_is_live`.

`grant_secret_idx` loses its `revoked_at IS NULL` predicate, deliberately: the
pre-authorization lookup **must** see revoked rows, and an index that excluded
them would leave that path scanning.

`grant_file_subject_type_idx` is new, for the lookups that filter by
`subject_type` on a file with many link grants.

No API change. No behavioural change. `test/performance.test.ts` fails against
the 0.5.0 schema — five of its ten tests — which is how we know the assertions
are load-bearing rather than decorative.

#### The migration

Safe to run online. Index builds take a lock that blocks writes to `file_grant`,
so on a large table use `CONCURRENTLY` (outside a transaction) as shown.

```sql
-- 1. Make the cheap conjunct visible to the planner. Changes no result.
CREATE OR REPLACE VIEW live_grant AS
SELECT * FROM file_grant WHERE revoked_at IS NULL AND grant_is_live(id);

-- 2. The pre-authorization secret lookup must reach revoked grants.
CREATE INDEX CONCURRENTLY grant_secret_all_idx
    ON file_grant (secret_hash) WHERE secret_hash IS NOT NULL;
DROP INDEX CONCURRENTLY grant_secret_idx;
ALTER INDEX grant_secret_all_idx RENAME TO grant_secret_idx;

-- 3. The subject-type lookups.
CREATE INDEX CONCURRENTLY grant_file_subject_type_idx
    ON file_grant (file_id, subject_type) WHERE revoked_at IS NULL;

-- 4. The planner needs statistics to choose any of this.
ANALYZE file_grant;
```

Step 2 is in that order on purpose: build the replacement before dropping the
original, so there is no window in which the secret lookup has no index at all.

To confirm it took effect:

```sql
EXPLAIN (ANALYZE) SELECT * FROM file_grant
 WHERE subject_type = 'link' AND secret_hash = 'not-a-real-hash' LIMIT 1;
```

An `Index Scan using grant_secret_idx` with `Rows Removed by Filter: 0` is
correct. A `Seq Scan`, or any non-zero `Rows Removed by Filter`, means step 1 or
step 4 did not run.

---

### Entry 6 — `0.6.0` → `0.7.0`: `TRUNCATE` on the audit log is refused

#### What was wrong

`audit_event` carries two rewrite rules that turn `UPDATE` and `DELETE` into
no-ops, and the schema described the table as append-only on the strength of
them. Postgres rewrite rules are per-DML-statement-type, and `TRUNCATE` is not
DML — so `TRUNCATE audit_event` emptied the whole table, every tenant chain and
the system chain with it, with both rules fully in place and no error.

This is a gap in a stated property, not a privilege escalation: it needs the
`TRUNCATE` privilege, which a least-privileged application role does not have.
It matters because nothing in our own quickstart creates a least-privileged
role — the documented deployment hands the application the same `DATABASE_URL`
that applied the schema, and that connection owns the table.

#### What changed

A statement-level `BEFORE TRUNCATE` trigger that raises. Statement-level
TRUNCATE triggers do fire, which is the whole reason this works where the rule
did not.

Also corrected, in the same release, two comments in this schema that described
things which do not exist: that deletion of history is detectable (it is not, for
truncation of the most recent events — see `AuditChainResult.lastHash`), and that
retention trimming is "a separate privileged path" (there is no such path; the
table grows without bound).

#### The migration

Additive and safe to apply at any time, with no downtime and no backfill:

```sql
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
```

#### What it does not do

It is not a privilege boundary and we do not present it as one. The trigger is
owned by the table owner and `DROP TRIGGER` is one statement. It stops an
accident, a stray script and an application bug. If your audit log needs to
survive someone who owns the database, the head hash has to live outside it:
`verifyAuditChain()` returns `lastId` and `lastHash` for exactly that.

#### Recommended alongside

Give the runtime a role that is not the owner:

```sql
REVOKE TRUNCATE, DELETE, UPDATE ON audit_event FROM <your_app_role>;
```

Nothing in the library needs any of the three.

---

### Entry 7 — `0.7.0` → `0.9.0`: no schema change, and one call site

#### What changed in the schema

Nothing. `schema.sql` has not been modified since the `0.7.0` commit, whose only
diff was the `audit_no_truncate()` trigger in Entry 6 above. **A database running
the `0.7.0` schema runs `0.9.0` unaltered**, and there is no SQL to apply.

This entry exists anyway, because §1 promises an entry per MINOR release and two
of them have shipped. An absent entry and an entry saying "nothing to do" look
identical to a reader deciding whether they are missing something, and only one
of them is an answer.

What those two releases contained is in the changelog: `0.8.0` was a review of
the storage adapter and the delivery routes plus the contention suite, and
`0.9.0` added `FsStorage` and the deployable example. Neither needed a column.

#### What you do have to change, if you match on it

`shares.create(id, { as, capabilities })` and `share({ subject: { type: 'link' },
capabilities })` now refuse anything beyond `read` **before any query**, with
`FilelayerError(400, 'link_is_read_only')`.

Until `0.9.0` the only thing standing in the way was the `grant_link_read_only`
CHECK constraint, so the refusal surfaced as a raw Postgres error: SQLSTATE
`23514`, the constraint name, and a `detail` field carrying the failing row —
which for `file_grant` includes `secret_hash`.

```ts
// Before 0.9.0
catch (e) { if (e.code === '23514') … }           // or matched on the constraint name

// 0.9.0 and later
catch (e) { if (e.code === 'link_is_read_only') … }
```

The constraint is unchanged and still refuses the row, so a writer going around
the library — a `psql` session, a migration script — is held to the same rule.
Two independent writers refused, not one check moved.

---

### Entry 8 — `0.9.0` → `0.10.0`: two columns, an index and a constraint

#### What changed in the schema

Pre-authorized direct upload needs to remember two things about a reservation
between the moment it is issued and the moment the bytes arrive. Both columns
are nullable and both are NULL for every file created by the ordinary
`upload()`, so **existing rows need no backfill**.

```sql
ALTER TABLE file
    ADD COLUMN upload_expires_at     timestamptz,
    ADD COLUMN upload_expected_bytes bigint
        CHECK (upload_expected_bytes IS NULL OR upload_expected_bytes >= 0);

ALTER TABLE file
    ADD CONSTRAINT file_upload_reservation_complete
        CHECK ((upload_expires_at IS NULL) = (upload_expected_bytes IS NULL));

CREATE INDEX file_upload_deadline_idx ON file (upload_expires_at)
    WHERE state = 'pending' AND upload_expires_at IS NOT NULL;
```

On a large `file` table, `CREATE INDEX CONCURRENTLY` instead — it cannot run
inside a transaction, so it goes in its own migration step:

```sql
CREATE INDEX CONCURRENTLY file_upload_deadline_idx ON file (upload_expires_at)
    WHERE state = 'pending' AND upload_expires_at IS NOT NULL;
```

Both `ADD COLUMN`s are metadata-only on PostgreSQL 11 and later (a nullable
column with no default rewrites nothing). The two `CHECK`s are validated against
existing rows, which for `file_upload_reservation_complete` is a full scan —
every existing row satisfies it trivially, since both sides are NULL, but the
scan still takes an `ACCESS EXCLUSIVE` lock. On a table large enough for that to
matter, add it `NOT VALID` and validate separately:

```sql
ALTER TABLE file ADD CONSTRAINT file_upload_reservation_complete
    CHECK ((upload_expires_at IS NULL) = (upload_expected_bytes IS NULL)) NOT VALID;
ALTER TABLE file VALIDATE CONSTRAINT file_upload_reservation_complete;
```

**A database running the `0.9.0` schema does NOT run `0.10.0` unaltered** if you
call `createUpload()`: the INSERT names both columns. Every other code path is
unaffected, so a deployment that never turns direct upload on can apply this
whenever it likes.

#### Why `expires_at` was not reused

`expires_at` means "the file stops being readable". `upload_expires_at` means
"the upload credential stops working". Conflating them would make a file unable
to outlive the window it was uploaded in, which is not a lifecycle anybody
wants.

#### Why the claimed size is a column and not `size_bytes`

While a reservation is pending, `size_bytes` is NULL and
`upload_expected_bytes` holds the size that was signed into the credential. The
cheaper design — put the claim in `size_bytes` and overwrite it on completion —
would make one column mean "measured by the adapter" on one path and "asserted
by a browser" on another. That is the shape of the `max_downloads` defect
described in `schema.sql`, and once was enough.

#### One behaviour change outside the schema

`recordUsage()` now writes upload bytes to `usage_daily.bytes_stored` instead of
`usage_daily.bytes_egressed`. If you query those columns, the numbers change
meaning: `bytes_egressed` becomes bytes actually delivered, and `bytes_stored`
stops being zero for every org on every day. Historical rows are not rewritten,
so a series that spans the upgrade has uploads counted as egress before it and
as storage after.

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
  rules that make `UPDATE` and `DELETE` no-ops, a trigger that refuses
  `TRUNCATE`, and the chain is verified by recomputation. A migration that needed
  to rewrite history would invalidate every subsequent hash, and we would rather
  that be impossible than documented. Note the limit of "verified by
  recomputation": replay detects edits and interior deletions, not truncation of
  the most recent events. See Entry 6.
- **Audit log retention.** There is none. `audit_event` grows without bound, and
  erasing a tenant's history is not a supported operation — the `ON DELETE
  CASCADE` from `org` is itself a `DELETE` that the rule rewrites away, so
  deleting an org row fails its own referential-integrity check.
