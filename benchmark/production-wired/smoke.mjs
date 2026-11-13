#!/usr/bin/env node
/**
 * Runs the production-wired variant once, end to end. Tooling, not counted.
 *
 *     node benchmark/production-wired/smoke.mjs
 *
 * server.ts is started as a deployment would start it: `pg` and the pinned
 * @filelayer/core installed from npm into an empty directory, DATABASE_URL at
 * an empty PostgreSQL (embedded, started here), and S3_* at the SigV4-checking
 * local store the raw-S3 baseline is tested against. The schema is applied by
 * the variant's own boot block, not by this script. Then one owner uploads a
 * file and reads it back, a non-member is refused, and the bytes are checked to
 * be in the store rather than in the process.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLocalS3 } from '../baseline-raw-s3/test/local-s3.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', '..', 'packages', 'core');
const fromCore = createRequire(join(CORE, 'package.json'));
const { default: EmbeddedPostgres } = await import(pathToFileURL(fromCore.resolve('embedded-postgres')).href);

const work = mkdtempSync(join(tmpdir(), 'fl-prod-smoke-'));
const app = join(work, 'app');
cpSync(HERE, app, { recursive: true, filter: (p) => !p.includes('node_modules') });
let server;
let pg;
let s3;
const fail = async (msg) => {
  console.error(`\nfilelayer-production smoke: ${msg}\n`);
  await cleanup();
  process.exit(1);
};
async function cleanup() {
  server?.kill('SIGKILL');
  await s3?.close().catch(() => {});
  await pg?.stop().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}

try {
  // The variant must be the published example plus a boot block, nothing else:
  // a variant that drifted from what ships would be counting a different app.
  const { readFileSync } = await import('node:fs');
  const shipped = readFileSync(join(HERE, '..', 'node_modules', '@filelayer', 'core', 'examples', 'vault', 'server.ts'), 'utf8');
  const mine = readFileSync(join(HERE, 'server.ts'), 'utf8');
  const head = (t) => t.slice(0, t.indexOf('// --- boot')).replace("from '../../src/index.ts'", "from '@filelayer/core'");
  if (head(shipped) !== head(mine)) await fail('server.ts above the boot block differs from the published example');

  const i = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--no-package-lock'], {
    cwd: app,
    encoding: 'utf8',
  });
  if (i.status !== 0) await fail(`npm install failed:\n${i.stdout}${i.stderr}`);

  const pgPort = 58000 + Math.floor(Math.random() * 1000);
  pg = new EmbeddedPostgres({
    databaseDir: join(work, 'pg'),
    user: 'postgres',
    password: 'postgres',
    port: pgPort,
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });
  await pg.initialise();
  await pg.start();

  s3 = createLocalS3({ accessKeyId: 'AKIDSMOKE', secretAccessKey: 'smoke-secret' });
  const s3Port = await s3.listen(0);
  const port = 59000 + Math.floor(Math.random() * 1000);

  server = spawn(process.execPath, ['server.ts'], {
    cwd: app,
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres`,
      S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'vault-prod',
      AWS_ACCESS_KEY_ID: 'AKIDSMOKE',
      AWS_SECRET_ACCESS_KEY: 'smoke-secret',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (b) => (stderr += b));

  const call = async (method, path, { as, body } = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { ...(as ? { 'x-actor-id': as } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // bytes, not JSON
    }
    return { status: r.status, text, json };
  };

  let up = false;
  for (let n = 0; n < 60 && !up; n++) {
    await new Promise((r) => setTimeout(r, 500));
    if (server.exitCode !== null) await fail(`server.ts exited (${server.exitCode}):\n${stderr}`);
    up = await call('GET', '/nothing').then(() => true, () => false);
  }
  if (!up) await fail(`server.ts did not listen within 30 s:\n${stderr}`);

  const alice = (await call('POST', '/actors', { body: { externalId: 'alice' } })).json.id;
  const eve = (await call('POST', '/actors', { body: { externalId: 'eve' } })).json.id;
  const org = (await call('POST', '/orgs', { body: { externalId: 'acme', ownerActorId: alice } })).json.id;
  const marker = 'PRODUCTION-WIRED';
  const put = await call('POST', `/orgs/${org}/files`, {
    as: alice,
    body: { name: 'a.txt', contentType: 'text/plain', contentBase64: Buffer.from(marker).toString('base64') },
  });
  if (put.status !== 201) await fail(`upload: ${put.status} ${put.text}`);
  const read = await call('GET', `/files/${put.json.id}`, { as: alice });
  if (read.status !== 200 || read.text !== marker) await fail(`owner read: ${read.status} ${read.text}`);
  const refused = await call('GET', `/files/${put.json.id}`, { as: eve });
  if (refused.status < 400) await fail(`non-member read was allowed: ${refused.status}`);
  const stored = [...s3.objects.values()].some((o) => o.body.toString() === marker);
  if (!stored) await fail('the bytes are not in the S3 store');

  console.log(
    'filelayer-production smoke: clean. Schema applied by the boot block on an empty PostgreSQL; ' +
      'upload stored in the S3 store; owner read the bytes back; a non-member was refused ' +
      `(${refused.status}).`,
  );
  await cleanup();
} catch (e) {
  await fail(e?.stack ?? String(e));
}
