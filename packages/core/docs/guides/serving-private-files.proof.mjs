#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `serving-private-files.md`, REPRODUCIBLE.
 *
 *     node docs/guides/serving-private-files.proof.mjs
 *
 * No PostgreSQL server and nothing to install beyond the package's own
 * dependencies: PGlite runs Postgres in-process. About five seconds.
 *
 * What it demonstrates, in order:
 *
 *   1. A real HTTP server, a 26-byte object, and every `Range` header a client
 *      actually sends -- with the status, the `Content-Range` and the bytes
 *      that came back. Twenty-six distinguishable bytes, so an off-by-one is
 *      visible rather than plausible.
 *
 *   2. THE FIVE CASES THAT LOOK LIKE 416 AND ARE NOT. This is the part worth
 *      running: every one of them is a range the server cannot serve as asked,
 *      and in every one of them 416 is the wrong answer. RFC 9110 says an
 *      unparseable or invalid range MUST BE IGNORED -- answer 200 with the
 *      whole representation -- and reserves 416 for a range that parsed
 *      cleanly and cannot be satisfied by THIS object.
 *
 *   3. Revocation on the proxy path, measured mid-stream: the reader is
 *      seeking through the file, access is withdrawn, and the next range
 *      request is refused. This is the property a presigned URL cannot have,
 *      and it is the entire reason to pay for proxying.
 *
 * Nothing here is Filelayer-specific except the import. The statuses are
 * RFC 9110's and the table is what any correct implementation must produce.
 */

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// THIS FILE SHIPS IN THE TARBALL, so it has to find the library from two
// different places: `<checkout>/docs/guides/` and `<node_modules>/@filelayer/
// core/docs/guides/`. A static `../../packages/core/src/index.ts` resolves from
// the first and silently not from the second -- which `npm run check:install-
// reach` catches, and did, which is why this probe exists rather than the one
// line that reads better.
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(HERE, '..', '..', 'packages', 'core', 'src', 'index.ts'), // the checkout
  join(HERE, '..', '..', 'src', 'index.ts'), // an install
];
const entry = CANDIDATES.find(existsSync);
if (!entry) {
  console.error(`could not find the library from ${HERE}; looked in:\n  ${CANDIDATES.join('\n  ')}`);
  process.exit(1);
}
const { createTestDb, Filelayer, MemoryStorage, deliveryHandler, parseRangeHeader } =
  await import(entry);

/** Every byte distinguishable: a wrong offset reads as the wrong letters. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.error(`  FAILED  ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
  return ok;
};

const { db } = await createTestDb();
const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });

const alice = (await fl.createActor('alice')).id;
const bob = (await fl.createActor('bob')).id;
const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
const file = await fl.upload({ actorId: alice }, org, {
  name: 'alphabet.txt',
  contentType: 'text/plain',
  body: new TextEncoder().encode(ALPHABET),
});

// `principal` is read per request, so the proof can change who is asking
// without restarting the server -- which is exactly what step 3 needs.
let caller = alice;
const server = createServer(deliveryHandler(fl, { principal: () => ({ actorId: caller }) }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function get(range) {
  const res = await fetch(`${base}/f/${file.id}`, {
    headers: range === undefined ? {} : { range },
  });
  return {
    status: res.status,
    contentRange: res.headers.get('content-range'),
    acceptRanges: res.headers.get('accept-ranges'),
    body: res.status < 400 ? await res.text() : '',
  };
}

const pad = (s, w) => String(s).padEnd(w);
const show = (raw, r) =>
  console.log(
    `| ${pad(raw === undefined ? '(none)' : raw, 20)} | ${pad(r.status, 6)} | ` +
      `${pad(r.contentRange ?? '-', 22)} | ${pad(r.acceptRanges ?? '-', 13)} | ${r.body || '-'} |`,
  );

const header = () => {
  console.log('\n| Range header         | status | Content-Range          | Accept-Ranges | body |');
  console.log('|---|---|---|---|---|');
};

// -----------------------------------------------------------------------------
console.log('\n1 · WHAT A CLIENT ACTUALLY SENDS');
console.log(`   object: ${ALPHABET.length} bytes, "${ALPHABET}"`);
header();

for (const [raw, expect] of [
  [undefined, { status: 200, body: ALPHABET }],
  // What a `<video>` element sends to discover whether it may seek at all.
  ['bytes=0-', { status: 206, body: ALPHABET }],
  ['bytes=0-4', { status: 206, body: 'abcde' }],
  ['bytes=5-9', { status: 206, body: 'fghij' }],
  // What a PDF reader sends FIRST: the cross-reference table is at the end of
  // the document, so the last bytes are read before the first ones.
  ['bytes=-4', { status: 206, body: 'wxyz' }],
  ['bytes=20-', { status: 206, body: 'uvwxyz' }],
  // Past the end but satisfiable: RFC 9110 says serve to the end, not 416.
  ['bytes=20-999', { status: 206, body: 'uvwxyz' }],
]) {
  const r = await get(raw);
  show(raw, r);
  check(`${raw} status`, r.status, expect.status);
  check(`${raw} body`, r.body, expect.body);
  check(`${raw} advertises Accept-Ranges`, r.acceptRanges, 'bytes');
}

// -----------------------------------------------------------------------------
console.log('\n2 · THE FIVE CASES THAT LOOK LIKE 416 AND ARE NOT');
console.log('   Every one is a range the server will not serve as asked.');
console.log('   416 is wrong in all five, and in four of them the parser never');
console.log('   even reaches the object: an invalid range is IGNORED.');
header();

for (const [raw, why, expect] of [
  ['bytes=9-4', 'last-pos before first-pos: invalid, so ignored', { status: 200, body: ALPHABET }],
  ['bytes=-0', 'a suffix of zero asks for nothing', { status: 200, body: ALPHABET }],
  ['bytes=abc', 'unparseable', { status: 200, body: ALPHABET }],
  ['items=0-4', 'a unit that is not bytes', { status: 200, body: ALPHABET }],
  // The one that is genuinely two questions. Answering the first under a 206
  // is the trap: the status code says nothing about having answered one of
  // two, so the client stitches the reply in at the wrong offset.
  ['bytes=0-4,10-14', 'multiple ranges: answered whole, deliberately', { status: 200, body: ALPHABET }],
]) {
  const r = await get(raw);
  show(raw, r);
  console.log(`|   ↳ ${why}`.padEnd(60) + '|');
  check(`${raw} status`, r.status, expect.status);
  check(`${raw} body`, r.body, expect.body);
  check(`${raw} parses to null`, parseRangeHeader(raw), null);
}

console.log('\n   And the one case that IS a 416 -- parsed cleanly, cannot be satisfied:');
header();
const past = await get('bytes=99-120');
show('bytes=99-120', past);
check('416 status', past.status, 416);
check('416 carries the size', past.contentRange, `bytes */${ALPHABET.length}`);

// -----------------------------------------------------------------------------
console.log('\n3 · REVOCATION, MID-STREAM');
console.log('   Bob is reading the file through the server, a range at a time.');

const grant = await fl.share({ actorId: alice }, file.id, {
  subject: { type: 'actor', actorId: bob },
  capabilities: ['read'],
});
caller = bob;

const before = await get('bytes=0-4');
console.log(`   bob, bytes=0-4   -> ${before.status} ${before.body}`);
check('bob can read before revocation', before.status, 206);

await fl.revoke({ actorId: alice }, grant.grantId);
console.log('   ... alice revokes, with the read in progress');

const after = await get('bytes=5-9');
console.log(`   bob, bytes=5-9   -> ${after.status} (nothing served)`);
check('bob is refused on the next range', after.status >= 400, true);

console.log(
  '\n   A presigned URL handed to bob instead would still be serving those\n' +
    '   bytes until it expired. That is the trade, stated as a number: the\n' +
    '   revocation window of a presigned URL is its remaining TTL, and the\n' +
    '   revocation window of a proxied read is one request.',
);

server.close();
await db.end?.();

console.log(
  failures === 0
    ? '\nAll measurements reproduced.\n'
    : `\n${failures} measurement(s) did not reproduce. The guide is wrong, or this is.\n`,
);
process.exit(failures === 0 ? 0 : 1);
