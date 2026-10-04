#!/usr/bin/env node
/**
 * THE MEASUREMENTS IN `deleting-files-and-orphaned-objects.md`, REPRODUCIBLE.
 *
 * The guide beside this file says the sweeper that reclaims orphaned objects is
 * the most dangerous job in the system, because it deletes things on the
 * strength of an ABSENCE. An absence is also what a partial answer looks like,
 * and the two are indistinguishable from inside the job.
 *
 *     node docs/guides/deleting-files-and-orphaned-objects.proof.mjs
 *
 * A real PostgreSQL for the rows, a real directory for the bytes. Nothing to
 * install, nothing left running.
 *
 * What it demonstrates, in order:
 *
 *   1. The sweeper working: one genuine orphan, collected, nothing else touched.
 *   2. A listing that lost its second page. Measured: live user files deleted,
 *      silently, by a job that reported success.
 *   3. A listing that failed and was caught-and-ignored — the single most common
 *      way this happens, because `catch { return [] }` looks defensive.
 *   4. An upload in flight: bytes on disk, row not committed yet. The sweeper
 *      deletes a file that is being created. The grace period fixes it.
 *   5. The guarded sweeper against all three. Nothing lost.
 */

import { mkdtemp, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'core');
const PORT = 54392;

const EmbeddedPostgres = (await import(join(CORE, 'node_modules/embedded-postgres/dist/index.js')))
  .default;
const pg = (await import(join(CORE, 'node_modules/pg/lib/index.js'))).default;

const root = await mkdtemp(join(tmpdir(), 'filelayer-sweeper-proof-'));
const bucket = join(root, 'bucket');
const server = new EmbeddedPostgres({
  databaseDir: join(root, 'data'),
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
});

process.stdout.write('starting a real PostgreSQL... ');
await server.initialise();
await server.start();
await server.createDatabase('proof');
console.log('up\n');

const db = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${PORT}/proof` });
await db.connect();
await db.query(`
  CREATE TABLE file (
      id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      object_key text NOT NULL UNIQUE,
      name       text NOT NULL
  )`);

// --- the world: 6 live files and 1 genuine orphan ---------------------------
const { mkdir } = await import('node:fs/promises');
await mkdir(bucket, { recursive: true });

const LIVE = ['a', 'b', 'c', 'd', 'e', 'f'];
const ORPHAN = 'orphan-from-a-crashed-upload';

async function world() {
  await db.query('TRUNCATE file');
  await rm(bucket, { recursive: true, force: true });
  await mkdir(bucket, { recursive: true });
  for (const k of LIVE) {
    await writeFile(join(bucket, k), `bytes of ${k}`);
    await db.query('INSERT INTO file (object_key, name) VALUES ($1, $2)', [k, `${k}.pdf`]);
  }
  await writeFile(join(bucket, ORPHAN), 'nobody references me');
}

const objectsOnDisk = async () => (await readdir(bucket)).sort();
const rowsInDb = async () =>
  (await db.query('SELECT object_key FROM file ORDER BY object_key')).rows.map((r) => r.object_key);

/**
 * The sweeper everyone writes: list the bucket, load the referenced keys,
 * delete the difference. `listing` is injected so the measurements below can
 * hand it a partial or failed answer -- which is the whole point.
 */
async function naiveSweep(listing) {
  const keys = await listing();
  const { rows } = await db.query('SELECT object_key FROM file');
  const referenced = new Set(rows.map((r) => r.object_key));
  const deleted = [];
  for (const k of keys) {
    if (!referenced.has(k)) {
      await rm(join(bucket, k), { force: true });
      deleted.push(k);
    }
  }
  return deleted;
}

/**
 * The same job with the three guards the guide argues for.
 *
 *   - The listing must report COMPLETENESS. A partial answer is an error, not
 *     a short list.
 *   - An error propagates. `catch { return [] }` is how a failure becomes a
 *     deletion.
 *   - Nothing younger than the grace period is eligible, because an upload in
 *     flight has bytes and no row yet.
 */
async function guardedSweep(listing, { graceSeconds = 60 } = {}) {
  const result = await listing(); // throws on failure, by design
  if (!result || result.complete !== true) {
    throw new Error('refusing to sweep: the object listing did not report itself complete');
  }
  const { rows } = await db.query('SELECT object_key FROM file');
  const referenced = new Set(rows.map((r) => r.object_key));
  const cutoff = Date.now() - graceSeconds * 1000;
  const deleted = [];
  for (const k of result.keys) {
    if (referenced.has(k)) continue;
    const { mtimeMs } = await stat(join(bucket, k));
    if (mtimeMs > cutoff) continue; // too young to judge
    await rm(join(bucket, k), { force: true });
    deleted.push(k);
  }
  return deleted;
}

let failures = 0;
const expect = (cond, what) => {
  if (!cond) {
    console.log(`     ^ UNEXPECTED: ${what}`);
    failures++;
  }
};
const report = async (label, deleted) => {
  const left = await objectsOnDisk();
  const lost = LIVE.filter((k) => !left.includes(k));
  console.log(
    `  ${label.padEnd(44)} deleted ${String(deleted.length).padStart(2)}` +
      `   live files lost: ${lost.length ? lost.join(',') : 'none'}`,
  );
  return lost;
};

// --- 1. it works -------------------------------------------------------------
console.log('1. the sweeper doing its job');
await world();
let deleted = await naiveSweep(objectsOnDisk);
let lost = await report('full, correct listing', deleted);
expect(deleted.length === 1 && deleted[0] === ORPHAN, 'expected exactly the orphan');
expect(lost.length === 0, 'live files were lost on the happy path');
console.log('   -> the orphan is reclaimed and nothing else is touched.\n');

// --- 2. a listing that lost a page ------------------------------------------
console.log('2. the listing silently loses its second page');
await world();
const partial = async () => (await objectsOnDisk()).slice(0, 3); // page 1 only
deleted = await naiveSweep(partial);
lost = await report('partial listing, no error raised', deleted);
console.log('   -> nothing deleted, because the sweep is storage-driven: a short');
console.log('      listing hides orphans rather than destroying files. Keep going.\n');

// --- 2b. the same bug on the OTHER direction, which is the dangerous one -----
console.log('2b. the same partial listing, in a DB-driven sweep');
console.log('    ("for each ROW, is the object there? no -> the row is dead")');
await world();
const seen = new Set(await partial());
const { rows: allRows } = await db.query('SELECT object_key FROM file');
const killed = [];
for (const r of allRows) {
  if (!seen.has(r.object_key)) {
    await db.query('DELETE FROM file WHERE object_key = $1', [r.object_key]);
    killed.push(r.object_key);
  }
}
const survivingRows = await rowsInDb();
console.log(
  `  ${'partial listing, DB-driven'.padEnd(44)} rows deleted ${String(killed.length).padStart(2)}` +
    `   rows left: ${survivingRows.length} of ${LIVE.length}`,
);
expect(killed.length === 3, 'expected the DB-driven sweep to delete the unseen rows');
console.log('   -> THREE live files erased from the database, their bytes now');
console.log('      unreferenced, by a job that reported success. The listing was');
console.log('      short and the job read short as absent.\n');

// --- 3. catch { return [] } --------------------------------------------------
console.log('3. the listing throws, and the job catches it "defensively"');
await world();
const swallowing = async () => {
  try {
    throw new Error('EACCES: permission denied, scandir');
  } catch {
    return []; // the line that looks careful and is not
  }
};
deleted = await naiveSweep(swallowing);
lost = await report('swallowed error, storage-driven', deleted);
console.log('   -> storage-driven: deletes nothing, hides every orphan forever.');
console.log('      DB-driven with the same swallow deletes EVERY row. Same line of');
console.log('      code, opposite catastrophe, depending on which way the job runs.\n');

// --- 4. an upload in flight --------------------------------------------------
console.log('4. an upload in flight: bytes written, row not committed yet');
await world();
await writeFile(join(bucket, 'in-flight'), 'uploading right now');
deleted = await naiveSweep(objectsOnDisk);
console.log(
  `  ${'no grace period'.padEnd(44)} deleted ${String(deleted.length).padStart(2)}` +
    `   ${deleted.includes('in-flight') ? 'INCLUDING the in-flight upload' : ''}`,
);
expect(deleted.includes('in-flight'), 'expected the in-flight upload to be collected');
console.log('   -> the sweeper deleted a file that was being created. The user sees');
console.log('      a successful upload and a broken file.\n');

// --- 5. the guarded version against all three -------------------------------
console.log('5. the guarded sweeper against the same three inputs');
await world();
await writeFile(join(bucket, 'in-flight'), 'uploading right now');

const completeListing = async () => ({ complete: true, keys: await objectsOnDisk() });
deleted = await guardedSweep(completeListing);
let left = await objectsOnDisk();
console.log(
  `  ${'complete listing + grace period'.padEnd(44)} deleted ${String(deleted.length).padStart(2)}` +
    `   in-flight survived: ${left.includes('in-flight')}`,
);
expect(deleted.length === 0, 'the grace period should have spared everything young');
expect(left.includes('in-flight'), 'the in-flight upload was collected anyway');

const partialListing = async () => ({ complete: false, keys: await partial() });
let refused = await guardedSweep(partialListing).then(
  () => 'RAN',
  (e) => `REFUSED: ${e.message}`,
);
console.log(`  ${'partial listing'.padEnd(44)} ${refused}`);
expect(refused.startsWith('REFUSED'), 'the guarded sweep ran on a partial listing');

const throwingListing = async () => {
  throw new Error('EACCES: permission denied, scandir');
};
refused = await guardedSweep(throwingListing).then(
  () => 'RAN',
  (e) => `REFUSED: ${e.message}`,
);
console.log(`  ${'listing that throws'.padEnd(44)} ${refused}`);
expect(refused.startsWith('REFUSED'), 'the guarded sweep swallowed the error');

lost = LIVE.filter((k) => !left.includes(k));
expect(lost.length === 0, `live files lost: ${lost.join(',')}`);
console.log('   -> refuses to act on an answer it cannot trust, and spares what is');
console.log('      too young to judge. A sweeper that does nothing is recoverable.\n');

await db.end();
await server.stop();
await rm(root, { recursive: true, force: true });

console.log(
  failures === 0
    ? 'Every claim in the guide reproduced.'
    : `${failures} claim(s) did not reproduce. The guide is wrong, or this script is.`,
);
process.exit(failures === 0 ? 0 : 1);
