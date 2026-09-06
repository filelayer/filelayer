/**
 * LIVE S3 / R2 INTEGRATION.
 *
 * SKIPPED unless real credentials are present in the environment. Present them
 * and it runs automatically -- in CI, in a local shell, anywhere -- with no flag
 * to remember and no separate command. That is deliberate: a suite you have to
 * opt into by name is a suite nobody runs.
 *
 * -----------------------------------------------------------------------------
 * WHAT A MAINTAINER MUST SET
 * -----------------------------------------------------------------------------
 *
 * The bucket, the token permissions and the exact secret names are specified in
 * ONE place -- `docs/LIVE-S3-TESTS.md` -- and this file deliberately does not
 * restate them. Two copies of a setup procedure drift, and the copy that drifts
 * is the one nobody followed most recently.
 *
 * What this file reads, and nothing more:
 *
 *   REQUIRED, all five or the suite skips:
 *     FILELAYER_TEST_S3_ENDPOINT, FILELAYER_TEST_S3_BUCKET,
 *     FILELAYER_TEST_S3_REGION, FILELAYER_TEST_S3_ACCESS_KEY_ID,
 *     FILELAYER_TEST_S3_SECRET_ACCESS_KEY
 *
 *   OPTIONAL:
 *     FILELAYER_TEST_S3_SESSION_TOKEN, FILELAYER_TEST_S3_PATH_STYLE,
 *     FILELAYER_TEST_S3_PREFIX, FILELAYER_TEST_S3_MULTIPART
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS EVEN THOUGH test/storage.test.ts PASSES
 * -----------------------------------------------------------------------------
 *
 * `test/storage.test.ts` proves the WIRE FORMAT against a server that verifies
 * every signature. It cannot prove anything about the counterparty: TLS, real
 * IAM evaluation, R2's divergences from S3, AWS's checksum requirements,
 * throttling and retry behaviour, read-after-write visibility, or the specific
 * error codes a real store returns. Those are the things that break a storage
 * adapter in production, and none of them can be simulated honestly. This suite
 * is where they get tested; until it has run against a real bucket, the adapter
 * is "wire-correct" and not "proven".
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { S3Storage, bytesToStream, collectStream } from '../src/storage.ts';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { REDIRECT_ACKNOWLEDGEMENT } from '../src/delivery.ts';

const env = process.env;
const REQUIRED = [
  'FILELAYER_TEST_S3_ENDPOINT',
  'FILELAYER_TEST_S3_BUCKET',
  'FILELAYER_TEST_S3_REGION',
  'FILELAYER_TEST_S3_ACCESS_KEY_ID',
  'FILELAYER_TEST_S3_SECRET_ACCESS_KEY',
] as const;

const missing = REQUIRED.filter((k) => !env[k]);
const enabled = missing.length === 0;
const skip = enabled
  ? false
  : `live S3 credentials not present (missing: ${missing.join(', ')}); see docs/LIVE-S3-TESTS.md`;

// `||`, not `??`: a workflow that forwards an unset repository variable hands
// us the EMPTY STRING, and `'' ?? default` is `''` -- which would root every
// test key at '/' instead of under the prefix that gets cleaned up.
const PREFIX = (env['FILELAYER_TEST_S3_PREFIX'] || 'filelayer-ci/').replace(/\/*$/, '/');
const RUN = `${PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 8)}/`;
const MULTIPART = env['FILELAYER_TEST_S3_MULTIPART'] === '1';

function makeStorage(): S3Storage {
  return new S3Storage({
    endpoint: env['FILELAYER_TEST_S3_ENDPOINT']!,
    bucket: env['FILELAYER_TEST_S3_BUCKET']!,
    region: env['FILELAYER_TEST_S3_REGION']!,
    accessKeyId: env['FILELAYER_TEST_S3_ACCESS_KEY_ID']!,
    secretAccessKey: env['FILELAYER_TEST_S3_SECRET_ACCESS_KEY']!,
    ...(env['FILELAYER_TEST_S3_SESSION_TOKEN']
      ? { sessionToken: env['FILELAYER_TEST_S3_SESSION_TOKEN'] }
      : {}),
    ...(env['FILELAYER_TEST_S3_PATH_STYLE'] === 'false' ? { pathStyle: false } : {}),
    partSizeBytes: 5 * 1024 * 1024,
  });
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

describe('S3Storage against LIVE object storage', { skip }, () => {
  let store: S3Storage;
  const written: string[] = [];
  const key = (name: string) => {
    const k = `${RUN}${name}`;
    written.push(k);
    return k;
  };

  before(() => {
    store = makeStorage();
  });

  // Best effort, and loud if it fails: a test suite that leaves objects in a
  // customer-shaped bucket is a test suite that costs money forever.
  after(async () => {
    if (!enabled) return;
    for (const k of written) {
      try {
        await store.delete(k);
      } catch (err) {
        console.error(`LEAKED TEST OBJECT ${k}: ${String(err)}`);
      }
    }
  });

  it('reports which provider it is', () => {
    assert.ok(['s3', 'r2'].includes(store.provider), `unexpected provider ${store.provider}`);
  });

  it('put / get / head / delete', async () => {
    const k = key('basic.txt');
    const r = await store.put(k, enc('live hello'), 'text/plain');
    assert.equal(r.bytes, 10);
    assert.ok(r.etag, 'a real store returns an ETag');

    assert.equal(dec((await store.get(k))!), 'live hello');

    const h = await store.head(k);
    assert.equal(h!.size, 10);
    // R2 and S3 both echo the content type; if this fails the adapter is not
    // sending it on the PUT, which the local harness cannot detect because it
    // stores whatever it is given.
    assert.equal(h!.contentType, 'text/plain');
    assert.ok(h!.lastModified instanceof Date && !Number.isNaN(h!.lastModified.getTime()));

    await store.delete(k);
    assert.equal(await store.get(k), null);
    assert.equal(await store.head(k), null);
  });

  it('a missing key is null, not a thrown error', async () => {
    assert.equal(await store.get(`${RUN}definitely-absent`), null);
    assert.equal(await store.head(`${RUN}definitely-absent`), null);
    assert.equal(await store.stream(`${RUN}definitely-absent`), null);
  });

  it('deleting an absent key succeeds', async () => {
    await store.delete(`${RUN}also-absent`);
  });

  it('survives keys with characters that break naive URL construction', async () => {
    // The exact class of key that made the previous adapter write to the wrong
    // object. Worth running against a real store because S3 and R2 disagree
    // with each other about some of these.
    for (const name of ['a#b.txt', 'a b.txt', 'a+b.txt', "a'b(c).txt", 'ünï-Ω.txt', 'a,b;c@d.txt']) {
      const k = key(name);
      await store.put(k, enc(`v:${name}`), 'application/octet-stream');
      assert.equal(dec((await store.get(k))!), `v:${name}`, name);
    }
    // A '?' in a key is legal in S3 but several proxies mangle it, so it is
    // asserted separately and its failure is informative rather than fatal to
    // the rest of the suite.
    const q = key('a?b.txt');
    await store.put(q, enc('q'), 'application/octet-stream');
    assert.equal(dec((await store.get(q))!), 'q');
  });

  it('streams, and honours ranges', async () => {
    const k = key('range.bin');
    await store.put(k, enc('abcdefghij'), 'application/octet-stream');

    const whole = (await store.stream(k))!;
    assert.equal(dec(await collectStream(whole.body)), 'abcdefghij');
    assert.equal(whole.size, 10);

    const part = (await store.stream(k, { range: { start: 2, end: 5 } }))!;
    assert.equal(dec(await collectStream(part.body)), 'cdef');
    assert.deepEqual(part.range, { start: 2, end: 5, total: 10 });

    const tail = (await store.stream(k, { range: { start: 8 } }))!;
    assert.equal(dec(await collectStream(tail.body)), 'ij');
  });

  it('lists with a prefix', async () => {
    const a = key('list/1');
    const b = key('list/2');
    await store.put(a, enc('1'), 'text/plain');
    await store.put(b, enc('2'), 'text/plain');
    const page = await store.list(`${RUN}list/`);
    const keys = page.entries.map((e) => e.key).sort();
    assert.deepEqual(keys, [a, b].sort());
    assert.ok(page.entries[0]!.lastModified instanceof Date, 'orphan collection needs this');
    assert.equal(page.entries[0]!.size, 1);
  });

  it('presigns a GET the real store honours, with pinned response headers', async () => {
    const k = key('presigned.html');
    await store.put(k, enc('<b>hi</b>'), 'text/html');
    const url = await store.presignGet(k, {
      expiresInSeconds: 60,
      responseContentType: 'application/octet-stream',
      responseContentDisposition: 'attachment; filename="x.html"',
    });
    const res = await fetch(url);
    const body = await res.text();
    assert.equal(res.status, 200, body);
    // If this fails, redirect delivery would serve user-uploaded HTML as HTML.
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(body, '<b>hi</b>');
  });

  it('a presigned URL expires, and a tampered one is refused', async () => {
    const k = key('expiring.txt');
    await store.put(k, enc('x'), 'text/plain');
    const url = await store.presignGet(k, { expiresInSeconds: 1 });
    assert.equal((await fetch(url)).status, 200);
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal((await fetch(url)).status, 403, 'the real store must enforce the expiry');

    const fresh = await store.presignGet(k, { expiresInSeconds: 60 });
    const tampered = fresh.replace('expiring.txt', 'something-else.txt');
    assert.ok([403, 404].includes((await fetch(tampered)).status));
  });

  it('surfaces a real error code rather than a bare status', async () => {
    const bad = new S3Storage({
      endpoint: env['FILELAYER_TEST_S3_ENDPOINT']!,
      bucket: env['FILELAYER_TEST_S3_BUCKET']!,
      region: env['FILELAYER_TEST_S3_REGION']!,
      accessKeyId: env['FILELAYER_TEST_S3_ACCESS_KEY_ID']!,
      secretAccessKey: `${env['FILELAYER_TEST_S3_SECRET_ACCESS_KEY']}-wrong`,
    });
    await assert.rejects(
      () => bad.get(`${RUN}whatever`),
      /SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied/,
    );
  });

  it(
    'multipart: uploads a stream larger than one part, byte-exactly',
    { skip: MULTIPART ? false : 'set FILELAYER_TEST_S3_MULTIPART=1 (uploads ~11 MB)' },
    async () => {
      const k = key('multipart.bin');
      const total = 5 * 1024 * 1024 * 2 + 1234;
      const src = new Uint8Array(total);
      let x = 0x9e3779b9;
      for (let i = 0; i < total; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        src[i] = x & 0xff;
      }
      const r = await store.put(k, bytesToStream(src), 'application/octet-stream');
      assert.equal(r.bytes, total);
      assert.equal((await store.head(k))!.size, total);
      const back = await collectStream((await store.stream(k))!.body);
      assert.deepEqual(Buffer.from(back), Buffer.from(src));
    },
  );
});

describe('Filelayer end to end against LIVE object storage', { skip }, () => {
  it('uploads, authorizes, delivers, redirects and deletes', async () => {
    const storage = makeStorage();
    const { db } = await createTestDb();
    const fl = new Filelayer(db, storage, {
      baseUrl: 'https://files.test',
      redirectDelivery: {
        acknowledgeRevocationWindow: REDIRECT_ACKNOWLEDGEMENT,
        ttlSeconds: 60,
      },
    });
    const alice = (await fl.createActor('live-alice')).id;
    const org = (await fl.createOrg('live-org', 'Live', { ownerActorId: alice })).id;

    const file = await fl.upload({ actorId: alice }, org, {
      name: 'live.txt',
      contentType: 'text/plain',
      body: enc('end to end'),
    });
    // The whole point of defect #1: the row must name the store the bytes are
    // actually in.
    assert.equal(file.storageProvider, storage.provider);
    const { rows } = await db.query<{ storage_provider: string }>(
      `SELECT storage_provider FROM file WHERE id = $1`,
      [file.id],
    );
    assert.equal(rows[0]!.storage_provider, storage.provider);

    assert.equal(dec((await fl.read({ actorId: alice }, file.id)).body), 'end to end');

    await fl.share({ actorId: alice }, file.id, { subject: { type: 'anonymous' } });
    const d = await fl.readStream({ actorId: null }, file.id, { mode: 'auto' });
    assert.equal(d.mode, 'redirect', 'an anonymous grant is eligible for redirect delivery');
    if (d.mode === 'redirect') {
      const res = await fetch(d.url);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'end to end');
    }

    await fl.delete({ actorId: alice }, file.id);
    assert.equal(await storage.get(file.storageKey), null, 'the bytes are really gone');
    assert.equal((await fl.store.verifyAuditChain(org)).valid, true);
  });
});

if (!enabled) {
  // One line, so a CI log makes it obvious the suite did not run and why. A
  // silent skip is how a suite stays skipped for a year.
  console.error(`[s3-live] SKIPPED -- ${skip}`);
}
