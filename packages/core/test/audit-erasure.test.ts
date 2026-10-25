/**
 * ERASING ONE PERSON FROM A CHAIN THAT WAS BUILT NOT TO FORGET.
 *
 * -----------------------------------------------------------------------------
 * WHAT WAS IMPOSSIBLE, AND WHY
 * -----------------------------------------------------------------------------
 *
 * `trimAuditChain()` is retention: it removes a PREFIX, makes one hole, and
 * writes one checkpoint. An erasure request is not shaped like that. One
 * person's events are scattered through the chain, so removing them makes
 * several holes, and a checkpoint attesting one says nothing about the others.
 *
 * Until this shipped, the only honest answer to "erase this person" was to
 * remove a date range CONTAINING their events, taking everyone else's in that
 * range with it. `LIMITATIONS.md` entry 11 said exactly that, and this suite
 * is what allows that entry to be rewritten.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS SUITE HOLDS APART
 * -----------------------------------------------------------------------------
 *
 *   1. Their events go, everyone else's stay. The over-deletion that the old
 *      answer forced is the thing being fixed, so it is asserted directly.
 *   2. Every hole is attested. `attestedGaps` equals the number of runs, and
 *      it must NOT be zero: a chain whose history is shorter than what
 *      happened says so.
 *   3. ADJACENT events are one hole, not two. The unit is a contiguous run,
 *      and getting this wrong writes checkpoints nothing will ever consume.
 *   4. Erasing the chain HEAD does not read as truncation when a seal exists.
 *      That is the case an honest erasure produces and the guard used to call
 *      tampering.
 *   5. THE CONTROL. The same removal performed WITHOUT the attestation is
 *      still reported as broken. Without it, every assertion above is also
 *      satisfied by a verifier that forgives everything.
 *
 * These run on the embedded PostgreSQL `createTestDb()` starts, because the
 * mechanism is a window function, an advisory lock and a rule the SERVER
 * enforces -- none of which a mock has, and all of which that engine does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { PostgresStore } from '../src/store.ts';
import { MemoryStorage } from '../src/storage.ts';

interface World {
  db: Queryable;
  fl: Filelayer;
  store: PostgresStore;
  orgId: string;
  erika: string;
  release: () => Promise<void>;
}

/**
 * A chain where Erika's reads are INTERLEAVED with someone else's, so the
 * removal is scattered rather than a prefix. Two of hers are deliberately
 * adjacent, which is the run case.
 *
 * order: erika, other, erika, erika, other, erika, other
 */
async function world(): Promise<World> {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://files.example.test' });
  await fl.orgs.create('acme', { name: 'Acme', owner: 'ceo' });
  await fl.orgs.setRole('acme', 'erika', 'member', { as: 'ceo' });
  await fl.orgs.setRole('acme', 'other', 'member', { as: 'ceo' });
  const { id } = await fl.files.put(new TextEncoder().encode('x'), {
    org: 'acme',
    owner: 'ceo',
    name: 'a.pdf',
    visibility: 'org',
  });

  for (const who of ['erika', 'other', 'erika', 'erika', 'other', 'erika', 'other']) {
    await fl.files.get(id, { as: who });
  }

  const orgId = (
    await db.query<{ id: string }>(`SELECT id FROM org WHERE external_id = 'acme'`)
  ).rows[0]!.id;
  const erika = (
    await db.query<{ id: string }>(`SELECT id FROM actor WHERE external_id = 'erika'`)
  ).rows[0]!.id;

  return { db, fl, orgId, erika, store: new PostgresStore(db), release: async () => {} };
}

const countFor = async (w: World, actorId: string) =>
  Number(
    (
      await w.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event WHERE org_id = $1 AND actor_id = $2`,
        [w.orgId, actorId],
      )
    ).rows[0]!.n,
  );

describe('erasing one actor from the audit chain', () => {

  it('removes theirs and leaves everyone else untouched', async () => {
    const w = await world();
    try {
      const otherBefore = Number(
        (
          await w.db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_event
              WHERE org_id = $1 AND actor_id IS DISTINCT FROM $2`,
            [w.orgId, w.erika],
          )
        ).rows[0]!.n,
      );
      const mine = await countFor(w, w.erika);
      assert.ok(mine >= 4, `expected several of Erika's events, got ${mine}`);

      const { removed } = await w.store.eraseActorFromAuditChain(w.orgId, w.erika, {
        note: 'erasure request, ticket 4471',
      });

      assert.equal(removed, mine);
      assert.equal(await countFor(w, w.erika), 0, 'some of her events survived');

      const otherAfter = Number(
        (
          await w.db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_event
              WHERE org_id = $1 AND actor_id IS DISTINCT FROM $2`,
            [w.orgId, w.erika],
          )
        ).rows[0]!.n,
      );
      assert.equal(
        otherAfter,
        otherBefore,
        'the over-deletion this feature exists to remove happened anyway',
      );
    } finally {
      await w.release();
    }
  });

  it('leaves the chain verifiable, with every hole attested', async () => {
    const w = await world();
    try {
      const { checkpoints } = await w.store.eraseActorFromAuditChain(w.orgId, w.erika, {
        note: 'erasure request, ticket 4471',
      });
      const v = await w.store.verifyAuditChain(w.orgId);

      assert.equal(v.valid, true, `the chain broke: ${v.problem} at ${v.brokenAt}`);
      assert.equal(
        v.attestedGaps,
        checkpoints.length,
        'a hole was made that no checkpoint accounts for',
      );
      assert.ok(v.attestedGaps > 0, 'a shorter history must not report as untouched');
    } finally {
      await w.release();
    }
  });

  it('writes ONE checkpoint per contiguous run, not one per event', async () => {
    // Erika's reads are interleaved as e,o,e,e,o,e,o — so her events form
    // three runs, one of which is two events long. A checkpoint per event
    // would write four, and the extra would be one nothing ever consumes.
    const w = await world();
    try {
      const { removed, checkpoints } = await w.store.eraseActorFromAuditChain(w.orgId, w.erika, {
        note: 'runs',
      });
      assert.ok(
        checkpoints.length < removed,
        `${checkpoints.length} checkpoint(s) for ${removed} event(s): adjacency was not collapsed`,
      );
      assert.equal(
        checkpoints.reduce((t, c) => t + c.removedCount, 0),
        removed,
        'the checkpoints do not account for every removed event',
      );
      // And every one of them is consumed: the verifier reports exactly as
      // many attested gaps as there are checkpoints.
      assert.equal((await w.store.verifyAuditChain(w.orgId)).attestedGaps, checkpoints.length);
    } finally {
      await w.release();
    }
  });

  it('carries the reason onto every checkpoint, and refuses a blank one', async () => {
    const w = await world();
    try {
      await assert.rejects(
        () => w.store.eraseActorFromAuditChain(w.orgId, w.erika, { note: '   ' }),
        /note` is required/,
      );
      const { checkpoints } = await w.store.eraseActorFromAuditChain(w.orgId, w.erika, {
        note: 'erasure request, ticket 4471',
      });
      for (const c of checkpoints) {
        assert.equal(c.note, 'erasure request, ticket 4471');
        assert.equal(c.kind, 'trim');
      }
    } finally {
      await w.release();
    }
  });

  it('is a no-op for an actor with nothing on the chain', async () => {
    const w = await world();
    try {
      const r = await w.store.eraseActorFromAuditChain(
        w.orgId,
        '00000000-0000-0000-0000-000000000000',
        { note: 'nobody' },
      );
      assert.equal(r.removed, 0);
      assert.deepEqual(r.checkpoints, []);
      assert.equal((await w.store.verifyAuditChain(w.orgId)).valid, true);
    } finally {
      await w.release();
    }
  });

  it('erasing the chain HEAD does not read as truncation past a seal', async () => {
    // The case an honest erasure produces and the guard used to call
    // tampering: seal the chain, then erase a person whose events include the
    // most recent one, so the head moves backwards.
    const w = await world();
    try {
      await w.fl.files.get(
        (await w.db.query<{ id: string }>(`SELECT id FROM file LIMIT 1`)).rows[0]!.id,
        { as: 'erika' },
      );
      const seal = await w.store.sealAuditChain(w.orgId, 'nightly');
      assert.ok(seal, 'nothing was sealed, so this test proves nothing');

      const head = (await w.store.verifyAuditChain(w.orgId)).lastId;
      await w.store.eraseActorFromAuditChain(w.orgId, w.erika, { note: 'erasure request' });

      const v = await w.store.verifyAuditChain(w.orgId);
      assert.ok(v.lastId !== null && head !== null && v.lastId < head, 'the head did not move');
      assert.notEqual(v.problem, 'truncated_past_seal');
      assert.equal(v.valid, true, `an attested head drop reported ${v.problem}`);
    } finally {
      await w.release();
    }
  });

  it('CONTROL: the same removal WITHOUT attestation is still reported', async () => {
    // Everything above is also true of a verifier that forgives any gap. This
    // is the assertion that says the checkpoints are doing the work.
    const w = await world();
    try {
      // IN A TRANSACTION, because `SET LOCAL` outside one does nothing and the
      // append-only rule then suppresses the DELETE. The first version of this
      // control did exactly that and reported it rather than passing: a
      // removal that did not happen cannot demonstrate anything about what
      // happens after a removal.
      await w.db.query('BEGIN');
      await w.db.query(`SET LOCAL filelayer.audit_trim = 'on'`);
      await w.db.query(`DELETE FROM audit_event WHERE org_id = $1 AND actor_id = $2`, [
        w.orgId,
        w.erika,
      ]);
      await w.db.query('COMMIT');
      assert.equal(await countFor(w, w.erika), 0, 'the raw DELETE was suppressed');
      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, false, 'an unattested erasure verified clean');
      assert.equal(v.attestedGaps, 0);
    } finally {
      await w.release();
    }
  });
});
