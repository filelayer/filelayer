/**
 * WHAT A STRANGER LEARNS ABOUT AN ORG ID, AS OF 0.36.1. A limitation, written
 * down (LIMITATIONS.md, entry 18), not a property: these tests assert the
 * behaviour as it is so that changing it is a decision, not an accident.
 *
 *   put into an org that does not exist           -> 404 not_found, unknown_org
 *   put by a non-member into an org that exists   -> 403 forbidden, no_membership
 *   list an org that does not exist               -> 404 not_found, unknown_org
 *   list an org that exists, with no access       -> { files: [] }
 *
 * The status alone tells a caller whether an org id exists, which
 * src/errors.ts says the reasons must not (both misses a 404, "so that a
 * stranger cannot tell them apart"). The next minor release is planned to
 * answer both pairs alike and keep the reason in the audit log; these tests
 * change with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Filelayer } from '../src/filelayer.ts';

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
    const err = e as { status?: number; code?: string; reason?: string };
    return { status: err.status, code: err.code, reason: err.reason };
  }
};

test('0.36.1: put tells an org that does not exist from one the caller is not in', async () => {
  const fl = await world();
  try {
    const ghost = await refusal(fl.files.put(utf8('x'), { org: 'ghost', owner: 'mallory', name: 'x.txt' }));
    const acme = await refusal(fl.files.put(utf8('x'), { org: 'acme', owner: 'mallory', name: 'x.txt' }));
    assert.deepEqual(ghost, { status: 404, code: 'not_found', reason: 'unknown_org' });
    assert.deepEqual(acme, { status: 403, code: 'forbidden', reason: 'no_membership' });
  } finally {
    await fl.close();
  }
});

test('0.36.1: list tells an org that does not exist from one the caller cannot read', async () => {
  const fl = await world();
  try {
    const ghost = await refusal(fl.files.list({ org: 'ghost', as: 'mallory' }));
    assert.deepEqual(ghost, { status: 404, code: 'not_found', reason: 'unknown_org' });
    const acme = await fl.files.list({ org: 'acme', as: 'mallory' });
    assert.deepEqual(acme.files, []);
  } finally {
    await fl.close();
  }
});
