/**
 * PROGRESSIVE DISCLOSURE -- the property suite for the tiered API.
 *
 * Two things are being tested here and they matter in this order:
 *
 *   1. Each tier WORKS. The examples in `examples/tier{1,2,3}-*` are imported
 *      and run, not transcribed. If an example stops working, this fails.
 *
 *   2. Each tier is still SAFE. The whole risk of a "simple mode" is that the
 *      ergonomics quietly buy their simplicity by turning a property off. Every
 *      security property the full API sells is re-asserted at the tier that
 *      first exposes it, against the tiered surface rather than the full one --
 *      because a property that holds only when you use the verbose API is a
 *      property we do not have.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Filelayer } from '../src/filelayer.ts';
import { DEFAULT_WORKSPACE, SYSTEM_ACTOR, sniffContentType } from '../src/simple.ts';
import { fileDownloadRoute } from '../src/delivery.ts';
import { rejects } from './helpers.ts';

import { tier1, tier1Server } from '../../../examples/tier1-avatar/app.ts';
import { tier2, tier2App } from '../../../examples/tier2-user-files/app.ts';
import { tier3 } from '../../../examples/tier3-org-roles/app.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const utf8 = (s: string) => new TextEncoder().encode(s);

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((r) => server.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// =============================================================================
// TIER 1 -- public avatar
// =============================================================================

describe('TIER 1: a public avatar costs one call and no concepts', () => {
  test('example runs: put -> URL -> anonymous GET returns the bytes', async () => {
    const { fl, url } = await tier1(PNG);
    const server = tier1Server(fl);
    const base = await listen(server);
    try {
      assert.match(url, /^http:\/\/localhost:3000\/f\/[0-9a-f-]{36}$/);
      const res = await fetch(`${base}${new URL(url).pathname}`);
      assert.equal(res.status, 200);
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
    } finally {
      server.close();
    }
  });

  test('P1 SURVIVES: `public: true` is a grant row, not a boolean column', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await fl.files.put(PNG, { public: true });

    // There is still no public/visibility-public column anywhere.
    const cols = await fl.store.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'file'`,
    );
    const names = cols.rows.map((r) => r.column_name);
    assert.ok(!names.includes('public'), 'a `public` column has appeared on `file`');
    assert.ok(!names.includes('is_public'));

    // What exists instead is one explicit, listable anonymous grant.
    const grants = await fl.store.db.query<{ subject_type: string; capabilities: string }>(
      `SELECT subject_type, capabilities::text FROM file_grant WHERE file_id = $1`,
      [id],
    );
    assert.equal(grants.rows.length, 1);
    assert.equal(grants.rows[0]!.subject_type, 'anonymous');
    assert.equal(grants.rows[0]!.capabilities, '{read}');
  });

  test('P4 SURVIVES: unpublish() kills a URL already in the wild', async () => {
    const fl = await Filelayer.quickstart();
    const server = tier1Server(fl);
    const base = await listen(server);
    try {
      const { id } = await fl.files.put(PNG, { public: true });
      assert.equal((await fetch(`${base}/f/${id}`)).status, 200);

      const { revoked } = await fl.files.unpublish(id);
      assert.equal(revoked, 1);

      // Same URL. Same process. No deletion, no cache purge, no key rotation.
      assert.equal((await fetch(`${base}/f/${id}`)).status, 404);

      // ...and the bytes are still there for anyone who still has authority.
      const still = await fl.files.get(id, { as: SYSTEM_ACTOR });
      assert.deepEqual(still.body, PNG);
    } finally {
      server.close();
    }
  });

  test('P1 SURVIVES: a NON-public file is not reachable from the public route', async () => {
    const fl = await Filelayer.quickstart();
    const server = tier1Server(fl);
    const base = await listen(server);
    try {
      const { id } = await fl.files.put(utf8('secret'), {}); // note: no `public`
      const res = await fetch(`${base}/f/${id}`);
      assert.equal(res.status, 404);
      // 404, not 403: the public route is not an existence oracle for private files.
      assert.deepEqual(await res.json(), { error: 'not_found' });
    } finally {
      server.close();
    }
  });

  test('the default workspace is a real org, not a NULL one', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await fl.files.put(PNG, { public: true });
    const { rows } = await fl.store.db.query<{ org_id: string | null; external_id: string }>(
      `SELECT f.org_id, o.external_id FROM file f JOIN org o ON o.id = f.org_id WHERE f.id = $1`,
      [id],
    );
    assert.equal(rows.length, 1, 'the file must be joined to a real org row');
    assert.notEqual(rows[0]!.org_id, null);
    assert.equal(rows[0]!.external_id, DEFAULT_WORKSPACE);
  });

  test('active content is served inert even when uploaded as a "public avatar"', async () => {
    const fl = await Filelayer.quickstart();
    const server = tier1Server(fl);
    const base = await listen(server);
    try {
      const { id } = await fl.files.put(utf8('<script>alert(document.cookie)</script>'), {
        public: true,
        name: 'x.svg',
        contentType: 'image/svg+xml',
      });
      const res = await fetch(`${base}/f/${id}`);
      assert.equal(res.status, 200);
      // Requested `inline`, but an active type is forced back to attachment and
      // its content type is neutralised.
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      server.close();
    }
  });

  test('sniffing is conservative: unknown bytes are octet-stream, never guessed active', () => {
    assert.equal(sniffContentType(PNG), 'image/png');
    assert.equal(sniffContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(sniffContentType(utf8('%PDF-1.7')), 'application/pdf');
    assert.equal(sniffContentType(utf8('<html><script>')), 'application/octet-stream');
    assert.equal(sniffContentType(utf8('<svg onload=alert(1)>')), 'application/octet-stream');
  });

  test('publishing is audited, so "who made this public?" has an answer', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await fl.files.put(PNG, { public: true });
    const { rows } = await fl.store.db.query<{ action: string; context: unknown }>(
      `SELECT action, context::text FROM audit_event WHERE file_id = $1 ORDER BY id`,
      [id],
    );
    const actions = rows.map((r) => r.action);
    assert.ok(actions.includes('file.create'));
    assert.ok(actions.includes('grant.create'), 'making a file public must be an audited event');
  });
});

// =============================================================================
// TIER 2 -- user-owned private files
// =============================================================================

describe('TIER 2: an owner is the only new concept', () => {
  test('example runs: alice can read her own file', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await tier2(fl);
    const mine = await fl.files.get(id, { as: 'alice' });
    assert.equal(new TextDecoder().decode(mine.body), 'alice private notes');
  });

  test('P1 SURVIVES: bob cannot read alice`s file, and gets 404 not 403', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await tier2(fl);
    await fl.files.put(utf8('bob file'), { owner: 'bob' }); // bob is a real user
    await rejects(() => fl.files.get(id, { as: 'bob' }), 404);
  });

  test('P2 SURVIVES: an anonymous caller holding the id gets nothing', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await tier2(fl);
    await rejects(() => fl.files.get(id), 404);
  });

  test('P2 SURVIVES: an UNKNOWN `as:` is denied, never demoted to anonymous', async () => {
    // This is the single most dangerous shortcut available in a "simple mode":
    // resolve the user, and if you cannot, just carry on as nobody. It would
    // turn a typo in a user id into a silent read of every public file and an
    // audit trail attributed to no one.
    const fl = await Filelayer.quickstart();
    const { id } = await fl.files.put(PNG, { public: true });
    // The file IS anonymously readable...
    assert.ok(await fl.files.get(id));
    // ...but a bogus identity is still an error, not a fallback.
    await rejects(() => fl.files.get(id, { as: 'nobody-by-that-name' }), 404);
  });

  test('auto-provisioning grants an identity, never a permission', async () => {
    const fl = await Filelayer.quickstart();
    await fl.files.put(utf8('a'), { owner: 'alice' });
    const { rows } = await fl.store.db.query<{ role: string }>(
      `SELECT m.role FROM membership m
         JOIN actor a ON a.id = m.actor_id
        WHERE a.external_id = 'alice'`,
    );
    assert.deepEqual(rows.map((r) => r.role), ['member']);
  });

  test('auto-provisioning cannot DEMOTE an identity a developer promoted', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'root' });
    await fl.orgs.setRole('acme', 'alice', 'admin', { as: 'root' });
    // An ordinary upload runs the same ensure-membership path.
    await fl.files.put(utf8('a'), { org: 'acme', owner: 'alice' });
    const { rows } = await fl.store.db.query<{ role: string }>(
      `SELECT m.role FROM membership m
         JOIN actor a ON a.id = m.actor_id
         JOIN org o ON o.id = m.org_id
        WHERE a.external_id = 'alice' AND o.external_id = 'acme'`,
    );
    assert.deepEqual(rows.map((r) => r.role), ['admin']);
  });

  test('the tier-2 example app returns 404 for the wrong user over real HTTP', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await tier2(fl);
    await fl.files.put(utf8('b'), { owner: 'bob' });
    const server = tier2App(fl);
    const base = await listen(server);
    try {
      assert.equal((await fetch(`${base}/files/${id}`, { headers: { 'x-user-id': 'alice' } })).status, 200);
      assert.equal((await fetch(`${base}/files/${id}`, { headers: { 'x-user-id': 'bob' } })).status, 404);
      assert.equal((await fetch(`${base}/files/${id}`)).status, 404);
    } finally {
      server.close();
    }
  });
});

// =============================================================================
// TIER 3 -- orgs and roles
// =============================================================================

describe('TIER 3: adding `org:` is an option, not a migration', () => {
  test('example runs: role matrix behaves as the full API does', async () => {
    const fl = await Filelayer.quickstart();
    const { privateId, sharedId } = await tier3(fl);

    // private: owner yes, everyone else no
    assert.ok(await fl.files.get(privateId, { as: 'ceo' }));
    await rejects(() => fl.files.get(privateId, { as: 'analyst' }), 404);
    await rejects(() => fl.files.get(privateId, { as: 'auditor' }), 404);

    // visibility 'org': every member, including a viewer
    assert.ok(await fl.files.get(sharedId, { as: 'analyst' }));
    assert.ok(await fl.files.get(sharedId, { as: 'auditor' }));
  });

  test('P3 SURVIVES: a file in acme is unreachable from another tenant', async () => {
    const fl = await Filelayer.quickstart();
    await tier3(fl);
    await fl.orgs.create('globex', { owner: 'rival' });
    const { privateId } = await tier3Ids(fl);
    await rejects(() => fl.files.get(privateId, { as: 'rival' }), 404);
  });

  test('P3 SURVIVES: every tiered file still carries a non-null org_id', async () => {
    const fl = await Filelayer.quickstart();
    await fl.files.put(PNG, { public: true }); // tier 1
    await fl.files.put(utf8('a'), { owner: 'alice' }); // tier 2
    await tier3(fl); // tier 3
    const { rows } = await fl.store.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file WHERE org_id IS NULL`,
    );
    assert.equal(Number(rows[0]!.n), 0);
  });

  test('membership changes are NOT simplified: `as` is required and authorized', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'ceo' });
    await fl.orgs.setRole('acme', 'mallory', 'viewer', { as: 'ceo' });
    // A viewer cannot promote themselves, through the tiered API either.
    await rejects(() => fl.orgs.setRole('acme', 'mallory', 'owner', { as: 'mallory' }), 404);
  });

  test('a tier-1 public put into a NAMED org does not make us an admin of it', async () => {
    // The service identity is `owner` of the default workspace but only
    // `member` of a customer tenant, so an unowned upload cannot be a back door
    // into that tenant's private documents.
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'ceo' });
    const { id: secret } = await fl.files.put(utf8('board deck'), { org: 'acme', owner: 'ceo' });
    await fl.files.put(PNG, { org: 'acme', public: true }); // unowned -> system actor
    await rejects(() => fl.files.get(secret, { as: SYSTEM_ACTOR }), 404);
  });
});

// =============================================================================
// TIER 4 -- sharing, expiry, caps, audit, through the tiered surface
// =============================================================================

describe('TIER 4: the full Vault capabilities, reached by adding options', () => {
  test('share link with expiry, password and cap; revocation beats the URL', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'https://vault.test' });
    await fl.orgs.create('acme', { owner: 'ceo' });
    const { id } = await fl.files.put(utf8('contract'), { org: 'acme', owner: 'ceo' });

    const share = await fl.shares.create(id, {
      as: 'ceo',
      expiresIn: 3600,
      maxDownloads: 2,
      password: 'hunter2',
    });
    assert.ok(share.secret);
    assert.equal(share.maxDownloads, 2);

    // wrong password
    await rejects(() => fl.shares.redeem(share.secret!, { password: 'wrong' }), 401);
    // right password, twice, then the cap bites
    assert.ok(await fl.shares.redeem(share.secret!, { password: 'hunter2' }));
    assert.ok(await fl.shares.redeem(share.secret!, { password: 'hunter2' }));
    await rejects(() => fl.shares.redeem(share.secret!, { password: 'hunter2' }), 404);
  });

  test('revocation through the tiered API is immediate', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'https://vault.test' });
    await fl.orgs.create('acme', { owner: 'ceo' });
    const { id } = await fl.files.put(utf8('contract'), { org: 'acme', owner: 'ceo' });
    const share = await fl.shares.create(id, { as: 'ceo' });
    assert.ok(await fl.shares.redeem(share.secret!));
    await fl.shares.revoke(share.grantId, { as: 'ceo' });
    await rejects(() => fl.shares.redeem(share.secret!), 404);
  });

  test('P5 SURVIVES: the audit trail of a tiered app is complete and verifiable', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'ceo' });
    const { id } = await fl.files.put(utf8('x'), { org: 'acme', owner: 'ceo' });
    await fl.files.get(id, { as: 'ceo' });
    await fl.orgs.setRole('acme', 'temp', 'viewer', { as: 'ceo' });
    await rejects(() => fl.files.get(id, { as: 'temp' }), 404); // a denial

    const log = await fl.orgs.audit('acme', { as: 'ceo' });
    const actions = log.map((e) => e.action);
    assert.ok(actions.includes('file.create'));
    assert.ok(actions.includes('member.add'));
    assert.ok(log.some((e) => e.decision === 'deny'), 'denials must be recorded');

    const chain = await fl.orgs.verifyAudit('acme', { as: 'ceo' });
    assert.equal(chain.valid, true);
  });

  test('audit is not readable by a non-admin, through the tiered API either', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'ceo' });
    await fl.orgs.setRole('acme', 'temp', 'member', { as: 'ceo' });
    await rejects(() => fl.orgs.audit('acme', { as: 'temp' }), 404);
  });
});

// =============================================================================
// CROSS-TIER -- the claim that tiers COMPOSE rather than fork
// =============================================================================

describe('the tiers are one model, not four', () => {
  test('a tier-1 file can be promoted to tier 4 without moving it', async () => {
    // The architectural claim under test: nothing about starting simple has to
    // be undone in order to get the advanced capabilities. Same row, same id,
    // same URL space.
    const fl = await Filelayer.quickstart({ baseUrl: 'https://x.test' });
    const { id } = await fl.files.put(utf8('doc'), { public: true }); // tier 1

    await fl.files.unpublish(id); // withdraw public access
    await rejects(() => fl.files.get(id), 404);

    // Now hand it to a named user, with an expiring capped link. Same file id.
    const share = await fl.shares.create(id, { as: SYSTEM_ACTOR, maxDownloads: 1 });
    const got = await fl.shares.redeem(share.secret!);
    assert.equal(new TextDecoder().decode(got.body), 'doc');
    await rejects(() => fl.shares.redeem(share.secret!), 404);
  });

  test('the full API and the tiered API are the same objects, not parallel worlds', async () => {
    const fl = await Filelayer.quickstart();
    const { id } = await fl.files.put(utf8('doc'), { owner: 'alice' });

    // Reached through the tiered surface, inspected through the full one.
    const { rows } = await fl.store.db.query<{ external_id: string }>(
      `SELECT a.external_id FROM file f JOIN actor a ON a.id = f.owner_id WHERE f.id = $1`,
      [id],
    );
    assert.equal(rows[0]!.external_id, 'alice');

    // `getFileRecord` used to be reachable from here without a principal; it is
    // private now, so the full-API inspection goes through the authorized
    // `stat()` and must name who is asking.
    const record = await fl.files.stat(id, { as: 'alice' });
    assert.equal(record.visibility, 'private');
  });

  test('metering: distinct file-owning users are actually recorded', async () => {
    const fl = await Filelayer.quickstart();
    await fl.files.put(utf8('a'), { owner: 'alice' });
    await fl.files.put(utf8('b'), { owner: 'alice' }); // same user, same day
    await fl.files.put(utf8('c'), { owner: 'bob' });
    const { rows } = await fl.store.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_owning_user_daily`,
    );
    assert.equal(Number(rows[0]!.n), 2, 'distinct owners per org per day');
  });
});

/** Re-run tier3 against an already-seeded world without re-creating the org. */
async function tier3Ids(fl: Filelayer) {
  const { rows } = await fl.store.db.query<{ id: string; visibility: string }>(
    `SELECT f.id, f.visibility FROM file f JOIN org o ON o.id = f.org_id
      WHERE o.external_id = 'acme' AND f.visibility = 'private' ORDER BY f.created_at LIMIT 1`,
  );
  return { privateId: rows[0]!.id };
}
