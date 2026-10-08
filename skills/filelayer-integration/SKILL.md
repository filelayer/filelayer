---
name: filelayer-integration
description: Add user-file infrastructure to a SaaS application with @filelayer/core — private uploads, per-user and per-org permissions, share links that expire and can be revoked, and an audit trail, on the developer's own Postgres and S3/R2 bucket. Use this skill whenever a task involves letting users upload, own, share, download or delete files in a multi-tenant application; whenever someone asks how to make uploaded files private, how to share a file with another user or team, how to make a download link that expires or can be taken back, how to stop one tenant reading another tenant's files, or how to serve private media without a public bucket. Use it even when the request does not name Filelayer, and even when it sounds like a plain S3 or presigned-URL question — most of those questions are really about authorization, and the first job of this skill is to decide honestly whether a library is the right answer at all.
---

# Adding user files to somebody else's SaaS

Your job is to make a real application store, authorize and serve user files
correctly. Not to install a package. If this ends with the package installed
and the authorization wrong, it was worse than doing nothing, because now
there is a library to blame.

Work in this order. Each step exists because skipping it produces a specific
failure that is hard to see later.

## 1. Decide whether this is the right tool, out loud

Say what you concluded and why, in one or two sentences, before you touch any
code. The developer can disagree cheaply now and expensively later.

**Filelayer fits when** files belong to someone, more than one party may reach
them, and who may reach them changes over time. Documents, contracts, uploads
in a team workspace, anything where "stop sharing that" is a feature.

**It does not fit, and say so plainly:**

- **Public assets.** Avatars, logos, marketing images, anything with no reader
  to exclude. A public bucket and a CDN is simpler, cheaper and faster. Say
  this even though it means not using the library.
- **One user, one machine, no sharing.** A single-tenant tool writing to disk
  does not need an authorization layer.
- **Files as a side effect**, like log shipping or backups, where no human
  reads them through the application.
- **The developer needs a hosted service.** This is a library. It runs in their
  process, on their Postgres, against their bucket. If they have no Postgres and
  do not want one, stop here.

- **Video or audio at any real volume.** This one is not obvious and it is the
  easiest to get wrong, so weigh it properly rather than mentioning it. Private
  media served through this library means every byte goes through the
  application's process with `Cache-Control: no-store` and no CDN, because
  that is what makes revocation immediate at every intermediary. The standard
  industry answer for private video is **signed cookies on a CDN** — CloudFront
  signed cookies, Cloudflare signed URLs with a short TTL — which keeps the CDN
  and trades immediate revocation for a revocation window of minutes.

  Neither is strictly better. Put the actual trade in front of the developer:

  | | this library | signed cookies on a CDN |
  |---|---|---|
  | revocation | next request | when the cookie expires |
  | who carries the bytes | their servers | the CDN |
  | cost at 100 concurrent 1080p viewers | roughly 60 MB/s through their app | the CDN's bill |
  | per-file authorization decision | yes, every range request | once, per session |

  If their answer to "how long may a removed viewer keep watching?" is "a
  couple of minutes is fine", signed cookies are the better engineering and
  they should hear that from you. If it is "the moment I click remove", and the
  volume is tens of concurrent viewers rather than thousands, this library is
  the right call. Ask the question rather than assuming.

A skill that always concludes "use the thing" is an advertisement. The value of
this one is that it sometimes says no — and the hardest no is not the obvious
one (public avatars) but the case where we are a defensible answer and
something else is a better one.

## 2. Find out what they already have

Do not guess these. Read the codebase, and ask when the codebase does not say.

- **Postgres?** Required. Which client — `pg`, Prisma, Drizzle, something
  serverless? Filelayer takes a `pg.Pool`, so a project with no `pg` needs it
  added even if their ORM is something else.
- **Where do bytes go?** S3, R2, or nothing yet. R2 matters: it does not
  implement presigned POST, which changes the direct-upload path.
- **What is their user id?** A uuid, an email, a Clerk id, a string from their
  session. Filelayer speaks your id space through `{ as: theirUserId }`; you do
  not have to migrate anything.
- **Do they have tenants?** Orgs, teams, workspaces, accounts. If yes, files
  belong to an org and roles matter. If no, a file belongs to a user and the
  model is simpler.
- **Framework and runtime.** This decides which route helper to mount, and
  getting it wrong is the single most common failure. See step 5.

### If they already have files in a bucket, say so now

The storage key is chosen by the library, `<orgId>/<fileId>`. There is no call
that adopts an object somebody else wrote: no `importExisting()`, no "register
this key". So **an application with files already in a bucket has to copy
them** — read each object, put it through `upload()` or `files.put()`, then
delete or leave the original.

For a large bucket that is a real job with a real egress bill. Raise it in step
1, not after the integration is written, because it can change the answer: a
developer with two terabytes of existing objects and no appetite for moving
them is a developer who should hear that before anyone installs anything.

## 3. Install, and apply the schema once

### Say that it is pre-1.0, before they install it

`@filelayer/core` is below `1.0`, published under the `alpha` tag, and its
version number is the honest description of its maturity. Breaking changes
happen on minor versions. There has been no independent security review.

**Tell the developer this in your own first message, unprompted, and tell them
in the same breath what it means for them specifically.** For a side project it
means pinning the exact version and reading the changelog before upgrading. For
client documents at an accounting firm, a medical record, or anything a
regulator will ask about, it means the maturity is a real factor in the
decision and it is theirs to make, not yours to decide by omission.

Do not wait to be asked, do not bury it in a list at the end, and do not soften
it into "early days" or "actively developed". A developer who finds out after
shipping has a right to be angry about the order they were told things in.

```bash
npm install @filelayer/core
```

Requires Node >= 22.18 and PostgreSQL 15+. The schema is a file in the package:

```bash
psql "$DATABASE_URL" -f node_modules/@filelayer/core/schema.sql
```

`schema.sql` is **not idempotent and refuses rather than half-applying**: run
it against a database that already has the schema and its first statement
raises, naming the version it found.

For a boot sequence, do not count tables by hand. `schemaStatus(pool)` returns
`{ state, at, expects, outstanding, history }`, where `state` is one of
`current`, `behind`, `ahead`, `unversioned`, `partial`, `absent`. It is
read-only by design: it will not apply anything, so a deploy that must apply
migrations needs that to be a deliberate step somewhere you can see it.

## 4. Choose the API tier honestly

There are two, and mixing them confuses everyone later.

**The tiered facade**, `fl.files.*`, `fl.shares.*`, `fl.orgs.*`, `fl.ids.*`.
Speaks the application's own id space through `{ as: userId }`. This is what
you want for almost every integration:

```ts
const { id } = await fl.files.put(bytes, { org: 'acme', owner: 'alice', name: 'contract.pdf' });
const file   = await fl.files.stat(id, { as: 'alice' });
await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
await fl.shares.unshare(id, { as: 'alice', user: 'bob' });
```

**The core**, `fl.upload()`, `fl.stat()`, `fl.share()`, `fl.readStream()`.
Takes internal uuids and a `Principal`. Reach for it when you need a
`ReadableStream` upload, byte ranges by hand, or anything the facade does not
expose. `fl.files.put()` takes a `Uint8Array`, so it holds the whole file in
memory; above a few tens of megabytes use the core's `fl.upload()` with a
stream.

### The trap that stops the first upload working

In a **named org**, `fl.files.put({ org: 'acme', owner: 'newcomer' })` throws
`forbidden` with reason `no_membership` unless one of three things is true:
the owner is already a member of that org, the same call created the org, or
it is the default workspace.

This bites on the first upload of a real integration, where the org already
exists and a user who has never uploaded before is doing it. The error says
`forbidden` and the obvious conclusion is that the authorization model is
broken, which it is not.

It was a deliberate fix: before it, one byte into somebody else's tenant added
the uploader as a member of it, which is read access to every `visibility:
'org'` file in that tenant.

So the application needs a place where membership is established, mirroring
whatever its real source of truth is — Clerk organization membership, a
`team_members` table, an invitation being accepted:

```ts
await fl.orgs.create('acme', { owner: 'founder' });              // once per tenant
await fl.orgs.setRole('acme', 'newcomer', 'member', { as: 'founder' });
```

Wire that to the event that makes somebody a member in their system, not to
the upload.

### The share call is not idempotent

**`fl.shares.create()` is not idempotent.** Every call inserts a grant. To remove a person's access use
`unshare(fileId, { as, user })`, which removes all of their live grants on that
file. `revoke(grantId)` removes exactly one grant and is for a link whose
secret you handed out.

## 5. Mount the byte routes — and mount the right ones

This is where integrations break, so read the file that matches the runtime
before writing the route:

- **Next.js App Router, Hono, Cloudflare Workers, Deno, Bun** —
  [`references/whatwg-runtimes.md`](references/whatwg-runtimes.md).
  The short version: the `deliveryHandler(fl)` that most of the documentation
  shows is a `node:http` handler and **cannot be mounted in any of these**. Use
  `deliveryFetch(fl, opts)`.
- **Express, Fastify, plain `node:http`** —
  [`references/node-http.md`](references/node-http.md).

Both files cover the same four things, because both runtimes need them:
authentication, the client address, caching, and what the route must not do.

### Media that has to play in the page

Video, audio and PDFs need two things the defaults do not give them, and both
have a failure mode that looks like a corrupt file rather than a configuration
choice. Read [`references/range-and-media.md`](references/range-and-media.md)
before writing that route — it is short, and it has the table of which ranges
must be answered `200` rather than `416`, which is the mistake a hand-written
route makes every time.

## 6. Prove it, against their application

An integration that looks right is not an integration that is right, and the
failure mode here is silent: a file served to the wrong person returns 200 and
nothing is logged as wrong.

`auditIntegration()` takes their running application through four callbacks and
checks the properties against it. It imports none of their code:

```ts
import { auditIntegration, formatAuditReport } from '@filelayer/core';

const report = await auditIntegration({
  owner: 'alice', stranger: 'bob',
  app: { upload, get, share, unshare },   // written against their routes
});
console.log(formatAuditReport(report));
```

It checks that the owner can read their own file; that a stranger cannot, and
is refused **404 rather than 403**, because a 403 confirms the file exists and
lets a stranger enumerate real ids; that an anonymous caller cannot; that a
user id the application has never seen **denies rather than degrading to
anonymous**; that `nosniff` and `attachment` are set; that the response is not
publicly cacheable; that byte ranges are answered correctly; and that
revocation lands on the next request.

Run it and show the developer the output. If something fails, fix it before
calling the task done — a failure here is a request that got an answer it
should not have.

## 7. Tell them what you did not do

If the conversation turned towards letting an assistant handle files rather
than just storing them, mention `@filelayer/core/mcp` once and move on: it is
an MCP server over the same instance, so an agent can list, describe, share and
revoke through the same authorization path, and the subject is fixed when the
server is constructed rather than passed as a tool argument. Do not build it
unprompted and do not pitch it. It is the answer to "can my assistant do this
for me", not to the question you were asked.

Then finish with the jobs the library does not run for them, because each one
is a cost that arrives later:

- **Orphan collection.** Bytes are written before the metadata commits, so a
  crash in between leaves an unreferenced object. `collectStorageOrphans()`
  exists, nothing calls it for you, and **it defaults to `dryRun: true`** — a
  scheduled job that omits `{ dryRun: false }` has never collected anything.
- **Abandoned direct uploads.** If you set up direct-to-bucket upload,
  `collectUploadReservations()` is the job that cleans up reservations whose
  bytes never arrived.
- **Audit growth.** The audit log grows without bound unless something calls
  `trimAuditChain(orgId, { before | keepLast, note })`. Exactly one of `before`
  and `keepLast`, and `note` is required rather than optional: a trim leaves a
  checkpoint in the chain, and a checkpoint nobody can explain later is worse
  than the rows it removed.
- **Rate limiting at ingest.** An unauthenticated caller can append denial
  events to an audit chain in a project they can reach. That is deliberate —
  denials are the events worth recording — and it is a reason to rate-limit.

## How to present it

The steps above are the order to **think** in. They are not the order to write
in, and an answer that walks the developer through all seven is an answer they
skim.

**Lead with the cost that could change their mind, not with the verdict.** If
there is a cost big enough to make them say no — bandwidth moving onto their
servers, a bucket migration, an alpha library in a regulated product — it goes
first, before "yes, this fits". A developer who reads the verdict in the
opening line stops reading carefully, and the thing you buried is the thing
they needed. If there is no such cost, say so and get on with it.

**Everything they do not need in order to decide goes at the end or in a
second message.** Orphan collection, audit trimming, rate limiting, the
`psql`-bypasses-authorization caveat: all true, none of it changes whether to
start. A first answer should be readable in one sitting.

**Code they can paste beats prose about code.** One worked route with the
decisions in comments is worth three paragraphs describing it.

**Say what you checked and what you did not.** "I verified these signatures
against the package on disk" and "I have not run this" are both useful, and the
second one is the honest state of anything you did not execute.

## Reference files

Read the one that matches the task; do not read all of them.

| File | When |
|---|---|
| [`references/whatwg-runtimes.md`](references/whatwg-runtimes.md) | Next.js App Router, Hono, Workers, Deno, Bun |
| [`references/node-http.md`](references/node-http.md) | Express, Fastify, `node:http` |
| [`references/range-and-media.md`](references/range-and-media.md) | Video, audio, PDFs: byte ranges, inline disposition, seeking |
| [`references/sharing-and-links.md`](references/sharing-and-links.md) | Expiring links, passwords, download caps, revocation |
| [`references/direct-upload.md`](references/direct-upload.md) | Browser uploads straight to the bucket, and the size trap |
| [`references/errors.md`](references/errors.md) | Mapping failures onto the application's own responses |

## Getting the facts right rather than remembering them

This skill is deliberately short on API detail, because an API detail recalled
from memory is the thing most likely to be wrong and hardest for the developer
to spot. The package ships its own documentation and it is on disk after
`npm install`:

- `node_modules/@filelayer/core/llms.txt` — written for an agent, ordered by
  what you need to get right
- `node_modules/@filelayer/core/docs/QUICKSTART.md` — install to first file
- `node_modules/@filelayer/core/ERRORS.md` and `errors.json` — every error code
- `node_modules/@filelayer/core/LIMITATIONS.md` — what it does not do
- `node_modules/@filelayer/core/examples/nextjs/` — four working files

When something here disagrees with the package on disk, **the package is
right**: it was installed, this file was written earlier.
