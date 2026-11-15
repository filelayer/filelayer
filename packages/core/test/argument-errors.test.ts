/**
 * THE MISTAKES A FIRST USER MAKES, AND WHAT THEY GET BACK.
 *
 * A cold first-user run against 0.35.2 (2026-11-11) found five mistakes that
 * came back as a raw JavaScript error naming none of what went wrong, and a
 * misspelled option that was silently ignored. Since 0.36.0 each is
 * `invalid_argument` (400), and `reason` names the argument and the fix. The
 * enumerated arguments (role, visibility, capabilities) are checked the same
 * way instead of reaching the schema's CHECK constraint.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../src/db.ts';
import { FilelayerError } from '../src/errors.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { bytes } from './helpers.ts';

async function invalid(fn: () => unknown, reason: RegExp) {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof FilelayerError, `expected invalid_argument, got ${String(err)}`);
  assert.equal(err.code, 'invalid_argument', `got ${err.code} (${err.reason})`);
  assert.equal(err.status, 400);
  assert.match(String(err.reason), reason);
}

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://x' });
  await fl.orgs.create('acme', { owner: 'alice' });
  return { db, fl };
}

describe('constructor arguments', () => {
  it('no arguments at all', async () => {
    // @ts-expect-error the mistake under test
    await invalid(() => new Filelayer(), /db must be a pg\.Pool/);
  });

  it('a connection string where the pool goes', async () => {
    await invalid(
      () => new Filelayer('postgres://u:p@h/db' as never, new MemoryStorage()),
      /Pass a pg\.Pool, not a connection string/,
    );
  });

  it('no storage adapter', async () => {
    const { db } = await createTestDb();
    await invalid(() => new Filelayer(db, undefined as never), /storage must be a storage adapter/);
  });

  it('a misspelled option is refused, with the right name', async () => {
    const { db } = await createTestDb();
    await invalid(
      () => new Filelayer(db, new MemoryStorage(), { baseURL: 'http://x' } as never),
      /unknown option "baseURL"; did you mean "baseUrl"\?/,
    );
  });

  it('baseUrl without a scheme', async () => {
    const { db } = await createTestDb();
    await invalid(
      () => new Filelayer(db, new MemoryStorage(), { baseUrl: 'app.example.com' }),
      /baseUrl must be an absolute http\(s\) URL/,
    );
  });

  it('a correct construction still works', async () => {
    const { db } = await createTestDb();
    new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://app.example.com', maxUploadBytes: 10 });
  });
});

describe('call arguments', () => {
  it('files.put with a string body', async () => {
    const { fl } = await world();
    await invalid(() => fl.files.put('hello' as never, { org: 'acme', owner: 'alice' }), /body is a string/);
  });

  it('orgs.setRole with no options object', async () => {
    const { fl } = await world();
    // @ts-expect-error the mistake under test
    await invalid(() => fl.orgs.setRole('acme', 'bob', 'member'), /orgs\.setRole needs \{ as:/);
  });

  it('a role outside the set', async () => {
    const { fl } = await world();
    await invalid(
      () => fl.orgs.setRole('acme', 'bob', 'editor' as never, { as: 'alice' }),
      /role must be one of viewer, member, admin, owner, got "editor"/,
    );
  });

  it('a visibility outside the set', async () => {
    const { fl } = await world();
    await invalid(
      () => fl.files.put(bytes('x'), { org: 'acme', owner: 'alice', visibility: 'public' as never }),
      /visibility must be one of private, org, got "public"/,
    );
  });

  it('a capability outside the set', async () => {
    const { fl } = await world();
    const f = await fl.files.put(bytes('x'), { org: 'acme', owner: 'alice' });
    await invalid(
      () => fl.shares.create(f.id, { as: 'alice', withUser: 'bob', capabilities: ['admin' as never] }),
      /capabilities must be one of read, write, delete, share, got "admin"/,
    );
  });

  it('a refused visibility leaves no file behind', async () => {
    const { db, fl } = await world();
    await invalid(
      () => fl.files.put(bytes('x'), { org: 'acme', owner: 'alice', visibility: 'public' as never }),
      /visibility/,
    );
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM file');
    assert.equal(Number(rows[0]!.n), 0);
  });
});
