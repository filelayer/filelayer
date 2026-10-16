#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `background-jobs-for-user-files.md`, REPRODUCIBLE.
 *
 *     node docs/guides/background-jobs-for-user-files.proof.mjs
 *
 * It needs nothing installed and no server running: `embedded-postgres` starts
 * a real PostgreSQL as an ordinary user process. A real one, because step 1 is
 * a race between a collector and a client finishing their upload, and TWO
 * BACKENDS is the whole point -- on a single-backend engine the losing version
 * and the correct one behave identically and the data loss never appears.
 *
 * What it demonstrates, in order:
 *
 *   1. The collector that deletes a file the user just finished uploading.
 *      SELECT-then-DELETE against a client completing in the window, then the
 *      same race against the DELETE that repeats its predicates.
 *   2. `job_run`'s one invariant: a failure with no error and a success
 *      carrying one are both unrepresentable, and `scanned` stays NULL when a
 *      run threw before deciding anything.
 *   3. Recording the ARGUMENT instead of the effective mode. Six runs, a job
 *      that looks healthy by every naive query, and nothing ever swept.
 *   4. The alerting query that drops the job that has NEVER run -- the worst
 *      case, hidden for free by three-valued logic.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core');
const PORT = 54393;

const EmbeddedPostgres = (await import(join(CORE, 'node_modules/embedded-postgres/dist/index.js')))
  .default;
const pg = (await import(join(CORE, 'node_modules/pg/lib/index.js'))).default;

const dir = await mkdtemp(join(tmpdir(), 'filelayer-jobs-proof-'));
const server = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL (the race needs two backends)... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const URL = `postgres://postgres:postgres@localhost:${PORT}/proof`;
const admin = new pg.Client({ connectionString: URL });
await admin.connect();

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};

await admin.query(`
  CREATE TABLE file (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      state             text NOT NULL CHECK (state IN ('pending', 'ready', 'deleted')),
      storage_key       text NOT NULL,
      upload_expires_at timestamptz
  )`);

await admin.query(`
  CREATE TABLE job_run (
      id          bigserial PRIMARY KEY,
      job         text NOT NULL CHECK (job IN ('storage_orphans', 'upload_reservations',
                                               'audit_trim', 'audit_seal')),
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz NOT NULL DEFAULT now(),
      outcome     text NOT NULL CHECK (outcome IN ('ok', 'failed')),
      mode        text NOT NULL CHECK (mode IN ('dry', 'live')),
      scanned     bigint,
      acted       bigint,
      detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
      error       text,
      CONSTRAINT job_run_error_iff_failed CHECK ((outcome = 'failed') = (error IS NOT NULL))
  )`);

const refusal = async (sql, params = []) => {
  try {
    await admin.query(sql, params);
    return null;
  } catch (e) {
    return String(e.message).split(':')[0].replace(/^new row .*/, 'CHECK refused');
  }
};

// ---------------------------------------------------------------------------
console.log('1. the collector and the client that finished in the window');
// ---------------------------------------------------------------------------
{
  const NAIVE = `DELETE FROM file WHERE id = $1 RETURNING storage_key`;
  const GUIDE = `
    DELETE FROM file
     WHERE id = $1
       AND state = 'pending'
       AND upload_expires_at IS NOT NULL
       AND upload_expires_at < $2
    RETURNING storage_key`;

  /**
   * One collector pass against one client completing mid-window.
   *
   * The collector SELECTs, pauses -- every such job has that pause, whether it
   * is a sleep here or a round trip to the object store there -- and only then
   * acts on what it believed.
   */
  async function race(deleteSql) {
    await admin.query('TRUNCATE file');
    const { rows } = await admin.query(
      `INSERT INTO file (state, storage_key, upload_expires_at)
       VALUES ('pending', 'k/1', now() - interval '1 second') RETURNING id`,
    );
    const id = rows[0].id;
    const cutoff = new Date().toISOString();

    const collector = new pg.Client({ connectionString: URL });
    const client = new pg.Client({ connectionString: URL });
    await collector.connect();
    await client.connect();
    try {
      const seen = await collector.query(
        `SELECT id FROM file
          WHERE state = 'pending' AND upload_expires_at IS NOT NULL
            AND upload_expires_at < $1`,
        [cutoff],
      );

      // The client's completeUpload lands in the gap.
      await client.query(
        `UPDATE file SET state = 'ready', upload_expires_at = NULL WHERE id = $1`,
        [id],
      );

      const removed = await collector.query(
        deleteSql,
        deleteSql === NAIVE ? [seen.rows[0].id] : [seen.rows[0].id, cutoff],
      );
      const left = await admin.query('SELECT state FROM file WHERE id = $1', [id]);
      return { deleted: removed.rowCount, survives: left.rowCount === 1, state: left.rows[0]?.state };
    } finally {
      await collector.end();
      await client.end();
    }
  }

  let r = await race(NAIVE);
  console.log(`   DELETE WHERE id = $1                 deleted ${r.deleted}  the file survives: ${r.survives}`);
  expect(r.deleted === 1 && !r.survives, 'the data-loss race did not reproduce');
  console.log("   -> the user's upload succeeded and their file is gone.");

  r = await race(GUIDE);
  console.log(`   DELETE with the predicates repeated  deleted ${r.deleted}  the file survives: ${r.survives} ('${r.state}')`);
  expect(r.deleted === 0 && r.survives && r.state === 'ready', 'the claiming DELETE did not skip it');
  console.log('   -> zero rows means the client won. The claim IS the write, so');
  console.log('      there is no window: nothing earlier is being trusted.\n');
}

// ---------------------------------------------------------------------------
console.log('2. the one invariant on a run record');
// ---------------------------------------------------------------------------
{
  let r = await refusal(
    `INSERT INTO job_run (job, outcome, mode) VALUES ('audit_trim', 'failed', 'live')`,
  );
  console.log(`   outcome 'failed' with no error    ${r ?? 'ACCEPTED'}`);
  expect(r !== null, 'a failure with no error was accepted');

  r = await refusal(
    `INSERT INTO job_run (job, outcome, mode, error)
     VALUES ('audit_trim', 'ok', 'live', 'connection reset')`,
  );
  console.log(`   outcome 'ok' carrying an error    ${r ?? 'ACCEPTED'}`);
  expect(r !== null, 'a success carrying an error was accepted');

  // A run that threw before deciding anything. Not scanned-zero: unknown.
  await admin.query(
    `INSERT INTO job_run (job, outcome, mode, error)
     VALUES ('audit_trim', 'failed', 'live', 'connection reset')`,
  );
  const { rows } = await admin.query(
    `SELECT scanned, acted FROM job_run WHERE outcome = 'failed' ORDER BY id DESC LIMIT 1`,
  );
  console.log(`   a run that threw early            scanned ${rows[0].scanned}  acted ${rows[0].acted}`);
  expect(rows[0].scanned === null && rows[0].acted === null,
    'a failed run claimed it scanned a number of things');
  console.log('   -> NULL, not 0. Zero is a claim, and an operator comparing');
  console.log('      runs would read it as a clean pass.\n');
}

// ---------------------------------------------------------------------------
console.log('3. recording the ARGUMENT instead of the effective mode');
// ---------------------------------------------------------------------------
{
  await admin.query('TRUNCATE job_run');

  // Six weeks of a cron that calls the collector with no arguments at all.
  // `dryRun` defaults to true, so not one of these swept anything.
  for (let week = 6; week >= 1; week--) {
    await admin.query(
      `INSERT INTO job_run (job, outcome, mode, scanned, acted, started_at, finished_at)
       VALUES ('storage_orphans', 'ok', 'dry', 412, 0,
               now() - ($1 || ' weeks')::interval, now() - ($1 || ' weeks')::interval)`,
      [week],
    );
  }

  const naive = (
    await admin.query(
      `SELECT count(*) AS runs, max(finished_at) AS last FROM job_run
        WHERE job = 'storage_orphans' AND outcome = 'ok'`,
    )
  ).rows[0];
  const honest = (
    await admin.query(
      `SELECT count(*) AS runs, max(finished_at) AS last FROM job_run
        WHERE job = 'storage_orphans' AND outcome = 'ok' AND mode = 'live'`,
    )
  ).rows[0];

  console.log(`   "has the sweep run?"          runs ${naive.runs}  last ${naive.last ? 'a week ago' : 'never'}`);
  console.log(`   "has it ever SWEPT?"          runs ${honest.runs}  last ${honest.last ? 'a week ago' : 'never'}`);
  expect(Number(naive.runs) === 6 && Number(honest.runs) === 0, 'the dry-run blind spot did not reproduce');
  const swept = (
    await admin.query(`SELECT coalesce(sum(acted), 0) AS n FROM job_run WHERE mode = 'live'`)
  ).rows[0].n;
  console.log(`   objects actually deleted      ${swept}`);
  expect(Number(swept) === 0, 'something was swept');
  console.log('   -> green on every dashboard, and the bucket has been growing');
  console.log('      for six weeks. Record the EFFECTIVE mode, not the argument.\n');
}

// ---------------------------------------------------------------------------
console.log('4. the alerting query that drops the job that never ran');
// ---------------------------------------------------------------------------
{
  await admin.query('TRUNCATE job_run');
  // Three jobs, three states. `audit_trim` has no rows at all.
  await admin.query(
    `INSERT INTO job_run (job, outcome, mode, scanned, acted, started_at, finished_at)
     VALUES ('storage_orphans', 'ok', 'live', 10, 1,
             now() - interval '6 weeks', now() - interval '6 weeks')`,
  );
  await admin.query(
    `INSERT INTO job_run (job, outcome, mode, error, started_at, finished_at)
     VALUES ('upload_reservations', 'failed', 'live', 'connection reset',
             now() - interval '5 minutes', now() - interval '5 minutes')`,
  );

  const JOBS = `(VALUES ('storage_orphans'), ('upload_reservations'), ('audit_trim')) AS j(job)`;

  const buggy = await admin.query(`
    SELECT j.job FROM ${JOBS}
      LEFT JOIN job_run r ON r.job = j.job
     GROUP BY j.job
    HAVING now() - max(r.finished_at) > interval '1 day'
     ORDER BY j.job`);

  const fixed = await admin.query(`
    SELECT j.job,
           CASE WHEN max(r.finished_at) IS NULL THEN 'never run' ELSE 'stale' END AS why
      FROM ${JOBS}
      LEFT JOIN job_run r ON r.job = j.job
     GROUP BY j.job
    HAVING max(r.finished_at) IS NULL
        OR now() - max(r.finished_at) > interval '1 day'
     ORDER BY j.job`);

  console.log(`   HAVING now() - max(...) > 1 day        pages for: ${buggy.rows.map((x) => x.job).join(', ') || '(nothing)'}`);
  console.log(`   ... OR max(...) IS NULL                pages for: ${fixed.rows.map((x) => `${x.job} (${x.why})`).join(', ')}`);
  expect(buggy.rows.length === 1 && buggy.rows[0].job === 'storage_orphans',
    'the buggy query did not drop the never-run job');
  expect(fixed.rows.length === 2, 'the fixed query did not catch both');
  console.log('   -> `NULL > interval` is NULL, `HAVING NULL` is not true, and the');
  console.log('      job with no cron at all is the one row that never appears.');

  const failed = (
    await admin.query(
      `SELECT job, outcome, now() - finished_at < interval '1 hour' AS recent FROM job_run
        WHERE outcome = 'failed'`,
    )
  ).rows[0];
  console.log(`   and the third state                    ${failed.job}: ${failed.outcome}, recent ${failed.recent}`);
  expect(failed.recent === true, 'the recent failure was not recent');
  console.log('   -> running, recent, and broken. Neither query above mentions it,');
  console.log('      because staleness is not the only question.\n');
}

await admin.end();
await server.stop();
await rm(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? 'Every claim in the guide reproduced.'
    : `${failures} claim(s) did not reproduce. The guide is wrong, or this script is.`,
);
process.exit(failures === 0 ? 0 : 1);
