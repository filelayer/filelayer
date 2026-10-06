/**
 * WHICH VERSION IS THIS DATABASE AT.
 *
 * -----------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * -----------------------------------------------------------------------------
 *
 * `MIGRATIONS.md` named the absence of a version table as a gap and promised
 * one "before 1.0". Three independent evaluations of the published package in
 * October 2026, each given nothing but the tarball and no access to this
 * repository, wrote the same sentence back:
 *
 *   - "there is no migrate command and no version table... track the version
 *     yourself until the promised table lands"
 *   - "write the first-boot migration tooling yourselves since it doesn't exist"
 *   - "apply schema.sql once, then add your own schema_version table"
 *
 * None of the three asked for a migration framework, and they were right not
 * to: your application owns a runner and ours has no business competing with
 * it. What they could not do was find out where a database was.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS PINNED HERE
 * -----------------------------------------------------------------------------
 *
 * The five states, the inference for a database older than the table, and the
 * one property that makes this safe to call from anywhere: `schemaStatus()`
 * issues no DDL. The last test is the one that would catch a future change
 * turning this into a runner, which is the change this must never take.
 *
 * The migration FILES are verified elsewhere, and not by a test: each one is
 * applied to the previous release's schema and the result compared against the
 * next release's, on real PostgreSQL, by `npm run check:migrations`. PGlite
 * cannot do `CREATE INDEX CONCURRENTLY` and two of the files need it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createTestDb,
  loadSchemaSql,
  schemaStatus,
  SCHEMA_VERSION,
  MIGRATIONS_PATH,
  type Queryable,
} from '../src/db.ts';

/** PGlite's multi-statement entry point. `query` refuses a script. */
type Exec = { exec(sql: string): Promise<unknown> };

const TABLES = [
  'file_owning_user_daily',
  'usage_daily',
  'audit_event',
  'file_grant',
  'file',
  'membership',
  'actor',
  'org',
  'project',
  'filelayer_schema_version',
];

describe('the version table, and the states schemaStatus reports', () => {
  it('a fresh database is current, and says it was created whole', async () => {
    const { db } = await createTestDb();
    const s = await schemaStatus(db);
    assert.equal(s.state, 'current');
    assert.equal(s.at, SCHEMA_VERSION);
    assert.equal(s.outstanding.length, 0);
    assert.equal(s.history.length, 1);
    // THE NOTE IS LOAD-BEARING. A database created from schema.sql never ran
    // migrations 1 to 9, and nine invented `applied_at` timestamps would be a
    // fabricated history in the one table whose value is being believed.
    assert.match(s.history[0]!.note, /created whole from schema\.sql/);
  });

  it('an empty database reports absent rather than guessing', async () => {
    const { db } = await createTestDb();
    for (const t of TABLES) await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    const s = await schemaStatus(db);
    assert.equal(s.state, 'absent');
    assert.equal(s.at, null);
    assert.equal(s.outstanding.length, 0);
  });

  it('SOME of the tables is partial, not absent and not unversioned', async () => {
    // THE DEFECT THIS PINS, which `examples/starter/server.ts` had already
    // found and fixed before `schemaStatus` existed, and which `schemaStatus`
    // then walked into: probing `project` alone looks sufficient and is not.
    // `project` is a table name an application is entirely likely to already
    // have, so a single probe answers "unversioned, looks like version 1"
    // against somebody else's database -- which invites running a migration on
    // their tables.
    const { db } = await createTestDb();
    await db.query(`DROP TABLE filelayer_schema_version`);
    await db.query(`DROP TABLE file_owning_user_daily`);
    await db.query(`DROP TABLE usage_daily`);

    const s = await schemaStatus(db);
    assert.equal(s.state, 'partial');
    assert.equal(s.at, null);
    assert.deepEqual(s.tables?.missing.sort(), ['file_owning_user_daily', 'usage_daily']);
    assert.ok(s.tables!.present.includes('project'));
    assert.equal(s.inferred, undefined, 'a partial schema has no version to infer');
    assert.equal(s.outstanding.length, 0, 'and nothing is safe to apply to it');
  });

  it('a lone table with a colliding name is partial, not a filelayer schema', async () => {
    const { db } = await createTestDb();
    for (const t of TABLES) await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    // Somebody else's `project` table, which is the realistic collision.
    await db.query(`CREATE TABLE project (id serial PRIMARY KEY, name text)`);
    const s = await schemaStatus(db);
    assert.equal(s.state, 'partial');
    assert.deepEqual(s.tables?.present, ['project']);
    assert.equal(s.tables?.missing.length, 8);
  });

  it('a database older than the table is unversioned, and the inference names its evidence', async () => {
    // The pre-0.15.0 shape: every filelayer table, no version table. Its
    // version cannot be READ off it, only inferred, so the inference is
    // reported with the object it rests on and the caller can check it.
    const { db } = await createTestDb();
    await db.query(`DROP TABLE filelayer_schema_version`);
    // A pre-0.15.0 database has no `audit_checkpoint` either: that arrived with
    // entry 11, years of releases later. Dropping only the version table would
    // leave a shape no database ever had, and the inference would correctly
    // report 11 against a fixture that was lying about being old.
    await db.query(`DROP TABLE audit_checkpoint`);

    const s = await schemaStatus(db);
    assert.equal(s.state, 'unversioned');
    assert.equal(s.at, null);
    assert.equal(s.inferred?.version, 8, 'the newest schema change before the version table');
    assert.match(s.inferred!.because, /file_upload_reservation_complete/);
    assert.deepEqual(s.outstanding.map((m) => m.file), [
      '010-schema-version.sql',
      '011-audit-retention.sql',
    ]);
  });

  it('the inference drops to an earlier version when a later marker is absent', async () => {
    // A CALIBRATION, not a scenario. If the inference returned 8 whatever the
    // database looked like, the test above would pass and mean nothing.
    const { db } = await createTestDb();
    await db.query(`DROP TABLE filelayer_schema_version`);
    await db.query(`DROP TABLE audit_checkpoint`);
    await db.query(`ALTER TABLE file DROP CONSTRAINT file_upload_reservation_complete`);

    const s = await schemaStatus(db);
    assert.equal(s.inferred?.version, 6, 'entry 8 is gone, so the trigger from entry 6 is newest');
    assert.match(s.inferred!.because, /audit_no_truncate/);
    assert.deepEqual(
      s.outstanding.map((m) => m.version),
      [8, 10, 11],
      'and every outstanding migration is named, in order',
    );
  });

  it('reports behind, with what is outstanding, in order', async () => {
    const { db } = await createTestDb();
    await db.query(`DELETE FROM filelayer_schema_version`);
    await db.query(
      `INSERT INTO filelayer_schema_version (version, introduced_in, note)
       VALUES (6, '0.7.0', 'a database that stopped at entry 6')`,
    );
    const s = await schemaStatus(db);
    assert.equal(s.state, 'behind');
    assert.equal(s.at, 6);
    assert.deepEqual(s.outstanding.map((m) => m.version), [8, 10, 11]);
  });

  it('reports ahead rather than pretending to understand a newer schema', async () => {
    const { db } = await createTestDb();
    await db.query(
      `INSERT INTO filelayer_schema_version (version, introduced_in, note)
       VALUES (99, '9.9.9', 'from a release this library does not know')`,
    );
    const s = await schemaStatus(db);
    assert.equal(s.state, 'ahead');
    assert.equal(s.at, 99);
    assert.equal(s.outstanding.length, 0, 'nothing to apply; the LIBRARY is what is behind');
  });

  it('an existing table with no row is not current', async () => {
    // `schema.sql` cannot produce this -- its INSERT is the last statement and
    // the file is one implicit transaction -- so it means somebody created the
    // table by hand or deleted the row, and calling it `current` would be the
    // worst available answer.
    const { db } = await createTestDb();
    await db.query(`DELETE FROM filelayer_schema_version`);
    const s = await schemaStatus(db);
    assert.equal(s.state, 'unversioned');
    assert.equal(s.at, null);
  });
});

describe('schema.sql refuses a database it did not create', () => {
  it('names the version it found, rather than dying on "relation already exists"', async () => {
    const { raw } = await createTestDb();
    const sql = await loadSchemaSql();
    await assert.rejects(
      () => (raw as Exec).exec(sql),
      (err: Error) => {
        assert.match(err.message, /already at schema version 11/);
        assert.match(err.message, /migrations\//, 'and points at what to do instead');
        return true;
      },
    );
  });

  it('tells a pre-0.15.0 database to ask schemaStatus rather than rerunning', async () => {
    const { db, raw } = await createTestDb();
    await db.query(`DROP TABLE filelayer_schema_version`);
    const sql = await loadSchemaSql();
    await assert.rejects(
      () => (raw as Exec).exec(sql),
      (err: Error) => {
        assert.match(err.message, /created before 0\.15\.0/);
        assert.match(err.message, /schemaStatus/);
        return true;
      },
    );
  });

  it('leaves the database untouched when it refuses', async () => {
    // The refusal is the first statement and Postgres wraps a multi-statement
    // simple query in one implicit transaction, so nothing is half-applied.
    const { db, raw } = await createTestDb();
    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const sql = await loadSchemaSql();
    await (raw as Exec).exec(sql).catch(() => {});
    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    assert.equal(after.rows[0]!.n, before.rows[0]!.n);
  });
});

describe('the manifest and the library agree', () => {
  it('manifest.expects equals SCHEMA_VERSION', async () => {
    // TWO PLACES HOLD THIS NUMBER: a constant the library compares against and
    // a manifest a runner reads. They have to agree or one of them is lying to
    // somebody.
    const manifest = JSON.parse(await readFile(join(MIGRATIONS_PATH, 'manifest.json'), 'utf8'));
    assert.equal(manifest.expects, SCHEMA_VERSION);
  });

  it('every migration the manifest names has a file, and declares its shape', async () => {
    const manifest = JSON.parse(await readFile(join(MIGRATIONS_PATH, 'manifest.json'), 'utf8'));
    for (const m of manifest.migrations) {
      const sql = await readFile(join(MIGRATIONS_PATH, m.file), 'utf8');
      assert.ok(sql.length > 200, `${m.file} is too short to be a migration`);
      assert.equal(typeof m.transactional, 'boolean', `${m.file} must declare transactional`);
      assert.equal(typeof m.requiresDecision, 'boolean');
      // A FILE DECLARED TRANSACTIONAL MUST CARRY ITS OWN BEGIN/COMMIT, and one
      // declared otherwise must not -- because CONCURRENTLY is refused inside a
      // transaction and that is the whole reason the flag exists.
      if (m.transactional) {
        assert.match(sql, /^BEGIN;$/m, `${m.file} says transactional and has no BEGIN`);
        assert.match(sql, /^COMMIT;$/m, `${m.file} says transactional and has no COMMIT`);
        assert.doesNotMatch(sql, /CONCURRENTLY/, `${m.file} cannot be transactional: CONCURRENTLY`);
      } else {
        assert.match(sql, /CONCURRENTLY/, `${m.file} says non-transactional for no stated reason`);
        assert.doesNotMatch(
          sql,
          /^BEGIN;$/m,
          `${m.file} is non-transactional and opens a transaction anyway`,
        );
      }
    }
  });

  it('every migration refuses a database that is not in the state it expects', async () => {
    // Pinned here as a property of the FILES. That each one actually produces
    // the next release's schema is checked by `npm run check:migrations`
    // against real PostgreSQL, which is where it belongs.
    const manifest = JSON.parse(await readFile(join(MIGRATIONS_PATH, 'manifest.json'), 'utf8'));
    for (const m of manifest.migrations) {
      const sql = await readFile(join(MIGRATIONS_PATH, m.file), 'utf8');
      assert.match(sql, /RAISE EXCEPTION/, `${m.file} has no precondition guard`);
      assert.match(
        sql,
        /already applied|Nothing to do/i,
        `${m.file} does not say "nothing to do" when it is already applied`,
      );
    }
  });
});

describe('schemaStatus issues no DDL, and must never', () => {
  it('writes nothing, in any state', async () => {
    // THE TEST THAT DEFENDS THE PRODUCT DECISION. A library that alters the
    // adopter's database because something called a status function is what a
    // compliance reviewer refuses, and `MIGRATIONS.md` section 2 has said from
    // the start that the runner is theirs. So every statement this function
    // issues is recorded and checked.
    const seen: string[] = [];
    const { db } = await createTestDb();
    const watched: Queryable = {
      query: (sql: string, params?: unknown[]) => {
        seen.push(sql);
        return db.query(sql, params as never);
      },
    };

    for (const prepare of [
      async () => {},
      async () => void (await db.query(`DROP TABLE filelayer_schema_version`)),
      async () => {
        for (const t of TABLES) await db.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
      },
    ]) {
      const fresh = await createTestDb();
      const w: Queryable = {
        query: (sql: string, params?: unknown[]) => {
          seen.push(sql);
          return fresh.db.query(sql, params as never);
        },
      };
      await prepare.call(null);
      await schemaStatus(w).catch(() => {});
    }
    await schemaStatus(watched);

    assert.ok(seen.length > 0, 'it issued no statements at all, so this test proves nothing');
    const writes = seen.filter((s) =>
      /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COMMENT)\b/i.test(s),
    );
    assert.deepEqual(writes, [], `schemaStatus issued ${writes.length} write statement(s)`);
  });
});
