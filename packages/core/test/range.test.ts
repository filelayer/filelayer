/**
 * BYTE RANGES, END TO END.
 *
 * The primitive existed before this suite: all three adapters took a
 * `ByteRange`, `assertRange` validated it, and `proxyStatus()` already derived
 * 206 from `Content-Range`. What did not exist was anything that read the
 * `Range` REQUEST header, so the whole capability was unreachable over HTTP --
 * and because it was unreachable, two defects sat in it untested:
 *
 *   1. An unsatisfiable range answered 404. Every adapter returns `null` both
 *      for "no such object" and for "that range starts past the end", and the
 *      delivery layer collapsed the two. A caller WITH permission to read the
 *      file was told it did not exist.
 *   2. `Accept-Ranges` was sent only on responses that were already ranged --
 *      the one response where the client no longer needs to be told.
 *
 * The tests below are written to fail against both of those, and against the
 * parser accepting anything RFC 9110 says to ignore.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { deliveryHandler, errorHeaders, parseRangeHeader } from '../src/delivery.ts';
import { bytes } from './helpers.ts';

/** 26 bytes, every one distinguishable, so a wrong offset is visible. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
  const alice = (await fl.createActor('alice')).id;
  const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  const file = await fl.upload({ actorId: alice }, org, {
    name: 'alphabet.txt',
    contentType: 'text/plain',
    body: bytes(ALPHABET),
  });
  return { db, fl, alice, org, file };
}

async function serve(fl: Filelayer, actorId: string | null) {
  const server: Server = createServer(
    deliveryHandler(fl, { principal: () => ({ actorId }) }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

// -----------------------------------------------------------------------------
// The parser, on its own. RFC 9110's rule here is the opposite of a normal
// validator's: a `Range` that cannot be parsed MUST BE IGNORED, and the
// response is a 200 with the whole representation. So every malformed case
// below must come back null, and `null` must never mean "error".
// -----------------------------------------------------------------------------

describe('parseRangeHeader ignores everything RFC 9110 says to ignore', () => {
  it('reads the three well-formed shapes', () => {
    assert.deepEqual(parseRangeHeader('bytes=0-4'), { start: 0, end: 4 });
    assert.deepEqual(parseRangeHeader('bytes=5-'), { start: 5 });
    assert.deepEqual(parseRangeHeader('bytes=-4'), { suffix: 4 });
  });

  it('ignores a malformed range rather than rejecting it', () => {
    for (const raw of [
      'bytes=abc',
      'bytes=',
      'bytes=-',
      'bytes=--5',
      'bytes=1.5-2',
      'bytes=0x10-0x20',
      'bytes= ',
      'bytes=4-2', // last-pos before first-pos: the whole set is invalid
      'bytes=-0', // a suffix of zero asks for nothing
      'items=0-5', // a unit we do not serve
      'seconds=0-5',
      'bytes 0-5', // no '='
      '0-5', // no unit
      '',
    ]) {
      assert.equal(parseRangeHeader(raw), null, `expected to ignore ${JSON.stringify(raw)}`);
    }
  });

  it('ignores multiple ranges instead of answering one of them', () => {
    // Answering only the first under a 206 is the trap: the client asked two
    // questions and the status code does not say which was answered.
    assert.equal(parseRangeHeader('bytes=0-9,20-29'), null);
    assert.equal(parseRangeHeader('bytes=0-9, 20-29'), null);
    assert.equal(parseRangeHeader('bytes=0-9,'), null);
  });

  it('ignores a repeated Range header, which node hands over as an array', () => {
    assert.equal(parseRangeHeader(['bytes=0-9', 'bytes=20-29']), null);
    assert.equal(parseRangeHeader(undefined), null);
  });

  it('treats an unrepresentable last-pos as "to the end" rather than ignoring it', () => {
    // A last-pos past the end of the object is SATISFIABLE per RFC 9110, and
    // the adapters already clamp it. Dropping `end` says the same thing without
    // carrying a number that cannot be compared exactly.
    assert.deepEqual(parseRangeHeader('bytes=5-99999999999999999999'), { start: 5 });
    // ...but an unrepresentable FIRST-pos cannot be turned into an offset at
    // all, so it is ignored.
    assert.equal(parseRangeHeader('bytes=99999999999999999999-'), null);
  });

  it('tolerates surrounding whitespace', () => {
    assert.deepEqual(parseRangeHeader('  bytes=0-4  '), { start: 0, end: 4 });
    assert.deepEqual(parseRangeHeader('bytes= 0-4 '), { start: 0, end: 4 });
  });
});

// -----------------------------------------------------------------------------
// Over HTTP, which is the part that did not exist.
// -----------------------------------------------------------------------------

describe('a ranged GET is served as a 206 with the right bytes', () => {
  it('serves an explicit range', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=0-4' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), `bytes 0-4/26`);
      assert.equal(res.headers.get('content-length'), '5');
      assert.equal(await res.text(), 'abcde');
    } finally {
      s.close();
    }
  });

  it('serves an open-ended range', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=23-' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 23-25/26');
      assert.equal(await res.text(), 'xyz');
    } finally {
      s.close();
    }
  });

  it('serves a suffix range, which is what a PDF reader asks for first', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=-4' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 22-25/26');
      assert.equal(await res.text(), 'wxyz');
    } finally {
      s.close();
    }
  });

  it('clamps a suffix longer than the object to the whole object', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=-500' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 0-25/26');
      assert.equal(await res.text(), ALPHABET);
    } finally {
      s.close();
    }
  });

  it('clamps a last-pos past the end instead of refusing it', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, {
        headers: { range: 'bytes=20-999' },
      });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 20-25/26');
      assert.equal(await res.text(), 'uvwxyz');
    } finally {
      s.close();
    }
  });

  it('a single ranged read still delivers only the bytes asked for', async () => {
    // Guards the defect class this whole feature could have shipped: a range
    // silently widened to the whole object, under a 206 that claims otherwise.
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=10-12' } });
      const body = await res.text();
      assert.equal(body, 'klm');
      assert.equal(body.length, 3, 'the range was widened');
    } finally {
      s.close();
    }
  });
});

describe('an unsatisfiable range is a 416, not a 404', () => {
  it('answers 416 with the satisfiable extent', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=100-200' } });
      // Before this change: 404. A caller who is ALLOWED to read the file was
      // told it does not exist, which inverts what the uniform 404 is for.
      assert.equal(res.status, 416);
      // The only field that tells a client the size it did not know.
      assert.equal(res.headers.get('content-range'), 'bytes */26');
    } finally {
      s.close();
    }
  });

  it('a 416 still carries the security headers', async () => {
    // `FilelayerError.headers` merges UNDER `errorHeaders()`, so the channel
    // that adds `Content-Range` cannot remove `nosniff`.
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: 'bytes=100-' } });
      assert.equal(res.status, 416);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('content-type'), 'application/json');
    } finally {
      s.close();
    }
  });

  it('the error-header channel cannot override a security header', () => {
    // The guarantee `FilelayerError.headers` claims. It is a property of
    // `errorHeaders`, which is why the merge lives there: asserted directly
    // rather than inferred from the fact that `Content-Range` happens not to
    // collide with anything today.
    const h = errorHeaders({
      'content-range': 'bytes */26',
      'x-content-type-options': 'off',
      'content-type': 'text/html',
      'cache-control': 'public, max-age=31536000',
    });
    assert.equal(h['content-range'], 'bytes */26', 'the useful header must get through');
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['content-type'], 'application/json');
    assert.match(h['cache-control']!, /no-store/);
  });

  it('a range against a file that does not exist is still a 404', async () => {
    // The disambiguation must not turn every 404 into a 416: a missing object
    // has no satisfiable extent to report, and inventing one would leak that
    // the id was well formed.
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/11111111-1111-4111-8111-111111111111`, {
        headers: { range: 'bytes=0-4' },
      });
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('content-range'), null);
    } finally {
      s.close();
    }
  });

  it('a suffix range on an empty object is a 416 naming a zero extent', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
    const alice = (await fl.createActor('alice')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
    const empty = await fl.upload({ actorId: alice }, org, {
      name: 'empty.txt',
      contentType: 'text/plain',
      body: new Uint8Array(0),
    });
    const s = await serve(fl, alice);
    try {
      const res = await fetch(`${s.base}/f/${empty.id}`, { headers: { range: 'bytes=-5' } });
      assert.equal(res.status, 416);
      assert.equal(res.headers.get('content-range'), 'bytes */0');
    } finally {
      s.close();
    }
  });
});

describe('a range that cannot be used is ignored, never an error', () => {
  for (const raw of ['bytes=abc', 'bytes=4-2', 'bytes=0-9,20-29', 'items=0-5', 'bytes=-0']) {
    it(`serves the whole object for ${JSON.stringify(raw)}`, async () => {
      const w = await world();
      const s = await serve(w.fl, w.alice);
      try {
        const res = await fetch(`${s.base}/f/${w.file.id}`, { headers: { range: raw } });
        assert.equal(res.status, 200, 'a malformed range must not fail the request');
        assert.equal(res.headers.get('content-range'), null);
        assert.equal(await res.text(), ALPHABET);
      } finally {
        s.close();
      }
    });
  }
});

describe('Accept-Ranges is advertised where a client actually looks', () => {
  it('is on the unranged 200, which is the response a player reads', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`);
      assert.equal(res.status, 200);
      // Before this change: absent. It was set only on 206 responses, i.e.
      // only after the client had already worked out it could ask.
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      await res.arrayBuffer();
    } finally {
      s.close();
    }
  });

  it('is on a HEAD, so a client can probe without spending bytes', async () => {
    const w = await world();
    const s = await serve(w.fl, w.alice);
    try {
      const res = await fetch(`${s.base}/f/${w.file.id}`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
    } finally {
      s.close();
    }
  });
});

describe('a download cap and byte ranges: the cap wins, and says so', () => {
  it('ignores the range, serves the whole object, and spends exactly one download', async () => {
    const w = await world();
    const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
      maxDownloads: 2,
    });
    const s = await serve(w.fl, null);
    try {
      const res = await fetch(`${s.base}/d/${share.secret}`, {
        headers: { range: 'bytes=0-4' },
      });
      // Not a 206 and not a 416: charging a download per seek would turn
      // `maxDownloads: 2` into "two seeks", and not charging would let ranges
      // bypass the cap altogether. RFC 9110 permits ignoring the header, so the
      // client gets a complete, working file and the cap keeps its meaning.
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-range'), null);
      assert.equal(await res.text(), ALPHABET);
      // And the drop is ANNOUNCED, so a well-behaved client stops asking
      // instead of retrying into the same silent widening.
      assert.equal(res.headers.get('accept-ranges'), 'none');
      assert.equal(res.headers.get('x-downloads-remaining'), '1');
    } finally {
      s.close();
    }
  });

  it('an uncapped link still serves ranges', async () => {
    const w = await world();
    const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
    });
    const s = await serve(w.fl, null);
    try {
      const res = await fetch(`${s.base}/d/${share.secret}`, {
        headers: { range: 'bytes=0-4' },
      });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('content-range'), 'bytes 0-4/26');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(await res.text(), 'abcde');
    } finally {
      s.close();
    }
  });

  it('a capped link is not drained by a client that seeks repeatedly', async () => {
    // The scenario the rule exists for: a player issuing many ranged requests
    // against a cap of 3. Each is a whole delivery, so three is three -- but
    // none of them is a partial read that got charged as a download.
    const w = await world();
    const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
      maxDownloads: 3,
    });
    const s = await serve(w.fl, null);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${s.base}/d/${share.secret}`, {
          headers: { range: `bytes=${i}-${i}` },
        });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), ALPHABET, 'each delivery is the whole object');
      }
      const exhausted = await fetch(`${s.base}/d/${share.secret}`, {
        headers: { range: 'bytes=0-0' },
      });
      assert.equal(exhausted.status, 404, 'the cap must still be enforceable');
      await exhausted.arrayBuffer();
    } finally {
      s.close();
    }
  });
});

describe('the suffix resolution pins both ends', () => {
  it('does not serve more than the suffix asked for if the object grows mid-request', async () => {
    // WHY THIS IS NOT THEORETICAL ENOUGH TO SKIP.
    //
    // Resolving `bytes=-4` takes two calls: a HEAD for the size, then a stream
    // for the bytes. Resolving it to an OPEN-ENDED range (`{ start }`) and
    // resolving it to a closed one (`{ start, end }`) are indistinguishable on
    // every healthy object -- which is exactly why a mutation from the second
    // to the first survived the rest of this suite.
    //
    // They differ when the object is longer at the second call than it was at
    // the first: the open-ended form reads to the NEW end and returns more
    // bytes than the suffix named, under a `Content-Range` that says it
    // returned the last four. Filelayer's keys are write-once UUIDs, so this
    // needs a hostile adapter to produce -- but "the store cannot do that" is
    // an argument about today's adapters, not about the resolution being right.
    const { db } = await createTestDb();
    const inner = new MemoryStorage();
    let headCalls = 0;
    const growing = new Proxy(inner, {
      get(t, prop, recv) {
        if (prop === 'head') {
          return async (key: string) => {
            const h = await inner.head(key);
            headCalls++;
            // Answer the size, then grow the object before `stream` is called.
            if (h && h.size === ALPHABET.length) {
              await inner.put(key, bytes(ALPHABET + '0123456789'), 'text/plain');
            }
            return h;
          };
        }
        return Reflect.get(t, prop, recv) as unknown;
      },
    }) as MemoryStorage;

    const fl = new Filelayer(db, growing, { baseUrl: 'http://localhost' });
    const alice = (await fl.createActor('alice')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
    const f = await fl.upload({ actorId: alice }, org, {
      name: 'growing.txt',
      contentType: 'text/plain',
      body: bytes(ALPHABET),
    });

    const d = await fl.readStream({ actorId: alice }, f.id, { range: { suffix: 4 } });
    assert.ok(headCalls > 0, 'the suffix form must consult the store for the size');
    assert.equal(d.mode, 'proxy');
    // The EXTENT is what the resolution pinned, and it is what must hold: the
    // four bytes that were the last four when the size was taken. The total
    // reports the object as the store found it on the second call (36), which
    // is the honest answer -- the store is the authority on its own size and it
    // really did have 36 bytes by then.
    assert.match(d.headers['content-range']!, /^bytes 22-25\//);
    const body = await new Response(d.mode === 'proxy' ? d.body : null).text();
    assert.equal(
      body.length,
      4,
      `Content-Range promised 4 bytes and ${body.length} were served`,
    );
    assert.equal(body, 'wxyz');
  });
});

describe('the engine API accepts a range directly', () => {
  it('readStream honours an explicit range and a suffix', async () => {
    const w = await world();
    const explicit = await w.fl.readStream({ actorId: w.alice }, w.file.id, {
      range: { start: 2, end: 4 },
    });
    assert.equal(explicit.mode, 'proxy');
    assert.equal(explicit.headers['content-range'], 'bytes 2-4/26');

    const suffix = await w.fl.readStream({ actorId: w.alice }, w.file.id, {
      range: { suffix: 3 },
    });
    assert.equal(suffix.mode, 'proxy');
    assert.equal(suffix.headers['content-range'], 'bytes 23-25/26');
  });

  it('read() is unranged by definition and says so', async () => {
    // The buffered form forces proxy mode and passes no range; a `Content-Range`
    // here would mean the convenience wrapper had silently become partial.
    const w = await world();
    const d = await w.fl.read({ actorId: w.alice }, w.file.id);
    assert.equal(d.headers['content-range'], undefined);
    assert.equal(d.headers['accept-ranges'], 'bytes');
    assert.equal(new TextDecoder().decode(d.body), ALPHABET);
  });
});
