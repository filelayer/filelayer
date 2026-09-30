/**
 * THE AUTHORIZATION HOT PATH READS THROUGH AN INDEX, AND KEEPS READING THROUGH ONE.
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS FILE EXISTS TO PREVENT
 * -----------------------------------------------------------------------------
 *
 * Found by audit, 2026-09-29, in the published 0.5.0 and in every release before
 * it. `file_grant` carries six indexes, five of them PARTIAL on
 * `revoked_at IS NULL`. Not one query in `store.ts` could use any of them.
 *
 * A partial index is only usable by a query whose predicate the planner can
 * prove implies the index predicate. Every grant lookup reads `live_grant`,
 * which was `SELECT * FROM file_grant WHERE grant_is_live(id)` -- and a function
 * call is opaque, so `revoked_at IS NULL` was unprovable. `findGrantBySecret`,
 * which reads `file_grant` directly, simply never stated it.
 *
 * The consequence was not only a sequential scan. On the `live_grant` paths the
 * planner evaluated `grant_is_live(id)` -- a RECURSIVE CTE declared COST 100 --
 * once per candidate row. `getActorGrants` was not even a seq scan: it used the
 * composite unique key, read every grant on the file, and called the function on
 * all of them. That is more expensive than a seq scan, not less.
 *
 * The worst of it is which request paid. `redeemStream` resolves a link secret
 * to a file BEFORE authorizing anything, because a revoked link has to reach the
 * engine for its denial to be attributed to the right tenant. So the table scan
 * sat on the one path an unauthenticated caller reaches by sending `GET
 * /d/<secret>` -- and it grew with the number of grants in the database.
 *
 * -----------------------------------------------------------------------------
 * WHY A TEST AND NOT A BENCHMARK
 * -----------------------------------------------------------------------------
 *
 * A wall-clock threshold on PGlite in WASM would be a flaky test that measures
 * the machine. What is stable, and what actually regressed, is the SHAPE OF THE
 * PLAN: whether the access path is an index, and whether rows reach the filter
 * that an index should already have discarded. `Rows Removed by Filter` is the
 * number that was six thousand and should be zero, and it does not depend on how
 * fast anything is.
 *
 * The suite is built so that reverting either half of the fix fails it, and the
 * last test proves that by doing exactly that.
 *
 * NOTE ON GENERALITY. PGlite is Postgres 17, so the planner here is the real
 * one. But an index is a COST decision: on a table of twelve rows a seq scan is
 * correctly cheaper, and no amount of indexing changes that. So the corpus is
 * large enough that the index is the right answer, and `enable_seqscan = off` is
 * used where the question is whether an index is USABLE AT ALL rather than
 * whether it was chosen. Those are different failures and only the first one is
 * a defect.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';

/** The view as it shipped through 0.5.0, for the negative control. */
const OLD_VIEW = `CREATE OR REPLACE VIEW live_grant AS
                  SELECT * FROM file_grant WHERE grant_is_live(id)`;
const NEW_VIEW = `CREATE OR REPLACE VIEW live_grant AS
                  SELECT * FROM file_grant WHERE revoked_at IS NULL AND grant_is_live(id)`;

interface Corpus {
  db: Queryable;
  fileId: string;
  otherFileId: string;
  alice: string;
  stranger: string;
  orgId: string;
  anonGrantId: string;
  total: number;
}

/**
 * A file that has been shared for a while: many link grants, a tenth of them
 * revoked, plus the anonymous and actor grants the read path looks for. This is
 * the shape that made the defect expensive -- not an unusual database, just one
 * that has been used.
 */
async function corpus(linkGrants = 4000): Promise<Corpus> {
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://files.example.test' });

  const alice = (await fl.createActor('alice')).id;
  const stranger = (await fl.createActor('stranger')).id;
  const orgId = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;

  const mk = async (name: string) =>
    (await fl.upload({ actorId: alice }, orgId, {
      name,
      contentType: 'application/pdf',
      body: new TextEncoder().encode(name),
    })).id;
  const fileId = await mk('shared.pdf');
  const otherFileId = await mk('other.pdf');

  await db.query(
    `INSERT INTO file_grant (file_id, org_id, subject_type, secret_hash, capabilities,
                             created_by, revoked_at)
     SELECT CASE WHEN g % 4 = 0 THEN $4::uuid ELSE $1::uuid END,
            $2, 'link', md5(g::text), ARRAY['read']::grant_capability[], $3,
            CASE WHEN g % 10 = 0 THEN now() ELSE NULL END
       FROM generate_series(1, $5::int) g`,
    [fileId, orgId, alice, otherFileId, linkGrants],
  );

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities, created_by)
     VALUES ($1, $2, 'anonymous', ARRAY['read']::grant_capability[], $3)
     RETURNING id`,
    [fileId, orgId, alice],
  );
  const anonGrantId = rows[0]!.id;

  await db.query(
    `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities, created_by)
     VALUES ($1, $2, 'actor', $3, ARRAY['read']::grant_capability[], $4)`,
    [fileId, orgId, stranger, alice],
  );

  // Without statistics the planner is guessing, and a guess is not evidence of
  // anything. This is what a deployed database has and a fresh test does not.
  await db.query('ANALYZE');

  const total = Number(
    (await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM file_grant`)).rows[0]!.c,
  );
  return { db, fileId, otherFileId, alice, stranger, orgId, anonGrantId, total };
}

interface Plan {
  text: string;
  seqScan: boolean;
  indexes: string[];
  rowsFiltered: number;
}

async function plan(db: Queryable, sql: string, params: unknown[]): Promise<Plan> {
  const { rows } = await db.query<Record<string, string>>(
    `EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) ${sql}`,
    params,
  );
  const text = rows.map((r) => r['QUERY PLAN'] ?? '').join('\n');
  return {
    text,
    seqScan: /Seq Scan on file_grant/.test(text),
    indexes: [...text.matchAll(/Index (?:Only )?Scan (?:using )?(\S+)/g)].map((m) => m[1]!),
    // Summed: a plan can filter at more than one node.
    rowsFiltered: [...text.matchAll(/Rows Removed by Filter: (\d+)/g)]
      .reduce((n, m) => n + Number(m[1]), 0),
  };
}

/**
 * The four lookups, verbatim from `store.ts`. Copied rather than called so that
 * this file asserts about SQL rather than about a method's return value -- the
 * defect was invisible from the return value, which is why it survived four
 * releases of a suite that tests behaviour exhaustively.
 */
const LOOKUPS = (c: Corpus): { name: string; sql: string; params: unknown[] }[] => [
  {
    name: 'findGrantBySecret (pre-authorization, and deliberately not live)',
    sql: `SELECT * FROM file_grant
           WHERE subject_type = 'link' AND secret_hash = $1
           LIMIT 1`,
    params: ['0000000000000000000000000000dead'],
  },
  {
    name: 'findLiveGrantBySecret',
    sql: `SELECT * FROM live_grant
           WHERE subject_type = 'link' AND secret_hash = $1
           LIMIT 1`,
    params: ['0000000000000000000000000000dead'],
  },
  {
    name: 'getActorGrants',
    sql: `SELECT * FROM live_grant
           WHERE file_id = $1 AND subject_type = 'actor' AND subject_id = $2
           ORDER BY created_at ASC, id ASC`,
    params: [] as unknown[],
  },
  {
    name: 'getAnonymousGrant',
    sql: `SELECT * FROM live_grant
           WHERE file_id = $1 AND subject_type = 'anonymous'
           ORDER BY created_at ASC
           LIMIT 1`,
    params: [] as unknown[],
  },
].map((q) => ({
  ...q,
  params: q.params.length ? q.params : q.name === 'getActorGrants' ? [c.fileId, c.stranger] : [c.fileId],
}));

describe('the authorization hot path is reached through an index', () => {
  it('no grant lookup sequentially scans file_grant', async () => {
    const c = await corpus();
    for (const q of LOOKUPS(c)) {
      const p = await plan(c.db, q.sql, q.params);
      assert.equal(
        p.seqScan,
        false,
        `${q.name} sequentially scans file_grant (${c.total} rows).\n${p.text}`,
      );
      assert.ok(p.indexes.length > 0, `${q.name} uses no index at all.\n${p.text}`);
    }
  });

  it('no grant lookup filters rows an index should have discarded', async () => {
    const c = await corpus();
    for (const q of LOOKUPS(c)) {
      const p = await plan(c.db, q.sql, q.params);
      // Zero, not "a few". Every one of these queries is selective enough on its
      // indexed columns that reaching the filter at all means the index was not
      // doing the work. This is the number that was 6000.
      assert.equal(
        p.rowsFiltered,
        0,
        `${q.name} discarded ${p.rowsFiltered} row(s) at the filter, out of ${c.total}. ` +
          `Each one also paid for grant_is_live(), a recursive CTE at COST 100.\n${p.text}`,
      );
    }
  });

  it('the partial indexes are USABLE, not merely sometimes chosen', async () => {
    // A cost decision can go either way on a given corpus; usability cannot.
    // With seqscan disabled, a plan that still scans means the planner had no
    // index it was ALLOWED to use -- which is the defect, independent of size.
    const c = await corpus();
    await c.db.query('SET enable_seqscan = off');
    try {
      for (const q of LOOKUPS(c)) {
        const p = await plan(c.db, q.sql, q.params);
        assert.equal(
          p.seqScan,
          false,
          `${q.name} scans even with enable_seqscan=off, so no index is usable by it ` +
            `at any table size.\n${p.text}`,
        );
      }
    } finally {
      await c.db.query('SET enable_seqscan = on');
    }
  });

  it('the secret lookup is indexed ACROSS revoked grants, which is what the audit trail needs', async () => {
    // grant_secret_idx is deliberately not partial on revoked_at. If someone
    // "tidies" it to match the others, the pre-authorization path -- the one an
    // unauthenticated caller reaches -- goes back to scanning.
    const c = await corpus();
    const { rows } = await c.db.query<{ hash: string }>(
      `SELECT secret_hash AS hash FROM file_grant
        WHERE revoked_at IS NOT NULL AND secret_hash IS NOT NULL LIMIT 1`,
    );
    const revokedSecret = rows[0]!.hash;

    const p = await plan(
      c.db,
      `SELECT * FROM file_grant WHERE subject_type = 'link' AND secret_hash = $1 LIMIT 1`,
      [revokedSecret],
    );
    assert.equal(p.seqScan, false, `a REVOKED secret is not reachable by index.\n${p.text}`);

    // And it still resolves, because attribution depends on it.
    const found = await c.db.query(
      `SELECT id FROM file_grant WHERE subject_type = 'link' AND secret_hash = $1`,
      [revokedSecret],
    );
    assert.equal(found.rows.length, 1, 'a revoked grant must still be findable by its secret');
    const live = await c.db.query(`SELECT id FROM live_grant WHERE secret_hash = $1`, [revokedSecret]);
    assert.equal(live.rows.length, 0, 'and it must not be live');
  });
});

describe('the faster live_grant is the same live_grant', () => {
  it('returns exactly the rows the 0.5.0 definition returned', async () => {
    const c = await corpus(1200);

    const idsOf = async (sql: string) =>
      new Set(
        (await c.db.query<{ id: string }>(sql)).rows.map((r) => r.id),
      );

    const shipped = await idsOf(`SELECT id FROM live_grant ORDER BY id`);
    // The predicate the new view is supposed to be equivalent to.
    const byFunction = await idsOf(`SELECT id FROM file_grant WHERE grant_is_live(id) ORDER BY id`);
    // And the INDEPENDENT top-down formulation the schema already carries, which
    // shares no code with grant_is_live at all.
    const recursive = await idsOf(`SELECT id FROM live_grant_recursive ORDER BY id`);

    assert.ok(shipped.size > 0, 'the corpus produced no live grants, so this proves nothing');
    assert.deepEqual([...shipped].sort(), [...byFunction].sort(), 'view disagrees with grant_is_live');
    assert.deepEqual([...shipped].sort(), [...recursive].sort(), 'view disagrees with live_grant_recursive');
  });

  it('still excludes every revoked grant, which is the conjunct that was added', async () => {
    const c = await corpus(1200);
    const { rows } = await c.db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM live_grant WHERE revoked_at IS NOT NULL`,
    );
    assert.equal(rows[0]!.c, '0');

    const revoked = await c.db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM file_grant WHERE revoked_at IS NOT NULL`,
    );
    assert.notEqual(revoked.rows[0]!.c, '0', 'the corpus has no revoked grants, so this is vacuous');
  });

  it('agrees on a corpus of DEEP DELEGATION CHAINS with revocations part-way up', async () => {
    // The flat corpus above cannot distinguish the two view definitions, because
    // a link grant has no ancestors and `revoked_at IS NULL` is then trivially
    // the whole of `self_live`. Liveness is RECURSIVE: a child that is not itself
    // revoked is dead if any ancestor is. That is where a misplaced conjunct
    // would diverge, so that is what this builds.
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://files.example.test' });

    const alice = (await fl.createActor('alice')).id;
    const orgId = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;

    const file = await fl.upload({ actorId: alice }, orgId, {
      name: 'chained.pdf',
      contentType: 'application/pdf',
      body: new TextEncoder().encode('x'),
    });

    // Eight independent chains, each five deep, each with its OWN actors.
    //
    // Fresh actors per chain matter: `share()` delegates from the OLDEST grant
    // the issuer holds, deterministically. Reuse a holder across two chains and
    // the second chain silently hangs off the first one's grant -- which is how
    // the first version of this test ended up trying to delegate from a grant it
    // had already revoked, and failed with `grant_parent_not_live`.
    const chains: string[][] = [];
    for (let c = 0; c < 8; c++) {
      const chain: string[] = [];
      let issuer = alice;
      for (let depth = 0; depth < 5; depth++) {
        const to = (await fl.createActor(`c${c}d${depth}`)).id;
        await fl.addMember({ actorId: alice }, orgId, to, 'member');
        const g = await fl.share({ actorId: issuer }, file.id, {
          subject: { type: 'actor', actorId: to },
          capabilities: ['read', 'share'],
        });
        chain.push(g.grantId);
        issuer = to;
      }
      chains.push(chain);
    }

    // Kill exactly one grant per chain, at a different depth each time, by a
    // different one of the three terms of `self_live`. Every chain mutated above
    // its leaf then contains the case this test exists for: a grant that is NOT
    // itself revoked and is NOT live, because an ancestor died.
    //
    // ONE MUTATION PER CHAIN, AND WHY. `file_grant_attenuation` is a
    // BEFORE INSERT OR UPDATE trigger, and it refuses any write to a row whose
    // parent is not live (schema.sql:926). So a second UPDATE inside a chain that
    // has already been broken above that point fails with
    // `grant_parent_not_live` -- which is the schema being right and the first
    // draft of this test being careless. Confining each chain to one mutation
    // makes that structurally impossible rather than accidentally avoided.
    const kill: [chain: number, depth: number, how: 'revoke' | 'expire' | 'exhaust'][] = [
      [0, 0, 'revoke'],   // the root: the whole chain below it dies
      [1, 1, 'revoke'],
      [2, 3, 'revoke'],
      [3, 4, 'revoke'],   // the leaf: nothing below it, so only itself dies
      [4, 0, 'expire'],
      [5, 2, 'expire'],
      [6, 0, 'exhaust'],
      [7, 3, 'exhaust'],
    ];
    for (const [c, depth, how] of kill) {
      const id = chains[c]![depth]!;
      const sql =
        how === 'revoke' ? `UPDATE file_grant SET revoked_at = now() WHERE id = $1`
        : how === 'expire' ? `UPDATE file_grant SET expires_at = now() - interval '1 hour' WHERE id = $1`
        : `UPDATE file_grant SET max_downloads = 1, download_count = 1 WHERE id = $1`;
      await db.query(sql, [id]);
    }
    await db.query('ANALYZE');

    const ids = async (sql: string) =>
      (await db.query<{ id: string }>(sql)).rows.map((r) => r.id).sort();

    const shipped = await ids(`SELECT id FROM live_grant`);
    const byFunction = await ids(`SELECT id FROM file_grant WHERE grant_is_live(id)`);
    const recursive = await ids(`SELECT id FROM live_grant_recursive`);

    const total = Number(
      (await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM file_grant`)).rows[0]!.c,
    );
    // The corpus has to contain the interesting case or this proves nothing: a
    // grant that is NOT itself revoked and is NOT live, because an ancestor died.
    const { rows: interesting } = await db.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM file_grant
        WHERE revoked_at IS NULL AND NOT grant_is_live(id)`,
    );
    assert.ok(
      Number(interesting[0]!.c) > 0,
      'no grant in this corpus is dead-by-ancestor, so it cannot distinguish the two views',
    );
    assert.ok(shipped.length > 0 && shipped.length < total, `degenerate corpus: ${shipped.length}/${total}`);

    assert.deepEqual(shipped, byFunction, 'the view disagrees with grant_is_live over delegation chains');
    assert.deepEqual(shipped, recursive, 'the view disagrees with live_grant_recursive over delegation chains');
  });

  it('a revoked grant is still refused through the real engine, not just the view', async () => {
    // The view is an implementation detail; this is the property a user has.
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://files.example.test' });
    const alice = (await fl.createActor('alice')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
    const file = await fl.upload({ actorId: alice }, org, {
      name: 'secret.pdf',
      contentType: 'application/pdf',
      body: new TextEncoder().encode('ACME CONFIDENTIAL'),
    });
    const link = await fl.share({ actorId: alice }, file.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
    });

    const ok = await fl.redeem(link.secret!, {});
    assert.equal(new TextDecoder().decode(ok.body), 'ACME CONFIDENTIAL');

    await fl.revoke({ actorId: alice }, link.grantId);
    await assert.rejects(() => fl.redeem(link.secret!, {}), /404|not_found/);
  });
});

describe('the plan-shape assertions can fail', () => {
  it('NEGATIVE CONTROL: restoring the 0.5.0 view brings the table scans back', async () => {
    const c = await corpus();

    // Sanity: green before.
    for (const q of LOOKUPS(c)) {
      const p = await plan(c.db, q.sql, q.params);
      assert.equal(p.rowsFiltered, 0, `${q.name} was already filtering before the control ran`);
    }

    await c.db.query(OLD_VIEW);
    await c.db.query('ANALYZE');
    try {
      const regressed = [];
      for (const q of LOOKUPS(c)) {
        if (q.name.startsWith('findGrantBySecret')) continue; // does not read the view
        const p = await plan(c.db, q.sql, q.params);
        if (p.seqScan || p.rowsFiltered > 0) regressed.push(`${q.name} (filtered ${p.rowsFiltered})`);
      }
      assert.ok(
        regressed.length >= 2,
        'the old view definition did NOT regress the plans, so these assertions would ' +
          `not have caught the defect. Regressed: ${regressed.join(', ') || 'none'}`,
      );
    } finally {
      await c.db.query(NEW_VIEW);
    }
  });

  it('NEGATIVE CONTROL: making grant_secret_idx partial again breaks the pre-auth path', async () => {
    const c = await corpus();
    await c.db.query('DROP INDEX grant_secret_idx');
    await c.db.query(
      `CREATE INDEX grant_secret_idx ON file_grant (secret_hash)
        WHERE revoked_at IS NULL AND secret_hash IS NOT NULL`,
    );
    await c.db.query('ANALYZE');
    try {
      const p = await plan(
        c.db,
        `SELECT * FROM file_grant WHERE subject_type = 'link' AND secret_hash = $1 LIMIT 1`,
        ['0000000000000000000000000000dead'],
      );
      assert.equal(
        p.seqScan,
        true,
        'a partial grant_secret_idx did not reintroduce the scan, so the non-partial ' +
          `index is not what is keeping the pre-authorization path fast.\n${p.text}`,
      );
    } finally {
      await c.db.query('DROP INDEX grant_secret_idx');
      await c.db.query(
        `CREATE INDEX grant_secret_idx ON file_grant (secret_hash) WHERE secret_hash IS NOT NULL`,
      );
    }
  });
});
