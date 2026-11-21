import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import pg from 'pg';
import { Filelayer, S3Storage, schemaStatus } from '@filelayer/core';
import { createApp } from './app.mjs';

const env = process.env;
const db = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });

// Filelayer's schema once, under a lock, as its quickstart says; then ours.
const c = await db.connect();
try {
  await c.query('SELECT pg_advisory_lock(727002)');
  if ((await schemaStatus(c)).state === 'absent') {
    const require = createRequire(import.meta.url);
    await c.query(await readFile(require.resolve('@filelayer/core/schema.sql'), 'utf8'));
  }
  await c.query(`
    CREATE TABLE IF NOT EXISTS app_user (id text PRIMARY KEY, email text NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS app_org (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  `);
  await c.query('SELECT pg_advisory_unlock(727002)');
} finally {
  c.release();
}

const storage = new S3Storage({
  endpoint: env.S3_ENDPOINT,
  bucket: env.S3_BUCKET,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  pathStyle: true,
});
const fl = new Filelayer(db, storage, { baseUrl: env.BASE_URL });
const app = createApp({ db, fl, baseUrl: env.BASE_URL, adminToken: env.ADMIN_TOKEN });
const port = Number(env.PORT ?? 3000);
app.listen(port, '127.0.0.1', () => console.log(`listening on ${port}`));
