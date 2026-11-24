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
