#!/usr/bin/env node
/**
 * The Filelayer CLI: answer an operator's questions about a real deployment
 * without making them write a script first.
 *
 *     npx filelayer doctor
 *     npx filelayer schema status
 *
 * =============================================================================
 * THE THING TO BE HONEST ABOUT FIRST
 * =============================================================================
 *
 * This tool reads `DATABASE_URL`. **Whoever holds that string already has
 * complete authority over every file row, every grant and the audit chain
 * itself.** So unlike the MCP server, which is scoped to one subject and
 * enforces, this CLI cannot enforce anything and must not pretend to. It is an
 * operator tool. If you can run it, you were already root.
 *
 * That is why there is no `filelayer share`, no `filelayer download` and no
 * `filelayer delete` here. Those would be an application's operations performed
 * with a credential that bypasses the application, and a convincing permission
 * check on top of root access is worse than no check: it tells you something
 * was authorized when nothing was.
 *
 * =============================================================================
 * SECRETS DO NOT COME FROM ARGUMENTS
 * =============================================================================
 *
 * There is no `--database-url`, on purpose, and passing one is an error rather
 * than being ignored. An argument lands in shell history, in `ps` output while
 * the process runs, and in the log of every CI system that echoes its
 * commands. The environment is not perfect either, but it does not persist to
 * disk by default and it is what every other tool in this space reads.
 *
 * =============================================================================
 * WHAT IT IS NOT, YET
 * =============================================================================
 *
 * No bucket checks. `doctor` says nothing about whether your bucket exists, is
 * reachable or is private, which is a real gap: a public bucket is the single
 * most common way this product's guarantees get undone, and it is exactly the
 * thing an operator would want a one-line answer about. It needs storage
 * credentials and an adapter, and shipping a check that half-works would be
 * worse than saying it is absent.
 *
 * No `filelayer audit`. Reading the trail needs a Filelayer instance, which
 * needs a storage adapter it would never use, and it needs a subject -- and the
 * subject question is exactly the one the paragraph above says this tool cannot
 * answer honestly. It is worth building and it is not worth guessing at.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaStatus, type SchemaStatus } from './db.ts';

const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version as string;
  } catch {
    return 'unknown';
  }
})();

const USAGE = `filelayer ${VERSION}

  filelayer doctor           is this environment ready to run Filelayer?
  filelayer schema status    what schema version is the database at?

Options
  --json                     machine-readable output on stdout
  --help, -h                 this
  --version, -v              the version

Reads DATABASE_URL from the environment. There is deliberately no flag for it:
an argument lands in shell history, in \`ps\` output, and in CI logs.

Everything here is read-only. This tool holds your database credential, which
is complete authority over every file and grant, so it does not pretend to
enforce permissions -- see the comment at the top of src/cli.ts.

Scope: the database only. It says NOTHING about your bucket -- not whether it
exists, not whether it is reachable, and not whether it is private. A public
bucket is the most common way this product's guarantees get undone, and a clean
run here is not evidence about it.
`;

type Finding = {
  name: string;
  state: 'ok' | 'problem' | 'unknown';
  detail: string;
  fix?: string;
};

const argv = process.argv.slice(2);
const wantsJson = argv.includes('--json');
const positional = argv.filter((a) => !a.startsWith('-'));

/** Secrets as arguments are refused rather than ignored. */
const SECRET_FLAGS = [
  '--database-url',
  '--db-url',
  '--password',
  '--secret-access-key',
  '--access-key-id',
  '--token',
];
const offending = argv.filter((a) => SECRET_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
if (offending.length > 0) {
  process.stderr.write(
    `filelayer: ${offending.map((o) => o.split('=')[0]).join(', ')} is not accepted as an ` +
      'argument.\n\n' +
      'A credential passed on a command line is written to your shell history, is\n' +
      'visible in `ps` while the process runs, and is echoed by most CI systems.\n' +
      'This is refused rather than ignored so that a script doing it fails loudly\n' +
      'instead of appearing to work.\n\n' +
      'Set it in the environment instead:\n\n' +
      '    DATABASE_URL=... filelayer doctor\n',
  );
  process.exit(2);
}

// `--version` first. It has no positional argument, so the no-command branch
// below swallowed it and printed the usage -- which looks like help working
// rather than like a broken flag, and is why this ordering has a test.
if (argv.includes('--version') || argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h') || positional.length === 0) {
  process.stdout.write(USAGE);
  process.exit(0);
}

// -----------------------------------------------------------------------------
// The database connection. `pg` is an optional peer: this package has zero
// runtime dependencies and the CLI is the only part that needs a driver, so it
// is loaded dynamically and its absence names itself and the command.
// -----------------------------------------------------------------------------
async function connect(): Promise<
  { ok: true; pool: { query: (...a: never[]) => unknown; end: () => Promise<void> } } | {
    ok: false;
    finding: Finding;
  }
> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return {
      ok: false,
      finding: {
        name: 'DATABASE_URL',
        state: 'problem',
        detail: 'not set, so there is nothing to connect to.',
        fix: 'Set DATABASE_URL in the environment. There is no flag for it, on purpose.',
      },
    };
  }

  let pg: typeof import('pg');
  try {
    pg = await import('pg');
  } catch {
    return {
      ok: false,
      finding: {
        name: 'the pg driver',
        state: 'problem',
        detail:
          'not installed. @filelayer/core has no runtime dependencies and the CLI is ' +
          'the only part that needs a PostgreSQL driver.',
        fix: 'npm install pg',
      },
    };
  }

  // `pg` is CommonJS, so an ESM dynamic import may hand back the module itself
  // or a module namespace with the exports on `default`, depending on how it
  // was built. Both shapes are real and the types only describe one.
  const Pool = (pg as unknown as { Pool?: typeof import('pg').Pool; default?: { Pool: typeof import('pg').Pool } })
    .Pool ?? (pg as unknown as { default: { Pool: typeof import('pg').Pool } }).default.Pool;
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query('select 1');
  } catch (e) {
    await pool.end().catch(() => {});
    return {
      ok: false,
      finding: {
        name: 'the database',
        state: 'problem',
        // The driver's message, trimmed. Not the connection string: it carries
        // the password, and this output goes into terminals people paste from.
        detail: `could not be reached: ${String((e as Error).message).slice(0, 160)}`,
        fix: 'Check the host, the port and whether this machine is allowed to connect.',
      },
    };
  }
  return { ok: true, pool: pool as never };
}

function describeSchema(s: SchemaStatus): Finding {
  const at = s.at === null ? 'none' : String(s.at);
  switch (s.state) {
    case 'current':
      return { name: 'the schema', state: 'ok', detail: `at version ${at}, which is current.` };
    case 'behind':
      return {
        name: 'the schema',
        state: 'problem',
        detail: `at version ${at}; this package expects ${s.expects}. Outstanding: ${
          s.outstanding.map((m) => m.version).join(', ') || 'unknown'
        }.`,
        fix: 'Apply the outstanding files in packages/core/migrations in order. This tool does not apply them: a schema change is a decision somebody should make deliberately, and migrations/README.md says which need a maintenance window.',
      };
    case 'ahead':
      return {
        name: 'the schema',
        state: 'problem',
        detail: `at version ${at}, which is AHEAD of the ${s.expects} this package expects.`,
        fix: 'Something newer than this package has written to this database. Upgrade @filelayer/core rather than downgrading the schema.',
      };
    case 'absent':
      return {
        name: 'the schema',
        state: 'problem',
        detail: 'not present: this database has no Filelayer tables.',
        fix: 'psql "$DATABASE_URL" -f node_modules/@filelayer/core/schema.sql',
      };
    case 'unversioned':
      return {
        name: 'the schema',
        state: 'problem',
        detail:
          'present but carries no version stamp, so it predates 0.15.0 and nothing can ' +
          'tell which migrations it has had.',
        fix: 'See packages/core/MIGRATIONS.md, which covers adopting an unstamped database.',
      };
    case 'partial':
      return {
        name: 'the schema',
        state: 'problem',
        detail: 'partially applied: some objects exist and some do not.',
        fix: 'A previous apply stopped halfway. MIGRATIONS.md covers recovering from this; do not re-run schema.sql, which refuses rather than half-applying.',
      };
    default:
      return { name: 'the schema', state: 'unknown', detail: `unrecognised state ${s.state}.` };
  }
}

function nodeFinding(): Finding {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > 22 || (major === 22 && minor >= 18);
  return ok
    ? { name: 'Node', state: 'ok', detail: `${process.versions.node}, which is >= 22.18.` }
    : {
        name: 'Node',
        state: 'problem',
        detail: `${process.versions.node}; this package requires >= 22.18.`,
        fix: 'Upgrade Node. The engines field refuses the install, but a CI image can be older than the one that built your lockfile.',
      };
}

function report(findings: Finding[]): never {
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify({ version: VERSION, findings }, null, 2)}\n`);
  } else {
    for (const f of findings) {
      const mark = f.state === 'ok' ? 'ok  ' : f.state === 'problem' ? 'FAIL' : '?   ';
      process.stdout.write(`  ${mark}  ${f.name}: ${f.detail}\n`);
      if (f.fix && f.state !== 'ok') process.stdout.write(`        ${f.fix}\n`);
    }
    const bad = findings.filter((f) => f.state === 'problem').length;
    process.stdout.write(
      bad === 0
        ? '\nNothing to fix here. Note that this says nothing about your bucket: see `filelayer --help`.\n'
        : `\n${bad} problem(s). Nothing was changed; everything here is read-only.\n`,
    );
  }
  process.exit(findings.some((f) => f.state === 'problem') ? 1 : 0);
}

// -----------------------------------------------------------------------------
// Commands.
// -----------------------------------------------------------------------------
const command = positional.join(' ');

if (command === 'doctor') {
  const findings: Finding[] = [nodeFinding()];
  const conn = await connect();
  if (!conn.ok) {
    findings.push(conn.finding);
    report(findings);
  }
  findings.push({ name: 'the database', state: 'ok', detail: 'reachable.' });
  try {
    findings.push(describeSchema(await schemaStatus(conn.pool as never)));
  } catch (e) {
    findings.push({
      name: 'the schema',
      state: 'unknown',
      detail: `could not be read: ${String((e as Error).message).slice(0, 160)}`,
    });
  }
  await conn.pool.end().catch(() => {});
  report(findings);
}

if (command === 'schema status') {
  const conn = await connect();
  if (!conn.ok) report([conn.finding]);
  let status: SchemaStatus;
  try {
    status = await schemaStatus(conn.pool as never);
  } catch (e) {
    await conn.pool.end().catch(() => {});
    report([
      {
        name: 'the schema',
        state: 'unknown',
        detail: `could not be read: ${String((e as Error).message).slice(0, 160)}`,
      },
    ]);
  }
  await conn.pool.end().catch(() => {});
  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    process.exit(status.state === 'current' ? 0 : 1);
  }
  report([describeSchema(status)]);
}

process.stderr.write(`filelayer: unknown command "${command}".\n\n${USAGE}`);
process.exit(2);
