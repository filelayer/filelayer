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

/**
 * Create an in-process Postgres (PGlite) with the Filelayer schema applied.
 *
 * PGlite is PostgreSQL 17 compiled to WASM: real planner, real constraints,
 * real enums, real arrays, real rules, real transactional semantics. The one
 * thing it is NOT is multi-process, which matters for exactly one test; see
 * test/security.test.ts, "atomic download cap", for what that weakens.
 */
export async function createTestDb(): Promise<{
  db: Queryable & { close(): Promise<void> };
  raw: unknown;
}> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const pg = await PGlite.create({ extensions: { pgcrypto } });
  const sql = await loadSchemaSql();
  await pg.exec(sql);
  return { db: pg as unknown as Queryable & { close(): Promise<void> }, raw: pg };
}
