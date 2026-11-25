/**
 * WHAT A STRANGER LEARNS ABOUT AN ORG ID: NOTHING, SINCE 0.37.0 (D081).
 *
 *   put into an org that does not exist           -> 404 not_found (reason unknown_org)
 *   put by a non-member into an org that exists   -> 404 not_found (reason no_membership)
 *   list an org that does not exist               -> { files: [] }
 *   list an org that exists, with no access       -> { files: [] }
 *
 * Until 0.36.1 the first pair differed in status (404 against 403) and the
 * second in kind (a throw against an empty page), so a caller could tell
 * whether an org id existed (LIMITATIONS.md entry 18, now closed). The status,
 * code and message are now the same in each pair. `reason` stays on the error
 * for the developer, as on every other refusal, and is never sent to an
 * untrusted caller; the audit log records it in both cases.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Filelayer } from '../src/filelayer.ts';
import type { Queryable } from '../src/db.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);

async function world() {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  await fl.files.put(utf8('plan'), { org: 'acme', owner: 'alice', name: 'plan.txt' });
  // mallory is a known user, of an org of her own, and in neither org above.
  await fl.orgs.create('mallory-co', { owner: 'mallory' });
  return fl;
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { status?: number; code?: string; reason?: string; message?: string };
    return { status: err.status, code: err.code, message: err.message, reason: err.reason };
  }
};

const denies = async (fl: Filelayer, reason: string) => {
  const db = (fl as unknown as { store: { db: Queryable } }).store.db;
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM audit_event WHERE decision = 'deny' AND reason = $1`,
    [reason],
  );
  return Number(rows[0]!.n);
};

test('put: an org that does not exist and one the caller is not in get the same answer', async () => {
  const fl = await world();
  try {
    const ghost = await refusal(fl.files.put(utf8('x'), { org: 'ghost', owner: 'mallory', name: 'x.txt' }));
    const acme = await refusal(fl.files.put(utf8('x'), { org: 'acme', owner: 'mallory', name: 'x.txt' }));
    const { reason: r1, ...publicGhost } = ghost!;
    const { reason: r2, ...publicAcme } = acme!;
    assert.deepEqual(publicGhost, { status: 404, code: 'not_found', message: 'not_found' });
    assert.deepEqual(publicAcme, publicGhost, 'status, code and message are the same');
    assert.equal(r1, 'unknown_org');
    assert.equal(r2, 'no_membership');
  } finally {
    await fl.close();
  }
});

test('put: both refusals are on the record, each with its true reason', async () => {
  const fl = await world();
  try {
    const before = { unknown: await denies(fl, 'unknown_org'), member: await denies(fl, 'no_membership') };
    await refusal(fl.files.put(utf8('x'), { org: 'ghost', owner: 'mallory', name: 'x.txt' }));
    await refusal(fl.files.put(utf8('x'), { org: 'acme', owner: 'mallory', name: 'x.txt' }));
    assert.equal(await denies(fl, 'unknown_org'), before.unknown + 1);
    assert.equal(await denies(fl, 'no_membership'), before.member + 1);
  } finally {
    await fl.close();
  }
});

test('list: an org that does not exist and one the caller cannot read give the same page', async () => {
  const fl = await world();
  try {
    const ghost = await fl.files.list({ org: 'ghost', as: 'mallory' });
    const acme = await fl.files.list({ org: 'acme', as: 'mallory' });
    assert.deepEqual(ghost.files, []);
    assert.deepEqual(ghost, acme);
    // Anonymous too.
    assert.deepEqual(await fl.files.list({ org: 'ghost' }), await fl.files.list({ org: 'acme' }));
  } finally {
    await fl.close();
  }
});

test('list: a missing org is still recorded as unknown_org', async () => {
  const fl = await world();
  try {
    const before = await denies(fl, 'unknown_org');
    await fl.files.list({ org: 'ghost', as: 'mallory' });
    assert.equal(await denies(fl, 'unknown_org'), before + 1);
  } finally {
    await fl.close();
  }
});

test('list: bad arguments are refused alike, whether the org exists or not', async () => {
  const fl = await world();
  try {
    for (const bad of [{ cursor: 'not-a-cursor' }, { limit: 0 }]) {
      const ghost = await refusal(fl.files.list({ org: 'ghost', as: 'mallory', ...bad }));
      const acme = await refusal(fl.files.list({ org: 'acme', as: 'mallory', ...bad }));
      assert.ok(acme, `acme refuses ${JSON.stringify(bad)}`);
      assert.deepEqual(ghost, acme);
    }
  } finally {
    await fl.close();
  }
});

// shares.create({ withOrg }) names an org as the SUBJECT of a grant, and a
// grant to an org that exists in the caller's project is the feature (a
// cross-org grant inside one project). What must not be visible is an org the
// caller cannot point a grant at: one in another project, which the schema
// refuses (composite foreign key), and one that was deleted. Those answer
// exactly as an org that never existed.
test('shares.create withOrg: an org in another project, or deleted, answers like one that does not exist', async () => {
  const { createTestDb } = await import('../src/db.ts');
  const { MemoryStorage } = await import('../src/storage.ts');
  const { db } = await createTestDb();
  const a = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://x' });
  const other = (await a.createProject('other', 'Other')).id;
  const b = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://x', projectId: other });
  try {
    await a.orgs.create('home', { owner: 'alice' });
    const file = await a.files.put(utf8('doc'), { org: 'home', owner: 'alice', name: 'doc.txt' });
    await b.orgs.create('elsewhere', { owner: 'bob' });
    await a.orgs.create('gone', { owner: 'alice' });
    await a.softDeleteOrg((await a.ids.orgId('gone'))!);

    const ask = (org: string) => refusal(a.shares.create(file.id, { as: 'alice', withOrg: org }));
    const ghost = await ask('ghost');
    assert.deepEqual(
      { status: ghost?.status, code: ghost?.code, message: ghost?.message },
      { status: 404, code: 'not_found', message: 'not_found' },
    );
    assert.deepEqual(await ask('elsewhere'), ghost, 'an org in another project');
    assert.deepEqual(await ask('gone'), ghost, 'a deleted org');
  } finally {
    await a.close();
    await b.close();
  }
});

// -----------------------------------------------------------------------------
// The orgs.* methods, with arguments a typed call would not send. A check that
// ran only on the path for a real org answered `invalid_argument` there and
// `404` on a missing one (cold review of e0c6bb4, B1). Each pair must match.
// -----------------------------------------------------------------------------

const pairs: Array<[string, (fl: Filelayer, org: string) => Promise<unknown>]> = [
  ['orgs.setRole with a role that is not one', (fl, org) => fl.orgs.setRole(org, 'bob', 'god' as never, { as: 'mallory' })],
  ['orgs.setRole with no role', (fl, org) => fl.orgs.setRole(org, 'bob', undefined as never, { as: 'mallory' })],
  ['orgs.setRole as a stranger', (fl, org) => fl.orgs.setRole(org, 'bob', 'admin', { as: 'mallory' })],
  ['orgs.removeMember as a stranger', (fl, org) => fl.orgs.removeMember(org, 'alice', { as: 'mallory' })],
  ['orgs.removeMember with no as', (fl, org) => fl.orgs.removeMember(org, 'alice', {} as never)],
  ['orgs.audit with no as', (fl, org) => fl.orgs.audit(org, {} as never)],
  ['orgs.audit as a stranger', (fl, org) => fl.orgs.audit(org, { as: 'mallory' })],
  ['orgs.verifyAudit with no as', (fl, org) => fl.orgs.verifyAudit(org, {} as never)],
  ['orgs.verifyAudit as a stranger', (fl, org) => fl.orgs.verifyAudit(org, { as: 'mallory' })],
];
for (const [name, call] of pairs) {
  test(`${name}: the same answer for an org that exists and one that does not`, async () => {
    const fl = await world();
    try {
      const strip = (r: Awaited<ReturnType<typeof refusal>>) => (r ? { ...r, reason: undefined } : r);
      const acme = await refusal(call(fl, 'acme'));
      const ghost = await refusal(call(fl, 'ghost'));
      assert.ok(acme, 'refused on the org that exists');
      assert.deepEqual(strip(ghost), strip(acme));
    } finally {
      await fl.close();
    }
  });
}

test('list: a capability that is not one is refused alike, as invalid_argument', async () => {
  const fl = await world();
  try {
    // '' and the other falsy values too: a truthiness test on one path made
    // them the default `read` there and an error on the other (review of 7c1135f).
    for (const bad of ['bogus', '', null, 0, false]) {
      const acme = await refusal(fl.files.list({ org: 'acme', as: 'mallory', capability: bad as never }));
      const ghost = await refusal(fl.files.list({ org: 'ghost', as: 'mallory', capability: bad as never }));
      assert.equal(acme?.code, 'invalid_argument', `${JSON.stringify(bad)}: a FilelayerError, not a raw Postgres error`);
      assert.deepEqual(ghost, acme, JSON.stringify(bad));
    }
  } finally {
    await fl.close();
  }
});

test('shares.create withOrg: a minRole that is not a role is refused alike, as invalid_argument', async () => {
  const fl = await world();
  try {
    const file = await fl.files.put(utf8('mine'), { org: 'mallory-co', owner: 'mallory', name: 'm.txt' });
    const ask = (org: string) => refusal(fl.shares.create(file.id, { as: 'mallory', withOrg: org, minRole: 'god' as never }));
    const acme = await ask('acme');
    assert.equal(acme?.code, 'invalid_argument', 'not a raw Postgres error carrying the INSERT');
    assert.deepEqual(await ask('ghost'), acme);
    // And in core, for a role subject.
    const malloryId = (await fl.ids.actorId('mallory'))!;
    const acmeId = (await fl.ids.orgId('acme'))!;
    const core = await refusal(
      fl.share({ actorId: malloryId }, file.id, { subject: { type: 'role', orgId: acmeId, minRole: 'god' as never } }),
    );
    assert.equal(core?.code, 'invalid_argument');
  } finally {
    await fl.close();
  }
});

test('a refused put registers nobody, so a later list({ as }) cannot tell the orgs apart', async () => {
  const fl = await world();
  try {
    await refusal(fl.files.put(utf8('x'), { org: 'acme', owner: 'new-1', name: 'x.txt' }));
    await refusal(fl.files.put(utf8('x'), { org: 'ghost', owner: 'new-2', name: 'x.txt' }));
    const one = await refusal(fl.files.list({ as: 'new-1' }));
    const two = await refusal(fl.files.list({ as: 'new-2' }));
    assert.equal(one?.status, 404);
    assert.deepEqual(one, two);
  } finally {
    await fl.close();
  }
});

test("a non-member's refused put is on that org's chain, and on no other", async () => {
  const fl = await world();
  try {
    const db = (fl as unknown as { store: { db: Queryable } }).store.db;
    const acmeId = (await fl.ids.orgId('acme'))!;
    const count = async () =>
      (
        await db.query<{ org_id: string | null; n: string }>(
          `SELECT org_id, count(*)::text AS n FROM audit_event
            WHERE action = 'org.access' AND reason = 'no_membership' GROUP BY org_id`,
        )
      ).rows;
    assert.deepEqual(await count(), []);
    await refusal(fl.files.put(utf8('x'), { org: 'acme', owner: 'mallory', name: 'x.txt' }));
    assert.deepEqual(await count(), [{ org_id: acmeId, n: '1' }]);
  } finally {
    await fl.close();
  }
});

test('orgs.audit: filters that cannot match are refused, not sent to Postgres', async () => {
  const fl = await world();
  try {
    for (const bad of [
      { file: 'not-a-uuid' },
      { since: new Date('nope') },
      { until: new Date('nope') },
      { since: 'yesterday' as never },
      { until: {} as never },
      { decision: 'bogus' as never },
    ]) {
      const r = await refusal(fl.orgs.audit('acme', { as: 'alice', ...bad }));
      assert.equal(r?.code, 'invalid_argument', JSON.stringify(bad));
    }
    // Core: `actorId` is an internal id, checked the same way.
    const aliceId = (await fl.ids.actorId('alice'))!;
    const acmeId = (await fl.ids.orgId('acme'))!;
    const core = await refusal(fl.auditLog({ actorId: aliceId }, acmeId, { actorId: 'not-a-uuid' }));
    assert.equal(core?.code, 'invalid_argument');
  } finally {
    await fl.close();
  }
});

test('orgs.audit: since and until given as an ISO string or epoch milliseconds still work', async () => {
  const fl = await world();
  try {
    const all = await fl.orgs.audit('acme', { as: 'alice' });
    assert.ok(all.length > 0);
    const past = Date.now() - 3_600_000;
    const future = Date.now() + 3_600_000;
    for (const bounds of [
      { since: new Date(past).toISOString(), until: new Date(future).toISOString() },
      { since: past, until: future },
      { since: '2000-01-01' },
    ]) {
      // At least every earlier row: each read is itself recorded, so later
      // reads see more.
      const rows = await fl.orgs.audit('acme', { as: 'alice', ...(bounds as object) });
      assert.ok(rows.length >= all.length, JSON.stringify(bounds));
    }
    const none = await fl.orgs.audit('acme', { as: 'alice', until: '2000-01-01' as never });
    assert.equal(none.length, 0);
  } finally {
    await fl.close();
  }
});
