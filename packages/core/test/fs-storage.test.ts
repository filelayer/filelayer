/**
 * THE ADAPTER THAT CLOSES THE GAP BETWEEN A MAP AND A BUCKET.
 *
 * Until 0.9.0 this package shipped two storage adapters: one that dies with the
 * process and one that needs IAM credentials. On 3 October 2026 an agent was
 * asked to integrate the published package from npm, reading only the published
 * documentation, and hit exactly one hard stop before its first stored byte --
 * it wanted bytes that survive a restart without creating a bucket, found
 * nothing between the two, and wrote the adapter itself from the type
 * definitions.
 *
 * These tests are the ones that measurement implies: the hostile keys a public
 * adapter will be handed, the ranges the delivery layer will ask for, the
 * listing the orphan collector needs, and a whole lifecycle whose bytes outlive
 * the object that wrote them.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { FsStorage, MemoryStorage, canPresign, canList } from '../src/storage.ts';
import { Filelayer } from '../src/filelayer.ts';
import { createTestDb } from '../src/db.ts';
import { bytes, text } from './helpers.ts';

const roots: string[] = [];
function freshRoot(): string {
  const r = join('/tmp', `filelayer-fs-${randomUUID()}`);
  roots.push(r);
  return r;
}

after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

async function drain(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const out: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out.push(value);
  }
  const total = out.reduce((n, c) => n + c.byteLength, 0);
  const flat = new Uint8Array(total);
  let at = 0;
  for (const c of out) {
    flat.set(c, at);
    at += c.byteLength;
  }
  return text(flat);
}

describe('FsStorage', () => {
  it('round-trips bytes and reports its own provider', async () => {
    const s = new FsStorage(freshRoot());
    const r = await s.put('org/a', bytes('HELLO'), 'text/plain');
    assert.equal(r.bytes, 5);
    assert.ok(r.etag, 'an etag, so a caller can tell two versions apart');
    assert.equal(text((await s.get('org/a'))!), 'HELLO');
    assert.equal(s.provider, 'fs');
    assert.equal(await s.get('nope'), null, 'a missing key is null, never a throw');
  });

  it('cannot be escaped by a hostile key', async () => {
    // Filelayer's own keys are `<orgUuid>/<fileUuid>` and are safe. This adapter
    // is exported, so it will be handed worse. Hashing the key is what makes
    // traversal, absolute paths and length limits all the same non-problem.
    const s = new FsStorage(freshRoot());
    const hostile = [
      '../../etc/passwd',
      '/absolute/path',
      'a/../../b',
      './dot/segment',
      'trailing/',
      'double//slash',
      'emoji-🎉-key',
      'Ünïcödé',
      'x'.repeat(400),
    ];
    for (const k of hostile) {
      await s.put(k, bytes(k), 'text/plain');
      assert.equal(text((await s.get(k))!), k, `round-trip failed for ${JSON.stringify(k)}`);
    }
    // Distinct keys stay distinct: no collision, no case-folding surprise.
    const { entries } = await s.list('');
    assert.equal(new Set(entries.map((e) => e.key)).size, hostile.length);
  });

  it('serves a byte range, and refuses one that makes no sense', async () => {
    const s = new FsStorage(freshRoot());
    await s.put('k', bytes('0123456789'), 'text/plain');

    const part = await s.stream('k', { range: { start: 2, end: 4 } });
    assert.ok(part);
    assert.equal(await drain(part.body), '234');
    assert.deepEqual(part.range, { start: 2, end: 4, total: 10 });

    const open = await s.stream('k', { range: { start: 7 } });
    assert.ok(open);
    assert.equal(await drain(open.body), '789', 'an open-ended range runs to the end');

    const whole = await s.stream('k');
    assert.ok(whole);
    assert.equal(whole.size, 10);
    assert.equal(whole.range, undefined, 'no range asked, no range reported');

    await assert.rejects(
      () => s.stream('k', { range: { start: 5, end: 2 } }),
      /invalid byte range/,
    );
    assert.equal(
      await s.stream('k', { range: { start: 99 } }),
      null,
      'past the end is unsatisfiable, which the delivery layer turns into a 404',
    );
  });

  it('lists by prefix and pages, so orphan collection works here too', async () => {
    const s = new FsStorage(freshRoot());
    for (let i = 0; i < 7; i++) await s.put(`acme/f${i}`, bytes(String(i)), 'text/plain');
    await s.put('other/x', bytes('x'), 'text/plain');

    const mine = await s.list('acme/');
    assert.equal(mine.entries.length, 7);
    assert.ok(mine.entries.every((e) => e.key.startsWith('acme/')));
    assert.ok(mine.entries.every((e) => e.lastModified instanceof Date));

    const page = await s.list('acme/', { limit: 3 });
    assert.equal(page.entries.length, 3);
    assert.ok(page.cursor, 'a short page hands back a cursor');
    const next = await s.list('acme/', { limit: 3, cursor: page.cursor });
    assert.equal(next.entries.length, 3);
    assert.ok(
      next.entries.every((e) => !page.entries.some((p) => p.key === e.key)),
      'and the next page does not repeat the first',
    );
  });

  it('deletes, and deleting what is not there is success', async () => {
    const s = new FsStorage(freshRoot());
    await s.put('k', bytes('x'), 'text/plain');
    await s.delete('k');
    assert.equal(await s.get('k'), null);
    assert.equal(await s.head('k'), null);
    await s.delete('k');
    await s.delete('never-existed');
  });

  it('answers the capability probes honestly', async () => {
    // The absence of `presignGet` is the honest answer, not an omission: a
    // presigned URL promises that some other server will serve the bytes, and a
    // local directory has no other server.
    const s = new FsStorage(freshRoot());
    assert.equal(canPresign(s), false, 'redirect delivery is unavailable, and says so up front');
    assert.equal(canList(s), true);
  });

  // ---------------------------------------------------------------------------
  // The nine below are not extra coverage. Each one failed on the first version
  // of this adapter, and all nine were found by an adversarial sweep rather
  // than by the seven tests above -- which is the measurement that matters: the
  // original suite let six of nine deliberate mutations survive, INCLUDING
  // removing temp+rename from `put` entirely.
  // ---------------------------------------------------------------------------

  it('a single unreadable object costs itself and nothing else', async () => {
    // THE DEFECT: `list()` did a bare `JSON.parse` on each object's metadata, so
    // one unreadable file threw out of the whole walk.
    // `collectStorageOrphans()` could then enumerate nothing at all, which makes
    // every object in the store unreclaimable because of one bad file. It did
    // not take corruption: the first format wrote the metadata with `writeFile`,
    // which opens O_TRUNC, so an overwrite passed through a zero-length window
    // and a concurrent `list()` read an empty file on the first round of every
    // run.
    const root = freshRoot();
    const s = new FsStorage(root);
    for (const k of ['a', 'b', 'c']) await s.put(k, bytes(k), 'text/plain');

    const objs: string[] = [];
    const find = async (d: string): Promise<void> => {
      for (const n of await readdir(d)) {
        const full = join(d, n);
        if ((await stat(full)).isDirectory()) await find(full);
        else if (n.endsWith('.obj')) objs.push(full);
      }
    };
    await find(root);
    assert.equal(objs.length, 3, 'one file per object, which is the point of the format');

    await writeFile(objs[0]!, '');
    const out = await s.list('');
    assert.equal(out.entries.length, 2, 'the two good objects are still listed');
    assert.equal(out.skipped, 1, 'and the one it could not read is reported, not hidden');

    // Half a header, which is what a truncated file looks like, is the same case.
    await writeFile(objs[1]!, '{"key":"b","byt');
    const out2 = await s.list('');
    assert.equal(out2.entries.length, 1);
    assert.equal(out2.skipped, 2);

    // Valid JSON that is not one of our headers is also skipped, not trusted.
    await writeFile(objs[2]!, '{"hello":"world"}\nbytes');
    const out3 = await s.list('');
    assert.equal(out3.entries.length, 0);
    assert.equal(out3.skipped, 3);
  });

  it('never serves an etag or a size that does not describe the bytes it sent', async () => {
    // THE DEFECT, and the reason this adapter keeps ONE FILE PER OBJECT rather
    // than a blob and a sidecar. Two files cannot be replaced atomically, and
    // every ordering was tried: blob first left bytes `list()` could never
    // report, and metadata first let a reader see the NEW etag over the OLD
    // bytes. A header and its payload in one file means one `rename`, and
    // `rename(2)` is atomic within a filesystem.
    //
    // THE PROPERTY IS PER CALL, and that is not a weaker claim -- it is the only
    // one any object store makes. `head()` followed by `get()` is two reads, and
    // a write landing between them gives you one version's metadata and the
    // other's bytes on S3 exactly as it does here; that is what an etag is FOR.
    // What must hold is that a SINGLE call is internally consistent, because
    // `stream()` is what the delivery layer serves from: the etag it returns as
    // a validator, the size it returns as `Content-Length`, and the bytes it
    // puts on the wire all have to be the same version. The old two-file layout
    // could not promise even that, because `stream()` itself was a `head()` plus
    // a `get()`.
    const s = new FsStorage(freshRoot());
    const versions = [0, 1, 2, 3].map((i) => 'ABCD'[i]!.repeat(4096 + i));
    await s.put('k', bytes(versions[0]!), 'text/plain');

    let mismatches = 0;
    let reads = 0;
    for (let round = 0; round < 60; round++) {
      const writer = s.put('k', bytes(versions[round % versions.length]!), 'text/plain');
      for (let i = 0; i < 8; i++) {
        const st = await s.stream('k');
        if (!st) continue;
        const body = await drain(st.body);
        reads++;
        const actual = `"${createHash('md5').update(bytes(body)).digest('hex')}"`;
        if (st.etag !== actual || st.size !== body.length) mismatches++;
      }
      await writer;
    }
    assert.ok(reads > 100, `only ${reads} reads landed, so this proved little`);
    assert.equal(
      mismatches,
      0,
      `${mismatches} of ${reads} reads served an etag or a Content-Length from a different version`,
    );

    // And a ranged read is consistent with the same object: the range total is
    // the size of the version the bytes came from.
    const part = await s.stream('k', { range: { start: 0, end: 9 } });
    assert.ok(part);
    const ten = await drain(part.body);
    assert.equal(ten.length, 10);
    assert.equal(part.range!.total, (await s.get('k'))!.byteLength);
  });

  it('a put that cannot finish leaves nothing behind', async () => {
    // THE DEFECT: there was no cleanup at all. A put that died partway -- full
    // disk, quota, EIO -- left a `.tmp` that `list()` does not report (it is not
    // an object file) and that `collectStorageOrphans()` therefore cannot
    // reclaim either. Reproduced for real with a write limit; the injection here
    // is a DIRECTORY where a file has to go, which makes `writeFile` and
    // `rename` fail with EISDIR deterministically, with no timing in it.
    const objOf = (root: string, key: string): { dir: string; obj: string } => {
      const h = createHash('sha256').update(key, 'utf8').digest('hex');
      const dir = join(root, h.slice(0, 2), h.slice(2, 4));
      return { dir, obj: join(dir, `${h}.obj`) };
    };
    const leftovers = async (root: string, ext: string): Promise<string[]> => {
      const hits: string[] = [];
      const walk = async (d: string): Promise<void> => {
        for (const n of await readdir(d)) {
          const full = join(d, n);
          if (n.endsWith(ext)) hits.push(full);
          else if ((await stat(full)).isDirectory()) await walk(full);
        }
      };
      await walk(root);
      return hits;
    };

    const root = freshRoot();
    const s = new FsStorage(root);
    await s.put('good', bytes('ok'), 'text/plain');

    const { dir, obj } = objOf(root, 'bad');
    await mkdir(obj, { recursive: true }); // the rename target is a directory
    await assert.rejects(() => s.put('bad', bytes('x'), 'text/plain'));
    assert.deepEqual(
      await leftovers(dir, '.tmp'),
      [],
      'a failed put left a temp file that no listing reports and nothing collects',
    );

    // And the object that did write is untouched, in both the bytes and the log.
    assert.equal(text((await s.get('good'))!), 'ok');
    assert.deepEqual(
      (await s.list('')).entries.map((e) => e.key),
      ['good'],
    );
  });

  it('refuses to report an unreadable store as an empty one', async () => {
    // THE DEFECT: every `readdir` error was swallowed, so a root with no read
    // permission returned `{ entries: [] }` -- indistinguishable from a store
    // nobody has written to. The caller is the orphan collector, and "nothing
    // is stored" is the single answer that makes it delete rows for files that
    // do exist. ENOENT stays benign, because an unused store has no directory.
    const root = freshRoot();
    const s = new FsStorage(root);
    await s.put('k', bytes('x'), 'text/plain');

    const dirs: string[] = [];
    const walk = async (d: string): Promise<void> => {
      dirs.push(d);
      for (const n of await readdir(d)) {
        const full = join(d, n);
        if ((await stat(full)).isDirectory()) await walk(full);
      }
    };
    await walk(root);
    const leaf = dirs[dirs.length - 1]!;
    await chmod(leaf, 0o000);
    try {
      await assert.rejects(() => s.list(''), (e: { code?: string }) => e.code === 'EACCES');
    } finally {
      await chmod(leaf, 0o700);
    }

    const empty = new FsStorage(freshRoot());
    assert.deepEqual(
      (await empty.list('')).entries,
      [],
      'a store that was never written to is empty, not an error',
    );
  });

  it('streams, in chunks, instead of buffering the object to slice it', async () => {
    // THE DEFECT, two of them from one cause. `stream()` called `head()` for the
    // size and then `get()` for the bytes, so a 10-byte range on a 100 MiB file
    // read all 100 MiB and then copied the slice out of it: resident memory grew
    // by 200 MiB, twice the object. A delete landing between the two calls
    // returned `{ size: 65536, body: <0 bytes> }` -- a response claiming 64 KiB
    // and sending none, which no HTTP layer trusting `ObjectStream.size` can
    // detect. The class comment at the top of storage.ts promises the opposite.
    //
    // COUNTING CHUNKS is what makes this test, rather than a memory reading
    // that a CI machine can flake. A buffered implementation has exactly one
    // chunk, because it hands `bytesToStream` a single Uint8Array; a real file
    // stream has one per read. That distinction cannot be faked by an
    // implementation that still reads the whole file first.
    const s = new FsStorage(freshRoot());
    const size = 4 * 1024 * 1024;
    await s.put('big', new Uint8Array(size).fill(65), 'application/octet-stream');

    const chunksOf = async (body: ReadableStream<Uint8Array>): Promise<number[]> => {
      const reader = body.getReader();
      const sizes: number[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) sizes.push(value.byteLength);
      }
      return sizes;
    };

    const part = await s.stream('big', { range: { start: 0, end: 1024 * 1024 - 1 } });
    assert.ok(part);
    assert.equal(part.size, 1024 * 1024);
    const sizes = await chunksOf(part.body);
    assert.ok(
      sizes.length > 1,
      `a 1 MiB range arrived in ${sizes.length} chunk(s), so the object was buffered, not streamed`,
    );
    assert.equal(
      sizes.reduce((n, c) => n + c, 0),
      1024 * 1024,
      'and the chunks add up to exactly the range that was asked for',
    );

    // A short range is still exact, and still correct bytes.
    const tiny = await s.stream('big', { range: { start: 10, end: 19 } });
    assert.ok(tiny);
    assert.equal(await drain(tiny.body), 'A'.repeat(10));
  });

  it('pages at the same ceiling as the other two adapters', async () => {
    // THE DEFECT: this adapter capped `limit` at 10,000 and the other two at
    // 1,000, so one `limit: 5000` produced a 5,000-entry page from a directory
    // and a 1,000-entry page from a bucket. A caller that paged correctly
    // against S3 skipped 4,000 objects against the filesystem, which for the
    // orphan collector means 4,000 files it believes are not there.
    //
    // 1,001 objects is the smallest number that can tell the two ceilings
    // apart, which is why this test writes them rather than asserting on a
    // dozen and proving nothing. It is the slowest test in the file on purpose.
    const s = new FsStorage(freshRoot());
    const one = bytes('x');
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) =>
        s.put(`k${String(i).padStart(4, '0')}`, one, 'text/plain'),
      ),
    );
    const asked = await s.list('', { limit: 9999 });
    assert.equal(asked.entries.length, 1000, 'the cap is 1,000 whatever the caller asks for');
    assert.ok(asked.cursor, 'and the 1,001st is behind a cursor, not dropped');
    assert.equal((await s.list('', { limit: 9999, cursor: asked.cursor })).entries.length, 1);

    const mem = new MemoryStorage();
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) =>
        mem.put(`k${String(i).padStart(4, '0')}`, one, 'text/plain'),
      ),
    );
    assert.equal(
      (await mem.list('', { limit: 9999 })).entries.length,
      asked.entries.length,
      'the two adapters page identically, which is the property that was broken',
    );
    assert.equal((await s.list('', { limit: 0 })).entries.length, 1, 'and 0 means 1, not all');
  });

  it('lists the empty key, which MemoryStorage silently could not', async () => {
    // Not an FsStorage defect; found while reading the neighbouring adapter.
    // `const after = opts.cursor ?? ''` with a filter of `k > after` excluded
    // the key `''` from the FIRST page as well, because `'' > ''` is false. An
    // object stored under the empty key was therefore listable by no call at
    // all, so `collectStorageOrphans()` could never reclaim it. Both adapters
    // are exported and take any string, so the key is reachable.
    for (const s of [new FsStorage(freshRoot()), new MemoryStorage()]) {
      await s.put('', bytes('EDGE'), 'text/plain');
      await s.put('a', bytes('a'), 'text/plain');
      const keys = (await s.list('')).entries.map((e) => e.key);
      assert.ok(keys.includes(''), `${s.provider} hid the empty key from every page`);
      assert.equal(keys.length, 2);
    }
  });

  it('round-trips through the header what the header is for', async () => {
    // Kills the mutation that drops `contentType` or `etag` from the header:
    // both are served from it, and the payload carries neither.
    const s = new FsStorage(freshRoot());
    const r = await s.put('k', bytes('PDFBYTES'), 'application/pdf');
    const h = await s.head('k');
    assert.ok(h);
    assert.equal(h.contentType, 'application/pdf');
    assert.equal(h.etag, r.etag);
    assert.equal(h.size, 8);
    const st = await s.stream('k');
    assert.ok(st);
    assert.equal(st.contentType, 'application/pdf');
    assert.equal(st.etag, r.etag);
  });

  // ---------------------------------------------------------------------------
  // Ported from the adversarial probe harness that found the nine defects
  // above. These are the properties it checked and found CORRECT -- kept
  // because a property nobody has written a test for is a property the next
  // rewrite is free to break, and this adapter has now been rewritten twice.
  // ---------------------------------------------------------------------------

  it('never serves a partial object to a reader racing a writer', async () => {
    const s = new FsStorage(freshRoot());
    // Self-describing payloads of distinct lengths, each big enough that a
    // non-atomic write would be observable.
    const bodies = [0, 1, 2, 3, 4, 5].map((i) =>
      bytes(String.fromCharCode(65 + i).repeat(1_000_000 + i * 777)),
    );
    await s.put('hot', bodies[0]!, 'text/plain');

    let reads = 0;
    let stop = false;
    const readers = Array.from({ length: 6 }, () =>
      (async () => {
        while (!stop) {
          const got = await s.get('hot');
          assert.ok(got, 'the object never vanishes while it is being overwritten');
          reads++;
          // Every byte of a read must come from ONE of the writes: the same
          // character throughout, at the length that character was written at.
          const ch = text(got.subarray(0, 1));
          const expected = bodies.find((b) => text(b.subarray(0, 1)) === ch)!;
          assert.equal(got.byteLength, expected.byteLength, `torn read: ${ch} had ${got.byteLength} bytes`);
          assert.ok(got.every((b) => b === expected[0]!), `torn read: mixed bytes in ${ch}`);
        }
      })(),
    );
    for (let round = 0; round < 25; round++) {
      await Promise.all(bodies.map((b) => s.put('hot', b, 'text/plain')));
    }
    stop = true;
    await Promise.all(readers);
    assert.ok(reads > 10, `did ${reads} concurrent reads`);
  });

  it('survives put, get, delete and list all racing on one key', async () => {
    const s = new FsStorage(freshRoot());
    const body = bytes('PAYLOAD'.repeat(5000));
    let ops = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        (async () => {
          for (let j = 0; j < 30; j++) {
            await s.put('churn', body, 'application/octet-stream');
            const g = await s.get('churn');
            if (g !== null) {
              assert.equal(g.byteLength, body.byteLength, 'any bytes present are the whole object');
            }
            await s.delete('churn');
            // `list()` must not throw here either. It used to, on a sidecar
            // caught mid-write, which is what the format change removed.
            await s.list('');
            ops++;
          }
        })(),
      ),
    );
    assert.equal(ops, 240);
    await s.delete('churn');
    assert.equal(await s.get('churn'), null);
  });

  it('surfaces the real errno when the root is unusable', async () => {
    // ENOTDIR and EACCES must not be laundered into "the object is missing".
    // `get()` returning null for a store that is unreadable is how the orphan
    // collector ends up deleting rows for files that exist.
    const root = freshRoot();
    await mkdir(root, { recursive: true });
    const asFile = join(root, 'not-a-dir');
    await writeFile(asFile, 'i am a file');
    const s = new FsStorage(asFile);
    for (const [name, fn] of [
      ['put', () => s.put('k', bytes('x'), 'text/plain')],
      ['get', () => s.get('k')],
      ['head', () => s.head('k')],
      ['stream', () => s.stream('k')],
      ['list', () => s.list('')],
    ] as const) {
      await assert.rejects(
        fn as () => Promise<unknown>,
        (e: { code?: string }) => e.code === 'ENOTDIR',
        `${name} surfaces ENOTDIR rather than pretending the object is missing`,
      );
    }
  });

  it('leaves the previous object intact when a write cannot land', async () => {
    if (process.getuid?.() === 0) return; // mode bits do not bind root
    const root = freshRoot();
    const s = new FsStorage(root);
    await s.put('k', bytes('ORIGINAL'), 'text/plain');
    const h = createHash('sha256').update('k', 'utf8').digest('hex');
    const dir = join(root, h.slice(0, 2), h.slice(2, 4));
    await chmod(dir, 0o500);
    try {
      await assert.rejects(
        () => s.put('k', bytes('REPLACEMENT'), 'text/plain'),
        (e: { code?: string }) => e.code === 'EACCES',
      );
      assert.equal(text((await s.get('k'))!), 'ORIGINAL', 'the failed write did not damage the old object');
      assert.equal((await s.head('k'))!.size, 8);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('keeps the path bounded for any key, however monstrous', async () => {
    const root = freshRoot();
    const s = new FsStorage(root);
    const monsters = ['x'.repeat(100_000), ' embedded-nul', 'a/'.repeat(5000), '\u{10FFFF}'.repeat(1000)];
    for (const k of monsters) {
      await s.put(k, bytes('ok'), 'text/plain');
      assert.equal(text((await s.get(k))!), 'ok', `round-trip failed for a ${k.length}-char key`);
    }
    assert.equal((await s.list('')).entries.length, monsters.length);
    // 64 hex + '.obj' of basename and 2+2 of directory, for every key there is.
    const walk = async (d: string): Promise<number> => {
      let worst = 0;
      for (const n of await readdir(d)) {
        const full = join(d, n);
        worst = (await stat(full)).isDirectory()
          ? Math.max(worst, await walk(full))
          : Math.max(worst, full.length - root.length);
      }
      return worst;
    };
    assert.ok((await walk(root)) < 90, 'the hashed path cannot exceed any OS limit');
  });

  it('sorts and timestamps its listing the way the orphan collector needs', async () => {
    const s = new FsStorage(freshRoot());
    for (const k of ['b', 'a', 'c']) await s.put(k, bytes(k), 'text/plain');
    const { entries } = await s.list('');
    assert.deepEqual(
      entries.map((e) => e.key),
      ['a', 'b', 'c'],
      'sorted by key, not by the hash the path is built from',
    );
    assert.ok(entries.every((e) => e.lastModified instanceof Date));
    assert.ok(entries.every((e) => Date.now() - e.lastModified!.getTime() < 60_000));
    assert.deepEqual(
      entries.map((e) => e.size),
      [1, 1, 1],
      'and the size is the payload, not the payload plus its header',
    );
  });

  it('carries a whole Filelayer lifecycle, and the bytes outlive the adapter', async () => {
    const root = freshRoot();
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new FsStorage(root), { baseUrl: 'http://x' });
    const f = await fl.files.put(bytes('CONTRACT'), { org: 'acme', owner: 'alice' });

    // A DIFFERENT adapter instance over the same directory, which is the
    // restart this adapter exists for.
    const fl2 = new Filelayer(db, new FsStorage(root), { baseUrl: 'http://x' });
    assert.equal(text((await fl2.files.get(f.id, { as: 'alice' })).body), 'CONTRACT');

    const share = await fl2.shares.create(f.id, { as: 'alice', expiresIn: 60, maxDownloads: 1 });
    assert.equal(text((await fl2.shares.redeem(share.secret, {})).body), 'CONTRACT');
    await rejects404(() => fl2.shares.redeem(share.secret, {}));

    const { rows } = await fl2.store.db.query<{ p: string }>(
      `SELECT storage_provider AS p FROM file WHERE id = $1`,
      [f.id],
    );
    assert.equal(rows[0]!.p, 'fs', 'the provider comes from the adapter, as SEMANTICS says');
  });
});

async function rejects404(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (e: { status?: number }) => e.status === 404);
}

describe('the bytes on disk are owner-only', () => {
  // QUICKSTART calls confirming the bucket is private "the one
  // security-sensitive decision Filelayer cannot make for you" and gives
  // concrete R2 and S3 instructions. It said nothing for THIS adapter -- the
  // one recommended for a single node and the one `examples/starter/` defaults
  // to -- and the default was 0755/0644. Object keys are `orgId/fileId` and P2
  // states they are not secrets, so a world-readable data directory is a public
  // bucket on local disk.
  //
  // Unlike a bucket ACL, this one the library CAN make, so it does. Found by an
  // agent deploying the published 0.11.0 with only the tarball to read.
  const mode = async (p: string) => (await stat(p)).mode.toString(8).slice(-4);

  /** The three levels FsStorage creates, plus the object. */
  async function levels(root: string): Promise<string[]> {
    const a = (await readdir(root))[0]!;
    const b = (await readdir(join(root, a)))[0]!;
    const f = (await readdir(join(root, a, b)))[0]!;
    return [
      await mode(root),
      await mode(join(root, a)),
      await mode(join(root, a, b)),
      await mode(join(root, a, b, f)),
    ];
  }

  it('creates its own directories 0700 and its objects 0600', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'fl-mode-')), 'data');
    const s = new FsStorage(root);
    await s.put('org/file', bytes('payroll'), 'text/plain');
    assert.deepEqual(await levels(root), ['0700', '0700', '0700', '0600']);
  });

  it('TIGHTENS a directory the operator pre-created world-readable', async () => {
    // The case that actually happens: a deploy script makes the data directory
    // under the default umask of 022, so it is 0755 before we ever see it.
    const root = join(await mkdtemp(join(tmpdir(), 'fl-mode-')), 'data');
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    assert.equal(await mode(root), '0755', 'fixture did not reproduce the umask case');

    const s = new FsStorage(root);
    await s.put('org/file', bytes('payroll'), 'text/plain');
    assert.deepEqual(await levels(root), ['0700', '0700', '0700', '0600']);
  });

  it('is not relying on the process umask to get there', async () => {
    // `mkdir`'s mode is masked by the umask, so a permissive umask would
    // silently widen it if the mode were the only mechanism.
    const previous = process.umask(0o000);
    try {
      const root = join(await mkdtemp(join(tmpdir(), 'fl-mode-')), 'data');
      const s = new FsStorage(root);
      await s.put('org/file', bytes('payroll'), 'text/plain');
      assert.deepEqual(await levels(root), ['0700', '0700', '0700', '0600']);
    } finally {
      process.umask(previous);
    }
  });

  it('removes group and other bits WITHOUT granting the owner anything new', async () => {
    // The precise property, and the one a flat `chmod 0o700` would break while
    // still passing every test above: 0550 must become 0500, not 0700. The
    // owner deliberately has no write bit and the library must not hand itself
    // one -- it only ever takes bits away.
    //
    // A mutation changing `chmod(path, owner)` to `chmod(path, 0o700)` survived
    // the suite until this test existed, because the only other directory
    // fixture was 0500, where the guard short-circuits before the argument
    // matters.
    if (process.getuid?.() === 0) return; // mode bits do not bind root
    const root = join(await mkdtemp(join(tmpdir(), 'fl-mode-')), 'data');
    const s = new FsStorage(root);
    // A first put, so the directory exists and the root stays writable. If the
    // ROOT were the one at 0550, `mkdir` would fail for want of a write bit
    // before the mode logic ran at all -- which is what a first draft of this
    // test got wrong.
    await s.put('org/file', bytes('payroll'), 'text/plain');
    const h = createHash('sha256').update('org/file', 'utf8').digest('hex');
    const leaf = join(root, h.slice(0, 2), h.slice(2, 4));

    // Group-readable AND owner-read-only. `current & 0o700` is 0500; a flat
    // 0700 would hand the owner a write bit it does not have.
    await chmod(leaf, 0o550);
    await s.put('org/file', bytes('again'), 'text/plain').catch(() => {});
    assert.equal(await mode(leaf), '0500', 'the owner was granted a bit it did not have');
  });

  it('still reads back what it wrote', async () => {
    // The permission is worth nothing if it locks out the owning process.
    const root = join(await mkdtemp(join(tmpdir(), 'fl-mode-')), 'data');
    const s = new FsStorage(root);
    await s.put('org/file', bytes('payroll'), 'text/plain');
    assert.equal(text((await s.get('org/file'))!), 'payroll');
    const listed = await s.list('');
    assert.equal(listed.entries.length, 1);
  });
});
