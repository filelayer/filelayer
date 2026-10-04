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

## [0.14.0] — 2026-10-04

**Six defects, found by giving the published tarball to an outside analyst and
asking it to describe the package.** It was told to look for what the project
does not advertise. It had no access to this repository and was not told who
wrote the catalog it was filling in. Every one of the six is real and every one
had been green in CI, because the whole family of checks in this repository ran
*beside* the repository rather than inside an install.

### Fixed — the shipped test suite could not run from an install

`test/tiers.test.ts` and `test/vault-example.test.ts` imported
`../../../examples/...`. From `packages/core/test/` that is the repository root
and it resolves. From `node_modules/@filelayer/core/test/` it escapes the
package, so both files threw `ERR_MODULE_NOT_FOUND` and **28 tests — every
example-integration test there is — ran for nobody using the shipped suite**,
which is the only audience a shipped suite has.

The copies under `packages/core/examples/` had the mirror-image defect: they
carried the root's `../../packages/core/src/index.ts` verbatim, which from a
copy one level deeper resolves to `packages/core/packages/core/src/`. Two wrong
paths that cancelled out in the repository and failed together everywhere else.

The tests now import `../examples/`, the copies carry `../../src/`, and
`tools/check-package-copies.mjs` gained a declared single-line rewrite so the
rest of those four files stays verified byte for byte — and fails if the
pattern it rewrites ever disappears, rather than quietly collapsing back into
the byte-identity that shipped this.

### Fixed — four documents were cited by files that ship, and did not ship

`TRUST.md`, `SECURITY.md` and `docs/LIVE-S3-TESTS.md` now ship.
`TRUST.md` is the evidence table, the first thing the README links, and the
page that exists so a sceptical engineer can decline quickly — and it was
reachable only over the network, which fails exactly the reader this project
claims to design for: an install and no browser. `docs/LIVE-S3-TESTS.md` is
named three times by the CHANGELOG and `docs/` ships, so a reader who found
`docs/` in their install went looking and came up empty.

QUICKSTART's three relative links into `architecture/` and
`ARCHITECTURE-PROGRESSIVE.md` are absolute URLs now, because those files do not
ship and are not going to; its link to `SEMANTICS.md`, which does ship, is
rewritten per copy so the offline reader gets the local file.

### Fixed — `verifyAuditChain()` loaded the entire chain into memory

One query, no `LIMIT`, mapped into an array. Two facts the project already
documented make that a hazard rather than a style question: the audit log
**grows without bound** and there is **no retention or trimming**. So peak
memory was linear in a tenant's whole history, on the one call an operator
reaches for when they already suspect something is wrong. The growth was
disclosed; that verification loaded all of it at once was not.

It reads in pages of 2,000 now, carrying the chain hash across the boundary.
Replay is sequential by construction, so the **time** is still linear in the
chain and no amount of paging changes that; what is fixed is the memory, which
is the part that turns a slow answer into no answer.

**One behaviour change, and it is why this is a minor rather than a patch.**
`checked` now counts the events actually verified. On a sound chain that is the
same number as before. On a broken one the old value reported the length of the
whole chain — "I checked 40,000" when it had stopped at the eleventh.
`lastId`/`lastHash` are unchanged in meaning and are now fetched in their own
indexed query, so a failure still reports the real head of the chain rather
than the row the replay stopped on; reporting the break point there would make
an operator comparing a pinned head conclude the log had been truncated when it
had not.

Five tests in `test/audit-resolution.test.ts`, including a tampered row on the
far side of a page boundary, which is the one that fails if the hash does not
carry across.

### Fixed — a line in QUICKSTART §9 said we do not do something we have done since 0.10.0

"**Direct browser → storage upload.** Upload bytes go through your server",
under the heading of what Filelayer does not do. `createUpload()` and
`completeUpload()` shipped on 4 October 2026 in `0.10.0`, and `createUpload`
appeared nowhere else in that document. §9 now describes the feature, its
opt-in acknowledgement, its `maxUploadBytes` requirement and the `FsStorage`
exception.

The same section gained the limitation that was previously stated only in a
comment inside `examples/starter/.env.example`: **plain `upload()` and
`fl.files.put()` impose no size ceiling at all.** `maxUploadBytes` belongs to
the direct-upload config and nothing else, so the limit is whatever your
process can allocate — a 400 MB body took the starter from 85 MB resident to
1.3 GB. That is the kind of thing that becomes a memory-exhaustion incident,
and it was not in the README's limitations list.

### Fixed — the two public fields that bypass the entire engine were not in the limitations list

`fl.store` is a public field and `fl.store.db` reaches the raw query interface.
Every method on `PostgresStore` reads and writes rows with no capability check
and no audit event, which SEMANTICS §10 states — as a constraint on a future
`@filelayer/sdk`, not as a fact about this package's own surface. The analyst
read it as a contradiction between the document and the code. It is not one,
but a careful reader arriving at the wrong conclusion about the authorization
boundary is a documentation defect on its own. README limitation 13 now says it
plainly: any code in your process holding a `Filelayer` can read or change any
tenant's files and leave no trace, the boundary is your process, and
`authorize()` protects it from the outside rather than from the inside.

### Fixed — the README and the website said the suite was 405 tests

It was 526 at the time. Both numbers had been right when written and both were
a month stale, and `check:versions` — the gate whose entire job is this — was
green, because it reads a hand-written list of file-and-pattern pairs and
neither line was on it. **Registration is not coverage.** An allow-list of
claims to check silently exempts every claim nobody thought to add, and it does
so most on the surfaces that accumulate the most prose.

### Added — `check:install-reach`, the gate that would have caught four of the six

`tools/check-install-reach.mjs` packs the package, extracts the tarball, and
resolves every relative import and every document reference **from inside the
extracted directory, with the repository out of reach**. A path that only works
because the checkout is one directory up cannot pass. It runs in `npm run
verify` and in the `shipped-surface` CI job, and its negative control injects
an escaping import and an unshipped link on every invocation.

It found more than the analyst did: six unreachable references rather than
four, and one of the four it cleared (26 `.ts` specifiers in the emitted
`.d.ts` files) is a false positive that TypeScript resolves correctly, verified
by typechecking a consumer against the installed `dist/`.

`check:versions` gained the matching inversion: a sweep that reads every public
surface and fails on any number that *looks* like a whole-suite test count and
is not the real one, with a floor at 100 to separate it from the scoped
subsets, and exceptions by shape rather than by line.

### Where this leaves the method

Five agent-integration runs through October found a revocation failure,
world-readable bytes, an audit blind spot, four misleading documents and the
identity gap. This run found six more, and the reason it could is that it was
given the artifact rather than the repository. Nothing a reviewer with commit
access can see would have found the two escaped import paths, because in the
repository they resolve.

---

## [0.13.1] — 2026-10-04

No library code changed. This release exists because `examples/` ships inside
the tarball, so a correction to the starter only reaches a reader through npm.

### Changed — the starter uses the route it is advertising

`0.13.0` added `{ as }` to `deliveryHandler` so an application holding its own
user ids could mount the library's route for authenticated reads. The starter
shipped in that same tarball still hand-wrote its own:

```ts
const f = await fl.files.get(id, { as: user });
res.writeHead(200, f.headers);
res.end(f.body);
```

Three lines, and every property of the real route missing from them. It read
the whole object into the process before writing a byte, so a 2 GB video was a
2 GB allocation; it ignored `Range`, so a browser could not seek and a resumed
download started over; it answered `GET` and 404'd `HEAD`; and it dropped
redirect delivery, so an S3 deployment proxied bytes it could have handed to
the bucket. `GET /files/:id` is now `fileDownloadRoute` mounted a second time,
with `principal: (req) => ({ as: userOf(req) })`.

**Two status codes moved in the example.** No session is now `404` rather than
`401` -- the route has no concept of a missing header; no session is the
anonymous caller, for whom an unpublished file does not exist. `GET /files` is
new and still answers `401`, because a listing cannot be anonymous at all.

### Added — a listing endpoint in the starter, and the field selection it needs

`GET /files?org=&cursor=` uses `fl.files.list()`. It selects fields rather than
echoing the page, and the comment says why: `FileRecord` carries `storageKey`,
`storageProvider` and `ownerId`, so `json(res, 200, page)` would publish your
bucket layout and a Filelayer-internal uuid to every caller. Neither is a
secret that protects anything -- `authorize()` does that -- but a bucket layout
in a client payload is a gift to anyone enumerating your storage.

### Fixed — `examples/starter/verify.mjs` was a test suite with no runner

It shipped on 3 October 2026 opening with "a claim about this repository is
supposed to be executable", and until today **nothing executed it**. The one
artifact a reader is told to copy was the only one no job touched.

`tools/drive-starter.mjs` (`npm run verify:starter`) packs the package,
installs the tarball into a temporary directory, copies the starter in, boots
it over HTTP against a real PostgreSQL and drives `verify.mjs` against it. It
runs in CI inside the `release-gate` job, reusing that job's Postgres service.
`verify:release` proves the library works from an empty directory; this proves
the example does, which is where route mounting, status codes, `Range`,
streaming and the fall-through order between the library's routes and an
application's own are exercised. Three of October's defects were in exactly
that layer.

Calibrated rather than assumed: the harness was run against three deliberate
breaks (a principal that drops the session, a listing that echoes the page
whole, a server that throws on boot) and each one turned it red. 25 checks,
0 failures against the published `0.13.0` tarball.

---

## [0.13.0] — 2026-10-04

**Your own identifiers now reach the whole API, including the HTTP routes.**
Nothing is removed and nothing changes shape; three things were missing and one
of them made the library's own route unmountable.

### Added — `fl.files.list({ as, org })`

The facade had no listing. `fl.listFiles(principal, orgId, …)` on the core API
takes an internal actor uuid and an internal org uuid, so a listing screen — the
most ordinary screen in a file product — was the one feature that forced you out
of the facade and into managing Filelayer's internal identifiers by hand.

Worse: it was **impossible** for any identity the library auto-provisioned.
`put({ owner: 'alice' })` registers `alice` itself, so the application never saw
an internal id for her, and no public call returned one.

```ts
const page = await fl.files.list({ as: 'user_123', org: 'acme', limit: 50 });
```

Same engine, same `listFiles`/`authorize()` set-equality guarantee. It uses
`requireOrg` rather than the get-or-create resolver, so a mistyped tenant is a
`404` rather than a new tenant created by a read.

### Added — `deliveryHandler`'s principal takes `{ as }`

```ts
deliveryHandler(fl, { principal: (req) => ({ as: yourUserId(req) }) })
```

The callback had to return `Principal.actorId`, an internal uuid. **So the
library's own HTTP route for authenticated reads could not be mounted** by an
application holding its own user ids — and the snippet in `QUICKSTART` §6 passed
`yourSession(req).userId` straight into `actorId`, which could not have worked.
`examples/vault/server.ts` sidesteps it by taking the uuid in a header, which is
not an answer for a real application.

An `as` this project has never seen is a `404` and the attempt is **recorded**,
never a silent downgrade to anonymous — that would turn a typo in a session
lookup into a read of every published file. `{ as: null }` is an explicitly
anonymous caller. The `Principal` form is unchanged and is still right when you
hold an internal id or want `ip`/`userAgent` in the audit log.

### Added — `fl.ids`, the escape hatch, documented rather than secret

`fl.ids.actorId(external)` and `fl.ids.orgId(external)` return the internal uuid
or `null` and create nothing. `fl.ids.ensureActor(external)` creates if absent
and is **idempotent** — unlike the core `createActor()`, which is a bare insert
and throws on a second call, which is why it was the wrong thing to build an id
cache on.

Withholding this protected nothing. These are in-process calls resolving ids you
chose, in a database you own, and P2 says the internal uuid is not an input to
any decision — the same reason a file id is safe in a URL. What stops a caller
reading somebody else's file is `authorize()`, not the obscurity of a primary
key. Prefer not to need it: the two additions above exist so the common cases
do not.

### How the gap was found, and how big it was

Four integration tasks were given to agents holding only the published `0.12.0`
tarball — no repository, no access to this codebase. **Three of the four hit
this**, and all three invented the same workaround: a `Map` from their user id to
an internal one, filled by harvesting values out of `FileRecord.ownerId` and
`GrantSummary.subjectId`, the only two places the public API let an internal id
escape. One stated the consequence exactly, which is the sentence that made this
release: *"a listing screen for anyone who is not a file's owner is impossible
unless you called `fl.createActor()` for that user yourself and kept the row."*

### Fixed — one query in two places under two names

`requireOrg` and `requireOrgId`, identical bodies on two different classes,
which is how a duplication survives a search for one of them. Both delegate to
`Identities.requireOrg` now. One copy is one place to get the project scoping
wrong, and a mutation dropping the project filter from the surviving copy
reached the suite before `fl.ids.orgId`'s project test existed.

---

## [0.12.0] — 2026-10-04

Two security fixes and four documents that were sending readers the wrong way.
Every one of them was found the same way, and not by a review: four integration
tasks were handed to agents that had **only the published `0.11.0` tarball** —
no repository, no access to this codebase — and what they got stuck on was read
as the deliverable. Each finding below was then reproduced here before it was
fixed.

> ### ⚠️ If you run `FsStorage` on `0.11.0` or earlier, fix the permissions
>
> The data directory was created `0755` and objects `0644`. On a shared host
> that is **a public bucket on local disk**: object keys are `orgId/fileId` and
> are explicitly not secrets, so any local user could read every tenant's files.
>
> ```bash
> chmod -R go-rwx /path/to/your/filelayer-data
> ```
>
> No advisory: it needs local shell access on the machine running your
> application, and no deployments are known. But it is a one-line fix and
> leaving it undone costs you the privacy of every file.

### Fixed — `FsStorage` wrote world-readable bytes

Directories are now `0700` and objects `0600`, and the mode is set explicitly
rather than left to `mkdir`'s argument, which the umask masks.

**It only ever removes bits.** The first version chmod'd each level to a flat
`0700`, which tightened `0755` correctly and also **widened** anything
stricter — a test that locks a directory to `0500` to prove a failed write
leaves the previous object intact started passing the write instead, because the
library had silently re-granted itself permission an operator had deliberately
removed. The mode is now `current & 0o700`: group and other lose everything, the
owner keeps exactly what was set.

QUICKSTART §7 calls confirming the bucket is private "the one security-sensitive
decision Filelayer cannot make for you" and gives concrete R2 and S3
instructions. It said nothing for `FsStorage` — the adapter recommended for a
single node and the one `examples/starter/` defaults to. It does now, and notes
the one part that is still yours: who **owns** the directory.

### Fixed — the facade did not audit an unknown identifier

Six places resolved `as:` and threw `404 unknown_actor` before the engine ran,
so **nothing was recorded**. The same refusal through the core API writes an
event. Measured on the published `0.11.0`:

```
facade, unknown external id  -> 404 unknown_actor   deny events 0 -> 0
core, well-formed actor uuid -> 404 no_membership   deny events 0 -> 1
```

`schema.sql` says, in a comment on the very column that makes the fix possible,
that `audit_event.actor_id` carries no foreign key **precisely** so a caller
presenting an unregistered id is still recorded, and calls the alternative "a
serious defect in two directions at once". The engine honours that. The
facade — the surface everybody uses — reopened the hole one level up, in the id
space an attacker actually sweeps, because it is the one they can guess. An
unknown **org** name was equally invisible; both are recorded now.

The event goes to the system chain (no tenant can be confirmed without building
a tenant oracle), keeps `unknown_actor` as its reason rather than degrading to
`no_membership`, and carries the presented id in `context`, truncated. The
response is unchanged: still an opaque `404`.

### Fixed — four documents that sent readers the wrong way

Worse than a gap, because a gap makes you look while an instruction makes you
act:

- **`llms.txt` said `put({ owner })` auto-registers that user as a member.**
  False since `0.6.0` for an org that already exists: it is `403
  no_membership`. The agent building a multi-tenant integration hit it, and
  nothing in the package explained it — the behaviour change is in the
  changelog and in a source comment, and the two documents an agent reads first
  were never updated.
- **Three places said direct upload was S3/R2-only and `FsStorage` "cannot
  sign".** False since `0.10.0`. The agent asked to build a browser upload
  nearly reported the task impossible, because the guide `llms.txt` points at
  says it cannot be done.
- **`examples/starter/` mounted the anonymous route at `/public` and advertised
  `GET /public/:id`**, while `publicUrl()` builds `/f` unconditionally. The
  example got away with it only because it never called `publish()`; the moment
  you do, the URL the library hands your user 404s against your own server. The
  example now agrees with the library.
- **QUICKSTART said "two operational jobs are yours to schedule."** There are
  four, and the list now also names the thing no job reclaims: an expired file
  keeps its row, the row keeps referencing its key, and `collectStorageOrphans()`
  skips any key a row references — so expired bytes are paid for indefinitely
  unless you sweep them yourself.

### Still open, recorded rather than fixed

The same exercise named two gaps that are design work rather than patches, and
they are in the README limitations:

- **No public resolver from an external id to an internal `actorId`**, while
  `deliveryHandler`'s `principal` callback requires one. Our own authenticated
  read route cannot be mounted without harvesting ids from `FileRecord.ownerId`
  and `GrantSummary.subjectId`. `createActor()` is a bare insert and throws on a
  second call, so an auto-provisioned identity's id cannot be recovered at all.
- **"Send these headers verbatim" is unimplementable in a browser** for
  `content-length`: it is a forbidden header name and `fetch` computes it. The
  pin still holds, because the computed value is the honest one, but the
  instruction as written cannot be followed by the client the feature exists
  for.

---

## [0.11.0] — 2026-10-04

> ### ⚠️ Read this if you are on `0.10.0` or earlier and you share files with named users
>
> **`shares.revoke(grantId)` could report success and leave the person's access
> working.** If your share endpoint ever ran twice for the same file and the same
> recipient — a double-clicked button, a retry after a timeout, a sync job — then
> two live grants existed and revoking the id you were holding left the other
> one. The owner was told the revocation succeeded. The recipient kept reading.
>
> **Upgrade and use `shares.unshare(fileId, { as, user })`** to remove a named
> user's access. To audit what you already have:
>
> ```sql
> SELECT file_id, subject_id, count(*)
>   FROM file_grant
>  WHERE subject_type = 'actor' AND revoked_at IS NULL
>  GROUP BY file_id, subject_id HAVING count(*) > 1;
> ```
>
> Any row there is a file where a single `revoke()` would not have been enough.
> There is no advisory: it needs the `share` capability, it affects one reader at
> a time, and it reverses the moment the duplicates are revoked. It is here
> rather than in a GHSA because it is a defect in the shape of our API, not an
> attack somebody can mount.

### Fixed — a grant id is not a person's access

`share()` is not idempotent: every call inserts a grant row. `revoke(grantId)`
revokes exactly one row. Both are right in isolation and the combination lost
the property this library is sold on, because the natural implementation of a
share endpoint — keep the id the last call returned, revoke that — leaves the
earlier grant live. Two calls also doubled an effective `maxDownloads: 3` into
six deliveries.

**`Filelayer.revokeFor(principal, fileId, subject)`** and
**`shares.unshare(fileId, { as, user })`** revoke every live grant naming that
subject, in ONE transaction. All-or-nothing: a partial unshare is the same
defect in a smaller form. Idempotent, so a retry is safe, and an unknown user is
`{ revoked: 0 }` rather than a 404, which would have made it an identity oracle.

`unpublish()` now delegates to it. **That is the embarrassing part**: `unpublish`
had done exactly this for anonymous grants since the beginning — list, revoke
every live one, return a count. The plural was understood for the one subject
type that has no id to hand back. For a named user the id became the interface
and the plural stopped being considered, for eight releases.

**`revoke(grantId)` is unchanged**, and is still correct for a share link whose
secret you handed out. The README's headline example used to teach it for a
named user; it now shows `unshare` for that case.

### Fixed — a spent grant reported `no_membership`

`getActorGrants` reads `live_grant`, so an exhausted, expired or revoked actor
grant was invisible to the engine and the refusal got attributed to the
fallback: `insufficient_role`, or `no_membership` for a recipient who never was
a member. **That reason is what reached the audit log**, so a compliance reader
asking why access was refused was told the person was not in the org — true, and
not the reason.

The deny path now consults dead grants and classifies them with
`deadGrantReason`, which the link path has always used. One extra query, on the
deny path only. The response is unchanged — still an opaque `404 not_found`,
because the reason must not become an oracle.

### How both were found

Not by a review. By handing an integration task to an agent that had **only the
published `0.10.0` tarball** — no repository, no access to this codebase,
nothing but what `npm install` provides — and reading what it got stuck on. It
grepped for `idempot`, found that `orgs.create` and `completeUpload` are
documented as idempotent and `share` is not mentioned either way, wrote a probe,
and reported `BOB STILL READS AFTER REVOKING s2`.

That is now how this project looks for defects in the shape of its own API,
because the people and agents who will hit them have exactly that much context
and no more.

### Added — a concurrent measurement, which found the other half

`npm run bench:load`, and
[`benchmark/load/RESULTS.md`](https://github.com/filelayer/filelayer/blob/main/benchmark/load/RESULTS.md).
The first concurrent measurement in this repository, against a real native
PostgreSQL with a real pool. It tests four claims `src/` already made about
itself; one was true, one was unconfirmed and had been stated as a property, and
one was false in a way nothing had noticed:

- **The cost of an authorized read is linear in the live grants that subject
  holds on that file**: 4.3 ms at five, 55 ms at a thousand, 5.9 s at a hundred
  thousand, while an owner read stays at 2.3 ms. `live_grant` evaluates
  `grant_is_live(id)` — a recursive function declared `COST 100` — once per
  matching row, and nothing bounds the row count. Not fixed in this release;
  `unshare` gives you the tool to keep the number small, and the README
  limitation says so.
- **The predicted write hotspot on a shared anonymous grant row did not
  appear** up to concurrency 64. The comment in `#reserve` asserted it as a
  property and now says "predicted and unconfirmed".
- **Table size does not matter**: 100 to 100 000 grants costs a read 3–8%.

And the harness got it wrong first, which is recorded in `RESULTS.md` rather
than quietly fixed: it bulk-inserted without `ANALYZE` and reported a read going
from 12 ms to 6 seconds, which was 12.6× of stale planner statistics and would
have been a false architectural finding. `MIGRATIONS.md` now says to run
`ANALYZE file_grant` after any bulk grant load, because that part is a real
operational hazard.

---

## [0.10.0] — 2026-10-04

Three capabilities and four defects. Two of the defects were found by the work
on the capabilities rather than by a review, and one was found by a test
asserting the wrong status code for the right reason.

**If you query `usage_daily`, read the metering entry below before upgrading**:
`bytes_egressed` and `bytes_stored` both change meaning, and
[`MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md)
Entry 8 has the schema SQL and the one behaviour change outside it.

### Added — pre-authorized direct browser upload. Opt-in, S3/R2 only

`createUpload()` authorizes the caller, reserves a `pending` file row, and
returns a presigned PUT the browser uses directly. `completeUpload()` asks the
object store what actually arrived and promotes the row to `ready`.
`collectUploadReservations()` reclaims the ones nobody redeemed.

Requires the verbatim `DIRECT_UPLOAD_ACKNOWLEDGEMENT` and a `maxUploadBytes` you
choose, because the thing being accepted is not obvious from the feature's name:
with direct upload the DECISION still happens here, but the BYTES do not, so
Filelayer can no longer measure them or reject them on content.

**The size is signed into the credential, which is the part the usual answer
gets wrong.** `content-length` and `content-type` go in
`X-Amz-SignedHeaders`, so SigV4 covers their values and the store recomputes the
signature from the headers it received. A client issued a URL for 204,800 bytes
and sending three gigabytes produces a different signature and a 403 with
nothing stored.

**Verified against live AWS S3**, not only against our own harness: the harness
builds the canonical request the same way the adapter does, so agreement between
those two would have proved nothing. CI run 74, in the live AWS lane,
`a presigned PUT with a signed content-length is enforced by the real store`
passing, with a 64 KB body against a URL signed for 20 bytes refused 403 and the
object left at its honest length. The live per-commit count goes from 11 to 12.

**Not presigned POST**, which is what the write-ups recommend and what our own
guide recommended: **Cloudflare R2 does not implement it**, and R2 is the
documented default store. The signed-header pin is stricter anyway — an exact
value rather than a range.

**`pending` is what makes the reversed ordering safe.** Everywhere else this
library writes bytes before it commits a row, so that a crash leaves an
unreferenced object rather than a row pointing at nothing. A reservation cannot
do that: the bytes arrive later, from someone else. It is safe because
`lifecycleDenial()` has refused `read` on a `pending` file since the schema was
written, so a reservation whose bytes never arrive is invisible rather than
broken. It is visible in a `write`-authorized listing, which is how an
application shows an upload in progress.

**The collector deletes the ROW first, atomically, and the object only for a row
it removed.** The dangerous interleaving is: deadline passes, the job selects the
reservation, the client completes at the last moment, the job deletes the
object — a `ready` file with no bytes. So `completeUpload()` refuses a
reservation past its deadline, the collector's grace period is floored at 60
seconds, and the DELETE repeats `state = 'pending'`. It hard-deletes rather than
soft-deletes: a tombstone still references its key, so `collectStorageOrphans()`
would skip it forever and any late bytes would be billed indefinitely.

Also: one `head()` on completion rather than trusting the client, a
`upload_size_mismatch` refusal whose only job is to catch a store that verifies
less than it claims to, and metering at completion so a reservation nobody
redeems is never billed.

### Added: the same upload shape on `FsStorage`, labelled `via: 'server'`

`new FsStorage(root, { upload: { baseUrl, secret } })` makes `presignPut`
available, minting an HMAC token for `localUploadRoute()`, which you mount. The
client code is then identical in development and in production (one signed URL,
one PUT, the same `createUpload()`/`completeUpload()` pair), which is the point:
the part a developer is most likely to get wrong is the browser-side request,
and it could not be exercised at all without a bucket.

**`PresignedUpload.via` is `'server'` on this adapter and `'storage'` on S3/R2,
and that field is why this is honest rather than merely convenient.** The bytes
go through your process here, exactly as `upload()`'s do. Returning something
that only looked like an object-store URL would let somebody build against it in
development, conclude their server was out of the data path, and deploy on that
belief.

`presignPut` is assigned in the constructor rather than declared as a method, so
an unconfigured instance does not have it and `canPresignPut()` honestly reports
false. That is the shape `presignGet`'s optionality already has. The secret is
refused below 32 characters and the base URL must be absolute, because a public
write endpoint whose only protection is an HMAC is not a place for a key
somebody set to `dev`.

**A defect found by a test asserting the wrong status code for the right
reason.** The route bounded its body read with the `size` out of the raw query
string and verified the signature afterwards. A stranger holding no valid token
could therefore name a large size and make the server buffer that much before
anything checked whether they were allowed to, repeatedly. The token is now
proved first, from the query string alone, and the verified size is the only
size the handler will read to.

Still missing: resumable and multipart direct upload (one PUT is one object) and
`starts-with` policy conditions.

### Fixed — upload bytes were counted as egress, and `bytes_stored` was always zero

`recordUsage()` put every caller's bytes in `usage_daily.bytes_egressed`,
including an upload's. So the column whose name means "bytes we sent out and paid
a transfer charge on" was incremented by bytes arriving, and `bytes_stored` —
in `schema.sql` since the beginning — was written by nothing and was zero for
every org on every day.

The two fail in opposite directions, which is what makes it worth a changelog
entry rather than a one-line fix: stores charge for stored bytes per month and
egressed bytes per transfer, at different rates. A table that reports one too
high and the other as nothing cannot answer the question it exists to answer.

Found while adding the second write-path caller. Nothing reads either column
yet, which is why it survived: a number nobody has looked at is
indistinguishable from a right one. If you query them, see `MIGRATIONS.md`
Entry 8 — historical rows are not rewritten, so a series spanning the upgrade
counts uploads as egress before it and as storage after.

### Changed — the private-uploads guide no longer says we are not the answer

It said Filelayer does not do direct browser-to-storage upload and pointed the
reader at the AWS SDK. That became false with this release, so it was rewritten —
but the useful half went the other way: the guide now documents **signing
`content-length` into a presigned PUT**, which we went looking for only because
R2 left us no presigned POST, and which we could not find written down anywhere.
It works with the AWS SDK and no Filelayer, which is the test every section in
those guides has to pass.

One sentence in it was also wrong: "you can include `Content-Length` as a signed
header, and S3 still does not enforce it server-side for a `PUT`". That is true
of a length passed to a signer that does not put it in `X-Amz-SignedHeaders`,
and false once it does. The new live-AWS test is what settles it.

### Added — `Range` requests, answered by the shipped routes

Everything below the route layer already handled byte ranges: all three storage
adapters took a `ByteRange`, `assertRange()` validated it, and
`sendNodeStream()` / `toStreamResponse()` already derived `206` from the
presence of `Content-Range`. Nothing read the `Range` *request* header, so the
whole capability was unreachable over HTTP — and because it was unreachable, two
defects had been sitting in it untested.

`fileDownloadRoute()`, `shareDownloadRoute()` and therefore `deliveryHandler()`
now parse `Range`. `parseRangeHeader()` is exported for anyone writing their own
route. Supported: `bytes=0-499`, `bytes=500-`, and `bytes=-500` — the suffix
form, which is what a PDF reader sends first to find the cross-reference table
at the end of a document.

**The suffix form costs one `head()` on the object, and resolving it any other
way would have been a bug.** "The last 500 bytes" is not a byte range until
something says how long the object is, and the only authority on that is the
object store. Resolving it from the `size_bytes` column — which this codebase
already distrusts two lines away, for `Content-Length` — would serve the *wrong
bytes*, offset by whatever the disagreement was, under a `Content-Range`
asserting they were the last 500.

### Fixed — an unsatisfiable range was a `404`

Every adapter returns `null` for two different things: "no such object", and "a
range that starts past the end" (`FsStorage` and `MemoryStorage` when
`start > end`; `S3Storage` by mapping the store's own `416`). The delivery layer
collapsed both into `404`.

So a caller who **was authorized to read the file** was told it did not exist.
That inverts what the uniform `404` is for: it exists to keep a tenant from
enumerating files they have no standing for, not to lie to the owner. It is now
a `416` carrying `Content-Range: bytes */<size>` — the field that tells a client
the size it was guessing at, which is the whole reason it asked past the end.

Disambiguated with a `head()` on the error path only, so an ordinary delivery
costs nothing extra. `head` is already mandatory on `StorageAdapter`, so no
third-party adapter has to change.

### Fixed — `Accept-Ranges` was sent only where it was useless

It was attached to ranged responses, which is the one response a client no
longer needs it on. A client discovers range support from the **unranged
`200`** — that is what a video player, a PDF reader or a resuming downloader
reads before deciding whether it can seek. Advertising support only after the
client had already worked it out is the same as not advertising it. It is now on
every proxied response.

### Changed — a download cap now takes precedence over a byte range

A capped grant and byte ranges cannot both keep their meaning, and this is the
decision [`architecture/TIER5-DESIGN-NOTE.md`](https://github.com/filelayer/filelayer/blob/main/architecture/TIER5-DESIGN-NOTE.md)
said would have to be made before ranges could ship. It is neither of the two
options it framed:

- Charging a download per ranged request makes `maxDownloads: 3` mean "three
  seeks" — a cap that is enforced and does not mean what it says, which is the
  exact defect `maxDownloads` was already fixed for in `0.7.0`.
- Not charging them lets ranges bypass the cap outright: a recipient reassembles
  the whole object for free.

So the **range** gives way, not the counter. When a cap binds, the range is
dropped, the whole object is served under a `200`, and `Accept-Ranges: none`
says so — RFC 9110 permits a server to ignore `Range`, and it is the only option
that leaves the client with a working file and the cap with its stated meaning.
A client that is told `none` stops asking rather than retrying into the same
silent widening.

### Still not supported, deliberately

- **Multiple ranges in one request.** `bytes=0-9,20-29` is ignored and the whole
  object is served under a `200`. Answering one of several under a `206` is
  indistinguishable, from the client's side, from an answer to a different
  question, so it stitches the reply in at the wrong offset.
  `multipart/byteranges` is a response format nothing here produces.
- **`If-Range`.** Not parsed. That is safe *here* only because an object key is
  a fresh UUID that is never rewritten, so the representation cannot change
  under a resuming client. It would not be safe in a system with mutable keys.

### Added — `FilelayerError.headers`, and a precedence that is now testable

A `416` without `Content-Range` is half an answer, and the error type had no way
to carry a header. `errorHeaders(extra?)` takes the merge and puts `extra`
*first*, so the security headers win: the channel can add `Content-Range` and
cannot remove `nosniff`. Both parameters are optional, so neither addition
breaks an existing caller.

### Added — `docs/guides/`, starting with the one whose usual answer is wrong

A search for the problem this library exists to solve returns Multer tutorials
and a composed answer that says "write a table, make an IAM user, use presigned
URLs". That is the incumbent, and it wins unopposed because nothing better is
reachable. The guides are the attempt to be reachable, and the rule for them is
that they have to be useful to a reader who never installs this.

The first one is [expiring and revocable file
links](https://github.com/filelayer/filelayer/blob/main/docs/guides/expiring-and-revocable-file-links.md).
It was chosen because the common answer is not merely incomplete, it is wrong: a
presigned URL **cannot be revoked individually**. You can delete the object,
change the bucket policy, or deactivate the credential — which kills every URL
that credential ever signed. AWS says so; the guide cites it.

It gives the schema, the four real options with what each costs, the HTTP
headers people leave out, and the one query that is easy to write wrong. The
measurements in it are not assertions: `expiring-and-revocable-file-links.proof.mjs`
ships beside it, starts a real PostgreSQL as an ordinary user process, and
reproduces all four in about twenty seconds.

What it measured, against two real backends with a cap of one:

| | Served | Counter |
|---|---|---|
| read-decide-write, no `CHECK` | **2** | 2 |
| read-decide-write, with the `CHECK` | 1 | 1, the loser gets SQLSTATE `23514` |
| one `UPDATE ... WHERE ... RETURNING` | 1 | 1 |
| the same, under `REPEATABLE READ` | 1 | 1, the loser gets `40001` and must retry |

The last two rows are why the guide exists in this form: the right answer is one
statement, the constraint is a backstop rather than a fix, and the isolation
level changes which of those two things happens to you.

The TypeScript block in the guide is executed by `npm run check:docs` on every
commit, so if revocation stopped taking effect on the next request the page would
fail the build rather than quietly become untrue. `llms.txt` names the guides,
and they ship in the tarball, so an agent with an install and no browser has
them on disk.

### Added — the second guide: private file uploads

The question is "how do I let users upload files privately", and the usual
answer — private bucket, presigned URL, credentials stay on the server — is
correct as far as it goes. The tutorials get that part right and the guide says
so.

What they leave out is that **a presigned PUT does not constrain the body**. A
URL issued for a 200 KB avatar accepts three gigabytes, up to the 5 GB
single-`PUT` ceiling, and signing `Content-Length` does not help: S3 does not
enforce it server-side for a `PUT`. What you published is an authenticated,
unmetered write into a bucket you pay for. The fix is a presigned **POST** with
a policy, where `content-length-range` is evaluated before the object exists.
Almost none of the tutorials that teach "secure uploads" teach that one.

Then the three traps in the order they bite: the declared content type is
attacker-controlled and becomes stored XSS if you serve it inline from your own
origin; the object key is not access control, however long it is; and the upload
happening outside your transaction leaves orphan objects, rows without bytes, and
replayable callbacks.

**This is the guide where Filelayer is not the answer to the main question.** We
do not do direct browser-to-storage uploads, deliberately, and the guide says to
use the SDK with the policy above instead. A guide that only ever concludes "use
us" is an advertisement, and nothing cites an advertisement.

The executable block in it asserts the two things we do claim: the content type
is decided from the magic bytes rather than from what the client declared, and
`nosniff` plus `attachment` are on the read path and not optional.

### Added — the third guide, and `docs/guides/` becomes a destination

"How do I do multi-tenant file access control?" The usual answer — `tenant_id`,
Row-Level Security, a session variable per request, `FORCE ROW LEVEL SECURITY`,
no `BYPASSRLS` on the application role, composite indexes — is good, and the
guide says so rather than inventing a weakness.

It argues with the conclusion people draw from it. **RLS decides which rows a
session may SEE. It does not decide which rows may EXIST.** Measured against a
real PostgreSQL:

| | |
|---|---|
| A tenant reads its own files only | isolated, as advertised |
| The same session writes a grant joining another tenant's FILE to its own ORG | **`INSERTED`** |
| The same write with `FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id)` | `REFUSED` 23503 |
| The same write from a role with `BYPASSRLS` and no tenant variable | reads all rows, still `REFUSED` 23503 |

Both policies are satisfied by that second row, and correctly: its `org_id` *is*
the session's tenant. RLS compared the row to the session; nothing compared the
row to the file it points at. The composite foreign key does, in standard SQL,
with no trigger and no extension — and it holds where a policy cannot, because a
policy is advice to a session and a constraint is a property of the data.

The guide also covers the second thing files have that ordinary rows do not: the
bytes are in a bucket, where none of your policies run.

`docs/guides/README.md` is now the index, with the rule these pages are written
to: a guide has to be useful to somebody who never installs this, the code in it
is executed on every commit, and where it states a number a script beside it
reproduces that number.

### Fixed — four findings from the content audit that were left open

The audit of 4 October produced forty-six findings and the commits that followed
applied most of them. These four were not, and three of them are the kind that
sit quietly.

**`SECURITY.md` had no row for `0.5.x`, and pointed the advisory at the release
that fixed it.** The supported-versions table ran `0.6.x` … `< 0.5`, so a user on
`0.5.3` found no row describing their version at all — and the one row carrying
`GHSA-835c-wg3v-pv7q` was `0.6.x`, which is the release where the remote
unauthenticated denial of service and the tenant takeover were *fixed*. Exactly
backwards, on the page somebody reads when they are deciding whether they are
exposed. The table now says `0.5.x and earlier — No, and vulnerable`, names both
defects, and says upgrade rather than patch.

**`MIGRATIONS.md` stopped at Entry 6** (`0.6.0` → `0.7.0`) while the package was
`0.9.0`, and §1 promises an entry per MINOR. The schema coverage was in fact
complete — `schema.sql` is untouched since the `0.7.0` commit — but nowhere said
so, and an absent entry looks the same as a missing one to a reader deciding
whether they are behind. Entry 7 now states that a database on the `0.7.0`
schema runs `0.9.0` unaltered, and records the one call-site change: matching on
SQLSTATE `23514` or on the constraint name must become matching on
`link_is_read_only`.

**A QUICKSTART sample called `yourRouter`**, which is defined nowhere in the
document. The block is marked skip, so `check:docs` never executed it; pasted as
written it is a `ReferenceError`. Commented out, with the fall-through it was
illustrating left in words.

**`ARCHITECTURE-PROGRESSIVE.md` §4.2 printed stale LOC numbers.** The block is
presented as the output of `npm run loc:tiers`; the command now prints 56 / 61 /
44 / 216 against the documented 55 / 58 / 44 / 208. The prose around it is
unaffected — `net`, `imports`, `boot` and `core` all still match — which is
precisely why nobody noticed.

### Added — the fourth guide: deleting files and orphaned objects

Chosen on evidence rather than taste. A search-visibility measurement taken the
same day showed that narrow, technical phrasings land closer to our territory
than broad category questions, so this one is as narrow as the set gets.

The well-covered answer — Postgres and S3 do not share a transaction, run a
sweeper — is right, and the guide credits it. What it adds is the two things
after it.

**Which delete goes first.** Object-then-row leaves a row pointing at nothing,
which every read turns into an error and which cannot be repaired because the
bytes are gone. Row-then-object leaves an orphan, which costs money and is
reclaimable. Fail in the direction you can recover from.

**The sweeper deletes on the strength of an absence**, and a partial answer is
indistinguishable from one. Measured, with the same short listing fed to both
natural shapes of the job:

| | |
|---|---|
| storage-driven ("for each OBJECT, is there a row?") | deletes nothing, hides every orphan |
| DB-driven ("for each ROW, is the object there?") | **three live files erased**, job reports success |

Same bug, opposite catastrophe, depending on which way the loop runs. That
framing came out of running both; it was not what the guide set out to say.

`catch { return [] }` is how it reaches production, because it looks defensive.
The guide notes that a storage adapter in this repository did exactly that for a
directory it could not read, and that a review caught it rather than a test.

Also measured: an upload in flight is indistinguishable from an orphan, and a
sweeper without a grace period deletes a file while the user is creating it.

The guarded version — a listing that reports completeness, errors that
propagate, and a grace period — refuses all three broken inputs and loses
nothing.

### Changed — the homepage no longer leads with the numbers sitting at zero

The trust section opened on a table whose second, third and fourth rows were
`0 production deployments`, `1 maintainer` and `no independent security review`
— before the page had finished making its case. That is an ordering problem
rather than an honesty one, and it is fixed by ordering.

The homepage now carries the figures a job produces on every commit, and points
at [TRUST.md](https://github.com/filelayer/filelayer/blob/main/TRUST.md) for the complete set, naming the rows it does not
show. TRUST.md is unchanged and still carries every row including the zeros,
because that page exists to be the one a sceptic reads.

What did NOT change, and would not have: the alpha banner and the
schema-may-change warning, and the precondition that Filelayer cannot make your
bucket private. Those two are not candour, they are the difference between a
reader who knows what they are taking on and a reader who finds out during an
incident.

### Fixed — a content audit of every public surface, and what it found

Three audits over README, TRUST, SECURITY, CONTRIBUTING, QUICKSTART, SEMANTICS,
MIGRATIONS, LIVE-S3-TESTS, ARCHITECTURE-PROGRESSIVE, TIER5, llms.txt, the
homepage and the OpenAPI generator. Every finding below carries the file and
line in the code that contradicted the sentence; several were settled by
executing the behaviour rather than reading it.

**Claims that were simply false.**

- `SECURITY.md` — "The S3/R2 storage adapter has never been executed against
  live AWS or Cloudflare credentials." False in both halves since 30 September
  and 3 October respectively, on the page a reviewer reads first.
- `ARCHITECTURE-PROGRESSIVE.md` §5 — the same claim, in a list whose own header
  says every item was re-checked against 0.9.0.
- `SEMANTICS.md` — "a hard org delete destroys that tenant's chain". Executed:
  `DELETE FROM org` fails its own referential-integrity check, because
  `audit_no_delete` rewrites the cascade to nothing. The org and its chain
  survive. `MIGRATIONS.md` had it right; SEMANTICS did not.
- `SEMANTICS.md` — `404 insufficient_role` listed as what a caller sees.
  `toPublicError()` has no case for it; the response is `404 not_found` and
  `insufficient_role` is the internal reason. A reader branching on `e.code`
  never matched.
- The homepage — "A signed URL is re-validated on every request". The default
  URL is not signed at all (`/f/<id>`, an opaque id), and the one URL Filelayer
  does sign is the presigned redirect, which is the opposite of re-validated.
  The true claim is stronger: every request is re-authorized.
- `TIER5-DESIGN-NOTE.md` — "no multipart and no resumable upload", while
  `S3Storage.putStream` has used S3 multipart above the part threshold all
  along, and a live test uploads 11 MB through it. The same file named the
  multipart path as the thing that had to change, two paragraphs earlier.
- `TRUST.md` — listed "the storage adapter proven against live R2 and S3" as an
  outstanding requirement, twelve rows below the two rows saying it was done.
- `web/README.md` — said `og.png` does not exist. It has existed since the
  commit that introduced the sentence, and `check-web.mjs` fails without it.

**Counts that had drifted.** README's runnable block said 330 tests (405).
TRUST said 405 run on Node 22/24/26 (397 do; the eight contention tests need a
real PostgreSQL). TRUST's prose said twelve live-storage tests per commit while
its own table said eleven. MIGRATIONS said nine performance tests (ten). The
homepage said `v0.7.0` in the eyebrow and the alpha banner, and `375 tests
across 94 suites` in the prose, while the trust table beneath them said 0.9.0
and 405/100 — three unguarded numbers on a page whose table was watched.

**Things 0.9.0 added that nothing told anyone about.** `FsStorage` and
`examples/starter` appeared ZERO times in README, `llms.txt` and the homepage.
`llms.txt` is the file an AI agent reads to choose a storage adapter, and the
changelog entry below records that an agent in exactly that position wrote
`FsStorage` by hand because nothing offered it one. It now names all three
adapters, says which to pick, and links the starter. README gains a "where the
bytes go" table; the homepage's production checklist no longer requires a
bucket, because `FsStorage` made that false.

**Also corrected.** `llms.txt` gains the share-link capability rule and the fact
that BOTH byte routes refuse a credential in the query string, with the two
different codes they use. QUICKSTART's error table gains `link_is_read_only`.
The OpenAPI generator declares the 400 that `/f/{fileId}` really returns, and
its error enum gains `credential_in_query_string`, which a generated client was
rejecting as an undocumented response. SECURITY's supported-versions table, the
examples lists, the offline file list, the dependency sentence, and the
`npm run verify` enumeration in CONTRIBUTING all now match the tree.

### Added — `check:live`, which asks whether the deployed page is the page we wrote

Every gate here reads the working tree. Nothing had ever made an HTTP request to
the site this repository describes, so a deploy that stopped, cached, or
published the wrong branch would have looked exactly like success.

It exists because of a mistake worth recording. A cached `fetch` of the site
came back as the 0.7.0 page and was reported as "the deployed site is two
releases behind". A no-cache fetch, diffed against `git show HEAD:web/index.html`,
came back byte-identical: the deploy tracks `main` and always had. What was
stale was the FILE. Neither a human nor an agent reading through a cache can
tell "the site is behind" from "my fetch is"; this can. It runs nightly and on
manual dispatch, not on push, because a push legitimately precedes the deploy.

### Changed — the storage adapter now runs against AWS S3, and the documents say so

The `s3-live-aws` CI job was written on 30 September and skipped itself for
three days for want of credentials, announcing that fact in every run summary so
a green tick could not be mistaken for coverage. On 3 October a bucket in
`eu-north-1`, a least-privilege IAM user and the five repository secrets turned
it on: **12 tests against a real AWS bucket, on every commit**, alongside the
same twelve against Cloudflare R2.

Six public surfaces said "never run against AWS S3" and no longer do: README
(three places, and its shipped copy), TRUST.md, llms.txt, SEMANTICS.md,
docs/LIVE-S3-TESTS.md and the homepage. The replacement text is narrower than
"proven" on purpose, and says what is still unexercised: one region, one bucket
configuration, no load, and nothing about S3 Express One Zone, requester pays,
object lock, cross-region replication or a stricter bucket policy.

### Fixed — "12 tests, every commit" was eleven

Found by reading the job summary of the run that was supposed to confirm the
entry above. Both live suites report `ran: 11 test(s)`, not twelve: the twelfth
uploads ~11 MB and is skipped unless `FILELAYER_TEST_S3_MULTIPART=1`, which only
the nightly schedule and a manual dispatch set. The overclaim had been on the R2
side since 30 September and was copied onto the AWS side the same day it was
written, because nobody compared the sentence to the summary that states the
number in plain text.

One test behind a flag is the smallest gap there is between a claim and its
evidence, which is the size of gap this project can least afford: the argument
for reading our numbers at all is that we do not round them in our favour. Seven
surfaces now say eleven per commit and a twelfth nightly, and that count is a
claim in `check-version-claims`, derived from the test file rather than from
memory.

### Fixed — the website's trust table drifted where no gate was looking

The homepage said `0.8.0 — alpha` and `375 across 94 suites` while the package
was 0.9.0 and the suite ran 405 across 100. `check:web` reported clean the whole
time: it verifies the JSON-LD `softwareVersion` and never read the table a human
reads, so the machine-readable claim and the human-readable one were different
numbers on the same page and only one was checked. Those three values are now
claims in `check-version-claims`, which measures them against a real run.

---

## [0.9.0] — 2026-10-03

**`FsStorage`: bytes on a local disk, and three rewrites of how it writes them.**

### Added — `FsStorage`, the adapter between a Map and a bucket

Until now this package shipped two: `MemoryStorage`, which dies with the
process, and `S3Storage`, which needs a bucket and real credentials. Everything
between them -- a laptop, a single VM, a container with a volume, a CI job, or
anyone evaluating this before creating an IAM user -- had nothing. We know the
size of that gap because we measured it: an agent integrating this library from
npm, reading only the published documentation, hit exactly one hard stop before
its first stored byte, and wrote sixty lines of this adapter itself.

`new FsStorage('./data')`. Keys are hashed, so traversal, absolute paths, NULs
and length limits are all the same non-problem. `presignGet` is deliberately
absent -- a presigned URL promises that some other server will serve the bytes,
and a directory has no other server -- so `canPresign()` reports false and
redirect delivery is unavailable rather than broken.

**The format is one file per object: a JSON header line, then the bytes.** That
is not the obvious design and it is the third one we tried. The obvious design
keeps the bytes in one file and the metadata in another, and it cannot work,
because two files cannot be replaced atomically. Each ordering was written,
measured, and thrown away:

- bytes in place, metadata after: `writeFile` opens `O_TRUNC`, so every
  overwrite passes through a zero-length metadata file, and a concurrent
  `list()` read an empty one on the first round of every run;
- both through temp+rename, bytes first: a crash between the renames left bytes
  that `list()` could never report, because it walks metadata -- storage nothing
  could ever reclaim;
- both through temp+rename, metadata first: no unreclaimable bytes, but a reader
  landing between the renames got the new etag over the old bytes. 7 bad reads
  in 480 under load; 0 on an idle machine.

One file is one `rename`, and `rename(2)` is atomic within a filesystem. **Then
the same defect reappeared one layer down**: a reader that opened the file twice
-- once for the header, once for the payload -- straddled that rename anyway, at
5 bad reads in 480. `stream()` now opens once and reads the payload from the
descriptor the header came from, because a descriptor refers to the inode and no
rename can move it.

Also in the adapter, each found by an adversarial sweep and each with a test that
fails without the fix: `list()` skips a file it cannot read a header from instead
of throwing out of the whole walk; `list()` raises `EACCES` rather than
reporting an unreadable store as an empty one; a failed `put` cleans up its temp
file; a ranged `stream()` reads the range rather than the object (a 10-byte range
on a 100 MiB file used to cost 200 MiB of resident memory); the `limit` ceiling
is 1,000, as on the other two adapters, not 10,000; and neither adapter can hide
the empty key from every page of a listing.

### Changed — a share link refuses capabilities beyond `read` with a 400

`grant_link_read_only` has refused the row since 0.5.1, so the rule was never
missing -- only the path to it. The only way to reach it was the `INSERT`, and a
CHECK violation arrives as a pg error: SQLSTATE 23514, the constraint name, and
a `detail` field carrying the failing row. For `file_grant` that row contains
`secret_hash`, so an application that logged the error logged a credential, and
one that mapped `err.status` found there was none and answered 500 to what is a
400.

`shares.create(id, { as, capabilities })` and `share({ subject: { type: 'link' },
capabilities })` now throw `FilelayerError(400, 'link_is_read_only')` before any
query. **If you were matching on the SQLSTATE or on `grant_link_read_only`, match
on the code instead.** The database constraint is unchanged and still refuses the
row, which is the point: two independent writers are refused, not one check
tested twice.

### Added — a deployable example, and the gaps it closed

`examples/starter/` is an application against a Postgres you own, with bytes
that survive a restart: configuration in one block, the schema applied once
under an advisory lock, `FsStorage` by default, and the route helpers mounted
next to routes of your own. `verify.mjs` drives it over HTTP in twenty checks.

An adversarial sweep then broke the example four ways, all fixed: it looked for
a `project` table to decide whether the schema was applied, and `project` is a
name a host application may already have (it now counts all nine tables and
stops on a partial match); `readBody` had no ceiling, so a 400 MB upload took the
process from 85 MB resident to 1.3 GB; path segments were not percent-decoded
while `searchParams` were, so `POST /orgs/my%20team` and `POST /files?org=my
team` created two different tenants; and the error handler logged raw error
objects, which is how the `secret_hash` above would have reached a log file.

### Changed — two gates that could be made to verify nothing

`check-offline-reach` asked `existsSync`, so a zero-byte README passed every
step including `npm pack`; it now has per-anchor size floors. Its second check
read the backticked filenames out of a sentence in `llms.txt` and skipped the
literal `this file`, so a rewording that kept the sentence and moved the list
into plain prose left zero names to check and the gate reported clean -- on the
exact defect it was written for. It now requires a floor of eight names and a
named set of five.

`check-register` counted U+2014 only, so replacing every em dash with an en dash
-- one find-and-replace, visually almost identical -- took every surface to zero
while the gate reported clean. It counts the dash family now, and its header says
what a clean run does and does not mean.

### Fixed — four public surfaces claimed a test count nobody had measured

`check-version-claims` compared the test counts on the public surfaces WITH EACH
OTHER and never with a test run. TRUST.md, ARCHITECTURE-PROGRESSIVE.md (three
places) and PUBLISH-RUNBOOK.md all said 375 tests across 94 suites while the
suite ran 405 across 100, and the gate reported clean because they agreed.
Consistency is not accuracy.

`npm run test:counted` now runs the suite and records what it counted, and the
gate reads that and fails if the record is missing or older than the code. The
numbers on all four surfaces come from a run.

It failed on its own first CI run, which is worth recording: the wrapper did not
pin `--test-reporter`, and Node's default differs by version. The machine it was
written on emitted `# tests 405` and the runner emitted `ℹ tests 405`, so no
local test could have caught it. The reporter is pinned now, the parser reads
either prefix, and `node tools/run-suite.mjs --self-test` checks it against
captured output from both -- the fixtures are copied from the failing run rather
than written from memory, because a fixture built to confirm a fix will confirm
it.

### Fixed — six gates existed and CI did not run them

`check:copies`, `check:versions`, `check:web`, `check:web-samples`,
`check:register` and `check:offline` were all written and all wired into
`npm run verify`, and none of them was in the CI workflow. They therefore ran
whenever a maintainer remembered to run the whole gate locally, which is the
definition of a check you do not have -- and it is why the stale test count
above survived a day of green builds. They are in the workflow now, with the
counts check in its own job, with Postgres, so the number it verifies is the
number from a full run.

---

## [0.8.0] — 2026-10-03

**The sweep nobody had done: the storage adapter and the delivery routes.**

Three previous reviews went at authorization, the published package, and
lifecycle. None had gone at `storage.ts` or at what happens to bytes between the
object store and a browser, so that is where this one went, with the usual rule:
a finding is real only if there is an executed test that fails before the fix and
passes after. Fourteen were real.

Also in this release, and the reason it exists at all: **concurrency is no longer
argued.**

### Added — eight contention tests against a real PostgreSQL, on every commit

PGlite has a single backend. Two transactions never overlap on it, so a
check-then-act race cannot be staged and a lock that is never contended cannot be
observed to work. Three races were found by review on 2 October and fixed on
reasoning alone, because nothing in CI could produce the interleaving they defend
against.

`test/contention.test.ts` now runs against a real server with real, separate
connections: two backends demoting two owners of the same org, ten simultaneous
redemptions against a cap of three, twenty concurrent writers on one audit chain,
and cross-tenant traffic under load. Three of them carry a **calibration
control** that drives the same interleaving with the protection removed and
asserts the bad outcome does occur — zero owners, a counter over its cap, a chain
that fails replay — because a concurrency test that has never been seen to fail
is indistinguishable from one that cannot fail.

`npm test` is unchanged: no server, no download, two seconds. The suite opts in
via `npm run test:contention`, and CI sets `FILELAYER_TEST_DATABASE_URL` and then
refuses to let it skip.

### Added — the AWS S3 job, waiting on credentials

"Storage adapter against live AWS S3: never run" has been a row on the trust page
since publication. The job is now written, identical to the R2 one including the
guard that fails the build if credentials are present and the suite skips itself.
Five secrets turn it on; `docs/LIVE-S3-TESTS.md` lists them and the minimum IAM
policy. Until then it stays green and says in the run summary that it did not run.

### Fixed — an unauthenticated probe could still make itself invisible

`GET /f/%00`. Four characters, no credential, and the 0.6.0 defect was back.

0.6.0 fixed a route its own URL could kill and chose, deliberately, to keep an
unrecognisable identifier verbatim in the audit event's `context` so that a probe
left a record. That changelog entry put it well: *"the probe left no record,
because the write that would have recorded it was the write that failed."* But
`context` is `jsonb`, and jsonb refuses U+0000 exactly as the `uuid` column it
replaced did. So the NUL decoded cleanly, travelled to the audit INSERT, and died
there with SQLSTATE 22P05: an unauthenticated 500, and again no audit row. The
defect had moved one column over rather than closed, and an attacker could sweep
the file namespace invisibly by appending `%00`.

Refusing the NUL outright was the first fix and it was quietly worse: the probe
then vanished from the log entirely, which is the same invisibility with better
manners. U+FFFD is substituted instead, at the route and again in the store, so
the attempt is denied and recorded.

### Fixed — a closed browser tab leaked an object-store connection

`sendNodeStream` awaited `drain` and only `drain`. Once a client disconnects the
response is destroyed, `write()` returns false forever and `drain` never fires
again, so the handler suspended permanently. Measured: 150 abandoned downloads,
150 handlers still suspended, zero upstream streams cancelled.

The suspended promise was not the cost. `S3Storage.stream()` hands back a live
undici response body, so every abandoned download held an open socket to the
object store — four of five still open eight seconds later against a real signing
server. And because `await route(req, res)` never resolved, every per-request log
line, metric and cleanup written after it silently stopped running.

Now the wait races `drain` against `close`, the loop breaks when the response is
gone, and the reader is cancelled rather than merely released.

### Fixed — `scope: 'all-grants'` redirected deliveries that came from no grant

The option is documented as widening redirects from anonymous grants to "link and
actor grants too". The only `via` check lived inside the narrow scope, so under
the wide one nothing checked where the authority came from and an **owner read of
a private file** was handed out as a presigned URL that outlives a revocation.
`grantId === null` is how the rest of the class already tells the two apart; it
is why an owner read is not charged against a download cap.

### Fixed — a ranged read was silently widened to the whole object

The redirect arm never read `opts.range`. A caller asking for six bytes got a 302
for all of them, with no `Content-Range`, no `Accept-Ranges`, and nothing in the
response to detect it by. A range now forces the proxy path.

### Fixed — the storage adapter trusted the response shape

- **A 3xx was followed.** No signature covers where a redirect points, so an
  endpoint able to shape its responses could substitute arbitrary bytes for an
  authorized object — served under the real file's pinned content-type and
  audited as a successful read. It also forwarded `x-amz-security-token`, which
  undici does not strip across origins, to a host of the redirector's choosing.
  `redirect: 'error'` now.
- **A 200 carrying an `<Error>` body was a successful write.** `res.ok` was the
  whole check, so a store that answers 200 for everything got a byte count back
  that became `file.size_bytes` — a row describing an object that does not exist.
  A missing `ETag` is now a failure, as it already was for `uploadPart`. The same
  applies to `delete()`, where it matters more: the caller has already been told
  the bytes are gone.
- **A HEAD with no `content-length` reported `size: 0`.** `stream()` got the
  identical case right twenty lines away, so one adapter gave two answers about
  one response.
- **`head()` and `delete()` discarded the store's error code**, while every other
  method reported it, because they drained the body before testing the status.
- **A malformed `ByteRange` was formatted straight into the header.** RFC 9110
  says a recipient must ignore a `Range` it cannot parse, so the store returned
  the WHOLE object and the adapter reported an unranged read. `MemoryStorage`
  disagreed with the S3 path on the same input, which meant a range test passing
  against the in-memory double proved nothing. `assertRange` is now exported and
  enforced by both.
- **A non-finite presign TTL signed `X-Amz-Expires=NaN`.** `Math.max(1,
  Math.min(Math.floor(NaN), n))` is NaN at every step, and being signed it could
  not be stripped.
- **A part could exceed `partSizeBytes`.** `readAtLeast` carried whatever the
  last source chunk brought with it, so a 12 MiB chunk against a 5 MiB part size
  produced a 12 MiB part — measured off the wire. The documented invariant
  ("peak memory is bounded by ONE part") was false; the overshoot is now carried.
- **The multipart ETag came back XML-escaped**, so one field had two formats
  depending on object size and the multipart one was not a valid entity-tag.
- **An endpoint carrying a path was silently dropped.** The limitation is fine;
  the silence was not.

### Fixed — two smaller delivery gaps

`fileDownloadRoute` did not apply the query-string credential refusal that
`deliveryHandler` advertises for the whole surface: `/d/x?token=abc` was a 400 and
`/f/<id>?token=abc` a 200. And `HEAD` was unroutable, so an existing authorized
file answered 404 to HEAD and 200 to GET, which misreports existence to every
cache and link checker. Note that a HEAD now spends a download against a capped
grant; `stat()` is the call that does not.

### Tests

383 across 98 suites, of which 375 run on PGlite on every commit and 8 against a
real PostgreSQL. Ten new regression tests, each observed to fail against `0.7.0`
and pass here. The two scratch probe files the review produced were deleted; what
survives is in `regression.test.ts` with the rest.

Two of those ten were weak when first written and passed against the pre-fix tree
— one exercised the engine instead of the route, the other pointed its redirect at
an unreachable port, so the fetch failed either way and proved nothing. Both were
rewritten until they discriminated. That check is the only reason the suite means
anything, and it is worth recording that it caught its own author twice.

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
