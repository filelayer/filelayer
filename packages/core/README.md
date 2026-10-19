# Filelayer

[![CI](https://github.com/filelayer/filelayer/actions/workflows/ci.yml/badge.svg)](https://github.com/filelayer/filelayer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@filelayer/core.svg)](https://www.npmjs.com/package/@filelayer/core)
[![node](https://img.shields.io/node/v/@filelayer/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/filelayer/filelayer/blob/main/LICENSE)

<!-- Every URL on this page is rooted at github.com/filelayer/filelayer and
     npmjs.com/package/@filelayer/core, so the badges resolve on their own with
     no edit here. -->

**The file layer for SaaS applications.** Public files and private files, with
one authorization model behind both. → **[filelayer.dev](https://filelayer.dev)**

You tell Filelayer who the caller is. Filelayer decides what they may do with a
file, serves the bytes with the right headers, and writes the audit event. For
file access that goes through Filelayer, that decision is made in one place,
`packages/core/src/authz.ts`, so you write no ownership checks in route
handlers, no presigned-URL expiry logic, and no per-route access rules of your
own.

> **Alpha, and looking for three to five design partners** — we will help you
> integrate this and stay on hand while you do, in exchange for hearing where it
> breaks. [Should you depend on this?](https://github.com/filelayer/filelayer/blob/main/TRUST.md) ·
> [what it does not do](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md) ·
> [roadmap to 1.0](https://github.com/filelayer/filelayer/blob/main/ROADMAP.md)

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
const bytes = new TextEncoder().encode('hello');
-->

```ts
// Public avatar
const { url } = await fl.files.put(bytes, { public: true });

// Private, user-owned
const { id } = await fl.files.put(bytes, { owner: 'user_123' });
const file  = await fl.files.get(id, { as: 'user_123' });

// Multi-tenant, role-controlled
await fl.files.put(bytes, { org: 'acme', owner: 'user_123' });

// Shared with an expiry, a password and a download cap, and revocable
const share = await fl.shares.create(id, {
  as: 'user_123', expiresIn: 3600, maxDownloads: 3, password: 'hunter2',
});
await fl.shares.revoke(share.grantId, { as: 'user_123' });   // this link, now

// Shared with a named user, and taken back. `unshare` is the one you want for
// a person: `create()` is not idempotent, so revoking a single grant id you
// happen to be holding can leave an earlier one live.
await fl.shares.create(id, { as: 'user_123', withUser: 'user_456' });
await fl.shares.unshare(id, { as: 'user_123', user: 'user_456' });   // all of it
```

**Start at whichever line matches your problem.** Complexity is incremental:
each tier adds one concept, and no tier makes you pay for a concept you are not
using. → [`docs/QUICKSTART.md`](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md)

---

## The three layers

```
your application          fl.files.put / get / list, fl.shares, fl.orgs
                          you pass YOUR user id; nothing here knows a uuid
   ───────────────────────────────────────────────────────────────────────
Filelayer                 ONE authorization function answers every request
                          grants, roles, expiry, download caps, revocation
                          the audit event, written in the decision's own
                          transaction so the log cannot disagree with it
   ───────────────────────────────────────────────────────────────────────
your Postgres             9 tables. Filelayer owns the schema, you own the
your bucket               database. Bytes go to S3, R2, B2 or a directory
                          behind one adapter; storage is replaceable
```

Filelayer sits between the two things you already run. It brings no database and
no storage of its own, and **zero runtime dependencies**.

**It is authorization middleware, not row-level security.** It decides for calls
made through it, in your process. The schema additionally refuses cross-tenant
grants, cross-project identities and delegation that amplifies authority from
*every* writer, including a `psql` session — those are constraints and triggers.
But there is no RLS policy in `schema.sql`, and a direct `SELECT` against these
tables is filtered by nothing. Filelayer composes with database-level
enforcement; it does not replace it.

---

## What it is for, and what it is not for

**Worth the overhead when:** files are private, belong to specific people or
tenants, and their permissions change over time. Documents, contracts,
attachments, exports, anything with a share link you might later want back.

**Not worth the overhead when:**

| You need | Use instead | Why |
|---|---|---|
| Public images at CDN volume | a CDN-backed bucket | Default delivery proxies every byte. Redirect delivery (below) removes the proxy but is opt-in and narrow. |
| Video or audio at scale | a CDN / media service | Seeking works — the shipped routes answer `Range` with `206`. But default delivery proxies every byte through your server, and there is no CDN on that path. |
| Browser → storage upload with your server out of the data path, in development | a real bucket | `FsStorage` mints the credential so the client code is identical, but it receives the bytes itself and says so: `via: 'server'`. Only S3 and R2 keep your process out of the path. |
| Resumable or multipart direct upload | presigned S3 directly / tus | One signed PUT, one object. There is no resume. |
| Thumbnails, transforms, format negotiation | Cloudinary / imgix | We have none. |

### Against the two things you would otherwise do

| | Hand-rolled presigned URLs | Supabase Storage | Filelayer |
|---|---|---|---|
| Revoke a link somebody already holds | **No.** A signature is valid until its clock runs out; your options are a short TTL or proxying the bytes yourself | **No.** Signed URLs are signed with an internal key and cannot be revoked | **Yes**, on the next request, transitively through the delegation chain |
| "Everyone in this org may read" | your own join, recomputed on every join and leave | expressible as an RLS policy | one grant row; membership resolves at request time |
| Who accessed this, including refusals | whatever you wrote | not a product feature; Postgres logging is not an access log | hash-chained per tenant, written in the decision's transaction |
| Download cap | your own counter, and the race in it | none | atomic, reserved before the bytes move |
| CDN on the private path | yes, and that is why you cannot revoke | yes, same trade | **no** — the two facts are the same fact |
| Public images at volume | **yes** | **yes** | no. Use a bucket behind a CDN |
| Lines for a public avatar | ~10 | **10** | 16 |

The last two rows are losses and they are not close. We publish the full
comparison, including every case we lose, in
[`ARCHITECTURE-PROGRESSIVE.md`](https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md)
§5. Short version: **for a public avatar, Supabase is 10 lines and Filelayer is
16.** If avatars are your whole problem, use Supabase.

---

## The five security properties

These are the product. Each is enforced in the schema or the authorization
engine, not by convention, and each has tests named after it.

| | Property | What it means in practice |
|---|---|---|
| **P1** | Deny by default | There is no `public` boolean anywhere in the schema. Public delivery is an explicit, revocable, auditable grant row — there is no flag to leave on by accident. **This is a property of the schema, not of your object store: Filelayer cannot make your bucket private, and a public bucket bypasses everything on this page.** That is the one configuration step it cannot do for you — [QUICKSTART §7](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md). |
| **P2** | No ambient authority | Knowing an object key, a URL or a file id grants nothing. Storage location is never an input to a decision. |
| **P3** | Cross-tenant grants are structurally impossible to write | A grant's `org_id` must equal its file's `org_id`, enforced by the composite foreign key `FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id)`. No writer — including a migration or a `psql` session — can create a grant pointing at another tenant's file. This is a write-side integrity constraint, not a read filter: it makes the *row* unrepresentable. Reads are scoped by the engine, not by the database. |
| **P4** | A URL never outlives its permission | Every signed URL embeds a grant id and is re-validated on **every** request, transitively through the whole delegation chain. Revocation beats a live URL. |
| **P5** | Every decision is audited, including denials | Hash-chained per tenant. Probes that cannot be attributed to a tenant go to a system chain rather than being dropped. The log answers in *your* identifiers — `marco`, `contract.pdf`, `acme` — alongside the internal ones, so "who accessed this?" needs no SQL of yours. |

Three more properties are enforced in the schema and documented in
[`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md): atomic download
counters (**P6**), deletion as a liveness predicate rather than a cascade
(**P7**), and per-project identifier namespaces (**P8**).

Two consequences worth knowing before you adopt:

- **Revocation actually works.** `fl.files.unpublish(id)` makes a URL that has
  been printed, indexed and pasted into a support ticket stop working on the
  next request. No deletion, no key rotation, no cache purge. Supabase's
  `getPublicUrl()` is offline string concatenation, so it has no request at
  which to make that decision; deleting the object is the only withdrawal.
- **This costs you a byte path.** P4 is why the default is to serve bytes rather
  than hand out a presigned URL, and it is why the default path has no CDN in
  front of it. The two facts are the same fact. Redirect delivery trades a
  bounded revocation window for that CDN and is opt-in; see
  [`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md).

---

## What backs that up

Said once, here, because every number in it is checked by a gate that fails the
build when a public surface and the run disagree:

| | |
|---|---|
| The suite | **706 tests**, every commit, all of them against a real PostgreSQL |
| Concurrency | **8 tests** on a real PostgreSQL with two backends — races staged, not reasoned about. Three carry a control that removes the protection and asserts the bad outcome *does* happen |
| Adversarial | **27 attacks, 0 breaches.** Also run against an earlier revision of this library known to be vulnerable, which scores 3. A suite that only ever passes proves nothing about itself |
| Live object storage | **12 tests against live Cloudflare R2 and 12 against live AWS S3, every commit**, plus a thirteenth each on the nightly run: an 11 MB multipart upload reassembled byte-exactly. R2 is S3-compatible, not S3, which is why both run |
| Schema migrations | every migration file applied to the **previous release's** `schema.sql` and the result compared against the next one, on real PostgreSQL |
| The published artifact | the tarball installed into an empty directory and driven through the whole lifecycle; the starter booted over HTTP and driven through 25 checks; every relative path inside the tarball resolved from inside the tarball |

**What none of that measures is load, or anyone's production.** The complete
table, including the rows that are zero, is on
[the trust page](https://github.com/filelayer/filelayer/blob/main/TRUST.md).

---

## The five that make people decline

The complete list is [`LIMITATIONS.md`](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md) -- fourteen
entries, each with its reasoning, shipped in the npm tarball so an install has
it on disk. These five are the ones that should make you close the tab if they
apply to you:

1. **No CDN on the private delivery path.** Bytes proxy through your
   application, and authenticated responses carry `Cache-Control: no-store`.
   That is not an oversight, it is P4: a URL that can be revoked is a URL that
   has to be asked about. An opt-in redirect mode trades a bounded revocation
   window of up to 300 seconds for cacheability. **If your workload is public
   images at volume, use a bucket behind a CDN and come back when you need to
   take a URL back.**
2. **A grant id is not a person's access, and `shares.create()` still inserts
   a row per call by default.** Two calls with an `expiresIn` are two
   legitimately different windows, so the engine cannot dedupe on its own. Pass
   an `idempotencyKey` and a retry returns the grant that already exists;
   without one, a double-clicked share button gives one reader two grants.
   `revoke()` now answers `subjectCanStillRead`, so revoking one grant and not
   removing somebody's access is visible in the reply rather than in an audit
   later. Use `shares.unshare(fileId, { as, user })` to remove a named person,
   and note there is still no bound on how many live grants one subject may
   hold.

   The *cost* of that is no longer the problem it was. Until `0.17.0` the read
   paid one recursive chain walk per grant held: 4.3 ms at five, 5 911 ms at a
   hundred thousand. The short-circuit moved into SQL and the cliff went with
   it — 30.4 ms at **two hundred** thousand concentrated grants, 1.13x the
   owner read on the same file, measured in
   [`benchmark/load/RESULTS.md`](https://github.com/filelayer/filelayer/blob/main/benchmark/load/RESULTS.md)
   H4b. What remains is a correctness trap, not a performance cliff.
3. **No resumable or multipart upload.** One signed PUT, one object. A large
   upload that fails starts over, and `fl.files.put()` holds the whole body in
   memory -- only the core `fl.upload()` takes a stream, and neither imposes a
   size ceiling, so that is yours to enforce.
4. **Org admins and owners can read `private` files.** Deliberate: retention
   and legal hold are useless if the people accountable for them cannot see
   what they are holding. But it is a policy decision, and if you need to
   exclude the operator you need envelope encryption, which we do not have.
5. **Alpha, nobody is running it in production including us, and the schema has
   changed twelve times.** Any `0.x` → `0.(x+1)` may
   break the API, the schema or both. Every break has a numbered entry in
   [`MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md) and a runnable file
   under `migrations/` that CI applies to the previous release's schema and
   checks produces the next one -- but there is no LTS branch, no backporting,
   and **no independent security review**.

---

## Install

```bash
npm install @filelayer/core
```

Requires **Node ≥ 22.18**. The package ships compiled JavaScript and type
declarations in `dist/`; the TypeScript source and the full test suite are in
the tarball as well, so every claim on this page is inspectable from what you
installed.

**That install has zero runtime dependencies.** Filelayer talks to *your*
Postgres and *your* bucket, so it ships neither. The throwaway instance below is
the one exception: `quickstart()` runs on an embedded WebAssembly Postgres,
declared as an *optional peer dependency* so that it never lands in a production
`node_modules`. Add it if you want the throwaway instance, and skip it
otherwise. `createTestDb()` will tell you, by name, if you need it:

```bash
npm install --save-dev "@electric-sql/pglite@^0.3.11"
```

**Install PGlite with that version constraint.** Filelayer supports the
**0.3.x** line, which is what `peerDependencies` declares and what the suite runs
against. **0.5.x is not supported**: we ran the full suite against 0.5.8 and it
does not pass, so the range has not been widened. PGlite's `latest` on npm is a
0.5.x release, so omitting the constraint can install a version outside the
supported range, and npm then refuses the whole tree with `ERESOLVE`. The quotes
are for your shell, not for npm: `^` is a glob operator under `zsh` with
`extendedglob` and an escape character in `cmd.exe`.

```ts
import { Filelayer } from '@filelayer/core';

const fl2 = await Filelayer.quickstart();          // PGlite + in-memory bytes
const { url: avatarUrl } = await fl2.files.put(bytes, { public: true });
```

`quickstart()` is **ephemeral**: everything is lost when the process exits.

### Serving the bytes

Authorizing a read is not the same as answering the request. Two handlers do
the second, and which one you want is decided by your runtime, not by
preference:

| | |
|---|---|
| `deliveryHandler(fl, opts?)` | Returns `(req: IncomingMessage, res: ServerResponse) => Promise<void>`. Node's own HTTP server, and Express, Fastify and Koa, which hand you those objects. |
| `deliveryFetch(fl, opts?)` | Returns `(req: Request) => Promise<Response \| null>`. Next.js App Router, Hono, Cloudflare Workers, Deno and Bun, which hand you a `Request` and want a `Response` back. |

They are the same two routes with the same behaviour. `deliveryFetch` returns
`null` for a request it does not own, so a catch-all route can fall through to
the rest of your application instead of swallowing it.

**Mounting the wrong one is the most common integration failure we see.** A
`node:http` handler in an App Router route exports a function with the wrong
shape; the symptom is not a type error at the mount point but a request that
never answers.

<!-- doccheck: skip reason="it is a route module: the export is the deliverable, and there is nothing here to call without inventing a request this page does not need" -->
```ts
import { deliveryFetch } from '@filelayer/core';

const serve = deliveryFetch(fl, {
  principal: async () => ({ as: await currentUserId() }),
});

export async function GET(req: Request) {
  return (await serve(req)) ?? new Response('Not found', { status: 404 });
}
```

Both parse `Range`, which matters more than it sounds: a `<video>` element will
not let the user scrub until a range request is answered, and a PDF reader asks
for the end of the file first. An **invalid** range is answered `200` with the
whole representation, as RFC 9110 requires, and only a range that parsed
cleanly and cannot be satisfied gets `416` with `Content-Range: bytes */<size>`.
`Accept-Ranges: bytes` goes on the plain `200` as well, because that is how a
client learns it may seek at all.

Two defaults to know before you mount either one. **`disposition` defaults to
`attachment`**, which downloads rather than plays, so a media route needs
`disposition: 'inline'`. And redirecting to a presigned URL instead of proxying
is opt-in, because it moves revocation out of your process for the life of the
URL; it requires a storage adapter that can sign, and it refuses with
`redirect_not_acknowledged` until the configuration says so out loud.
[`docs/guides/serving-private-files.md`](https://github.com/filelayer/filelayer/blob/main/docs/guides/serving-private-files.md)
is the measured comparison of the two.

### Everything else, one page per thing

That is the whole integration for most applications: install, `quickstart()` to
see it work, then a real database and one of these handlers. The rest is a page
each, and every one of them ships inside the npm tarball, so an install has them
on disk.

| | |
|---|---|
| Which storage adapter, and making the bucket private | [QUICKSTART §7](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) |
| Checking a deployment from a terminal (`filelayer doctor`) | [`docs/CLI.md`](https://github.com/filelayer/filelayer/blob/main/docs/CLI.md) |
| The Agent Skill, if an agent is doing the integration | [`docs/AGENT-SKILL.md`](https://github.com/filelayer/filelayer/blob/main/docs/AGENT-SKILL.md) |
| Browser → bucket upload, with your server out of the path | [`docs/DIRECT-UPLOAD.md`](https://github.com/filelayer/filelayer/blob/main/docs/DIRECT-UPLOAD.md) |
| An MCP server, so an agent can operate files | [`docs/MCP.md`](https://github.com/filelayer/filelayer/blob/main/docs/MCP.md) |
| The 29 error codes, and `FilelayerError` | [QUICKSTART §9](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) · [`ERRORS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/ERRORS.md) |
| Proving **your** routes hold, not ours (`auditIntegration()`) | [QUICKSTART §8](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) |
| Reading the audit trail, with a time window and no storage adapter | [QUICKSTART §4](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) |
| Running the suite yourself, from a clone | [CONTRIBUTING](https://github.com/filelayer/filelayer/blob/main/CONTRIBUTING.md) · [from an install](https://github.com/filelayer/filelayer/blob/main/docs/VERIFY-WHAT-YOU-INSTALLED.md) |

The guides are also rendered at **[filelayer.dev/guides](https://filelayer.dev/guides/)**,
which is the same markdown and is easier to read than a repository file.

## Versioning

Pre-1.0. The version is `0.MINOR.PATCH` and the promise is deliberately narrow:

- **`0.x` → `0.(x+1)`** may break the API, the schema, or both. Every break is
  in [`packages/core/CHANGELOG.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md), and every
  schema break has a migration in
  [`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md).
- **`0.x.y` → `0.x.(y+1)`** is additive or a fix. No schema change that requires
  action, no signature change.
- There is no long-term support branch and no backporting before 1.0.

**The schema has changed twelve times.** `MIGRATIONS.md` has fifteen numbered
entries, ten of which carry forward SQL; the other two schema changes predate
the oldest tag in the repository and cannot be verified against an earlier
schema. Budget an upgrade against that file rather than against this paragraph.
Every figure in this paragraph is derived from `migrations/manifest.json` by
`check:versions`, which fails the build if any of them drifts — because these
numbers were last corrected by hand at `0.15.0` and had drifted again by
`0.33.0`.

**Which version a database is at is readable off the database.**
`schemaStatus(db)` reports where a database is, what this build expects, and
which files under `migrations/` are outstanding. It issues no DDL: your
application owns the migration runner, which is the position
[`MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md)
§2 takes and is keeping.

---

## Layout

| Path | What it is |
|---|---|
| `packages/core/schema.sql` | The data model. Every security property is commented at the constraint that enforces it. Read this first if you are reviewing us. |
| `packages/core/src/authz.ts` | The authorization engine. Two functions, one decision core. |
| `packages/core/src/simple.ts` | The tiered API (`files`, `orgs`, `shares`). No authorization logic — a facade. |
| `packages/core/src/delivery.ts` | Byte delivery. Owns the response headers so you cannot get them wrong. |
| `packages/core/test/` | The property suite. Ships in the tarball. |
| `packages/core/dev/` | Diagnostic scripts. Not published. |
| `examples/tier1-avatar` … `tier3-org-roles` | One runnable example per tier |
| `examples/vault` | A full B2B document workspace over HTTP |
| `examples/starter` | A deployable server: your Postgres, `FsStorage`, route helpers mounted |
| `examples/nextjs` | App Router: `deliveryFetch` at a catch-all route, upload, share, revoke |
| `examples/mcp` | A launchable MCP server, driven over real stdio by its own `verify.mjs` |

## Documents

- [`docs/QUICKSTART.md`](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) — install → first file → the advanced capabilities
- [`LIMITATIONS.md`](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md) — the complete list of what this does not do, fourteen entries with their reasoning
- [`ROADMAP.md`](https://github.com/filelayer/filelayer/blob/main/ROADMAP.md) — the nine things an outside evaluator said would change its answer, eight of them done, and what is deliberately not coming
- [`docs/guides/`](https://github.com/filelayer/filelayer/tree/main/docs/guides) — four answers to questions people actually ask, useful whether or not you use this library; the code in them is executed in CI
- [`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md) — the exact behaviour of every edge: liveness, delegation, deletion, the audit chain
- [`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md) — how schema changes are delivered and what the pre-1.0 compatibility promise is
- [`packages/core/CHANGELOG.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md) — the real history, including the security defects we found in ourselves
- [`ARCHITECTURE-PROGRESSIVE.md`](https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md) — the tier model, lines of code versus the alternatives, and where we lose
- [`architecture/TIER5-DESIGN-NOTE.md`](https://github.com/filelayer/filelayer/blob/main/architecture/TIER5-DESIGN-NOTE.md) — large files, streaming, range requests, CDN
- [`llms.txt`](https://github.com/filelayer/filelayer/blob/main/llms.txt) — the same map, written for an agent implementing an integration
- [`openapi.yaml`](https://github.com/filelayer/filelayer/blob/main/openapi.yaml) — the two HTTP routes the library serves, as OpenAPI 3.1

Every link above points at GitHub, and an installed consumer may have no network
and no browser. The npm package therefore carries the same files on disk under
`node_modules/@filelayer/core/`, and three resolve as subpath imports —
`@filelayer/core/llms.txt`, `@filelayer/core/openapi.json` and
`@filelayer/core/schema.sql` — so a reader does not have to guess at the layout
of `node_modules`.

## License

**[Apache-2.0](https://github.com/filelayer/filelayer/blob/main/LICENSE)**, with
an express patent grant and a patent-retaliation termination clause. No copyleft
obligation on your own code; preserve the notices and state significant changes.
`LICENSE` and [`NOTICE`](https://github.com/filelayer/filelayer/blob/main/NOTICE)
both ship in the tarball, so the grant travels with the artifact.

```
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Technology Pro Bono S.L.
```

**Dependencies.** **No runtime dependencies**, and a job in CI fails the build
if one appears. The third-party packages are all `devDependencies`:
[`@electric-sql/pglite`](https://github.com/electric-sql/pglite) (Apache-2.0),
also an optional peer dependency and what `quickstart()` runs on, plus `pg` and
`embedded-postgres` for the contention tests that need two real backends. A
production install contains none of them, and no third-party code is copied or
embedded anywhere in this repository.

## Contributing, security and conduct

- [`CONTRIBUTING.md`](https://github.com/filelayer/filelayer/blob/main/CONTRIBUTING.md)
  — how to set up, what `npm run verify` covers, and what a pull request needs.
- [`SECURITY.md`](https://github.com/filelayer/filelayer/blob/main/SECURITY.md)
  — **report vulnerabilities privately**, never as a public issue. Includes our
  disclosure timetable and what is in and out of scope.
- [`CODE_OF_CONDUCT.md`](https://github.com/filelayer/filelayer/blob/main/CODE_OF_CONDUCT.md)
  — Contributor Covenant 2.1.

Bugs, questions and "this document is wrong" reports go to
[GitHub Issues](https://github.com/filelayer/filelayer/issues). A report that
the product does not do what this README says is the most valuable thing you can
send us, and every one so far has been fixed the same day.
