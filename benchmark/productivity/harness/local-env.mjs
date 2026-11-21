/**
 * The environment one run's server gets: an empty PostgreSQL database, an
 * S3-compatible object store with one private bucket, and the variables in
 * REQUIREMENTS.md. Used by the harness for every run and by the reference
 * checks, so both arms meet the same services.
 *
 *   PostgreSQL: embedded-postgres (a real PostgreSQL binary), one per run.
 *   S3: moto's server mode (`pip install "moto[server]"`), a widely used S3
 *   emulator that accepts what the AWS SDKs send by default, checksums and
 *   chunked uploads included.
 *
 * startEnv() returns { env, stop } where env holds the variables for the
 * server under test, without PORT.
 *
 * With PRODBENCH_PG_ADMIN_URL and PRODBENCH_S3_URL set (the scorer container,
 * where PostgreSQL and moto are containers of their own), startEnv() uses
 * those servers instead, with a new database and a new bucket each call.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const requireCore = createRequire(join(HERE, '..', 'package.json'));

export const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

export async function waitFor(url, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not yet */
    }
    if (Date.now() > until) throw new Error(`not ready after ${ms} ms: ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function externalEnv() {
  const { default: pg } = await import(requireCore.resolve('pg'));
  const tag = randomBytes(6).toString('hex');
  const database = `app_${tag}`;
  const admin = new pg.Client({ connectionString: process.env.PRODBENCH_PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();
  const s3Url = process.env.PRODBENCH_S3_URL.replace(/\/$/, '');
  const bucket = `documents-${tag}`;
  const made = await fetch(`${s3Url}/${bucket}`, { method: 'PUT' });
  if (made.status !== 200) throw new Error(`could not create the bucket: ${made.status}`);
  const url = new URL(process.env.PRODBENCH_PG_ADMIN_URL);
  url.pathname = `/${database}`;
  return {
    env: {
      DATABASE_URL: url.toString(),
      S3_ENDPOINT: s3Url,
      S3_REGION: 'us-east-1',
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: 'benchmark',
      S3_SECRET_ACCESS_KEY: 'benchmark-secret',
      ADMIN_TOKEN: randomBytes(24).toString('hex'),
    },
    async stop() {},
  };
}

export async function startEnv() {
  if (process.env.PRODBENCH_PG_ADMIN_URL && process.env.PRODBENCH_S3_URL) return externalEnv();
  const { default: EmbeddedPostgres } = await import(requireCore.resolve('embedded-postgres'));
  const dir = mkdtempSync(join(tmpdir(), 'prodbench-pg-'));
  const pgPort = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port: pgPort, persistent: false, onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('app');

  const s3Port = await freePort();
  const moto = spawn('moto_server', ['-H', '127.0.0.1', '-p', String(s3Port)], { stdio: 'ignore' });
  const s3Url = `http://127.0.0.1:${s3Port}`;
  await waitFor(`${s3Url}/`);
  const bucket = 'documents';
  const made = await fetch(`${s3Url}/${bucket}`, { method: 'PUT' });
  if (made.status !== 200) throw new Error(`could not create the bucket: ${made.status}`);

  const env = {
    DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${pgPort}/app`,
    S3_ENDPOINT: s3Url,
    S3_REGION: 'us-east-1',
    S3_BUCKET: bucket,
    S3_ACCESS_KEY_ID: 'benchmark',
    S3_SECRET_ACCESS_KEY: 'benchmark-secret',
    ADMIN_TOKEN: randomBytes(24).toString('hex'),
  };
  return {
    env,
    async stop() {
      moto.kill('SIGTERM');
      await pg.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Start the implementation in `dir` with `npm start`; resolves once /health answers. */
export async function startServer(dir, env, { log = () => {} } = {}) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn('npm', ['start', '--silent'], {
    cwd: dir,
    // Only what npm needs and the contract's variables: the code under test is
    // untrusted and must not see the harness's environment.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env, PORT: String(port), BASE_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group: npm does not always pass a signal on to the
    // server it started, and an orphaned server keeps the scorer alive.
    detached: true,
  });
  child.stdout.on('data', (d) => log(String(d)));
  child.stderr.on('data', (d) => log(String(d)));
  await waitFor(`${baseUrl}/health`, 60_000);
  return {
    baseUrl,
    adminToken: env.ADMIN_TOKEN,
    stop: () =>
      new Promise((r) => {
        const group = (sig) => {
          try {
            process.kill(-child.pid, sig);
          } catch {
            /* already gone */
          }
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          group('SIGKILL');
          return r();
        }
        child.once('exit', () => {
          group('SIGKILL');
          r();
        });
        group('SIGTERM');
        setTimeout(() => group('SIGKILL'), 3000).unref();
      }),
  };
}
