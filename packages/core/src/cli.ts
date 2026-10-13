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
 * THIS SECTION SAID "No bucket checks" UNTIL 0.29.0, AND IT WAS WRONG. The gap
 * it described -- `doctor` saying nothing about whether the bucket is private --
 * was closed by `anonymousReadFinding`, which runs on every path, and the
 * paragraph announcing the absence stayed. Noticed on 12 October 2026 while
 * reading this header to decide what to add next: the section whose entire job
 * is to say what is missing was advertising a capability the file already had,
 * and no gate here reads prose inside a `.ts` for staleness. A document that
 * understates the product is a milder defect than one that overstates it, and
 * it is the same defect.
 *
 * `doctor` now answers two independent storage questions. Whether a STRANGER
 * can read the bucket (unsigned, needs no credentials) and whether the
 * credentials this deployment holds are ACCEPTED (one signed HEAD). Neither
 * stretches past what its own probe shows; read them together.
 *
 * What is still absent: nothing proves the bucket EXISTS. A missing bucket and
 * a missing key answer the same 404 to both probes, and the honest options are
 * a list call or a bucket-level request, neither of which the adapter offers
 * today. Said here rather than guessed at in a finding.
 *
 * No `filelayer audit`, and HALF OF THE REASON THIS GAVE WAS WRONG. It said
 * reading the trail "needs a Filelayer instance, which needs a storage adapter
 * it would never use". The three audit reads reference storage zero times and
 * `PostgresStore` takes a connection and nothing else, so the requirement came
 * from where the methods lived rather than from what they do. `auditReader(db)`
 * now exists for exactly this, and needs no adapter.
 *
 * The other half stands, and it is the half that matters: this tool would have
 * to decide WHOSE authority it reads on. `--as <admin>` runs a real
 * `read_audit` check that cannot mean anything here -- the operator can pass a
 * different name, or open `psql` -- which is the convincing check on top of
 * root access that the section above refuses. Reading as an operator identity
 * instead is defensible and is a new concept in the authorization model, not a
 * CLI flag.
 *
 * So the obstacle is gone and the question is not. Still absent on purpose.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { schemaStatus, type SchemaStatus } from './db.ts';

const VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const v = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version;
    // A MISSING FIELD DOES NOT THROW. The first version of this only caught an
    // exception, so a package.json that parsed and had no `version` printed the
    // string "undefined" as the version -- which is worse than "unknown",
    // because it looks like a value. That is not a hypothetical: the published
    // verification procedure replaces package.json with a minimal stub to prove
    // the suite needs no development dependencies, and `filelayer --version`
    // answered `undefined` there.
    return typeof v === 'string' && v.length > 0 ? v : 'unknown';
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

Scope. \`doctor\` checks the database and, when S3_ENDPOINT and S3_BUCKET are
set, whether the bucket answers an UNAUTHENTICATED read -- which is the most
common way this product's guarantees get undone. That probe writes nothing and
uses no credential: it reads an absent key without signing, and a refusal is
what a private bucket does.

It does NOT check whether your credentials work, and a refusal is evidence
about the bucket root only: a policy that opens one prefix answers the same way
and is still public where it matters.
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

/**
 * Is the bucket readable by anybody?
 *
 * ---------------------------------------------------------------------------
 * HOW THIS WORKS, AND WHY IT USES NO CREDENTIAL
 * ---------------------------------------------------------------------------
 *
 * An unsigned GET of a key that does not exist separates the two cases without
 * writing anything and without signing anything:
 *
 *   403  the store refuses an anonymous reader, and refuses in a way that does
 *        not reveal whether the key exists. This is what a private bucket does.
 *   404  the store answered the anonymous reader honestly, which means it is
 *        willing to serve anonymous readers. For a bucket holding other
 *        people's documents that is the whole product undone.
 *
 * It needs no access key, which is the point: a check that cannot read a
 * credential cannot leak one. It also writes nothing, so `doctor` stays
 * read-only and this needs no flag and no confirmation.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT ESTABLISH
 * ---------------------------------------------------------------------------
 *
 * A 403 here is evidence about the bucket root only. A policy that grants
 * anonymous reads on one prefix and refuses everything else answers 403 to this
 * probe and is still public where it matters. And this says nothing about
 * whether your credentials work, which needs a signed request and is not here
 * yet. The finding says so rather than implying a clean bill.
 */
async function anonymousReadFinding(): Promise<Finding> {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;

  if (!endpoint) {
    return {
      name: 'storage',
      state: 'unknown',
      detail:
        'S3_ENDPOINT is not set, so no bucket was checked. If this deployment uses ' +
        'FsStorage that is expected; if it uses a bucket, this check did not run.',
      fix: 'Set S3_ENDPOINT and S3_BUCKET to have the anonymous-read check run.',
    };
  }
  if (!bucket) {
    return {
      name: 'storage',
      state: 'problem',
      detail: 'S3_ENDPOINT is set and S3_BUCKET is not, so the bucket cannot be addressed.',
      fix: 'Set S3_BUCKET.',
    };
  }

  // A key nobody will have. Random, so a previous run cannot make this answer
  // 200 and turn a real finding into a different one.
  const probe = `filelayer-anonymous-read-probe-${Math.random().toString(36).slice(2)}`;
  const url = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}/${probe}`;

  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', redirect: 'manual' });
  } catch (e) {
    return {
      name: 'storage',
      state: 'problem',
      detail: `the endpoint could not be reached: ${String((e as Error).message).slice(0, 120)}`,
      fix: 'Check S3_ENDPOINT, and whether this machine is allowed to reach it.',
    };
  }

  if (res.status === 403 || res.status === 401) {
    return {
      name: 'storage',
      state: 'ok',
      detail:
        `an unauthenticated read of ${bucket} is refused (${res.status}), which is what a ` +
        'private bucket does. This covers the bucket root only, and says nothing about ' +
        'whether your credentials work.',
    };
  }
  if (res.status === 404) {
    return {
      name: 'storage',
      state: 'problem',
      detail:
        `an unauthenticated read of ${bucket} was answered honestly (404 for a key that ` +
        'does not exist) rather than refused, which means this bucket serves anonymous ' +
        'readers. Every object in it is readable by anyone who knows or guesses a key, ' +
        'and Filelayer cannot prevent that: it decides who may be GIVEN a URL, not who ' +
        'the store will answer.',
      fix: 'Make the bucket private and serve bytes through your application or through signed URLs. On S3 this is Block Public Access plus a policy with no anonymous principal; on R2 it is removing the public development URL and any custom domain that serves it unsigned.',
    };
  }
  if (res.status === 200) {
    return {
      name: 'storage',
      state: 'problem',
      detail: `an unauthenticated GET of a random key in ${bucket} returned 200, which should be impossible.`,
      fix: 'Something is answering for this endpoint that is not the object store you think it is. Check S3_ENDPOINT for a proxy or a captive portal.',
    };
  }
  return {
    name: 'storage',
    state: 'unknown',
    detail: `an unauthenticated read of ${bucket} answered ${res.status}, which this check does not interpret.`,
    fix: 'Neither refused nor answered: inspect it by hand before relying on either reading.',
  };
}

/**
 * DO THE CONFIGURED CREDENTIALS WORK?
 *
 * `anonymousReadFinding` above asks whether a STRANGER can read the bucket, and
 * it needs no credentials to ask. That left the complementary question
 * unanswered: whether the credentials this deployment holds are accepted at
 * all. An operator with a typo in `S3_SECRET_ACCESS_KEY` gets a completely
 * clean `doctor` today and finds out on the first upload, from an end user.
 *
 * One signed GET on a key nobody has -- GET rather than HEAD, and that is a
 * correction rather than a preference. HEAD was the obvious choice (no bytes to
 * transfer) and it loses the provider's error code: an HTTP HEAD response
 * carries no body, so `s3Error`'s XML parse finds nothing and every failure
 * arrives as a bare status. `AccessDenied` and `SignatureDoesNotMatch` are
 * different problems with different fixes -- a key without permission versus a
 * key that is wrong -- and collapsing them into "403" makes the operator guess.
 * The probe key does not exist, so the GET transfers nothing either way.
 *
 * WHAT A NULL RESULT PROVES, AND WHAT IT DOES NOT. The adapter turns 404 into
 * `null`, and a bucket that does not exist also answers 404 -- so "the probe
 * key is absent" and "the bucket is absent" arrive identically here. This
 * finding therefore claims only that a signed request was ACCEPTED, and says
 * so. The bucket's existence and privacy are what the anonymous probe speaks
 * to, and the two findings are meant to be read together rather than either
 * one being stretched.
 *
 * THE STORE'S OWN SENTENCE IS NOT PRINTED, on purpose. `s3Error` builds a
 * message out of the provider's `<Message>` body and also attaches the
 * structured `s3Code` and `status`. Only the structured pair is reported here.
 * Relaying a vendor's prose into a terminal, a CI log or a pasted bug report
 * means trusting that no provider ever echoes credential material into an
 * authentication-failure body, and that is a bet with no upside: the code and
 * the status are what an operator acts on anyway.
 */
async function credentialsFinding(): Promise<Finding> {
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const hasKey = Boolean(process.env.S3_ACCESS_KEY_ID);
  const hasSecret = Boolean(process.env.S3_SECRET_ACCESS_KEY);

  if (!endpoint || !bucket) {
    return {
      name: 'storage credentials',
      state: 'unknown',
      detail:
        'no S3 endpoint and bucket are configured, so nothing was signed. Expected if ' +
        'this deployment uses FsStorage.',
    };
  }
  if (!hasKey || !hasSecret) {
    const missing = [!hasKey && 'S3_ACCESS_KEY_ID', !hasSecret && 'S3_SECRET_ACCESS_KEY']
      .filter(Boolean)
      .join(' and ');
    return {
      name: 'storage credentials',
      state: 'problem',
      detail: `S3_ENDPOINT is set and ${missing} is not, so no request can be signed.`,
      fix: `Set ${missing} in the environment. Not as an argument -- see --help.`,
    };
  }

  const { S3Storage } = await import('./storage.ts');
  const probe = `filelayer-credentials-probe-${Math.random().toString(36).slice(2)}`;
  try {
    const s3 = new S3Storage({
      endpoint,
      bucket,
      region: process.env.S3_REGION ?? 'auto',
      accessKeyId: process.env.S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      ...(process.env.S3_SESSION_TOKEN ? { sessionToken: process.env.S3_SESSION_TOKEN } : {}),
    });
    await s3.get(probe);
    return {
      name: 'storage credentials',
      state: 'ok',
      detail:
        'the store accepted a signed request. This does not prove the bucket exists: a ' +
        'missing bucket answers the same 404 as a missing key. Read it with the storage ' +
        'finding above.',
    };
  } catch (e) {
    const err = e as Error & { s3Code?: string | null; status?: number };
    const rejected =
      err.status === 403 ||
      ['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'AccessDenied'].includes(err.s3Code ?? '');
    if (rejected) {
      return {
        name: 'storage credentials',
        state: 'problem',
        detail:
          `the store rejected the signed request (${err.status ?? 'no status'}` +
          `${err.s3Code ? ` ${err.s3Code}` : ''}). The credentials in the environment are ` +
          'not accepted for this bucket.',
        fix:
          'Check S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, and that the key is scoped to ' +
          'this bucket and region.',
      };
    }
    return {
      name: 'storage credentials',
      state: 'unknown',
      detail:
        `the signed request did not complete (${err.status ?? 'no status'}` +
        `${err.s3Code ? ` ${err.s3Code}` : ''}). That is not an authentication answer, so ` +
        'this check cannot say whether the credentials are good.',
    };
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

  // The storage check runs on EVERY path, including the ones where the database
  // never answers. The first version of this reported storage only after a
  // successful connection, so the most common first run -- no DATABASE_URL yet
  // -- said nothing about the bucket, which is the silence this check exists to
  // end. The two questions are independent and are answered independently.
  const storage = await anonymousReadFinding();
  // Same reasoning as the line above: the credentials question is independent
  // of whether the database answers, so it is asked on every path too.
  const creds = await credentialsFinding();

  const conn = await connect();
  if (!conn.ok) {
    findings.push(conn.finding, storage, creds);
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
  findings.push(storage, creds);
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
