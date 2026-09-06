# Filelayer Quickstart

Simple first. Each section adds **one** concept. Stop reading at whichever
section solves your problem — nothing later is required to make anything earlier
work.

If you are an AI agent implementing an integration: every TypeScript block on
this page is extracted and **executed** by `tools/check-doc-samples.mjs`, which
runs in CI on every push. Two blocks are marked as skipped in the markdown
source, each with a stated reason. Runnable examples of the same shapes live in
`examples/tier1-avatar/`, `examples/tier2-user-files/`,
`examples/tier3-org-roles/` and `examples/vault/`. If a snippet here disagrees
with the test suite, the test suite is right and this page is a bug.

**Contents**

0. [Install](#0-install)
1. [Tier 1 — a public file](#1-tier-1--a-public-file)
2. [Tier 2 — a private, user-owned file](#2-tier-2--a-private-user-owned-file)
3. [Tier 3 — organizations and roles](#3-tier-3--organizations-and-roles)
4. [Tier 4 — sharing, expiry, caps, revocation, audit](#4-tier-4--sharing-expiry-caps-revocation-audit)
5. [Listing what a caller may see](#5-listing-what-a-caller-may-see)
6. [Serving bytes](#6-serving-bytes)
7. [Going to production](#7-going-to-production)
8. [Errors](#8-errors)
9. [What Filelayer does not do](#9-what-filelayer-does-not-do)

---

## 0. Install

**Requirements:** Node ≥ 22.18. Nothing else — no Docker, no Postgres daemon for
development.

```bash
npm install @filelayer/core
```

That pulls in nothing else: the package has **no runtime dependencies**. It
talks to your Postgres through whatever driver you already use (`pg.Pool` works
directly) and to your bucket over HTTP.

The throwaway instance in the next block is the exception. `quickstart()` runs on
PGlite, an embedded WebAssembly Postgres, which is declared as an **optional peer
dependency** — a library whose premise is "point it at your own Postgres" should
not put a second Postgres into every production install. Install it too if you
want `quickstart()` or `createTestDb()`:

```bash
npm install --save-dev "@electric-sql/pglite@^0.3.11"
```

Keep the version constraint. Filelayer supports the **0.3.x** line of PGlite —
that is what `peerDependencies` declares and what the suite runs against — and
**0.5.x is not supported**: the suite was run against 0.5.8 and does not pass, so
the range was left alone. PGlite's `latest` on npm is a 0.5.x release, so a bare
`npm install` of it can pick a version outside the range and npm will then refuse
the install with `ERESOLVE`. The quotes are for your shell: `^` is a glob
operator under `zsh` with `extendedglob` and an escape character in `cmd.exe`.

Forget it and nothing breaks silently: `createTestDb()` throws an error naming
the package and that exact command. Production code never reaches it — see §7.

To run the test suite, or the examples, clone the repository instead. The tests
import the TypeScript source directly and Node will not strip types from files
under `node_modules`, so they cannot be run from an install:

```bash
git clone https://github.com/filelayer/filelayer && cd filelayer
npm run bootstrap
npm test          # confirm the suite passes before you build on it
```

A throwaway instance, for a first run and for tests:

<!-- doccheck-setup
import { Filelayer } from '@filelayer/core';
const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const bytes = new TextEncoder().encode('notes');
const deck = new TextEncoder().encode('board deck');
const handbook = new TextEncoder().encode('handbook');
-->

```ts
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
```

<!-- doccheck-setup
const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
-->

`quickstart()` uses PGlite (PostgreSQL compiled to WebAssembly, in-process) and
in-memory bytes. **Everything is lost when the process exits.** For a real
deployment see §7 — it is three steps and they are not hidden.

---

## 1. Tier 1 — a public file

**New concepts: none.**

```ts
const { id, url } = await fl.files.put(avatarBytes, { public: true });
// url -> http://localhost:3000/f/1f0b...c3

await fl.files.unpublish(id);   // the URL stops working on the next request
```

That is the whole API for this tier. There is no org, no user, no role and no
grant in your mental model.

`contentType` is sniffed from the file's magic bytes (PNG, JPEG, GIF, WebP,
PDF). Anything unrecognised becomes `application/octet-stream` and is served as
a download rather than rendered — deliberately, because an unrecognised upload
could be HTML or SVG, and both execute. **Pass `contentType` explicitly if you
know it:**

```ts
await fl.files.put(avatarBytes, { public: true, name: 'a.png', contentType: 'image/png' });
```

### Taking it back

`unpublish()` is the reason to use Filelayer for a public file, and the only
reason. No deletion, no key rotation, no cache purge. The file is still there
and is still readable by anyone who has authority. A public S3 bucket and
Supabase's `getPublicUrl()` cannot do this: their URL is not a request to us, so
there is no moment at which a decision can be re-made. Deleting the object is
their only withdrawal mechanism.

### What is actually happening

`{ public: true }` is one line of sugar. It does **not** set a flag — there is no
`public` column in the schema and there never will be. It creates one explicit
grant row with `subject_type = 'anonymous'` and capability `read`. That row can
be listed, audited and revoked, which is why `unpublish()` works.

If you never mention an org, your files land in a **default workspace** — a real
organization row with a reserved id, auto-created on first use. It is not a
special case in the data model; it is an ordinary tenant you did not have to
name. Adding `org:` later (§3) moves you to a named one.

Runnable: `npm run example:tier1`.

---

## 2. Tier 2 — a private, user-owned file

**New concept: an owner.**

```ts
const { id } = await fl.files.put(bytes, { owner: 'user_123', name: 'notes.txt' });

const file = await fl.files.get(id, { as: 'user_123' });   // works
await fl.files.get(id, { as: 'user_456' });                // throws 404
await fl.files.get(id);                                    // throws 404
```

`owner` and `as` are **your own user ids**. Filelayer does not have a user
table you must sync into; the id is registered on first use.

Files are **private by default**. Through Filelayer, `user_123` can read it and
no other user can — not an anonymous caller holding the file id, and not someone
who learns the storage key, because the key is not an input to the decision. You
wrote no rule to make that true.

Two caveats, stated here rather than in an appendix. **Org admins and owners can
read `private` files** — deliberate, because retention and legal hold are their
responsibility; see the Limitations list in the README. And this describes access
**through Filelayer**: code that queries the `file` table directly is not
filtered by anything, because there is no RLS policy in the schema.

### Four things to know before you build on this

1. **Filelayer does not authenticate.** You tell it who the caller is. Establish
   that from your own session or JWT, exactly as you do today. `as:` is a claim
   you are vouching for.
2. **An unknown `as:` is a 404, never an anonymous read.** A typo in a user id
   fails; it does not silently downgrade.
3. **Denials are 404, not 403**, so an error message cannot be used to discover
   whether a file exists.
4. **`get()` returns `headers`.** Use them:
   ```ts
   const { id: fid } = await fl.files.put(bytes, { owner: 'user_123' });
   const f = await fl.files.get(fid, { as: 'user_123' });
   // res.writeHead(200, f.headers);   not { 'content-type': f.contentType }
   // res.end(f.body);
   ```
   Those headers are what stop a user-uploaded `.html` from executing in your
   origin. Writing the content type by hand re-opens stored XSS.

Runnable: `npm run example:tier2`.

---

## 3. Tier 3 — organizations and roles

**New concepts: an org, and a role.**

```ts
await fl.orgs.create('acme', { name: 'Acme Inc', owner: 'ceo' });
await fl.orgs.setRole('acme', 'analyst', 'member', { as: 'ceo' });
await fl.orgs.setRole('acme', 'reviewer', 'viewer', { as: 'ceo' });

await fl.files.put(deck,     { org: 'acme', owner: 'ceo' });                      // private
await fl.files.put(handbook, { org: 'acme', owner: 'ceo', visibility: 'org' });   // whole org
```

Note what did **not** change: `put` and `get` have the same shape as tier 2.
Promoting an app from "user files" to "multi-tenant" is adding `org:` to a call.

### The role model, in full

Four roles, fixed, no custom roles. This is the entire table:

| Role | Own files | Others' files, `visibility: 'private'` | Others' files, `visibility: 'org'` | Manage members | Read audit |
|---|---|---|---|---|---|
| `viewer` | read | — | read | — | — |
| `member` | read, write, delete, share | — | read | — | — |
| `admin` | full | full | full | yes | yes |
| `owner` | full | full | full | yes | yes |

`visibility` defaults to `'private'`: owner and org admins only. The failure
mode of that default is "somebody has to ask for access". The failure mode of
the other one is a disclosure.

Org admins and owners retain access to `private` files. That is deliberate —
retention, deletion and legal hold are their responsibility, and a control the
accountable party cannot exercise is not a control. If you need to exclude the
operator, you need envelope encryption, which Filelayer does not provide.

### `as` is required on membership changes

```ts
await fl.orgs.setRole('acme', 'x', 'admin', { as: 'ceo' });   // authorized
```

There is no shortcut here and there will not be. Membership is the privilege
that confers every other privilege. You may not grant a role above your own, may
not modify anyone who outranks you, and may not remove the last owner. Every
attempt — allowed or denied — is audited.

Runnable: `npm run example:tier3`.

---

## 4. Tier 4 — sharing, expiry, caps, revocation, audit

**New concept: a grant.**

<!-- doccheck-setup
const { id: fileId } = await fl.files.put(deck, { org: 'acme', owner: 'ceo', name: 'q4.pdf' });
-->

```ts
const share = await fl.shares.create(fileId, {
  as: 'ceo',
  expiresIn: 3600,      // seconds
  maxDownloads: 3,
  password: 'hunter2',  // optional, on top of the link secret
});
// share.secret is returned EXACTLY ONCE. Only its SHA-256 is stored.
```

<!-- doccheck-setup
const share = await fl.shares.create(fileId, {
  as: 'ceo', expiresIn: 3600, maxDownloads: 3, password: 'hunter2',
});
-->

Redeem it (the secret is the credential; no identity needed):

```ts
const dl = await fl.shares.redeem(share.secret!, { password: 'hunter2' });
```

Share with a named user instead of minting a link:

```ts
await fl.shares.create(fileId, { as: 'ceo', withUser: 'analyst' });
```

Share with a whole organization — including **another** organization, which is
the "the company that posted this job may read this CV" case. The org must
already exist; an unknown name is a `404`, never a silently created tenant:

<!-- doccheck-setup
await fl.orgs.create('partner-co', { owner: 'partner-boss', name: 'Partner Co' });
-->

```ts
await fl.shares.create(fileId, { as: 'ceo', withOrg: 'partner-co' });
```

...or with just the senior people in it. `minRole` is a floor over the four
existing roles (`viewer | member | admin | owner`); there are no custom roles:

```ts
await fl.shares.create(fileId, { as: 'ceo', withOrg: 'partner-co', minRole: 'admin' });
```

**This is resolved by a join, not by a copy.** Add or remove a member of
`partner-co` and their access changes on the very next request — no
recomputation, no background job, and not one grant row written. That is the
same mechanism that makes revocation immediate, applied to membership.

Revoke — and this takes effect immediately, for URLs already sent:

```ts
await fl.shares.revoke(share.grantId, { as: 'ceo' });
await fl.shares.list(fileId, { as: 'ceo' });   // what have we shared, with whom?
```

### Delegation

If you give someone `share`, what they hand on can never exceed what they hold —
not in capability, not in lifetime, not in remaining download budget. That is
enforced by the authorization engine *and* again by a database trigger, so it
binds a migration or a psql session too. Revoking a grant kills everything ever
delegated from it, at any depth, with **no cascading write** — liveness is
evaluated over the ancestor chain.

Nor can what they hand on reach **more people** than they can. Someone whose own
authority came from a grant may pass it to a named user or as a share link, and
nothing wider: never to an organization, never to a role, never anonymously.
Only authority derived from an org role (admin, owner, or the file's owner) can
open a file to a population. Enforced in the engine and again by the same
trigger.

Share links are read-only by database constraint, so a leaked link can never
delete or re-share.

### Download caps count every delivery

`maxDownloads` binds **any** delivery of bytes authorized by that grant: a share
link redemption and a direct authenticated read alike. Authority that comes from
an org role is not metered — a role is not a credential with a budget — and
metadata reads (`stat()`) are not charged, because no bytes leave.

### Audit

```ts
const log     = await fl.orgs.audit('acme', { as: 'ceo' });
const denials = await fl.orgs.audit('acme', { as: 'ceo', decision: 'deny' });
const chain   = await fl.orgs.verifyAudit('acme', { as: 'ceo' });  // { valid, checked }
```

Every access decision is recorded, **including denials** — a trail that records
only successes cannot evidence an attempted breach. Events are hash-chained per
tenant, so deletion or alteration of history is detectable. Requires `read_audit`
(admin or owner).

**The answer comes back in your identifiers, not ours.** Each row carries the
internal uuids it always did *and* the ids you supplied, so "who accessed this
contract?" is answerable without a join you write yourself:

```ts
const row = (await fl.orgs.audit('acme', { as: 'ceo', decision: 'deny' }))[0];

row?.summary;           // '2026-09-06T10:12:41.002Z marco file.read deny:grant_revoked contract.pdf @acme'
row?.actor.label;       // 'marco'        — the `as:` you passed
row?.file.label;        // 'contract.pdf'
row?.org.label;         // 'acme'         — the `org:` you passed
row?.actorId;           // the internal uuid, unchanged, still there
```

`label` is never null, so a row always prints. An access with no principal —
a share link, a public URL — reads as `anonymous` rather than as a null you have
to interpret; an event with no tenant (a probe that could not be attributed to
one) reads as `system`; and an id that resolves to nothing in your project keeps
its uuid and says `resolution: 'unresolved'` instead of inventing a name.
`.actor.externalId`, `.org.externalId` and `.file.name` are the same values with
no fallback, for when you want the null.

### Lifecycle

```ts
await fl.files.put(bytes, { org: 'acme', owner: 'ceo', expiresIn: 86400 });
await fl.files.put(bytes, { org: 'acme', owner: 'ceo', retainFor: 7 * 365 * 86400 });
```

`retainFor` blocks deletion until it passes, **including by the org owner**. That
is the point of a retention hold.

Runnable: `npm run example:vault` (the full Vault app over HTTP, on :8787).

---

## 5. Listing what a caller may see

**This is implemented.** It is one call, it paginates, and there is no predicate
for you to write:

```ts
// `listFiles` is on the core API and takes RESOLVED internal ids, not the
// external ids the `fl.files` facade takes. Every file record carries both, so
// `stat()` is the supported way to get them.
const rec = await fl.files.stat(fileId, { as: 'ceo' });

const page = await fl.listFiles(
  { actorId: rec.ownerId },    // the principal — a resolved actor id, or null
  rec.orgId,                   // the org — a resolved org id
  { capability: 'read', limit: 50, cursor: null },
);

page.files;        // FileRecord[] — exactly the files this caller may `read`
page.nextCursor;   // opaque keyset cursor, or null on the last page
```

There is **no filter parameter**, and that is the design. A listing screen is
the highest-frequency operation in a document product and historically the
highest-yield source of cross-tenant disclosure, because building one by hand
means writing the org filter, the visibility rule, the owner check, the role
check and a union over the grant table — five predicates, in application SQL,
that have to stay in step with the point check forever. Here the set of files a
caller may see *is* the return value.

`listFiles` and `authorize()` are asserted equal — set equality, not containment
— on every capability, over a randomized corpus, on every run, in
`packages/core/test/listing.test.ts`. A widening drift in one of them fails the
build.

Notes on the signature:

- It takes **resolved internal ids**, not the external ids the `fl.files` facade
  takes. There is no public resolver from an external id to an internal one
  today — the identity mapping is internal to the facade — so read them off a
  `FileRecord` (`stat()`, or anything that returns one) or keep them from your
  own request routing, as `examples/vault/server.ts` does. A `fl.files.list()`
  on the tiered facade is not implemented; this is the listing API.
- `limit` is clamped to `[1, 200]`. An out-of-range value is clamped, not
  rejected.
- An empty page is a valid answer. A caller with no standing sees nothing, and
  so does a caller naming an org that does not exist — distinguishing them would
  rebuild the existence oracle that 404-on-denial exists to close.
- A link-secret principal cannot list. A share link is a bearer credential for
  exactly one file; asking it to enumerate is refused with `400`, not silently
  narrowed.
- One SQL query and one audit event per page, independent of page size.

`examples/vault/server.ts` uses it for `GET /orgs/:id/files`; that endpoint is
the whole listing implementation in that application.

---

## 6. Serving bytes

Filelayer owns your response headers. This is not a convenience — it is where
three of the four remaining security-sensitive decisions used to live.

<!-- doccheck-setup
const yourSession = (_req: unknown): { userId: string } | null => null;
-->

```ts
import { fileDownloadRoute, shareDownloadRoute } from '@filelayer/core';

// Public files: serve as an anonymous caller, so only files with a live
// anonymous grant are reachable and everything else is 404.
const publicRoute = fileDownloadRoute(fl, {
  prefix: '/f',
  disposition: 'inline',
  principal: () => ({ actorId: null }),
});

// Authenticated reads: you supply identity, we supply everything else.
const authedRoute = fileDownloadRoute(fl, {
  prefix: '/files',
  principal: (req) => ({ actorId: yourSession(req)?.userId ?? null }),
});

// Share links.
const shareRoute = shareDownloadRoute(fl, { prefix: '/d' });
```

Every response carries `nosniff`, an explicit `Content-Disposition`, a sandbox
CSP, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`. None of these
is optional, because a header you can forget is a header you will forget.

Three consequences to design around:

- **A password for a share link must be POSTed in the body.** Putting a
  credential in the query string is refused with `400 credential_in_query` —
  loudly, before any work, without consuming a download. Query strings end up in
  access logs, proxy logs and browser history.
- **`Cache-Control: no-store` means no CDN on the default path.** That is what
  makes "revocation is immediate" true at every intermediary and not merely at
  our origin. It is also why public delivery costs us money. Redirect delivery
  is the opt-in escape hatch and it is deliberately awkward to turn on; see
  [`../packages/core/SEMANTICS.md`](../packages/core/SEMANTICS.md) and
  [`../architecture/TIER5-DESIGN-NOTE.md`](../architecture/TIER5-DESIGN-NOTE.md) §4.
- **These routes do not answer `Range` requests.** They never return `206`, so a
  browser cannot seek. The delivery API underneath accepts a byte range and the
  S3 adapter honours it, but parsing the `Range` request header and passing it
  down is your code today:

```ts
import { toStreamResponse } from '@filelayer/core';

// A range-capable read, in full: parse the header, pass a range, write it out.
const rangeHeader = 'bytes=0-3'; // in a route: req.headers.range
const m = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader ?? '');

const { id: clipId } = await fl.files.put(bytes, { public: true, name: 'clip.bin' });
const delivery = await fl.readStream({ actorId: null }, clipId, {
  mode: 'proxy',
  ...(m ? { range: { start: Number(m[1]), ...(m[2] ? { end: Number(m[2]) } : {}) } } : {}),
});

const response = toStreamResponse(delivery);
console.log(response.status, response.headers.get('content-range')); // 206 bytes 0-3/5
// On node:http it is the same one line: await sendNodeStream(res, delivery);
```

  You do **not** have to set the status yourself, and there is no parameter for
  it. `sendNodeStream()` and `toStreamResponse()` derive it from the delivery: a
  partial body always goes out as `206` with `Content-Range`, a whole object
  always as `200`. That is deliberate — a truncated body under a `200` is
  undetectable by every HTTP client, so it is not a mistake the API lets you
  make.

For Workers / Deno / Bun, `toResponse(delivery)` returns a WHATWG `Response` and
`toStreamResponse(delivery)` returns one that streams.

---

## 7. Going to production

`quickstart()` is ephemeral. A real deployment is three steps, and the third one
matters more than the other two.

**1. Provision Postgres and apply the schema.**

```bash
# from a clone
psql "$DATABASE_URL" -f packages/core/schema.sql

# from an install
psql "$DATABASE_URL" -f node_modules/@filelayer/core/schema.sql
```

PostgreSQL 15 or later. Requires the `pgcrypto` extension (the schema creates
it). The path is also exported programmatically as `SCHEMA_PATH`, and
`loadSchemaSql()` returns its contents, so a migration runner does not have to
hardcode a path.

**2. Construct the client with a real pool and a real bucket.**

<!-- doccheck: skip reason="requires the `pg` driver and a live Postgres and bucket; `pg` is deliberately not a dependency of this package" -->

```ts
import { Pool } from 'pg';
import { Filelayer, S3Storage } from '@filelayer/core';

const production = new Filelayer(
  new Pool({ connectionString: process.env.DATABASE_URL }),
  new S3Storage({
    endpoint: process.env.R2_ENDPOINT!,   // https://<account>.r2.cloudflarestorage.com
    bucket: 'filelayer-prod',
    region: 'auto',
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  }),
  { baseUrl: 'https://files.yourapp.com' },
);
```

`pg.Pool` satisfies the `Queryable` interface directly; no adapter needed. It is
used through `connect()` so that a transaction stays on one connection.

Nothing on this path touches PGlite, and the release gate proves it: it installs
the packed tarball into an empty directory with no `@electric-sql/pglite` on
disk and drives this entire page's lifecycle against a real PostgreSQL server
over `pg`.

**3. Confirm the bucket is PRIVATE.**

This is the one security-sensitive decision Filelayer cannot make for you, and
getting it wrong bypasses everything above. Object keys are `orgId/fileId` and
P2 explicitly does not treat them as secrets. A public bucket makes every file
readable to anyone who can guess or scrape a key, and no error will tell you.

- **R2:** do not attach a custom domain or enable the r2.dev public URL.
- **S3:** leave all four Block Public Access settings ON, at the account and the
  bucket level. Grant `s3:GetObject`/`PutObject` only to your application's role.

**Running more than one process is supported.** The audit hash chain is appended
by `audit_append()`, a single SQL function that takes
`pg_advisory_xact_lock` on the chain, reads the predecessor and inserts, and the
library runs that inside the same transaction as the mutation it describes. Two
API processes cannot fork the chain. One honest caveat: the test suite runs on
PGlite, which has a single backend, so what the suite proves is that the lock is
taken on the write path and that the encoding round-trips — the multi-process
argument rests on Postgres advisory-lock semantics, not on an executed test.
`packages/core/SEMANTICS.md` says the same thing at more length.

**Two operational jobs are yours to schedule.** Neither runs on its own:

- `collectStorageOrphans()` — bytes are written before metadata commits, so a
  crash in between leaves an unreferenced object.
- Rate limiting at ingest, per project and per source address, before a request
  reaches the engine. Denials are audited by design (P5), so an unauthenticated
  caller who can reach your API can grow a tenant's chain.

---

## 8. Errors

Everything throws `FilelayerError` with an HTTP-shaped `status` and a stable
machine-readable `code`.

<!-- doccheck-setup
const { id: someFileId } = await fl.files.put(bytes, { owner: 'user_123' });
const userId = 'user_123';
const res = { writeHead: (_s: number) => ({ end: (_b?: string) => undefined }) };
-->

```ts
import { FilelayerError } from '@filelayer/core';

try { await fl.files.get(someFileId, { as: userId }); }
catch (e) {
  if (e instanceof FilelayerError) return res.writeHead(e.status).end(JSON.stringify({ error: e.code }));
  throw e;
}
```

| status | code | Meaning |
|---|---|---|
| 404 | `not_found` | Does not exist, **or** you may not have it, **or** the link is revoked/expired/used up. Deliberately indistinguishable. |
| 401 | `password_required` | Share link needs a password. Re-issue as `POST` with `{"password": "..."}`. |
| 403 | `forbidden` | Attenuation or membership refusal. Only reachable by a caller who already has standing, so it leaks nothing. |
| 409 | `retention_hold` | Deletion blocked by a retention floor. |
| 410 | `gone` | The file itself has expired. |
| 400 | `credential_in_query` | A credential appeared in the query string. Move it to the body. |
| 400 | `link_principal_cannot_list` | A share-link credential was used to call `listFiles`. |

**Never serialize `e.reason` to an untrusted caller.** It carries the internal
deny reason (`no_membership`, `grant_revoked`, `bad_link_secret`…), which is
recorded in the audit log for your incident responder and would be an
enumeration oracle in a response body. `e.code` is the safe field.

---

## 9. What Filelayer does not do

- **Authenticate users.** You supply identity.
- **Answer `Range` requests from the shipped HTTP routes.** No `206`, no
  seeking. **Do not use them for video or audio.** The delivery API accepts a
  byte range and the shipped writers emit `206` correctly when you pass one
  (§6); what is missing is a route that reads the request header for you.
- **Stream through the tiered facade.** `fl.files.put()` takes a `Uint8Array`,
  so a file put through it is fully resident in memory. The core `fl.upload()`
  accepts a `ReadableStream` — use that for large files.
- **Resumable upload.**
- **Direct browser → storage upload.** Upload bytes go through your server.
- **CDN delivery by default.** Deliberate; see §6. Redirect delivery is opt-in,
  restricted to anonymous grants unless you widen it, and carries a bounded
  revocation window that you have to acknowledge in the config by name.
- **Image transformation or thumbnails.**
- **Custom roles.** Four fixed roles, on purpose: an unbounded role system is an
  authorization model nobody can audit.
- **Encryption at rest beyond what your bucket provides.** Org admins can read
  `private` files.
- **Per-org identifier namespaces.** `actor.external_id` and `org.external_id`
  are unique per **project** — one customer application — not per org. Two orgs
  inside one project share one id space for users.
- **Run its own maintenance.** Orphan collection and ingest rate limiting are
  jobs you schedule; see §7.

If your problem is a public avatar and nothing more,
[Supabase Storage does it in 10 lines to our 16](../ARCHITECTURE-PROGRESSIVE.md#41-the-headline-a-public-avatar)
and gives you a CDN. Use it. Come back when you need to take a URL back.
