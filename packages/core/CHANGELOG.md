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

## [Unreleased]

Two things: **packaging** — the published tarball now has no runtime
dependencies at all — and **group grant subjects** (RFC-001), a breaking schema
change with an additive API whose migration is `MIGRATIONS.md` Entry 2.

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
