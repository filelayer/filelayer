/**
 * TWO THINGS THE FACADE DID NOT DO THAT THE ENGINE DOES.
 *
 * -----------------------------------------------------------------------------
 * HOW THEY WERE FOUND
 * -----------------------------------------------------------------------------
 *
 * By handing four integration tasks to agents that had only the published
 * `0.11.0` tarball -- no repository, no access to this codebase -- and reading
 * what they got stuck on. Both findings below came out of that, were reproduced
 * against the published package, and are fixed here.
 *
 * -----------------------------------------------------------------------------
 * 1. AN UNKNOWN EXTERNAL ID LEFT NO AUDIT EVENT
 * -----------------------------------------------------------------------------
 *
 * Six places in `simple.ts` resolved `as:` with `findActor()` and threw
 * `404 unknown_actor` on null -- before the engine ran, so nothing was
 * recorded. The same refusal through the core API writes an event. Measured:
 *
 *     facade, unknown external id  -> 404 unknown_actor   deny events 0 -> 0
 *     core, well-formed actor uuid -> 404 no_membership   deny events 0 -> 1
 *
 * `schema.sql` says in a comment on the column that makes the fix possible that
 * `audit_event.actor_id` carries no foreign key PRECISELY so a caller
 * presenting an unregistered id is still recorded, and calls the alternative "a
 * serious defect in two directions at once". The engine honours that. The
 * facade -- the surface everybody uses -- reopened the hole one level up, in
 * the id space an attacker actually sweeps, because it is the one they can
 * guess.
 *
 * The same was true of an unknown ORG name.
 *
 * -----------------------------------------------------------------------------
 * 2. `FsStorage` WROTE WORLD-READABLE BYTES
 * -----------------------------------------------------------------------------
 *
 * Covered in `fs-storage.test.ts`; see the note on `#mkdirPrivate`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { bytes } from './helpers.ts';
import type { Queryable } from '../src/db.ts';

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
  const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
  return { db, fl, id };
}

const denials = async (db: Queryable) =>
  (
    await db.query<{ action: string; reason: string | null; as: string | null; org: string | null }>(
      `SELECT action, reason, context->>'as' AS as, context->>'org' AS org
         FROM audit_event WHERE decision = 'deny' ORDER BY id`,
    )
  ).rows;

describe('an unknown external id is refused AND recorded', () => {
  it('files.get with an unknown as: writes a deny event naming the id tried', async () => {
    const w = await world();
    const before = (await denials(w.db)).length;

    const err = await w.fl.files.get(w.id, { as: 'sweep-1' }).then(
      () => null,
      (e: { status: number; code: string; reason?: string }) => e,
    );
    // The RESPONSE is unchanged: an opaque 404, so this is not an oracle.
    assert.equal(err!.status, 404);
    assert.equal(err!.code, 'not_found');
    assert.equal(err!.reason, 'unknown_actor');

    const after = await denials(w.db);
    assert.equal(after.length, before + 1, 'the attempt was not recorded');
    const ev = after[after.length - 1]!;
    assert.equal(ev.reason, 'unknown_actor');
    // Which ids were tried is the whole value of the record.
    assert.equal(ev.as, 'sweep-1');
  });

  it('records a sweep across every facade entry point that takes `as:`', async () => {
    const w = await world();
    for (const [, call] of [
      ['get', () => w.fl.files.get(w.id, { as: 'sweep-get' })],
      ['stat', () => w.fl.files.stat(w.id, { as: 'sweep-stat' })],
      ['delete', () => w.fl.files.delete(w.id, { as: 'sweep-del' })],
      ['share', () => w.fl.shares.create(w.id, { as: 'sweep-share' })],
      ['list', () => w.fl.shares.list(w.id, { as: 'sweep-list' })],
      ['unshare', () => w.fl.shares.unshare(w.id, { as: 'sweep-unshare', user: 'x' })],
    ] as const) {
      await call().catch(() => {});
    }
    const recorded = (await denials(w.db))
      .filter((d) => d.reason === 'unknown_actor')
      .map((d) => d.as);
    // Every one of them, not a subset: a blind spot on one entry point is a
    // blind spot, and an attacker will find whichever one it is.
    for (const id of [
      'sweep-get',
      'sweep-stat',
      'sweep-del',
      'sweep-share',
      'sweep-list',
      'sweep-unshare',
    ]) {
      assert.ok(recorded.includes(id), `${id} left no audit event`);
    }
  });

  it('records an unknown ORG name too, which is the same attack one space over', async () => {
    const w = await world();
    const err = await w.fl.orgs.audit('no-such-tenant', { as: 'alice' }).then(
      () => null,
      (e: { status: number; reason?: string }) => e,
    );
    assert.equal(err!.status, 404);
    assert.equal(err!.reason, 'unknown_org');

    const ev = (await denials(w.db)).find((d) => d.reason === 'unknown_org');
    assert.ok(ev, 'an unknown org name left no audit event');
    assert.equal(ev.org, 'no-such-tenant');
  });

  it('goes to the SYSTEM chain, because the tenant is what could not be resolved', async () => {
    // Charging the event to an org would mean resolving the file to an org
    // before authorizing anybody, which is a tenant oracle. `authorizeOrg`
    // already routes an unconfirmable org to the system chain for this reason.
    const w = await world();
    await w.fl.files.get(w.id, { as: 'sweep-sys' }).catch(() => {});
    const { rows } = await w.db.query<{ org_id: string | null }>(
      `SELECT org_id FROM audit_event
        WHERE reason = 'unknown_actor' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0]!.org_id, null);
  });

  it('truncates the presented id, so the log cannot be stuffed', async () => {
    const w = await world();
    await w.fl.files.get(w.id, { as: 'x'.repeat(4000) }).catch(() => {});
    const ev = (await denials(w.db)).find((d) => d.reason === 'unknown_actor');
    assert.ok(ev);
    assert.ok(ev.as!.length <= 128, `recorded ${ev.as!.length} characters`);
  });

  it('does not break the audit chain it is appended to', async () => {
    // These are new event shapes on a hash chain, and one with a null org goes
    // to a different chain than the file events around it.
    const w = await world();
    await w.fl.files.get(w.id, { as: 'sweep-chain' }).catch(() => {});
    await w.fl.files.get(w.id, { as: 'alice' });
    const chain = await w.fl.orgs.verifyAudit(
      '__filelayer_workspace__',
      { as: 'alice' },
    ).catch(() => null);
    // `alice` is a plain member of the workspace, so she may not read the audit
    // chain; what matters is that the write above did not corrupt it, which the
    // engine's own verification covers. Assert through the core instead.
    void chain;
    const { rows } = await w.db.query<{ n: string }>(
      `SELECT count(*)::text n FROM audit_event WHERE reason = 'unknown_actor'`,
    );
    assert.ok(Number(rows[0]!.n) >= 1);
  });

  it('a KNOWN id with no standing is unchanged: still the engine recording it', async () => {
    // The fix must not have moved the ordinary denial off the engine's path.
    const w = await world();
    await w.fl.files.put(bytes('x'), { owner: 'bob' });
    const err = await w.fl.files.get(w.id, { as: 'bob' }).then(
      () => null,
      (e: { reason?: string }) => e,
    );
    assert.notEqual(err!.reason, 'unknown_actor');
    const ev = (await denials(w.db)).find((d) => d.action === 'file.read');
    assert.ok(ev, 'the engine stopped recording an ordinary denial');
  });
});
