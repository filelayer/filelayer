/**
 * THE FAST PATH DECIDES EXACTLY WHAT THE SLOW PATH DECIDED.
 *
 * -----------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY IT IS DANGEROUS
 * -----------------------------------------------------------------------------
 *
 * `resolveStanding` has always stopped at the first live grant supplying the
 * capability being asked for. It stopped in TypeScript, after `getActorGrants`
 * had fetched every row and Postgres had evaluated `grant_is_live(id)` -- a
 * recursive function declared COST 100 -- on each one. A subject holding n
 * grants on a file paid n recursive walks per read, for an answer the loop took
 * from the first. Measured: 38.10 ms at 2 000 grants, against 0.88 ms at 5.
 *
 * So the lookup moved into SQL, with a capability filter and `LIMIT 1`.
 *
 * THAT IS A CHANGE TO THE AUTHORIZATION PATH MADE FOR SPEED, which is the most
 * dangerous kind of change this codebase can take, and the reason this file
 * exists is not to show it is fast. It is to pin that it decides the same
 * things:
 *
 *   * the same grant is chosen, which matters beyond the allow because that
 *     grant becomes `parent_grant_id` on delegation and therefore sets the
 *     ceiling the attenuation trigger measures a child against;
 *   * an allow is still an allow and a denial is still a denial;
 *   * AND THE REFUSAL STILL CARRIES THE RIGHT REASON. A miss on the fast path
 *     means "no live grant of this subject supplies this capability", not
 *     "this subject has nothing", and those are different refusals with
 *     different audit reasons. This project shipped that exact confusion once
 *     already, in 0.10.0: a recipient whose three downloads were spent was
 *     refused with `no_membership`, so a compliance reader asking why was told
 *     the person was not in the org, which was true and was not the reason.
 *
 * The last of those is why the engine falls back to the full fetch when the
 * fast query returns nothing. Denials for a subject with many grants still pay
 * the old cost. That is deliberate and it is the right trade: the hot path is
 * the allow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { PostgresStore } from '../src/store.ts';
import { MemoryStorage } from '../src/storage.ts';
import { bytes } from './helpers.ts';

interface World {
  fl: Filelayer;
  store: PostgresStore;
  org: string;
  owner: string;
  reader: string;
  fileId: string;
}

async function world(): Promise<World> {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://files.test' });
  const owner = (await fl.createActor(`owner-${Math.random()}`)).id;
  const reader = (await fl.createActor(`reader-${Math.random()}`)).id;
  const org = (await fl.createOrg(`org-${Math.random()}`, 'Org', { ownerActorId: owner })).id;
  const file = await fl.upload({ actorId: owner }, org, {
    name: 'f.bin',
    contentType: 'application/octet-stream',
    body: bytes('x'),
  });
  return { fl, store: new PostgresStore(db), org, owner, reader, fileId: file.id };
}

describe('the capability-filtered lookup picks the row the loop picked', () => {
  it('is the OLDEST grant supplying the capability, not the oldest grant', async () => {
    const w = await world();

    // Oldest first, and it does NOT supply `delete`. The engine must skip it
    // for a delete and choose the second -- which is the whole subtlety: "the
    // first grant" and "the first grant that supplies this" are different rows,
    // and the delegation ceiling is taken from the one that supplies it.
    const readOnly = await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
    });
    const withDelete = await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read', 'delete'],
    });

    const forRead = await w.store.getActorGrantSupplying(w.fileId, w.reader, 'read');
    const forDelete = await w.store.getActorGrantSupplying(w.fileId, w.reader, 'delete');

    assert.equal(forRead?.id, readOnly.grantId, 'read is supplied by the oldest grant');
    assert.equal(forDelete?.id, withDelete.grantId, 'delete is supplied by the second');

    // And it agrees with the unfiltered list it replaces, which is the real
    // assertion: same ordering, same choice.
    const all = await w.store.getActorGrants(w.fileId, w.reader);
    assert.equal(all[0]!.id, readOnly.grantId, 'ordering is unchanged');
    assert.equal(
      all.find((g) => g.capabilities.includes('delete'))!.id,
      forDelete!.id,
      'the filtered query returns what scanning the list in order would find',
    );
  });

  it('returns null when no grant supplies it, rather than the nearest thing', async () => {
    const w = await world();
    await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
    });
    assert.equal(await w.store.getActorGrantSupplying(w.fileId, w.reader, 'delete'), null);
    assert.equal((await w.store.getActorGrants(w.fileId, w.reader)).length, 1, 'but the grant is there');
  });

  it('ignores grants that are not live, exactly as the view does', async () => {
    const w = await world();
    const spent = await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
      maxDownloads: 1,
    });
    const fresh = await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
    });

    assert.equal(
      (await w.store.getActorGrantSupplying(w.fileId, w.reader, 'read'))?.id,
      spent.grantId,
      'while it is live, the oldest wins',
    );

    await w.fl.revoke({ actorId: w.owner }, spent.grantId);

    assert.equal(
      (await w.store.getActorGrantSupplying(w.fileId, w.reader, 'read'))?.id,
      fresh.grantId,
      'once it is not live, the next one does',
    );
  });

  it('refuses a malformed id instead of asking the database', async () => {
    const w = await world();
    assert.equal(await w.store.getActorGrantSupplying('not-a-uuid', w.reader, 'read'), null);
    assert.equal(await w.store.getActorGrantSupplying(w.fileId, 'not-a-uuid', 'read'), null);
  });
});

describe('the decision, and the reason, are unchanged', () => {
  it('a grant that supplies the capability still allows', async () => {
    const w = await world();
    await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
    });
    const got = await w.fl.read({ actorId: w.reader }, w.fileId);
    assert.ok(got.body.byteLength > 0);
  });

  it('A GRANT WITH THE WRONG CAPABILITY DENIES WITH grant_wrong_capability', async () => {
    // THE TEST THIS FILE EXISTS FOR. The fast query returns nothing here,
    // because no grant supplies `delete`. If a miss were treated as a denial,
    // the engine would never learn that the subject holds a live grant at all
    // and would refuse with a no-standing reason -- which is a true statement
    // about the wrong thing, and is what 0.10.0 did with spent grants.
    const w = await world();
    await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
    });

    await assert.rejects(
      () => w.fl.delete({ actorId: w.reader }, w.fileId),
      (e: unknown) => {
        const err = e as { status?: number; reason?: string };
        assert.equal(err.status, 404);
        assert.equal(
          err.reason,
          'grant_wrong_capability',
          'the refusal must say the capability was wrong, not that the person is a stranger',
        );
        return true;
      },
    );
  });

  it('a subject with no grant at all still denies with no_membership', async () => {
    const w = await world();
    await assert.rejects(
      () => w.fl.read({ actorId: w.reader }, w.fileId),
      (e: unknown) => {
        assert.equal((e as { reason?: string }).reason, 'no_membership');
        return true;
      },
    );
  });

  it('a spent grant still explains itself, which is the 0.10.0 defect', async () => {
    const w = await world();
    const g = await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
      maxDownloads: 1,
    });
    void g;
    await w.fl.read({ actorId: w.reader }, w.fileId); // spends it

    await assert.rejects(
      () => w.fl.read({ actorId: w.reader }, w.fileId),
      (e: unknown) => {
        const reason = (e as { reason?: string }).reason;
        assert.notEqual(reason, 'no_membership', 'a spent grant is not an absent person');
        assert.match(String(reason), /grant|download|spent|exhaust/i);
        return true;
      },
    );
  });

  it('duplicates do not change the decision, only what it costs', async () => {
    // The pathological shape, small enough to run on PGlite: many identical
    // live grants. The answer must be identical to one grant.
    const w = await world();
    const first = await w.fl.share({ actorId: w.owner }, w.fileId, {
      subject: { type: 'actor', actorId: w.reader },
      capabilities: ['read'],
    });
    for (let i = 0; i < 40; i++) {
      await w.fl.share({ actorId: w.owner }, w.fileId, {
        subject: { type: 'actor', actorId: w.reader },
        capabilities: ['read'],
      });
    }
    assert.equal((await w.store.getActorGrants(w.fileId, w.reader)).length, 41);
    assert.equal(
      (await w.store.getActorGrantSupplying(w.fileId, w.reader, 'read'))?.id,
      first.grantId,
      'the oldest is still the one chosen, whatever piled up behind it',
    );
    const got = await w.fl.read({ actorId: w.reader }, w.fileId);
    assert.ok(got.body.byteLength > 0);
  });
});
