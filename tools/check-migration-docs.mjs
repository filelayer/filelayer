#!/usr/bin/env node
/**
 * Every migration in the manifest has an entry in `MIGRATIONS.md`, and the
 * other way round.
 *
 *     node tools/check-migration-docs.mjs
 *     node tools/check-migration-docs.mjs --self-test
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *
 * `migrations/012-grant-lookup-order.sql` shipped with `0.17.0` and
 * `MIGRATIONS.md` did not mention it. Not an incomplete entry -- no entry, and
 * no mention of the version anywhere in the file. It was found on
 * 14 October 2026, fifteen releases later, while writing entry 13.
 *
 * That file is not incidental. The README tells an adopter to budget an upgrade
 * against it, in those words. So for fifteen releases somebody auditing the
 * schema history from the document we point them at would have concluded there
 * was no change between `0.16.0` and `0.18.0`.
 *
 * `check:migrations` executes every migration against the schema it upgrades
 * and compares the result, so the FILE was never in doubt. What nothing
 * compared was the file against its documentation. Two lists, one of them the
 * one readers use, and nothing holding them to each other.
 *
 * ---------------------------------------------------------------------------
 * BOTH DIRECTIONS, because each omission has a different failure
 * ---------------------------------------------------------------------------
 *
 * A manifest entry with no document is the defect above: a schema change an
 * adopter cannot find.
 *
 * A document entry with no manifest entry is the opposite and is also real:
 * `MIGRATIONS.md` has entries for versions with no SQL at all -- 4, 7 and 9 are
 * declared `noSchemaChange`, 1 and 2 are `unverifiable` because they predate
 * the oldest tag. Those are legitimate and are read from the manifest's own
 * declarations rather than guessed, so an entry for a version the manifest has
 * never heard of means one of the two was edited alone.
 *
 * Cheap on purpose: no database, no network. `check:migrations` is the slow one
 * and it has twice been the gate nobody could run.
 *
 * ---------------------------------------------------------------------------
 * AND A THIRD COPY OF THE SAME FACT: the file's own `introduced_in`
 * ---------------------------------------------------------------------------
 *
 * Every migration from 010 on writes a `filelayer_schema_version` row naming
 * the release that introduced it, and `schemaStatus()` shows that row to an
 * operator. The manifest says the same thing in `introducedIn`. Nothing
 * compared them, and the 0.33.0 release shipped `013-share-idempotency.sql`
 * recording '0.33.0' for a migration introduced in 0.32.0: `bump:version`
 * rewrote it, because the value sits on the line below the word
 * `introduced_in` that its history guard looks for. Any database migrated with
 * the 0.33.0 tarball carries that wrong row. This compares the version number
 * and the release in each file's INSERT with the manifest entry.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'packages/core/MIGRATIONS.md';

const manifest = JSON.parse(
  readFileSync(join(ROOT, 'packages/core/migrations/manifest.json'), 'utf8'),
);
const doc = readFileSync(join(ROOT, DOC), 'utf8');

/** `### Entry 12 — ...` */
const entries = new Set(
  [...doc.matchAll(/^###\s+Entry\s+(\d+)\s/gm)].map((m) => Number(m[1])),
);

/** Versions the manifest accounts for, by whichever route. */
const withSql = manifest.migrations.map((m) => m.version);
const noSchema = manifest.noSchemaChange ?? [];
const unverifiable = (manifest.unverifiable ?? []).map((u) => u.version);
const accounted = new Set([...withSql, ...noSchema, ...unverifiable]);

/**
 * The `filelayer_schema_version` row a migration file writes, if it writes one:
 * `(13, '0.32.0', '...')` after `INSERT INTO filelayer_schema_version`.
 */
export function recordedRow(sql) {
  const m = sql.match(
    /INSERT\s+INTO\s+filelayer_schema_version\s*\([^)]*\)\s*VALUES\s*\(\s*(\d+)\s*,\s*'([^']*)'/i,
  );
  return m ? { version: Number(m[1]), introducedIn: m[2] } : null;
}

/** Problems for one manifest entry against the text of its file. */
function rowProblems(m, sql) {
  const row = recordedRow(sql);
  // The version table arrived with migration 010; earlier files cannot write to it.
  if (row === null) {
    return m.version >= 10
      ? [`${m.file} writes no filelayer_schema_version row, and every migration from 010 on must.`]
      : [];
  }
  const out = [];
  // Entries before 011 name the release as `to`; later ones as `introducedIn`.
  const expected = m.introducedIn ?? m.to;
  if (row.version !== m.version) {
    out.push(`${m.file} records schema version ${row.version}; the manifest says ${m.version}.`);
  }
  if (row.introducedIn !== expected) {
    out.push(
      `${m.file} records introduced_in '${row.introducedIn}'; the manifest says ` +
        `'${expected}'.\n    The file is what a database stores, so the operator reading ` +
        '`schemaStatus()` sees the wrong release.',
    );
  }
  return out;
}

if (process.argv.includes('--self-test')) {
  // The control: a manifest version absent from the document must be caught.
  // That is the defect this file exists for, and a gate that cannot see its own
  // founding defect is decoration.
  const pretend = new Set(entries);
  pretend.delete(12);
  const caught = withSql.some((v) => !pretend.has(v));
  // And the row check, on the shape that shipped in 0.33.0.
  const m13 = { version: 13, file: '013.sql', introducedIn: '0.32.0' };
  const planted = "INSERT INTO filelayer_schema_version (version, introduced_in, note) VALUES\n    (13, '0.33.0', 'x')";
  const honest = planted.replace("'0.33.0'", "'0.32.0'");
  const rowCaught = rowProblems(m13, planted).length === 1 && rowProblems(m13, honest).length === 0;
  console.log(
    caught
      ? 'check-migration-docs: control passed (a migration with no entry is caught).'
      : 'check-migration-docs: control DID NOT FAIL: a missing entry went unnoticed.',
  );
  console.log(
    rowCaught
      ? 'check-migration-docs: control passed (a file recording the wrong release is caught, the right one is not).'
      : 'check-migration-docs: control DID NOT FAIL: a wrong introduced_in went unnoticed, or a right one was refused.',
  );
  process.exit(caught && rowCaught ? 0 : 1);
}

const problems = [];

for (const m of manifest.migrations) {
  if (!entries.has(m.version)) {
    problems.push(
      `${m.file} (version ${m.version}, introduced in ${m.introducedIn}) has no\n` +
        `    "### Entry ${m.version}" in ${DOC}. The README tells an adopter to budget an\n` +
        '    upgrade against that file, so a schema change missing from it is a change\n' +
        '    they cannot find.',
    );
  }
}

for (const m of manifest.migrations) {
  const sql = readFileSync(join(ROOT, 'packages/core/migrations', m.file), 'utf8');
  problems.push(...rowProblems(m, sql));
}

for (const v of noSchema) {
  if (!entries.has(v)) {
    problems.push(
      `version ${v} is declared \`noSchemaChange\` in the manifest and has no\n` +
        `    "### Entry ${v}" in ${DOC}. A release with no SQL still needs the entry that\n` +
        '    says so, or the numbering has a hole a reader has to explain to themselves.',
    );
  }
}

for (const v of unverifiable) {
  if (!entries.has(v)) {
    problems.push(
      `version ${v} is declared \`unverifiable\` in the manifest and has no\n` +
        `    "### Entry ${v}" in ${DOC}.`,
    );
  }
}

for (const v of [...entries].sort((a, b) => a - b)) {
  if (!accounted.has(v)) {
    problems.push(
      `${DOC} has "### Entry ${v}" and the manifest does not account for version ${v}\n` +
        '    at all -- not in `migrations`, not in `noSchemaChange`, not in\n' +
        '    `unverifiable`. One of the two was edited without the other.',
    );
  }
}

if (manifest.expects !== Math.max(...accounted)) {
  problems.push(
    `manifest.expects is ${manifest.expects} and the highest accounted version is ` +
      `${Math.max(...accounted)}.\n    The two disagree, and \`schemaStatus()\` reports` +
      ' against `expects`.',
  );
}

if (problems.length > 0) {
  console.error(`\ncheck-migration-docs: FAILED\n`);
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log(
  `check-migration-docs: clean. ${accounted.size} schema version(s) accounted for in both ` +
    `the manifest and ${DOC}\n  (${withSql.length} with SQL, ${noSchema.length} with no schema ` +
    `change, ${unverifiable.length} predating the oldest tag); manifest.expects is ` +
    `${manifest.expects}.`,
);
