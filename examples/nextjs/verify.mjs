#!/usr/bin/env node
/**
 * THE NEXT.JS ROUTE HANDLERS, DRIVEN AS WHAT THEY ARE.
 *
 *     npm run verify:nextjs                    # from a checkout
 *
 * NOT runnable in place. Like `examples/starter`, these files import
 * `@filelayer/core` by name -- because that is what a developer pastes into
 * their own project -- and the repository root has no `node_modules`. The
 * runner packs the package, installs the TARBALL into a scratch directory,
 * copies these files in and drives them there, so what is exercised is the
 * published bytes rather than the checkout.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS NO NEXT.JS, AND WHAT THAT COSTS
 * ---------------------------------------------------------------------------
 *
 * An App Router route handler IS `(Request) => Promise<Response>`. Nothing in
 * these files touches a Next API: they import `Request`, `Response` and
 * `FormData`, all of which are global in Node 18+. So this harness imports the
 * route modules and calls their exported `GET`, `POST`, `DELETE` and `HEAD`
 * directly, with real `Request` objects, and reads real `Response`s back.
 *
 * What that does NOT cover, stated so nobody mistakes a green run for more
 * than it is: Next's own routing (which handler a URL reaches), its caching
 * and `dynamic` handling, middleware, the edge runtime, and the build. Those
 * need a real Next.js install. What it DOES cover is every line of logic in
 * these files, which is the part that was not written down anywhere before and
 * the part an agent will get wrong.
 *
 * `params` is passed the way Next 15 passes it -- a PROMISE of the object --
 * because that changed in 15 and a handler written for 14 is a runtime error
 * rather than a type error.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const delivery = await import(join(HERE, 'app', '[...filelayer]', 'route.ts'));
const files = await import(join(HERE, 'app', 'api', 'files', 'route.ts'));
const share = await import(join(HERE, 'app', 'api', 'files', '[id]', 'share', 'route.ts'));

const BASE = 'http://localhost:3000';
const as = (user) => (user === null ? {} : { 'x-demo-user': user });

/** Next 15 hands `params` over as a promise. */
const ctx = (params) => ({ params: Promise.resolve(params) });

// -----------------------------------------------------------------------------
// Upload
// -----------------------------------------------------------------------------

async function upload(user, org, name, body) {
  const form = new FormData();
  form.set('org', org);
  form.set('file', new File([body], name, { type: 'text/plain' }));
  return files.POST(new Request(`${BASE}/api/files`, {
    method: 'POST',
    headers: as(user),
    body: form,
  }));
}

const unauth = await files.POST(new Request(`${BASE}/api/files`, { method: 'POST' }));
check('an unauthenticated upload is refused', unauth.status === 401, `status ${unauth.status}`);

const created = await upload('alice', 'acme', 'contract.txt', 'CONTRACT BODY');
const createdBody = await created.json();
check('alice uploads', created.status === 201 && typeof createdBody.id === 'string',
  `status ${created.status}`);
check('the response carries the path the catch-all serves',
  createdBody.url === `/f/${createdBody.id}`, createdBody.url);

const fileId = createdBody.id;

// -----------------------------------------------------------------------------
// Read, through the catch-all
// -----------------------------------------------------------------------------

const own = await delivery.GET(new Request(`${BASE}/f/${fileId}`, { headers: as('alice') }));
check('the owner reads their own file', own.status === 200, `status ${own.status}`);
check('and gets the bytes back', (await own.text()) === 'CONTRACT BODY');

const stranger = await delivery.GET(new Request(`${BASE}/f/${fileId}`, { headers: as('bob') }));
check('a stranger is refused as not_found, not forbidden',
  stranger.status === 404, `status ${stranger.status}`);

const anon = await delivery.GET(new Request(`${BASE}/f/${fileId}`));
check('an anonymous caller is refused', anon.status >= 400, `status ${anon.status}`);

const unknown = await delivery.GET(
  new Request(`${BASE}/f/${fileId}`, { headers: { 'x-demo-user': 'nobody-by-that-name' } }),
);
check('an unknown user id DENIES rather than degrading to anonymous',
  unknown.status === 404, `status ${unknown.status}`);

const headed = await delivery.HEAD(new Request(`${BASE}/f/${fileId}`, {
  method: 'HEAD', headers: as('alice'),
}));
check('HEAD answers with no body', headed.status === 200 && (await headed.text()) === '');

const ranged = await delivery.GET(new Request(`${BASE}/f/${fileId}`, {
  headers: { ...as('alice'), range: 'bytes=0-7' },
}));
check('a range is served as a 206', ranged.status === 206, `status ${ranged.status}`);
check('with the right bytes', (await ranged.text()) === 'CONTRACT');
check('and Content-Range', ranged.headers.get('content-range') === 'bytes 0-7/13',
  ranged.headers.get('content-range') ?? 'absent');

const past = await delivery.GET(new Request(`${BASE}/f/${fileId}`, {
  headers: { ...as('alice'), range: 'bytes=900-999' },
}));
check('an unsatisfiable range is a 416 carrying the size',
  past.status === 416 && past.headers.get('content-range') === 'bytes */13',
  `${past.status} ${past.headers.get('content-range')}`);

const invalid = await delivery.GET(new Request(`${BASE}/f/${fileId}`, {
  headers: { ...as('alice'), range: 'bytes=9-4' },
}));
check('an INVALID range is ignored and the whole file is served under a 200',
  invalid.status === 200, `status ${invalid.status}`);

const credentialed = await delivery.GET(
  new Request(`${BASE}/f/${fileId}?token=abc`, { headers: as('alice') }),
);
check('a credential in the query string is refused before any work',
  credentialed.status === 400, `status ${credentialed.status}`);

check('the security headers are set for you',
  own.headers.get('x-content-type-options') === 'nosniff' &&
    (own.headers.get('content-disposition') ?? '').startsWith('attachment'));

const notOurs = await delivery.GET(new Request(`${BASE}/dashboard`));
check('a path the library does not own falls through to the app',
  notOurs.status === 404, `status ${notOurs.status}`);

// -----------------------------------------------------------------------------
// Sharing
// -----------------------------------------------------------------------------

const linked = await share.POST(
  new Request(`${BASE}/api/files/${fileId}/share`, {
    method: 'POST', headers: { ...as('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ maxDownloads: 2 }),
  }),
  ctx({ id: fileId }),
);
const link = await linked.json();
check('alice mints a share link', linked.status === 201 && typeof link.url === 'string',
  `status ${linked.status}`);

const secret = String(link.url).split('/').pop();
const redeemed = await delivery.GET(new Request(`${BASE}/d/${secret}`));
check('a stranger with the link reads the file', redeemed.status === 200,
  `status ${redeemed.status}`);
check('and the remaining count comes back',
  redeemed.headers.get('x-downloads-remaining') === '1',
  redeemed.headers.get('x-downloads-remaining') ?? 'absent');

const second = await delivery.GET(new Request(`${BASE}/d/${secret}`));
check('the second download is the last one allowed', second.status === 200);
const third = await delivery.GET(new Request(`${BASE}/d/${secret}`));
check('the third is refused: the cap is enforced', third.status >= 400, `status ${third.status}`);

const withUser = await share.POST(
  new Request(`${BASE}/api/files/${fileId}/share`, {
    method: 'POST', headers: { ...as('alice'), 'content-type': 'application/json' },
    body: JSON.stringify({ withUser: 'bob' }),
  }),
  ctx({ id: fileId }),
);
check('alice shares with bob by name', withUser.status === 201, `status ${withUser.status}`);

const bobReads = await delivery.GET(new Request(`${BASE}/f/${fileId}`, { headers: as('bob') }));
check('bob can now read it', bobReads.status === 200, `status ${bobReads.status}`);

const unshared = await share.DELETE(
  new Request(`${BASE}/api/files/${fileId}/share?user=bob`, {
    method: 'DELETE', headers: as('alice'),
  }),
  ctx({ id: fileId }),
);
check('alice unshares bob', unshared.status === 200, `status ${unshared.status}`);

const bobAgain = await delivery.GET(new Request(`${BASE}/f/${fileId}`, { headers: as('bob') }));
check('and bob is refused on his NEXT request, not at some TTL',
  bobAgain.status === 404, `status ${bobAgain.status}`);

const notOwner = await share.POST(
  new Request(`${BASE}/api/files/${fileId}/share`, {
    method: 'POST', headers: { ...as('bob'), 'content-type': 'application/json' },
    body: JSON.stringify({ withUser: 'carol' }),
  }),
  ctx({ id: fileId }),
);
check('bob cannot share a file he does not own', notOwner.status >= 400,
  `status ${notOwner.status}`);

// -----------------------------------------------------------------------------
// Listing
// -----------------------------------------------------------------------------

const listed = await files.GET(
  new Request(`${BASE}/api/files?org=acme`, { headers: as('alice') }),
);
const page = await listed.json();
check('alice lists her org\'s files', listed.status === 200 && Array.isArray(page.files ?? page),
  `status ${listed.status}`);

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed === 0 ? 0 : 1);
