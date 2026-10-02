# Changelog

All notable changes to `@filelayer/core`.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is pre-1.0 and is explained in [`MIGRATIONS.md`](MIGRATIONS.md) §1.

## A note on honesty, before the entries

Most of the entries below are security defects we found in our own code, and
they are described the way we found them, including the ones that were
embarrassing. A changelog that only records features is a marketing document.

`0.3.0` was the first version published to npm, under the `alpha` dist-tag.
`0.1.0` and `0.2.0` predate the registry: they are real, dated development
milestones in this repository rather than releases anyone could install. They
are written up anyway, because a consumer deciding whether to depend on a `0.x`
library is entitled to know what has already moved underneath it.

---

## [Unreleased]

Nothing yet.

---

## [0.7.0] — 2026-10-02

**A correctness release, from the sweep that followed `0.6.0` by about an hour.**

`0.6.0` shipped as a security release, and the obvious next question was whether
the sweep that produced it had looked hard enough. It had not. Three independent
agents were given the tree with one rule — a finding is real only if you have an
executed test that fails here and passes once it is fixed — and they came back
with 66 probes and eleven defects. None of them is an authorization bypass; the
engine held again. All of them are in the surface around it.

The one that should not have shipped:

### Fixed — an expired file could not be deleted by anyone

`lifecycleDenial` returned `file_expired` for every capability, `delete`
included, while the two gates on either side of it were already scoped —
`pending` to `read`, `retention_hold` to `delete`. Expiry was the only unscoped
line, which is how we know it was an oversight rather than a decision.

`delete()` is the only method in the library that removes bytes and it authorizes
`delete` first; the orphan collector skips any key that still has a row. So an
expired file was terminal in both directions at once: the row could not go and
the bytes could not be collected. A plain member could manufacture one with
`expiresIn`, no org owner could clean it up, and the bytes billed forever. An
erasure request against an expired file could not be satisfied through the API.

Expiry gates *use*. Deleting is not use. Retention, which is the control that is
supposed to block deletion, is unchanged and still binds owners.

### Fixed — two ways to leave a tenant with no owner and no way back

An org admin could delete the sole owner's membership the moment that owner was
soft-deleted. `authorizeMembershipChange` read the target's role through
`getMembership`, which excludes soft-deleted actors, so the role came back `null`
and both guards that protect an owner — `superior_target` and `last_owner` —
stood down at once. Restoring the actor afterwards returned an identity with no
role. The event was recorded as `member.add` with `fromRole: null`: the log
described a destruction as an addition.

Separately, `createOrg` ran its three statements in three transactions. A
well-formed but unregistered `ownerActorId` is enough for the membership insert
to fail after the org row had already committed, and the result was permanent:
nobody held `manage_members` so no first membership could be created, `createOrg`
again hit the unique constraint, and `orgs.create` correctly refused to bootstrap
into an org that already existed. The external id was burned.

Membership decisions now read the row **on paper**, soft-deleted actors included,
and enforce two invariants rather than one: at least one owner membership row
must survive (recoverability), and at least one live owner must survive
(administrability). `createOrg` is one transaction.

### Fixed — bytes written for requests that were refused

`retainFor` greater than `expiresIn` violates a CHECK that fires on the INSERT,
which is *after* `storage.put()`. The caller got a raw SQLSTATE 23514 instead of
a 400, and every rejected attempt left an orphaned object with no row and no
audit event to find it by — a member could run up an unbounded storage bill in a
loop. Validated now before the bytes go out, which fixes the status code and the
orphan with one check.

### Fixed — the collector could be talked out of its grace period

`Math.max(60, x)` clamps every finite number, so `0` and `-Infinity` were
harmless. `Math.max(60, NaN)` is `NaN`, `cutoff` becomes `NaN`, and
`lastModified > NaN` is false for everything — the skip never fired and the
60-second floor disappeared. `Number(process.env.GC_GRACE)` on a misspelled
variable is `NaN`, so a correct caller with a typo in a deployment config could
collect uploads still in flight and turn a committed file into one whose object
does not exist.

### Fixed — a destructive job that recorded nothing when it failed

`collectStorageOrphans` wrote its audit event after the delete loop, so a
`storage.delete()` that threw on the third of three destroyed the first two and
recorded nothing at all. The event now goes out in a `finally` and names the keys
actually destroyed, with `complete: false` when it did not finish. On the happy
path it used to record only counts, so even a successful run was
unreconstructable.

### Fixed — a failed `storage.delete()` stranded bytes permanently

`delete()` commits the soft delete and then removes the bytes. If that throws —
one transient S3 error — the row survived, and because the orphan collector
skipped any key with a matching row, the tombstone shielded its own bytes
forever. There is no retry, no reconciler, and the second `delete()` is a 404.
The collector now ignores soft-deleted rows whose retention has lapsed, which is
the same operation finishing rather than a race with it: a file row has no
undelete.

### Fixed — argument validation that reached Postgres raw

`maxDownloads` of `0`, `-1`, `1.5` and `2^31` surfaced as SQLSTATE `23514`,
`23514`, `22P02` and `22003`. Because `23514` is not one of the named `grant_*`
triggers in `SCHEMA_REFUSAL`, the deny-audit branch never fired either, so a
caller hammering it left no row and no trace. `limit: 0` was handled three
different ways on three surfaces: honoured by `fl.auditLog`, discarded by
truthiness in `fl.orgs.audit`, and clamped *up* to one row by `listFiles`.
Negative and non-integer limits reached the driver unvalidated. All are 400s now.

Soft-deleting an actor who belongs to no org wrote no audit event anywhere — the
fan-out loop was the whole audit, and over an empty set it did nothing. It now
falls back to the system chain, as the project lifecycle paths already did.

### Changed — the tamper-evidence claim is narrower, and true

The audit chain detects any edit to a recorded event, the removal of one from the
middle, and the removal of the first. It does **not** detect truncation of the
most recent events: replay walks forward and nothing in the table records where
the chain was supposed to end, so what remains verifies cleanly and reports
`valid: true`. An emptied chain is indistinguishable from one that never existed.

We are not fixing this with an anchor inside the same database, because that
would not be a fix — whoever can delete the rows can rewrite the anchor in the
same transaction. `verifyAuditChain()` now returns `lastId` and `lastHash` so the
head can be pinned somewhere outside, which is the only place the comparison
means anything. `schema.sql`, `README.md` and `TRUST.md` say so plainly, and
`TRUST.md` says how long it said otherwise.

`TRUNCATE audit_event` also bypassed the append-only rules entirely — Postgres
rewrite rules are per-DML-statement-type and `TRUNCATE` is not DML. A
statement-level `BEFORE TRUNCATE` trigger now refuses it. See MIGRATIONS.md Entry
6; the migration is additive.

Two schema comments described things that do not exist and have been corrected: a
"retention trimming path" (there is none, and the log grows without bound) and
`SEMANTICS.md` §5's claim that expiries are "extendable" (nothing in the library
ever updates `expires_at` after the upload).

### Changed — lock ordering on membership changes

`authorizeMembershipChange` counts the owners and then writes. Both halves were
already in one transaction, but the only lock in the unit was the audit chain
lock, taken from the *settle* step — after the count. Two backends demoting two
different owners could both read the pre-state and both commit. The per-org chain
lock is now taken as the first statement of the unit, which preserves the
documented global ordering (chain lock before any row lock) where a `FOR UPDATE`
on `membership` would have inverted it. Not proven under contention: the test
engine has one backend. Disclosed in TRUST.md, unchanged.

### Documented

`Queryable.query` now states its contract: every call in a unit of work must
reach the same backend connection. Every shape we document is safe — a `pg.Pool`
is used through `connect()`, a `Client` is one connection, PGlite has one backend
— but the type accepts a hand-rolled forwarding wrapper, and with one of those
`withTransaction` issues `BEGIN` on one connection and the write on another. The
call looks transactional and has no atomicity at all.

### Tests

364 across 90 suites, up from 352 across 83. Ten new regression tests, each
observed to fail against `0.6.0` and pass here. Two existing tests changed, and
both deserve naming: one used `retainFor > expiresIn` as its failure injection,
which was relying on the defect above to stage itself; the other asserted that
the collector never touches a soft-deleted row, on a rationale — "a retention
hold blocks the delete, so the row survives" — that cannot happen, because a hold
blocks the delete and the file therefore never reaches `state = deleted`.

## [0.6.0] — 2026-10-02

**A security release. Upgrade from any earlier version.**

`0.3.0` through `0.5.3` contain a remote unauthenticated denial of service and a
tenant takeover. Both were found by an adversarial review of the *published*
package, not of a working tree, and both were reproduced against the tarball
before anything was changed. Earlier versions are deprecated on npm.

### Fixed — critical

- **A single unauthenticated request could stop the process.**
  `shareDownloadRoute` decoded the secret path segment *outside* its `try`, so a
  malformed percent-escape — `GET /d/%%%`, four characters, no credential, no
  valid secret, no body — threw `URIError`. The returned async handler rejected,
  `node:http` had nowhere to catch it, and Node's default `unhandledRejection`
  policy terminated the process.

  It was reachable through `deliveryHandler()`, which is the one-liner the
  quickstart, the homepage and `examples/vault/server.ts` all recommend. Both
  route helpers are now total: nothing before the `try` can throw, and a segment
  that is not valid percent-encoding is the same 404 as a secret we never issued.

- **`orgs.create()` on an existing tenant made the named identity an owner of
  it.** The method is documented as idempotent, which invites calling it on every
  signup. On an `external_id` that already existed it returned that tenant *and*
  bootstrapped the named identity as an **owner** — no principal, no
  authorization check. Any caller who controlled the tenant slug could read the
  tenant's private files, read its audit log, and evict the real owner.

  It worked on the implicit single-tenant workspace too, so a tier-2 application
  that had never heard the word "org" was equally exposed:
  `orgs.create('__filelayer_workspace__', { owner: 'mallory' })`.

  `Filelayer.createOrg` refused the same call with a unique violation. The facade
  was more permissive than the engine it wraps, which is the one thing a facade
  must never be. It is now idempotent only for a genuine retry — same owner, same
  answer — and `409 org_exists` otherwise.

### Fixed — high

- **A project-bound instance could soft-delete, and restore, another customer's
  project.** `#setOrgDeleted` and `#setActorDeleted` both carry the project
  filter; `#setProjectDeleted`, twelve lines below them, did not. Deleting took
  every tenant in the victim project dark. Restoring is the worse direction: it
  silently re-arms every share link an operator believed revoked when they
  terminated that customer. An instance built with an explicit `projectId: null`
  is the control plane and may still reach any project.

- **`files.put({ org, owner })` auto-joined an arbitrary existing tenant.** One
  byte uploaded into someone else's named org added the uploader as a `member`,
  which is read access to every `visibility: 'org'` file in it and a listing of
  the tenant's documents. `addMember` denies that exact call. Auto-join now
  happens only in the default workspace — where it is the single-tenant design —
  or in an org the same call just created.

- **A malformed file id was a 500 with no audit event, where an unknown one is a
  404 with a deny.** A non-uuid reached the audit write, whose `file_id` column
  is `uuid`, and raised `22P02`. That is not a `FilelayerError`, so the shipped
  routes could not map it: an existence oracle on the one input an internet user
  types, and the probe left *no* record, because the write that would have
  recorded it was the write that failed. Malformed identifiers are now kept
  verbatim in the event's `context` — inside the hash digest, so as
  tamper-evident as the rest of the row — exactly as malformed addresses already
  were.

  Found while fixing it: the audit `INSERT` read `actor_id` and `file_id` from
  the caller's input while the chain digest was computed over the normalised
  values. Both now come from the same object, so a row can no longer be covered
  by a hash over data it does not hold.

### Fixed — behaviour changes you may notice

- **`expiresIn: 0` and `expiresIn: NaN` meant "never expires".** Both call sites
  were `input.expiresIn ? … : null`. `NaN` is what `Number(req.body.ttl)` returns
  for a missing field, and `0` is what someone writes meaning "immediately", so
  the most restrictive value anyone could ask for produced the least restrictive
  outcome — while `-1`, which is nonsense, failed closed. The same shape as the
  password that was accepted and never enforced in `0.5.0`. Non-finite and
  non-positive values are now `400 invalid_argument`, for `expiresIn` and
  `retainFor`, on uploads and on shares.

- **The credential-in-the-query refusal was case-sensitive.** `?password=` was a
  400; `?Password=` was served with a 200. A guard that depends on the attacker's
  shift key is decoration. Matching is now case-insensitive.

### Added

- Nine regression tests in `test/regression.test.ts`, each observed to fail
  against the `0.5.3` sources and pass here. The suite is **352 tests across 83
  suites**.

### A note on where the defects were

Three independent agents attacked in parallel. The authorization **engine**
held: 1,440 differential comparisons between `listFiles` and `authorize` over
soft-delete axes the shipped corpus never touched, 54 delete/restore orderings,
cross-tenant isolation, delegation attenuation, audit-chain lock ordering — zero
discrepancies.

Every defect above is in the surface *around* the engine: the convenience facade,
the HTTP route helpers, and the control plane. 343 tests and twelve gates did not
see them, because all of them tested what the library decides and none of them
tested what the library does with a request that is merely malformed.

---

## [0.5.3] — 2026-09-30

**Two public surfaces contradicted two other public surfaces.** No code change.

### Fixed

- **`examples/vault/server.ts` claimed an independent security review.** Its
  revision-3 header said four defects were found by *"an independent security
  review"*. `TRUST.md` lists **Independent security review: none**, and that is
  the true one — the review was internal. A page that trades on accuracy cannot
  have one file quietly awarding itself a credential another file disclaims, and
  of the two possible fixes, deleting the claim was the only honest one.

- **The homepage linked `openapi.yaml` under a heading promising the tarball.**
  §7 opens with *"Every surface below already exists in the repository and ships
  inside the npm tarball"*, and the OpenAPI card linked the YAML. The tarball
  ships `openapi.json` only. The card now links the JSON and says where the YAML
  lives.

### Not a defect, checked

The homepage does not mention the opt-in redirect delivery mode, which trades a
bounded revocation window for cacheability. The page describes the **default**
byte path, where revocation is immediate, and that description is accurate. An
omission of a mode you have to switch on is not a false claim about the mode you
get. `TRUST.md` and `README.md` both document the window.

---

## [0.5.2] — 2026-09-30

**An org could be left with no living owner, and a failed membership change was
recorded as a success.** Both found by re-verifying our own audit report, which
also turned out to contain two findings that were not real. That is written up
below too.

### Fixed

- **`countOwners` counted soft-deleted owners.** It feeds exactly one decision:
  the `last_owner` guard that refuses to demote an org's final owner, so that no
  org is left with nobody accountable for it. The query read `membership` alone,
  while `getMembership` — two methods above it — has always excluded deleted
  actors. An org whose other owner had been deleted therefore read as having two,
  the guard stood down, and the last living owner could demote herself.

  The result was an unadministrable org: no member could be added, no file
  deleted, no audit log read, and no supported call could repair it. A deleted
  actor cannot act, so it must not count toward the quorum that proves somebody
  can.

- **`addMember` and `removeMember` are now one transaction with their audit
  event.** They authorized — which *writes* the allow event — and then mutated,
  as two autocommit statements. A well-formed but unregistered actor id is enough
  to make the `INSERT` fail on its foreign key, and the call then threw while
  leaving `member.add / allow` in the log for a privilege grant that never
  happened.

  A log that records privilege grants which did not occur is worse than a log
  with a gap, because the gap is visible. `test/persistence.test.ts` has asserted
  this property since 0.4.0 under the name *"the mutation and the audit event
  that records it commit together"* — for uploads and revocations. Membership,
  which is the privilege that confers every other privilege, was the one mutation
  it did not cover. It is covered now, in both directions: the failure path
  leaves nothing behind, and the success path is asserted to take the chain lock
  before the row lock, as every other mutation does.

- **`shares.create` now types its return correctly for the link case.** A share
  with neither `withUser` nor `withOrg` is a link, and a link always carries a
  secret — but `ShareResult.secret` is optional, because an `actor`, `org` or
  `role` grant has nothing to hand out. An overload now narrows it, so
  `redeem(share.secret)` typechecks without a non-null assertion. The shortest
  correct version of our own headline example needed a `!`, which reads as the
  library's types being wrong about the library.

### Added

- **`npm run check:web-samples`.** Typechecks every TypeScript block on the
  homepage against the real library under `--strict`. `check-doc-samples.mjs` has
  compiled and executed every sample in `README.md` and `docs/QUICKSTART.md`
  since before the site existed; the homepage was never added to a list, so the
  most-read code we publish was the only code we published that nobody checked.
  It is a typecheck rather than an execution because homepage samples are
  deliberately elided, and a sample rewritten to be executable is no longer the
  sample on the page.

  Four negative controls, including the exact defect that shipped.

### A note on the audit report

Of the six HIGH findings in the 2026-09-29 internal audit, **two were not real**
and one was overstated. They are recorded here because the report was used to
order this work, and a defect list that invents entries is worse than no list:

- **H1 — "a malformed `X-Forwarded-For` rolls back the transaction." False.**
  `store.audit()` has kept an unparseable address in `context.rawIp` since the
  initial `0.3.0` release, and `context` is covered by the audit digest, so the
  value is preserved *and* tamper-evident while the request survives. Verified
  against `v0.4.4` as well, to rule out an incidental fix.
- **H6 — "every example tells you to run a command that does not exist." False.**
  The documents reference `npm run example:tier1` … `:vault`, and all four exist.
  The broken form appears only inside the audit report itself.
- **H5 — "two website code samples do not compile." One sample**, failing at two
  lines with one root cause, fixed above.

H2, H3 and H4 were real, are fixed, and each now has a test that fails against
the release before it.

---

## [0.5.1] — 2026-09-30

**Every index on `file_grant` was unreachable. Authorization cost grew with the
size of the table.**

No correctness defect, no API change, and no behavioural change. The published
`0.5.0` — and every release before it — performed every authorization decision
without using a single one of the six indexes on `file_grant`.

### Fixed

- **The partial indexes on `file_grant` are now usable.** Five of the six are
  partial on `revoked_at IS NULL`, and a partial index can only be used by a
  query the planner can prove implies its predicate. No query in `store.ts`
  did — for two different reasons. Every grant lookup reads `live_grant`, whose
  predicate was `grant_is_live(id)`; a function call is opaque, so
  `revoked_at IS NULL` was unprovable. And `findGrantBySecret()`, which reads
  `file_grant` directly, simply never stated it.

  `live_grant` now states `revoked_at IS NULL` alongside `grant_is_live(id)`.
  The conjunct is **logically redundant** — `grant_is_live` already requires it
  of the row itself — so the view returns exactly the rows it did before, which
  is asserted in both directions and against `live_grant_recursive`, the
  independent formulation that shares no code with `grant_is_live`.

  The cost was worse than a sequential scan. On the `live_grant` paths the
  planner evaluated `grant_is_live(id)` — a recursive CTE declared `COST 100` —
  once per candidate row. `getActorGrants()` was not even a scan: it used the
  composite unique key, read every grant on the file, and called the function on
  all of them.

  Measured on 6,001 grants with a tenth revoked:

  | lookup | before | after |
  |---|---|---|
  | `findGrantBySecret` | Seq Scan, 6001 rows filtered | `grant_secret_idx`, 0 |
  | `findLiveGrantBySecret` | Seq Scan, 6001 rows filtered | `grant_secret_idx`, 0 |
  | `getActorGrants` | 6001 rows filtered | `grant_subject_idx`, 0 |
  | `getAnonymousGrant` | 6000 rows filtered | `grant_file_subject_type_idx`, 0 |

- **`grant_secret_idx` is no longer partial on `revoked_at`**, deliberately.
  `redeemStream()` resolves a link secret to a file *before* authorizing
  anything, because a revoked link has to reach the engine for its denial to be
  attributed to the right tenant instead of vanishing onto the system chain. So
  that lookup must see revoked rows — and an index excluding them left the one
  path an unauthenticated caller reaches, `GET /d/<secret>`, scanning the whole
  table, growing with every grant ever issued.

- **`grant_file_subject_type_idx` added**, on `(file_id, subject_type)` where not
  revoked, for the anonymous and actor lookups. A file that has been shared for a
  year has many link grants on it, and `grant_file_idx` alone returned all of
  them for the `subject_type` filter to throw away.

### Added

- `test/performance.test.ts`. Nine tests asserting the **shape of the plan**
  rather than a wall-clock number, which would measure the machine: that no grant
  lookup sequentially scans `file_grant`, that none of them reaches the filter
  with rows an index should have discarded, and — with `enable_seqscan = off` —
  that the indexes are *usable* rather than merely sometimes chosen. Those are
  different failures and only the first is a defect.

  Two of the nine are negative controls that reintroduce each half of the fix and
  assert the plans regress. Against the 0.5.0 schema, five of the nine fail.

  This is the gap the defect lived in: the suite tests behaviour exhaustively,
  and the return values were always correct. Nothing was looking at how they were
  obtained.

### Changed

- `MIGRATIONS.md` no longer says nothing has been published to npm. It has been
  since `0.3.0`.

### Migration

Entry 5 in [`MIGRATIONS.md`](MIGRATIONS.md). One `CREATE OR REPLACE VIEW`, an
index swap and one new index, all safe online; use `CONCURRENTLY` on a large
table. A deployment that does not run it keeps working and stays slow.

---

## [0.5.0] — 2026-09-29

**Two security defects found by internal audit, in the published `0.4.4`.**
Neither had a known victim, because there are no known deployments. Both are
recorded here anyway, because a quietly patched authorization bug is how a
project teaches people not to trust its changelog.

Both carry a migration: see `MIGRATIONS.md` entries 3 and 4.

### Fixed — a password was accepted where it was never enforced

`share()` hashed and stored `password` for **every** subject type, but
`authorize()` consults `password_hash` on the **link** branch alone. So

```ts
share(principal, fileId, { subject: { type: 'anonymous' }, password: 'hunter2' })
```

was accepted, stored the hash, and published the file **to anybody, with no
password at all** — silently, with nothing in the audit log to notice, while at
the call site it looked exactly like publishing behind a password. The link path
enforced the same option correctly, which is what made the mistake plausible.

Fixed in two independent places, because one `if` is a thing a refactor drops:
`share()` now raises `400 password_requires_link_subject`, and
`grant_password_only_on_link` refuses the row from any writer including `psql`.
`grant_subject_coherent` already pinned every *other* subject column for exactly
this reason; `password_hash` was the one it missed.

### Fixed — a client IPv6 address could mark a tenant's audit chain as forged

`auditHashTail()` builds the digest in the application process from the
submitted address; the column is `inet`, which Postgres canonicalises; and
`verifyAuditChain()` recomputes from `host(ip)`. `normalizeIp()` validated the
shape and returned the string **unchanged**.

`2001:0db8::1` — one leading zero, which plenty of clients emit — therefore
hashed one value and verified against another, and that tenant's chain read
`hash_mismatch` from that row onward. Permanently: `audit_event` is append-only.
`X-Forwarded-For` is attacker-controlled, so this was one header away from
anybody. `schema.sql` states the standard it failed: tamper evidence that cries
wolf is not tamper evidence.

`normalizeIp()` now returns exactly what `host(inet)` reads back — the
`inet_ntop` algorithm, not an approximation — and is **differentially tested
against Postgres** over a randomised corpus, because "matches libc" is a claim
that has to be checked against libc rather than reasoned about.

### Fixed — `TRUST.md` stated the wrong version

It said `0.4.3` while the package was `0.4.4`, on the one page every other
surface sends a sceptic to. `tools/check-version-claims.mjs` — added in 0.4.4 to
prevent precisely this — had no `TRUST.md` entry. It does now.

### Tests

324 → **330** across **76** suites. Six new, all regression tests for the above:
four for the password refusal (API, link still works, database, and a
non-vacuous control) and two for the address canonicalisation (the differential
test against Postgres, and a chain that survives a non-canonical address).

---

## [0.4.4] — 2026-09-06

Documentation only. **No API change, no schema change, no behaviour change.**
The `schema.sql` and `authz.ts` edits are comments; the SQL and the decision
logic are byte-for-byte the behaviour of `0.4.3`.

### Corrected — security claims that overstated what is enforced, and where

We described Filelayer in a way that implied it supersedes database-level
enforcement. It does not, and the repository contradicted itself about it: the
README disparaged predicate-based enforcement while our own published Supabase
comparison concluded that authorization living next to the data "is a
structurally stronger position than middleware." The second one is right.

The corrected framing, now consistent across every public surface:
**Filelayer is authorization middleware, not row-level security. It decides for
calls made through it. Some invariants — cross-tenant grants, cross-project
identities, and delegation that amplifies authority or subject breadth — are
refused by constraints and triggers and therefore bind every writer, including
a `psql` session. All read authorization is in `authz.ts`. There is no RLS
policy in `schema.sql`, and a direct `SELECT` is not filtered. The two layers
compose; this one does not replace the other.**

- **`README.md`** — removed "there is exactly one place a decision is made, and
  it is not in your application", which was false for any caller that bypasses
  the library. Added the middleware/RLS paragraph.
- **`README.md`, P3** — was "Cross-tenant *access* is unrepresentable, not
  merely prevented by a `WHERE` clause." Two faults: *access* is a read and the
  composite foreign key constrains writes, and the comparison disparaged the
  mechanism RLS is built on. Now "cross-tenant grants are structurally
  impossible to write", scoped to the row.
- **`packages/core/schema.sql`** — the P3 header comment carried the same two
  faults verbatim. Corrected. This is the file both `README.md` and `TRUST.md`
  send a sceptical reviewer to first.
- **`packages/core/src/authz.ts`** — the module header made the same
  exclusivity claim and listed "every RLS policy" as a source of leaks.
- **`TRUST.md`** — "enforces them at the data layer" was false for the read
  half of P1 and P3, and for P2 and P5. Now says which properties bind every
  writer and which bind only library callers.
- **`llms.txt`** — added the middleware/RLS distinction to the opening, because
  an agent that assumes data-layer enforcement will write an unsafe direct
  query.
- **`docs/QUICKSTART.md`** — "Nobody else can" now states the two caveats it
  omitted: org admins and owners can read `private` files, and a direct query
  against the `file` table is not filtered.
- **`examples/`** — removed "no RLS policies" from the vault's list of absences
  and said explicitly that the absence is not a claim that database-level
  enforcement is unnecessary; removed "no way to write one wrong" (the bucket
  is a way); qualified tier 2's "readable by alice and by nobody else".
- **`packages/core/package.json`** — description now reads "authorization
  middleware" and "a single decision point".
- **`openapi.yaml` / `openapi.json`** — "Authorization … is **entirely ours**"
  is gone. It was the strongest exclusivity claim we made, on the surface an
  integrating agent is most likely to read *instead of* the README. It is now
  scoped to requests that reach the two routes, and carries both the
  middleware/RLS distinction and the precondition the document cannot enforce:
  **your object bucket must be private.** Storage keys are `orgId/fileId` and
  are deliberately not secrets (P2), so a world-readable bucket makes the rest
  of the document inapplicable — and nothing in it had said so. Edited in
  `tools/openapi.mjs`, which generates both files.
- **`ARCHITECTURE-PROGRESSIVE.md` §4.3** — the "6.7× fewer places to get right"
  figure sits directly under a row reading "Supabase + RLS", which invites
  exactly one misreading. The measurement stays, unaltered; what is added is
  the sentence that makes it honest: **reduction in decisions and strength of
  enforcement are different axes, and RLS wins the second.** It now cites our
  own published comparison, which concludes that authorization living next to
  the data "cannot be bypassed by a new code path" and is "a structurally
  stronger position than middleware."

### Fixed — stale version and test counts on public surfaces

`SECURITY.md` said `0.3.0` and listed `0.3.x` as the supported line, so the
security policy declared the current release unsupported.
`ARCHITECTURE-PROGRESSIVE.md` and `architecture/TIER5-DESIGN-NOTE.md` said
"current as of 0.3.0", and the former claimed 313 tests across 68 suites. It is
**324 across 74**. `PUBLISH-RUNBOOK.md` still instructed the publisher to expect
an `E404` from the registry, which would abort every release after the first.

### Added — a gate so the version drift cannot happen again

`npm run check:versions` (`tools/check-version-claims.mjs`, wired into
`npm run verify`) fails the build when a public surface states a version that
disagrees with `packages/core/package.json`, when the supported-versions table
in `SECURITY.md` does not list the current minor, or when two surfaces disagree
about the test or suite count. Historical mentions — "Fixed in `0.3.0`", the
ranges in `MIGRATIONS.md` — are not claims and are not checked; the gate matches
specific current-state phrasings instead. It carries a negative control, and it
was validated by reintroducing the exact drift described above and confirming it
is caught.

One policy file changed to support this work. `.internal-language.json` now
exempts the comparison-implementation term when every occurrence on the line is
part of a published `benchmark/baseline-supabase/`-style path — mirroring the
exemption its neighbouring rule already carried, for the same reason: a file
reference is not the framing the rule exists to ban, and the reports in those
directories are evidence we cite against ourselves. Bare uses remain violations,
verified with a negative control. The gate then caught this very changelog entry
on its first draft, which is the behaviour we wanted.

---

## [0.4.3] — 2026-09-06

Distribution only. No product change, no API change, no schema change, no
change to any authorization decision. Two defects in how the package reaches a
reader, one of which turned out not to be where we thought it was.

### Fixed

- **The npm packument carried no README, and the diagnosis we started with was
  wrong.** `https://registry.npmjs.org/@filelayer/core` answers with
  `"readme": ""` and `"readmeFilename": ""`. That matters more than it sounds:
  npmjs.com returns 403 to every non-browser client, so for a tool or an agent
  the registry JSON is the entire package description, and what it contains is
  a 178-character summary and twelve keywords including `s3` and `r2`. From
  that the reasonable inference is "an S3 wrapper" — which is precisely the
  inference the README's alpha banner, its "never run against live
  credentials" warning and its Limitations section exist to prevent.

  The suspected cause was ordering: `packages/core/README.md` was generated by
  `prepack`, so on a clean checkout it did not exist, and npm was assumed to
  build the publish manifest before `prepack` runs. **That is not what npm
  does.** `npm publish` reads the manifest, packs (which runs `prepack`), and
  then reads the manifest *again* — the comment in npm's own publish command
  says "The purpose of re-reading the manifest is in case it changed" — and it
  is that second read that is sent to the registry.
  Publishing a clean clone at a local capture registry, under both npm 10.9.8
  and npm 11.12.1 (the version that published 0.4.0–0.4.2), produced a manifest
  carrying `readme` of 20,793 characters and `readmeFilename: "README.md"`. The
  README was already reaching npm.

  What is actually happening is on the registry side. npm hoists a version's
  `readme` to the top of the packument and deletes it from the version
  document, and it does that only for the version that is `latest` at the
  moment of publish. Every version of this package was published with
  `--tag alpha`, and the evidence is visible in the packument: 0.4.0, 0.4.1 and
  0.4.2 still carry a per-version `readmeFilename`, meaning they were never
  hoisted, while in every package we compared against — `chalk`, `semver`,
  `typescript`, `next`, `@electric-sql/pglite` — exactly the `latest` version
  has had its `readmeFilename` stripped and every non-`latest` tagged version
  has kept it. The empty string at the top of our packument dates from the
  0.3.0 publish that created it and has never been rewritten, because no
  publish since has been a `latest` publish. Moving the tag afterwards with
  `npm dist-tag` does not re-run the hoist.

  So the remedy is in the publish step, not in the package: `publish.sh` now
  publishes to `latest` and adds the `alpha` tag immediately afterwards, and
  then *asserts* that the packument's `readme` is non-empty rather than
  assuming it. `latest` has already pointed at this alpha since 0.4.2, so this
  changes what npm records about the package and not what `npm install
  @filelayer/core` resolves to.

- **`llms.txt` and `openapi.json` were not in the tarball.** Both are written
  for a reader who is not a person with a browser, and neither was reachable
  from an install: `tar tzf` on the published 0.4.2 artifact lists a README, a
  LICENSE and a NOTICE under the tarball's `package/` prefix, and nothing else
  of the kind. An agent whose whole world is `node_modules/@filelayer/core` had
  the README and the source, and no map. They now ship, and resolve as subpath
  imports — `@filelayer/core/llms.txt` and `@filelayer/core/openapi.json`,
  alongside the `@filelayer/core/schema.sql` that already existed — so nothing
  has to guess at the layout of `node_modules`.

### Changed

- **README, LICENSE, NOTICE, `llms.txt` and `openapi.json` are tracked inside
  `packages/core` instead of being copied in by `prepack`.** This is not what
  fixes the packument — see above, and the note at the top of
  `tools/check-package-copies.mjs`, which says so where someone would otherwise
  re-derive the wrong conclusion from the diff. It fixes a smaller, real thing:
  on a clean checkout those files did not exist until something ran `pack`, and
  every gate that reads "what the package ships" was reading absent files and
  passing. `tools/check-publication-boundary.mjs` expands the `files` array
  against the disk and skips entries that are not there; on a fresh clone it
  skipped all three.

  Tracking a copy creates a second source of truth, which is only an
  improvement if the copy is verified rather than trusted. `npm run verify` now
  runs `tools/check-package-copies.mjs`, which compares each pair as bytes — a
  trailing newline or a BOM is a difference — and additionally requires that
  each copy is tracked by git, is listed in `files`, is not written by
  `prepack`, and carries a version stamp equal to the version being published.
  It runs a negative control first, on ten pairs whose correct classification
  is known, including two empty files (which are identical) and an empty file
  against a full one (which is not): a comparator written with a truthiness
  test gets both wrong while appearing to work.

- **`prepack` is now just `npm run build`.** It no longer copies anything.

---

## [0.4.2] — 2026-09-06

The audit log now answers in your identifiers instead of ours. No schema
change, no API break, no change to any authorization decision.

### Changed

- **`auditLog()` answers "who touched this?" in the caller's own vocabulary.**
  The log stored `actor_id`, `file_id` and `org_id` — internal uuids — and
  shipped no supported way back to the ids the caller had supplied. So the one
  question the audit trail exists to answer rendered as
  `97cf1649-dd8...` where the developer had written `marco`, and the only route
  to a readable answer was to find the `actor` table in `schema.sql` and write
  SQL against it. The first developer to try it from the public docs lost about
  eight minutes there, on the step this product is *for*.

  Every row returned by `fl.auditLog()` (and therefore by `fl.orgs.audit()`) is
  now a `ResolvedAuditRow`, which is `AuditRow` **plus** four fields:

  ```ts
  const [row] = await fl.orgs.audit('acme', { as: 'ceo', decision: 'deny' });

  row.summary;        // '2026-09-06T10:12:41.002Z marco file.read deny:grant_revoked contract.pdf @acme'
  row.actor.label;    // 'marco'         — the `as:` that was passed
  row.file.label;     // 'contract.pdf'
  row.org.label;      // 'acme'          — the `org:` that was passed
  row.actorId;        // the uuid, unchanged, exactly where it has always been
  ```

  - **Additive, deliberately.** Every internal id is still on the row, in the
    same field, with the same value. Something downstream may be keyed on them;
    replacing them would have been a breaking change wearing a usability
    costume.
  - **`label` is never null**, so a row always prints. An access with no
    principal — a share link, a public URL — reads as `anonymous` rather than a
    null the caller has to interpret. An event with no tenant (the system
    chain, `org_id IS NULL`) reads as `system`. An id that resolves to nothing
    keeps its uuid and says `resolution: 'unresolved'` rather than inventing a
    name. `.actor.externalId`, `.org.externalId` and `.file.name` are the same
    values without the fallback, for callers who want the null.
  - **It is still one query.** Resolution is three `LEFT JOIN`s on the statement
    that already reads the events, not a lookup per row: an audit read happens
    during an incident, and turning it into N+1 round trips would be a worse
    defect than the one being fixed.
  - **The joins are project-scoped (P8).** An audit event may legitimately name
    an identifier belonging to another application — that is what a probe looks
    like — and such an id must resolve to nothing rather than print another
    customer's vocabulary into this tenant's trail.
  - `packages/core/test/audit-resolution.test.ts` covers the legible answer, a
    denial with its reason and the principal who was refused, anonymous access,
    the system chain, the project boundary, and the single-statement claim.

### Fixed — documentation

- **`packages/core/CHANGELOG.md` asserted in bold that "No version of this
  package has been published to npm", directly above dated entries for `0.3.0`,
  `0.4.0` and `0.4.1`, all of which are on the registry.** It was true when it
  was written and nobody deleted it at the first publish. The same staleness had
  left everything shipped in `0.3.0` and `0.4.0` sitting under an
  `[Unreleased]` heading; that material is now filed under the releases it went
  out in, with its text unchanged.
- `llms.txt` announced the current version as `0.3.0`, and `README.md` dated its
  Limitations list "current as of `0.3.0`". Both are `0.4.2`.
- The HTML comment in `README.md` explaining that the CI and npm badges "render
  as unknown until the repository is pushed and the package is published" has
  outlived both conditions and is gone.
- `TRUST.md` and `README.md` both put the suite at 313 tests. It is 324.

---

## [0.4.1] — 2026-09-06

A single defect, in the first command a new user runs. Nothing else changed: no
API change, no schema change, no behaviour change. If you already have a working
install, this release does nothing for you.

### Fixed

- **The documented command for installing PGlite could not resolve against the
  peer range this package declares.** `0.4.0` declares
  `peerDependencies: { "@electric-sql/pglite": "^0.3.11" }`, as an optional peer.
  The install command in the `createTestDb()` error message, in `README.md`, in
  `docs/QUICKSTART.md`, in `llms.txt` and in the changelog entry above carried no
  version at all. PGlite's `latest` on npm is `0.5.8`, outside `^0.3.11`, so
  following our own written instructions could put a version on disk that the
  declared range does not admit — and npm then refuses the whole tree:

  ```
  npm error Could not resolve dependency:
  npm error peerOptional @electric-sql/pglite@"^0.3.11" from @filelayer/core@0.4.0
  ```

  It is deterministic for anyone whose project already has PGlite, or who asks
  for a specific version, and it is a hard stop about sixty seconds in. Every
  install command in this repository is now version-explicit:

  ```bash
  npm install --save-dev "@electric-sql/pglite@^0.3.11"
  ```

  The quotes are for the shell, not for npm — `^` is a glob operator under `zsh`
  with `extendedglob` and an escape character in `cmd.exe`, and a command that
  breaks in a common shell is the same defect wearing a different hat.

### Not changed, deliberately

- **The peer range is still `^0.3.11`. PGlite 0.5.x is not supported.** Before
  choosing between widening the range and fixing the instructions, the full
  suite was run against `0.5.8`. It does not pass. `tsc --noEmit` is clean and
  every assertion that executes passes, but seven test files are killed by the
  operating system and the run aborts after 92 of 313 tests. Reproduced in
  isolation with 3.6 GB free, so it is not a plain out-of-memory: one suite runs
  20 of 21 subtests green and is then killed. Against `0.3.16` the identical
  suite is 313 of 313.

  We have not diagnosed it further, because the supported range is the decision
  in front of us and the cause is upstream. What we will not do is widen the
  range to whatever npm installs by default and describe an untested
  configuration as supported. When 0.5.x passes, the range moves and this entry
  gets a successor.

### Added

- **`tools/check-install-commands.mjs`, wired into `npm run verify`.** It reads
  every tracked file and fails the build if an install command names a
  version-constrained package without a version constraint, or pins one to a
  range that is not the range `packages/core/package.json` declares. The
  comparison is semver intervals rather than string equality and runs in both
  directions, so widening the peer range without updating the documentation
  fails, and so does the reverse. No network and no install: it is a check on
  what we wrote, evaluated against what we declared.

  It carries a negative control that runs on every invocation, before the real
  scan: fourteen commands whose correct classification is known — including the
  exact unversioned command `0.4.0` shipped, in each of the five forms it was
  written in — plus seven pieces of text that must *not* be read as install
  commands. If the detector misclassifies any of them the check exits `2` and
  says the detector is broken rather than reporting a clean repository. A
  checker that has never rejected anything is a green tick of unknown value.

### Changed

- **The release gate now runs the documented command instead of its own.**
  `tools/verify-release.mjs` reads the install command out of `README.md` at run
  time and executes that string in its empty consumer directory. It used to
  write its own equivalent, which is why a green gate and a broken instruction
  could coexist for a whole release: the gate was testing a command no user
  would ever type.
- **The gate also installs in the other order.** Phases 1 and 2 install the
  package first and PGlite second, and in that order npm can rescue a bad
  instruction by quietly walking `latest` back into the peer range — which is
  precisely how `0.4.0`'s command passed. A new phase does it the other way
  round, in a second directory that has never contained anything: the documented
  command first, then `@filelayer/core` on top. There is nothing left to rescue
  there, so the resolution failure is either real or absent. It asserts, too,
  that the version actually installed satisfies the declared range, because an
  install that succeeds by giving the reader something other than what they
  asked for is still a broken instruction.
- `README.md`, `docs/QUICKSTART.md` and the `createTestDb()` error message now
  state the supported range in words as well as in the command: the 0.3.x line
  is supported, 0.5.x is not, and the reason is that the suite does not pass
  against it.

---

## [0.4.0] — 2026-09-06

### Changed

- **`@electric-sql/pglite` is no longer a runtime dependency.** It is now a
  dev dependency and an *optional* peer. The published package declares zero
  runtime dependencies. A library whose premise is "run it against your own
  Postgres" should not install an embedded WASM Postgres into every production
  deployment; it did, and that was wrong.
  `createTestDb()` and `Filelayer.quickstart()` still need it, and now say so
  with an actionable message instead of a module-resolution error. If you use
  either in tests, add
  `npm install --save-dev "@electric-sql/pglite@^0.3.11"`. Nothing
  else changes; production code paths never imported it.

  *(The command in this entry originally omitted the version constraint. That
  omission is the defect fixed in 0.4.1, and the command has been corrected here
  so that nobody reading the history copies the broken one.)*

### Added

- A CI job that exercises the S3/R2 storage adapter against live object storage
  when credentials are configured, and states plainly in the build summary when
  they are not. See `docs/LIVE-S3-TESTS.md`.
- `TRUST.md` — the current state of this project in numbers, including the ones
  that are zero, and what would change them.

### Fixed

- `FILELAYER_TEST_S3_PREFIX` used `??` rather than `||`, so the empty string CI
  supplies for an unset variable became a real value and rooted test objects at
  the bucket root instead of under the prefix cleanup deletes.

---

## Detail for 0.4.0 and 0.3.0

Everything below shipped. It was written under an `[Unreleased]` heading and
stayed there through two releases; the heading was wrong, the text was not, so
the text is kept verbatim and correctly filed. **Packaging** — the published
tarball having no runtime dependencies — and the live-storage CI job are
`0.4.0`. **Group grant subjects** (RFC-001), the byte-range status fix and the
`getActorGrants` ordering fix are `0.3.0`. The dated entries above and below are
the short form of the same work; this is the long form, kept because it is where
the reasoning is.

### Changed — packaging

- **`@electric-sql/pglite` is no longer a runtime dependency.** It was the only
  one, and it should never have been one: it is an embedded WebAssembly
  PostgreSQL, and a library whose entire premise is "run it against your own
  Postgres" has no business putting a second Postgres into every production
  `node_modules`. It is used by exactly two functions — `createTestDb()` and the
  `Filelayer.quickstart()` built on it — and both are development helpers.
  - It is now a **`devDependency`** (the suite needs it) *and* an **optional
    peer dependency** (`peerDependenciesMeta.optional: true`). A consumer who
    wants `createTestDb()` is told what to install and at which version range; a
    consumer who does not gets no install warning and no WASM blob.
  - **Installing `@filelayer/core` now installs one package.** Asserted from
    inside the installed copy by the release gate and by the packaging job, so
    a runtime dependency cannot be reintroduced without a red build.
  - **Nothing about the public API changed.** `createTestDb`, `SCHEMA_PATH` and
    `loadSchemaSql` are exported exactly as before, and production code — a
    `pg.Pool` (or anything satisfying `Queryable`) passed to `new Filelayer()` —
    never touches the removed dependency. If you use `quickstart()` or
    `createTestDb()`, add
    `npm install --save-dev "@electric-sql/pglite@^0.3.11"`.
- **`createTestDb()` without PGlite installed now explains itself.** It used to
  surface Node's raw `ERR_MODULE_NOT_FOUND` from inside `dist/`, naming a
  package the caller never asked for. It now throws an error that names
  `@electric-sql/pglite`, gives the exact install command, says why the package
  is optional, and points at the production alternative (`pg.Pool` plus
  `psql -f node_modules/@filelayer/core/schema.sql`). The original resolution
  error is preserved as `cause`. A resolution failure *inside* PGlite — a broken
  install rather than a missing one — is passed through untouched.
- **The release gate now runs the whole lifecycle twice, in both shapes.** Once
  in the shape a production consumer installs — the packed tarball and nothing
  else, no embedded database on disk, driven against a real PostgreSQL server
  through `pg` — and once through `Filelayer.quickstart()` after explicitly
  installing the optional peer dependency. The assertions are written once and
  run in both. It also asserts that a missing optional peer produces no install
  warning, and that `createTestDb()`'s error names the package and the command.

### Added — testing

- **The live S3/R2 suite now runs in CI.** `test/s3-live.test.ts` has always
  skipped itself without credentials; it now has a job that runs it when the
  repository secrets are present. This is the code path every download goes
  through, and a local harness that verifies signatures cannot speak for TLS,
  real IAM evaluation, R2's divergences from S3, read-after-write visibility or
  the error codes a real store returns.
  - **A fork does not go red.** Secrets are unavailable to pull requests from
    forks, so the job decides for itself whether it has credentials and skips
    the work if not.
  - **The skip is visible.** It is written to the job summary and raised as a
    workflow notice, naming the missing secrets. A green tick that ran nothing
    is worse than an honest "skipped: no credentials", because the two look
    identical. The converse is checked too: credentials present and the suite
    skipping itself anyway is a **failure**, not a pass.
  - **`docs/LIVE-S3-TESTS.md`** is the single place the bucket, the minimal R2
    token / IAM policy and the exact secret names are specified. The test file
    header used to restate them and now points at it.
  - The multipart test (~11 MB of uploads) runs on a nightly schedule and on
    manual dispatch, rather than on every push.
- Fixed while wiring the above: an *empty* `FILELAYER_TEST_S3_PREFIX` — what a
  workflow hands you for an unset repository variable — was taken as a real
  value by `??`, rooting every test key at `/` instead of under the prefix the
  cleanup deletes.

### Fixed

- **A byte range could be sent as `HTTP 200`, which is silent data corruption.**
  `readStream()` and `redeemStream()` accept a byte range and attach
  `Content-Range` when the store serves one, but `sendNodeStream()` and
  `toStreamResponse()` both hardcoded `200`. Anyone following the documented
  advice to wire the `Range` request header themselves emitted a **truncated
  body under a 200** — which every HTTP client treats as the complete
  representation, so it is cached, hashed and handed on with no error anywhere.
  Both writers now derive the status from the delivery: `206` with
  `Content-Range` when a range was served, `200` otherwise. There is deliberately
  no status parameter — there is no value a caller could supply that the writer
  does not already know, and every value they could supply by mistake is wrong.
  Covered by four tests in `test/delivery.test.ts`.

### Added

- **`grant_subject := actor | org | role | link | anonymous`.** A grant's
  subject is a principal set, and `org` / `role` are the missing middle between
  "one person" and "everyone". Two new columns on `file_grant`,
  `subject_org_id` and `subject_min_role`.
  - **Resolution is a join, never a materialization.** Adding or removing an org
    member changes access on the very next request, with no recomputation and no
    write to any grant row. Asserted by fingerprinting every `file_grant` row
    across a join, a leave and a role change.
  - **Cross-org grants inside a project are the point** ("the company that
    posted this job may read this CV"). Cross-**project** ones are
    unrepresentable, by composite foreign key.
  - No custom groups, no nested orgs, no configurable inheritance, no deny
    rules. `subject_min_role` is only a threshold over the existing
    `viewer | member | admin | owner` enum.
- **I6 — subject breadth may not be amplified by delegation.** An issuer whose
  authority is role-derived may mint any subject type; an issuer whose authority
  is grant-derived may mint only `actor` or `link`. Enforced in
  `authorizeShare()` (reason `subject_breadth_amplification`, `403`, audited)
  **and** in the `file_grant_attenuate()` trigger (`grant_subject_amplification`),
  so it binds a caller issuing raw SQL. The trigger now also fires on the subject
  columns, so a delegated grant cannot be widened by a later `UPDATE`.
- `AuthzPath` gains `grant:org` and `grant:role`. Group allows carry `viaOrgId`,
  `viaMinRole` and `viaRole` in the audit context, so a compliance auditor can
  see which membership conferred access.
- `shares.create(fileId, { as, withOrg, minRole })` on the tiered API.
  `withOrg` does **not** auto-provision a tenant: an unknown org is `404`.

### Changed

- `grant_scope_is_live()` takes a fourth argument and gains one term: a grant is
  live only while its **subject org** is live (I2). Deleting an org now kills the
  grants held by its members, as it already killed the grants on its files.
- `file.visibility = 'org'` is **retained**, and is now describable as an
  implicit org grant.

### Fixed

- **`getActorGrants` had no `ORDER BY`, and the delegation parent depended on
  it.** `resolveStanding` attributes an allow to the first returned grant
  carrying the requested capability, and on the share path that grant becomes
  the child's `parent_grant_id` — the ceiling the attenuation trigger measures
  against. With no ordering, Postgres returned heap order, which is undefined
  and moves with page layout, `VACUUM` and row width. A principal holding
  several grants on one file could therefore have `share()` succeed or fail
  depending on physical storage. Fail-closed, never a disclosure, but not a
  semantics anyone could document. Now ordered oldest-first. Found while adding
  the columns above, which was enough to flip it.

### Known, recorded rather than hidden

- `authorizeShare` computes the issuer's held capabilities as the **union** over
  every source, while `parent_grant_id` is a **single** grant. A principal
  holding several grants on one file can therefore be approved for a capability
  set that no one ancestor covers, and the attenuation trigger then refuses the
  insert. The outcome is a `403` rather than a disclosure, so P4 is intact; what
  is wrong is that a legitimate delegation can be refused. Closing it means
  changing the delegation model (pick a covering parent, or mint one child per
  contributing ancestor) and was out of scope for RFC-001.

---

## [0.3.0] — 2026-09-05

The release that makes the package installable, and the one that closes the
last cross-tenant defect.

### Added

- **Compiled output.** The package now ships `dist/` (JavaScript plus `.d.ts`)
  and its `exports` point at it. Previously `exports` pointed at `src/index.ts`,
  which is not importable from an install: Node refuses to strip types from
  files under `node_modules`
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). The package was installable
  and unusable.
- **The TypeScript source and the full test suite ship in the tarball**, so
  every claim in the README is inspectable from what you installed. They cannot
  be *run* from `node_modules` for the reason above; clone the repository.
- `SEMANTICS.md`, `MIGRATIONS.md`, `CHANGELOG.md` and `LICENSE` are in the
  tarball.
- **A transaction abstraction.** `withTransaction()`, `Tx`, and `Queryable`
  gaining an optional `withTransaction` hook. `pg.Pool` is now used through
  `connect()`, so a transaction stays on one connection instead of scattering
  across the pool.
- **Streaming.** `upload()` accepts a `ReadableStream`; the storage interface
  gained `stream()`, `head()` and an optional `list()`; delivery can stream
  rather than buffer. `toStreamResponse()` returns a streaming WHATWG
  `Response`.
- **Byte-range reads** at the storage and delivery API level. The shipped HTTP
  route helpers still do not parse the `Range` request header and never return
  `206`.
- **Redirect delivery** — an opt-in mode that hands out a short-lived presigned
  URL instead of proxying bytes, for deployments that need a CDN. Off by
  default; restricted to anonymous grants unless widened; requires passing a
  verbatim acknowledgement constant, because it trades a bounded revocation
  window for the byte path and that trade must be made deliberately.
- `collectStorageOrphans()` — collection for objects written by an upload whose
  metadata never committed.

### Fixed

- **Cross-project identity collision (HIGH).** `org.external_id` and
  `actor.external_id` were globally unique. In any deployment where more than
  one application shares a database, application B calling `put({ org: 'acme'
  })` did not get an error — it got application A's org id, and the identity
  resolver then added B's user to A's tenant as a `member`. Same shape for
  actors, so `as: 'alice'` resolved across the boundary too. A complete
  cross-tenant compromise reachable from the most ergonomic entry point in the
  library. Fixed by introducing a **project** scope above the tenant and making
  every access-bearing table carry `project_id` under a composite foreign key,
  so a cross-project row is unrepresentable rather than merely unlikely.
  **Breaking schema change — see [`MIGRATIONS.md`](MIGRATIONS.md) entry 1.**
- **A soft-deleted org stopped conferring membership but did not kill
  outstanding grants.** Deleting a tenant removed the owner's access and left a
  contractor's share link serving bytes. Nobody chose that; it was an emergent
  asymmetry between two store methods, found because the set query and the point
  check disagreed. Grant liveness is now a predicate over the whole scope — the
  file, its org, that org's project, the subject actor and the issuing actor —
  evaluated on every request, with no cascading write, so a restore revives
  exactly what the delete killed.
- **`maxDownloads` was charged only on the share-link path.** An actor grant
  carrying `maxDownloads: 3` permitted unlimited direct authenticated reads,
  because nothing on that path touched the counter. The field meant "link
  redemptions" on one path and nothing at all on the other, while being named,
  documented and billed as a download cap. A download is now charged whenever
  bytes leave through a grant, by any principal, on any path. Authority derived
  from an org role is not charged (a role is not a metered credential) and
  metadata reads are not charged (no bytes leave).
- **The audit hash chain could fork under concurrent writers.** It was built
  with a `SELECT` of the last hash followed by an `INSERT`, from application
  code, in two statements — atomic only under a single serialized writer. It is
  now one call to `audit_append()`, which takes `pg_advisory_xact_lock` on the
  chain, reads the predecessor and inserts, inside one statement. The library
  runs that in the same transaction as the mutation it describes, so the lock
  covers both. Caveat stated plainly: the suite runs on PGlite, which has one
  backend, so the test proves the lock is taken on the write path — the
  multi-process argument rests on Postgres advisory-lock semantics.
- **The audit write was not in the same transaction as the thing it audited.**
  `put()` performed five independent statements; a failure after the second left
  a file with no audit record. For a product whose selling point is a
  tamper-evident trail, an intact chain that simply does not mention what
  happened is a hole in the premise.
- **`file.storage_provider` was written as the literal `'memory'` on every
  insert**, regardless of the configured adapter, so a production deployment
  recorded every object as living in an in-process map. It participates in a
  unique index with the key and is therefore half of an object's identity, not a
  label.
- **Unauthenticated audit-chain growth is now bounded.** A caller probing org
  ids can only reach a tenant chain inside a project they are already
  authenticated for; probes at every other id land on the system chain. Still
  requires rate limiting at ingest — denials are audited by design and that is
  not negotiable — but the reach went from "any internet caller, any tenant" to
  "an authenticated customer, their own tenant".

### Changed

- **Breaking:** the schema requires a `project` row. A default project is
  inserted by `schema.sql`, so a single-application deployment needs no project
  vocabulary.
- **Breaking:** `engines.node` is `>=22.18` and enforced.
- **Licensed under Apache-2.0.** `license` was `UNLICENSED` and `LICENSE` was an
  explicit placeholder granting no rights; both are resolved before this version
  is published. `LICENSE` is now the verbatim Apache License 2.0 and ships in
  the tarball alongside a `NOTICE` file, so the grant travels with the package
  rather than only with the repository. See
  [LICENSE](https://github.com/filelayer/filelayer/blob/main/LICENSE) and
  [NOTICE](https://github.com/filelayer/filelayer/blob/main/NOTICE).
- Scratch and diagnostic scripts moved out of the package root into `dev/` and
  are excluded from the tarball. The `package.json` scripts that referenced them
  moved to the repository root.
- Documentation was swept of internal review vocabulary, and a CI check now
  fails the build if it comes back.

### Known limitations at this version

Listed in the README, and repeated here because a changelog that only records
wins is not one: no `Range` responses from the shipped routes; no direct
browser-to-storage upload; org admins can read `private` files; identifiers are
per-project, not per-org; the S3/R2 adapter has never run against live
credentials; orphan collection and ingest rate limiting are jobs you schedule.

---

## [0.2.0] — 2026-09-05

The security rebuild. Twelve defects found by an independent review of the
authorization core plus five found while fixing them. This is the release where
the delivery layer stopped being the developer's problem.

### Fixed — authorization

- **A delegated grant outlived the grant that created it (HIGH).** Revoking a
  grant left everything delegated from it alive, which meant the central claim —
  a URL never outlives its permission — was true only for directly-issued
  grants. Liveness is now evaluated over the whole ancestor chain, in the
  schema, so revocation is transitive at any depth with no cascading write.
- **Capability amplification through `share` (HIGH).** A holder of `read` could
  mint a grant carrying `delete`. Attenuation is now enforced by the
  authorization engine *and* again by a `BEFORE INSERT` trigger, so it binds a
  migration or a `psql` session as well as an API call.
- **Membership management had no authorization and no audit (HIGH).** Anyone who
  could reach the method could change anyone's role. Now: you may not grant a
  role above your own, may not modify anyone who outranks you, may not remove
  the last owner, and every attempt — allowed or denied — is audited.
- **Holding `share` conferred revoke over every grant on the file.** A
  contractor given the ability to share could revoke the owner's grants.
  Narrowed to the grants in your own delegation subtree.
- **A `link` grant could carry `delete`.** A leaked share link could destroy the
  file it pointed at. Share links are read-only by database constraint now.

### Fixed — the audit trail

- **Enumeration left no trace (HIGH).** Decisions that could not be attributed
  to a tenant — a probe against a file id that does not exist, a sweep against
  link secrets — were dropped rather than recorded, which made exactly the
  reconnaissance the log exists to catch invisible. They now go to a system
  chain (`org_id IS NULL`) that no tenant can read.
- **An exhausted download cap was not audited.** "Why did my link stop working"
  was unanswerable from the log.
- **The hash chain did not cover the forensic fields.** The digest covered seven
  columns; `reason`, `grant_id`, `ip`, `user_agent` and `context` — the fields an
  incident responder relies on and an attacker would rewrite — were outside the
  commitment, which made the chain decorative for the questions that matter. The
  digest now covers every forensically relevant column, encoded as canonical
  JSON rather than concatenated, because concatenation lets a forger shift field
  boundaries.
- **A well-formed but unregistered actor id crashed the audit write (HIGH).**
  `audit_event.actor_id` carried a foreign key to `actor`, so a caller
  presenting an unknown-but-valid id could not be audited at all: the insert
  raised, the exception propagated out of `authorize()`, the denial was never
  recorded, and the caller got a 500 where a real stranger gets a 404 — an
  actor-existence oracle and a silent hole in the denial log, at once. The
  foreign key is gone; recording identifiers that do not exist is the audit
  log's job.

### Fixed — the error surface and delivery

- **The error surface was an existence oracle.** Denials are now uniformly 404
  and the evaluation order that makes that true is itself a security property.
- **`Content-Disposition` filenames were interpolated, not encoded** — response
  splitting through an uploaded filename. On one comparison implementation the
  same bug turns every share download of an affected document into a permanent
  500.
- **`upload()` took a bare actor id (HIGH)**, so ownership was forgeable from a
  request body. It takes an authorized principal now.
- **Byte delivery was the developer's problem (HIGH).** `read()` returned a
  `Uint8Array` and the application chose `Content-Type`,
  `Content-Disposition`, `X-Content-Type-Options` and `Cache-Control` — three
  security-sensitive decisions handed back to the developer by a library
  claiming to have removed them, and the example got them wrong. `get()` now
  returns `headers`, computed from the file record, with no option to disable
  them.
- **A credential could be passed in a share-link query string.** Refused with
  `400 credential_in_query`, before any work, without consuming a download.
  Query strings end up in access logs, proxy logs and browser history.

### Added

- **An authorized listing primitive (HIGH — its absence was the defect).** There
  was no way to ask "which files may this caller see?", so building a listing
  screen meant hand-rolling the org filter, the visibility rule, the owner
  check, the role check and a union over the grant table in application SQL.
  `listFiles()` answers it in one query and one audit event, with no filter
  parameter to forget. `test/listing.test.ts` asserts set equality against
  `authorize()` over a randomized corpus on every capability, every run — a set
  query that is too wide *or* too narrow fails the build.
- **File-level `visibility`.** Every member of an org could previously read
  every file in it. Files are now `private` by default — owner and org admins
  only — and org-wide visibility is something the creator asks for.

### Known and reported, not fixed at this version

- `authorize()` is file-scoped, so creation authorization sits outside it.
  Narrowed to a single `authorizeOrg('create_file')` call, not eliminated.
- Unauthenticated callers can append denial events to a known tenant's audit
  chain. Bounded in 0.3.0.
- `maxDownloads` charged only on redemption. Fixed in 0.3.0.
- The audit chain could fork under concurrent writers. Fixed in 0.3.0.
- A soft-deleted org left outstanding grants alive. Fixed in 0.3.0.

---

## [0.1.0] — 2026-09-04

Initial implementation.

- The data model: projects had not been invented yet, so orgs, actors, files,
  memberships, grants and a hash-chained audit log, with tenant isolation
  enforced by composite foreign key rather than by `WHERE` clause.
- The authorization engine: one decision core, reached from a point check.
- The tiered facade — `files`, `orgs`, `shares` — over it.
- `MemoryStorage`, and an S3/R2 adapter that had not been run against anything.
- Share links with expiry, password and download cap.

Every defect in the 0.2.0 list above was present in this version.
