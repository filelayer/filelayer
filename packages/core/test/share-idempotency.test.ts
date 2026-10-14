/**
 * A RETRIED SHARE IS NOT A SECOND SHARE.
 *
 * `share()` inserts a grant row on every call, which is correct and was a trap.
 * Two calls carrying `expiresIn` are two legitimately different windows, so the
 * engine cannot dedupe on its own -- and the consequence, disclosed in
 * LIMITATIONS entry 2 from the beginning, is that a double-clicked share button
 * gives one reader two grants and `revoke()` on the id the caller is holding
 * leaves the other live. The caller believes access was withdrawn.
 *
 * Disclosing it for thirty releases did not stop anyone walking into it, so
 * `idempotencyKey` exists. This suite holds three things apart:
 *
 *   1. the trap is real -- asserted directly, so the fix has something to beat;
 *   2. the key closes it, and a replay returns the ORIGINAL window rather than
 *      a fresh one;
 *   3. a key reused for a DIFFERENT subject is REFUSED. That is the case where
 *      a convenience feature could become a confused deputy: returning the
 *      stored grant because its key matched would report that this subject has
 *      access when the row belongs to another one.
 *
 * The third is the one worth having. The first two are a feature working.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FilelayerError } from '../src/errors.ts';
import { Filelayer } from '../src/index.ts';

async function scenario() {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'alice' });
  await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
  await fl.orgs.setRole('acme', 'carol', 'member', { as: 'alice' });
  const { id } = await fl.files.put(new TextEncoder().encode('contract'), {
    org: 'acme',
    owner: 'alice',
    name: 'contract.pdf',
  });
  return { fl, fileId: id };
}

describe('a retried share', () => {
  it('WITHOUT a key, inserts twice -- and revoking one leaves access live', async () => {
    const { fl, fileId } = await scenario();

    // The double-clicked button, exactly.
    const first = await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });
    const second = await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });
    assert.notEqual(first.grantId, second.grantId, 'two calls, two grants');

    // And here is the trap: the caller revokes the id they are holding and
    // believes Bob is out.
    await fl.shares.revoke(first.grantId, { as: 'alice' });
    const still = await fl.files.get(fileId, { as: 'bob' });
    assert.ok(still, 'bob can still read -- this is the defect, asserted');
  });

  it('WITH a key, returns the same grant and inserts nothing', async () => {
    const { fl, fileId } = await scenario();

    const first = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      expiresIn: 3600,
      idempotencyKey: 'req-7f3a',
    });
    const retry = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      expiresIn: 3600,
      idempotencyKey: 'req-7f3a',
    });

    assert.equal(retry.grantId, first.grantId, 'one act of sharing, one grant');
    assert.equal(retry.replayed, true, 'and the caller is told it was a replay');
    assert.notEqual(first.replayed, true, 'the first call was not');

    // Revoking the one grant now actually removes access, which is the whole
    // point of the key.
    await fl.shares.revoke(first.grantId, { as: 'alice' });
    await assert.rejects(() => fl.files.get(fileId, { as: 'bob' }), /not_found/);
  });

  it('does not extend the window on a replay', async () => {
    const { fl, fileId } = await scenario();

    const first = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      expiresIn: 60,
      idempotencyKey: 'req-window',
    });
    // A retry asking for a LONGER life must not get one. An idempotent call
    // returns what happened, not what was asked for the second time.
    const retry = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      expiresIn: 60,
      idempotencyKey: 'req-window',
    });

    assert.deepEqual(retry.expiresAt, first.expiresAt, 'the original expiry, unchanged');
  });

  it('REFUSES a key reused for a different subject', async () => {
    const { fl, fileId } = await scenario();

    await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: 'share-this-file',
    });

    // The dangerous case. A key derived from the FILE rather than from the
    // request collides across recipients, and resolving the collision by
    // returning the stored grant would tell the caller Carol has access.
    await assert.rejects(
      () =>
        fl.shares.create(fileId, {
          as: 'alice',
          withUser: 'carol',
          idempotencyKey: 'share-this-file',
        }),
      (err: unknown) => {
        assert.ok(err instanceof FilelayerError);
        assert.equal(err.code, 'idempotency_key_reused');
        assert.equal(err.status, 409);
        return true;
      },
    );

    // And the refusal left Carol with nothing, rather than with Bob's grant.
    await assert.rejects(() => fl.files.get(fileId, { as: 'carol' }), /not_found/);
  });

  it('refuses a key reused for different capabilities', async () => {
    const { fl, fileId } = await scenario();

    await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      capabilities: ['read'],
      idempotencyKey: 'req-caps',
    });

    await assert.rejects(
      () =>
        fl.shares.create(fileId, {
          as: 'alice',
          withUser: 'bob',
          capabilities: ['read', 'share'],
          idempotencyKey: 'req-caps',
        }),
      /idempotency_key_reused/,
    );
  });

  it('treats capabilities as a set, not as an order', async () => {
    const { fl, fileId } = await scenario();

    const first = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      capabilities: ['read', 'share'],
      idempotencyKey: 'req-order',
    });
    // A caller whose retry builds the list in a different order has not asked
    // for anything different, and must not be told they reused a key.
    const retry = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      capabilities: ['share', 'read'],
      idempotencyKey: 'req-order',
    });
    assert.equal(retry.grantId, first.grantId);
    assert.equal(retry.replayed, true);
  });

  it('scopes a key to its file, so the same key shares two files', async () => {
    const { fl, fileId } = await scenario();
    const other = await fl.files.put(new TextEncoder().encode('invoice'), {
      org: 'acme',
      owner: 'alice',
      name: 'invoice.pdf',
    });

    const a = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: 'nightly-sync',
    });
    const b = await fl.shares.create(other.id, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: 'nightly-sync',
    });
    assert.notEqual(a.grantId, b.grantId, 'two files, two grants, one key');
  });

  it('keeps applying after the grant is revoked', async () => {
    const { fl, fileId } = await scenario();

    const first = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: 'req-late',
    });
    await fl.shares.revoke(first.grantId, { as: 'alice' });

    // A retry arriving after the revoke must NOT mint access the caller has
    // already taken away. It returns the revoked grant, which reads as dead.
    const late = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: 'req-late',
    });
    assert.equal(late.grantId, first.grantId);
    assert.equal(late.replayed, true);
    await assert.rejects(() => fl.files.get(fileId, { as: 'bob' }), /not_found/);
  });

  it('refuses an empty key rather than treating it as none', async () => {
    const { fl, fileId } = await scenario();
    // Asserted on `code` and `reason`, not on the message. A FilelayerError's
    // message IS its code -- the precise reason is internal and deliberately
    // not serialized -- and a first draft of this test matched the message
    // against /idempotency_key_empty/ and failed for that reason rather than
    // for the behaviour.
    await assert.rejects(
      () => fl.shares.create(fileId, { as: 'alice', withUser: 'bob', idempotencyKey: '   ' }),
      (err: unknown) => {
        assert.ok(err instanceof FilelayerError);
        assert.equal(err.code, 'invalid_argument');
        assert.equal(err.status, 400);
        assert.equal(err.reason, 'idempotency_key_empty');
        return true;
      },
    );
  });

  it('trims, so a stray space is not a second key', async () => {
    const { fl, fileId } = await scenario();
    const first = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: 'req-space',
    });
    const retry = await fl.shares.create(fileId, {
      as: 'alice',
      withUser: 'bob',
      idempotencyKey: '  req-space  ',
    });
    assert.equal(retry.grantId, first.grantId);
  });

  it('records the replay without claiming a second grant was created', async () => {
    const { fl, fileId } = await scenario();

    await fl.shares.create(fileId, { as: 'alice', withUser: 'bob', idempotencyKey: 'req-audit' });
    await fl.shares.create(fileId, { as: 'alice', withUser: 'bob', idempotencyKey: 'req-audit' });

    const log = await fl.orgs.audit('acme', { as: 'alice', action: 'grant.create' });
    const replays = log.filter((e) => (e.context as Record<string, unknown>)?.replayed === true);
    assert.equal(replays.length, 1, 'the retry is on the record');

    // P5 wants the decision recorded. What it must not say is that two grants
    // exist, because one does.
    const grantIds = new Set(log.map((e) => e.grantId));
    assert.equal(grantIds.size, 1, 'both events name the one grant');
  });
});

describe('revoke() reports what access remains', () => {
  it('says the person can still read when a second grant survives', async () => {
    const { fl, fileId } = await scenario();

    const first = await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });
    await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });

    const result = await fl.shares.revoke(first.grantId, { as: 'alice' });
    assert.equal(result.subjectType, 'actor');
    assert.equal(
      result.subjectCanStillRead,
      true,
      'the trap, now visible in the answer instead of only in an audit later',
    );
  });

  it('says they cannot once the last grant is gone', async () => {
    const { fl, fileId } = await scenario();
    const only = await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });

    const result = await fl.shares.revoke(only.grantId, { as: 'alice' });
    assert.equal(result.subjectCanStillRead, false);
    await assert.rejects(() => fl.files.get(fileId, { as: 'bob' }), /not_found/);
  });

  it('counts a ROLE grant that a row count would have missed', async () => {
    const { fl, fileId } = await scenario();

    // Bob reaches this file two ways: a direct share, and every member of acme.
    const direct = await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });
    await fl.shares.create(fileId, { as: 'alice', withOrg: 'acme' });

    const result = await fl.shares.revoke(direct.grantId, { as: 'alice' });
    // No grant NAMING bob remains, so counting rows by subject would say zero
    // and imply he is out. He is not: the org grant resolves through his
    // membership at request time.
    assert.equal(result.subjectCanStillRead, true);
    assert.ok(await fl.files.get(fileId, { as: 'bob' }));
  });

  it('answers null for a link, because there is no person to ask about', async () => {
    const { fl, fileId } = await scenario();
    const link = await fl.shares.create(fileId, { as: 'alice', expiresIn: 3600 });

    const result = await fl.shares.revoke(link.grantId, { as: 'alice' });
    assert.equal(result.subjectType, 'link');
    assert.equal(
      result.subjectCanStillRead,
      null,
      'not false: false would read as "nobody can get in now", which is a different claim',
    );
  });

  it('does not put a read event on the chain for the probe', async () => {
    const { fl, fileId } = await scenario();
    const only = await fl.shares.create(fileId, { as: 'alice', withUser: 'bob' });
    await fl.shares.revoke(only.grantId, { as: 'alice' });

    // The probe asks the engine whether bob could read. Bob asked for nothing,
    // so the trail must not say he tried.
    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const bobId = await fl.ids.ensureActor('bob');
    const bobReads = log.filter((e) => e.action === 'file.read' && e.actorId === bobId);
    assert.equal(bobReads.length, 0, 'an audit trail that invents attempts is worse than none');
  });
});
