/**
 * A REAL POSTGRES, WITH REAL BACKENDS, FOR THE TESTS THAT NEED CONTENTION.
 *
 * WHY THIS FILE EXISTS. Every other test in this suite runs on PGlite, which is
 * PostgreSQL 17 compiled to WebAssembly: the real planner, the real constraints,
 * real transactional semantics. It is excellent and it has found real defects.
 * It has exactly one limitation that matters, and it is the one that matters
 * most to this library: PGlite has A SINGLE BACKEND. Two transactions never
 * overlap. Statements from two "concurrent" callers are serialised end to end
 * by the engine itself, so a check-then-act race cannot be staged on it, and a
 * lock that is never contended cannot be observed to work.
 *
 * That left a whole class of claims argued rather than tested. On 2 October 2026
 * an adversarial sweep found three races in this codebase -- the `last_owner`
 * guard, the download counter, and the audit chain -- and the fixes shipped in
 * 0.7.0 could be reasoned about but NOT PROVEN, because the only engine
 * available could not produce the interleaving they defend against. TRUST.md
 * said so in as many words: *"argued from Postgres semantics and tested on a
 * single-backend engine ... reasoned and followed, not proven under real
 * contention."*
 *
 * A fix you cannot test is a belief. This file is how that sentence stops being
 * true.
 *
 * HOW IT PICKS AN ENGINE, in order:
 *
 *   1. `FILELAYER_TEST_DATABASE_URL`, if set. This is what CI uses: a real
 *      `postgres:17` service container. A maintainer can point it at anything.
 *   2. Otherwise an embedded Postgres, downloaded and run as an ordinary user
 *      process. No root, no Docker, no service. It is a real server with real
 *      backends -- just one that cleans up after itself.
 *
 * Either way `pg.Pool` hands out SEPARATE CONNECTIONS, which is the entire
 * point. Nothing below means anything on a single-backend engine.
 *
 * WHAT IT DOES NOT DO. It does not replace PGlite for the rest of the suite.
 * The other 364 tests stay where they are: they are about semantics, not
 * scheduling, they run in two seconds, and they need no server at all. This is
 * for the handful of properties that only exist when two backends collide.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { Queryable, QueryResult } from '../src/db.ts';

/**
 * `pg` IS LOADED LAZILY, AND THE TYPE IMPORT ABOVE IS ERASED.
 *
 * This file used `import pg from 'pg'` until 5 October 2026, which made the
 * driver a load-time requirement of the module rather than a requirement of the
 * tests that use it. The suite SHIPS in the npm tarball, `pg` is deliberately
 * not a dependency of the published package, and `embedded-postgres` is not
 * either. So anyone who installed `@filelayer/core` and ran the tests we invite
 * them to run got `ERR_MODULE_NOT_FOUND` out of `contention.test.ts`: 524 tests
 * and one hard failure, instead of 547 and a clean skip.
 *
 * The skip logic in `contention.test.ts` was correct the whole time and never
 * got to execute, because a static import fails before any `before()` hook
 * runs. `embedded-postgres` was already imported dynamically ten lines below,
 * so one of the two optional dependencies was handled and the other was not.
 *
 * A reader who runs our suite and sees a failure is the reader who was taking
 * us seriously enough to check, which makes this the most expensive possible
 * place to have a broken first impression.
 */
let pgModule: typeof import('pg') | null | undefined;

async function loadPg(): Promise<typeof import('pg') | null> {
  if (pgModule !== undefined) return pgModule;
  try {
    pgModule = (await import('pg')).default as unknown as typeof import('pg');
  } catch {
    pgModule = null;
  }
  return pgModule;
}

const SCHEMA_SQL = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema.sql');

/**
 * One embedded server for the whole file, started lazily and stopped once.
 *
 * Starting Postgres costs a second or two; starting one per test would cost
 * more than the tests. Isolation comes from a fresh DATABASE per world, which
 * is cheap once the server is up.
 */
let embedded: { stop(): Promise<void>; url: string } | null = null;
let startingEmbedded: Promise<{ stop(): Promise<void>; url: string }> | null = null;

async function startEmbedded(): Promise<{ stop(): Promise<void>; url: string }> {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // A high, randomised port: two test files running in parallel must not fight
  // over one, and a developer's own Postgres on 5432 must not be touched.
  const port = 55000 + Math.floor(Math.random() * 2000);
  const databaseDir = join('/tmp', `filelayer-pg-${randomUUID()}`);
  const server = new EmbeddedPostgres({
    databaseDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
  });
  await server.initialise();
  await server.start();
  return {
    url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
    stop: () => server.stop(),
  };
}

/** The connection string for the server these tests run against. */
async function serverUrl(): Promise<string> {
  const given = process.env['FILELAYER_TEST_DATABASE_URL'];
  if (given) return given;
  if (!embedded) {
    startingEmbedded ??= startEmbedded();
    embedded = await startingEmbedded;
  }
  return embedded.url;
}

/**
 * True when a real server is reachable, so a suite can skip rather than fail on
 * a machine that has neither a `DATABASE_URL` nor the ability to run the
 * embedded build.
 *
 * CI DOES NOT USE THIS. The whole value of these tests is that they run, so the
 * workflow sets `FILELAYER_TEST_DATABASE_URL` and a separate guard fails the job
 * if the suite skipped itself anyway -- the failure mode that looks exactly like
 * success, and which we have already been bitten by once on the R2 job.
 */
export async function realPostgresAvailable(): Promise<boolean> {
  return (await probeRealPostgres()).ok;
}

/**
 * The same probe, with the REASON it failed.
 *
 * "No server answered" and "the driver is not installed" are different
 * problems with different fixes, and a caller that refuses to skip needs to
 * say which one it hit. Reporting the wrong one sends a reader to check their
 * `DATABASE_URL` when what they actually need is `npm i -D pg`.
 */
export async function probeRealPostgres(): Promise<{ ok: true } | { ok: false; why: string }> {
  const PG = await loadPg();
  if (!PG) {
    return {
      ok: false,
      why:
        "the `pg` driver is not installed. It is not a dependency of @filelayer/core, " +
        'by design: the library takes any `Queryable` and does not choose your driver. ' +
        'To run the suites that need a real server: `npm i -D pg embedded-postgres`.',
    };
  }
  try {
    const url = await serverUrl();
    const c = new PG.Client({ connectionString: url });
    await c.connect();
    await c.end();
    return { ok: true };
  } catch (e) {
    return { ok: false, why: `no server answered: ${(e as Error).message}` };
  }
}

/** node-postgres speaks `rowCount`; `Queryable` speaks `affectedRows`. */
function adapt(poolOrClient: Pool | PoolClient): Queryable {
  return {
    async query<R = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const r = await poolOrClient.query(sql, params as unknown[]);
      return { rows: r.rows as R[], affectedRows: r.rowCount ?? 0 } satisfies QueryResult<R>;
    },
  };
}

export interface RealDb {
  /**
   * A POOL, deliberately. `withTransaction` prefers `connect()` and keeps a
   * transaction on one checked-out client, which is the production shape and
   * the only one under which these tests prove anything.
   */
  db: Queryable;
  pool: Pool;
  /** A second, independent connection: the other half of every race below. */
  connect(): Promise<{ q: Queryable; release(): void }>;
  close(): Promise<void>;
}

/**
 * A fresh, isolated database with the schema applied.
 *
 * A DATABASE rather than a schema inside one, because `schema.sql` creates an
 * extension and a handful of functions in `public` and the tests should not
 * have to care about `search_path`. Creating one costs milliseconds.
 */
export async function createRealDb(opts: { max?: number } = {}): Promise<RealDb> {
  const url = await serverUrl();
  const name = `fl_${randomUUID().replace(/-/g, '')}`;

  const PG = (await loadPg())!;

  const admin = new PG.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const dbUrl = new URL(url);
  dbUrl.pathname = `/${name}`;
  /**
   * `max` MUST EXCEED the number of connections a test holds at once, plus one
   * for `db` itself. `pool.connect()` does not fail when the pool is exhausted,
   * it QUEUES, so asking for more than `max` and releasing none of them is a
   * silent hang rather than an error. That cost a run while writing this file:
   * a ten-connection test against a pool of eight simply stopped, with no
   * output and no failure.
   */
  const pool = new PG.Pool({ connectionString: dbUrl.toString(), max: opts.max ?? 24 });

  const sql = await readFile(SCHEMA_SQL, 'utf8');
  const setup = await pool.connect();
  try {
    await setup.query(sql);
  } finally {
    setup.release();
  }

  const pooled = pool as unknown as Queryable & { connect: unknown };

  return {
    // The pool itself: it has `connect`, so `withTransaction` checks a client
    // out and the unit of work stays on one backend.
    db: pooled,
    pool,
    async connect() {
      const client = await pool.connect();
      return { q: adapt(client), release: () => client.release() };
    },
    async close() {
      await pool.end();
    },
  };
}

/** Stop the embedded server, if this process started one. */
export async function stopRealPostgres(): Promise<void> {
  if (embedded) {
    const e = embedded;
    embedded = null;
    startingEmbedded = null;
    await e.stop();
  }
}

/**
 * Run `fn` on two independent connections at the same time and return both
 * outcomes, settled rather than thrown.
 *
 * `Promise.all` would hide the interesting case: when one of two racing callers
 * is SUPPOSED to lose, the test needs to see HOW it lost, not merely that
 * something rejected.
 */
export async function race<T>(
  real: RealDb,
  a: (q: Queryable) => Promise<T>,
  b: (q: Queryable) => Promise<T>,
): Promise<[PromiseSettledResult<T>, PromiseSettledResult<T>]> {
  const ca = await real.connect();
  const cb = await real.connect();
  try {
    const [ra, rb] = await Promise.allSettled([a(ca.q), b(cb.q)]);
    return [ra, rb];
  } finally {
    ca.release();
    cb.release();
  }
}
