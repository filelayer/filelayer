# Filelayer in a Next.js App Router application

Four files. Upload, list, read, share, revoke — with authorization, `Range`,
and an audit trail, and no HTTP plumbing of your own.

```
app/[...filelayer]/route.ts        every byte Filelayer serves
app/api/files/route.ts             POST an upload, GET a listing
app/api/files/[id]/share/route.ts  share with a link or a user, and revoke
lib/filelayer.ts                   one instance, and who is asking
```

Copy them into your project, replace `currentUser()` with your session, and
replace `getFilelayer()`'s body with your own pool and bucket.

---

## The thing that is not obvious

The README and QUICKSTART mount delivery with `deliveryHandler(fl)`. **That is a
`node:http` handler and it does not work here.** It takes `(req, res)` with a
Node `ServerResponse`; an App Router route handler is `(Request) => Response`.
They are different shapes, and a developer arriving from the README has no way
to know that except by trying it.

`deliveryFetch(fl, opts)` is the same two routes for `Request`/`Response`
runtimes — App Router, Hono, Workers, Deno, Bun. It is not a thin wrapper
around `toResponse()`: what it carries is everything *around* the response.

| | hand-written | `deliveryFetch` |
|---|---|---|
| `Range` parsed from the request | yours | done |
| `206` vs `200` derived from `Content-Range` | yours | done |
| `416` carrying `bytes */<size>` | yours | done |
| an *invalid* range ignored, not refused | yours | done |
| credential in the query string refused | yours | done |
| a path segment like `%%%` answered, not thrown | yours | done |
| password read from a JSON *or* form body | yours | done |
| `401` with `WWW-Authenticate` so the client retries | yours | done |

Each of those is a place to be wrong in a way that looks like it works. The
`node:http` user got them free; until `0.18.0` the Next.js user did not.

It returns **`null`** for a request it does not own, so a catch-all route does
not swallow the rest of your application:

```ts
return (await serve(req)) ?? new Response('Not found', { status: 404 });
```

---

## Two decisions this example makes on purpose

**The client's IP address is yours to supply.** A `Request` has no socket, so
the only candidate is a header, and a header is written by whoever spoke last.
If this library read `X-Forwarded-For` on its own, a directly reachable
deployment would let the client choose what its own audit log says about it. So
it does not. Pass `clientIp` if you sit behind an edge you trust, or pass
nothing and record no address.

**`dynamic = 'force-dynamic'` is load-bearing.** Authorization is per request
and the answer changes the moment a grant is revoked. Without it Next may serve
a previously authorized response to a later caller, which is the one caching
bug in this area that looks like it is working.

---

## Running it

```bash
npm run verify:nextjs
```

Twenty-eight checks, about forty seconds, no database and no server to start.
The example uses `Filelayer.quickstart()`, which runs PostgreSQL in-process, and
App Router handlers are plain functions, so the harness calls the exported
`GET`, `POST`, `DELETE` and `HEAD` with real `Request` objects and reads real
`Response`s back. `params` is passed as a promise, the way Next 15 passes it.

CI runs this on every commit, against a freshly packed tarball installed into a
scratch directory — so what is exercised is the published bytes, not this
checkout.

**What it does not cover**, so a green run is not mistaken for more than it is:
Next's own routing (which handler a URL reaches), caching and `dynamic`
handling, middleware, the edge runtime, and the build. Those need a real
Next.js install. What it does cover is every line of logic in these four files.

---

## Two things to change before this is yours

1. **`currentUser()` reads a header.** `x-demo-user` is set by the client, which
   is not authentication. Replace it with your session — NextAuth, Clerk, a
   cookie you signed. Returning an id Filelayer has never seen **denies**; it
   never silently degrades to anonymous.

2. **The imports end in `.ts`.** That is what lets Node run these files with no
   build step and no Next.js, which is what makes CI able to check them. In a
   real Next project you would write `@/lib/filelayer`. It is the only line in
   each file that changes.

---

## Where the bytes actually are

`lib/filelayer.ts` uses `Filelayer.quickstart()`: Postgres in-process, bytes in
memory, gone when the process exits. For a deployment, that function's body
becomes your own `pg.Pool` and `S3Storage` and the schema applied once — see
[QUICKSTART §7](https://github.com/filelayer/filelayer/blob/main/docs/QUICKSTART.md).
Nothing else in these four files changes.

Serverless note: a `Filelayer` holds a connection pool, and a platform that
starts many short-lived instances will open many pools. Use a pooler
(PgBouncer, Neon's, Supabase's) and size the client pool small.
