#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `expiring-and-revocable-file-links.md`, REPRODUCIBLE.
 *
 * The guide next to this file states four numbers about what happens when two
 * requests redeem the same share link at the same moment. Numbers in a guide
 * that nobody can re-run are an assertion with a confident voice, so this is the
 * script that produced them.
 *
 * It needs nothing installed and no server running: `embedded-postgres` starts a
 * real PostgreSQL as an ordinary user process, which is what makes this
 * meaningful. The whole point is TWO BACKENDS. On a single-backend engine the
 * race cannot be staged at all and every version looks correct.
 *
 *     node docs/guides/expiring-and-revocable-file-links.proof.mjs
 *
 * What it demonstrates, in order:
 *
 *   1. The naive read-decide-write, WITHOUT the CHECK constraint: a cap of one
 *      serves two and the counter ends at 2. Silent.
 *   2. The same, WITH the CHECK: one is served and the other gets SQLSTATE
 *      23514. Loud, but still a 500 for a visitor who should have got a 404.
 *   3. The single `UPDATE ... WHERE ... RETURNING` from the guide, at four
 *      concurrency levels: exactly the cap, every time.
 *   4. The same statement under REPEATABLE READ: the loser aborts with 40001
 *      instead of blocking, which your application has to retry.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core');
const PORT = 54390;

const EmbeddedPostgres = (await import(join(CORE, 'node_modules/embedded-postgres/dist/index.js')))
  .default;
const pg = (await import(join(CORE, 'node_modules/pg/lib/index.js'))).default;

const dir = await mkdtemp(join(tmpdir(), 'filelayer-guide-proof-'));
const server = new EmbeddedPostgres({
  databaseDir: join(dir, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL (two backends is the whole point)... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const URL = `postgres://postgres:postgres@localhost:${PORT}/proof`;
const admin = new pg.Client({ connectionString: URL });
await admin.connect();

/** The table from the guide, verbatim apart from the two FK columns. */
await admin.query(`
  CREATE TABLE share_link (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      secret_hash    bytea NOT NULL UNIQUE,
      expires_at     timestamptz,
      max_downloads  integer,
      download_count integer NOT NULL DEFAULT 0,
      revoked_at     timestamptz,
      CONSTRAINT downloads_within_cap
          CHECK (max_downloads IS NULL OR download_count <= max_downloads)
  )`);

/** The statement the guide tells you to copy. */
const GUIDE_SQL = `
  UPDATE share_link
     SET download_count = download_count + 1
   WHERE secret_hash = $1
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now())
     AND (max_downloads IS NULL OR download_count < max_downloads)
  RETURNING id, download_count`;

const SECRET = Buffer.from([1]);

async function reset(cap) {
  await admin.query('TRUNCATE share_link');
  await admin.query('INSERT INTO share_link (secret_hash, max_downloads) VALUES ($1, $2)', [
    SECRET,
    cap,
  ]);
}

async function counter() {
  const { rows } = await admin.query('SELECT download_count FROM share_link');
  return Number(rows[0].download_count);
}

/** Each attempt gets its OWN connection: a pool would serialise them. */
async function concurrently(n, fn) {
  const clients = await Promise.all(
    Array.from({ length: n }, async () => {
      const c = new pg.Client({ connectionString: URL });
      await c.connect();
      return c;
    }),
  );
  try {
    return await Promise.all(clients.map(fn));
  } finally {
    await Promise.all(clients.map((c) => c.end()));
  }
}

/** Read, decide, then write. What a reasonable person writes first. */
const naive = async (c) => {
  await c.query('BEGIN');
  const { rows } = await c.query(
    'SELECT download_count, max_downloads FROM share_link WHERE secret_hash = $1',
    [SECRET],
  );
  await c.query('SELECT pg_sleep(0.05)'); // the window every such read has
  let served = false;
  if (Number(rows[0].download_count) < Number(rows[0].max_downloads)) {
    try {
      await c.query(
        'UPDATE share_link SET download_count = download_count + 1 WHERE secret_hash = $1',
        [SECRET],
      );
      served = true;
    } catch (e) {
      served = `ERR:${e.code}`;
    }
  }
  await c.query('COMMIT').catch(async () => {
    await c.query('ROLLBACK').catch(() => {});
  });
  return served;
};

const guide = (isolation) => async (c) => {
  if (isolation) await c.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  try {
    const r = await c.query(GUIDE_SQL, [SECRET]);
    if (isolation) await c.query('COMMIT');
    return r.rowCount > 0;
  } catch (e) {
    if (isolation) await c.query('ROLLBACK').catch(() => {});
    return `ERR:${e.code}`;
  }
};

const line = (label, got, n) =>
  console.log(
    `  ${label.padEnd(46)} served ${String(got.filter((x) => x === true).length).padStart(2)}` +
      `  counter ${String(n).padStart(2)}` +
      (got.some((x) => typeof x === 'string') ? `  [${[...new Set(got.filter((x) => typeof x === 'string'))].join(', ')}]` : ''),
  );

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};

console.log('1. read-decide-write, WITHOUT the CHECK constraint');
await admin.query('ALTER TABLE share_link DROP CONSTRAINT downloads_within_cap');
await reset(1);
let got = await concurrently(2, naive);
let n = await counter();
line('2 concurrent, cap 1', got, n);
expect(got.filter((x) => x === true).length === 2 && n === 2, 'the overshoot did not reproduce');
console.log('   -> both served. The cap did not hold, and nothing said so.\n');

console.log('2. read-decide-write, WITH the CHECK constraint');
// Clear first: step 1 deliberately left a row over its cap, and PostgreSQL
// validates an added CHECK against the rows already there.
await admin.query('TRUNCATE share_link');
await admin.query(
  'ALTER TABLE share_link ADD CONSTRAINT downloads_within_cap CHECK (max_downloads IS NULL OR download_count <= max_downloads)',
);
await reset(1);
got = await concurrently(2, naive);
n = await counter();
line('2 concurrent, cap 1', got, n);
expect(n === 1, 'the constraint did not hold the counter at the cap');
console.log('   -> the constraint caught it. A backstop, not a fix: that is a 500.\n');

console.log('3. the single UPDATE from the guide, READ COMMITTED (the default)');
for (const [requests, cap] of [
  [2, 1],
  [10, 3],
  [20, 1],
  [50, 7],
]) {
  await reset(cap);
  got = await concurrently(requests, guide(null));
  n = await counter();
  line(`${requests} concurrent, cap ${cap}`, got, n);
  expect(
    got.filter((x) => x === true).length === Math.min(requests, cap) && n === Math.min(requests, cap),
    `expected exactly ${Math.min(requests, cap)}`,
  );
}
console.log('   -> exactly the cap, every time. No window, because no earlier read.\n');

console.log('4. the same statement under REPEATABLE READ');
await reset(1);
got = await concurrently(2, guide('REPEATABLE READ'));
n = await counter();
line('2 concurrent, cap 1', got, n);
expect(n === 1 && got.includes('ERR:40001'), 'expected one 40001');
console.log('   -> the loser aborts rather than blocking. Your code must retry.\n');

await admin.end();
await server.stop();
await rm(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? 'Every number in the guide reproduced.'
    : `${failures} measurement(s) did not reproduce. The guide is wrong, or this script is.`,
);
process.exit(failures === 0 ? 0 : 1);
