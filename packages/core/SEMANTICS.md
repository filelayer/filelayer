# Filelayer semantics

What deletion, expiry, revocation and metering mean — precisely enough to
predict behaviour without reading the code.

Every rule here is enforced in `schema.sql` or `src/authz.ts` and asserted in
`test/semantics.test.ts`. Where a rule was a judgement call, the call and the
reasoning are stated. Nothing here is aspirational.

---

## 1. The object model

```
project  →  org  →  file  →  grant
   ↑          ↑                ↑
   └── actor ─┘         (subject / issuer)
```

- **project** — one customer application. Authenticated by an API key at the
  ingest boundary. The scope in which `external_id` is unique.
- **org** — one tenant inside a customer's application.
- **actor** — one identity inside a customer's application. May hold grants in
  orgs it is not a member of.
- **file** — bytes plus lifecycle.
- **grant** — an explicit, revocable, listable, auditable row conferring
  capabilities on one file. Grants may be delegated; a delegated grant records
  its parent.

There is **no ambient authority and no public flag.** Access exists only as a
`membership` row or a `grant` row. Absence of a row is denial.

### 1a. A grant's subject is a principal set

```
grant_subject := actor | org | role | link | anonymous
```

| subject | the set it denotes | columns |
|---|---|---|
| `actor` | exactly one principal | `subject_id` |
| `role` | every member of an org at role **≥** the floor | `subject_org_id`, `subject_min_role` |
| `org` | every member of an org, at any role | `subject_org_id` |
| `link` | whoever holds the secret (bearer, not identity) | `secret_hash` |
| `anonymous` | everyone | — |

Breadth ordering, which invariant **I6** below attenuates over:

```
actor  ⊂  role  ⊆  org  ⊂  anonymous          link — orthogonal (bearer)
```

`org` is `role` with the floor at `viewer`. Both exist because the common case
should not require naming a role.

**Resolution is a JOIN, never a materialization.** A group grant matches a
principal iff that principal has a live `membership` row in `subject_org_id` at
a sufficient role, evaluated on the request. There is no fan-out table and no
per-member row, so:

> **Adding or removing a member changes access on the very next request, with
> no recomputation and no write to any grant.**

That is the same property that makes revocation immediate, and it is the reason
fan-out was rejected: fan-out makes membership *eventually consistent* with
access. `test/group-subjects.test.ts` asserts it by fingerprinting every column
of every `file_grant` row before and after a join, a leave and a role change.

**What group subjects deliberately are not.** No custom groups — a group is an
org. No nested orgs. No configurable inheritance. No arbitrary permission sets.
No deny rules. `subject_min_role` is *only* a threshold over the existing
four-value `org_role` enum, and the roles remain exactly
`viewer | member | admin | owner`.

**Cross-org, not cross-project.** `subject_org_id` may name an org other than
the file's own — "the company that posted this job may read this CV" — but it
must be an org in the **same project**, enforced by composite foreign key
against `org(id, project_id)` where `project_id` is derived from the file. A
cross-project group grant is unrepresentable (P8), exactly as a cross-tenant
grant is (P3).

**`visibility = 'org'` is retained**, and is now describable as an *implicit org
grant*: a read grant whose subject org is the file's own. It stays as sugar for
that one case because it needs no vocabulary at all, and because keeping it a
column on `file` is what lets the role matrix remain a total function over
4 roles × 2 ownerships × 2 visibilities — the enumeration the listing predicate
is derived from. It is not a boolean that opens a file to a population beyond
its own tenant, so P1 is unchanged.

---

## 2. Access is the conjunction of three things

A request is allowed only if **all** hold:

1. **Standing** — the principal holds the capability, via an org role or a live
   grant. (`fileCapabilities()` / `resolveStanding()`)
2. **Grant liveness**, if standing came from a grant — see §3.
3. **File lifecycle** — the file is not deleted, not expired, not `pending` for
   a read, and not under a retention hold for a delete. (`lifecycleDenial()`)

Evaluation order is 1 → 2 → 3, and that order is a security property: steps 1
and 2 are indistinguishable to the caller (everything is `404`), so the
statuses that are *not* 404 (`410 Gone`, `409 retention_hold`) are only ever
reachable by someone who already proved they may perform the operation.

---

## 3. Grant liveness

A grant is **live** iff **it and every one of its ancestors** satisfies all of:

| dimension | dead when |
|---|---|
| revocation | `revoked_at` is set |
| expiry | `expires_at ≤ now()` |
| budget | `download_count ≥ max_downloads` |
| **scope** | its file, org, project, **subject**, **subject org** or **issuer** is deleted |

Evaluated by one predicate, `grant_is_live()`, which every grant lookup reads
through (`live_grant`). There is no query that can opt out of it, including a
`psql` session or a future endpoint.

Liveness is **derived, never cascaded**. Revoking a grant or deleting a scope
writes nothing to the grants below it; they simply stop being live. This is why
revocation is transitive at any depth with no second write to get wrong, and
why undelete is exact.

---

## 4. Deletion — the table

Everything below is **soft delete**: `deleted_at` is set, no data is erased.

| you delete | grants **to** that thing | grants **issued by** it | role-derived access | reversible |
|---|---|---|---|---|
| **project** | all, in every org | all | all | yes |
| **org** | all in the org, **plus every group grant naming it** | all in the org | all | yes |
| **file** | all on the file | — | n/a (file gate denies) | yes |
| **actor** | all where they are subject | **all they issued** | theirs | yes |
| **membership** (removal) | *unaffected* | *unaffected* | theirs — **including every group grant that reached them through it** | re-add |

### Why "everything dies"

A tenant whose deletion leaves its share links serving bytes has not been
deleted. "We offboarded that customer" has exactly one honest meaning. The
previous behaviour — memberships died, grants did not — was nobody's decision;
it was an asymmetry between two store methods.

### Why a deleted **issuer** takes their links with them

This is the judgement call, and the call is **P4**: *a signed URL may never
outlive the permission that created it.* A root grant is minted from the
issuer's role-derived authority. Delete the identity and that authority is gone,
so the grant goes with it. The alternative is "the intern left two years ago and
their link still works", which is the failure this product exists to remove.

Expect this to be **loud**: deleting a prolific sharer revokes many links at
once. That is the rule working.

### Why a deleted **subject org** takes its members' access with it

The mirror of the rule above, and the same reading. A group grant's subject is
"the members of org O". Delete O and that set is not empty, it is **gone** —
there is no longer a tenant whose members the grant could mean. The rule already
says a deleted org kills the grants **on** its files; it now also kills the
grants **held by** its members. Without that, soft-deleting a partner
organization would leave its former members reading the other tenant's
documents, which is the org-deletion defect P7 exists to close, re-opened on a
new axis.

Nothing is written, so `restoreOrg` revives exactly what the deletion suspended
and nothing else — a group grant independently revoked beforehand stays revoked.

### Why removing a **membership** does *not* do the same

Deliberate asymmetry. Membership removal is a role change inside a living tenant
— someone changed teams, duties were transferred. Mass-revoking a colleague's
customer-facing links as a side effect of a role edit would be an expensive
surprise. Identity **deletion** is the different, stronger statement: *this
person is gone.*

- To end one person's access: remove the membership (and `revoke` anything
  specific — `listGrants` shows you what).
- To offboard them completely: `softDeleteActor`.

**Group grants sharpen this, and the asymmetry is unchanged.** Removing a
membership immediately ends every access that reached the person *through* that
membership — that is what a group subject means, and it takes effect on the next
request with no grant row touched. It still does **not** revoke grants issued
**to them by name**, nor grants **they issued**. So "remove them from the org"
now does considerably more than it used to, and it still is not the same
statement as "this person is gone".

### Deletion vs. retention and legal hold

Soft delete **suspends access and preserves evidence.**

- It writes no row that a retention hold protects. `retain_until` still blocks
  deletion of a file, including for org owners.
- The deleted tenant's audit chain remains intact and independently verifiable.
- The deletion itself is audited (`org.delete`, `actor.delete`,
  `project.delete`).

Therefore soft delete **cannot** be used to destroy records under legal hold.
Erasure is a separate privileged operation gated on retention, and it is not
this one.

### Restore

`restoreOrg` / `restoreActor` / `restoreProject` revive **exactly** what the
corresponding delete suspended, and nothing else. A grant that was independently
revoked before the delete stays revoked. The same secret keeps working; nothing
is re-issued.

### Hard deletes

Not part of the model. `ON DELETE CASCADE` on `org` reaches `audit_event`, so a
hard org delete destroys that tenant's chain. Use soft delete.

---

## 5. Expiry is not deletion

`file.expires_at` and `grant.expires_at` are **time gates**, evaluated on every
access and extendable. `deleted_at` is **existence**, and it is what grant scope
liveness reads. Two different questions, two different mechanisms — which is why
an expired file does not make its grants non-live (the lifecycle gate denies the
access instead), and why extending an expiry restores access without touching a
grant.

---

## 6. `maxDownloads` counts byte deliveries

**A cap of *n* means the bytes leave at most *n* times, on any path, by any
principal, at any delegation depth.**

| operation | charges the cap? |
|---|---|
| `redeem()` (share link) | **yes** |
| `read()` authorized **via a grant** | **yes** |
| `read()` authorized via an **org role** or ownership | no |
| `stat()` / `listFiles()` | no |
| `authorize()` alone | no |

The cap binds the **credential**, not the file: an administrator doing their job
must not silently spend a contractor's budget. If a principal could have read
the file by role, the grant is not charged (standing resolution reaches the role
first).

A delivery charges **the entire ancestor chain**, so a parent's cap is a real
budget over its whole delegation tree — mint three children from a parent with 5
left and you have sold 5, not 15.

The reservation happens **before** the bytes are fetched, atomically
(`consume_download`). Two concurrent deliveries against a cap of 1 yield exactly
one delivery. A storage failure after a successful reservation still spends the
download; that is the fail-closed direction and it is deliberate.

`download_count` is incremented on every grant-authorized delivery whether or
not a cap is set, because it is also the answer to "how many times has this link
been downloaded", which `listGrants` reports. Cost of that choice: a
high-traffic public file makes its single anonymous grant row a write hotspot
(recorded in `Filelayer.deliver()`).

Previously the cap was charged only by `redeem()`, which made it a lie on
the path the SDK actually uses. Rejected alternatives: renaming it
`maxRedemptions` (moves the ambiguity, since it would still be settable on an
actor grant), and refusing the field on non-link grants (removes a capability
instead of defining one).

---

## 7. Attenuation — a delegated grant can never exceed its parent

Attenuation has **two dimensions**: what a delegate may *do*, and *who they may
reach*. Both are enforced by the same `BEFORE INSERT OR UPDATE` trigger, so both
bind every writer and not just the application.

### 7a. Authority — what a delegate may do

- **capabilities** — must be a subset. Excess is **rejected**, not narrowed:
  silently reducing an authority someone asked for hides a bug.
- **expiry** and **budget** — **clamped** to the parent's, and the effective
  values are returned so the clamp is visible.
- **lineage is immutable** — `parent_grant_id` cannot be changed.
- **depth is bounded** (32), so liveness evaluation is bounded.
- You cannot delegate from a grant that is not live — including one whose file,
  org, project, subject or issuer has been deleted.

Link and anonymous grants are **read-only by CHECK constraint**, so authority
cannot be passed on by a bearer credential: only a named, revocable, attributable
actor can delegate.

### 7b. Breadth (I6) — who a delegate may reach

> **Delegation may attenuate authority, but it may never amplify subject
> breadth.**

| the issuer's authority came from | subject types they may mint |
|---|---|
| an **org role** (admin/owner of the file's org, or the file's owner) | **all five** |
| a **grant** (`parent_grant_id` is set) | **`actor` and `link` only** |

So, exhaustively:

| delegation | outcome |
|---|---|
| `org` grant → `actor` | allowed |
| `org` grant → `link` | allowed, if capability attenuation also holds |
| `org` grant → `org` | **denied** |
| `actor` grant → `org` / `role` | **denied** |
| `link` grant → `org` | **denied** |
| any grant-derived → `anonymous` | **denied** |

**Why.** Capability attenuation stops a delegate *doing more*; it says nothing
about *reaching more people*. Without I6, a contractor holding one `{read,
share}` grant — the narrowest useful authority we issue — could re-grant to an
entire organization, or publish the file anonymously, and every capability check
would still pass because the child's set is a subset of the parent's. One
consultant's read access becomes a public link with attenuation satisfied the
whole way. Both dimensions must be attenuated or neither is.

**Where it is enforced.** In `authorizeShare()`, which refuses with reason
`subject_breadth_amplification`, a `403`, and an audit event naming the
requested subject type; **and** in the `file_grant_attenuate()` trigger, which
raises `grant_subject_amplification` — so the invariant holds for a caller
issuing raw SQL, a migration, or an admin tool. The trigger fires on the subject
columns as well as on INSERT, so a delegated grant cannot be widened by a later
`UPDATE` either. Every case in the table above is asserted through both paths in
`test/group-subjects.test.ts`.

---

## 8. The tenant and project boundaries

- A grant's `org_id` must equal its file's `org_id` — composite foreign key.
  Cross-tenant grants are **unrepresentable**, not merely prevented.
- A delegated grant must concern the same file as its parent — composite foreign
  key.
- A group grant's `subject_org_id` must be in the same **project** as the file —
  composite foreign key against `org(id, project_id)`, where `project_id` is
  derived from the file's org by trigger and can never be supplied by a writer.
  Cross-**org** group grants inside a project are legal and are the point;
  cross-**project** ones are **unrepresentable**.
- Every table naming an actor carries `project_id` under a composite foreign key
  to `actor(id, project_id)`. Cross-project memberships, file ownership, grant
  subjects and grant issuers are **unrepresentable**.
- `external_id` is unique **per project**. Two customers may both call their
  tenant `acme` and their user `alice`; those are four different rows.
- A `Filelayer` bound to a project cannot read, list, audit or address anything
  outside it. Probes at another project's ids are `404` and are recorded on the
  **system chain**.

Before this, `external_id` was globally unique, and the get-or-create in
the tiered API resolved one customer's `acme` to another customer's org row —
then added the caller's user to it. A common tenant name was a complete
cross-customer compromise from the most ergonomic entry point we ship.

---

## 9. The audit log

- **Every decision is recorded, including denials.** Denials are the
  security-relevant events.
- **Every allow names the path it came from**, in `context.via`:
  `owner | role | grant:actor | grant:org | grant:role | grant:link |
  grant:anonymous`. For the two group paths the event also carries
  `viaOrgId` (which org's membership conferred it), `viaMinRole` (the floor the
  grant asked for) and `viaRole` (the role the caller actually held), so
  "why did this succeed?" is answerable from one row without a join.
- **One event per decision.** `listFiles` emits **one** event carrying the
  capability, the caller's role, the result count and the returned ids — not one
  per file.
- **Decisions with no tenant to charge them to go to the SYSTEM chain**
  (`org_id IS NULL`): probes at unknown file ids, sweeps against link secrets,
  probes at orgs outside the caller's project, and project-level control-plane
  actions. No tenant-facing API can read it. Attributing such events to a
  guessed org would itself be an existence oracle; dropping them made
  enumeration invisible.
- **Attempts against a suspended tenant's own files still land on that tenant's
  chain.** The file exists and belongs to them; "who tried after we suspended
  this org" must be answerable from their record.
- **Hash-chained per chain**, committing to every forensically relevant column.
  Appended by `audit_append()`, which takes `pg_advisory_xact_lock` on the
  chain, reads the predecessor and inserts — all in one statement, therefore one
  transaction, therefore fork-proof under concurrent writers.
- The digest is computed in SQL on write and recomputed in TypeScript on read,
  so the two implementations check each other on every verification.
- `UPDATE` and `DELETE` on `audit_event` are no-ops.
- Attribution survives deletion: `actor_id` carries no foreign key, so deleting
  a user does not rewrite what they did.

**What PGlite cannot prove:** it has one backend. No test in this repository can
demonstrate lock contention, a waiting writer, or a fork actually prevented.
The tests prove the lock is taken before the predecessor is read, that the key
is per-chain, that the SQL and TypeScript digests agree, and that the fork the
old code would have produced is detectable. Proving serialization requires a
real multi-connection Postgres and belongs in the deployment suite.

---

## 10. The ingest boundary — operational requirements

An unauthenticated caller who guesses an org UUID can cause denials to be
appended to that tenant's chain. Under the per-chain lock this is a **latency
attack on that tenant's request path**, not merely log noise, because every one
of that tenant's own requests takes the same lock on its audit write.

This is **not fixable inside the engine**: P5 requires that every decision be
recorded, so any in-engine mitigation is a rule for dropping audit events; and
the engine cannot distinguish a flood from reconnaissance, because they are the
same request and only the rate differs.

**Fixed in core:** the blast radius. `orgExists` is project-scoped, so a caller
can only reach a tenant chain inside a project they are already authenticated
for. Everything else goes to the system chain.

**Required of the API layer** — these are requirements, not suggestions:

- **R1.** Every request carries a project credential. No project, no engine.
- **R2.** Rate limit per (project, source address) **before** the engine runs.
- **R3.** Cap per-project audit append rate; shed with `429`. Never by dropping
  a decision that was actually made.
- **R4.** Alert on system-chain append rate. That chain is where unattributable
  probes go, so its rate is the enumeration signal.

Related boundary: `PostgresStore` is the engine's dependency surface and **every
method on it is unauthorized by construction**. `@filelayer/sdk` must not
re-export `PostgresStore`, `Filelayer.store`, or `store.db`.

---

## 10a. Storage, transactions, and delivery modes

### The object's identity is (provider, key)

`file.storage_provider` was written as the literal `'memory'` on every insert,
regardless of which adapter was configured. Against
`CREATE UNIQUE INDEX file_storage_key_idx ON file (storage_provider, storage_key)`
that means a production database recorded every object as living in an
in-process Map, and the one column that says *where the bytes are* was wrong for
every row.

It now comes from `StorageAdapter.provider`. An adapter with no provider name is
refused at construction. Conventional values: `memory`, `s3`, `r2`. The
`S3Storage` adapter defaults to `r2` for an R2 endpoint and `s3` otherwise, and
takes an explicit override.

**This is part of an object's identity, not a label.** Changing it for an
existing deployment makes every existing row point at a store the bytes are not
in. Pin it explicitly (`provider: 'r2'`) for anything long-lived.

`size_bytes` is likewise what the adapter reports it **wrote**, not what the
caller claimed. A caller-supplied `size` that disagrees with the object is how a
`content-length` ends up truncating a download.

### What is in a transaction, and why

`Queryable` now carries a transaction abstraction (`withTransaction(db, fn)`)
that works for `pg.Pool` (checkout + `BEGIN`/`COMMIT`/`ROLLBACK` + `release`), a
single `pg.Client`, PGlite, and anything that supplies its own
`withTransaction`. Nesting becomes a `SAVEPOINT`.

**The rule: an audit event is written in the same transaction as the decision or
mutation it records.**

| operation | one transaction covers |
|---|---|
| `upload` | INSERT `file` · `file.create` event · usage · file-owner metering |
| `readStream` / `read` | the `authorize()` decision + its event · `consume_download` · the `file.deliver` event when redirected |
| `redeemStream` / `redeem` | secret resolution · unresolved-secret event · decision + event · `consume_download` |
| `share` | decision + event · INSERT `file_grant` (inside a SAVEPOINT) · `grant.create` event |
| `revoke` | decision + event · `UPDATE file_grant` · `grant.revoke` event |
| `delete` | decision + event · `UPDATE file` |
| `stat` | decision + event |

Two consequences worth stating explicitly.

**Denials commit.** A refusal writes an audit event and then throws. A naive
"throw ⇒ rollback" would silently destroy exactly the events P5 exists to keep
while the caller still saw their 403. So a `FilelayerError` — and only a
`FilelayerError` — is treated as a *decided* outcome: commit, then throw.
Everything else rolls back.

**The advisory lock now means something.** `audit_append()` takes
`pg_advisory_xact_lock`, which is held to the end of the *transaction*. Under
autocommit that was the end of one statement, so the lock serialized the append
but could not serialize it against the mutation it described. It now spans both.
The consequence is a lock-ordering rule that every method follows:

> **The audit chain lock is always taken before any row lock.**

`authorize()` audits before `consume_download()` touches the grant row;
`authorizeRevoke()` audits before the `UPDATE`. The revoke lookup deliberately
does **not** take `FOR UPDATE`, which would invert the order.

### The storage write is not transactional. The ordering is the answer.

Object storage cannot join a Postgres transaction. There are two orderings:

- **commit metadata, then write bytes** — a crash between them leaves a `ready`
  `file` row whose object does not exist. Every read 404s forever, the file is
  listable, and the customer sees data loss.
- **write bytes, then commit metadata** — a crash between them leaves an object
  no row points at. It is unreachable (every read path starts from a `file` row,
  and keys are fresh UUIDs that are never reissued), so it costs storage and
  nothing else.

**We take the second.** Deletion takes the mirror ordering: commit the metadata
delete first, remove the bytes after. Both failure modes produce an *orphan*
rather than data loss.

### Orphan collection is a REQUIRED operational job

`Filelayer.collectStorageOrphans({ olderThanSeconds, limit, dryRun })`. It is
not automatic and nothing calls it for you. Run it on a schedule (hourly is
ample).

- `dryRun` defaults to **true**.
- `olderThanSeconds` defaults to 3600 and is floored at 60. **The grace period
  is load-bearing**: an object written seconds ago may belong to an upload whose
  transaction has not committed, and deleting it would turn a successful upload
  into permanent data loss.
- An object is collected only when **nothing** references `(provider, key)`.
  Soft-deleted files still have rows, so a file under a retention hold whose
  bytes were never removed is never collected.
- Needs a `list()`-capable adapter. `MemoryStorage` and `S3Storage` have one.
- Sweeps are audited to the system chain as `storage.gc`.

### Delivery modes

Two, with different security properties.

**`proxy` — the default, and the only mode available unless you opt in.**
Bytes flow through the process. Every request is authorized. Responses carry
`Cache-Control: private, no-store, …`. **Revocation is immediate, unqualified.**
Delivery is now *streamed*: `readStream()` / `redeemStream()` return a
`ReadableStream`, and the library's own HTTP routes use them, so a large file is
never resident. `read()` / `redeem()` remain the buffered convenience form for
small files and are unchanged.

**`redirect` — opt-in, bounded, audited.** Authorize → audit → `302` to a
short-lived presigned URL. No egress through the process, no heap, and for a
public asset a CDN-cacheable response.

> **The guarantee, stated the way a compliance auditor needs it:
> revocation is immediate at decision time, plus up to `ttlSeconds` of in-flight
> window.**

If a grant is revoked at *T*, no new redirect is issued from *T* onward — that
half is as immediate as the proxied path. A redirect issued at *T−1* hands out a
URL the object store honours until *T−1+ttlSeconds*, and the object store has
never heard of a grant. AWS's own documented answer to recalling one is "rotate
the signing credential", which kills every URL for every tenant at once and is
not a per-grant control. The window is real; it is bounded; the bound is ours.

Enforced, not documented:

- The config does not typecheck without the verbatim `REDIRECT_ACKNOWLEDGEMENT`
  string, and is rejected at runtime too.
- `ttlSeconds` is clamped to `MAX_REDIRECT_TTL_SECONDS` (300). Clamped, not
  rejected — rejecting invites someone to "fix" it by removing the bound.
- Default scope is `anonymous-grants-only`: only a delivery authorized by an
  **anonymous grant** — something the customer deliberately published — may be
  redirected. `via` is the engine's own account of where authority came from, so
  "public" means "published", not "the request looked public".
  `scope: 'all-grants'` widens it and is never the default.
- Only an anonymous redirect is **cacheable** (`public, max-age=ttl/2` — half,
  so a cached redirect always has at least half its life left). A widened-scope
  redirect gets `private, no-store`. **Nothing that was not already public
  becomes cacheable by a shared cache.**
- The presigned URL pins `response-content-type` and
  `response-content-disposition`, so the object store serves the same
  neutralised type and `attachment` disposition the proxied path would have. A
  redirect does not lose the response-header protections.
- Every redirected delivery writes a **`file.deliver`** audit event with
  `mode: 'redirect'`, `ttlSeconds`, `revocationWindowSeconds`, `via` and
  `cacheable`. A compliance auditor answering *"which deliveries left our control?"*
  filters on that action; everything else was proxied.

```ts
import { REDIRECT_ACKNOWLEDGEMENT } from '@filelayer/core';

new Filelayer(pool, new S3Storage({ … }), {
  baseUrl,
  redirectDelivery: {
    acknowledgeRevocationWindow: REDIRECT_ACKNOWLEDGEMENT,
    ttlSeconds: 60,          // clamped to 300
    // scope: 'all-grants',  // opt in again to redirect private grants
  },
});
```

Per-route override: `deliveryHandler(fl, { mode: 'proxy' })` forces proxying on
an instance that has opted in. There is no `mode: 'redirect'` — a route cannot
demand a mode the instance was not configured for.

### Testing the storage adapter

`test/storage.test.ts` runs `S3Storage` against `test/local-s3.mjs`, a local
S3-protocol server that **recomputes every SigV4 signature** from the request as
received and rejects a mismatch. It proves the wire format: canonical URI
encoding, canonical query strings, header canonicalisation, payload hashes,
multipart sequencing and part-size rules, ranges, HEAD, DELETE, list pagination
and presigning.

`test/s3-live.test.ts` runs the same operations against a **real bucket**. It is
skipped unless credentials are present and runs automatically when they are:

| variable | required | notes |
|---|---|---|
| `FILELAYER_TEST_S3_ENDPOINT` | yes | `https://<account>.r2.cloudflarestorage.com` or `https://s3.<region>.amazonaws.com` |
| `FILELAYER_TEST_S3_BUCKET` | yes | **use a dedicated test bucket** |
| `FILELAYER_TEST_S3_REGION` | yes | `auto` for R2 |
| `FILELAYER_TEST_S3_ACCESS_KEY_ID` | yes | |
| `FILELAYER_TEST_S3_SECRET_ACCESS_KEY` | yes | |
| `FILELAYER_TEST_S3_SESSION_TOKEN` | no | STS / temporary credentials |
| `FILELAYER_TEST_S3_PATH_STYLE` | no | `false` for virtual-hosted addressing |
| `FILELAYER_TEST_S3_PREFIX` | no | default `filelayer-ci/`; everything written is deleted after |
| `FILELAYER_TEST_S3_MULTIPART` | no | `1` to run the ~11 MB multipart test; enable in the nightly job |

Bucket permissions: `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`,
`s3:ListBucket`, `s3:AbortMultipartUpload` (+
`s3:ListBucketMultipartUploads` if multipart is enabled).

**Until that suite has run green against a real bucket, the S3 adapter is
"wire-correct", not "proven".** See the report accompanying this change for the
explicit list of what remains unverified.

---

## 11. Control-plane operations

These take no `Principal`, by design, and are authenticated by the customer's
project credential at the API boundary:

`createProject` · `createOrg` · `createActor` ·
`softDeleteOrg` / `restoreOrg` · `softDeleteActor` / `restoreActor` ·
`softDeleteProject` / `restoreProject` · `collectStorageOrphans`

Org and actor **creation** are control-plane because there is no principal
inside the system yet who could be authorized to perform them. Org and actor
**lifecycle** is control-plane for a sharper reason: deleting an org kills
membership-derived access, so the instant it succeeds nobody holds a role in
that org and nobody could ever restore it. An authorization rule that makes its
own inverse unreachable is a one-way door, not a rule.

`collectStorageOrphans` is control-plane for a different reason: it operates on
the object store, which has no tenant of its own, and it is the operational job
that pays for the storage-write ordering described in §10a. Its sweeps are
audited to the system chain.

All of them are audited.

**Everything else that names a resource takes a `Principal`.** The exceptions
are enumerated and asserted by a test (`test/persistence.test.ts`, "the
enumerated public surface has no unauthenticated resource accessor"), which fails
when a method is added to `Filelayer` that takes an id and no principal. Internal
helpers are ECMAScript `#private` or module-level functions, so they do not
appear on the prototype at all — unlike a TypeScript `private`, which does.

---

## 12. Errors

Internally we record precisely why access was denied. Externally:

| condition | response |
|---|---|
| absent / not yours / no standing / dead grant | `404 not_found` |
| file expired | `410 gone` |
| deletion blocked by retention | `409 retention_hold` |
| share link needs a password | `401 password_required` |
| attenuation, role escalation, superior target, last owner | `403 forbidden` |

`404` covers everything that would otherwise confirm existence. `410` and `409`
are reachable only by a caller who already proved they may perform the
operation. `403` is answered only to a caller who has already established
standing.

---

## 13. Migration (per-project `external_id` is breaking)

There are no customers, so the migration is a drop and recreate. For a
deployment with data:

```sql
ALTER TABLE org   DROP CONSTRAINT org_external_id_key;
ALTER TABLE actor DROP CONSTRAINT actor_external_id_key;

INSERT INTO project (id, key, name)
VALUES ('00000000-0000-0000-0000-0000000f11e1', '__filelayer_default_project__', 'Default project');

ALTER TABLE org   ADD COLUMN project_id uuid NOT NULL
  DEFAULT '00000000-0000-0000-0000-0000000f11e1' REFERENCES project(id) ON DELETE CASCADE;
ALTER TABLE actor ADD COLUMN project_id uuid NOT NULL
  DEFAULT '00000000-0000-0000-0000-0000000f11e1' REFERENCES project(id) ON DELETE CASCADE;

ALTER TABLE org   ADD UNIQUE (project_id, external_id), ADD UNIQUE (id, project_id);
ALTER TABLE actor ADD UNIQUE (project_id, external_id), ADD UNIQUE (id, project_id);
-- then project_id + the composite foreign keys on membership, file, file_grant,
-- and the project_from_org() trigger on each. See schema.sql.
```

Every pre-existing row lands in one project, which is exactly what a
pre-hosted deployment was.

Other breaking changes in this pass:

- `Filelayer.getFileRecord()` is gone from the class entirely. It is a
  module-level function now, because TypeScript's `private` is erased at compile
  time — `fl['getFileRecord'](id)` was a working cross-tenant metadata read from
  any JavaScript caller, and an SDK consumer holds JavaScript. Module scope is
  the only privacy the runtime enforces. Use `stat(principal, fileId)`.
- `Filelayer.read()` now returns `remainingDownloads` and **charges the download
  cap** when authority came from a grant.
- `Filelayer` constructor options are now `FilelayerOptions` and accept
  `projectId` and `redirectDelivery`.
- `StorageAdapter` gained `provider` (required), `head()`, a streaming `put()`,
  a richer `stream()` with range support, and optional `presignGet()` / `list()`.
  `put()` returns `{ bytes, etag }`; `stream()` returns an object rather than a
  bare `ReadableStream`.
- `UploadInput.body` accepts a `ReadableStream<Uint8Array>`.
- `FileRecord` and `ListedFile` gained `storageProvider`.
- New: `readStream()`, `redeemStream()`, `collectStorageOrphans()`,
  `withTransaction()`, `sendNodeStream()`, `toStreamResponse()`.
