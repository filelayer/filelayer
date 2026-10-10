# Filelayer

[![CI](https://github.com/filelayer/filelayer/actions/workflows/ci.yml/badge.svg)](https://github.com/filelayer/filelayer/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@filelayer/core.svg)](https://www.npmjs.com/package/@filelayer/core)
[![node](https://img.shields.io/node/v/@filelayer/core.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/filelayer/filelayer/blob/main/LICENSE)

<!-- Every URL on this page is rooted at github.com/filelayer/filelayer and
     npmjs.com/package/@filelayer/core, so the badges resolve on their own with
     no edit here. -->

> **Alpha — developer preview, not production software.** Nobody is running it
> in production, including us. [**Should you depend on this?**](https://github.com/filelayer/filelayer/blob/main/TRUST.md)
> has the real numbers, including the ones that are zero, and exactly what would
> change them. [Limitations](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md) is the complete list of what it
> does not do.
>
> **We are looking for three to five design partners.** If you are building
> something with private user files, we will help you integrate this and stay on
> hand while you do, in exchange for telling us where it breaks. That is the only
> thing on our [roadmap to 1.0](https://github.com/filelayer/filelayer/blob/main/ROADMAP.md) we cannot build ourselves.
> [Open an issue](https://github.com/filelayer/filelayer/issues) or say hello.

**The file layer for SaaS applications.** Public files and private files, with
one authorization model behind both.

You tell Filelayer who the caller is. Filelayer decides what they may do with a
file, serves the bytes with the right headers, and writes the audit event. For
file access that goes through Filelayer, that decision is made in one place,
`packages/core/src/authz.ts`, so you write no ownership checks in route
handlers, no presigned-URL expiry logic, and no per-route access rules of your
own.

**Filelayer is authorization middleware, not row-level security.** It runs in
your application process, in front of Postgres and your bucket. Code that
queries these tables directly does not go through it. The schema does enforce a
set of invariants against *every* writer: cross-tenant grants, cross-project
identities, and delegation that amplifies authority or subject breadth are
refused by constraints and triggers, so a migration or a `psql` session cannot
write them. But there is no RLS policy in `schema.sql`, and a direct `SELECT` is
not filtered by anything. If you need enforcement that survives arbitrary
database clients, use database-level enforcement; Filelayer is the layer above
it, and the two compose.

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
| The suite | **649 tests**, every commit, all of them against a real PostgreSQL |
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
2. **Read cost is linear in grants per subject, and nothing caps them.**
   Measured: 4.3 ms at five grants on one file, 5.9 seconds at a hundred
   thousand. `shares.create()` is not idempotent, so a share endpoint that
   inserts on every click gets there. Use `shares.unshare()` and watch the
   count.
3. **No resumable or multipart upload.** One signed PUT, one object. A large
   upload that fails starts over, and `fl.files.put()` holds the whole body in
   memory -- only the core `fl.upload()` takes a stream, and neither imposes a
   size ceiling, so that is yours to enforce.
4. **Org admins and owners can read `private` files.** Deliberate: retention
   and legal hold are useless if the people accountable for them cannot see
   what they are holding. But it is a policy decision, and if you need to
   exclude the operator you need envelope encryption, which we do not have.
5. **Alpha, and the schema has changed six times.** Any `0.x` → `0.(x+1)` may
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

### Where the bytes go

Three adapters, and the one you want depends on whether you have a bucket:

| | |
|---|---|
| `new MemoryStorage()` | A Map. Dies with the process. For tests. |
| `new FsStorage('./data')` | A real directory. Survives a restart, needs no bucket and no IAM user. One process on one disk: no locking between writers, and no `presignGet`, so redirect delivery is unavailable and `canPresign()` says so before a request rather than during one. |
| `new S3Storage({ endpoint, bucket, region, accessKeyId, secretAccessKey })` | S3 or R2. The one to use the moment you run two application servers. |

`FsStorage` exists because we measured the gap: an agent integrating the
published package, reading only the published documentation, wanted bytes that
survive a restart without creating a bucket, found nothing between a Map and
IAM credentials, and wrote the adapter itself from the type definitions.

Production is three configuration steps and is not hidden: your Postgres,
somewhere for the bytes, and — if you chose a bucket — confirming it is private.
[`examples/starter/`](https://github.com/filelayer/filelayer/tree/main/examples/starter)
is all three in one file you can copy, and
[`docs/QUICKSTART.md`](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md)
§7 is the prose version.

### Checking a deployment from a terminal

```bash
npx filelayer doctor          # Node, DATABASE_URL, and what state the schema is in
npx filelayer schema status   # just the schema, with --json for a script
```

Both are read-only. Every problem comes with a line saying what to do about it,
and `--json` gives an agent the same findings in a shape it can branch on.

Two things it will not do, both on purpose. **It takes no credential as an
argument** — there is no `--database-url`, and passing one is an error rather
than being ignored, because a credential on a command line is written to shell
history, visible in `ps`, and echoed by most CI systems. And **it has no
`share`, `download` or `delete`**: reading `DATABASE_URL` is complete authority
over every file and grant, so the CLI cannot enforce permissions and does not
pretend to. A convincing permission check layered on root access is worse than
none, because it reports that something was authorized when nothing was.

With `S3_ENDPOINT` and `S3_BUCKET` set, `doctor` also reports whether the bucket
serves an **unauthenticated** read, which is the most common way everything here
gets undone: Filelayer decides who may be *given* a URL and has no say in who
the object store will answer. The probe writes nothing and uses no credential —
an unsigned GET of a key that does not exist is refused by a private bucket and
answered honestly by a public one — so a check that cannot read a credential
cannot leak one. With those variables unset it says the bucket was not checked
rather than saying nothing.

A refusal is evidence about the bucket root only: a policy that opens one prefix
answers identically and is still public where it matters. And none of this says
whether your credentials work, which needs a signed request and is not here
yet.

`pg` is an optional peer dependency: the CLI is the only part of this package
that needs a driver, and it asks for it by name at runtime.

### An Agent Skill, which ships in the package

If a coding agent is going to do the integration, there is a skill for it:

```bash
mkdir -p .claude/skills
cp -r node_modules/@filelayer/core/skills/filelayer-integration .claude/skills/
```

Committed under `.claude/skills/` it applies to every session in that
repository, so a colleague's agent gets it too. `~/.claude/skills/` instead
makes it personal to one machine.

**Copy it out of your own `node_modules`, not out of a repository.** The copy
in the package carries the version it describes and cannot drift from what you
installed; a copy taken from the default branch describes whatever is newest,
which may be API your version does not have. A build gate keeps the shipped
copy byte-identical to the one here and keeps its version stamp current.

What it does: decides out loud whether a library is the right answer at all,
finds out what the project already has, picks the API tier, mounts the handler
that matches the runtime, and then proves the result with `auditIntegration()`
rather than declaring success. Graded blind against the same scenarios with and
without it, it scored 23/24 against 13/24; the numbers, what they do not
establish, and the mistakes found while measuring are in
[`skills/filelayer-integration/evals/MEASUREMENT.md`](https://github.com/filelayer/filelayer/blob/main/skills/filelayer-integration/evals/MEASUREMENT.md).

### Serving the bytes

Authorizing a read is not the same as answering the request, and this page used
to stop at the first one. Two handlers do the second, and which one you want is
decided by your runtime, not by preference:

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

### Uploading straight to the bucket

For files measured in hundreds of megabytes, `createUpload()` mints a presigned
PUT so the bytes never travel through your process:

<!-- doccheck: skip reason="direct upload is opt-in and needs a storage adapter that can sign plus the verbatim acknowledgement; the throwaway instance on this page has neither, by design" -->
```ts
const { file, upload } = await fl.createUpload(principal, orgId, {
  name: 'recording.mp4',
  contentType: 'video/mp4',
  size: declaredSize,            // required and exact
});
// the client PUTs to upload.url with upload.headers, then:
const ready = await fl.completeUpload(principal, file.id);
```

A presigned PUT signs the method, the key and the expiry, and **does not
constrain the body**: a URL minted for a 200 KB avatar accepts three gigabytes.
`createUpload()` signs `content-length` and `content-type` into the credential
so the object store rejects the wrong size or type before accepting it, which on
Cloudflare R2 is the only way to bound the body at all. Until
`completeUpload()` succeeds the row is `pending` and refuses `read`, and
`completeUpload()` asks the store what arrived rather than believing the client.

It is off until the configuration carries the verbatim
`DIRECT_UPLOAD_ACKNOWLEDGEMENT` string, and `maxUploadBytes` has no default.
Below a few tens of megabytes `fl.files.put()` is simpler and strictly safer,
because you see the bytes.

### Letting an agent operate it

`@filelayer/core/mcp` builds an MCP server over an instance, so an agent can
answer "which contracts can Alice see", "share this one with the external
accountant for two weeks", "take that back" — through the same authorization
code path as your HTTP routes, with no second set of rules to keep in agreement.
You construct it and you run it; there is nothing hosted and nothing to sign up
for.

<!-- doccheck: skip reason="it connects a server to stdio and never returns, and it imports the MCP SDK, which is an optional peer this checker does not install" -->
```ts
import { filelayerMcpServer } from '@filelayer/core/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = await filelayerMcpServer(fl, {
  as: 'user_partner_alice',          // fixed here, not a tool argument
  org: 'org_acme',
  agentLabel: 'acme-assistant/1.0',  // how the audit trail names the agent
});
await server.connect(new StdioServerTransport());
```

**The subject is fixed at construction.** It is not a tool parameter and no
tool changes it, because the obvious design — a `user` argument on every call —
lets the agent choose who it is, which makes every permission check advisory. An
MCP server that can act as anyone is an admin backdoor with a schema. One server
speaks for one subject in one organisation; serving several people means
constructing several servers, and that cost is the property.

Seven tools by default: list files, describe one, list its grants, share with a
person, create a link, revoke one grant, remove a person entirely. Expiry is
required on both sharing tools, because a permanent grant is a decision a person
should make. Each tool declares `readOnlyHint` and `destructiveHint` so a client
can gate the ones that write. Failures come back as the stable error `code` with
the `meaning` and `fix` from the catalogue, and never with `reason`.

Three things are off by default, each for its own reason: `allowDestructive`
(deleting is not recoverable), `returnFileBytes` (a document returned by a tool
is a document copied into a model's context), and `exposeAuditTrail` — because
reading the trail is the one act Filelayer does not itself record, so an agent
could read an organisation's whole history and leave nothing behind
([`LIMITATIONS.md`](https://github.com/filelayer/filelayer/blob/main/LIMITATIONS.md)
entry 16).

This module is the only part of the package with dependencies, and they are
optional peers, so the install above stays at zero:

```bash
npm install @modelcontextprotocol/sdk zod
```

`zod` is not a preference: the SDK accepts Zod schemas for a tool's inputs and
nothing else. Calling the factory without either one throws and names what is
missing and the command.

Every call made through these tools records `agentLabel` as the audit event's
user agent, which is what lets the chain separate "the partner opened this" from
"the partner's assistant opened this". Those are different facts and until
`0.21.0` the library had nowhere to put the difference.

If you want a server a client can simply start, there is a second binary that
builds the instance from the environment:

```json
{
  "mcpServers": {
    "filelayer": {
      "command": "npx",
      "args": ["-y", "@filelayer/core", "filelayer-mcp"],
      "env": {
        "DATABASE_URL": "postgres://...",
        "FILELAYER_AS": "user_alice",
        "FILELAYER_ORG": "org_acme",
        "FILELAYER_DATA_DIR": "/srv/filelayer-data"
      }
    }
  }
}
```

`FILELAYER_AS` comes from whoever configures the client, never from a
conversation — one process speaks for one subject, and many users means a server
per user. With neither `FILELAYER_DATA_DIR` nor `S3_ENDPOINT` set it refuses to
start rather than falling back to memory, which would work in a demo and lose
the first real file. The three tools above stay off unless the matching
`FILELAYER_MCP_*` variable is exactly `true`.

[`examples/mcp/`](https://github.com/filelayer/filelayer/tree/main/examples/mcp)
is a server you can launch and a script that drives it the way a client does:
it spawns the server as a subprocess and exchanges protocol frames over its
real stdin and stdout, in 27 checks that CI runs against a freshly packed
tarball on every commit.

### Errors, and proving the integration

Everything throws `FilelayerError`, carrying `status`, a typed `code`, an
internal `reason` that must never be serialized, and `headers` where a status is
defined in terms of one. **The status is a function of the code**, so branching
on `code` never means also branching on `status`.

```ts
import { FilelayerError } from '@filelayer/core';

async function readOrRespond(id: string, as: string): Promise<Response> {
  try {
    const file = await fl.files.get(id, { as });
    return new Response(JSON.stringify({ id: file.id }), { status: 200 });
  } catch (e) {
    if (!(e instanceof FilelayerError)) throw e;
    return new Response(JSON.stringify({ error: e.code }), {
      status: e.status,
      headers: { 'content-type': 'application/json', ...(e.headers ?? {}) },
    });
  }
}

// A file that is not there, and a caller who may not know that:
const denied = await readOrRespond('00000000-0000-0000-0000-000000000000', 'user_123');
console.assert(denied.status === 404, 'a stranger gets 404, never 403');
```

There are 29 codes. The full table ships in the package as `ERRORS.md` and
machine-readably as `errors.json`, both resolvable from an install
(`@filelayer/core/errors.json`), both generated from the source, and a build
gate fails if they drift. `ERROR_CODES` and `isErrorCode()` are exported for
narrowing a code that arrived as a string.

`auditIntegration()` then checks **your** routes rather than ours. You give it
an owner, a stranger and four callbacks onto your own endpoints, and it drives
them over HTTP:

<!-- doccheck: skip reason="it drives an application over HTTP; there is no application here, and inventing one would check this library rather than the reader's" -->
```ts
import { auditIntegration, formatAuditReport } from '@filelayer/core';

const report = await auditIntegration({ owner, stranger, app });
console.log(formatAuditReport(report));
```

It is there because the library being correct and the integration being correct
are different claims, and the second one is the one your users depend on. It
checks, among other things, that a stranger gets `404` and not `403` — a `403`
confirms the file exists and turns your ids into an enumeration oracle, and an
application error handler that helpfully maps `not_found` back to a `403` undoes
the property the library was providing.

### Running the suite

The tests are in the tarball but they cannot be executed from inside
`node_modules`: Node refuses to strip types from files under `node_modules`, and
the tests import the TypeScript source directly. To run them, clone the
repository. Tests run against PGlite, PostgreSQL 17 compiled to WebAssembly and
running in-process, so there is no daemon and no Docker:

```bash
git clone https://github.com/filelayer/filelayer && cd filelayer
npm run bootstrap        # npm ci in packages/core
npm test                 # the security property suite, 649 tests
npm run typecheck
npm run verify           # typecheck + tests + build + doc and language checks
npm run example:tier1    # a public avatar, on :3000
npm run example:vault    # the full Vault app, on :8787
npm run example:starter  # a deployable server against your own Postgres
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

**The schema has changed six times**, not once. This section said "one breaking
change (per-project identifier namespaces)" until `0.15.0`, counting the first
and largest; `MIGRATIONS.md` has ten numbered entries of which six carry
forward SQL. Budget an upgrade against that file, not against this paragraph —
the discrepancy was found by an outside analyst reading only the published
package, and it was understating the cost of adopting us.

**Which version a database is at is now readable off the database.** Since
`0.15.0` `schema.sql` creates `filelayer_schema_version` and stamps it, and
`schemaStatus(db)` reports where a database is, what this build expects, and
which files under `migrations/` are outstanding. It issues no DDL: your
application owns the migration runner, which is the position
[`MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md)
§2 has always taken and is keeping.

<!-- doccheck: skip reason="takes the `pg.Pool` you own; `pg` is deliberately not a dependency of this package, so there is nothing here to construct one from" -->

```ts
import { schemaStatus } from '@filelayer/core';
const s = await schemaStatus(pool);   // { state: 'current', at: 10, expects: 10, ... }
```

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
- [`docs/guides/`](https://github.com/filelayer/filelayer/tree/main/docs/guides) — answers to
  questions people actually ask, written to be useful whether or not you use this
  library. The code in them is executed in CI.
  Four so far: why a presigned URL cannot be taken back, why a presigned PUT
  does not limit what gets uploaded, why Row-Level Security does not stop a
  cross-tenant grant from being written, and why the job that reclaims orphaned
  objects is the most dangerous one in the system.
- [`packages/core/SEMANTICS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/SEMANTICS.md) — the exact behaviour of every edge: liveness, delegation, deletion, the audit chain
- [`packages/core/MIGRATIONS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md) — how schema changes are delivered and what the pre-1.0 compatibility promise is
- [`packages/core/CHANGELOG.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/CHANGELOG.md) — the real history, including the security defects we found in ourselves
- [`ARCHITECTURE-PROGRESSIVE.md`](https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md) — the tier model, lines of code versus the alternatives, and where we lose
- [`architecture/TIER5-DESIGN-NOTE.md`](https://github.com/filelayer/filelayer/blob/main/architecture/TIER5-DESIGN-NOTE.md) — large files, streaming, range requests, CDN
- [`llms.txt`](https://github.com/filelayer/filelayer/blob/main/llms.txt) — the same map, written for an agent implementing an integration
- [`openapi.yaml`](https://github.com/filelayer/filelayer/blob/main/openapi.yaml) — the two HTTP routes the library serves, as OpenAPI 3.1

Every link above points at GitHub, and an installed consumer may have no network
and no browser. The npm package therefore carries the same files on disk, under
`node_modules/@filelayer/core/`: this README, `docs/QUICKSTART.md`, `llms.txt`,
`openapi.json`, `schema.sql`, `SEMANTICS.md`, `MIGRATIONS.md`, `CHANGELOG.md`,
`LICENSE` and `NOTICE`, alongside `src/`, `test/` and `examples/`. Three of them also resolve as subpath
imports: `@filelayer/core/llms.txt`, `@filelayer/core/openapi.json` and
`@filelayer/core/schema.sql`, so a reader does not have to guess at the layout
of `node_modules`.

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
repository. There are no per-file licence headers. The grant is carried by
`LICENSE`, `NOTICE` and the `license` field of every `package.json`.

**Dependencies.** Filelayer has **no runtime dependencies**, and a job in CI
fails the build if one appears. Its third-party packages are all
`devDependencies`: [`@electric-sql/pglite`](https://github.com/electric-sql/pglite)
(Apache-2.0), which is also an *optional peer dependency* and is what
`quickstart()` and most of the suite run on, plus `pg` and `embedded-postgres`
for the eight contention tests that need a server with two real backends. A
production install contains none of them. It is installed from the registry rather than vendored, ships no `NOTICE`
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
[GitHub Issues](https://github.com/filelayer/filelayer/issues). A report that
the product does not do what this README says is the most valuable thing you can
send us, and every one so far has been fixed the same day.
