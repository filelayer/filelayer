# Filelayer Quickstart

Simple first. Each section adds **one** concept. Stop reading at whichever
section solves your problem — nothing later is required to make anything earlier
work.

If you are an AI agent implementing an integration: every TypeScript block on
this page is extracted and **executed** by `tools/check-doc-samples.mjs`, which
runs in CI on every push. Two blocks are marked as skipped in the markdown
source, each with a stated reason. Runnable examples of the same shapes live in
`examples/tier1-avatar/`, `examples/tier2-user-files/`,
`examples/tier3-org-roles/` and `examples/vault/`, and `examples/starter/` is a
deployable server against your own Postgres. If a snippet here disagrees
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

The tests import the TypeScript source directly and Node will not strip types
from files under `node_modules`, so `node --test node_modules/@filelayer/core/test/`
does not work. **That is not a reason to clone us.** Copying the package
directory out to a scratch directory runs the same suite against *the bytes you
were sent*, which is the only thing worth verifying, and the exact procedure is
in
[docs/VERIFY-WHAT-YOU-INSTALLED.md](https://github.com/filelayer/filelayer/blob/main/docs/VERIFY-WHAT-YOU-INSTALLED.md)
— two minutes, no account, no credentials, no database. CI runs that document's
commands verbatim against a freshly packed tarball on every commit, so it cannot
quietly stop working.

Clone the repository if you want to *change* it, or to run the examples, which
are driven by scripts in the repository root:

```bash
git clone https://github.com/filelayer/filelayer && cd filelayer
npm run bootstrap
npm run example:tier1
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
// share.url is the ready-made link, built from the baseUrl you constructed with.
// share.grantId is what you pass to revoke().
```

**`capabilities` is how you hand over more than reading**, and it defaults to
`['read']`. Until you find it, delegation reads as broken: the person you shared
with tries to share onward and gets a `404`, because what they hold says `read`
and nothing else.

**A LINK can only ever carry `read`.** `shares.create` refuses anything else
with `400 link_is_read_only` before any query, and the `grant_link_read_only`
constraint refuses the row even from a `psql` session. Not a policy you can
argue with: a bearer secret that
can mint further authority is a bearer secret that escapes. So delegation is
granted to a NAMED user:

```ts
const delegable = await fl.shares.create(fileId, {
  as: 'ceo',
  withUser: 'contractor',             // a named subject, not a link
  capabilities: ['read', 'share'],    // now they may share it onward
  expiresIn: 3600,
});

// And the contractor can now mint their own link, read-only and clamped.
const onward = await fl.shares.create(fileId, { as: 'contractor', expiresIn: 600 });
```

Everything the second grant does is clamped to the first, which is §4's
Delegation section: asking for a capability the parent does not hold is refused
outright, while a longer expiry or a bigger download budget is narrowed to the
parent's without complaint. Valid capabilities are `read`, `write`, `delete` and
`share` -- the four in the `Capability` type. A share LINK is the exception and
carries `read` only, which `shares.create` refuses to widen; §4 says why.

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

- It takes **resolved internal ids**. If you are holding your own user ids,
  use **`fl.files.list({ as, org })`** on the facade instead — same engine,
  same guarantees, your identifiers:

  ```ts
  const page = await fl.files.list({ as: 'user_123', org: 'acme', limit: 50 });
  ```

  That method and `fl.ids` landed in `0.13.0`. Until then this core call was
  the only listing API and there was no public way to resolve an external id,
  so a listing screen was the one feature that forced you out of the facade --
  and it was **impossible** for any identity the library auto-provisioned,
  because nothing returned its id. Three agents given an integration task hit
  that and each invented the same workaround. If you genuinely need the
  internal value, `fl.ids.actorId('user_123')` and `fl.ids.orgId('acme')`
  return it or `null`; `fl.ids.ensureActor()` creates the identity if it does
  not exist.
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
// `{ as }` is YOUR user id -- the same string you pass to fl.files.get().
const authedRoute = fileDownloadRoute(fl, {
  prefix: '/files',
  principal: (req) => ({ as: yourSession(req)?.userId ?? null }),
});

// Share links.
const shareRoute = shareDownloadRoute(fl, { prefix: '/d' });
```

### Mounting them

Each of those is `(req, res) => Promise<boolean>`. It returns `true` when it
handled the request and `false` when the path was not its own, so you try them in
order and fall through to your own router:

<!-- doccheck: skip reason="it calls listen(), and a sample that never returns hangs the checker rather than failing it" -->

```ts
import { createServer } from 'node:http';

createServer(async (req, res) => {
  if (await publicRoute(req, res)) return;
  if (await authedRoute(req, res)) return;
  if (await shareRoute(req, res)) return;
  // ...and fall through to your own router.
  // yourRouter(req, res);
}).listen(3000);
```

`deliveryHandler(fl)` is the same three, pre-mounted, if you want one line.

**`principal` returns YOUR user id, as `{ as }`.** The same string you pass
everywhere else. An id this project has never seen is a `404` and the attempt is
recorded -- never a silent downgrade to anonymous, which would turn a typo in a
session lookup into a read of every published file.

Until `0.13.0` the callback had to return Filelayer's **internal** actor uuid,
and there was no public way to get one. That made the library's own route for
authenticated reads unmountable by any application with its own user ids, and
the snippet on this page passed `yourSession(req).userId` into `actorId`, which
could not have worked. Of four integration tasks given to agents holding only
the published tarball, three hit it and each invented the same workaround.

If you already hold an internal id -- or you want to pass `ip` / `userAgent`
through to the audit log -- the `Principal` form still works:

<!-- doccheck-setup
const sessionOf = (_req: unknown): { filelayerActorId: string; ip: string } | null => null;
-->

```ts
const mappedRoute = fileDownloadRoute(fl, {
  prefix: '/files',
  principal: (req) => {
    const s = sessionOf(req);
    return s ? { actorId: s.filelayerActorId, ip: s.ip } : { actorId: null };
  },
});

// And `fl.ids` is the bridge when you need the value itself:
const actorId = await fl.ids.actorId('user_123');   // string | null, creates nothing
const orgId = await fl.ids.orgId('acme');           // string | null
await fl.ids.ensureActor('user_123');               // creates if absent; idempotent
```

`fl.files.stat(fileId, { as })` is also still worth knowing: `rec.ownerId` on
the returned `FileRecord` is the resolved actor id of that file's owner, which
is how the listing example above gets one without a lookup.

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
  [`SEMANTICS.md`](../SEMANTICS.md) and
  [`architecture/TIER5-DESIGN-NOTE.md`](https://github.com/filelayer/filelayer/blob/main/architecture/TIER5-DESIGN-NOTE.md) §4.
- **These routes answer `Range` requests, and you write none of it.**
  `fileDownloadRoute()` and `shareDownloadRoute()` parse the header, so a
  browser can seek in a file served by them. `Accept-Ranges: bytes` goes on
  every proxied response — including the unranged `200`, which is the response a
  video player or PDF reader actually reads to decide whether seeking is
  possible — and a range past the end is a `416` carrying
  `Content-Range: bytes */<size>`, which is the only thing that tells a client
  the size it was guessing at.

  If you are writing your own route, the same range goes straight into the
  delivery API. `parseRangeHeader()` is exported so you get the RFC 9110
  behaviour rather than a regex:

```ts
import { parseRangeHeader, toStreamResponse } from '@filelayer/core';

const { id: clipId } = await fl.files.put(bytes, { public: true, name: 'clip.bin' });

// In a route this is `req.headers.range`. A header it cannot use returns null,
// which means "serve the whole object" -- never an error. RFC 9110 requires a
// malformed `Range` to be IGNORED, not rejected.
const range = parseRangeHeader('bytes=0-3');

const delivery = await fl.readStream({ actorId: null }, clipId, {
  mode: 'proxy',
  ...(range ? { range } : {}),
});

const response = toStreamResponse(delivery);
console.log(response.status, response.headers.get('content-range')); // 206 bytes 0-3/5
// On node:http it is the same one line: await sendNodeStream(res, delivery);
```

  `bytes=-N` ("the last N bytes", which is what a PDF reader sends first to find
  the cross-reference table) is also supported. It costs one extra `head()` on
  the object, because the last N bytes of a file are not a byte range until
  something authoritative says how long the file is — and that is the object
  store, not the `size_bytes` column.

  You do **not** have to set the status yourself, and there is no parameter for
  it. `sendNodeStream()` and `toStreamResponse()` derive it from the delivery: a
  partial body always goes out as `206` with `Content-Range`, a whole object
  always as `200`. That is deliberate — a truncated body under a `200` is
  undetectable by every HTTP client, so it is not a mistake the API lets you
  make.

### Next.js App Router, Hono, Workers, Deno, Bun

**`deliveryHandler(fl)` cannot be mounted on any of those.** It is a
`node:http` handler: it takes `(req, res)` and writes to a `ServerResponse`.
An App Router route handler is `(Request) => Response`, and the two are not the
same shape. That sentence is here because its absence cost a reader a morning.

`deliveryFetch(fl, opts)` is the same two routes for a runtime that speaks
`Request` and `Response`, with the same `Range` parsing, the same `416` carrying
the object's size, the same refusal of a credential in the query string, and the
same `401` that tells a client to retry a password link as a POST:

<!-- doccheck: skip reason="it is a route module: the export is the deliverable, and there is nothing here to call without inventing a request the rest of this page does not need" -->

```ts
// app/[...filelayer]/route.ts
import { deliveryFetch } from '@filelayer/core';

const serve = deliveryFetch(fl, {
  principal: async (req) => ({ as: await currentUser(req) }),
});

async function handler(req: Request) {
  // `null` means "not one of mine", so your own routes still work.
  return (await serve(req)) ?? new Response('Not found', { status: 404 });
}

export const GET = handler;
export const POST = handler;
export const HEAD = handler;
export const dynamic = 'force-dynamic';   // authorization is per request
```

Two things it deliberately does not do for you. It will not read
`X-Forwarded-For`: a `Request` has no socket, that header is written by whoever
spoke last, and a library that guessed would let a client choose what its own
audit log says about it — pass `clientIp` if you sit behind an edge you trust.
And `dynamic = 'force-dynamic'` is yours to set; without it Next may serve a
previously authorized response to a later caller.

[`examples/nextjs`](https://github.com/filelayer/filelayer/blob/main/examples/nextjs/README.md)
is the whole thing — upload, list, read, share, revoke — in four files, driven
by CI on every commit against a freshly packed tarball.

The lower-level pieces are still exported and still right when you want to build
the response yourself: `toResponse(delivery)` returns a WHATWG `Response` and
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

`schema.sql` is **not idempotent, and since `0.15.0` it refuses rather than
half-applies.** Run it against a database that already has the schema and its
first statement raises, naming the version it found, instead of dying part-way
through on `relation "project" already exists`.

It creates `filelayer_schema_version` and stamps it as its last statement, so
the database records what it has. **`schemaStatus(db)` reads that** and returns
`{ state, at, expects, outstanding, history }` — which is what a boot sequence
should consult rather than counting tables by hand:

<!-- doccheck: skip reason="it takes the `pg.Pool` you own; `pg` is deliberately not a dependency of this package, so there is nothing here to construct one from" -->

```ts
import { schemaStatus } from '@filelayer/core';

const status = await schemaStatus(pool);
if (status.state === 'absent') {
  // apply schema.sql, once, under an advisory lock if more than one node boots
} else if (status.outstanding.length > 0) {
  throw new Error(`schema is at ${status.at}, expected ${status.expects}`);
}
```

`schemaStatus` is read-only by construction: it will not apply anything, which
is deliberate — see MIGRATIONS.md. The migrations themselves are `.sql` files
under `migrations/`, enumerated in `migrations/manifest.json` with whether each
one is transactional and which schema version it upgrades from, so a runner can
drive them without parsing prose.
[MIGRATIONS.md](https://github.com/filelayer/filelayer/blob/main/packages/core/MIGRATIONS.md)
says how changes are delivered and what the pre-1.0 promise is.

*Until 7 October 2026 this paragraph said there was no `schema_version` table
and no way to tell, which stopped being true in `0.15.0` and sent every reader
of the canonical production path off to hand-roll something that already
shipped. Recorded rather than quietly corrected, because the stale instruction
is the kind of defect this project is supposed to find before its readers do.*

**2. Construct the client with a real pool and a real bucket.**

### Which storage adapter

Three ship, and the one you want is usually obvious once they are side by side.

| adapter | bytes live | survives a restart | redirect delivery | use it for |
|---|---|---|---|---|
| `MemoryStorage` | in the process | no | no | tests, and `quickstart()` |
| `FsStorage` | a directory you name | yes | no | local development, a single node, evaluation before you create a bucket |
| `S3Storage` | S3, R2, or anything S3-compatible | yes | yes | production |

```ts
import { FsStorage } from '@filelayer/core';

const storage = new FsStorage('./filelayer-data');
```

`FsStorage` is one process on one disk. It does no locking across writers and has
no replication, so two application servers cannot share it the way they share a
bucket. It has no `presignGet`, which is the honest shape of the thing rather
than a gap: a presigned URL promises that some other server will hand over the
bytes without asking you, and a local directory has no other server. Redirect
delivery is therefore unavailable, and `canPresign(storage)` reports that before
a request rather than during one.

Anything else is a `StorageAdapter`: five required methods (`put`, `get`,
`stream`, `head`, `delete`) plus a `provider` string, and two optional methods
(`presignGet` enables redirect delivery, `list` enables orphan collection). The
interface is in `src/storage.ts`, which ships inside the package, and
`FsStorage` in the same file is a worked implementation: 224 lines of code and
150 of comment, and the comments are the longer half because what is hard about
writing one of these is the write ordering, the failure paths and how many times
you open the file -- not the five signatures. It keeps one file per object, a
JSON header line followed by the bytes, so replacing an object is a single
`rename` and a reader cannot be served one version's etag over another
version's bytes.

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

### The `FsStorage` equivalent of "make the bucket private"

The step above tells you to confirm your bucket is private, and calls it the one
security-sensitive decision Filelayer cannot make for you. On `FsStorage` it
**can**, so it does: the data directory and every level under it are kept
owner-only (`0700`), and objects are written `0600`. It only ever removes group
and other bits -- a directory you deliberately made read-only stays read-only.

Until `0.12.0` they were `0755` and `0644`, which on a shared host is a public
bucket on local disk: object keys are `orgId/fileId` and are explicitly not
secrets, so any local user could read every tenant's files. If you deployed an
earlier version, fix the existing tree once:

```bash
chmod -R go-rwx /path/to/your/filelayer-data
```

What is still yours: the directory's **owner**. Run the application as a user
nobody else can become, and do not put the data directory somewhere a backup
agent or a log shipper reads as a different account.

**Four operational jobs are yours to schedule.** None of them runs on its own,
and this list said "two" until `0.12.0` — an engineer deploying the published
`0.11.0` had to grep the type declarations to find out it was wrong:

- `collectStorageOrphans()` — bytes are written before metadata commits, so a
  crash in between leaves an unreferenced object. Defaults to `dryRun: true`.
- `collectUploadReservations()` — only if you enabled `directUpload`. A
  reservation nobody redeems is a `pending` row no read path can see, so nothing
  will draw your attention to it. Also `dryRun: true` by default.
- `verifyAuditChain(principal, orgId)`, and **pin the result somewhere outside
  this database.** Replay detects edits and interior deletions, not truncation
  of the most recent events; comparing `lastId`/`lastHash` against a copy you
  keep elsewhere is what closes that. It is authorized per org and there is no
  "verify every tenant" call, so you need the list of orgs and an admin
  identity for each. A tenant you forget is silently unmonitored.
- Rate limiting at ingest, per project and per source address, before a request
  reaches the engine. Denials are audited by design (P5), so an unauthenticated
  caller who can reach your API can grow a tenant's chain.

**And one thing no job reclaims.** `expiresIn` is a gate on use, not a
deletion: an expired file keeps its row, the row keeps referencing its key, and
`collectStorageOrphans()` skips any key a row still references. So expired
bytes are paid for indefinitely. If you set `expiresIn`, you need your own
sweep that calls `delete()` on files past their expiry.

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

`code` is typed: it is a union of the 29 codes this library can produce, so a
`switch` over it is exhaustive and `'not-found'` for `'not_found'` is a compile
error rather than a branch that silently never runs.

**The status is a function of the code.** One code never means two statuses, so
branching on `code` is enough. The constructor does not take a status at all;
it reads it from the catalogue.

The eight you will meet first:

| status | code | Meaning |
|---|---|---|
| 404 | `not_found` | Does not exist, **or** you may not have it, **or** the link is revoked/expired/used up. Deliberately indistinguishable. |
| 401 | `password_required` | Share link needs a password. Re-issue as `POST` with `{"password": "..."}`. |
| 403 | `forbidden` | Attenuation or membership refusal. Only reachable by a caller who already has standing, so it leaks nothing. |
| 409 | `retention_hold` | Deletion blocked by a retention floor. |
| 410 | `gone` | The file itself has expired. |
| 400 | `credential_in_query` | A credential appeared in the query string. Move it to the body. |
| 400 | `link_principal_cannot_list` | A share-link credential was used to call `listFiles`. |
| 400 | `link_is_read_only` | A share link was asked for a capability beyond `read`. Name an actor or an org as the subject instead. |

**All twenty-nine, with what to do about each, are in
[`ERRORS.md`](https://github.com/filelayer/filelayer/blob/main/packages/core/ERRORS.md).**
It is generated from the code, so it cannot drift from it. If you are mapping
these onto your own responses in a script, read
[`errors.json`](https://github.com/filelayer/filelayer/blob/main/packages/core/errors.json)
instead; it ships in the tarball and resolves as `@filelayer/core/errors.json`.

*Until 7 October 2026 the table above was the whole published list, and the
library threw twenty-nine codes. A caller who hit `upload_not_received` or
`bad_cursor` had nothing to tell them whether those names were stable.*

**Never serialize `e.reason` to an untrusted caller.** It carries the internal
deny reason (`no_membership`, `grant_revoked`, `bad_link_secret`…), which is
recorded in the audit log for your incident responder and would be an
enumeration oracle in a response body. `e.code` is the safe field.

---

## 9. What Filelayer does not do

- **Authenticate users.** You supply identity.
- **Answer *multiple* ranges in one request, or honour `If-Range`.**
  `bytes=0-9,20-29` is ignored and the whole object is served under a `200`;
  answering one of several ranges under a `206` is indistinguishable, from the
  client's side, from an answer to a different question. `If-Range` is not
  parsed, which is safe here only because an object key is a fresh UUID that is
  never rewritten, so the bytes cannot change under a resuming client. Single
  ranges, suffix ranges and `416` all work (§6).
- **Stream through the tiered facade.** `fl.files.put()` takes a `Uint8Array`,
  so a file put through it is fully resident in memory. The core `fl.upload()`
  accepts a `ReadableStream` — use that for large files.
- **Resumable or multipart upload.** A large upload that fails starts over.
- **Direct browser → storage upload *by default*.** Upload bytes go through
  your server unless you turn this on. `createUpload()` / `completeUpload()`
  since `0.10.0` authorize first and then hand the browser a presigned `PUT`
  that pins length and content type, so the bytes never enter your process; it
  is opt-in behind an acknowledgement string and needs a `maxUploadBytes` you
  choose, and on `FsStorage` it reports `via: 'server'` because there is
  nothing to presign. This line said flatly that Filelayer did not do this at
  all, which stopped being true on 4 October 2026 and stayed on the page for
  the rest of that day.
- **A size ceiling on `fl.files.put()` or `fl.upload()`.** `maxUploadBytes`
  belongs to the direct-upload config and nothing else. The plain upload paths
  accept whatever you hand them, so the limit is whatever your process can
  allocate: a 400 MB body took the starter from 85 MB resident to 1.3 GB.
  Counting bytes as the body arrives is your application's job and
  `examples/starter/server.ts` shows it.
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
[Supabase Storage does it in 10 lines to our 16](https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md#41-the-headline-a-public-avatar)
and gives you a CDN. Use it. Come back when you need to take a URL back.
