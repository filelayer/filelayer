#!/usr/bin/env node
/**
 * EVERY MIGRATION FILE HAS BEEN EXECUTED, AGAINST THE SCHEMA IT CLAIMS TO
 * UPGRADE, AND PRODUCES THE SCHEMA IT CLAIMS TO PRODUCE.
 *
 *   node tools/check-migrations.mjs              # check, exit 1 on a hit
 *   node tools/check-migrations.mjs --list       # the hops it will run
 *   node tools/check-migrations.mjs --self-test  # the negative controls only
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * `MIGRATIONS.md` section 2 promised, from the first release that had it, "the
 * forward SQL, written to be pasted into your own migration tool". On
 * 4 October 2026 that promise was checked against the thirteen fenced SQL
 * blocks in the file, and it was not kept:
 *
 *   * Entry 3's forward block carries `2a. Revoke them (recommended)` AND
 *     `2b. ...keep them open and drop the inert hash` as consecutive
 *     statements. A runner does both: revokes every password-bearing grant and
 *     then strips the hashes off the grants it just revoked.
 *   * Entry 8 has four blocks, three of which are three formulations of the
 *     same change offered so you could pick by table size. In sequence they
 *     create the same index twice.
 *   * Entry 6's second block has a `<your_app_role>` placeholder.
 *   * Entries 1, 4 and 5 are not complete scripts: entry 1 ends by telling you
 *     to copy blocks "verbatim from schema.sql" at a version the tree no longer
 *     has, entry 4's only block is a detection SELECT, entry 5's second is an
 *     EXPLAIN.
 *   * Entries 5 and 8 need `CREATE INDEX CONCURRENTLY`, which Postgres refuses
 *     inside a transaction -- so a runner that wraps each file in one, which
 *     most do by default, fails on them.
 *
 * Nothing in that was false in prose. Every block is labelled where it sits.
 * The trap is the instruction plus the shape, and nobody had walked into it
 * only because nobody has ever run these migrations: there are no installs.
 *
 * This is the same defect this project has now found three times -- a claim
 * with no runner behind it. `examples/starter/verify.mjs` shipped as a test
 * suite nothing executed. Every documentation gate ran beside the repository
 * rather than inside an install. And the forward SQL was prose that had never
 * been SQL. In all three the fix was the same: make the artifact executable and
 * then execute it on every commit.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES
 * -----------------------------------------------------------------------------
 *
 * For each entry in `packages/core/migrations/manifest.json` that names a
 * `verifiedAgainst` pair:
 *
 *   1. Start a real PostgreSQL and create two databases.
 *   2. In BEFORE, apply `schema.sql` as it was at the `from` tag,
 *      read out of git. That is the schema the migration claims to upgrade.
 *   3. In AFTER, apply `schema.sql` as it is at the `to` tag. That is the
 *      schema the migration claims to produce, built the way a new install
 *      gets it.
 *   4. Apply the migration file to BEFORE, honouring `transactional`.
 *   5. Fingerprint both databases -- columns, every constraint definition,
 *      every index definition, enum labels in order, triggers, rules, function
 *      signatures -- and require them to be equal.
 *
 * A fingerprint rather than a text diff of the two files, because two SQL files
 * that differ in comments, whitespace or statement order can describe the same
 * database, and a migration's job is to produce the same DATABASE.
 *
 * REAL POSTGRESQL, NOT THE WASM BUILD the rest of the suite runs on. PGlite has
 * a single backend and answers `CREATE INDEX CONCURRENTLY` with
 * `tuple concurrently updated`, so two of the five files could not be verified
 * on it at all -- and a migration is a thing you run against a real server.
 *
 * -----------------------------------------------------------------------------
 * THE NEGATIVE CONTROLS
 * -----------------------------------------------------------------------------
 *
 * Two, run on every invocation:
 *
 *   1. The comparator must call two different schemas different. It is given
 *      the `from` and `to` schemas of a hop with no migration applied, and must
 *      report a difference. A comparator that returns "equal" for everything
 *      makes every check below a green tick of no value.
 *   2. The comparator must call the same schema the same, twice built. Any
 *      per-build nondeterminism -- a generated constraint name, a timestamp in
 *      a default -- would make every hop fail for a reason that is not the
 *      migration's fault, and the failure message would send someone hunting in
 *      the wrong file.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(ROOT, 'packages', 'core');
const MIG = join(CORE, 'migrations');
const KEEP = process.argv.includes('--keep');

const requireFromCore = createRequire(join(CORE, 'package.json'));
const importFromCore = (name) => import(pathToFileURL(requireFromCore.resolve(name)).href);

const manifest = JSON.parse(readFileSync(join(MIG, 'manifest.json'), 'utf8'));

/** `schema.sql` as it was at a git ref. `HEAD` means the working tree. */
function schemaAt(ref) {
  if (ref === 'HEAD') return readFileSync(join(CORE, 'schema.sql'), 'utf8');
  return execFileSync('git', ['show', `${ref}:packages/core/schema.sql`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
}

// --- the fingerprint --------------------------------------------------------
//
// Function BODIES are deliberately absent. `pg_get_functiondef` differs on
// whitespace that `CREATE OR REPLACE` normalises differently, and a body
// difference that matters shows up as a behaviour difference in the 531-test
// suite, which is a better instrument for it than string equality.
const SECTIONS = {
  columns: `
    SELECT table_name || '.' || column_name || ' ' || data_type
           || CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
           || COALESCE(' DEFAULT ' || column_default, '') AS d
      FROM information_schema.columns WHERE table_schema = 'public'`,
  constraints: `
    SELECT c.conrelid::regclass || ' ' || c.conname || ' ' || pg_get_constraintdef(c.oid) AS d
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE n.nspname = 'public'`,
  indexes: `SELECT indexdef AS d FROM pg_indexes WHERE schemaname = 'public'`,
  enums: `
    SELECT t.typname || ' = ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS d
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' GROUP BY t.typname`,
  triggers: `
    SELECT c.relname || ' ' || t.tgname || ' ' || pg_get_triggerdef(t.oid) AS d
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal`,
  rules: `
    SELECT c.relname || ' ' || r.rulename || ' ' || pg_get_ruledef(r.oid) AS d
      FROM pg_rewrite r JOIN pg_class c ON c.oid = r.ev_class
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND r.rulename <> '_RETURN'`,
  functions: `
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') -> '
           || pg_get_function_result(p.oid) AS d
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'`,
};

/**
 * `filelayer_schema_version` is EXCLUDED from the fingerprint's row contents
 * but not from its structure: the table and its constraints are compared, the
 * rows in it are not. A migrated database says "stamped on an existing
 * database" and a fresh one says "created whole from schema.sql", which is a
 * real and deliberate difference in the data, and comparing it would require
 * one of those two notes to be a lie.
 */
async function fingerprint(client) {
  const out = {};
  for (const [name, sql] of Object.entries(SECTIONS)) {
    const { rows } = await client.query(sql);
    out[name] = rows.map((r) => String(r.d).replace(/\s+/g, ' ').trim()).sort();
  }
  return out;
}

function differences(a, b, labelA, labelB) {
  const lines = [];
  for (const section of Object.keys(SECTIONS)) {
    const setA = new Set(a[section]);
    const setB = new Set(b[section]);
    for (const x of a[section]) if (!setB.has(x)) lines.push(`    ${section}: only after the MIGRATION (${labelA}):  ${x}`);
    for (const x of b[section]) if (!setA.has(x)) lines.push(`    ${section}: only in a FRESH ${labelB}:  ${x}`);
  }
  return lines;
}

// --- running a migration file ----------------------------------------------
//
// `transactional: false` means the file contains CONCURRENTLY and MUST NOT be
// wrapped, so the statements are split and sent one at a time. The splitter is
// deliberately crude and the files are written for it: statements end at a
// semicolon that is at the end of a line, and dollar-quoted bodies are tracked
// so a `$$ ... ; ... $$` block is not cut in half.
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let dollar = null;
  for (const line of sql.split('\n')) {
    buf += line + '\n';
    const tags = line.match(/\$[A-Za-z_]*\$/g) ?? [];
    for (const t of tags) {
      if (dollar === null) dollar = t;
      else if (dollar === t) dollar = null;
    }
    if (dollar === null && /;\s*$/.test(line)) {
      const stripped = buf
        .split('\n')
        .filter((l) => !/^\s*--/.test(l))
        .join('\n')
        .trim();
      if (stripped) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function applyMigration(client, sql, transactional) {
  if (transactional) {
    // The file carries its own BEGIN/COMMIT, so it goes as one script.
    await client.query(sql);
    return;
  }
  for (const stmt of splitStatements(sql)) await client.query(stmt);
}

// --- boot one real PostgreSQL ----------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'filelayer-migrations-'));
let pgHandle = null;
let Client;

async function cleanup() {
  if (pgHandle) await pgHandle.stop().catch(() => {});
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`\n  kept: ${work}`);
}
process.on('SIGINT', () => cleanup().then(() => process.exit(130)));

const problems = [];
const ran = [];
let harnessLog = [];

try {
  if (process.argv.includes('--list')) {
    for (const m of manifest.migrations) {
      const v = m.verifiedAgainst;
      console.log(
        `  ${String(m.version).padStart(3, '0')}  ${v ? `${v.from} -> ${v.to}` : 'NOT VERIFIED'}` +
          `  ${m.transactional ? 'txn   ' : 'no-txn'}  ${m.file}`,
      );
    }
    for (const u of manifest.unverifiable) console.log(`  ${String(u.version).padStart(3, '0')}  unverifiable: ${u.why}`);
    await cleanup();
    process.exit(0);
  }

  console.log('\nthe migration files, executed\n');
  process.stdout.write('  starting PostgreSQL ... ');
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await importFromCore('embedded-postgres'));
    ({ Client } = requireFromCore('pg'));
  } catch (err) {
    console.error(
      `\n\ncheck-migrations: ${err.message}\n\nRun \`npm ci --prefix packages/core\` first.\n`,
    );
    await cleanup();
    process.exit(1);
  }
  const port = 55000 + Math.floor(Math.random() * 2000);
  // THE SERVER'S OWN LOG IS CAPTURED, NOT PRINTED. `initdb` writes twenty lines
  // about locales and `postgres` logs every guard this gate deliberately
  // triggers as an ERROR, so the default is a wall of text in which the five
  // lines that matter are invisible. Kept in `serverLog` and printed only when
  // something fails, which is when it is worth reading.
  const serverLog = [];
  pgHandle = new EmbeddedPostgres({
    databaseDir: join(work, 'pg'),
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: (m) => serverLog.push(String(m)),
    onError: (m) => serverLog.push(String(m?.message ?? m)),
  });
  harnessLog = serverLog;
  await pgHandle.initialise();
  await pgHandle.start();
  console.log(`ok (port ${port})`);

  const url = (dbName) => `postgresql://postgres:postgres@127.0.0.1:${port}/${dbName}`;

  /** A fresh database with `sql` applied, and a connected client. */
  async function freshDb(sql, label) {
    const name = `fl_${label.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_${randomUUID().slice(0, 8)}`;
    const admin = new Client({ connectionString: url('postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const c = new Client({ connectionString: url(name) });
    await c.connect();
    await c.query(sql);
    return c;
  }

  // --- negative control 1: the comparator must see a real difference --------
  process.stdout.write('  control: two different schemas compare as different ... ');
  {
    const probe = manifest.migrations.find((m) => m.verifiedAgainst);
    const before = await freshDb(schemaAt(probe.verifiedAgainst.from), 'ctl_before');
    const after = await freshDb(schemaAt(probe.verifiedAgainst.to), 'ctl_after');
    const d = differences(await fingerprint(before), await fingerprint(after), 'before', 'after');
    await before.end();
    await after.end();
    if (d.length === 0) {
      problems.push(
        `the comparator reported NO difference between the ${probe.verifiedAgainst.from} and ` +
          `${probe.verifiedAgainst.to} schemas, which differ. Every result below would be a ` +
          `green tick of no value.`,
      );
      console.log('FAILED');
    } else {
      console.log(`ok (${d.length} difference(s) seen)`);
    }
  }

  // --- negative control 2: the comparator must be deterministic -------------
  process.stdout.write('  control: the same schema built twice compares as equal ... ');
  {
    const a = await freshDb(schemaAt('HEAD'), 'ctl_det_a');
    const b = await freshDb(schemaAt('HEAD'), 'ctl_det_b');
    const d = differences(await fingerprint(a), await fingerprint(b), 'a', 'b');
    await a.end();
    await b.end();
    if (d.length) {
      problems.push(
        'the same schema, built twice, did not compare as equal. Something in the fingerprint ' +
          'is nondeterministic, so every hop below would fail for a reason that is not the ' +
          `migration's fault:\n${d.join('\n')}`,
      );
      console.log('FAILED');
    } else {
      console.log('ok');
    }
  }

  // --- the hops -------------------------------------------------------------
  const onDisk = new Set(readdirSync(MIG).filter((f) => f.endsWith('.sql')));
  for (const m of manifest.migrations) {
    if (!onDisk.has(m.file)) {
      problems.push(`${m.file} is in manifest.json and not on disk.`);
      continue;
    }
    onDisk.delete(m.file);
    const v = m.verifiedAgainst;
    if (!v) {
      problems.push(
        `${m.file} has no \`verifiedAgainst\` in manifest.json, so nothing executes it. ` +
          `A migration nobody has run is the defect this gate exists for.`,
      );
      continue;
    }

    process.stdout.write(`  ${m.file}  ${v.from} -> ${v.to} ... `);
    const before = await freshDb(schemaAt(v.from), `m${m.version}_before`);
    const after = await freshDb(schemaAt(v.to), `m${m.version}_after`);
    const sql = readFileSync(join(MIG, m.file), 'utf8');
    try {
      await applyMigration(before, sql, m.transactional);
    } catch (err) {
      problems.push(`${m.file} failed to apply to the ${v.from} schema:\n    ${err.message}`);
      console.log('FAILED to apply');
      await before.end();
      await after.end();
      continue;
    }

    const d = differences(await fingerprint(before), await fingerprint(after), v.from, v.to);

    // AND THE GUARD HAS TO FIRE on a second run. A migration that silently
    // re-applies is one an operator runs twice during an incident.
    let guarded = false;
    try {
      await applyMigration(before, sql, m.transactional);
    } catch (err) {
      guarded = /already applied|duplicate/i.test(err.message);
      if (!guarded) {
        problems.push(
          `${m.file} re-applied with an error that is not its own guard, so an operator who ` +
            `runs it twice gets a confusing failure rather than "nothing to do":\n    ${err.message}`,
        );
      }
    }
    if (!guarded && problems.length === 0) {
      problems.push(`${m.file} applied a SECOND time without refusing. It needs a precondition guard.`);
    }

    await before.end();
    await after.end();

    if (d.length) {
      problems.push(
        `${m.file} applied to ${v.from} does not produce the ${v.to} schema:\n${d.join('\n')}`,
      );
      console.log(`FAILED (${d.length} difference(s))`);
    } else {
      ran.push(`${m.file}  ${v.from} -> ${v.to}`);
      console.log('ok');
    }
  }

  for (const orphan of onDisk) {
    problems.push(
      `migrations/${orphan} is on disk and not in manifest.json, so this gate does not run it ` +
        `and no runner can enumerate it.`,
    );
  }
} catch (err) {
  problems.push(`harness: ${err?.stack ?? String(err)}`);
}

await cleanup();

if (process.argv.includes('--self-test')) {
  const controlsOnly = problems.filter((p) => /comparator/.test(p));
  console.log(
    controlsOnly.length === 0
      ? '\ncheck-migrations: both negative controls passed.\n'
      : `\ncheck-migrations: a control FAILED:\n${controlsOnly.join('\n')}\n`,
  );
  process.exit(controlsOnly.length === 0 ? 0 : 1);
}

if (problems.length) {
  console.error('\ncheck-migrations: FAILED\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  const tail = harnessLog.filter((l) => /ERROR|FATAL|PANIC/.test(l)).slice(-25);
  if (tail.length) {
    console.error('  the server said, last 25 error lines:\n');
    for (const l of tail) console.error(`      ${l.trim()}`);
    console.error('');
  }
  process.exit(1);
}

console.log(
  `\ncheck-migrations: clean. ${ran.length} migration file(s) executed against the schema they ` +
    `upgrade and\n  producing the schema they claim, on real PostgreSQL; both negative controls ` +
    `correct.\n` +
    manifest.unverifiable
      .map((u) => `  not verifiable: ${String(u.version).padStart(3, '0')} — ${u.why}`)
      .join('\n') +
    '\n',
);
