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
const requireCore = createRequire(join(HERE, '..', '..', '..', 'packages', 'core', 'package.json'));

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

export async function startEnv() {
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
    env: { ...process.env, ...env, PORT: String(port), BASE_URL: baseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => log(String(d)));
  child.stderr.on('data', (d) => log(String(d)));
  await waitFor(`${baseUrl}/health`, 60_000);
  return {
    baseUrl,
    adminToken: env.ADMIN_TOKEN,
    stop: () =>
      new Promise((r) => {
        child.once('exit', r);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 3000).unref();
      }),
  };
}
