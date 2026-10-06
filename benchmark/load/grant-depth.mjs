#!/usr/bin/env node
/**
 * H4b, MADE RE-RUNNABLE: what does a read cost a subject who holds n grants?
 *
 *   node benchmark/load/grant-depth.mjs                 # the default ladder
 *   node benchmark/load/grant-depth.mjs 5 100 1000      # your own
 *
 * -----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * -----------------------------------------------------------------------------
 *
 * `RESULTS.md` records that a delegated read went from 4.32 ms at ~5 grants to
 * 5 911 ms at 100 000, and names the cause: `live_grant` applies
 * `grant_is_live(id)`, a recursive function declared `COST 100`, ONCE PER
 * MATCHING ROW.
 *
 * THE FULL BENCHMARK ALREADY EXISTS and already measures this:
 * `packages/core/dev/bench-load.ts`, `npm run bench:load`, H4b. An earlier
 * version of this comment claimed there was no runner, which was wrong and was
 * written after looking in `benchmark/load/` and concluding from an absence in
 * the wrong directory. Recorded here because the mistake is the one this
 * project keeps making in the other direction: a conclusion drawn from not
 * finding something where you looked.
 *
 * What this adds is narrower and faster. `bench:load` answers a page of
 * questions about concurrency and takes a seat; this answers one, on real
 * PostgreSQL, in about a minute, and prints a before/after table. It is the
 * thing to reach for while CHANGING the lookup, and `bench:load` is the thing
 * that settles the number afterwards.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT MEASURES, AND THE CONTROL THAT MAKES IT MEAN SOMETHING
 * -----------------------------------------------------------------------------
 *
 * Two reads per rung, and the second is the control:
 *
 *   * The DELEGATED read, by the subject whose grants accumulated. This is the
 *     one the cliff is supposed to be in.
 *   * The OWNER read, on the same file, in the same database, at the same
 *     moment. The owner is authorized by role and never looks at those grants,
 *     so this number must stay flat. If it climbs with n, the slowdown is
 *     something else -- table size, cache pressure, the machine being busy --
 *     and the delegated number proves nothing.
 *
 * That control is the whole reason to trust the result, and it is what
 * `RESULTS.md` was right to include.
 */

import { createRealDb, stopRealPostgres, probeRealPostgres } from '../../packages/core/test/real-postgres.ts';
import { Filelayer } from '../../packages/core/src/index.ts';
import { MemoryStorage } from '../../packages/core/src/storage.ts';

const LADDER = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0);
const RUNGS = LADDER.length ? LADDER : [5, 100, 500, 2000];
const SAMPLES = 25;

const probe = await probeRealPostgres();
if (!probe.ok) {
  console.error(`grant-depth: ${probe.why}`);
  process.exit(1);
}

/** Median, not mean: one scheduling hiccup should not move the headline. */
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function time(fn) {
  // One untimed pass: the first call of anything pays for plan caching and a
  // cold buffer, and that cost belongs to neither rung.
  await fn();
  const took = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    await fn();
    took.push(performance.now() - t0);
  }
  return median(took);
}

const rows = [];
for (const n of RUNGS) {
  const { db, close } = await createRealDb();
  try {
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://bench.test' });
    const owner = await fl.createActor('owner');
    const reader = await fl.createActor('reader');
    // The owner is seeded with the org, not added afterwards: an org with no
    // members has nobody who may add one, which is the correct refusal and
    // the first thing this harness got wrong.
    // `createOrg` returns the INTERNAL id, and that is what every other call
    // wants. Passing the external one gets `no_membership`, which is a correct
    // refusal about an org that does exist under a different key.
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: owner.id })).id;

    const file = await fl.upload({ actorId: owner.id }, org, {
      name: 'f.bin',
      contentType: 'application/octet-stream',
      body: new TextEncoder().encode('x'),
    });

    // n grants to the SAME subject on the SAME file, through the public API,
    // which is exactly how a retry loop or a nightly re-sync produces them.
    // `share()` does not dedupe, by design (see LIMITATIONS 2).
    for (let i = 0; i < n; i++) {
      await fl.share({ actorId: owner.id }, file.id, {
        subject: { type: 'actor', actorId: reader.id },
        capabilities: ['read'],
      });
    }

    // ANALYZE, AND IT IS NOT CHEATING. Without statistics the planner estimates
    // one row, decides a sort of one row is free, and never considers the index
    // that carries the order -- so the measurement is of a planner flying
    // blind, which is the state of no deployment that has been accumulating
    // grants for longer than a few seconds. A harness that inserts 500 rows in
    // two seconds and queries immediately is the unrealistic case, not this.
    //
    // Measured here on 6 October 2026, at 500 grants: 10.2 ms without, 0.21 ms
    // with, same query and same data. `RESULTS.md` already carries a section
    // saying to run it after a bulk load; this is the same advice with a number
    // on it.
    await db.query('ANALYZE file_grant');

    const live = await db.query(
      `SELECT count(*)::int AS n FROM live_grant WHERE file_id = $1 AND subject_id = $2`,
      [file.id, reader.id],
    );

    const delegated = await time(() => fl.stat({ actorId: reader.id }, file.id));
    const ownerRead = await time(() => fl.stat({ actorId: owner.id }, file.id));

    rows.push({ n, live: live.rows[0].n, delegated, ownerRead });
    console.error(`  ${String(n).padStart(6)} grants ... delegated ${delegated.toFixed(2)} ms`);
  } finally {
    await close();
  }
}

await stopRealPostgres();

const pad = (s, w) => String(s).padStart(w);
console.log('\n| grants | live rows | delegated read | owner read (control) | ratio |');
console.log('|---|---|---|---|---|');
const base = rows[0];
for (const r of rows) {
  console.log(
    `| ${pad(r.n, 6)} | ${pad(r.live, 9)} | ${pad(r.delegated.toFixed(2) + ' ms', 14)} ` +
      `| ${pad(r.ownerRead.toFixed(2) + ' ms', 20)} | ${pad((r.delegated / base.delegated).toFixed(1) + '×', 5)} |`,
  );
}

// The control, stated rather than left for the reader to spot. A delegated
// ratio that tracks the owner ratio is not a grant problem.
const ownerDrift = rows[rows.length - 1].ownerRead / base.ownerRead;
const delegatedDrift = rows[rows.length - 1].delegated / base.delegated;
console.log(
  `\nowner read drifted ${ownerDrift.toFixed(2)}× across the ladder; ` +
    `the delegated read drifted ${delegatedDrift.toFixed(2)}×.`,
);
// THE VERDICT COMPARES THE TWO DRIFTS, which is what the control is actually
// for. An earlier version failed the run whenever the owner read moved more
// than 1.5x, and that was the wrong rule: at 2 000 grants both reads slowed by
// a similar small amount, because the table is bigger, and the run was called
// invalid when it was showing exactly the result we wanted -- a delegated cost
// that no longer tracks the grant count.
//
// What matters is whether the delegated read drifted MORE than the general
// overhead did. If the two move together, the cost is not grant-specific.
const excess = delegatedDrift / ownerDrift;
console.log(
  excess > 2
    ? `CLIFF PRESENT: the delegated read drifted ${excess.toFixed(1)}x more than the general overhead.`
    : `No grant-specific cliff: the delegated read drifted ${excess.toFixed(2)}x relative to the ` +
      'general overhead, so what moved is the machine and the table, not the grant count.',
);
