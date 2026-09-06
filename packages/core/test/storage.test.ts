/**
 * THE S3 ADAPTER, ACTUALLY EXERCISED.
 *
 * `S3Storage` shipped as "included so the interface is proven to be
 * implementable against real object storage, not because it has been
 * exercised". This suite exercises it, against `test/local-s3.mjs` -- a local
 * S3-protocol server that recomputes every SigV4 signature from the request as
 * received and returns `SignatureDoesNotMatch` on any mismatch.
 *
 * WHAT THIS PROVES: the wire format. Canonical URI encoding, canonical query
 * string ordering, header canonicalisation, the payload hash, the signing key
 * derivation, multipart sequencing and part-size rules, ranged reads, HEAD,
 * DELETE, list pagination, and presigned URL construction including expiry.
 *
 * WHAT IT DOES NOT PROVE: anything about real AWS or real R2 -- TLS, IAM policy
 * evaluation, R2's divergences from S3, eventual consistency, throttling,
 * checksum algorithms AWS may require in future. See `test/s3-live.test.ts`,
 * which runs the same operations against a real bucket when the
 * `FILELAYER_TEST_S3_*` environment variables are set, and skips otherwise.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { createLocalS3 } from './local-s3.mjs';
import {
  MemoryStorage,
  S3Storage,
  bytesToStream,
  canonicalQueryString,
  collectStream,
  rfc3986,
} from '../src/storage.ts';

const AK = 'AKIAFILELAYERTEST000';
const SK = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

describe('S3Storage against a signature-verifying local S3', () => {
  let s3: ReturnType<typeof createLocalS3>;
  let store: S3Storage;
  const sigFailures: unknown[] = [];

  before(async () => {
    s3 = createLocalS3({ accessKeyId: AK, secretAccessKey: SK, bucket: 'fl-test' });
    s3.server.on('sigfail', (v: unknown) => sigFailures.push(v));
    await s3.listen();
    store = new S3Storage({
      endpoint: s3.endpoint(),
      bucket: 'fl-test',
      region: 'auto',
      accessKeyId: AK,
      secretAccessKey: SK,
      partSizeBytes: 5 * 1024 * 1024,
    });
  });

  after(async () => {
    await s3.close();
  });

  it('never produces a signature the server rejects', async () => {
    // Asserted at the end of the suite too, but stated here so the failure
    // message names the real problem rather than a downstream symptom.
    assert.deepEqual(sigFailures, []);
  });

  it('put/get/head/delete round trip', async () => {
    const r = await store.put('org/one.txt', enc('hello world'), 'text/plain');
    assert.equal(r.bytes, 11);
    assert.ok(r.etag);

    assert.equal(dec((await store.get('org/one.txt'))!), 'hello world');

    const h = await store.head('org/one.txt');
    assert.equal(h!.size, 11);
    assert.equal(h!.contentType, 'text/plain');
    assert.ok(h!.lastModified instanceof Date);

    await store.delete('org/one.txt');
    assert.equal(await store.get('org/one.txt'), null);
    assert.equal(await store.head('org/one.txt'), null);
  });

  it('a missing key is null, not an exception', async () => {
    assert.equal(await store.get('org/nope'), null);
    assert.equal(await store.head('org/nope'), null);
    assert.equal(await store.stream('org/nope'), null);
  });

  it('deleting a key that never existed is not an error', async () => {
    await store.delete('org/never-existed');
  });

  /**
   * BUG #1 (fixed). The old adapter built the URL with `encodeURI(key)`, which
   * leaves `#?&=+,:;@$!'()*` unescaped. A `#` truncated the request at the
   * fragment, a `?` started a query string, and a `+` signed one byte sequence
   * while sending another. Every one of these is a 403 or a silent write to the
   * wrong key.
   */
  it('handles keys containing characters encodeURI would have left alone', async () => {
    const nasty = [
      'org/a#b.txt',
      'org/a?b.txt',
      'org/a+b.txt',
      'org/a b.txt',
      'org/a&b=c.txt',
      "org/a'b(c).txt",
      'org/a,b;c:d@e.txt',
      'org/ünïcøde-Ω.txt',
      'org/a%2Fb.txt',
      'org/sub/dir/deep.txt',
    ];
    for (const key of nasty) {
      await store.put(key, enc(`v:${key}`), 'application/octet-stream');
      assert.equal(dec((await store.get(key))!), `v:${key}`, key);
      assert.equal((await store.head(key))!.size, enc(`v:${key}`).byteLength, key);
    }
    // The keys really are distinct objects on the server, i.e. nothing collided.
    for (const key of nasty) assert.ok(s3.objects.has(key), `server is missing ${key}`);
    for (const key of nasty) await store.delete(key);
  });

  it('a key with a literal + is not confused with a space', async () => {
    await store.put('org/plus+key', enc('plus'), 'text/plain');
    await store.put('org/space key', enc('space'), 'text/plain');
    assert.equal(dec((await store.get('org/plus+key'))!), 'plus');
    assert.equal(dec((await store.get('org/space key'))!), 'space');
  });

  it('streams, with the right length and content type', async () => {
    await store.put('org/stream.bin', enc('0123456789'), 'application/pdf');
    const s = (await store.stream('org/stream.bin'))!;
    assert.equal(s.size, 10);
    assert.equal(s.contentType, 'application/pdf');
    assert.equal(dec(await collectStream(s.body)), '0123456789');
  });

  it('honours ranges and reports content-range', async () => {
    await store.put('org/range.bin', enc('abcdefghij'), 'text/plain');
    const mid = (await store.stream('org/range.bin', { range: { start: 2, end: 5 } }))!;
    assert.equal(dec(await collectStream(mid.body)), 'cdef');
    assert.deepEqual(mid.range, { start: 2, end: 5, total: 10 });

    const tail = (await store.stream('org/range.bin', { range: { start: 7 } }))!;
    assert.equal(dec(await collectStream(tail.body)), 'hij');
    assert.deepEqual(tail.range, { start: 7, end: 9, total: 10 });

    // A range past the end is 416, which we surface as "no such bytes".
    assert.equal(await store.stream('org/range.bin', { range: { start: 999 } }), null);
  });

  /**
   * BUG #2 (fixed). There was no multipart path at all: `put()` took a
   * `Uint8Array`, so a large upload was a single PUT of an entirely resident
   * buffer. S3 caps a single PUT at 5 GB and the heap caps it far lower.
   */
  it('uploads a large stream via multipart and reassembles it byte-exactly', async () => {
    const partSize = 5 * 1024 * 1024;
    const total = partSize * 2 + 1234; // 3 parts: full, full, remainder
    const source = deterministicStream(total, 64 * 1024);

    const r = await store.put('org/big.bin', source, 'application/octet-stream');
    assert.equal(r.bytes, total);

    const stored = s3.objects.get('org/big.bin')!.body;
    assert.equal(stored.length, total);
    assert.deepEqual(
      Buffer.from(stored.subarray(0, 4096)),
      Buffer.from(deterministicBytes(total).subarray(0, 4096)),
    );
    assert.deepEqual(Buffer.from(stored), Buffer.from(deterministicBytes(total)));

    const posts = s3.requestLog.filter((l) => l.key === 'org/big.bin' && l.method === 'PUT' && l.query['uploadId']);
    assert.equal(posts.length, 3, 'exactly three UploadPart calls');
    await store.delete('org/big.bin');
  });

  it('a stream that fits in one part does NOT start a multipart upload', async () => {
    const before = s3.uploads.size;
    const r = await store.put('org/small-stream.bin', bytesToStream(enc('tiny')), 'text/plain');
    assert.equal(r.bytes, 4);
    assert.equal(s3.uploads.size, before, 'no multipart upload was created');
    const initiates = s3.requestLog.filter(
      (l) => l.key === 'org/small-stream.bin' && 'uploads' in l.query,
    );
    assert.equal(initiates.length, 0);
    assert.equal(dec((await store.get('org/small-stream.bin'))!), 'tiny');
  });

  it('an empty stream produces an empty object, not a failed multipart', async () => {
    const r = await store.put('org/empty.bin', bytesToStream(new Uint8Array(0)), 'text/plain');
    assert.equal(r.bytes, 0);
    assert.equal((await store.get('org/empty.bin'))!.byteLength, 0);
  });

  /**
   * BUG #3 (fixed). A failed multipart upload used to be impossible because
   * multipart did not exist; now that it does, an abandoned upload is billable
   * storage nothing points at. The adapter aborts on any part failure.
   */
  it('aborts the multipart upload when a part fails', async () => {
    s3.clearFaults();
    let seen = 0;
    s3.injectFault({ key: 'org/doomed.bin', method: 'PUT', status: 503, code: 'SlowDown' });
    const before = s3.uploads.size;
    await assert.rejects(
      () => store.put('org/doomed.bin', deterministicStream(6 * 1024 * 1024, 64 * 1024), 'application/octet-stream'),
      /uploadPart failed: 503 SlowDown/,
    );
    s3.clearFaults();
    seen = s3.uploads.size;
    assert.equal(seen, before, 'the abandoned upload was aborted, not leaked');
    assert.equal(s3.objects.has('org/doomed.bin'), false);
  });

  /**
   * BUG #4 (fixed). Errors were thrown as `storage get failed: 403`. Three
   * completely different operational problems -- a wrong policy, a rotated key
   * and a signing bug in our own code -- are all 403, and the status alone sends
   * you to the wrong one.
   */
  it('surfaces the S3 error code, not just the status', async () => {
    s3.deactivateAccessKey(AK);
    await assert.rejects(() => store.get('org/anything'), /InvalidAccessKeyId/);
    s3.activateAccessKey(AK);
  });

  it('a wrong secret produces SignatureDoesNotMatch, proving the server verifies', async () => {
    const wrong = new S3Storage({
      endpoint: s3.endpoint(),
      bucket: 'fl-test',
      region: 'auto',
      accessKeyId: AK,
      secretAccessKey: SK + 'x',
    });
    await assert.rejects(() => wrong.put('org/x', enc('x'), 'text/plain'), /SignatureDoesNotMatch/);
    // ...and the harness saw it as a signature failure, which is the whole
    // reason this harness is worth having.
    assert.ok(sigFailures.length >= 1);
    sigFailures.length = 0;
  });

  it('lists with a prefix and paginates', async () => {
    for (let i = 0; i < 7; i++) await store.put(`lst/${i}`, enc(String(i)), 'text/plain');
    const first = await store.list('lst/', { limit: 3 });
    assert.equal(first.entries.length, 3);
    assert.ok(first.cursor);
    const second = await store.list('lst/', { limit: 10, cursor: first.cursor });
    assert.equal(second.entries.length, 4);
    assert.equal(second.cursor, null);
    const keys = [...first.entries, ...second.entries].map((e) => e.key);
    assert.deepEqual(keys, ['lst/0', 'lst/1', 'lst/2', 'lst/3', 'lst/4', 'lst/5', 'lst/6']);
    assert.equal(first.entries[0]!.size, 1);
    assert.ok(first.entries[0]!.lastModified instanceof Date);
  });

  it('presigns a GET that the store accepts, with the response headers pinned', async () => {
    await store.put('org/presigned.txt', enc('presigned body'), 'text/html');
    const url = await store.presignGet('org/presigned.txt', {
      expiresInSeconds: 60,
      responseContentType: 'application/octet-stream',
      responseContentDisposition: 'attachment; filename="x.txt"',
    });
    const res = await fetch(url);
    assert.equal(res.status, 200);
    // The STORE serves the neutralised type, so a redirect cannot lose the
    // protections `deliveryHeaders()` guarantees on the proxied path.
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="x.txt"');
    assert.equal(await res.text(), 'presigned body');
  });

  it('a presigned URL expires', async () => {
    await store.put('org/expiring.txt', enc('x'), 'text/plain');
    const url = await store.presignGet('org/expiring.txt', { expiresInSeconds: 1 });
    assert.equal((await fetch(url)).status, 200);
    await new Promise((r) => setTimeout(r, 1100));
    const late = await fetch(url);
    assert.equal(late.status, 403);
    assert.match(await late.text(), /AccessDenied/);
  });

  it('a tampered presigned URL is rejected', async () => {
    await store.put('org/tamper.txt', enc('secret'), 'text/plain');
    await store.put('org/other.txt', enc('other'), 'text/plain');
    const url = await store.presignGet('org/tamper.txt', { expiresInSeconds: 60 });
    const swapped = url.replace('tamper.txt', 'other.txt');
    const res = await fetch(swapped);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /SignatureDoesNotMatch/);
    sigFailures.length = 0;
  });

  it('clamps a presigned TTL to the adapter ceiling', async () => {
    const capped = new S3Storage({
      endpoint: s3.endpoint(),
      bucket: 'fl-test',
      region: 'auto',
      accessKeyId: AK,
      secretAccessKey: SK,
      maxPresignSeconds: 30,
    });
    const url = await capped.presignGet('org/tamper.txt', { expiresInSeconds: 86400 });
    assert.match(url, /X-Amz-Expires=30(&|$)/);
  });

  it('names itself, and derives r2 from an R2 endpoint', () => {
    assert.equal(store.provider, 's3');
    assert.equal(
      new S3Storage({
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
        bucket: 'b',
        region: 'auto',
        accessKeyId: 'a',
        secretAccessKey: 'b',
      }).provider,
      'r2',
    );
    assert.equal(
      new S3Storage({
        endpoint: 'https://abc123.r2.cloudflarestorage.com',
        bucket: 'b',
        region: 'auto',
        accessKeyId: 'a',
        secretAccessKey: 'b',
        provider: 'r2-eu',
      }).provider,
      'r2-eu',
    );
  });

  it('refuses to construct with missing configuration', () => {
    assert.throws(
      () =>
        new S3Storage({
          endpoint: '',
          bucket: 'b',
          region: 'auto',
          accessKeyId: 'a',
          secretAccessKey: 'b',
        }),
      /missing required config 'endpoint'/,
    );
  });

  it('supports virtual-hosted style URLs', () => {
    const vh = new S3Storage({
      endpoint: 'https://s3.eu-west-1.amazonaws.com',
      bucket: 'my-bucket',
      region: 'eu-west-1',
      accessKeyId: 'a',
      secretAccessKey: 'b',
      pathStyle: false,
    });
    // Exercised only for URL construction here; the local harness is path-style.
    return vh.presignGet('k/1.txt', { expiresInSeconds: 60 }).then((url) => {
      assert.match(url, /^https:\/\/my-bucket\.s3\.eu-west-1\.amazonaws\.com\/k\/1\.txt\?/);
    });
  });

  it('the harness never saw a bad signature across the whole suite', () => {
    assert.deepEqual(sigFailures, []);
  });
});

describe('SigV4 encoding primitives', () => {
  it('rfc3986 escapes everything encodeURIComponent leaves behind', () => {
    assert.equal(rfc3986("a!b'c(d)e*f"), 'a%21b%27c%28d%29e%2Af');
    assert.equal(rfc3986('a/b'), 'a%2Fb');
    assert.equal(rfc3986('a b'), 'a%20b');
    assert.equal(rfc3986('a+b'), 'a%2Bb');
    assert.equal(rfc3986('~-._'), '~-._', 'unreserved characters are untouched');
  });

  it('canonical query strings sort on the ENCODED key', () => {
    assert.equal(
      canonicalQueryString({ b: '2', a: '1', 'X-Amz-Date': 'z' }),
      'X-Amz-Date=z&a=1&b=2',
    );
    assert.equal(canonicalQueryString({ uploads: '' }), 'uploads=');
  });
});

describe('MemoryStorage satisfies the same interface', () => {
  it('round trips, streams, ranges, heads and lists', async () => {
    const m = new MemoryStorage();
    assert.equal(m.provider, 'memory');
    await m.put('a/1', enc('abcdefghij'), 'text/plain');
    assert.equal(dec((await m.get('a/1'))!), 'abcdefghij');
    assert.equal((await m.head('a/1'))!.size, 10);
    const r = (await m.stream('a/1', { range: { start: 1, end: 3 } }))!;
    assert.equal(dec(await collectStream(r.body)), 'bcd');
    assert.deepEqual(r.range, { start: 1, end: 3, total: 10 });
    const l = await m.list('a/');
    assert.equal(l.entries.length, 1);
  });

  it('accepts a stream body', async () => {
    const m = new MemoryStorage();
    const r = await m.put('a/2', bytesToStream(enc('streamed')), 'text/plain');
    assert.equal(r.bytes, 8);
    assert.equal(dec((await m.get('a/2'))!), 'streamed');
  });

  it('cannot presign, and says so structurally', () => {
    const m = new MemoryStorage();
    assert.equal((m as { presignGet?: unknown }).presignGet, undefined);
  });
});

// -----------------------------------------------------------------------------

function deterministicBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[i] = x & 0xff;
  }
  return out;
}

function deterministicStream(n: number, chunk: number): ReadableStream<Uint8Array> {
  const all = deterministicBytes(n);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= n) return void controller.close();
      const end = Math.min(at + chunk, n);
      controller.enqueue(all.subarray(at, end));
      at = end;
    },
  });
}
