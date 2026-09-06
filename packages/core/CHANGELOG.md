# Changelog

All notable changes to `@filelayer/core`.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning is pre-1.0 and is explained in [`MIGRATIONS.md`](MIGRATIONS.md) §1.

## A note on honesty, before the entries

**No version of this package has been published to npm.** The versions below are
real, dated development milestones in this repository, not registry releases. We
are writing them up as a changelog rather than starting the history at the first
publish because a consumer deciding whether to depend on a `0.x` library is
entitled to know what has already moved underneath it, and because most of the
entries are security defects we found in our own code.

They are described the way we found them, including the ones that were
embarrassing. A changelog that only records features is a marketing document.

`0.3.0` is the version prepared for the first publish.

---

## [Unreleased] — group grant subjects (RFC-001)

Breaking schema change, additive API. Migration: `MIGRATIONS.md` Entry 2.

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
