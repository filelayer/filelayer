/**
 * STARTER -- the deployable one.
 *
 * The other three examples and the vault each take a `db` and a `storage` and
 * show what the API does. Every one of them is handed `quickstart()`, which runs
 * Postgres inside the process and keeps bytes in a Map, and which throws it all
 * away when the process exits.
 *
 * That left a cliff. On 3 October 2026 an agent was asked to integrate the
 * published package into a new application, reading only the published
 * documentation. It got to a first stored byte in four lines of our API and then
 * spent its time on everything this file is: where configuration comes from,
 * how the schema gets applied without applying it twice, which storage adapter
 * to use when you have a disk and no bucket, and how the route helpers mount
 * next to routes of your own.
 *
 * So this file is deliberately boring, and the boring parts are the point:
 *
 *   - CONFIGURATION comes from the environment, in one block, at the top, with
 *     a failure that names the variable instead of a stack trace.
 *   - THE SCHEMA is applied once, under a lock, by a check you can read.
 *   - STORAGE is a real directory by default, so bytes survive a restart with
 *     no bucket and no IAM user.
 *   - THE ROUTES are mounted, which the quickstart snippets never showed.
 *
 * Copy it into your own application and delete what you do not need. It is not
 * a framework and there is nothing to extend.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import {
  Filelayer,
  FsStorage,
  S3Storage,
  loadSchemaSql,
  fileDownloadRoute,
  shareDownloadRoute,
  type StorageAdapter,
} from '@filelayer/core';

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------
// FILELAYER ITSELF READS NO ENVIRONMENT VARIABLE. Every one of these is read by
// THIS file and handed to a constructor, which is worth knowing before you go
// looking for a config reference that does not exist.

/**
 * A MISSING VARIABLE IS A CONFIGURATION ERROR, AND IT IS WORTH SAYING WHICH ONE.
 *
 * `advice` exists because the first version printed the same paragraph about
 * Postgres for every variable, so a missing `S3_SECRET_ACCESS_KEY` was answered
 * with `export DATABASE_URL=...`. It also ran AFTER the schema had been applied,
 * because `storageFromEnv()` was called at the `new Filelayer(...)` line: a boot
 * that was going to fail on a missing S3 key wrote the schema first and then
 * exited, which on a fresh database is a side effect nobody asked for.
 */
function required(name: string, advice: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`\n  ${name} is not set.\n\n  ${advice}\n\n  See .env.example next to this file.\n`);
    process.exit(1);
  }
  return v;
}

const DATABASE_URL = required(
  'DATABASE_URL',
  'This example needs a Postgres you own. Anything works:\n' +
    '    export DATABASE_URL=postgres://user:pass@localhost:5432/mydb',
);
const PORT = Number(process.env['PORT'] ?? 3000);
const BASE_URL = process.env['BASE_URL'] ?? `http://localhost:${PORT}`;
const DATA_DIR = process.env['FILELAYER_DATA_DIR'] ?? './filelayer-data';

/**
 * AN UPLOAD NEEDS A CEILING, and the ceiling has to be enforced while the body
 * is arriving.
 *
 * `readBody` collected chunks into an array with nothing watching the total, so
 * the limit was whatever the process could allocate: a 400 MB POST took this
 * server from 85 MB resident to 1.3 GB, and a handful of them concurrently is
 * an out-of-memory kill. Nothing in Filelayer imposes a size -- it is your
 * application's decision, which means your application has to make it.
 */
const MAX_UPLOAD_BYTES = Number(process.env['MAX_UPLOAD_BYTES'] ?? 25 * 1024 * 1024);

/**
 * A bucket if you configured one, a directory if you did not.
 *
 * `FsStorage` is one process on one disk: no locking between writers, no
 * replication, and no `presignGet`, so redirect delivery is unavailable. That is
 * the right trade for a laptop, a single node, and for evaluating this before
 * creating an IAM user. The moment you run two application servers, move to the
 * bucket.
 */
function storageFromEnv(): StorageAdapter {
  const endpoint = process.env['S3_ENDPOINT'];
  if (!endpoint) {
    console.log(`storage: FsStorage at ${DATA_DIR} (set S3_ENDPOINT to use a bucket)`);
    return new FsStorage(DATA_DIR);
  }
  const bucketAdvice =
    'You set S3_ENDPOINT, so the bucket variables are required. Unset S3_ENDPOINT\n' +
    '    to go back to a local directory, which needs none of them.';
  console.log(`storage: S3Storage at ${endpoint}`);
  return new S3Storage({
    endpoint,
    bucket: required('S3_BUCKET', bucketAdvice),
    region: process.env['S3_REGION'] ?? 'auto',
    accessKeyId: required('S3_ACCESS_KEY_ID', bucketAdvice),
    secretAccessKey: required('S3_SECRET_ACCESS_KEY', bucketAdvice),
  });
}

// Built HERE, before the database is touched, so a bad storage configuration
// exits without having applied a schema.
const storage = storageFromEnv();

// -----------------------------------------------------------------------------
// First boot
// -----------------------------------------------------------------------------

/**
 * APPLY THE SCHEMA ONCE, AND SURVIVE TWO SERVERS BOOTING AT THE SAME MOMENT.
 *
 * `schema.sql` is not idempotent: run it twice and the second run dies on
 * `relation "project" already exists`. There is no `schema_version` table and no
 * migrate command, which MIGRATIONS.md states plainly, so the check is yours to
 * write. This is what it looks like.
 *
 * The advisory lock is not decoration. Without it, two processes starting
 * together both see an empty database, both apply the schema, and one of them
 * crashes on first boot -- the kind of failure that only ever happens in the
 * deployment and never on the laptop. `pg_advisory_lock` is held on one
 * connection until released, so the second process waits, then finds the tables
 * and does nothing.
 *
 * WHY IT COUNTS NINE TABLES INSTEAD OF LOOKING FOR ONE. The first version asked
 * `to_regclass('public.project')`, and `project` is a table name an application
 * is entirely likely to already have. Point this at the database your app
 * already uses and it prints "already applied", binds the port, and then returns
 * 500 from every route forever, because none of the OTHER eight tables exist.
 * Counting turns that into the three honest answers: none of them, so apply;
 * all of them, so do nothing; some of them, which is either a half-applied
 * schema or a name collision with your own tables, and in both cases the only
 * safe move is to stop and say which it is.
 */
const SCHEMA_TABLES = [
  'project',
  'org',
  'actor',
  'membership',
  'file',
  'file_grant',
  'audit_event',
  'usage_daily',
  'file_owning_user_daily',
];

async function applySchemaIfAbsent(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Any constant works, as long as every process that might apply this schema
    // uses the same one. 0x F11E1A would be cute; a plain number is readable.
    await client.query('SELECT pg_advisory_lock($1)', [8451201]);
    const { rows } = await client.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname = ANY($1::text[])`,
      [SCHEMA_TABLES],
    );
    const present = rows.map((r) => r.name);

    if (present.length === SCHEMA_TABLES.length) {
      console.log('schema: already applied');
      return;
    }
    if (present.length > 0) {
      const missing = SCHEMA_TABLES.filter((tbl) => !present.includes(tbl));
      console.error(
        `\n  This database has ${present.length} of Filelayer's ${SCHEMA_TABLES.length} tables, ` +
          `which is neither empty nor ready.\n\n` +
          `  present: ${present.join(', ')}\n` +
          `  missing: ${missing.join(', ')}\n\n` +
          `  Two things look like this. Either the schema was applied and then\n` +
          `  partly changed, in which case MIGRATIONS.md has the SQL -- or those\n` +
          `  tables are YOUR application's and the names collide, in which case\n` +
          `  give Filelayer its own schema or its own database. Applying\n` +
          `  schema.sql now would fail halfway through either way.\n`,
      );
      process.exit(1);
    }
    console.log('schema: applying for the first time');
    await client.query(await loadSchemaSql());
  } finally {
    await client.query('SELECT pg_advisory_unlock_all()').catch(() => {});
    client.release();
  }
}

// -----------------------------------------------------------------------------
// The application
// -----------------------------------------------------------------------------

const pool = new Pool({ connectionString: DATABASE_URL });
await applySchemaIfAbsent(pool);

const fl = new Filelayer(pool, storage, { baseUrl: BASE_URL });

/**
 * YOUR SESSION, WHATEVER IT IS. The only thing Filelayer needs from it is your
 * own stable id for the user; the tiered API (`fl.files`, `fl.orgs`,
 * `fl.shares`) resolves that to an actor for you and creates one on first use.
 *
 * A real application reads a cookie or a bearer token here. This one reads a
 * header so that `curl` is enough to try it.
 */
const userOf = (req: IncomingMessage): string | null =>
  (req.headers['x-user'] as string | undefined) ?? null;

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

/**
 * Collect the body, and stop collecting the moment it is too big.
 *
 * The check has to be INSIDE the loop. A `content-length` test alone is a
 * suggestion -- a chunked upload has no `content-length` at all, and a header
 * can say 1 KB while the socket sends 400 MB. Counting as the chunks arrive is
 * the only version that bounds what this process allocates.
 */
class TooLarge extends Error {
  readonly status = 413;
  readonly code = 'payload_too_large';
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new TooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).byteLength;
    if (total > MAX_UPLOAD_BYTES) {
      req.destroy();
      throw new TooLarge();
    }
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * The share route, mounted at /d. Each route helper is
 * `(req, res) => Promise<boolean>`: true when it handled the request, false when
 * the path was not its own, so you try them in order and fall through to your
 * own router.
 */
const shareRoute = shareDownloadRoute(fl, { prefix: '/d' });

/** Public files, served as an anonymous caller: only published files resolve. */
const publicRoute = fileDownloadRoute(fl, {
  prefix: '/public',
  disposition: 'inline',
  principal: () => ({ actorId: null }),
});

const server = createServer(async (req, res) => {
  try {
    if (await shareRoute(req, res)) return;
    if (await publicRoute(req, res)) return;

    const url = new URL(req.url ?? '/', BASE_URL);
    const user = userOf(req);

    // DECODE THE PATH, because `searchParams` already decoded the query.
    //
    // Without this, `POST /orgs/my%20team` created a tenant literally named
    // `my%20team` while `POST /files?org=my team` created `my team`, so the two
    // halves of this file disagreed about which tenant the caller meant and
    // silently made two. That is the same class of bug the tenant note below
    // exists to prevent, reintroduced by the router rather than the API.
    let seg: string[];
    try {
      seg = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      // A malformed escape -- `%zz`, a lone `%` -- is a bad request, not a 500.
      return json(res, 400, { error: 'bad_path' });
    }

    // POST /orgs/:org        create a tenant, with the caller as its OWNER
    //
    // DO THIS EXPLICITLY. `files.put({ org: 'acme' })` will create `acme` for
    // you if it does not exist, and it joins you to it as a `member`. A member
    // cannot read the audit log, cannot set roles, and gets the same `404` a
    // stranger gets, so a tenant created as a side effect of an upload is a
    // tenant you do not administer. The call below is the one that makes you
    // its owner.
    if (req.method === 'POST' && seg[0] === 'orgs' && seg.length === 2) {
      if (!user) return json(res, 401, { error: 'no_session' });
      const org = await fl.orgs.create(seg[1]!, { owner: user });
      return json(res, 201, { id: org.id });
    }

    // POST /files?org=acme    upload, owned by the caller
    if (req.method === 'POST' && seg[0] === 'files' && seg.length === 1) {
      if (!user) return json(res, 401, { error: 'no_session' });
      const file = await fl.files.put(await readBody(req), {
        org: url.searchParams.get('org') ?? undefined,
        owner: user,
        name: url.searchParams.get('name') ?? 'upload.bin',
        contentType: req.headers['content-type'] ?? 'application/octet-stream',
      });
      return json(res, 201, { id: file.id });
    }

    // GET /files/:id          read it back, as yourself
    if (req.method === 'GET' && seg[0] === 'files' && seg.length === 2) {
      if (!user) return json(res, 401, { error: 'no_session' });
      const f = await fl.files.get(seg[1]!, { as: user });
      res.writeHead(200, f.headers);
      return void res.end(f.body);
    }

    // POST /files/:id/share   a link that expires and can be taken back
    if (req.method === 'POST' && seg[0] === 'files' && seg.length === 3 && seg[2] === 'share') {
      if (!user) return json(res, 401, { error: 'no_session' });
      const share = await fl.shares.create(seg[1]!, {
        as: user,
        expiresIn: 3600,
        maxDownloads: 3,
      });
      return json(res, 201, { url: share.url, grantId: share.grantId });
    }

    // DELETE /shares/:grantId revocation takes effect on the next request
    if (req.method === 'DELETE' && seg[0] === 'shares' && seg.length === 2) {
      if (!user) return json(res, 401, { error: 'no_session' });
      await fl.shares.revoke(seg[1]!, { as: user });
      return json(res, 200, { revoked: true });
    }

    // GET /orgs/:org/audit    the log, denials included
    if (req.method === 'GET' && seg[0] === 'orgs' && seg.length === 3 && seg[2] === 'audit') {
      if (!user) return json(res, 401, { error: 'no_session' });
      const rows = await fl.orgs.audit(seg[1]!, { as: user, limit: 50 });
      return json(res, 200, { events: rows.map((r) => r.summary) });
    }

    json(res, 404, { error: 'not_found' });
  } catch (err) {
    // A FilelayerError carries the status the caller should see. So does the
    // 413 above. Anything else is unexpected and must not leak its message.
    const e = err as { status?: number; code?: string; name?: string; message?: string };
    if (typeof e.status === 'number') {
      if (!res.headersSent) json(res, e.status, { error: e.code ?? 'error' });
      return;
    }

    // A CLIENT THAT HUNG UP IS NOT A BUG IN THIS FILE. `ECONNRESET` and
    // `ERR_STREAM_PREMATURE_CLOSE` arrive here whenever a browser cancels a
    // download, and the first version logged every one of them with a full
    // stack under a comment calling it a bug, which buries the real ones.
    const code = (err as { code?: string }).code;
    if (code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE' || !res.writable) {
      return;
    }

    // ONE LINE, NOT THE ERROR OBJECT. `console.error(err)` on a pg error prints
    // its `detail`, which for a CHECK violation is the FAILING ROW -- and for
    // `file_grant` that row contains `secret_hash`, a share link's credential.
    // The name, the message and the SQLSTATE are what an operator needs; the
    // row is what they must not have in a log file.
    console.error(
      `unhandled: ${e.name ?? 'Error'}: ${e.message ?? ''}${code ? ` (${code})` : ''}`,
    );
    if (!res.headersSent) json(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, () => console.log(`starter listening on ${BASE_URL}`));
