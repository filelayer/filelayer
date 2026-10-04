/**
 * YOUR IDENTIFIERS REACH EVERY PART OF THE API.
 *
 * -----------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * -----------------------------------------------------------------------------
 *
 * `Principal.actorId` and `listFiles(principal, orgId)` take INTERNAL uuids.
 * Everything in the tiered facade takes the developer's own string ids and
 * keeps the mapping private. There was no bridge, so two ordinary things could
 * not be done from the facade at all:
 *
 *   1. A listing screen. `fl.files` had no `list()`, so the only route to one
 *      was the core API, which wanted an internal actor id AND an internal org
 *      id.
 *   2. Mounting the library's own HTTP route for authenticated reads.
 *      `deliveryHandler`'s `principal` callback had to return an internal id.
 *
 * Measured rather than argued: four integration tasks were given to agents
 * holding only the published `0.12.0` tarball, and three of them hit this. All
 * three invented the same workaround -- a `Map` from their user id to an
 * internal one, filled by harvesting values out of `FileRecord.ownerId` and
 * `GrantSummary.subjectId`, the only two places the public API let an internal
 * id escape. One stated the consequence precisely: a listing is then impossible
 * for any identity the library auto-provisioned, because no call recovers its
 * id.
 *
 * The tests below are written as the thing those agents could not do. Each one
 * uses nothing but external ids.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { deliveryHandler } from '../src/delivery.ts';
import { bytes, rejects } from './helpers.ts';

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
  return { db, fl };
}

async function serve(fl: Filelayer, user: () => string | null) {
  const server: Server = createServer(
    deliveryHandler(fl, { principal: () => ({ as: user() }) }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => server.close(),
  };
}

describe('fl.files.list(): the listing screen, in your id space', () => {
  it('lists what a caller may read, with no internal id anywhere', async () => {
    const { fl } = await world();
    await fl.files.put(bytes('a'), { owner: 'alice', name: 'a.txt' });
    await fl.files.put(bytes('b'), { owner: 'alice', name: 'b.txt' });
    await fl.files.put(bytes('c'), { owner: 'bob', name: 'c.txt' });

    const page = await fl.files.list({ as: 'alice' });
    assert.deepEqual(
      page.files.map((f) => f.name).sort(),
      ['a.txt', 'b.txt'],
    );
  });

  it('works for an identity the library auto-provisioned', async () => {
    // THE CASE THAT WAS IMPOSSIBLE. `put({ owner })` registers the identity
    // itself, so the application never saw an internal id for it and no public
    // call returned one. A listing for that user could not be built.
    const { fl } = await world();
    await fl.files.put(bytes('x'), { owner: 'never-explicitly-created', name: 'x.txt' });
    const page = await fl.files.list({ as: 'never-explicitly-created' });
    assert.deepEqual(page.files.map((f) => f.name), ['x.txt']);
  });

  it('paginates with an opaque cursor', async () => {
    const { fl } = await world();
    for (const n of ['1', '2', '3']) {
      await fl.files.put(bytes(n), { owner: 'alice', name: `${n}.txt` });
    }
    const first = await fl.files.list({ as: 'alice', limit: 2 });
    assert.equal(first.files.length, 2);
    assert.ok(first.nextCursor);
    const second = await fl.files.list({ as: 'alice', limit: 2, cursor: first.nextCursor });
    assert.equal(second.files.length, 1);
    assert.equal(second.nextCursor, null);
  });

  it('honours the capability, so a write listing is not a read listing', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('a'), { owner: 'alice', name: 'a.txt' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob', capabilities: ['read'] });

    assert.equal((await fl.files.list({ as: 'bob' })).files.length, 1);
    // Bob may read it and not write it, so a `write` listing is empty. The
    // predicate is generated from the same gate `authorize()` uses.
    assert.equal((await fl.files.list({ as: 'bob', capability: 'write' })).files.length, 0);
  });

  it('is scoped to one tenant, and names it in your id space', async () => {
    const { fl } = await world();
    await fl.orgs.create('acme', { owner: 'ceo' });
    await fl.orgs.setRole('acme', 'alice', 'member', { as: 'ceo' });
    await fl.files.put(bytes('a'), { org: 'acme', owner: 'alice', name: 'acme.txt' });
    await fl.files.put(bytes('w'), { owner: 'alice', name: 'workspace.txt' });

    const acme = await fl.files.list({ as: 'alice', org: 'acme' });
    assert.deepEqual(acme.files.map((f) => f.name), ['acme.txt']);
    // The default is the workspace, not "everything".
    const workspace = await fl.files.list({ as: 'alice' });
    assert.deepEqual(workspace.files.map((f) => f.name), ['workspace.txt']);
  });

  it('a stranger to the tenant gets an empty page, not somebody else files', async () => {
    const { fl } = await world();
    await fl.orgs.create('acme', { owner: 'ceo' });
    await fl.files.put(bytes('a'), { org: 'acme', owner: 'ceo', name: 'secret.txt' });
    await fl.files.put(bytes('o'), { owner: 'outsider' });

    const page = await fl.files.list({ as: 'outsider', org: 'acme' });
    assert.equal(page.files.length, 0);
  });

  it('does NOT create a tenant somebody mistyped', async () => {
    // `requireOrg`, not the get-or-create `org()`. A listing that provisioned a
    // tenant as a side effect of a typo would be a write on a read path, and
    // would make the next typo look like it worked.
    const { fl } = await world();
    await fl.files.put(bytes('a'), { owner: 'alice' });
    await rejects(() => fl.files.list({ as: 'alice', org: 'acmee' }), 404);
    assert.equal(await fl.ids.orgId('acmee'), null, 'the typo created a tenant');
  });

  it('an unknown user denies rather than listing the public files', async () => {
    const { fl } = await world();
    await fl.files.put(bytes('a'), { public: true });
    await rejects(() => fl.files.list({ as: 'who-is-this' }), 404);
  });
});

describe('deliveryHandler takes { as }, so the route can be mounted', () => {
  it('serves an authenticated read with no internal id in the application', async () => {
    // THE WHOLE POINT. Before this, `principal` had to return an internal
    // uuid, so an application with its own user ids could not mount the
    // library's own route for authenticated reads.
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('private bytes'), { owner: 'alice' });
    let user: string | null = 'alice';
    const s = await serve(fl, () => user);
    try {
      const mine = await fetch(`${s.base}/f/${id}`);
      assert.equal(mine.status, 200);
      assert.equal(await mine.text(), 'private bytes');

      user = 'bob';
      await fl.files.put(bytes('b'), { owner: 'bob' });
      const theirs = await fetch(`${s.base}/f/${id}`);
      assert.equal(theirs.status, 404, 'another user read it');
      await theirs.arrayBuffer();
    } finally {
      s.close();
    }
  });

  it('{ as: null } is an anonymous caller, which reaches only published files', async () => {
    const { fl } = await world();
    const priv = await fl.files.put(bytes('private'), { owner: 'alice' });
    const pub = await fl.files.put(bytes('public'), { public: true });
    const s = await serve(fl, () => null);
    try {
      assert.equal((await fetch(`${s.base}/f/${priv.id}`)).status, 404);
      const open = await fetch(`${s.base}/f/${pub.id}`);
      assert.equal(open.status, 200);
      assert.equal(await open.text(), 'public');
    } finally {
      s.close();
    }
  });

  it('an unknown id DENIES and is recorded, never downgraded to anonymous', async () => {
    // The property that makes the convenience safe. A typo in a session lookup
    // must not become a read of every public file, and the attempt must be
    // visible for the same reason it is on `fl.files.get()`.
    const { fl, db } = await world();
    const pub = await fl.files.put(bytes('public'), { public: true });
    const s = await serve(fl, () => 'ghost-user');
    try {
      const res = await fetch(`${s.base}/f/${pub.id}`);
      assert.equal(res.status, 404, 'an unknown id was downgraded to anonymous');
      await res.arrayBuffer();

      const { rows } = await db.query<{ as: string | null }>(
        `SELECT context->>'as' AS as FROM audit_event
          WHERE reason = 'unknown_actor' ORDER BY id DESC LIMIT 1`,
      );
      assert.equal(rows[0]?.as, 'ghost-user', 'the attempt left no audit event');
    } finally {
      s.close();
    }
  });

  it('still accepts a Principal, for ip/userAgent and for core callers', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('private bytes'), { owner: 'alice' });
    const actorId = await fl.ids.actorId('alice');
    assert.ok(actorId);

    const server = createServer(
      deliveryHandler(fl, { principal: () => ({ actorId, ip: '203.0.113.9' }) }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/f/${id}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'private bytes');
    } finally {
      server.close();
    }
  });
});

describe('fl.ids: the escape hatch, for when you really do need the uuid', () => {
  it('resolves an actor and an org, and returns null for an unknown one', async () => {
    const { fl } = await world();
    await fl.files.put(bytes('a'), { owner: 'alice' });
    await fl.orgs.create('acme', { owner: 'ceo' });

    assert.match((await fl.ids.actorId('alice'))!, /^[0-9a-f-]{36}$/);
    assert.match((await fl.ids.orgId('acme'))!, /^[0-9a-f-]{36}$/);
    // Null rather than throwing: the caller asked a question, not for access.
    assert.equal(await fl.ids.actorId('nobody'), null);
    assert.equal(await fl.ids.orgId('no-such-tenant'), null);
  });

  it('actorId() creates nothing, which is what separates it from ensureActor()', async () => {
    const { fl } = await world();
    assert.equal(await fl.ids.actorId('newcomer'), null);
    assert.equal(await fl.ids.actorId('newcomer'), null, 'the lookup provisioned an identity');

    const id = await fl.ids.ensureActor('newcomer');
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal(await fl.ids.actorId('newcomer'), id);
  });

  it('ensureActor() is idempotent, unlike createActor() on the core API', async () => {
    // `createActor()` is a bare INSERT and throws on a second call, which is
    // why it is the wrong thing to build an id cache on -- an identity another
    // call auto-provisioned can never be created again, so its id was
    // unrecoverable. This is the upsert.
    const { fl } = await world();
    const first = await fl.ids.ensureActor('alice');
    const second = await fl.ids.ensureActor('alice');
    assert.equal(second, first);
    await assert.rejects(() => fl.createActor('alice'), 'createActor stopped throwing');
  });

  it('the resolved id is the one the engine uses', async () => {
    // Otherwise the escape hatch is decoration.
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('private'), { owner: 'alice' });
    const actorId = (await fl.ids.actorId('alice'))!;
    const d = await fl.read({ actorId }, id);
    assert.equal(new TextDecoder().decode(d.body), 'private');
  });

  it('resolution is scoped to the project', async () => {
    // P8: `external_id` is unique per project, so an id resolved by an instance
    // bound to one project must not resolve in another.
    const { db } = await createTestDb();
    const a = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://x' });
    const project = (await a.createProject('other', 'Other')).id;
    const b = new Filelayer(db, new MemoryStorage(), {
      baseUrl: 'http://x',
      projectId: project,
    });

    await a.files.put(bytes('a'), { owner: 'alice' });
    await a.orgs.create('acme', { owner: 'ceo' });

    assert.ok(await a.ids.actorId('alice'));
    assert.ok(await a.ids.orgId('acme'));
    // BOTH id spaces, because they are two queries and only one of them was
    // covered until a mutation dropping the project filter from `findOrg`
    // survived this suite.
    assert.equal(await b.ids.actorId('alice'), null, 'an actor id leaked across projects');
    assert.equal(await b.ids.orgId('acme'), null, 'an org id leaked across projects');
  });
});
