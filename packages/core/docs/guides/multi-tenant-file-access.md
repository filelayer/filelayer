# How do I do multi-tenant file access control?

The usual answer is a good one: put `tenant_id` on every table, turn on
Row-Level Security, set a session variable per request, and index on
`(tenant_id, …)`. The better tutorials also tell you to use `FORCE ROW LEVEL
SECURITY`, to keep `BYPASSRLS` off your application role, and to never take the
tenant from the client. All of that is right and this guide does not argue with
any of it.

It argues with what people conclude from it. **RLS decides which rows a session
may see. It does not decide which rows may exist.** For files that gap has a
name, because files have two things ordinary rows do not: a grant that points at
another tenant's row, and bytes that live somewhere with no policies at all.

Everything below was measured against a real PostgreSQL. The script is
[beside this file](multi-tenant-file-access.proof.mjs) and takes about twenty
seconds.

---

## RLS does exactly what it says, which is less than you need

Start with the schema a good tutorial produces: `file` and `file_grant`, both
carrying `org_id`, both with RLS enabled and forced, both with a policy
comparing `org_id` to `current_setting('app.tenant_id')`.

Reads are isolated, and this part works:

```
acme sees: ["acme-contract.pdf"]
```

`globex-deck.pdf` is invisible. Now, from a session whose tenant is **globex**,
insert a grant that gives globex access to **acme's** file:

```sql
INSERT INTO file_grant (file_id, org_id, note)
VALUES ('<acme's file>', '<globex>', 'globex may read an acme file');
```

Measured result: `INSERTED`.

Both policies are satisfied, and correctly. The row's `org_id` **is** globex,
which is the session's tenant, so `WITH CHECK` passes. RLS compared the row to
the session. **Nothing compared the row to the file it points at.** You now have
a grant that spans two tenants, written by a session that was never allowed to
see the file it just granted.

This is not an RLS bug. It is RLS being a row filter, which is what it is. The
tutorials are not wrong; the conclusion that RLS makes cross-tenant access
impossible is.

---

## The composite foreign key

Standard SQL, no extension, no trigger. Make the pair unique on the parent, then
reference the pair from the child:

```sql
ALTER TABLE file       ADD UNIQUE (id, org_id);

ALTER TABLE file_grant ADD FOREIGN KEY (file_id, org_id)
                           REFERENCES file (id, org_id);
```

`file.id` is already the primary key, so `UNIQUE (id, org_id)` adds no
meaningful constraint on `file` — it exists only so the pair can be referenced.
The child now says: *the file I point at must belong to the org I claim.*

The same `INSERT`, measured:

```
result: REFUSED:23503
```

A foreign-key violation. The pair `(acme's file, globex)` is not a row in
`file`, so the grant is not a row that can exist. It is no longer a rule about
who is asking; it is a statement about which rows are possible.

### And it holds where a policy does not

A policy constrains a session. If anything reaches the table through another
session — a migration, an admin script, a background job, a connection pooler
that reset your session variable, a role someone granted `BYPASSRLS` to in a
hurry — the policy is simply not in force.

Measured, from a role with `BYPASSRLS` and no tenant variable set at all:

```
this role sees all 2 files, and the write: REFUSED:23503
```

It reads every row in the database, and it still cannot write that grant. That
is the whole argument for pushing this into the schema: **a policy is advice to
a session, a constraint is a property of the data.** The one you want protecting
tenant isolation is the second kind, because the first kind has an off switch
and the off switch is used by people in a hurry.

Apply the same shape to every table that joins two tenant-scoped things:
membership, audit rows, anything with two foreign keys that both ultimately
belong to a tenant. If a row can be written that spans two tenants, eventually
one will be.

---

## The bytes are not in the database

The second thing files have that ordinary rows do not.

RLS protects `SELECT … FROM file`. It has nothing to say about the object in S3.
If your download path looks up a key under RLS and then fetches it, the lookup
was protected and the fetch was not — which is fine as long as the key only ever
comes from that lookup. It stops being fine the moment:

- **the bucket is public.** Then the object is readable by anyone who knows or
  guesses the key, and no policy in your database is in the path at all. The key
  is not a secret: it appears in logs, in `Referer` headers, in backups, in
  anything that has ever listed the bucket.
- **you issue presigned URLs.** The store validates a signature, not a session.
  Whatever tenant checking you did happened before the URL existed, and the URL
  outlives the check. See
  [expiring and revocable file links](expiring-and-revocable-file-links.md) for
  what that costs and what to do instead.
- **a key is constructible.** If keys are `tenant/<org>/<file>` and a caller can
  influence either segment, path traversal across tenants is an input-validation
  bug away. Hash the key, or generate it, but never build it from something a
  user supplied.

The rule that keeps this simple: **one place decides, and the bytes are only
reachable through it.** Private bucket, no presigned URLs you cannot revoke, and
every read passing the same function. If there are two paths to the bytes, the
second one is the one that will be wrong.

---

## Three smaller things, in the order they bite

**Sharing is cross-tenant on purpose, and RLS has no vocabulary for it.** The
point of a share link is that somebody outside the tenant reads one file. A
policy keyed on `org_id = current_setting(...)` cannot express "and also this
one anonymous grant". The usual escape is a privileged role for redemption,
which is a hole with a job title. Model the grant as a row, authorize against
the grant, and keep the privileged path out of the design.

**Admins are tenants too.** "Org owners can read every file in their org" is a
policy decision, not an accident, and it should be written down somewhere a user
can read. If your product promises that nobody but the uploader sees a file, RLS
will not give you that — you need encryption the operator cannot undo, which is
a different and much larger project.

**The index is part of the correctness story.** A policy that forces a sequential
scan is a policy somebody will turn off under load. `(org_id, …)` as the leading
columns on the access paths, every time.

---

## If you would rather not build it

[Filelayer](https://github.com/filelayer/filelayer) is this shape, packaged:
files with orgs and roles, grants as rows, and the cross-tenant constraint above
in the schema rather than in the application. Its `file_grant` table carries
exactly the composite key this guide recommends:

```sql
FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id) ON DELETE CASCADE
```

Worth being precise about what that is and is not: **Filelayer is authorization
middleware, not row-level security.** It decides for calls made through it. A
client that queries your Postgres directly bypasses it — the composite keys and
triggers still hold, because those bind every writer, but no authorization runs
and no audit event is written. The two compose; neither replaces the other. If
you want RLS as well, add it; nothing here conflicts.

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
import assert from 'node:assert/strict';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

```ts
await fl.orgs.create('acme', { owner: 'ceo' });
await fl.orgs.create('globex', { owner: 'other-ceo' });
const { id } = await fl.files.put(new TextEncoder().encode('CONTRACT'), {
  org: 'acme', owner: 'ceo', name: 'contract.pdf',
});

// A member of the other tenant gets a 404, not a 403: a 403 would confirm
// the file exists, which is itself a cross-tenant disclosure.
await assert.rejects(
  () => fl.files.get(id, { as: 'other-ceo' }),
  (e: { status?: number }) => e.status === 404,
);
```

That block is executed by `npm run check:docs` on every commit.

It is Apache-2.0, it runs on your own Postgres and your own bucket, and it is
alpha — [the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
has the numbers, including the ones sitting at zero.

---

## Related

- [Expiring and revocable file links](expiring-and-revocable-file-links.md) —
  why a presigned URL cannot be taken back.
- [Private file uploads](private-file-uploads.md) — why a presigned PUT does not
  limit what gets uploaded.

---

## Sources

- [Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — PostgreSQL, on what a policy does and on `BYPASSRLS`
- [Postgres Row-Level Security: multi-tenant patterns that hold up](https://queryplane.com/blog/postgres-row-level-security-in-practice/) — QueryPlane
- [Implementing managed PostgreSQL for multi-tenant SaaS applications](https://docs.aws.amazon.com/prescriptive-guidance/latest/saas-multitenant-managed-postgresql/welcome.html) — AWS Prescriptive Guidance
- [How to architect multi-tenant SaaS on Postgres](https://clickhouse.com/resources/engineering/multi-tenant-saas-postgres-architecture) — ClickHouse
