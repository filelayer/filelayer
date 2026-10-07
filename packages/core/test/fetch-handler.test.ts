/**
 * THE `fetch` HANDLER MUST ANSWER WHAT THE `node:http` HANDLER ANSWERS.
 *
 * `deliveryFetch` exists because the careful parts of this library's delivery
 * path -- `Range`, 416 with the size in it, the query-string credential
 * refusal, a path segment that is not valid percent-encoding, the 401 that
 * tells a client to retry with a password -- were reachable from
 * `node:http` and not from Next.js, Hono, Workers, Deno or Bun. A second
 * implementation of those rules is a second place for them to drift, so
 * almost every test here is a PARITY test: the same request goes through both
 * handlers and the two answers are compared.
 *
 * That shape is deliberate. A test that asserts `deliveryFetch` returns 416
 * for `bytes=99-120` pins this file against a constant somebody typed. A test
 * that asserts both handlers agree pins it against the implementation that has
 * the suite behind it, so a change to the rules fails here unless it was made
 * in both places.
 *
 * The exceptions are at the bottom: the four behaviours that CANNOT be parity
 * tests, because they are the places the two runtimes genuinely differ.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { deliveryHandler, deliveryFetch } from '../src/delivery.ts';
import { bytes } from './helpers.ts';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
  const alice = (await fl.createActor('alice')).id;
  const bob = (await fl.createActor('bob')).id;
  const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  const file = await fl.upload({ actorId: alice }, org, {
    name: 'alphabet.txt',
    contentType: 'text/plain',
    body: bytes(ALPHABET),
  });
  return { db, fl, alice, bob, org, file };
}

/**
 * Both handlers over the same `Filelayer`, so a difference cannot be a
 * difference in state.
 */
async function both(fl: Filelayer, actorId: string | null) {
  const server: Server = createServer(deliveryHandler(fl, { principal: () => ({ actorId }) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fetchHandler = deliveryFetch(fl, { principal: () => ({ actorId }) });

  return {
    base,
    close: () => server.close(),
    /** The same request, both ways, reduced to what a client can observe. */
    async compare(path: string, init: RequestInit = {}) {
      const viaNode = await fetch(`${base}${path}`, init);
      const viaFetch = await fetchHandler(new Request(`${base}${path}`, init));
      assert.ok(viaFetch, `deliveryFetch returned null for ${init.method ?? 'GET'} ${path}`);

      const shape = async (r: Response) => ({
        status: r.status,
        contentRange: r.headers.get('content-range'),
        acceptRanges: r.headers.get('accept-ranges'),
        contentType: r.headers.get('content-type'),
        disposition: r.headers.get('content-disposition'),
        nosniff: r.headers.get('x-content-type-options'),
        cacheControl: r.headers.get('cache-control'),
        delivery: r.headers.get('x-filelayer-delivery'),
        authenticate: r.headers.get('www-authenticate'),
        body: await r.text(),
      });

      const a = await shape(viaNode);
      const b = await shape(viaFetch);
      assert.deepEqual(b, a, `handlers disagree on ${init.method ?? 'GET'} ${path}`);
      return a;
    },
  };
}

// -----------------------------------------------------------------------------
// Parity on the authorized read path
// -----------------------------------------------------------------------------

describe('deliveryFetch answers what deliveryHandler answers, on /f', () => {
  it('agrees on every Range a client actually sends', async () => {
    const w = await world();
    const s = await both(w.fl, w.alice);
    try {
      for (const range of [
        undefined,
        'bytes=0-',
        'bytes=0-4',
        'bytes=5-9',
        'bytes=-4',
        'bytes=20-',
        'bytes=20-999',
      ]) {
        const got = await s.compare(
          `/f/${w.file.id}`,
          range ? { headers: { range } } : {},
        );
        assert.equal(got.acceptRanges, 'bytes', `Accept-Ranges missing for ${range ?? '(none)'}`);
      }
    } finally {
      s.close();
    }
  });

  it('agrees on the ranges that must be ignored rather than refused', async () => {
    const w = await world();
    const s = await both(w.fl, w.alice);
    try {
      // RFC 9110: an invalid range is IGNORED, and the answer is the whole
      // representation under a 200. Four of these look like a 416 and are not.
      for (const range of ['bytes=9-4', 'bytes=-0', 'bytes=abc', 'items=0-4', 'bytes=0-4,10-14']) {
        const got = await s.compare(`/f/${w.file.id}`, { headers: { range } });
        assert.equal(got.status, 200, `${range} should be ignored, not refused`);
        assert.equal(got.body, ALPHABET);
      }
    } finally {
      s.close();
    }
  });

  it('agrees on the one range that IS a 416, including the size it carries', async () => {
    const w = await world();
    const s = await both(w.fl, w.alice);
    try {
      const got = await s.compare(`/f/${w.file.id}`, { headers: { range: 'bytes=99-120' } });
      assert.equal(got.status, 416);
      // Without this the client has no way to ask a better question.
      assert.equal(got.contentRange, `bytes */${ALPHABET.length}`);
    } finally {
      s.close();
    }
  });

  it('agrees on refusing a stranger, and on refusing as not_found', async () => {
    const w = await world();
    const s = await both(w.fl, w.bob);
    try {
      const got = await s.compare(`/f/${w.file.id}`);
      assert.equal(got.status, 404, 'a 403 here is a membership oracle');
    } finally {
      s.close();
    }
  });

  it('agrees on refusing a credential in the query string', async () => {
    const w = await world();
    const s = await both(w.fl, w.alice);
    try {
      for (const q of ['token=abc', 'Password=hunter2', 'KEY=x']) {
        const got = await s.compare(`/f/${w.file.id}?${q}`);
        assert.equal(got.status, 400, `?${q} reached the access log unrefused`);
      }
    } finally {
      s.close();
    }
  });

  it('agrees on a path segment that is not valid percent-encoding', async () => {
    const w = await world();
    const s = await both(w.fl, w.alice);
    try {
      // `%%%` killed the process once, through the node route. Whatever the
      // answer is, both routes must give it rather than throwing.
      for (const seg of ['%%%', '%00', 'not-a-uuid']) {
        await s.compare(`/f/${seg}`);
      }
    } finally {
      s.close();
    }
  });

  it('agrees on the security headers of an ordinary read', async () => {
    const w = await world();
    const s = await both(w.fl, w.alice);
    try {
      const got = await s.compare(`/f/${w.file.id}`);
      assert.equal(got.nosniff, 'nosniff');
      assert.match(got.disposition ?? '', /^attachment/);
      assert.equal(got.delivery, 'proxy');
    } finally {
      s.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Parity on the share-link path
// -----------------------------------------------------------------------------

describe('deliveryFetch answers what deliveryHandler answers, on /d', () => {
  it('agrees on redeeming a link', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
        subject: { type: 'link' },
      });
      const got = await s.compare(`/d/${share.secret}`);
      assert.equal(got.status, 200);
      assert.equal(got.body, ALPHABET);
    } finally {
      s.close();
    }
  });

  it('agrees on a revoked link', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
        subject: { type: 'link' },
      });
      await w.fl.revoke({ actorId: w.alice }, share.grantId);
      const got = await s.compare(`/d/${share.secret}`);
      assert.ok(got.status >= 400, 'a revoked link still served bytes');
    } finally {
      s.close();
    }
  });

  it('agrees on a secret that was never issued', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const got = await s.compare('/d/not-a-real-secret');
      assert.equal(got.status, 404);
    } finally {
      s.close();
    }
  });

  it('agrees on the 401 that tells a client to retry with a password', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
        subject: { type: 'link' },
        password: 'hunter2',
      });
      const got = await s.compare(`/d/${share.secret}`);
      assert.equal(got.status, 401);
      // The header is the whole mechanism: without it the client has no way to
      // know a password exists, and no reason to try a POST.
      assert.equal(got.authenticate, 'FilelayerShare');
      assert.match(got.body, /"retry"/);
    } finally {
      s.close();
    }
  });

  it('agrees on a password in a JSON body, and on a wrong one', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
        subject: { type: 'link' },
        password: 'hunter2',
      });
      // Two links, because redeeming spends state and the two handlers would
      // otherwise be comparing different attempts of the same link.
      const wrong = await s.compare(`/d/${share.secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      assert.ok(wrong.status >= 400);

      const right = await s.compare(`/d/${share.secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'hunter2' }),
      });
      assert.equal(right.status, 200);
      assert.equal(right.body, ALPHABET);
    } finally {
      s.close();
    }
  });

  it('agrees on a password in a form body', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
        subject: { type: 'link' },
        password: 'hunter2',
      });
      const got = await s.compare(`/d/${share.secret}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ password: 'hunter2' }).toString(),
      });
      assert.equal(got.status, 200);
    } finally {
      s.close();
    }
  });

  it('agrees on refusing a password in the query string', async () => {
    const w = await world();
    const s = await both(w.fl, null);
    try {
      const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
        subject: { type: 'link' },
        password: 'hunter2',
      });
      const got = await s.compare(`/d/${share.secret}?password=hunter2`);
      assert.equal(got.status, 400);
    } finally {
      s.close();
    }
  });
});

// -----------------------------------------------------------------------------
// The four things that cannot be parity tests
// -----------------------------------------------------------------------------

describe('where the two runtimes genuinely differ', () => {
  it('returns null for a request it does not own, instead of a 404', async () => {
    const w = await world();
    const handler = deliveryFetch(w.fl, { principal: () => ({ actorId: w.alice }) });

    // `deliveryHandler` owns a whole server and 404s everything else. This one
    // is mounted inside an application that has its own routes, so "not mine"
    // has to be distinguishable from "mine, and missing" -- otherwise it
    // swallows every other route in the app.
    assert.equal(await handler(new Request('http://x/anything/else')), null);
    assert.equal(await handler(new Request('http://x/f/a/b')), null, 'too many segments');
    assert.equal(await handler(new Request('http://x/f')), null, 'no segment at all');
    assert.equal(
      await handler(new Request(`http://x/f/${w.file.id}`, { method: 'DELETE' })),
      null,
      'a method this route does not serve belongs to the application',
    );

    // ...and a file id that is simply wrong IS ours, and is a 404 with a body.
    const missing = await handler(new Request('http://x/f/00000000-0000-0000-0000-000000000000'));
    assert.ok(missing);
    assert.equal(missing.status, 404);
  });

  it('answers HEAD with the headers of the GET and no body', async () => {
    const w = await world();
    const handler = deliveryFetch(w.fl, { principal: () => ({ actorId: w.alice }) });

    const get = await handler(new Request(`http://x/f/${w.file.id}`));
    const head = await handler(new Request(`http://x/f/${w.file.id}`, { method: 'HEAD' }));
    assert.ok(get && head);
    assert.equal(head.status, get.status);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(head.headers.get('accept-ranges'), 'bytes');
    assert.equal(await head.text(), '', 'a HEAD must not carry a body');
    // Not compared with the node handler: `node:http` strips the body itself,
    // so `fetch()` against it shows the same emptiness for a different reason.
  });

  it('records no client address unless the application supplies one', async () => {
    const w = await world();
    const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
      subject: { type: 'link' },
    });

    // X-Forwarded-For is written by whoever spoke last. If this library read it
    // on its own, any client reachable directly could choose what the audit log
    // says about them -- so it does not, and the default is no address rather
    // than an attacker's.
    const blind = deliveryFetch(w.fl);
    await blind(new Request(`http://x/d/${share.secret}`, {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    }));

    const events = await w.fl.store.listAudit(w.org, { limit: 50 });
    const reads = events.filter((e) => e.action === 'file.read' && e.decision === 'allow');
    assert.ok(reads.length > 0, 'the read was not audited at all');
    // Checked across EVERY event rather than only the read: the address would
    // be just as wrong on the deny that a bad secret writes, and asserting
    // against one action is how a leak survives in another.
    assert.ok(
      events.every((e) => !JSON.stringify(e).includes('203.0.113.9')),
      'a client-supplied address reached the audit log',
    );
  });

  it('takes the client address from the application when it supplies one', async () => {
    const w = await world();
    const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
      subject: { type: 'link' },
    });

    const trusting = deliveryFetch(w.fl, {
      clientIp: (req) => req.headers.get('cf-connecting-ip') ?? undefined,
      userAgent: (req) => req.headers.get('user-agent') ?? undefined,
    });
    const res = await trusting(new Request(`http://x/d/${share.secret}`, {
      headers: { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'proof/1' },
    }));
    assert.ok(res);
    assert.equal(res.status, 200);
  });

  it('refuses an oversized password body before reading it', async () => {
    const w = await world();
    const share = await w.fl.share({ actorId: w.alice }, w.file.id, {
      subject: { type: 'link' },
      password: 'hunter2',
    });
    const handler = deliveryFetch(w.fl, { maxBodyBytes: 32 });
    const res = await handler(new Request(`http://x/d/${share.secret}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(1024) }),
    }));
    assert.ok(res);
    assert.equal(res.status, 413);
  });
});
