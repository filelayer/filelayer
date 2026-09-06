/**
 * Postgres. Vercel Blob has no ownership model, no roles, no metadata beyond
 * pathname/contentType/etag, and no query surface, so the entire domain model
 * lives here. In practice this is a Vercel Marketplace database (Neon) — a
 * second vendor, a second bill, a second set of connection limits, and a
 * second thing to keep in sync with the blob store.
 *
 * Connection handling note: Vercel Functions are serverless, so a classic
 * `pg.Pool` will exhaust Postgres connections under load. Either use a
 * serverless driver over HTTP (`@neondatabase/serverless`) or put PgBouncer in
 * front. This is a real decision, not boilerplate — getting it wrong shows up
 * as "too many connections" only at traffic.
 */
import { neon } from '@neondatabase/serverless';

export const sql = neon(process.env.DATABASE_URL!);

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);

-- blob_pathname is the join key to Vercel Blob. Nothing enforces that it
-- points at a blob that exists, or that the blob it points at belongs to this
-- org. Both invariants are ours to maintain.
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  uploader_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes BIGINT,
  blob_pathname TEXT NOT NULL UNIQUE,
  blob_url TEXT,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS documents_org_idx ON documents(org_id);

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  password_salt TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shares_doc_idx ON shares(document_id);

CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGSERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  org_seq BIGINT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  UNIQUE (org_id, org_seq)
);
CREATE INDEX IF NOT EXISTS audit_org_idx ON audit_log(org_id, org_seq);
`;
