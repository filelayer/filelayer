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

type World = { fl: Filelayer; fileId: string; alice: { actorId: string }; acmeId: string };

async function world(): Promise<World> {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  const f = await fl.files.put(utf8('plan'), { org: 'acme', owner: 'alice', name: 'plan.txt' });
  const alice = { actorId: (await fl.ids.actorId('alice'))! };
  return { fl, fileId: f.id, alice, acmeId: (await fl.ids.orgId('acme'))! };
}

// [name, call, expected code]. Every row must be REFUSED with that code: a row
// that is accepted fails, so a value nobody checks cannot pass by being taken.
const IA = 'invalid_argument';
const NF = 'not_found';
const rows: Array<[string, (w: World) => Promise<unknown>, string]> = [
  // The facade.
  ['files.put with a NUL in name', ({ fl }) => fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: NUL }), IA],
  ['files.put with a NUL in a metadata value', ({ fl }) =>
    fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: 'x', metadata: { k: NUL } }), IA],
  ['files.put with a NUL in owner', ({ fl }) => fl.files.put(utf8('x'), { owner: NUL, name: 'x' }), IA],
  ['files.put with a NUL in org', ({ fl }) => fl.files.put(utf8('x'), { org: NUL, owner: 'alice', name: 'x' }), IA],
  ['files.put with an object as owner', ({ fl }) => fl.files.put(utf8('x'), { owner: OBJ, name: 'x' }), IA],
  ['files.put with expiresIn too large for a date', ({ fl }) =>
    fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: 'x', expiresIn: 1e20 }), IA],
  ['files.list with a NUL in org', ({ fl }) => fl.files.list({ org: NUL, as: 'alice' }), IA],
  ['files.list with a NUL in as', ({ fl }) => fl.files.list({ org: 'acme', as: NUL }), IA],
  ['files.list with an object as org', ({ fl }) => fl.files.list({ org: OBJ, as: 'alice' }), IA],
  ['files.get with a NUL in the id', ({ fl }) => fl.files.get(NUL, { as: 'alice' }), NF],
  ['files.delete with a NUL in the id', ({ fl }) => fl.files.delete(NUL, { as: 'alice' }), NF],
  ['files.delete with an object as the id', ({ fl }) => fl.files.delete(OBJ, { as: 'alice' }), NF],
  ['orgs.create with a NUL in the id', ({ fl }) => fl.orgs.create(NUL, { owner: 'alice' }), IA],
  ['orgs.create with a NUL in the name', ({ fl }) => fl.orgs.create('other', { owner: 'alice', name: NUL }), IA],
  ['orgs.create with an object as owner', ({ fl }) => fl.orgs.create('other2', { owner: OBJ }), IA],
  ['orgs.setRole with a NUL in the user', ({ fl }) => fl.orgs.setRole('acme', NUL, 'member', { as: 'alice' }), IA],
  ['orgs.setRole with an object as the user', ({ fl }) => fl.orgs.setRole('acme', OBJ, 'member', { as: 'alice' }), IA],
  ['orgs.setRole with an empty user', ({ fl }) => fl.orgs.setRole('acme', '', 'member', { as: 'alice' }), IA],
  ['orgs.removeMember with a NUL in the user', ({ fl }) => fl.orgs.removeMember('acme', NUL, { as: 'alice' }), IA],
  ['orgs.audit with a NUL in user', ({ fl }) => fl.orgs.audit('acme', { as: 'alice', user: NUL }), IA],
  ['orgs.audit with a NUL in action', ({ fl }) => fl.orgs.audit('acme', { as: 'alice', action: NUL as never }), IA],
  ['orgs.audit with an object as user', ({ fl }) => fl.orgs.audit('acme', { as: 'alice', user: OBJ }), IA],
  ['shares.create with a NUL in withUser', ({ fl, fileId }) => fl.shares.create(fileId, { as: 'alice', withUser: NUL }), IA],
  ['shares.create with a NUL in idempotencyKey', ({ fl, fileId }) =>
    fl.shares.create(fileId, { as: 'alice', idempotencyKey: NUL } as never), IA],
  ['shares.create with a number as password', ({ fl, fileId }) =>
    fl.shares.create(fileId, { as: 'alice', password: 5 as never } as never), IA],
  ['shares.create with expiresIn too large for a date', ({ fl, fileId }) =>
    fl.shares.create(fileId, { as: 'alice', expiresIn: 1e20 } as never), IA],
  ['shares.unshare with a NUL in the user', ({ fl, fileId }) => fl.shares.unshare(fileId, { as: 'alice', user: NUL }), IA],
  ['shares.revoke with a NUL in the grant id', ({ fl }) => fl.shares.revoke(NUL, { as: 'alice' }), NF],
  ['shares.redeem with a number', ({ fl }) => fl.shares.redeem(5 as never), IA],
  ['shares.redeem with null', ({ fl }) => fl.shares.redeem(null as never), IA],
  ['shares.redeem with an object', ({ fl }) => fl.shares.redeem({} as never), IA],
  ['shares.redeem with a NUL', ({ fl }) => fl.shares.redeem(NUL), NF],
  ['shares.redeem with a number as password', ({ fl }) => fl.shares.redeem('x', { password: 5 as never }), IA],
  ['ids.actorId with a NUL', ({ fl }) => fl.ids.actorId(NUL), IA],
  ['ids.orgId with an object', ({ fl }) => fl.ids.orgId(OBJ), IA],
  ['ids.ensureActor with a NUL', ({ fl }) => fl.ids.ensureActor(NUL), IA],
  // The core class, called directly: these go through no facade method, so
  // only the guard on Filelayer.prototype stands between them and a raw error.
  ['core upload with a NUL in name', ({ fl, alice, acmeId }) =>
    fl.upload(alice, acmeId, { name: NUL, contentType: 'text/plain', body: utf8('x') } as never), IA],
  ['core auditLog with a NUL in action', ({ fl, alice, acmeId }) => fl.auditLog(alice, acmeId, { action: NUL as never }), IA],
  ['core share with a NUL in idempotencyKey', ({ fl, alice, fileId }) =>
    fl.share(alice, fileId, { subject: { type: 'link' }, idempotencyKey: NUL } as never), IA],
  ['core read with a NUL in the id', ({ fl, alice }) => fl.read(alice, NUL), NF],
  ['core delete with a NUL in the id', ({ fl, alice }) => fl.delete(alice, NUL), NF],
  ['core revoke with a NUL in the grant id', ({ fl, alice }) => fl.revoke(alice, NUL), NF],
];

for (const [name, call, expected] of rows) {
  test(`${name}: ${expected}, with no SQL and no internal id`, async () => {
    const w = await world();
    try {
      let err: unknown = null;
      try {
        await call(w);
      } catch (e) {
        err = e;
      }
      assert.ok(err !== null, 'refused, not accepted');
      assert.ok(err instanceof FilelayerError, `got ${(err as Error)?.constructor?.name}: ${(err as Error)?.message}`);
      assert.equal(err.code, expected);
      const own = Object.keys(err);
      assert.ok(!own.includes('query') && !own.includes('params') && !own.includes('cause'), `enumerable fields: ${own.join(', ')}`);
      const shown = JSON.stringify(err) + String(err.reason ?? '');
      assert.doesNotMatch(shown, SQL);
      assert.doesNotMatch(shown, UUID);
    } finally {
      await w.fl.close();
    }
  });
}

test('a database error mapped by the guard keeps the original as a non-enumerable cause, for the server log', async () => {
  const w = await world();
  try {
    let err: FilelayerError | null = null;
    try {
      await w.fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: NUL });
    } catch (e) {
      err = e as FilelayerError;
    }
    assert.ok(err);
    assert.equal(err.code, 'invalid_argument');
    const cause = (err as { cause?: { code?: string } }).cause;
    assert.ok(cause, 'the original error is there for the operator');
    assert.match(String(cause.code), /^22/);
    assert.ok(!Object.keys(err).includes('cause'));
    assert.ok(!JSON.stringify(err).includes('cause'));
  } finally {
    await w.fl.close();
  }
});

test('a projectId that is not a uuid is refused at construction, not reported as every caller\'s bad argument', async () => {
  const { createTestDb } = await import('../src/db.ts');
  const { MemoryStorage } = await import('../src/storage.ts');
  const { db } = await createTestDb();
  try {
    assert.throws(() => new Filelayer(db, new MemoryStorage(), { projectId: 'acme' }), /projectId must be a project id/);
  } finally {
    await (db as { close?: () => Promise<void> }).close?.();
  }
});

test('a TypeError from the storage adapter is not reported as the caller\'s invalid_argument', async () => {
  const { createTestDb } = await import('../src/db.ts');
  const { MemoryStorage } = await import('../src/storage.ts');
  const { db } = await createTestDb();
  const storage = new MemoryStorage();
  (storage as unknown as { put: () => never }).put = () => {
    const e = new TypeError('adapter bug') as TypeError & { code?: string };
    e.code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  };
  const fl = new Filelayer(db, storage, { baseUrl: 'http://x' });
  try {
    await fl.orgs.create('acme', { owner: 'alice' });
    await assert.rejects(
      fl.files.put(utf8('x'), { org: 'acme', owner: 'alice', name: 'x' }),
      (e: unknown) => !(e instanceof FilelayerError && e.code === 'invalid_argument'),
    );
  } finally {
    await fl.close();
  }
});

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
