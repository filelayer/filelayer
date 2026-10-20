/**
 * DOUBLE-SUBMIT PROTECTION, AND THE LINE IT MUST NOT CROSS.
 *
 * `share()` inserted a grant on every call. The consequence — one recipient
 * holding several grants, `revoke()` on the id you happen to be holding
 * leaving the others live — was disclosed from the beginning and people walked
 * into it anyway, because the thing that produces it is a button and whoever
 * wires a button up does not read a limitations file. `idempotencyKey` was the
 * answer and it only helps a caller who already knows.
 *
 * So the common case got a default. It is a NARROWER promise than idempotency
 * and this suite is mostly about the narrowness:
 *
 *   1. It collapses an identical repeat, within a short window, for subjects
 *      that NAME somebody.
 *   2. It NEVER collapses a `link`. A link grant carries a secret: the grant
 *      is a URL, two of them are two URLs, and merging them would hand the
 *      second recipient the first one's link and make one revoke cut off both.
 *      That is a worse defect than the one being fixed, and a silent one.
 *   3. It is bounded in time, so "share with Bob again next month" is a new
 *      act rather than a resolution to a grant that has since lapsed.
 *   4. It never resurrects a dead grant. A repeat after a revoke inserts.
 *   5. It does not collide with a caller's own key.
 *
 * Point 2 is the one worth having. The rest is a feature working.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb } from '../src/db.ts';
import { FilelayerError } from '../src/errors.ts';
import {
  AUTO_KEY_PREFIX,
  DOUBLE_SUBMIT_WINDOW_SECONDS,
  Filelayer,
} from '../src/index.ts';
import { MemoryStorage } from '../src/storage.ts';

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost:3000' });
  const alice = (await fl.createActor('alice')).id;
  const bob = (await fl.createActor('bob')).id;
  const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  await fl.addMember({ actorId: alice }, org, bob, 'member');
  const file = await fl.upload({ actorId: alice }, org, {
    name: 'contract.pdf',
    contentType: 'application/pdf',
    body: new TextEncoder().encode('contract'),
  });
  return { fl, db, alice, bob, org, fileId: file.id };
}

const liveGrants = async (fl: Filelayer, alice: string, fileId: string) =>
  (await fl.listGrants({ actorId: alice }, fileId)).filter((g) => g.live !== false);

describe('double-submit protection', () => {
  it('collapses an identical repeat to an ACTOR', async () => {
    const { fl, alice, bob, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, { subject: { type: 'actor', actorId: bob } });
    const b = await fl.share({ actorId: alice }, fileId, { subject: { type: 'actor', actorId: bob } });
    assert.equal(b.grantId, a.grantId);
    assert.equal(b.replayed, true, 'the caller must be told this was not a second act');
    assert.equal((await liveGrants(fl, alice, fileId)).length, 1);
  });

  it('collapses an identical repeat to ANONYMOUS', async () => {
    const { fl, alice, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, { subject: { type: 'anonymous' } });
    const b = await fl.share({ actorId: alice }, fileId, { subject: { type: 'anonymous' } });
    assert.equal(b.grantId, a.grantId);
  });

  // --- the line -------------------------------------------------------------

  it('NEVER collapses a link, and returns two distinct secrets', async () => {
    const { fl, alice, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, { subject: { type: 'link' } });
    const b = await fl.share({ actorId: alice }, fileId, { subject: { type: 'link' } });
    assert.notEqual(b.grantId, a.grantId, 'two link grants were merged into one');
    assert.ok(a.secret && b.secret);
    assert.notEqual(a.secret, b.secret, 'two link shares handed out the SAME secret');
    assert.notEqual(b.replayed, true);
    assert.equal((await liveGrants(fl, alice, fileId)).length, 2);
  });

  it('revoking one link does not cut off the other', async () => {
    // The consequence of the rule above, asserted as an outcome rather than as
    // a row count: this is what a merged link grant would have broken.
    const { fl, alice, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, { subject: { type: 'link' } });
    const b = await fl.share({ actorId: alice }, fileId, { subject: { type: 'link' } });
    await fl.revoke({ actorId: alice }, a.grantId);
    const read = await fl.redeem(b.secret!);
    assert.ok(read, 'revoking one link killed the other');
  });

  // --- the other boundaries -------------------------------------------------

  it('does NOT collapse two different windows', async () => {
    const { fl, alice, bob, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, {
      subject: { type: 'actor', actorId: bob }, expiresIn: 3600,
    });
    const b = await fl.share({ actorId: alice }, fileId, {
      subject: { type: 'actor', actorId: bob }, expiresIn: 7200,
    });
    assert.notEqual(b.grantId, a.grantId);
  });

  it('does NOT collapse two different capability sets', async () => {
    const { fl, alice, bob, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, {
      subject: { type: 'actor', actorId: bob }, capabilities: ['read'],
    });
    const b = await fl.share({ actorId: alice }, fileId, {
      subject: { type: 'actor', actorId: bob }, capabilities: ['read', 'share'],
    });
    assert.notEqual(b.grantId, a.grantId);
  });

  it('does NOT resurrect a revoked grant', async () => {
    // An explicit `idempotencyKey` deliberately keeps applying after a revoke:
    // the caller named an act. A derived key names nothing, so resolving to a
    // revoked grant would report access that does not exist -- the share would
    // look like it worked and nobody would have been given anything.
    const { fl, alice, bob, fileId } = await world();
    const a = await fl.share({ actorId: alice }, fileId, { subject: { type: 'actor', actorId: bob } });
    await fl.revoke({ actorId: alice }, a.grantId);
    const b = await fl.share({ actorId: alice }, fileId, { subject: { type: 'actor', actorId: bob } });
    assert.notEqual(b.grantId, a.grantId, 'a repeat after a revoke returned the dead grant');
    assert.ok(await fl.read({ actorId: bob }, fileId), 'the re-share granted nothing');
  });

  it('is bounded in time', async () => {
    // Asserted against the stored key rather than by waiting a minute: the key
    // carries the bucket, so a window that was not bounded would be visible as
    // a key with no bucket in it.
    const { fl, db, alice, bob, fileId } = await world();
    await fl.share({ actorId: alice }, fileId, { subject: { type: 'actor', actorId: bob } });
    const { rows } = await db.query<{ idempotency_key: string | null }>(
      `SELECT idempotency_key FROM file_grant WHERE file_id = $1 AND subject_type = 'actor'`,
      [fileId],
    );
    const key = rows[0]!.idempotency_key;
    assert.ok(key !== null && key.startsWith(AUTO_KEY_PREFIX), `derived key missing: ${key}`);
    const bucket = Number(key.slice(key.lastIndexOf(':') + 1));
    const expected = Math.floor(Date.now() / (DOUBLE_SUBMIT_WINDOW_SECONDS * 1000));
    assert.ok(
      Math.abs(bucket - expected) <= 1,
      `the key's bucket (${bucket}) is not this window (${expected}); the dedupe is unbounded`,
    );
  });

  it('refuses a caller key in the reserved namespace rather than rewriting it', async () => {
    // Silently namespacing somebody's identifier would make a retry under the
    // same key stop matching, which is the one thing an idempotency key must
    // not do.
    const { fl, alice, bob, fileId } = await world();
    await assert.rejects(
      () =>
        fl.share({ actorId: alice }, fileId, {
          subject: { type: 'actor', actorId: bob },
          idempotencyKey: `${AUTO_KEY_PREFIX}mine`,
        }),
      (e: unknown) => e instanceof FilelayerError && e.code === 'invalid_argument',
    );
  });

  it('leaves an explicit key in charge', async () => {
    // A caller who supplies a key gets idempotency, not double-submit
    // protection: the stored key is theirs, and it keeps applying after a
    // revoke, which the derived one must not.
    const { fl, db, alice, bob, fileId } = await world();
    await fl.share({ actorId: alice }, fileId, {
      subject: { type: 'actor', actorId: bob },
      idempotencyKey: 'req-42',
    });
    const { rows } = await db.query<{ idempotency_key: string | null }>(
      `SELECT idempotency_key FROM file_grant WHERE file_id = $1 AND subject_type = 'actor'`,
      [fileId],
    );
    assert.equal(rows[0]!.idempotency_key, 'req-42');
  });
});
