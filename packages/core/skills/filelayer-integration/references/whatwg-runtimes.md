# Next.js App Router, Hono, Workers, Deno, Bun

## The thing to get right first

**`deliveryHandler(fl)` cannot be mounted in any of these.** It is a
`node:http` handler: it takes `(req, res)` and writes to a `ServerResponse`.
These runtimes hand you a `Request` and want a `Response` back. The two are not
the same shape, and most of Filelayer's documentation shows the `node:http`
one, so an agent working from memory will reach for it and produce something
that cannot work.

Use `deliveryFetch(fl, opts)`. Same two routes, same rules, `(Request) =>
Promise<Response | null>`.

## The route

```ts
// app/[...filelayer]/route.ts
import { deliveryFetch } from '@filelayer/core';
import { getFilelayer, currentUser } from '@/lib/filelayer';

async function handler(req: Request): Promise<Response> {
  const fl = await getFilelayer();
  const serve = deliveryFetch(fl, {
    principal: async (r) => ({ as: await currentUser(r) }),
    userAgent: (r) => r.headers.get('user-agent') ?? undefined,
  });
  // `null` means "not one of mine", so the rest of the application still works.
  return (await serve(req)) ?? new Response('Not found', { status: 404 });
}

export const GET = handler;
export const POST = handler;   // a password-protected link posts its password
export const HEAD = handler;
```

It catches `/f/<id>` (an authorized read) and `/d/<secret>` (a share link).
Change the prefixes with `filePrefix` and `sharePrefix` if those paths are
taken, and keep `publicUrl` / `baseUrl` in step with them.

## Four things that are the application's job

**Authentication.** `principal` returns `{ as: yourUserId }` or `{ as: null }`
for an anonymous caller. Returning an id Filelayer has never seen **denies**
and records the attempt; it is never a silent downgrade to anonymous, because
that would turn a typo in a session lookup into a read of every public file.

**Nothing is cached, and there is no `dynamic` export** (Next.js).
Authorization is per request and the answer changes the moment a grant is
revoked. Route handlers are not cached unless you opt in, and this handler
reads the request, which keeps it out of any prerender, with or without
`cacheComponents`. Next 16 projects created by `create-next-app` turn
`cacheComponents` on, and with it `export const dynamic = 'force-dynamic'` is a
build error, so do not add one. What must not happen is a `'use cache'` around
anything that decides or serves a read: a cached answer is an authorized answer
handed to the next caller. This is the caching bug in this area that looks like
it is working.

**The client address.** `deliveryFetch` will not read `X-Forwarded-For`. A
`Request` has no socket, so the only candidate is a header, and a header is
written by whoever spoke last — on a directly reachable deployment that is the
client choosing what its own audit log says about it. Pass `clientIp` only if
the deployment sits behind an edge it trusts:

```ts
clientIp: (r) => r.headers.get('cf-connecting-ip') ?? undefined,
```

Recording no address is the honest default.

**One instance, not one per request.** A `Filelayer` holds a connection pool.
Build it once in module scope. On a platform that starts many short-lived
instances, use a pooler (PgBouncer, Neon's, Supabase's) and keep the client
pool small.

```ts
let instance: Promise<Filelayer> | null = null;
export function getFilelayer(): Promise<Filelayer> {
  // Assigned before awaiting, so two requests arriving together share one
  // instance rather than racing to build two.
  instance ??= build();
  return instance;
}
```

## Upload and listing routes

Those are the application's own routes; Filelayer does not ship them. Bound the
size before reading the body — `file.size` is known without touching it — and
do not pass the browser's `file.type` through: let Filelayer sniff the content
type from the magic bytes, because a declared `text/html` served back inline is
stored XSS against your own origin. Take the org from the session, never from
the form or the query string, and create orgs on purpose with
`fl.orgs.create(id, { name, owner })` where your app creates a workspace; an
upload is not the place to create one.

```ts
const org = await currentOrg(req); // from your session, not from the request
if (file.size > MAX_BYTES) return json({ error: 'payload_too_large' }, 413);
const { id } = await fl.files.put(new Uint8Array(await file.arrayBuffer()), {
  org, owner: user, name: file.name,
});
```

## A working version of all of this

`node_modules/@filelayer/core/examples/nextjs/` is upload, list, read, share
and revoke in four files, with a `verify.mjs` that drives the exported route
handlers directly. Read it rather than reconstructing it. CI runs it on every
commit against a freshly packed tarball.

Three things in that example are not what a real project writes, and the
example's README says so: `currentUser()` reads a header, which is not
authentication; `currentOrg()` returns the demo's one workspace, created in
`getFilelayer()` because the demo has no sign-up; and the imports are relative,
where your project would likely use `@/lib/filelayer`.
