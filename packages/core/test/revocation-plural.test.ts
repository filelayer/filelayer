/**
 * A GRANT ID IS NOT A PERSON'S ACCESS.
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT, AND HOW IT WAS FOUND
 * -----------------------------------------------------------------------------
 *
 * `share()` is not idempotent: every call inserts a grant row. `revoke(grantId)`
 * revokes exactly one row. Both are correct in isolation and the combination
 * loses the property this library is sold on.
 *
 * A share endpoint that keeps the `grantId` its last call returned, and revokes
 * that when asked to unshare -- which is the pattern the README's headline
 * example taught -- silently leaves the earlier grant live. The owner is told
 * the revocation succeeded. The recipient keeps reading. Two calls also doubled
 * an effective `maxDownloads: 3` into six deliveries.
 *
 * Found on 4 October 2026 by handing an integration task to an agent that had
 * only the published `0.10.0` tarball: no repository, no access to this
 * codebase, nothing but what `npm install` provides. It grepped for `idempot`,
 * found that `orgs.create` and `completeUpload` are documented as idempotent
 * and `share` is not mentioned either way, wrote a probe, and reported
 * `BOB STILL READS AFTER REVOKING s2`. Reproduced here.
 *
 * The embarrassing part is that `unpublish()` had done the right thing all
 * along -- list, revoke every live anonymous grant, return a count. The plural
 * was understood for the one subject type with no id to hand back. For a named
 * user, the id became the interface and the plural stopped being considered.
 *
 * Every test below fails against the tree before `revokeFor`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { bytes } from './helpers.ts';

async function world() {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'http://localhost' });
  return { db, fl };
}

/** Did the bytes come out? Written as a boolean because that is the question. */
const canRead = async (fl: Filelayer, id: string, as: string): Promise<boolean> => {
  try {
    await fl.files.get(id, { as });
    return true;
  } catch {
    return false;
  }
};

describe('two shares, one revoke: the defect', () => {
  it('share() twice leaves TWO live grants for the same recipient', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    const a = await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
    const b = await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
    assert.notEqual(a.grantId, b.grantId, 'share() deduplicated; this test is stale');
    const live = (await fl.shares.list(id, { as: 'alice' })).filter((g) => g.live);
    assert.equal(live.length, 2);
  });

  it('revoking the id you were handed last does NOT remove access', async () => {
    // The behaviour is retained rather than fixed, because `revoke(grantId)` is
    // doing exactly what it says. What was missing is the operation below it.
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
    const second = await fl.shares.create(id, { as: 'alice', withUser: 'bob' });

    await fl.shares.revoke(second.grantId, { as: 'alice' });
    assert.equal(
      await canRead(fl, id, 'bob'),
      true,
      'if this is now false, revoke() changed and the docs must stop pointing at unshare()',
    );
  });

  it('two grants double an effective download cap', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob', maxDownloads: 3 });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob', maxDownloads: 3 });

    let served = 0;
    for (let i = 0; i < 10; i++) {
      if (!(await canRead(fl, id, 'bob'))) break;
      served++;
    }
    assert.equal(served, 6, 'a cap of 3 served a different number than two grants worth');
  });
});

describe('unshare(): the operation that was missing', () => {
  it('removes access however many share() calls created it', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    for (let i = 0; i < 5; i++) {
      await fl.shares.create(id, { as: 'alice', withUser: 'bob', maxDownloads: 3 });
    }
    assert.equal(await canRead(fl, id, 'bob'), true);

    const { revoked } = await fl.shares.unshare(id, { as: 'alice', user: 'bob' });
    assert.equal(revoked, 5);
    assert.equal(await canRead(fl, id, 'bob'), false, 'access survived unshare()');
  });

  it('is idempotent, so a retried unshare is safe', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob' });

    assert.equal((await fl.shares.unshare(id, { as: 'alice', user: 'bob' })).revoked, 1);
    // The second call is the one a network retry produces. It must not throw.
    assert.equal((await fl.shares.unshare(id, { as: 'alice', user: 'bob' })).revoked, 0);
    assert.equal(await canRead(fl, id, 'bob'), false);
  });

  it('an unknown user is 0 revoked, not a 404', async () => {
    // "Make sure this person cannot read it" is satisfied by their not
    // existing. A 404 here would make the endpoint an identity oracle: a caller
    // could enumerate which user ids the project has seen.
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    const r = await fl.shares.unshare(id, { as: 'alice', user: 'nobody-at-all' });
    assert.equal(r.revoked, 0);
  });

  it('touches nobody else', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
    await fl.shares.create(id, { as: 'alice', withUser: 'carol' });

    await fl.shares.unshare(id, { as: 'alice', user: 'bob' });
    assert.equal(await canRead(fl, id, 'bob'), false);
    assert.equal(await canRead(fl, id, 'carol'), true, 'unshare hit the wrong subject');
    // And the owner is unaffected, which is worth pinning: `revokeFor` walks
    // grants, and ownership is not a grant.
    assert.equal(await canRead(fl, id, 'alice'), true);
  });

  it('leaves a share LINK alone, because a link is not a named user', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    const link = await fl.shares.create(id, { as: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob' });

    await fl.shares.unshare(id, { as: 'alice', user: 'bob' });
    assert.equal(await canRead(fl, id, 'bob'), false);
    // The link still redeems: revoking it is `revoke(grantId)`, which is what
    // that method is for -- you handed out a secret and you are taking it back.
    const redeemed = await fl.shares.redeem(link.secret!);
    assert.ok(redeemed, 'unshare() revoked a link it was not asked about');
  });

  it('is all-or-nothing, so a failure cannot half-remove access', async () => {
    // `revokeFor` runs every revocation in ONE transaction. A loop over
    // `revoke()` would be one transaction each, and a failure partway would
    // leave some of a person's access gone and the rest live -- the same defect
    // in a smaller form and harder to notice.
    //
    // The instance is built on a QUERY-ONLY wrapper on purpose. `withTransaction`
    // prefers `db.connect()` and keeps the transaction on a checked-out client,
    // so a hook on `query` would never see it. Without `connect`, it falls back
    // to explicit BEGIN/COMMIT through `query`, which is a real transaction and
    // is interceptable.
    const { db } = await createTestDb();
    let calls = 0;
    const hooked: Queryable = {
      async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
        if (/UPDATE file_grant SET revoked_at/.test(sql) && ++calls === 2) {
          throw new Error('injected failure mid-unshare');
        }
        return db.query<R>(sql, params);
      },
    };
    const fl = new Filelayer(hooked, new MemoryStorage(), { baseUrl: 'http://localhost' });
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    for (let i = 0; i < 3; i++) await fl.shares.create(id, { as: 'alice', withUser: 'bob' });

    await assert.rejects(() => fl.shares.unshare(id, { as: 'alice', user: 'bob' }));

    // Read back through the UNHOOKED connection, so the assertion is about what
    // committed rather than about what the hook let through.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text n FROM file_grant
        WHERE file_id = $1 AND subject_type = 'actor' AND revoked_at IS NULL`,
      [id],
    );
    assert.equal(Number(rows[0]!.n), 3, 'a failed unshare committed a partial revocation');
    assert.equal(await canRead(fl, id, 'bob'), true, 'access was partially removed');
  });
});

describe('unpublish() delegates, and still behaves', () => {
  it('revokes every anonymous grant, as it always did', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('public'), { owner: 'alice' });
    await fl.files.publish(id, { as: 'alice' });
    await fl.files.publish(id, { as: 'alice' });

    const r = await fl.files.unpublish(id, { as: 'alice' });
    assert.ok(r.revoked >= 2, `expected both anonymous grants revoked, got ${r.revoked}`);
    await assert.rejects(() => fl.files.get(id));
  });

  it('does not revoke a named user while unpublishing', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('public'), { owner: 'alice' });
    await fl.files.publish(id, { as: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob' });

    await fl.files.unpublish(id, { as: 'alice' });
    await assert.rejects(() => fl.files.get(id), 'the anonymous grant survived');
    assert.equal(await canRead(fl, id, 'bob'), true, 'unpublish revoked a named user');
  });
});

describe('a spent grant says it is spent', () => {
  it('reports grant_exhausted rather than no_membership', async () => {
    // The deny path consults dead grants now. Before this, `getActorGrants`
    // read `live_grant`, so an exhausted grant was invisible and the refusal
    // was attributed to the fallback -- `no_membership`, for a recipient who
    // never was a member. That reason is what reached the audit log, so a
    // compliance reader asking why the refusal happened was told the wrong
    // thing about a headline feature.
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob', maxDownloads: 1 });
    await fl.files.get(id, { as: 'bob' });

    const err = await fl.files.get(id, { as: 'bob' }).then(
      () => null,
      (e: { status: number; code: string; reason?: string }) => e,
    );
    assert.ok(err);
    // The OUTSIDE is unchanged: still an opaque 404, because the reason must
    // not become an oracle.
    assert.equal(err.status, 404);
    assert.equal(err.code, 'not_found');
    assert.equal(err.reason, 'grant_exhausted');
  });

  it('reports grant_revoked, and prefers it over exhaustion', async () => {
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    const s = await fl.shares.create(id, { as: 'alice', withUser: 'bob' });
    await fl.shares.revoke(s.grantId, { as: 'alice' });

    const err = await fl.files.get(id, { as: 'bob' }).then(
      () => null,
      (e: { reason?: string }) => e,
    );
    assert.equal(err!.reason, 'grant_revoked');
  });

  it('falls back to the role reason when there is no dead grant', async () => {
    // The fallback must survive: a dead grant is a better explanation only when
    // there IS one.
    //
    // Carol gets `insufficient_role` rather than `no_membership`, and that is
    // correct for a reason worth pinning: her own `put()` auto-provisioned her
    // as a `member` of the same default workspace org alice's file lives in.
    // "Reads never auto-provision identities. Writes do." So she holds a role
    // and simply lacks the capability. My first draft of this test asserted
    // `no_membership` and was wrong about the fixture, not the engine.
    const { fl } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.files.put(bytes('x'), { owner: 'carol' });

    const err = await fl.files.get(id, { as: 'carol' }).then(
      () => null,
      (e: { reason?: string }) => e,
    );
    assert.equal(err!.reason, 'insufficient_role');
    // The point of the test: a grant-shaped reason must NOT be invented for
    // somebody who never held a grant.
    assert.doesNotMatch(String(err!.reason), /^grant_/);
  });

  it('writes the real reason to the audit log', async () => {
    // The reason exists for the log, not for the caller, so the log is where it
    // has to be asserted.
    const { fl, db } = await world();
    const { id } = await fl.files.put(bytes('secret'), { owner: 'alice' });
    await fl.shares.create(id, { as: 'alice', withUser: 'bob', maxDownloads: 1 });
    await fl.files.get(id, { as: 'bob' });
    await fl.files.get(id, { as: 'bob' }).catch(() => {});

    const { rows } = await db.query<{ reason: string | null }>(
      `SELECT reason FROM audit_event
        WHERE file_id = $1 AND decision = 'deny' ORDER BY id DESC LIMIT 1`,
      [id],
    );
    assert.equal(rows[0]?.reason, 'grant_exhausted');
  });
});
