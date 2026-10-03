/**
 * Drives the starter over HTTP and prints one line per step.
 *
 * It exists because "a starter that runs" is a claim, and a claim about this
 * repository is supposed to be executable. Point it at a running server:
 *
 *     DATABASE_URL=... node --experimental-strip-types server.ts &
 *     node verify.mjs
 */

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
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

const as = (user, init = {}) => ({
  ...init,
  headers: { 'x-user': user, ...(init.headers ?? {}) },
});

// 0. create the tenant, with alice as its OWNER
//
// Skipping this and letting the upload create `acme` is the trap this step
// exists to show: you end up a MEMBER of your own tenant, and step 5 then gets
// the same 404 a stranger gets.
const mk = await fetch(`${BASE}/orgs/acme`, as('alice', { method: 'POST' }));
check('the tenant is created with an owner', mk.status === 201, `status=${mk.status}`);

// 1. upload
const up = await fetch(`${BASE}/files?org=acme&name=contract.txt`, {
  ...as('alice', { method: 'POST', body: 'BOARD DECK' }),
  headers: { 'x-user': 'alice', 'content-type': 'text/plain' },
});
const { id } = await up.json();
check('upload returns 201 with an id', up.status === 201 && Boolean(id), `id=${id}`);

// 2. the owner reads it, a stranger does not
const mine = await fetch(`${BASE}/files/${id}`, as('alice'));
check('the owner reads the bytes back', mine.status === 200 && (await mine.text()) === 'BOARD DECK');

const theirs = await fetch(`${BASE}/files/${id}`, as('mallory'));
check('a stranger gets 404, never 403', theirs.status === 404, `status=${theirs.status}`);

const anon = await fetch(`${BASE}/files/${id}`);
check('no session is 401', anon.status === 401, `status=${anon.status}`);

// 3. a share link, capped at three downloads
const sh = await fetch(`${BASE}/files/${id}/share`, as('alice', { method: 'POST' }));
const share = await sh.json();
check('a share link is minted with a url', sh.status === 201 && Boolean(share.url), share.url);

let served = 0;
for (let i = 0; i < 4; i++) {
  const r = await fetch(share.url);
  if (r.status === 200) {
    served++;
    await r.text();
  }
}
check('the cap of three is a cap', served === 3, `served=${served} of 4 attempts`);

// 4. revocation, on a fresh link so the cap is not what stops it
const sh2 = await fetch(`${BASE}/files/${id}/share`, as('alice', { method: 'POST' }));
const share2 = await sh2.json();
const before = await fetch(share2.url);
check('the fresh link works before revocation', before.status === 200);
await before.text();

const rev = await fetch(`${BASE}/shares/${share2.grantId}`, as('alice', { method: 'DELETE' }));
check('the owner revokes it', rev.status === 200);

const after = await fetch(share2.url);
check('and the next request fails immediately', after.status === 404, `status=${after.status}`);

// 5. the audit trail, denials included
const log = await fetch(`${BASE}/orgs/acme/audit`, as('alice'));
const { events = [] } = await log.json();
check(
  'the org owner reads the audit log',
  log.status === 200 && events.length > 0,
  `status=${log.status}, ${events.length} events`,
);
check(
  'and the refusals are in it',
  events.some((e) => String(e).includes('deny')),
  events.filter((e) => String(e).includes('deny')).slice(0, 3).join(' | '),
);

const notMine = await fetch(`${BASE}/orgs/acme/audit`, as('mallory'));
check('a stranger cannot read it', notMine.status === 404, `status=${notMine.status}`);

// 6. the four things an adversarial sweep broke on 3 October 2026
//
// Each of these passed as a 500, a duplicate tenant, or a 1.3 GB process
// before the fix. They are HTTP-level, so they belong here rather than in the
// library's own suite.

// A percent-escaped tenant name must mean ONE tenant, not two.
//
// The path used to go undecoded while `searchParams` was decoded, so
// `POST /orgs/my%20team` created a tenant literally named `my%20team` and
// `POST /files?org=my team` created a SECOND one called `my team` -- and joined
// the uploader to it as a member rather than an owner, which is precisely the
// trap step 0 of this script exists to demonstrate. Both halves returned 201,
// so the only way to see it is to ask the tenant whether the upload is in it.
const TEAM = 'my team';
const esc = await fetch(`${BASE}/orgs/${encodeURIComponent(TEAM)}`, as('alice', { method: 'POST' }));
check('an escaped tenant name is created once', esc.status === 201, `status=${esc.status}`);
const escUp = await fetch(`${BASE}/files?org=${encodeURIComponent(TEAM)}&name=decoded.txt`, {
  ...as('alice', { method: 'POST', body: 'X' }),
  headers: { 'x-user': 'alice', 'content-type': 'text/plain' },
});
check('and the upload is accepted', escUp.status === 201, `status=${escUp.status}`);
const escLog = await fetch(`${BASE}/orgs/${encodeURIComponent(TEAM)}/audit`, as('alice'));
const escEvents = escLog.ok ? ((await escLog.json()).events ?? []) : [];
check(
  'and it landed in THAT tenant, not in a second one with the escape in its name',
  escLog.status === 200 && escEvents.some((e) => String(e).includes('decoded.txt')),
  `status=${escLog.status}, ${escEvents.length} events, ` +
    `${escEvents.filter((e) => String(e).includes('decoded.txt')).length} naming the file`,
);

// A malformed escape is a 400, not a stack trace.
const bad = await fetch(`${BASE}/orgs/%zz`, as('alice', { method: 'POST' }));
check('a malformed path escape is a 400', bad.status === 400, `status=${bad.status}`);

// An upload above the ceiling is refused by the ceiling, not by the OOM killer.
const tooBig = await fetch(`${BASE}/files?org=acme&name=big.bin`, {
  ...as('alice', { method: 'POST', body: new Uint8Array(30 * 1024 * 1024) }),
  headers: { 'x-user': 'alice', 'content-type': 'application/octet-stream' },
}).catch((e) => ({ status: `threw:${e.code ?? e.message}` }));
check(
  'an upload over MAX_UPLOAD_BYTES is refused',
  tooBig.status === 413,
  `status=${tooBig.status}`,
);

// Three unmatched shapes that used to reach a handler with the wrong arity.
for (const path of ['/files/x/share/extra', '/orgs/acme/audit/extra']) {
  const r = await fetch(`${BASE}${path}`, as('alice', { method: path.includes('share') ? 'POST' : 'GET' }));
  check(`${path} is 404, not a 500`, r.status === 404, `status=${r.status}`);
}

console.log(`\n==== ${passed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
