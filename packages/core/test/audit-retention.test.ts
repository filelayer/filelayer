/**
 * RETENTION ON A HASH CHAIN: WHAT CAN BE REMOVED, AND WHAT MUST STILL BE VISIBLE.
 *
 * -----------------------------------------------------------------------------
 * THE THREE DEFECTS THIS CLOSES
 * -----------------------------------------------------------------------------
 *
 * 1. `audit_event` grew without bound and could not be trimmed. Not "there was
 *    no helper": a hash chain cut from the front leaves a remainder that is
 *    indistinguishable from a tampered one, so keeping the log verifiable meant
 *    keeping it forever, for the life of the deployment.
 *
 * 2. A TENANT COULD NOT BE DELETED AT ALL. `audit_event.org_id` was
 *    `REFERENCES org(id) ON DELETE CASCADE`; the cascade is a DELETE;
 *    `audit_no_delete` rewrote that DELETE to nothing; and Postgres raised
 *
 *        referential integrity query on "org" from constraint
 *        "audit_event_org_id_fkey" on "audit_event" gave unexpected result
 *
 *    Every tenant has audit events, because creating one is an audited action,
 *    so this was every tenant. Nobody had hit it because the library exposes no
 *    org deletion, which means the trap was set for whoever first had to honour
 *    an erasure request.
 *
 * 3. Truncation of the most recent events was undetectable, as
 *    `AuditChainResult.lastHash` says at length: remove the last n rows and
 *    what remains verifies perfectly, because nothing inside the chain records
 *    where it was supposed to end.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS PINNED HERE, AND WHAT IS DELIBERATELY NOT CLAIMED
 * -----------------------------------------------------------------------------
 *
 * The property is NOT "the log cannot be deleted". It never was, and the schema
 * says so: the rules and the trigger are owned by the table owner and stop an
 * accident, not an adversary. The property is:
 *
 *     A removal that leaves a checkpoint is reported as an attested gap.
 *     A removal that leaves none is reported as tampering.
 *
 * So the test that matters most in this file is the one where a deletion is
 * performed through exactly the same privileged path the library uses, WITHOUT
 * writing the checkpoint, and verification still calls it a break. A retention
 * mechanism that made every deletion look legitimate would be worse than none.
 *
 * These tests need two things PGlite cannot give: real `SET LOCAL` GUC
 * behaviour across a transaction boundary and real advisory locks. They run on
 * `embedded-postgres` and skip, loudly, where it is unavailable.
 */

import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

import { createRealDb, stopRealPostgres, probeRealPostgres, type RealDb } from './real-postgres.ts';
import { Filelayer } from '../src/filelayer.ts';
import { PostgresStore } from '../src/store.ts';
import { MemoryStorage } from '../src/storage.ts';

const PROMISED = !!process.env['FILELAYER_TEST_DATABASE_URL'];
const OPTED_IN = PROMISED || process.env['FILELAYER_TEST_CONTENTION'] === '1';
let available = false;

before(async () => {
  if (!OPTED_IN) {
    console.error(
      '\n  audit-retention.test.ts: not opted in, skipping.\n' +
        '  Run `npm run test:contention`, or set FILELAYER_TEST_DATABASE_URL.\n',
    );
    return;
  }
  const probe = await probeRealPostgres();
  available = probe.ok;
  if (!probe.ok) {
    if (PROMISED) {
      throw new Error(
        `FILELAYER_TEST_DATABASE_URL is set but the suite cannot run: ${probe.why} ` +
          'Refusing to skip: retention on a chain nobody exercised is the state this fixes.',
      );
    }
    console.error(`\n  audit-retention.test.ts: skipping. ${probe.why}\n`);
  }
});

after(async () => {
  await stopRealPostgres();
});

interface World {
  real: RealDb;
  store: PostgresStore;
  orgId: string;
  /** How many events the fixture produced. */
  total: number;
  release(): Promise<void>;
}

/** An org with a known number of audit events, and nothing else. */
async function world(reads = 8): Promise<World> {
  const real = await createRealDb();
  const fl = new Filelayer(real.db, new MemoryStorage(), { baseUrl: 'https://files.example.test' });
  await fl.orgs.create('acme', { name: 'Acme', owner: 'ceo' });
  const { id } = await fl.files.put(new TextEncoder().encode('x'), {
    org: 'acme',
    owner: 'ceo',
    name: 'a.pdf',
  });
  for (let i = 0; i < reads; i++) await fl.files.get(id, { as: 'ceo' });

  const orgId = (
    await real.db.query<{ id: string }>(`SELECT id FROM org WHERE external_id = 'acme'`)
  ).rows[0]!.id;
  const total = Number(
    (
      await real.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event WHERE org_id = $1`,
        [orgId],
      )
    ).rows[0]!.n,
  );
  return { real, store: new PostgresStore(real.db), orgId, total, release: () => real.close() };
}

const countEvents = async (w: World) =>
  Number(
    (
      await w.real.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_event WHERE org_id = $1`,
        [w.orgId],
      )
    ).rows[0]!.n,
  );

/**
 * Delete through the privileged path WITHOUT writing a checkpoint. This is the
 * adversary, and it has everything the library has.
 */
async function deleteUnattested(w: World, sql: string): Promise<void> {
  await w.real.db.query('BEGIN');
  await w.real.db.query(`SET LOCAL filelayer.audit_trim = 'on'`);
  await w.real.db.query(sql, [w.orgId]);
  await w.real.db.query('COMMIT');
}

describe('the delete rule, and the declaration that lifts it', () => {
  it('a plain DELETE still removes nothing', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await w.real.db.query(`DELETE FROM audit_event WHERE org_id = $1`, [w.orgId]);
      assert.equal(await countEvents(w), w.total, 'the rule must still be in force by default');
    } finally {
      await w.release();
    }
  });

  it('the declaration does not outlive its transaction', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await deleteUnattested(w, `DELETE FROM audit_event WHERE id = (
        SELECT min(id) FROM audit_event WHERE org_id = $1)`);
      assert.equal(await countEvents(w), w.total - 1, 'the declared delete should have worked');

      // THE POINT OF `SET LOCAL`. If the GUC leaked past the COMMIT, this
      // second delete would empty the chain and the mechanism would be a
      // permanently open door rather than a per-transaction declaration.
      await w.real.db.query(`DELETE FROM audit_event WHERE org_id = $1`, [w.orgId]);
      assert.equal(await countEvents(w), w.total - 1, 'the door must have closed at COMMIT');
    } finally {
      await w.release();
    }
  });

  it('TRUNCATE is still refused, and says which table', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await assert.rejects(
        () => w.real.db.query(`TRUNCATE audit_event`),
        /audit_event is append-only/,
      );
      await assert.rejects(
        () => w.real.db.query(`TRUNCATE audit_checkpoint`),
        // The message is built from TG_TABLE_NAME; a literal would send the
        // reader to the wrong table, which is why this asserts the other name.
        /audit_checkpoint is append-only/,
      );
    } finally {
      await w.release();
    }
  });
});

describe('trimming, and the record it leaves', () => {
  it('a trimmed chain still verifies, and says how much is missing', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const trimmed = await w.store.trimAuditChain(w.orgId, {
        keepLast: 4,
        note: 'retention: 4 most recent',
      });
      assert.equal(trimmed.removed, w.total - 4);
      assert.equal(trimmed.checkpoint?.kind, 'trim');
      assert.equal(trimmed.checkpoint?.removedCount, w.total - 4);
      assert.ok(trimmed.checkpoint!.removedFrom instanceof Date);
      assert.ok(trimmed.checkpoint!.removedTo instanceof Date);

      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, true, 'a trim with a checkpoint must not read as tampering');
      assert.equal(v.checked, 4);
      assert.equal(v.attestedGaps, 1, 'the gap is accounted for, and counted');
      assert.equal(v.trims.length, 1);
      assert.equal(v.trims[0]!.note, 'retention: 4 most recent');
    } finally {
      await w.release();
    }
  });

  it('a trim that matches nothing writes nothing', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const r = await w.store.trimAuditChain(w.orgId, { keepLast: 9999, note: 'nothing to do' });
      assert.equal(r.removed, 0);
      assert.equal(r.checkpoint, null, 'a retention run that removed nothing must not claim to');
      assert.equal((await w.store.auditCheckpoints(w.orgId)).length, 0);
      assert.equal(await countEvents(w), w.total);
    } finally {
      await w.release();
    }
  });

  it('trimming by date leaves what happened after it', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const mid = (
        await w.real.db.query<{ t: string }>(
          `SELECT occurred_at::text AS t FROM audit_event
            WHERE org_id = $1 ORDER BY id ASC OFFSET 3 LIMIT 1`,
          [w.orgId],
        )
      ).rows[0]!.t;

      // THE EXPECTED COUNT COMES FROM THE SAME PREDICATE, not from the offset.
      // Events written in a tight loop can share an `occurred_at` to the
      // microsecond, so "the fourth row by id" and "rows strictly before the
      // fourth row's timestamp" are not the same three rows whenever two of
      // them landed in the same instant. Asserting 3 made this test pass on
      // most runs and fail on the ones where the clock did not move, which is
      // the worst kind of test: it fails for a reason that has nothing to do
      // with what it is checking, and it teaches people to re-run.
      const expected = Number(
        (
          await w.real.db.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_event WHERE org_id = $1 AND occurred_at < $2`,
            [w.orgId, mid],
          )
        ).rows[0]!.n,
      );
      assert.ok(expected > 0, 'the fixture must leave something before the cut');

      const r = await w.store.trimAuditChain(w.orgId, { before: new Date(mid), note: 'by date' });
      assert.equal(r.removed, expected);
      assert.equal(await countEvents(w), w.total - expected);
      assert.equal((await w.store.verifyAuditChain(w.orgId)).valid, true);
    } finally {
      await w.release();
    }
  });

  it('refuses a policy that is two policies, or none, or unexplained', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await assert.rejects(
        () => w.store.trimAuditChain(w.orgId, { before: new Date(), keepLast: 1, note: 'both' }),
        /exactly one/,
      );
      await assert.rejects(() => w.store.trimAuditChain(w.orgId, { note: 'neither' }), /exactly one/);
      await assert.rejects(
        () => w.store.trimAuditChain(w.orgId, { keepLast: 1, note: '   ' }),
        /note. is required/,
        'a retention run that cannot say why it ran is a deletion with a receipt',
      );
      await assert.rejects(
        () => w.store.trimAuditChain(w.orgId, { keepLast: -1, note: 'negative' }),
        /non-negative integer/,
      );
    } finally {
      await w.release();
    }
  });
});

describe('what the checkpoint does NOT excuse', () => {
  it('a deletion with no checkpoint is still tampering', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      // THE ADVERSARY TEST, and the reason this whole design is defensible.
      // This uses the same declaration the library uses, from the same
      // connection, and simply does not write the record.
      await deleteUnattested(w, `DELETE FROM audit_event WHERE id IN (
        SELECT id FROM audit_event WHERE org_id = $1 ORDER BY id ASC LIMIT 2)`);

      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, false, 'an unattested gap must not be forgiven');
      assert.equal(v.problem, 'prev_hash_mismatch');
      assert.equal(v.attestedGaps, 0);
    } finally {
      await w.release();
    }
  });

  it('a checkpoint for a different hash does not cover the gap', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      // A plausible-looking record that attests to the wrong thing. Verification
      // matches on the hash, not on the existence of paperwork.
      await w.real.db.query(
        `INSERT INTO audit_checkpoint
           (org_id, kind, through_event_id, through_hash, removed_count, removed_from, removed_to, note)
         VALUES ($1, 'trim', 1, 'not-the-hash-that-was-there', 2, now(), now(), 'wrong')`,
        [w.orgId],
      );
      await deleteUnattested(w, `DELETE FROM audit_event WHERE id IN (
        SELECT id FROM audit_event WHERE org_id = $1 ORDER BY id ASC LIMIT 2)`);

      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, false);
      assert.equal(v.problem, 'prev_hash_mismatch');
    } finally {
      await w.release();
    }
  });

  it('checkpoints cannot be edited or removed', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await w.store.trimAuditChain(w.orgId, { keepLast: 4, note: 'original' });
      await w.real.db.query(`UPDATE audit_checkpoint SET note = 'rewritten', removed_count = 1`);
      await w.real.db.query(`DELETE FROM audit_checkpoint`);

      const after = await w.store.auditCheckpoints(w.orgId);
      assert.equal(after.length, 1, 'the record must outlive attempts to remove it');
      assert.equal(after[0]!.note, 'original');
      assert.equal(after[0]!.removedCount, w.total - 4);
    } finally {
      await w.release();
    }
  });

  it('a seal cannot claim to have removed anything', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await assert.rejects(
        () =>
          w.real.db.query(
            `INSERT INTO audit_checkpoint (org_id, kind, through_event_id, through_hash, removed_count, note)
             VALUES ($1, 'seal', 1, 'h', 5, 'a seal that deleted things')`,
            [w.orgId],
          ),
        /checkpoint_seal_removes_nothing/,
      );
      await assert.rejects(
        () =>
          w.real.db.query(
            `INSERT INTO audit_checkpoint (org_id, kind, through_event_id, through_hash, note)
             VALUES ($1, 'trim', 1, 'h', 'a trim that removed nothing')`,
            [w.orgId],
          ),
        /checkpoint_trim_removes_something/,
      );
    } finally {
      await w.release();
    }
  });
});

describe('seals, and the truncation they make visible', () => {
  it('a head behind a seal is reported as truncation', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const seal = await w.store.sealAuditChain(w.orgId, 'nightly');
      assert.equal(seal?.kind, 'seal');
      assert.equal(seal?.removedCount, 0);
      assert.equal((await w.store.verifyAuditChain(w.orgId)).valid, true);

      // Remove the most recent event. Replay alone cannot see this: what is
      // left is a shorter chain in which every link verifies.
      await deleteUnattested(w, `DELETE FROM audit_event WHERE id = (
        SELECT max(id) FROM audit_event WHERE org_id = $1)`);

      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, false, 'this is the case LIMITATIONS 11 said was undetectable');
      assert.equal(v.problem, 'truncated_past_seal');
      assert.equal(v.brokenAt, seal!.throughEventId);
    } finally {
      await w.release();
    }
  });

  it('an emptied chain with a seal on record is the loudest form of the same finding', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      await w.store.sealAuditChain(w.orgId, 'before');
      await deleteUnattested(w, `DELETE FROM audit_event WHERE org_id = $1`);
      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, false);
      assert.equal(v.problem, 'truncated_past_seal');
      assert.equal(v.lastId, null, 'and the chain really is empty');
    } finally {
      await w.release();
    }
  });

  it('a trim does not read as truncation, because the seal moves with it', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      // A seal taken BEFORE a trim refers to an event the trim removed. The
      // head is then behind it by id, and this must not be reported as
      // truncation: the events are accounted for.
      await w.store.sealAuditChain(w.orgId, 'before the trim');
      await w.store.trimAuditChain(w.orgId, { keepLast: 2, note: 'retention' });
      const v = await w.store.verifyAuditChain(w.orgId);
      assert.equal(v.valid, true, 'a seal older than a trim is not evidence of truncation');
      assert.equal(v.attestedGaps, 1);
    } finally {
      await w.release();
    }
  });

  it('sealing an empty chain records nothing rather than inventing a head', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const real = await createRealDb();
    try {
      const store = new PostgresStore(real.db);
      assert.equal(await store.sealAuditChain('00000000-0000-0000-0000-00000000dead', 'empty'), null);
    } finally {
      await real.close();
    }
  });
});

describe('erasing a tenant, which used to raise', () => {
  it('an org with audit history can now be deleted', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      // Before 0.16.0 this threw: the cascade was a DELETE, the rule rewrote it
      // away, and Postgres refused its own referential-integrity result.
      await w.real.db.query(`DELETE FROM org WHERE id = $1`, [w.orgId]);
      const orgs = await w.real.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM org WHERE id = $1`,
        [w.orgId],
      );
      assert.equal(Number(orgs.rows[0]!.n), 0, 'the tenant row is gone');

      // AND THE HISTORY SURVIVES IT, deliberately. Deleting a subject must not
      // rewrite what they did; erasure is a separate, explicit, attested step.
      assert.equal(await countEvents(w), w.total);
    } finally {
      await w.release();
    }
  });

  it('erasure removes the events and leaves a record that it happened', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const r = await w.store.trimAuditChain(w.orgId, {
        keepLast: 0,
        note: 'erasure request 2026-10-06',
      });
      assert.equal(r.removed, w.total);
      assert.equal(await countEvents(w), 0);

      await w.real.db.query(`DELETE FROM org WHERE id = $1`, [w.orgId]);

      const left = await w.store.auditCheckpoints(w.orgId);
      assert.equal(left.length, 1, 'the record of the erasure outlives the tenant');
      assert.equal(left[0]!.removedCount, w.total);
      assert.equal(left[0]!.note, 'erasure request 2026-10-06');

      // What that surviving row contains, which is why it is allowed to survive:
      // an org id, two hashes, a count and a window. Nothing about any person.
      assert.deepEqual(Object.keys(left[0]!).sort(), [
        'createdAt', 'id', 'kind', 'note', 'orgId',
        'removedCount', 'removedFrom', 'removedTo', 'throughEventId', 'throughHash',
      ]);
    } finally {
      await w.release();
    }
  });
});
