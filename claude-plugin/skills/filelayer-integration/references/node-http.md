# Express, Fastify, plain `node:http`

## Two ways to mount, and when each is right

**`deliveryHandler(fl, opts)`** is both byte routes plus a 404 for everything
else, as one `node:http` request listener. It owns the whole server, so it is
right when Filelayer is the only thing on that port and wrong when the
application has routes of its own:

```ts
import { createServer } from 'node:http';
import { deliveryHandler } from '@filelayer/core';

createServer(deliveryHandler(fl, {
  principal: (req) => ({ as: userIdFrom(req) }),
})).listen(3000);
```

**`fileDownloadRoute(fl, opts)` and `shareDownloadRoute(fl, opts)`** are the
two routes separately. Each returns `(req, res) => Promise<boolean>`, where
`false` means "not mine, carry on". That is the one to mount beside an existing
application, and it composes with any router:

```ts
import { fileDownloadRoute, shareDownloadRoute } from '@filelayer/core';

const files  = fileDownloadRoute(fl, { prefix: '/f', principal: (req) => ({ as: userIdFrom(req) }) });
const shares = shareDownloadRoute(fl, { prefix: '/d' });

// node:http
const server = createServer(async (req, res) => {
  if (await files(req, res)) return;
  if (await shares(req, res)) return;
  yourRouter(req, res);
});

// Express: the same handlers, since Express req/res are node:http's
app.use(async (req, res, next) => {
  if (await files(req, res)) return;
  if (await shares(req, res)) return;
  next();
});
```

Mounting `fileDownloadRoute` twice with different prefixes and different
`principal` functions is a legitimate pattern: one path for authenticated
reads, another for a public path that passes `{ as: null }`. The anonymous one
is not a bypass — an anonymous principal reaches only a file carrying an
explicit anonymous grant.

## What the route does for you

Do not re-implement any of this beside it:

- Parses `Range`, answers `206` with `Content-Range`, `416` with
  `Content-Range: bytes */<size>` for a range past the end, and advertises
  `Accept-Ranges: bytes` on every proxied response including the plain `200`.
- Refuses a credential in the query string with a `400`, before doing any work
  and without spending a download.
- Sets `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment` and
  `Cache-Control: no-store`.
- Answers `401` with `WWW-Authenticate: FilelayerShare` for a password-protected
  link, so the client knows to retry as a `POST` with the password in the body.
- Survives a malformed path segment. `GET /d/%%%` used to kill the process.

## Four things that are the application's job

**Authentication.** `principal(req)` returns `{ as: yourUserId }` or
`{ as: null }`. An id Filelayer has never seen **denies** and the attempt is
audited; it never degrades silently to anonymous.

**Body size on your own upload route.** Filelayer's routes serve bytes; the
upload endpoint is yours. Count bytes as they arrive and refuse early. A 400 MB
body took the shipped starter from 85 MB resident to 1.3 GB because it was
buffered before being rejected.

**One instance.** A `Filelayer` holds a `pg.Pool`. Build it once at startup,
not per request.

**No proxy cache in front of the byte path.** The responses say `no-store` for
a reason: authorization is per request. If something in front of the
application ignores that, it will hand one caller's bytes to the next.

## A working version

`node_modules/@filelayer/core/examples/starter/server.ts` is a deployable
application on a real Postgres with the routes mounted beside its own, and
`verify.mjs` beside it drives the whole thing over HTTP. CI boots it against a
real PostgreSQL on every commit, so it is tested rather than merely published.
