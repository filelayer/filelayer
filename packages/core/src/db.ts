/**
 * Database bootstrap and the transaction abstraction.
 *
 * `Queryable` is the whole surface the store needs. PGlite satisfies it, and so
 * does `pg.Pool` / `pg.Client`, so the store layer is written once and runs
 * against WASM Postgres in CI and real Postgres in production without a branch.
 *
 * -----------------------------------------------------------------------------
 * WHY THERE IS NOW A TRANSACTION ABSTRACTION
 * -----------------------------------------------------------------------------
 *
 * `Queryable` used to be a bare `query(sql, params)` and nothing else. Every
 * write the library performed was therefore its own autocommit transaction, and
 * on `pg.Pool` each one could land on a DIFFERENT CONNECTION. That produced two
 * defects, one of them in the product's headline claim:
 *
 *  1. `put()` did storage write -> INSERT file -> audit -> recordUsage ->
 *     recordFileOwner as five independent statements. A failure after the
 *     second one leaves a file with no audit record. For a product whose
 *     selling point is a tamper-evident audit trail, the audit write not being
 *     in the same transaction as the thing it audits is a hole in the premise:
 *     the chain is intact and simply does not mention what happened.
 *
 *  2. `audit_append()` takes `pg_advisory_xact_lock`, which is held until the
 *     end of the TRANSACTION. Under autocommit that is the end of the single
 *     statement, so the lock did serialize the append itself -- but it could not
 *     serialize the append with respect to the mutation it describes, because
 *     the mutation was in a different transaction. The lock was doing the small
 *     half of its job. It now spans the mutation as well (see `audit_append` in
 *     schema.sql and the chain-lock test in test/semantics.test.ts).
 *
 * A consumer could not fix either one themselves, because there was no way to
 * hand the library a transaction.
 *
 * -----------------------------------------------------------------------------
 * WHAT THE STORAGE WRITE DOES ABOUT NOT BEING TRANSACTIONAL
 * -----------------------------------------------------------------------------
 *
 * Object storage does not participate in a Postgres transaction and never will.
 * There are exactly two orderings and one of them is wrong:
 *
 *   (a) commit metadata, then write bytes -- a crash in between leaves a `file`
 *       row in state 'ready' whose object does not exist. Every read of that
 *       file 404s forever, `listFiles` shows it, and the failure is visible to
 *       the customer as data loss.
 *   (b) write bytes, then commit metadata -- a crash in between leaves an
 *       object no `file` row points at. It is unreachable (every read path
 *       starts from a `file` row and the key is a fresh UUID that is never
 *       reissued), so it costs storage and nothing else.
 *
 * We take (b). An orphan is a garbage-collection problem rather than a
 * correctness one. `Filelayer.collectStorageOrphans()` implements the
 * collection; it is a REQUIRED OPERATIONAL JOB, documented in SEMANTICS.md, not
 * something that happens on its own.
 *
 * Deletion is the mirror image and takes the mirror ordering: commit the
 * metadata delete FIRST, then delete the bytes. A crash in between leaves an
 * orphan (collectable) rather than a live `file` row with no object (data
 * loss).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  affectedRows?: number;
}

export interface Queryable {
  /**
   * THE CONTRACT: every call in one unit of work must reach the SAME BACKEND
   * CONNECTION.
   *
   * This is not pedantry about types. When nothing below is present,
   * `withTransaction` falls back to issuing a literal `BEGIN` through this
   * method -- so a `query` that round-robins across a pool puts `BEGIN` on one
   * connection and the write on another, and the `ROLLBACK` undoes nothing. The
   * call looks transactional, type-checks, passes a smoke test, and silently has
   * no atomicity at all.
   *
   * Every shape this project documents is safe, which is why the hole is easy to
   * miss: a `pg.Pool` is used through `connect()` so a transaction stays on one
   * checked-out client, a single `pg.Client` is one connection by construction,
   * and PGlite has one backend. The unsafe shape is the hand-rolled wrapper --
   * `{ query: (s, p) => pool.query(s, p) }` -- which nothing in the docs asks
   * for and the type happily accepts.
   *
   * If your wrapper cannot guarantee connection affinity, do not hand it over
   * bare: implement `withTransaction` below and let your own driver own the
   * unit of work.
   */
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>>;
  exec?(sql: string): Promise<unknown>;
  /**
   * Optional. An implementation that provides this is used in preference to
   * everything `withTransaction` would otherwise sniff for, which is the escape
   * hatch for a driver we have never heard of.
   */
  withTransaction?<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

/**
 * A `Queryable` that is known to be inside a transaction.
 *
 * `savepoint()` exists because a statement that RAISES inside a Postgres
 * transaction aborts the whole transaction: every subsequent statement fails
 * with "current transaction is aborted". Any place that expects a constraint to
 * fire and then wants to keep going -- `share()`, where the attenuation trigger
 * is the schema-level backstop and the refusal must still be AUDITED -- has to
 * wrap the failing statement in a savepoint or it cannot write the audit event
 * it exists to write.
 */
export interface Tx extends Queryable {
  readonly inTransaction: true;
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

export function isTx(db: Queryable): db is Tx {
  return (db as Partial<Tx>).inTransaction === true;
}

/**
 * Commit the transaction, then throw.
 *
 * The audit log records DECISIONS, including the ones that ended in a refusal.
 * A denial writes an audit event and then throws, so if a throw always rolled
 * back we would lose precisely the events P5 exists to keep -- and, worse, we
 * would lose them silently, since the caller still sees their 403.
 *
 * So the rule is explicit and narrow: a `FilelayerError` is a DECIDED outcome
 * (see `Filelayer.transaction()`), and everything else -- a driver error, a
 * constraint we did not anticipate, a bug -- rolls back. Wrapping in this class
 * makes the intent survive a refactor that changes the error type.
 */
export class CommitThenThrow extends Error {
  readonly inner: unknown;
  constructor(inner: unknown) {
    super('commit_then_throw');
    this.name = 'CommitThenThrow';
    this.inner = inner;
  }
}

type PoolLike = Queryable & {
  connect(): Promise<
    Queryable & { release(err?: unknown): void }
  >;
};
type PgliteLike = Queryable & {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
};

function isPool(db: Queryable): db is PoolLike {
  return typeof (db as Partial<PoolLike>).connect === 'function';
}
function isPglite(db: Queryable): db is PgliteLike {
  return typeof (db as Partial<PgliteLike>).transaction === 'function';
}

let savepointCounter = 0;

/**
 * Run `fn` inside one database transaction, on ONE connection.
 *
 * Supports, in this order of preference:
 *
 *   1. anything exposing `withTransaction` (bring your own);
 *   2. PGlite, via its own `transaction()` -- which is what the test suite uses,
 *      and which is a real Postgres transaction, not an emulation;
 *   3. `pg.Pool`, via `connect()` + BEGIN/COMMIT/ROLLBACK on the checked-out
 *      client, with `release()` in a finally. Taking a client is the whole
 *      point: `pool.query('BEGIN')` starts a transaction on an arbitrary
 *      connection and the next statement may not get the same one, which is a
 *      classic way to leave a connection wedged in an open transaction;
 *   4. a single `pg.Client` (or anything else), via BEGIN/COMMIT/ROLLBACK
 *      directly.
 *
 * Nesting: if `db` is already a `Tx`, the inner call becomes a SAVEPOINT rather
 * than a second BEGIN, so a helper that wants a transaction composes with a
 * caller that already opened one.
 */
export async function withTransaction<T>(
  db: Queryable,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (isTx(db)) return db.savepoint(() => fn(db));

  if (typeof db.withTransaction === 'function') {
    return db.withTransaction((raw) => fn(asTx(raw)));
  }

  if (isPglite(db)) {
    // PGlite's `transaction()` rolls back on throw and commits otherwise, so
    // CommitThenThrow has to be converted into a normal return and re-thrown
    // outside. `settled` carries which of the two happened.
    let settled: { commitThenThrow: unknown } | null = null;
    const value = await db.transaction(async (raw) => {
      try {
        return await fn(asTx(raw));
      } catch (err) {
        if (err instanceof CommitThenThrow) {
          settled = { commitThenThrow: err.inner };
          return undefined as unknown as T;
        }
        throw err;
      }
    });
    if (settled !== null) throw (settled as { commitThenThrow: unknown }).commitThenThrow;
    return value as T;
  }

  if (isPool(db)) {
    const client = await db.connect();
    try {
      return await runTx(client, fn);
    } finally {
      client.release();
    }
  }

  return runTx(db, fn);
}

async function runTx<T>(conn: Queryable, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await conn.query('BEGIN');
  let result: T;
  try {
    result = await fn(asTx(conn));
  } catch (err) {
    if (err instanceof CommitThenThrow) {
      await conn.query('COMMIT');
      throw err.inner;
    }
    // A rollback that itself fails must not mask the original error.
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  }
  await conn.query('COMMIT');
  return result;
}

function asTx(conn: Queryable): Tx {
  const existing = conn as Partial<Tx>;
  if (existing.inTransaction === true) return conn as Tx;
  const tx: Tx = {
    inTransaction: true,
    query: (sql, params) => conn.query(sql, params),
    ...(conn.exec ? { exec: (sql: string) => conn.exec!(sql) } : {}),
    async savepoint<T>(fn: () => Promise<T>): Promise<T> {
      const name = `fl_sp_${++savepointCounter}`;
      await conn.query(`SAVEPOINT ${name}`);
      try {
        const r = await fn();
        await conn.query(`RELEASE SAVEPOINT ${name}`);
        return r;
      } catch (err) {
        await conn.query(`ROLLBACK TO SAVEPOINT ${name}`);
        await conn.query(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    },
  };
  return tx;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_PATH = join(HERE, '..', 'schema.sql');

export async function loadSchemaSql(): Promise<string> {
  return readFile(SCHEMA_PATH, 'utf8');
}

/** The directory holding the migration files and their manifest. */
export const MIGRATIONS_PATH = join(HERE, '..', 'migrations');

/**
 * The schema version this build of the library expects.
 *
 * It is the entry number in MIGRATIONS.md, not the package version, and it does
 * not move when a release ships without a schema change -- which is most of
 * them. `tools/check-migrations.mjs` fails the build if this disagrees with
 * `migrations/manifest.json`.
 */
export const SCHEMA_VERSION = 10;

export interface MigrationRef {
  /** The entry number in MIGRATIONS.md. */
  version: number;
  /** Filename under `MIGRATIONS_PATH`. */
  file: string;
  title: string;
  /** False when the file contains `CONCURRENTLY` and must not be wrapped. */
  transactional: boolean;
  /** True when the file makes a choice on your behalf. Read it before running. */
  requiresDecision: boolean;
}

export interface SchemaStatus {
  /**
   * `current`      the database is at the version this library expects.
   * `behind`       it is older; `outstanding` lists what to apply.
   * `ahead`        it is newer than this library understands. Upgrade the
   *                library rather than downgrading the database.
   * `unversioned`  every filelayer table is there and the version table is
   *                not, so it was created before 0.15.0. `inferred` says what
   *                it looks like and how to stamp it.
   * `partial`      SOME of the tables are present. Either a half-applied schema
   *                or a name collision with your own tables; `tables` says
   *                which. Applying `schema.sql` would fail part-way either way.
   * `absent`       no filelayer schema here. Apply `schema.sql`.
   */
  state: 'current' | 'behind' | 'ahead' | 'unversioned' | 'partial' | 'absent';
  /** `max(version)`, or null when there is no version table. */
  at: number | null;
  /** `SCHEMA_VERSION`. */
  expects: number;
  /** Migrations this library ships that the database has not recorded. */
  outstanding: MigrationRef[];
  /** Present only for `unversioned`. */
  inferred?: {
    version: number;
    /** The object that establishes it, named so you can check the inference. */
    because: string;
    /** The statement that records it. Read it before you run it. */
    stampWith: string;
  };
  /** Newest first. Empty unless the version table exists. */
  history: { version: number; introducedIn: string; appliedAt: Date; note: string }[];
  /** Which of the schema's tables are present. Populated for `partial`. */
  tables?: { present: string[]; missing: string[] };
}

/**
 * The tables `schema.sql` creates, excluding the version table.
 *
 * COUNTED, NOT PROBED ONE BY ONE, and the reason is a defect
 * `examples/starter/server.ts` had already found and fixed before this function
 * existed. Asking `to_regclass('project')` alone looks sufficient and is not:
 * `project` is a table name an application is entirely likely to already have.
 * Pointed at the database your own app uses, a single probe answers
 * "unversioned, looks like version 1", which is wrong in the direction that
 * does damage -- it invites you to run a migration against somebody else's
 * tables. Counting turns it into three honest answers: none of them, all of
 * them, or some of them, which needs a human.
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
] as const;

/**
 * WHERE IS THIS DATABASE, AND WHAT IS OUTSTANDING. Read-only.
 *
 * -----------------------------------------------------------------------------
 * WHY IT IS READ-ONLY, AND WILL STAY THAT WAY
 * -----------------------------------------------------------------------------
 *
 * This function issues no DDL and never will. A library that alters the
 * adopter's database because something imported it is exactly what a compliance
 * reviewer refuses, and `MIGRATIONS.md` section 2 has always said the same
 * thing for a different reason: your application owns a migration runner and
 * ours has no business competing with it. So this answers the question and
 * hands you the statements. Running them is yours.
 *
 * -----------------------------------------------------------------------------
 * WHY IT EXISTS
 * -----------------------------------------------------------------------------
 *
 * Three independent evaluations of the published package in October 2026, each
 * given nothing but the tarball, wrote back the same sentence: there is no
 * version table, so you cannot tell which version a database is at. One added
 * the consequence -- "track the version yourself until the promised table
 * lands". This is the table, and this is the read.
 *
 * THE `unversioned` CASE IS THE INTERESTING ONE. A database created before
 * `0.15.0` has the tables and no version row, and its version cannot be read
 * off it -- only inferred from which objects are present. So the inference is
 * reported WITH the object it rests on, so you can check it, and the stamp is
 * handed to you as SQL rather than executed.
 */
export async function schemaStatus(db: Queryable): Promise<SchemaStatus> {
  const manifest = JSON.parse(
    await readFile(join(MIGRATIONS_PATH, 'manifest.json'), 'utf8'),
  ) as {
    expects: number;
    migrations: {
      version: number;
      file: string;
      title: string;
      transactional: boolean;
      requiresDecision: boolean;
    }[];
  };
  const all: MigrationRef[] = manifest.migrations.map((m) => ({
    version: m.version,
    file: m.file,
    title: m.title,
    transactional: m.transactional,
    requiresDecision: m.requiresDecision,
  }));

  const exists = async (name: string): Promise<boolean> => {
    const { rows } = await db.query<{ ok: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS ok`,
      [name],
    );
    return Boolean(rows[0]?.ok);
  };

  if (!(await exists('filelayer_schema_version'))) {
    const { rows: tableRows } = await db.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
      [[...SCHEMA_TABLES]],
    );
    const present = tableRows.map((r) => r.name).sort();
    const missing = SCHEMA_TABLES.filter((t) => !present.includes(t));

    if (present.length === 0) {
      return { state: 'absent', at: null, expects: SCHEMA_VERSION, outstanding: [], history: [] };
    }
    if (missing.length > 0) {
      return {
        state: 'partial',
        at: null,
        expects: SCHEMA_VERSION,
        outstanding: [],
        history: [],
        tables: { present, missing: [...missing] },
      };
    }
    // THE MARKERS, newest first. Each is the object that migration created, so
    // the highest one present is the newest migration this database has had.
    const markers: { version: number; because: string; sql: string }[] = [
      { version: 8, because: `constraint file_upload_reservation_complete`,
        sql: `SELECT 1 FROM pg_constraint WHERE conname = 'file_upload_reservation_complete'` },
      { version: 6, because: `trigger audit_no_truncate on audit_event`,
        sql: `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
               WHERE c.relname = 'audit_event' AND t.tgname = 'audit_no_truncate'` },
      { version: 5, because: `index grant_file_subject_type_idx`,
        sql: `SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
               AND indexname = 'grant_file_subject_type_idx'` },
      { version: 3, because: `constraint grant_password_only_on_link`,
        sql: `SELECT 1 FROM pg_constraint WHERE conname = 'grant_password_only_on_link'` },
      { version: 1, because: `table project`, sql: `SELECT 1 FROM pg_tables
               WHERE schemaname = 'public' AND tablename = 'project'` },
    ];
    let found = markers[markers.length - 1]!;
    for (const m of markers) {
      const { rows } = await db.query(m.sql);
      if (rows.length > 0) {
        found = m;
        break;
      }
    }
    return {
      state: 'unversioned',
      at: null,
      expects: SCHEMA_VERSION,
      outstanding: all.filter((m) => m.version > found.version),
      inferred: {
        version: found.version,
        because: found.because,
        // THE STAMP IS MIGRATION 010's JOB, so this points at the file rather
        // than duplicating its SQL -- a second copy of a statement that creates
        // a table is a second thing to keep correct.
        stampWith:
          `apply migrations/010-schema-version.sql, which creates the version table and ` +
          `records version 10. It refuses unless the database is already at the 0.14.0 ` +
          `schema, so apply anything in \`outstanding\` first.`,
      },
      history: [],
    };
  }

  const { rows } = await db.query<{
    version: number;
    introduced_in: string;
    applied_at: Date;
    note: string;
  }>(
    `SELECT version, introduced_in, applied_at, note
       FROM filelayer_schema_version ORDER BY version DESC`,
  );
  const history = rows.map((r) => ({
    version: Number(r.version),
    introducedIn: r.introduced_in,
    appliedAt: r.applied_at,
    note: r.note,
  }));
  const at = history.length ? Math.max(...history.map((h) => h.version)) : null;

  // NO ROWS IN THE VERSION TABLE is a real state and it is not `current`. It
  // means the table exists and nothing stamped it, which `schema.sql` cannot
  // produce -- its INSERT is the last statement in the file and the whole file
  // is one implicit transaction -- so somebody created the table by hand or
  // deleted the row.
  if (at === null) {
    return { state: 'unversioned', at: null, expects: SCHEMA_VERSION, outstanding: all,
      inferred: { version: 0, because: 'the version table exists and is empty',
        stampWith: 'establish which version this database actually is before stamping anything; an empty version table is not a state schema.sql can produce.' },
      history };
  }

  const state = at === SCHEMA_VERSION ? 'current' : at < SCHEMA_VERSION ? 'behind' : 'ahead';
  return {
    state,
    at,
    expects: SCHEMA_VERSION,
    outstanding: all.filter((m) => m.version > at),
    history,
  };
}

/**
 * The one package this library needs and deliberately does not depend on.
 *
 * PGlite is an embedded WASM build of PostgreSQL. It is what `createTestDb()`
 * and `Filelayer.quickstart()` run on, and it is superb for that -- but a
 * library whose premise is "point it at YOUR Postgres" has no business putting
 * a second Postgres into every production `node_modules`. So it is declared as
 * an OPTIONAL PEER DEPENDENCY: named, version-ranged and discoverable, but not
 * installed for anyone who never calls the two helpers that use it.
 *
 * The cost of that choice is this constant and the `catch` below. Without them
 * the failure mode for a consumer who calls `createTestDb()` is a raw
 * ERR_MODULE_NOT_FOUND naming a package they never asked for, from a stack
 * inside our `dist`, and no indication that installing one thing fixes it.
 */
const PGLITE = '@electric-sql/pglite';

/**
 * The install command a caller is handed, spelled out in full.
 *
 * The version constraint is not decoration. PGlite's `latest` on npm is a 0.5.x
 * release and this package declares `peerDependencies` of `^0.3.11`, so an
 * install with no constraint on it can land a version outside the declared
 * range -- at which point npm refuses the whole tree with ERESOLVE and the
 * developer is stuck one minute in, having typed what we told them to type.
 * That happened; it is the defect 0.4.1 fixes.
 *
 * The range is a literal rather than a template so that
 * `tools/check-install-commands.mjs` can read it out of this file and fail the
 * build if it ever stops matching `peerDependencies` in package.json. The two
 * are the same fact written in two places, and the check is what keeps them
 * one fact.
 *
 * The quotes are for the shell, not for npm: `^` is a glob operator under zsh
 * with `extendedglob`, and an escape character in cmd.exe.
 */
const PGLITE_INSTALL = 'npm install --save-dev "@electric-sql/pglite@^0.3.11"';

/** True when `err` is Node refusing to resolve `spec`, and not some other failure. */
function isModuleNotFound(err: unknown, spec: string): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  // A resolution failure *inside* pglite itself is a broken install, not a
  // missing one, and must not be reported as "run npm install".
  return String((err as Error).message ?? '').includes(spec);
}

/**
 * Create an in-process Postgres (PGlite) with the Filelayer schema applied.
 *
 * PGlite is PostgreSQL 17 compiled to WASM: real planner, real constraints,
 * real enums, real arrays, real rules, real transactional semantics. The one
 * thing it is NOT is multi-process, which matters for exactly one test; see
 * test/security.test.ts, "atomic download cap", for what that weakens.
 *
 * REQUIRES the optional peer dependency `@electric-sql/pglite`. Production code
 * does not need it: hand `new Filelayer(...)` your own `pg.Pool`, or anything
 * else that satisfies `Queryable`, and this function is never reached.
 */
export async function createTestDb(): Promise<{
  db: Queryable & { close(): Promise<void> };
  raw: unknown;
}> {
  const { PGlite, pgcrypto } = await importPglite();
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  const sql = await loadSchemaSql();
  await pg.exec(sql);
  return { db: pg as unknown as Queryable & { close(): Promise<void> }, raw: pg };
}

async function importPglite(): Promise<{
  PGlite: typeof import('@electric-sql/pglite').PGlite;
  pgcrypto: typeof import('@electric-sql/pglite/contrib/pgcrypto').pgcrypto;
}> {
  try {
    const [mod, contrib] = await Promise.all([
      import('@electric-sql/pglite'),
      import('@electric-sql/pglite/contrib/pgcrypto'),
    ]);
    return { PGlite: mod.PGlite, pgcrypto: contrib.pgcrypto };
  } catch (err) {
    if (!isModuleNotFound(err, PGLITE)) throw err;
    throw new Error(
      `createTestDb() needs "${PGLITE}", which is not installed.\n` +
        `\n` +
        `  ${PGLITE_INSTALL}\n` +
        `\n` +
        `The version is part of the command. @filelayer/core supports the 0.3.x line\n` +
        `of ${PGLITE}; 0.5.x is not supported, because the test suite does\n` +
        `not pass against it. Installing without the constraint can resolve to a\n` +
        `version outside the supported range, and npm then refuses the install with\n` +
        `ERESOLVE rather than giving you a working tree.\n` +
        `\n` +
        `It is an OPTIONAL peer dependency of @filelayer/core, on purpose: it is an\n` +
        `embedded WASM PostgreSQL used by createTestDb() and Filelayer.quickstart()\n` +
        `for tests and local development, and shipping it to production installs of\n` +
        `a library that talks to your own Postgres would be wrong.\n` +
        `\n` +
        `In production, do not call this. Pass your own database instead:\n` +
        `\n` +
        `  import { Pool } from 'pg';\n` +
        `  new Filelayer(new Pool({ connectionString: process.env.DATABASE_URL }), storage, opts)\n` +
        `\n` +
        `and apply the schema once with:\n` +
        `\n` +
        `  psql "$DATABASE_URL" -f node_modules/@filelayer/core/schema.sql\n`,
      { cause: err },
    );
  }
}
