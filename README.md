# Filelayer

[![CI](https://github.com/filelayer/filelayer/actions/workflows/ci.yml/badge.svg)](https://github.com/filelayer/filelayer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@filelayer/core.svg)](https://www.npmjs.com/package/@filelayer/core)
[![node](https://img.shields.io/node/v/@filelayer/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/filelayer/filelayer/blob/main/LICENSE)

<!-- Every URL on this page is rooted at github.com/filelayer/filelayer and
     npmjs.com/package/@filelayer/core, so the badges resolve on their own with
     no edit here. -->

> ## ⚠️ Alpha — developer preview. Not production software.

> **[Should you depend on this?](https://github.com/filelayer/filelayer/blob/main/TRUST.md)** — the real numbers, including the ones
> that are zero, and exactly what would change them.
>
> We would rather you trust us later for good reasons than trust us now for bad
> ones, so here is the honest state of this project.
>
> **What is tested.** The authorization engine is the part we stand behind. It
> carries a property suite covering cross-tenant isolation, revocation,
> delegation attenuation, download caps, audit tamper-evidence and the full role
> matrix, plus a differential test asserting that the set query and the point
> check agree exactly, plus an adversarial suite of attacks it must survive. All
> of it runs in CI on every commit, against real PostgreSQL. A release gate packs
> the tarball, installs it into an empty directory and drives the whole lifecycle
> as a stranger would.
>
> **What has never run against live infrastructure.** The S3/R2 storage adapter
> has **never been executed against real AWS or Cloudflare credentials.** It is
> exercised against a local implementation that verifies SigV4 signatures, which
> is not the same thing and we will not pretend it is. A live-credential suite
> exists and runs automatically once `FILELAYER_TEST_S3_*` is in the
> environment; nobody has supplied it yet.
>
> **What may break.** Nobody has deployed this. There is no production usage, no
> hosted service, no CLI, and no operational track record — so the failure modes
> that only appear under real traffic, real object stores and real connection
> pools are unmeasured. Expect to be the person who finds them.
>
> **The schema may change before 1.0.** It has already had one breaking change.
> Any `0.x` → `0.(x+1)` may break the API, the schema, or both. Every break is
> in the [changelog](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md)
> and every schema break ships with SQL in
> [MIGRATIONS.md](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md),
> but there is no long-term support branch and no backporting.
>
> **Use it** to evaluate the model, to build something that is not yet carrying
> customer data, or to tell us where it breaks. **Do not use it** as the file
> layer under a production system you would be embarrassed to lose. The full
> list of known gaps is in [Limitations](#limitations) below; nothing there is
> hidden in an appendix.

**The file layer for SaaS applications.** Public files and private files, with
one authorization model behind both.

You tell Filelayer who the caller is. Filelayer decides what they may do with a
file, serves the bytes with the right headers, and writes the audit event. You
do not write authorization rules, RLS policies, bucket ACLs, ownership checks in
route handlers, or presigned-URL expiry logic — because there is exactly one
place a decision is made, and it is not in your application.

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

// Shared with an expiry, a password and a download cap — and revocable
const share = await fl.shares.create(id, {
  as: 'user_123', expiresIn: 3600, maxDownloads: 3, password: 'hunter2',
});
await fl.shares.revoke(share.grantId, { as: 'user_123' });   // takes effect now
```

**Start at whichever line matches your problem.** Complexity is incremental:
each tier adds one concept, and no tier makes you pay for a concept you are not
using. → [`docs/QUICKSTART.md`](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md)

---

## Status: pre-release. Read this part.

Filelayer is pre-1.0 and has not been deployed by anyone. This README is
accurate rather than promotional, because you are more likely to be an AI agent
reading it to write an integration than a human reading it to be persuaded, and
an inaccurate README wastes your time and ours.

- **Licensed under [Apache-2.0](https://github.com/filelayer/filelayer/blob/main/LICENSE).**
  You may use it, modify it, distribute it and ship it inside commercial
  software, with a patent grant. This was the single largest blocker to adoption
  and it is resolved: `packages/core/package.json` declares
  `"license": "Apache-2.0"`, and both `LICENSE` and
  [`NOTICE`](https://github.com/filelayer/filelayer/blob/main/NOTICE) ship
  inside the npm tarball. See [License](#license) below.
- The authorization core is tested: a property suite covering cross-tenant
  isolation, revocation, delegation attenuation, download caps, audit
  tamper-evidence and the full role matrix, plus a differential test that
  asserts the set query and the point check agree exactly.
- The S3/R2 storage adapter is exercised against a **signature-verifying local
  S3 implementation** (`packages/core/test/storage.test.ts`). It has **never
  been run against live AWS or Cloudflare credentials.** A live-credential suite
  exists (`packages/core/test/s3-live.test.ts`) and runs automatically when
  `FILELAYER_TEST_S3_*` is present in the environment; nobody has supplied it.
- There is no hosted service and no CLI. You run it against your own Postgres.
- Versioning is pre-1.0: see [Versioning](#versioning) below and
  [`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md).

---

## What it is for, and what it is not for

**Worth the overhead when:** files are private, belong to specific people or
tenants, and their permissions change over time. Documents, contracts,
attachments, exports, anything with a share link you might later want back.

**Not worth the overhead when:**

| You need | Use instead | Why |
|---|---|---|
| Public images at CDN volume | a CDN-backed bucket | Default delivery proxies every byte. Redirect delivery (below) removes the proxy but is opt-in and narrow. |
| Video or audio seeking in a browser | a CDN / media service | The shipped HTTP route helpers do not answer `Range` requests. |
| Direct browser → storage upload | Supabase / presigned S3 | Uploads go through your server. |
| Thumbnails, transforms, format negotiation | Cloudinary / imgix | We have none. |

We publish the full comparison, including the cases we lose, in
[`ARCHITECTURE-PROGRESSIVE.md`](https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md)
§5. Short version: **for a public avatar, Supabase is 10 lines and Filelayer is
16.** If avatars are your whole problem, use Supabase.

---

## The five security properties

These are the product. Each is enforced in the schema or the authorization
engine, not by convention, and each has tests named after it.

| | Property | What it means in practice |
|---|---|---|
| **P1** | Deny by default | There is no `public` boolean anywhere in the schema. Public delivery is an explicit, revocable, auditable grant row. "The bucket was public" is not expressible. |
| **P2** | No ambient authority | Knowing an object key, a URL or a file id grants nothing. Storage location is never an input to a decision. |
| **P3** | Structural tenant isolation | A grant's `org_id` must equal its file's `org_id`, enforced by a composite foreign key. Cross-tenant access is unrepresentable, not merely prevented by a `WHERE` clause. |
| **P4** | A URL never outlives its permission | Every signed URL embeds a grant id and is re-validated on **every** request, transitively through the whole delegation chain. Revocation beats a live URL. |
| **P5** | Every decision is audited, including denials | Hash-chained per tenant. Probes that cannot be attributed to a tenant go to a system chain rather than being dropped. The log answers in *your* identifiers — `marco`, `contract.pdf`, `acme` — alongside the internal ones, so "who accessed this?" needs no SQL of yours. |

Three more properties are enforced in the schema and documented in
[`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md): atomic download
counters (**P6**), deletion as a liveness predicate rather than a cascade
(**P7**), and per-project identifier namespaces (**P8**).

Two consequences worth knowing before you adopt:

- **Revocation actually works.** `fl.files.unpublish(id)` makes a URL that has
  been printed, indexed and pasted into a support ticket stop working on the
  next request — no deletion, no key rotation, no cache purge. Supabase's
  `getPublicUrl()` is offline string concatenation, so it has no request at
  which to make that decision; deleting the object is the only withdrawal.
- **This costs you a byte path.** P4 is why the default is to serve bytes rather
  than hand out a presigned URL, and it is why the default path has no CDN in
  front of it. The two facts are the same fact. Redirect delivery trades a
  bounded revocation window for that CDN and is opt-in; see
  [`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md).

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
otherwise — `createTestDb()` will tell you, by name, if you need it:

```bash
npm install --save-dev "@electric-sql/pglite@^0.3.11"
```

**Install PGlite with that version constraint.** Filelayer supports the
**0.3.x** line, which is what `peerDependencies` declares and what the suite runs
against. **0.5.x is not supported**: we ran the full suite against 0.5.8 and it
does not pass, so the range has not been widened. PGlite's `latest` on npm is a
0.5.x release, so omitting the constraint can install a version outside the
supported range — and npm then refuses the whole tree with `ERESOLVE`. The quotes
are for your shell, not for npm: `^` is a glob operator under `zsh` with
`extendedglob` and an escape character in `cmd.exe`.

```ts
import { Filelayer } from '@filelayer/core';

const fl2 = await Filelayer.quickstart();          // PGlite + in-memory bytes
const { url: avatarUrl } = await fl2.files.put(bytes, { public: true });
```

`quickstart()` is **ephemeral** — everything is lost when the process exits.
Production is three configuration steps and is not hidden:
[`docs/QUICKSTART.md`](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md)
§6.

### Running the suite

The tests are in the tarball but they cannot be executed from inside
`node_modules`: Node refuses to strip types from files under `node_modules`, and
the tests import the TypeScript source directly. To run them, clone the
repository — tests run against PGlite, PostgreSQL 17 compiled to WebAssembly and
running in-process, so there is no daemon and no Docker:

```bash
git clone https://github.com/filelayer/filelayer && cd filelayer
npm run bootstrap        # npm ci in packages/core
npm test                 # the security property suite, 324 tests
npm run typecheck
npm run verify           # typecheck + tests + build + doc and language checks
npm run example:tier1    # a public avatar, on :3000
npm run example:vault    # the full Vault app, on :8787
```

---

## Versioning

Pre-1.0. The version is `0.MINOR.PATCH` and the promise is deliberately narrow:

- **`0.x` → `0.(x+1)`** may break the API, the schema, or both. Every break is
  in [`packages/core/CHANGELOG.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md), and every
  schema break has a migration in
  [`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md).
- **`0.x.y` → `0.x.(y+1)`** is additive or a fix. No schema change that requires
  action, no signature change.
- There is no long-term support branch and no backporting before 1.0.

The schema has already had one breaking change (per-project identifier
namespaces). It is written up, with the SQL, as the first entry in
[`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md).

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

## Documents

- [`docs/QUICKSTART.md`](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md) — install → first file → the advanced capabilities
- [`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md) — the exact behaviour of every edge: liveness, delegation, deletion, the audit chain
- [`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md) — how schema changes are delivered and what the pre-1.0 compatibility promise is
- [`packages/core/CHANGELOG.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md) — the real history, including the security defects we found in ourselves
- [`ARCHITECTURE-PROGRESSIVE.md`](https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md) — the tier model, lines of code versus the alternatives, and where we lose
- [`architecture/TIER5-DESIGN-NOTE.md`](https://github.com/filelayer/filelayer/blob/main/architecture/TIER5-DESIGN-NOTE.md) — large files, streaming, range requests, CDN
- [`llms.txt`](https://github.com/filelayer/filelayer/blob/main/llms.txt) — the same map, written for an agent implementing an integration
- [`openapi.yaml`](https://github.com/filelayer/filelayer/blob/main/openapi.yaml) — the two HTTP routes the library serves, as OpenAPI 3.1

## License

**[Apache-2.0](https://github.com/filelayer/filelayer/blob/main/LICENSE).**
Commercial use, modification, distribution and private use are permitted, with
an express patent grant and a patent-retaliation termination clause. You must
preserve the copyright and licence notices and state significant changes; there
is no copyleft obligation on your own code.

```
SPDX-License-Identifier: Apache-2.0
Copyright 2026 Technology Pro Bono S.L.
```

`LICENSE` is the unmodified licence text from apache.org.
[`NOTICE`](https://github.com/filelayer/filelayer/blob/main/NOTICE) carries the
attribution notice required by section 4(d); both are inside the published npm
tarball, so the grant travels with the artifact rather than only with the
repository. There are no per-file licence headers — the grant is carried by
`LICENSE`, `NOTICE` and the `license` field of every `package.json`.

**Dependencies.** Filelayer has **no runtime dependencies**. Its one third-party
package, [`@electric-sql/pglite`](https://github.com/electric-sql/pglite)
(Apache-2.0), is a `devDependency` and an *optional peer dependency*: the test
suite and `quickstart()` run on it, and a production install does not contain
it. It is installed from the registry rather than vendored, ships no `NOTICE`
file of its own, and is recorded in ours for convenience. No third-party code is
copied or embedded anywhere in this repository.

## Contributing, security and conduct

- [`CONTRIBUTING.md`](https://github.com/filelayer/filelayer/blob/main/CONTRIBUTING.md)
  — how to set up, what `npm run verify` covers, and what a pull request needs.
- [`SECURITY.md`](https://github.com/filelayer/filelayer/blob/main/SECURITY.md)
  — **report vulnerabilities privately**, never as a public issue. Includes our
  disclosure timetable and what is in and out of scope.
- [`CODE_OF_CONDUCT.md`](https://github.com/filelayer/filelayer/blob/main/CODE_OF_CONDUCT.md)
  — Contributor Covenant 2.1.

Bugs, questions and "this document is wrong" reports go to
[GitHub Issues](https://github.com/filelayer/filelayer/issues). Given the alpha
status at the top of this page, a report that the product does not do what this
README says is the most valuable thing you can send us.

## Limitations

Restated here so they are not only in an appendix. Each one is current as of
`0.4.2`; where a limitation has been lifted since an earlier release, the
[changelog](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md) says so.

1. **No `Range` responses from the shipped HTTP routes.** `fileDownloadRoute()`
   and `shareDownloadRoute()` do not parse the `Range` request header, so they
   never return `206` and a browser cannot seek. Do not use the shipped routes
   for video or audio. The layer underneath is complete: `readStream()` and
   `redeemStream()` take a byte range, the S3 adapter honours it, and
   `sendNodeStream()` / `toStreamResponse()` emit `206` with `Content-Range`
   whenever a range was served. Parsing the request header is the part you
   write — see
   [QUICKSTART §6](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md)
   for the whole thing.
2. **The tiered facade `fl.files.put()` takes a `Uint8Array`**, so a file put
   through it is fully resident in memory. The core `fl.upload()` accepts a
   `ReadableStream`; use that above a few tens of megabytes.
3. **No direct browser → storage upload.** Upload bytes go through your server.
4. **Org admins and owners can read `private` files.** Deliberate — retention
   and legal hold are their responsibility — but if you need to exclude the
   operator, you need envelope encryption and we do not have it.
5. **Identifiers are unique per *project*, not per org.** `actor.external_id`
   and `org.external_id` are scoped to a project (one customer application). Two
   orgs inside one project cannot both have a user called `alice` meaning
   different people.
6. **The S3/R2 adapter has never run against live credentials.** It is tested
   against a local implementation that verifies SigV4 signatures, which is not
   the same thing.
7. **Unauthenticated callers can still append denial events to the audit chain
   of a tenant inside a project they can reach.** That is P5 working as designed
   — denials are the events worth recording — but it is a load-bearing reason to
   rate-limit at ingest. `orgExists` is project-scoped, so the reach is bounded
   to a project the caller is already authenticated for.
8. **Orphan collection is a job you have to run.** Bytes are written before the
   metadata commits, so a crash in between leaves an unreferenced object.
   `collectStorageOrphans()` cleans them up and nothing calls it for you.
9. **Redirect delivery has a revocation window.** If you enable it, a presigned
   URL stays valid for up to its TTL after the grant is revoked. It is off by
   default, defaults to anonymous grants only, and requires passing a verbatim
   acknowledgement string. That string is the point.
