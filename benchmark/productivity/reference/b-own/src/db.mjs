// Schema and connection. Created on start, idempotently.
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          text PRIMARY KEY,
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orgs (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
  org_id      text NOT NULL REFERENCES orgs(id),
  user_id     text NOT NULL REFERENCES users(id),
  role        text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
  PRIMARY KEY (org_id, user_id)
);
CREATE TABLE IF NOT EXISTS documents (
  id            text PRIMARY KEY,
  org_id        text NOT NULL REFERENCES orgs(id),
  name          text NOT NULL,
  content_type  text NOT NULL,
  size          integer NOT NULL,
  storage_key   text NOT NULL,
  uploaded_by   text NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz
);
CREATE INDEX IF NOT EXISTS documents_org_idx ON documents (org_id, created_at DESC);
CREATE TABLE IF NOT EXISTS shares (
  id              text PRIMARY KEY,
  org_id          text NOT NULL REFERENCES orgs(id),
  document_id     text NOT NULL REFERENCES documents(id),
  token_hash      text NOT NULL UNIQUE,
  created_by      text NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  password_hash   text,
  max_downloads   integer,
  download_count  integer NOT NULL DEFAULT 0,
  revoked_at      timestamptz
);
CREATE TABLE IF NOT EXISTS audit_events (
  seq          bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  action       text NOT NULL,
  decision     text NOT NULL CHECK (decision IN ('allow','deny')),
  actor_id     text,
  org_id       text,
  document_id  text,
  share_id     text,
  reason       text
);
CREATE INDEX IF NOT EXISTS audit_org_idx ON audit_events (org_id, seq DESC);
`;

export async function openDb(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 20 });
  // Two processes starting at once must not race on CREATE TABLE.
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(727001)');
    await c.query(SCHEMA);
    await c.query('SELECT pg_advisory_unlock(727001)');
  } finally {
    c.release();
  }
  return pool;
}
