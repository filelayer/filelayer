/**
 * RUN THE STARTER. OVER HTTP. AGAINST A REAL POSTGRES.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * `examples/starter/verify.mjs` opens with "a claim about this repository is
 * supposed to be executable". It shipped on 3 October 2026 and until 4 October
 * NOTHING EXECUTED IT. It was a test suite with no runner: the one artifact in
 * this repository that a reader is told to copy into their own application, and
 * the only one no job touched.
 *
 * Found while changing the starter to use `0.13.0`'s `{ as }` route. The change
 * worked, which I knew because I wrote this harness by hand to find out. Writing
 * it by hand once is a thing to do; writing it by hand every time is how the
 * starter rots between releases.
 *
 * `verify:release` already proves the LIBRARY works from an empty directory.
 * This proves the EXAMPLE works, which is a different claim and a louder one:
 * the starter is an HTTP server, so it is the only place where route mounting,
 * header handling, `Range`, streaming, status codes and the fall-through order
 * between the library's routes and the application's own are exercised at all.
 * Three of the defects found in October were in exactly that layer.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES
 * -----------------------------------------------------------------------------
 *
 *   pack -> install into a temp directory -> copy the starter in
 *        -> boot it -> drive verify.mjs over HTTP -> report
 *
 * It installs THE TARBALL, not the checkout, so the starter is compiled against
 * the same `dist/` a user gets. A failure here is a failure a user would have
 * had, which is the same standard `verify:release` holds itself to.
 *
 * -----------------------------------------------------------------------------
 * THE DATABASE
 * -----------------------------------------------------------------------------
 *
 * `FILELAYER_STARTER_DATABASE_URL` if you set it, which is what CI does: the
 * `release-gate` job already has a PostgreSQL 17 service and there is no reason
 * to start a second database next to it. Otherwise this boots
 * `embedded-postgres` -- a real PostgreSQL binary, not WASM -- so that running
 * it on a laptop needs no setup.
 *
 * SCRATCH DATABASE ONLY. The starter applies `schema.sql` on first boot, and
 * this harness drops and recreates the `public` schema first so a re-run starts
 * clean. Point it at a database you do not care about.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(ROOT, 'packages', 'core');

/**
 * Resolve from `packages/core`, not from this file. The repository root has no
 * `node_modules`: every dev dependency this harness borrows -- `pg` and
 * `embedded-postgres` -- is installed under the package, and hand-written
 * `node_modules/<name>/dist/index.js` paths are a guess about a layout npm is
 * free to change.
 */
const requireFromCore = createRequire(join(CORE, 'package.json'));
const importFromCore = (name) => import(pathToFileURL(requireFromCore.resolve(name)).href);
const STARTER = join(ROOT, 'examples', 'starter');
const KEEP = process.argv.includes('--keep');
const PORT = Number(process.env.FILELAYER_STARTER_PORT ?? 3457);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function die(stage, detail) {
  console.error(`\nFAIL  ${stage}`);
  if (detail) console.error(detail.trimEnd().replace(/^/gm, '      '));
  process.exit(1);
}

function step(name) {
  process.stdout.write(`  ${name} ... `);
}

const started = Date.now();
let pgHandle = null;
let serverProc = null;
const workdir = mkdtempSync(join(tmpdir(), 'filelayer-starter-'));
const dataDir = join(workdir, 'bytes');

/**
 * Tear down in the reverse order of setup, and do it even when a step threw.
 * An embedded Postgres left running holds a port and a data directory, and the
 * second run is then a confusing failure about the first one.
 */
async function cleanup() {
  if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGKILL');
  if (pgHandle) await pgHandle.stop().catch(() => {});
  if (!KEEP) rmSync(workdir, { recursive: true, force: true });
  else console.log(`\n  kept: ${workdir}`);
}

process.on('SIGINT', () => cleanup().then(() => process.exit(130)));

try {
  console.log('\nthe starter, driven over HTTP\n');

  // ---------------------------------------------------------------------------
  // 1. A database.
  // ---------------------------------------------------------------------------
  let databaseUrl = process.env.FILELAYER_STARTER_DATABASE_URL ?? '';
  if (databaseUrl) {
    step('database (provided)');
    console.log('ok');
  } else {
    step('database (embedded-postgres)');
    let EmbeddedPostgres;
    try {
      ({ default: EmbeddedPostgres } = await importFromCore('embedded-postgres'));
    } catch (err) {
      die(
        'database (embedded-postgres)',
        `${err.message}\n\nEither run \`npm ci --prefix packages/core\`, or set\n` +
          'FILELAYER_STARTER_DATABASE_URL to a scratch Postgres you own.',
      );
    }
    // A high, randomised port: this may run next to the test suite.
    const port = 55000 + Math.floor(Math.random() * 2000);
    pgHandle = new EmbeddedPostgres({
      databaseDir: join(workdir, 'pg'),
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
    });
    await pgHandle.initialise();
    await pgHandle.start();
    databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
    console.log(`ok (port ${port})`);
  }

  // A SCRATCH SCHEMA. `schema.sql` is not idempotent and the starter's own
  // first-boot check will refuse to apply it twice, so a database left behind
  // by a previous run would make this harness test nothing.
  step('reset the public schema');
  {
    const { Client } = requireFromCore('pg');
    const c = new Client({ connectionString: databaseUrl });
    await c.connect();
    await c.query('DROP SCHEMA IF EXISTS public CASCADE');
    await c.query('CREATE SCHEMA public');
    await c.end();
  }
  console.log('ok');

  // ---------------------------------------------------------------------------
  // 2. The tarball, installed where it has never seen this repository.
  // ---------------------------------------------------------------------------
  step('pack');
  const packed = run('npm', ['pack', '--pack-destination', workdir], { cwd: CORE });
  if (packed.status !== 0) die('pack', packed.out);
  const tarball = readdirSync(workdir).find((f) => f.endsWith('.tgz'));
  if (!tarball) die('pack', `no .tgz landed in ${workdir}\n${packed.out}`);
  console.log(`ok (${tarball})`);

  step('install the tarball and pg');
  writeFileSync(
    join(workdir, 'package.json'),
    `${JSON.stringify({ name: 'filelayer-starter-drive', private: true, type: 'module' }, null, 2)}\n`,
  );
  const installed = run('npm', ['install', '--no-audit', '--no-fund', join(workdir, tarball), 'pg'], {
    cwd: workdir,
  });
  if (installed.status !== 0) die('install the tarball and pg', installed.out);
  console.log('ok');

  step('copy the starter in');
  for (const f of ['server.ts', 'verify.mjs']) {
    copyFileSync(join(STARTER, f), join(workdir, f));
  }
  console.log('ok');

  // ---------------------------------------------------------------------------
  // 3. Boot it, exactly as its README says to.
  // ---------------------------------------------------------------------------
  const base = `http://localhost:${PORT}`;
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    BASE_URL: base,
    PORT: String(PORT),
    FILELAYER_DATA_DIR: dataDir,
  };
  // REMOVED, NOT SET EMPTY. `storageFromEnv()` branches on the variable being
  // truthy, so an inherited `S3_ENDPOINT` from a developer's shell would send
  // this harness at a bucket and then fail on the four variables that go with
  // it. A bucket is a separate claim, and `s3-live.test.ts` is where it is made.
  delete env.S3_ENDPOINT;

  step('boot');
  const log = [];
  serverProc = spawn('node', ['--experimental-strip-types', join(workdir, 'server.ts')], {
    cwd: workdir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => log.push(String(d)));
  serverProc.stderr.on('data', (d) => log.push(String(d)));

  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    if (serverProc.exitCode !== null) {
      die('boot', `the server exited with ${serverProc.exitCode}\n\n${log.join('')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
    // A 404 IS A SUCCESSFUL PROBE. The starter has no health endpoint and
    // adding one to it for this harness's benefit would be the harness
    // changing the artifact it is testing. Any HTTP answer means listening.
    try {
      await fetch(`${base}/__probe-${randomUUID()}`);
      up = true;
    } catch {
      /* not listening yet */
    }
  }
  if (!up) die('boot', `nothing answered on ${base} after 20s\n\n${log.join('')}`);
  console.log('ok');

  // WHAT THE SERVER SAID ABOUT THE SCHEMA, on success as well as on failure.
  // The rest of its output is suppressed unless something breaks, and that was
  // right until the schema decision moved into `schemaStatus()`: hiding the one
  // line that says which branch first boot took makes this harness unable to
  // show the thing it is now verifying.
  for (const line of log.join('').split('\n')) {
    if (/^schema:|^storage:/.test(line.trim())) console.log(`    ${line.trim()}`);
  }

  // ---------------------------------------------------------------------------
  // 4. Drive it.
  // ---------------------------------------------------------------------------
  console.log('\n--- verify.mjs ---------------------------------------------------\n');
  const verify = spawn('node', [join(workdir, 'verify.mjs')], {
    cwd: workdir,
    env: { ...env, BASE_URL: base },
    stdio: 'inherit',
  });
  const code = await new Promise((r) => verify.on('exit', r));
  console.log('------------------------------------------------------------------');

  if (code !== 0) {
    console.error('\nthe server said:\n');
    console.error(log.join('').replace(/^/gm, '      '));
    die('verify.mjs', `exit ${code}`);
  }

  console.log(`\nthe starter runs.  ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
  await cleanup();
  process.exit(0);
} catch (err) {
  await cleanup();
  die('harness', err?.stack ?? String(err));
}
