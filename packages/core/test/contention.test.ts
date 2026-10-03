/**
 * THE PROPERTIES THAT ONLY EXIST WHEN TWO BACKENDS COLLIDE.
 *
 * Every other file in this suite runs on PGlite, which has one backend and
 * therefore cannot interleave two transactions. That is fine for semantics and
 * useless for scheduling, so until now this library shipped three claims it
 * could argue but not test:
 *
 *   - an org can never be left without an owner;
 *   - a download cap is a cap, not a suggestion;
 *   - the audit chain cannot fork.
 *
 * All three are about what happens when two callers arrive at once. All three
 * had a defect found by review rather than by test -- the `last_owner` race on
 * 2 October 2026, and the chain fork earlier -- and the fixes went out on
 * reasoning alone. TRUST.md said as much: "reasoned and followed, not proven
 * under real contention."
 *
 * This file runs against a real PostgreSQL server with real, separate
 * connections. Every test here would pass vacuously on PGlite, which is exactly
 * why none of them live in the other files.
 *
 * EACH PROPERTY IS TESTED TWICE, once forwards and once as a CALIBRATION
 * CONTROL: the same interleaving, hand-driven, with the protection removed. A
 * concurrency test that has never been seen to fail is indistinguishable from a
 * test that cannot fail, and this suite exists precisely because we had a lot of
 * the second kind.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRealDb,
  stopRealPostgres,
  realPostgresAvailable,
  type RealDb,
} from './real-postgres.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import type { Queryable } from '../src/db.ts';
import { bytes, text } from './helpers.ts';

/**
 * CI MUST NOT SKIP THIS QUIETLY. A suite that silently reports success when it
 * did not run is the one failure mode that looks exactly like success, and this
 * project has already shipped it once on the R2 job. When
 * `FILELAYER_TEST_DATABASE_URL` is set, the environment has promised a server
 * and a skip is a failure.
 */
const PROMISED = Boolean(process.env['FILELAYER_TEST_DATABASE_URL']);
/**
 * OPT IN, so that `npm test` stays what it has always been: two seconds, no
 * server, no download, nothing to install. This file needs a real PostgreSQL,
 * and silently acquiring one on every contributor's first `npm test` would be a
 * rude surprise and a slow one.
 *
 * `npm run test:contention` sets it. So does CI, which also sets
 * `FILELAYER_TEST_DATABASE_URL` and then refuses to let the suite skip.
 */
const OPTED_IN = PROMISED || process.env['FILELAYER_TEST_CONTENTION'] === '1';
let available = false;

before(async () => {
  if (!OPTED_IN) {
    console.error(
      '\n  contention.test.ts: not opted in, skipping.\n' +
        '  Run `npm run test:contention`, or set FILELAYER_TEST_DATABASE_URL.\n',
    );
    return;
  }
  available = await realPostgresAvailable();
  if (!available && PROMISED) {
    throw new Error(
      'FILELAYER_TEST_DATABASE_URL is set but no server answered. ' +
        'Refusing to skip: a contention suite that does not run proves nothing.',
    );
  }
  if (!available) {
    console.error('\n  contention.test.ts: no PostgreSQL available, skipping.\n');
  }
});

after(async () => {
  await stopRealPostgres();
});

/** A `Filelayer` pinned to ONE backend. This is the supported single-Client shape. */
function onConnection(q: Queryable, storage: MemoryStorage): Filelayer {
  return new Filelayer(q, storage, { baseUrl: 'https://files.example.test' });
}

interface Two {
  real: RealDb;
  storage: MemoryStorage;
  fl: Filelayer;
  release(): Promise<void>;
}

async function world(): Promise<Two> {
  const real = await createRealDb();
  const storage = new MemoryStorage();
  return {
    real,
    storage,
    fl: onConnection(real.db, storage),
    release: () => real.close(),
  };
}

// =============================================================================
// 1. AN ORG CANNOT BE LEFT WITHOUT AN OWNER
// =============================================================================

describe('contention: the last owner', () => {
  it('two backends demoting two different owners cannot both win', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const alice = (await w.fl.createActor('alice')).id;
      const bob = (await w.fl.createActor('bob')).id;
      const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      await w.fl.addMember({ actorId: alice }, org, bob, 'owner');

      const before = await owners(w.real.db, org);
      assert.equal(before, 2, 'two live owners to start');

      // Two separate connections, each demoting the OTHER owner, launched
      // together. Without the per-org advisory lock taken as the first
      // statement of the unit, both read 2, both pass the guard, and both
      // commit. With it, the second one blocks until the first commits and
      // then reads 1.
      const ca = await w.real.connect();
      const cb = await w.real.connect();
      try {
        const flA = onConnection(ca.q, w.storage);
        const flB = onConnection(cb.q, w.storage);
        const [ra, rb] = await Promise.allSettled([
          flA.removeMember({ actorId: alice }, org, bob),
          flB.removeMember({ actorId: bob }, org, alice),
        ]);

        const wins = [ra, rb].filter((r) => r.status === 'fulfilled').length;
        const losses = [ra, rb].filter((r) => r.status === 'rejected');

        assert.equal(wins, 1, `exactly one may win, got ${wins}`);
        assert.equal(losses.length, 1);

        // THE LOSER MAY LOSE IN EITHER OF TWO WAYS, and both are correct.
        //
        // 403 `last_owner` is the guard firing on a count it re-read after the
        // lock. 404 is the loser discovering it no longer has standing at all:
        // the winner removed its membership, so `manage_members` is denied
        // before the guard is ever reached, and the uniform-denial rule turns
        // that into the same 404 any stranger gets.
        //
        // Asserting one specific code here would be asserting a scheduling
        // order, which is exactly the thing that is not deterministic. The
        // property is that the org survives.
        const err = (losses[0] as PromiseRejectedResult).reason as {
          status?: number;
          reason?: string;
        };
        assert.ok(
          err.status === 403 || err.status === 404,
          `the loser must be refused, got ${err.status} ${err.reason}`,
        );
        if (err.status === 403) assert.equal(err.reason, 'last_owner');

        assert.equal(await owners(w.real.db, org), 1, 'the org still has an owner');
      } finally {
        ca.release();
        cb.release();
      }
    } finally {
      await w.release();
    }
  });

  it('CONTROL: the same interleaving without the lock does reach zero owners', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    // Hand-driven check-then-act, which is what the code did before 0.7.0: both
    // transactions read the owner count BEFORE either writes. This is not a
    // test of the library. It is the proof that the interleaving the test above
    // defends against is reachable on this engine, so that a pass up there
    // means something.
    const w = await world();
    try {
      const alice = (await w.fl.createActor('alice')).id;
      const bob = (await w.fl.createActor('bob')).id;
      const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      await w.fl.addMember({ actorId: alice }, org, bob, 'owner');

      const ca = await w.real.connect();
      const cb = await w.real.connect();
      try {
        await ca.q.query('BEGIN');
        await cb.q.query('BEGIN');

        const seenA = await ownersIn(ca.q, org);
        const seenB = await ownersIn(cb.q, org);
        assert.equal(seenA, 2, 'A reads the pre-state');
        assert.equal(seenB, 2, 'and so does B, because neither has written yet');

        await ca.q.query(`DELETE FROM membership WHERE org_id = $1 AND actor_id = $2`, [org, bob]);
        await cb.q.query(`DELETE FROM membership WHERE org_id = $1 AND actor_id = $2`, [
          org,
          alice,
        ]);
        await ca.q.query('COMMIT');
        await cb.q.query('COMMIT');

        assert.equal(
          await owners(w.real.db, org),
          0,
          'without serialisation the org is left unadministrable, which is the point',
        );
      } finally {
        ca.release();
        cb.release();
      }
    } finally {
      await w.release();
    }
  });
});

// =============================================================================
// 2. A DOWNLOAD CAP IS A CAP
// =============================================================================

describe('contention: the download cap', () => {
  it('maxDownloads 1 serves exactly one of two simultaneous redemptions', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const alice = (await w.fl.createActor('alice')).id;
      const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      const file = await w.fl.upload({ actorId: alice }, org, {
        name: 'one.txt',
        contentType: 'text/plain',
        body: bytes('ONCE'),
      });
      const share = await w.fl.share({ actorId: alice }, file.id, {
        subject: { type: 'link' },
        maxDownloads: 1,
      });

      const ca = await w.real.connect();
      const cb = await w.real.connect();
      try {
        const [ra, rb] = await Promise.allSettled([
          onConnection(ca.q, w.storage).redeem(share.secret!),
          onConnection(cb.q, w.storage).redeem(share.secret!),
        ]);
        const ok = [ra, rb].filter((r) => r.status === 'fulfilled');
        assert.equal(ok.length, 1, 'one download, not two');
        assert.equal(text((ok[0] as PromiseFulfilledResult<{ body: Uint8Array }>).value.body), 'ONCE');

        const { rows } = await w.real.db.query<{ n: number }>(
          `SELECT download_count::int AS n FROM file_grant WHERE id = $1`,
          [share.grantId],
        );
        assert.equal(Number(rows[0]!.n), 1, 'and the counter is 1, never 2');
      } finally {
        ca.release();
        cb.release();
      }
    } finally {
      await w.release();
    }
  });

  it('ten simultaneous redemptions against a cap of three serve three', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const alice = (await w.fl.createActor('alice')).id;
      const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      const file = await w.fl.upload({ actorId: alice }, org, {
        name: 'three.txt',
        contentType: 'text/plain',
        body: bytes('THRICE'),
      });
      const share = await w.fl.share({ actorId: alice }, file.id, {
        subject: { type: 'link' },
        maxDownloads: 3,
      });

      const conns = await Promise.all(Array.from({ length: 10 }, () => w.real.connect()));
      try {
        const results = await Promise.allSettled(
          conns.map((c) => onConnection(c.q, w.storage).redeem(share.secret!)),
        );
        const served = results.filter((r) => r.status === 'fulfilled').length;
        assert.equal(served, 3, `exactly three served, got ${served}`);

        const { rows } = await w.real.db.query<{ n: number }>(
          `SELECT download_count::int AS n FROM file_grant WHERE id = $1`,
          [share.grantId],
        );
        assert.equal(Number(rows[0]!.n), 3, 'the counter never overshoots');
      } finally {
        conns.forEach((c) => c.release());
      }
    } finally {
      await w.release();
    }
  });

  it('CONTROL: read-then-decide overshoots on the same engine', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    // The naive counter, driven by hand: read the count, decide, then write.
    // `consume_download` exists because this is what a reasonable person writes
    // first, and this control shows what it costs on a real server.
    const w = await world();
    try {
      await w.real.db.query(`CREATE TABLE naive (id int PRIMARY KEY, used int NOT NULL)`);
      await w.real.db.query(`INSERT INTO naive VALUES (1, 0)`);
      const cap = 1;

      const conns = await Promise.all(Array.from({ length: 2 }, () => w.real.connect()));
      try {
        const attempt = async (q: Queryable) => {
          await q.query('BEGIN');
          const { rows } = await q.query<{ used: number }>(`SELECT used FROM naive WHERE id = 1`);
          const used = Number(rows[0]!.used);
          await q.query('SELECT pg_sleep(0.05)'); // the window every such read has
          if (used >= cap) {
            await q.query('ROLLBACK');
            return false;
          }
          await q.query(`UPDATE naive SET used = used + 1 WHERE id = 1`);
          await q.query('COMMIT');
          return true;
        };
        const got = await Promise.all(conns.map((c) => attempt(c.q)));
        const served = got.filter(Boolean).length;
        assert.equal(served, 2, 'both pass a cap of one, which is the defect being prevented');

        const { rows } = await w.real.db.query<{ used: number }>(`SELECT used FROM naive WHERE id = 1`);
        assert.equal(Number(rows[0]!.used), 2, 'and the counter is over the cap');
      } finally {
        conns.forEach((c) => c.release());
      }
    } finally {
      await w.release();
    }
  });
});

// =============================================================================
// 3. THE AUDIT CHAIN CANNOT FORK
// =============================================================================

describe('contention: the audit chain', () => {
  it('twenty concurrent writers leave one verifiable chain', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const alice = (await w.fl.createActor('alice')).id;
      const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      const file = await w.fl.upload({ actorId: alice }, org, {
        name: 'f.txt',
        contentType: 'text/plain',
        body: bytes('X'),
      });

      // Twenty reads from eight connections, all writing allow events onto the
      // same per-org chain at once. Before `audit_append` took
      // `pg_advisory_xact_lock`, two writers read the same predecessor hash and
      // the chain forked; replay then reports a mismatch at the fork point.
      const conns = await Promise.all(Array.from({ length: 8 }, () => w.real.connect()));
      try {
        const work = Array.from({ length: 20 }, (_, i) =>
          onConnection(conns[i % conns.length]!.q, w.storage).read({ actorId: alice }, file.id),
        );
        const settled = await Promise.allSettled(work);
        assert.equal(
          settled.filter((r) => r.status === 'fulfilled').length,
          20,
          'every read succeeds',
        );

        const v = await w.fl.verifyAuditChain({ actorId: alice }, org);
        assert.equal(v.valid, true, `chain must verify, got ${JSON.stringify(v)}`);
        assert.ok(v.checked >= 20, 'and it has to have actually recorded them');
        assert.ok(v.lastHash, 'the head is reported');
      } finally {
        conns.forEach((c) => c.release());
      }
    } finally {
      await w.release();
    }
  });

  it('CONTROL: a chain that DID fork is caught by the same verifier', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    // The point of this control is narrow and worth stating, because the first
    // version of it was wrong.
    //
    // The test above asserts that twenty concurrent writers leave a chain that
    // verifies. That is only evidence if `verifyAuditChain` is capable of
    // saying no, and specifically of saying no TO A FORK -- two rows claiming
    // the same predecessor, which is the shape the pre-lock code produced.
    //
    // My first attempt inserted two rows with hand-written hashes. That is not
    // a fork, it is a forgery: replay recomputed the digest, found it wrong,
    // and reported `hash_mismatch` before it ever looked at the links. It
    // proved the verifier works, but not the thing being claimed here.
    //
    // So: build a real chain through the real code path, then move the last
    // row's `prev_hash` back one link. Now two rows name the same predecessor
    // and nothing else about the row has been touched. The rules make that
    // UPDATE a no-op by design, so the control disables one for the length of
    // the statement, exactly as the tamper tests in security.test.ts do.
    const w = await world();
    try {
      const alice = (await w.fl.createActor('alice')).id;
      const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
      const file = await w.fl.upload({ actorId: alice }, org, {
        name: 'f.txt',
        contentType: 'text/plain',
        body: bytes('X'),
      });
      for (let i = 0; i < 3; i++) await w.fl.read({ actorId: alice }, file.id);

      const clean = await w.fl.verifyAuditChain({ actorId: alice }, org);
      assert.equal(clean.valid, true, 'the chain is sound before we break it');

      const { rows } = await w.real.db.query<{ id: string; prev_hash: string }>(
        `SELECT id, prev_hash FROM audit_event WHERE org_id = $1 ORDER BY id DESC LIMIT 2`,
        [org],
      );
      const [last, previous] = rows;
      assert.ok(last && previous);

      await w.real.db.query(`ALTER TABLE audit_event DISABLE RULE audit_no_update`);
      await w.real.db.query(`UPDATE audit_event SET prev_hash = $1 WHERE id = $2`, [
        previous.prev_hash,
        last.id,
      ]);
      await w.real.db.query(`ALTER TABLE audit_event ENABLE RULE audit_no_update`);

      const v = await w.fl.verifyAuditChain({ actorId: alice }, org);
      assert.equal(v.valid, false, 'a forked chain must not verify');
      assert.equal(v.problem, 'prev_hash_mismatch', 'and it is reported as a broken link');
      assert.equal(String(v.brokenAt), String(last.id), 'at the row that forked');
    } finally {
      await w.release();
    }
  });
});

// =============================================================================
// 4. CROSS-TENANT ISOLATION, UNDER LOAD
// =============================================================================

describe('contention: isolation does not degrade under load', () => {
  it('concurrent traffic in two tenants never crosses', async (t) => {
    if (!available) return t.skip('no PostgreSQL');
    const w = await world();
    try {
      const a = (await w.fl.createActor('a')).id;
      const b = (await w.fl.createActor('b')).id;
      const orgA = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: a })).id;
      const orgB = (await w.fl.createOrg('bcorp', 'B Corp', { ownerActorId: b })).id;
      const fA = await w.fl.upload({ actorId: a }, orgA, {
        name: 'a.txt', contentType: 'text/plain', body: bytes('A SECRET'),
      });
      const fB = await w.fl.upload({ actorId: b }, orgB, {
        name: 'b.txt', contentType: 'text/plain', body: bytes('B SECRET'),
      });

      const conns = await Promise.all(Array.from({ length: 6 }, () => w.real.connect()));
      try {
        const jobs: Promise<unknown>[] = [];
        for (let i = 0; i < 30; i++) {
          const fl = onConnection(conns[i % conns.length]!.q, w.storage);
          // Legitimate traffic in both tenants, plus each actor reaching for the
          // other's file, all at once.
          jobs.push(fl.read({ actorId: a }, fA.id));
          jobs.push(fl.read({ actorId: b }, fB.id));
          jobs.push(fl.read({ actorId: a }, fB.id).then(() => 'LEAK', () => 'denied'));
          jobs.push(fl.read({ actorId: b }, fA.id).then(() => 'LEAK', () => 'denied'));
        }
        const out = await Promise.all(jobs);
        assert.equal(out.filter((x) => x === 'LEAK').length, 0, 'no cross-tenant read, at any point');
      } finally {
        conns.forEach((c) => c.release());
      }
    } finally {
      await w.release();
    }
  });
});

async function owners(q: Queryable, org: string): Promise<number> {
  return ownersIn(q, org);
}

async function ownersIn(q: Queryable, org: string): Promise<number> {
  const { rows } = await q.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM membership m JOIN actor a ON a.id = m.actor_id
      WHERE m.org_id = $1 AND m.role = 'owner' AND a.deleted_at IS NULL`,
    [org],
  );
  return Number(rows[0]!.c);
}
