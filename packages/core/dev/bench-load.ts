/**
 * LOAD BENCHMARK: what an authorized read costs, and where it stops scaling.
 *
 *     npm run bench:load
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHAT WAS HERE BEFORE IT
 * -----------------------------------------------------------------------------
 *
 * `TRUST.md` and the README both say the same thing about load: nobody has
 * pointed any at this. Two things already existed and neither closed that gap:
 *
 *   - `dev/bench-authz.ts` times `authorize()` SEQUENTIALLY on PGlite, which is
 *     PostgreSQL compiled to WebAssembly with a single backend. Its own header
 *     says the milliseconds are meaningless and only the ratios matter. It
 *     cannot observe contention, because on one backend there is none.
 *   - `test/performance.test.ts` asserts with `EXPLAIN` that the hot path uses
 *     its indexes and does not sequentially scan `file_grant`. That is a PLAN
 *     assertion. A query can use a perfect index and still be the wrong shape
 *     under concurrency.
 *
 * So this is not a faster version of either. It is the first measurement of
 * concurrent behaviour against a real native PostgreSQL with a real connection
 * pool.
 *
 * -----------------------------------------------------------------------------
 * IT TESTS FOUR CLAIMS THIS CODEBASE ALREADY MAKES ABOUT ITSELF
 * -----------------------------------------------------------------------------
 *
 * Deliberately not "how many requests per second can Filelayer do", which is a
 * number with no denominator and no decision attached to it. Each scenario below
 * exists because some comment in `src/` asserts something a measurement can
 * contradict.
 *
 * H1. THE ROUND-TRIP COUNT IS THE LATENCY. An authorized read is several
 *     statements, and on a remote database the count matters more than any of
 *     them individually. Nothing has ever counted them. Reported per operation,
 *     alongside the times, so a reader can predict their own latency from their
 *     own network rather than from ours.
 *
 * H2. A ROLE-DERIVED READ IS CHEAPER THAN A GRANT-DERIVED ONE, because
 *     `#reserve` charges the download counter only when authority came through a
 *     grant. That is a documented asymmetry and it should be visible.
 *
 * H3. THE SINGLE-ROW WRITE HOTSPOT IS REAL. `filelayer.ts` says, in the comment
 *     on `#reserve`:
 *
 *         "for a TIER-1 PUBLIC ASSET, where one anonymous grant row serves
 *          every request, that single row becomes a write hotspot under load.
 *          It is a scalability problem, not a correctness one ... flagged so
 *          the trade is made deliberately when volume forces it."
 *
 *     That was written from reasoning, not measurement. If it is true, the
 *     anonymous-read scenario stops scaling with concurrency while the owner
 *     read keeps going. If it is false, the comment is wrong and should say so.
 *
 * H4. GRANT VOLUME DOES NOT CHANGE THE COST OF A READ. Liveness is a recursive
 *     CTE over a delegation chain, and `file_grant` grows forever. The indexes
 *     say this is bounded by chain depth rather than by table size; this checks
 *     it at 100, 10_000 and 100_000 grants.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT CANNOT SEE, stated so nobody quotes it for something it did not do
 * -----------------------------------------------------------------------------
 *
 *   - Byte delivery. Storage is `FsStorage` on a local disk, so object-store
 *     latency is excluded ON PURPOSE: this measures the decision, not S3. A real
 *     deployment adds one round trip to the store on top of every number here.
 *   - The network. Driver, pool and database are one machine. A managed Postgres
 *     adds its RTT once per statement in the H1 column.
 *   - Any HTTP framework. It drives `fl.readStream()` directly, so there is no
 *     router, no TLS and no JSON serialisation in these numbers.
 *   - Sustained load. Each scenario runs for seconds. Connection leaks, memory
 *     growth and vacuum pressure need hours and are not measured here.
 *
 * A number from this file is a floor on latency and a ceiling on throughput.
 */

import { hrtime } from 'node:process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { createRealDb, realPostgresAvailable, stopRealPostgres } from '../test/real-postgres.ts';
import { Filelayer } from '../src/filelayer.ts';
import { FsStorage } from '../src/storage.ts';
import type { Queryable } from '../src/db.ts';

const DURATION_MS = Number(process.env['BENCH_MS'] ?? 3000);
const CONCURRENCIES = (process.env['BENCH_CONC'] ?? '1,8,32,64').split(',').map(Number);
const enc = (s: string) => new TextEncoder().encode(s);

if (!(await realPostgresAvailable())) {
  console.error(
    'bench:load needs a real PostgreSQL. `embedded-postgres` is a devDependency and\n' +
      'starts one as an ordinary user process; see test/real-postgres.ts for how the\n' +
      'engine is chosen. PGlite is deliberately NOT a fallback here: it has one\n' +
      'backend, so every concurrency column would measure the same serial path.',
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Measurement
// -----------------------------------------------------------------------------

/** Counts statements so H1 is a count rather than an inference from the clock. */
function counting(db: Queryable): { db: Queryable; reset: () => void; count: () => number } {
  let n = 0;
  return {
    db: {
      async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
        n++;
        return db.query<R>(sql, params);
      },
    },
    reset: () => {
      n = 0;
    },
    count: () => n,
  };
}

interface Sample {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  ops: number;
  rps: number;
  errors: number;
}

function summarise(latencies: number[], elapsedMs: number, errors: number): Sample {
  const s = [...latencies].sort((a, b) => a - b);
  const at = (q: number) => (s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(s.length * q))]!);
  return {
    p50: +at(0.5).toFixed(3),
    p95: +at(0.95).toFixed(3),
    p99: +at(0.99).toFixed(3),
    max: +(s[s.length - 1] ?? 0).toFixed(3),
    ops: s.length,
    rps: Math.round((s.length / elapsedMs) * 1000),
    errors,
  };
}

/**
 * CLOSED LOOP: `concurrency` workers, each issuing one operation at a time for
 * `DURATION_MS`. Not an open loop with a fixed arrival rate -- that measures
 * queueing, and what is wanted here is the service time at a known level of
 * parallelism, which is the thing a pool size has to be chosen against.
 */
async function drive(
  concurrency: number,
  op: () => Promise<unknown>,
): Promise<Sample> {
  const latencies: number[] = [];
  let errors = 0;
  const deadline = hrtime.bigint() + BigInt(DURATION_MS) * 1_000_000n;

  const worker = async (): Promise<void> => {
    for (;;) {
      const t0 = hrtime.bigint();
      if (t0 >= deadline) return;
      try {
        await op();
        latencies.push(Number(hrtime.bigint() - t0) / 1e6);
      } catch {
        errors++;
      }
    }
  };

  const started = hrtime.bigint();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = Number(hrtime.bigint() - started) / 1e6;
  return summarise(latencies, elapsed, errors);
}

// -----------------------------------------------------------------------------
// The world
// -----------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'filelayer-bench-'));
// Pool larger than the top concurrency, so a saturated pool is never mistaken
// for a saturated database. If the pool were the bottleneck every scenario
// would flatten at the same place and the result would say nothing.
const real = await createRealDb({ max: Math.max(...CONCURRENCIES) + 8 });
const storage = new FsStorage(root);
const counter = counting(real.db);
const fl = new Filelayer(counter.db, storage, { baseUrl: 'http://bench.invalid' });

process.stdout.write('building the corpus... ');
const owner = (await fl.createActor('bench-owner')).id;
const reader = (await fl.createActor('bench-reader')).id;
const org = (await fl.createOrg('bench-org', 'Bench', { ownerActorId: owner })).id;
await fl.addMember({ actorId: owner }, org, reader, 'member');

const file = await fl.upload({ actorId: owner }, org, {
  name: 'bench.bin',
  contentType: 'application/octet-stream',
  body: enc('x'.repeat(1024)),
});

// H3's subject: ONE anonymous grant row, serving every anonymous read. This is
// the tier-1 public asset shape the comment in `#reserve` is about.
await fl.share({ actorId: owner }, file.id, { subject: { type: 'anonymous' } });

// An uncapped actor grant, so the grant path is measured without a cap binding.
await fl.share({ actorId: owner }, file.id, {
  subject: { type: 'actor', actorId: reader },
  capabilities: ['read'],
});

// A delegation chain, for the depth column.
const deep = await fl.createActor('bench-deep');
let issuer: { actorId: string } = { actorId: owner };
let last = '';
for (let i = 0; i < 5; i++) {
  const r = await fl.share(issuer, file.id, {
    subject: { type: 'actor', actorId: deep.id },
    capabilities: ['read', 'share'],
  });
  last = r.grantId;
  issuer = { actorId: deep.id };
}
void last;
console.log('done');

const grantCount = async (): Promise<number> =>
  Number(
    (await real.db.query<{ c: string }>('SELECT count(*)::text c FROM file_grant')).rows[0]!.c,
  );

/**
 * Bulk-insert noise grants, in one of two SHAPES, and the distinction is the
 * whole of H4.
 *
 * 'spread'      — one grant each to many distinct subjects. The table grows and
 *                 no single (file_id, subject_id) pair accumulates. This is what
 *                 ordinary growth looks like.
 * 'concentrated' — every grant on the SAME (file_id, subject_id) pair the `deep`
 *                 scenario reads. This is what repeated re-sharing of one file
 *                 with one person looks like, and nothing in the API dedupes it.
 *
 * The first measurement of this benchmark used only 'concentrated' and reported
 * a read going from 12 ms to 6 seconds. That number was real and the conclusion
 * drawn from it would have been wrong: it was attributed to table size, which
 * these two shapes exist to separate.
 */
async function padGrants(shape: 'spread' | 'concentrated', target: number): Promise<number> {
  const have = await grantCount();
  if (have >= target) return have;
  const n = target - have;
  process.stdout.write(`  +${n.toLocaleString()} ${shape} grants... `);
  if (shape === 'concentrated') {
    await real.db.query(
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities, created_by)
       SELECT $1, $2, 'actor', $3, ARRAY['read']::grant_capability[], $4
         FROM generate_series(1, $5)`,
      [file.id, org, deep.id, owner, n],
    );
  } else {
    // Distinct subjects, so nothing lands on the pair under test. The actors
    // have to exist first: `file_grant.subject_id` is checked against `actor`.
    await real.db.query(
      `WITH new_actors AS (
         INSERT INTO actor (external_id)
         SELECT 'noise-' || g || '-' || $2::text FROM generate_series(1, $1) g
         RETURNING id
       )
       INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities, created_by)
       SELECT $3, $4, 'actor', a.id, ARRAY['read']::grant_capability[], $5 FROM new_actors a`,
      [n, Date.now(), file.id, org, owner],
    );
  }
  // ANALYZE, AND THE FIRST VERSION OF THIS FILE DID NOT DO IT.
  //
  // Without it this harness measures the PLANNER'S IGNORANCE, not the system.
  // Bulk-inserting 100_000 grants and reading immediately left `pg_statistic`
  // believing the table had a handful of rows, so the planner chose
  // `grant_file_subject_type_idx` -- (file_id, subject_type) -- and applied
  // `subject_id` and the COST 100 `grant_is_live(id)` as a FILTER over every
  // actor grant on the file. Measured: 23.0 ms median. One `ANALYZE` later the
  // planner picks `grant_subject_idx`, reads five rows, and the same call takes
  // 1.82 ms.
  //
  // The 12.6x was real and the conclusion it invited was false: it is a
  // statistics artefact, not a scaling property of the schema. That distinction
  // is the whole reason this line exists and the reason it is commented rather
  // than quietly added -- a load harness that reports the planner's cold-start
  // as the product's throughput is worse than no harness, because it produces
  // numbers somebody will act on.
  await real.db.query('ANALYZE file_grant');
  const total = await grantCount();
  console.log(`${total.toLocaleString()} rows`);
  return total;
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

const read = (actorId: string | null) => async () => {
  const d = await fl.readStream({ actorId }, file.id, { mode: 'proxy' });
  if (d.mode === 'proxy') await d.body.cancel();
};

/** H1: statements per operation, measured on a single quiet call. */
async function roundTrips(label: string, op: () => Promise<unknown>): Promise<number> {
  await op();
  counter.reset();
  await op();
  const n = counter.count();
  console.log(`  ${label.padEnd(34)} ${n} statement(s)`);
  return n;
}

const results: Record<string, unknown> = {
  recordedAt: new Date().toISOString(),
  durationMsPerCell: DURATION_MS,
  concurrencies: CONCURRENCIES,
  engine: 'embedded-postgres (native backend), FsStorage on tmpdir, one machine',
  node: process.version,
};

console.log('\nH1 — round trips per authorized read');
results['roundTrips'] = {
  ownerRead: await roundTrips('owner read (role-derived)', read(owner)),
  grantRead: await roundTrips('member read via actor grant', read(reader)),
  anonymousRead: await roundTrips('anonymous read via public grant', read(null)),
};

console.log('\nH2/H3 — latency and throughput by concurrency');
const scenarios: { key: string; label: string; op: () => Promise<unknown> }[] = [
  { key: 'owner', label: 'owner read (no grant, no charge)', op: read(owner) },
  { key: 'grant', label: 'actor grant (charges the counter)', op: read(reader) },
  { key: 'anonymous', label: 'ONE anonymous grant row, shared', op: read(null) },
  { key: 'deep', label: 'delegation depth 5', op: read(deep.id) },
];

const byConcurrency: Record<string, Record<number, Sample>> = {};
for (const s of scenarios) {
  byConcurrency[s.key] = {};
  for (const c of CONCURRENCIES) {
    const r = await drive(c, s.op);
    byConcurrency[s.key]![c] = r;
    console.log(
      `  ${s.label.padEnd(34)} c=${String(c).padStart(2)}  ` +
        `p50 ${String(r.p50).padStart(7)}ms  p99 ${String(r.p99).padStart(8)}ms  ` +
        `${String(r.rps).padStart(5)} ops/s` +
        (r.errors ? `  ERRORS ${r.errors}` : ''),
    );
  }
}
results['byConcurrency'] = byConcurrency;

/**
 * H4, in two halves. Same concurrency for every cell so the columns compare.
 */
const CONC_H4 = 8;
const measure = async (
  shape: string,
  total: number,
  keys: readonly ('owner' | 'anonymous' | 'deep')[],
): Promise<Record<string, Sample>> => {
  const out: Record<string, Sample> = {};
  for (const key of keys) {
    const s = scenarios.find((x) => x.key === key)!;
    const r = await drive(CONC_H4, s.op);
    out[key] = r;
    console.log(
      `  ${shape.padEnd(13)} ${total.toLocaleString().padStart(7)} grants  ${key.padEnd(10)}` +
        `p50 ${String(r.p50).padStart(9)}ms  p99 ${String(r.p99).padStart(9)}ms  ` +
        `${String(r.rps).padStart(5)} ops/s`,
    );
  }
  return out;
};

console.log(`\nH4a — table size, grants SPREAD across distinct subjects (c=${CONC_H4})`);
const spread: Record<number, Record<string, Sample>> = {};
for (const target of [100, 10_000, 100_000]) {
  const total = await padGrants('spread', target);
  spread[total] = await measure('spread', total, ['owner', 'anonymous', 'deep']);
}

console.log(`\nH4b — the same table size CONCENTRATED on the pair being read (c=${CONC_H4})`);
const concentrated: Record<number, Record<string, Sample>> = {};
{
  // Start from the spread table and add concentrated rows on top, so the only
  // variable between H4a's last row and H4b's rows is where the grants point.
  const base = await grantCount();
  for (const add of [1_000, 10_000, 100_000]) {
    const total = await padGrants('concentrated', base + add);
    concentrated[total] = await measure('concentrated', total, ['owner', 'deep']);
  }
}
results['byGrantVolume'] = { spread, concentrated, concurrency: CONC_H4 };

const out = join(import.meta.dirname, '..', '..', '..', 'benchmark', 'load', 'results.json');
await writeFile(out, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`\nwrote ${out}`);

await real.close();
await stopRealPostgres();
await rm(root, { recursive: true, force: true });
