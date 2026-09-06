import { openDb } from './db.mjs';
import { createStorage } from './storage.mjs';
import { createApp, sweepOrphans } from './app.mjs';

const required = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing required env var ${k}`);
  return v;
};

const db = await openDb(required('DATABASE_URL'));
const storage = createStorage({
  endpoint: process.env.S3_ENDPOINT,
  region: required('S3_REGION'),
  bucket: required('S3_BUCKET'),
  accessKeyId: required('AWS_ACCESS_KEY_ID'),
  secretAccessKey: required('AWS_SECRET_ACCESS_KEY'),
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
});

const app = createApp({
  db,
  storage,
  baseUrl: required('PUBLIC_BASE_URL'),
  // 'proxy' is the only mode that satisfies "revocation takes effect
  // immediately". Do not change this without reading REPORT.md §9.
  shareDelivery: process.env.SHARE_DELIVERY ?? 'proxy',
});

// Nothing else reaps abandoned presigned uploads.
setInterval(() => {
  sweepOrphans(db, storage).catch((e) => console.error('sweep failed', e));
}, 15 * 60 * 1000).unref();

app.listen(Number(process.env.PORT ?? 3000));
