/**
 * READING THE TRAIL WITHOUT A STORAGE ADAPTER, AND BEING NO MORE TRUSTED FOR IT.
 *
 * `auditReader(db)` exists because the three audit reads touch storage zero
 * times, so requiring an adapter was an artefact of where the methods lived.
 * The risk in a narrower object is that it is also a weaker one -- that
 * "fewer dependencies" quietly becomes "fewer checks" -- so this suite holds
 * the two halves apart:
 *
 *   1. it works with a `Queryable` and nothing else, and
 *   2. it authorizes and records exactly as a `Filelayer` does.
 *
 * The second is the one worth having. A reader that skipped `read_audit`, or
 * that read without leaving the `audit.read` event 0.27.0 added, would be a
 * hole opened by a convenience -- which is the shape of the privilege
 * escalation this project nearly shipped in 0.28.0 through a lookup helper.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditReader } from '../src/audit-read.ts';
import { Filelayer } from '../src/index.ts';

/** A tenant with a file, an admin, a plain member and a second tenant. */
async function scenario() {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  await fl.orgs.setRole('acme', 'mallory', 'member', { as: 'alice' });
  await fl.orgs.create('other', { owner: 'bob' });
  const { id } = await fl.files.put(new TextEncoder().encode('q3'), {
    org: 'acme',
    owner: 'alice',
    name: 'q3.pdf',
  });
  const ids = {
    alice: await fl.ids.ensureActor('alice'),
    mallory: await fl.ids.ensureActor('mallory'),
    bob: await fl.ids.ensureActor('bob'),
    acme: (await fl.ids.orgId('acme'))!,
    other: (await fl.ids.orgId('other'))!,
  };
  return { fl, id, ids };
}

describe('auditReader: a database and nothing else', () => {
  it('reads the trail with no storage adapter in sight', async () => {
    const { fl, ids } = await scenario();
    // THE POINT OF THE WHOLE FILE: the only argument is the connection. No
    // adapter, no provider string, nothing that would claim to hold bytes.
    const audit = auditReader(fl.store.db);
    const rows = await audit.log({ actorId: ids.alice }, ids.acme);
    assert.ok(rows.length > 0, 'the trail came back empty');
    // The action names are READ OFF A RUN, not guessed. The first draft of this
    // asserted `file.put` and `org.create`, which are the facade's method names
    // and not what the engine records: it writes `file.create` and
    // `member.bootstrap`. A test that invents the vocabulary it checks is
    // testing the author's memory.
    assert.ok(
      rows.some((e) => e.action === 'file.create'),
      `the seeded work is not in the trail; saw ${[...new Set(rows.map((e) => e.action))].join(', ')}`,
    );
  });

  it('verifies the chain and lists checkpoints', async () => {
    const { fl, ids } = await scenario();
    const audit = auditReader(fl.store.db);
    const chain = await audit.verify({ actorId: ids.alice }, ids.acme);
    // `valid`, not `ok` -- also read off a run rather than assumed.
    assert.equal(chain.valid, true, 'the chain did not verify through the reader');
    assert.ok(Array.isArray(await audit.checkpoints({ actorId: ids.alice }, ids.acme)));
  });

  it('is NOT more trusting than a Filelayer: a member without read_audit is denied', async () => {
    const { fl, ids } = await scenario();
    const audit = auditReader(fl.store.db);
    await assert.rejects(
      () => audit.log({ actorId: ids.mallory }, ids.acme),
      (e: Error & { code?: string }) => e.code === 'not_found',
      'a plain member read the trail through the narrow reader',
    );
  });

  it('refuses a cross-tenant read', async () => {
    const { fl, ids } = await scenario();
    const audit = auditReader(fl.store.db);
    await assert.rejects(
      () => audit.log({ actorId: ids.bob }, ids.acme),
      (e: Error & { code?: string }) => e.code === 'not_found',
      "another tenant's owner read acme's trail",
    );
  });

  it('records the read, exactly as the long path does', async () => {
    const { fl, ids } = await scenario();
    const audit = auditReader(fl.store.db);
    const before = await audit.log({ actorId: ids.alice }, ids.acme);
    const after = await audit.log({ actorId: ids.alice }, ids.acme);
    assert.equal(
      after.length,
      before.length + 1,
      'the reader read without leaving an audit.read event, so the narrow door ' +
        'is a way around what 0.27.0 added',
    );
    assert.ok(after.some((e) => e.action === 'audit.read'));
  });

  it('attributes the read, and carries the audit context', async () => {
    const { fl, ids } = await scenario();
    const audit = auditReader(fl.store.db);
    const AGENT = 'filelayer-cli/0.0.0 (operator)';
    await audit.log({ actorId: ids.alice, userAgent: AGENT }, ids.acme, { limit: 10 });
    const rows = await audit.log({ actorId: ids.alice }, ids.acme);
    const stamped = rows.filter((e) => e.action === 'audit.read' && e.userAgent === AGENT);
    assert.equal(stamped.length, 1, 'exactly the one read made with a label should carry it');
    assert.deepEqual((stamped[0]!.context as { filter?: unknown }).filter, { limit: 10 });
  });

  it('a denied read is recorded too, so an attempt is not invisible', async () => {
    const { fl, ids } = await scenario();
    const audit = auditReader(fl.store.db);
    await assert.rejects(() => audit.log({ actorId: ids.mallory }, ids.acme));
    const rows = await audit.log({ actorId: ids.alice }, ids.acme);
    assert.ok(
      rows.some((e) => e.decision === 'deny' && e.action === 'audit.read'),
      "mallory's refused attempt left no trace",
    );
  });
});
