/**
 * MALFORMED INPUT LEAVES AS invalid_argument, since 0.37.1 (LIMITATIONS 19
 * until then).
 *
 * One row per public entry point that takes text, with the inputs a typed call
 * never sends: a NUL byte, an object where a string goes, a duration too large
 * to be a date, a non-string secret. Each must come back as a FilelayerError
 * whose own enumerable fields and JSON carry no SQL text and no internal id.
 * Before 0.37.1 most of these were raw Postgres errors with the statement in
 * `query` and the project's id in `params`, or a bare RangeError or TypeError.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Filelayer } from '../src/filelayer.ts';
import { FilelayerError } from '../src/errors.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);
const NUL = 'a\u0000b';
const OBJ = { toString: () => 'x' } as unknown as string;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SQL = /\b(SELECT|INSERT|UPDATE|DELETE)\b/;

type World = { fl: Filelayer; fileId: string };

async function world(): Promise<World> {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  const f = await fl.files.put(utf8('plan'), { org: 'acme', owner: 'alice', name: 'plan.txt' });
  return { fl, fileId: f.id };
}

const rows: Array<[string, (w: World) => Promise<unknown>]> = [
  ['files.put with a NUL in name', ({ fl }) => fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: NUL })],
  ['files.put with a NUL in a metadata value', ({ fl }) =>
    fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: 'x', metadata: { k: NUL } })],
  ['files.put with a NUL in owner', ({ fl }) => fl.files.put(utf8('x'), { owner: NUL, name: 'x' })],
  ['files.put with a NUL in org', ({ fl }) => fl.files.put(utf8('x'), { org: NUL, owner: 'alice', name: 'x' })],
  ['files.put with an object as owner', ({ fl }) => fl.files.put(utf8('x'), { owner: OBJ, name: 'x' })],
  ['files.put with expiresIn too large for a date', ({ fl }) =>
    fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: 'x', expiresIn: 1e20 })],
  ['files.list with a NUL in org', ({ fl }) => fl.files.list({ org: NUL, as: 'alice' })],
  ['files.list with a NUL in as', ({ fl }) => fl.files.list({ org: 'acme', as: NUL })],
  ['files.list with an object as org', ({ fl }) => fl.files.list({ org: OBJ, as: 'alice' })],
  ['files.get with a NUL in the id', ({ fl }) => fl.files.get(NUL, { as: 'alice' })],
  ['orgs.create with a NUL in the id', ({ fl }) => fl.orgs.create(NUL, { owner: 'alice' })],
  ['orgs.create with a NUL in the name', ({ fl }) => fl.orgs.create('other', { owner: 'alice', name: NUL })],
  ['orgs.create with an object as owner', ({ fl }) => fl.orgs.create('other2', { owner: OBJ })],
  ['orgs.setRole with a NUL in the user', ({ fl }) => fl.orgs.setRole('acme', NUL, 'member', { as: 'alice' })],
  ['orgs.setRole with an object as the user', ({ fl }) => fl.orgs.setRole('acme', OBJ, 'member', { as: 'alice' })],
  ['orgs.removeMember with a NUL in the user', ({ fl }) => fl.orgs.removeMember('acme', NUL, { as: 'alice' })],
  ['orgs.audit with a NUL in user', ({ fl }) => fl.orgs.audit('acme', { as: 'alice', user: NUL })],
  ['orgs.audit with a NUL in action', ({ fl }) => fl.orgs.audit('acme', { as: 'alice', action: NUL as never })],
  ['orgs.audit with an object as user', ({ fl }) => fl.orgs.audit('acme', { as: 'alice', user: OBJ })],
  ['shares.create with a NUL in withUser', ({ fl, fileId }) => fl.shares.create(fileId, { as: 'alice', withUser: NUL })],
  ['shares.create with a NUL in idempotencyKey', ({ fl, fileId }) =>
    fl.shares.create(fileId, { as: 'alice', idempotencyKey: NUL } as never)],
  ['shares.create with a number as password', ({ fl, fileId }) =>
    fl.shares.create(fileId, { as: 'alice', password: 5 as never } as never)],
  ['shares.create with expiresIn too large for a date', ({ fl, fileId }) =>
    fl.shares.create(fileId, { as: 'alice', expiresIn: 1e20 } as never)],
  ['shares.unshare with a NUL in the user', ({ fl, fileId }) => fl.shares.unshare(fileId, { as: 'alice', user: NUL })],
  ['shares.redeem with a number', ({ fl }) => fl.shares.redeem(5 as never)],
  ['shares.redeem with null', ({ fl }) => fl.shares.redeem(null as never)],
  ['shares.redeem with an object', ({ fl }) => fl.shares.redeem({} as never)],
  ['shares.redeem with a NUL', ({ fl }) => fl.shares.redeem(NUL)],
  ['ids.actorId with a NUL', ({ fl }) => fl.ids.actorId(NUL)],
  ['ids.orgId with an object', ({ fl }) => fl.ids.orgId(OBJ)],
  ['ids.ensureActor with a NUL', ({ fl }) => fl.ids.ensureActor(NUL)],
];

for (const [name, call] of rows) {
  test(`${name}: a FilelayerError with no SQL and no internal id`, async () => {
    const w = await world();
    try {
      let err: unknown = null;
      try {
        await call(w);
      } catch (e) {
        err = e;
      }
      if (err === null) {
        console.log(`ACCEPTED: ${name}`);
        return;
      }
      assert.ok(err instanceof FilelayerError, `got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
      const own = Object.keys(err);
      assert.ok(!own.includes('query') && !own.includes('params'), `enumerable fields: ${own.join(', ')}`);
      const shown = JSON.stringify(err) + String((err as FilelayerError).reason ?? '');
      assert.doesNotMatch(shown, SQL);
      assert.doesNotMatch(shown, UUID);
    } finally {
      await w.fl.close();
    }
  });
}

test('reason is not enumerable and not in JSON, and is still readable', async () => {
  const w = await world();
  try {
    let err: FilelayerError | null = null;
    try {
      await w.fl.files.put(utf8('x'), { org: 'ghost', owner: 'mallory', name: 'x' });
    } catch (e) {
      err = e as FilelayerError;
    }
    assert.ok(err);
    assert.equal(err.reason, 'unknown_org');
    assert.ok(!Object.keys(err).includes('reason'));
    assert.deepEqual(JSON.parse(JSON.stringify(err)), { name: 'FilelayerError', status: 404, code: 'not_found', message: 'not_found' });
    assert.ok(!('reason' in { ...err }));
  } finally {
    await w.fl.close();
  }
});
