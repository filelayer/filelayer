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
