#!/usr/bin/env node
/**
 * Check every "since 0.X.Y" claim on a published surface against the published
 * tarballs, by installing the version cited and the one published before it.
 *
 *   node tools/check-since-claims.mjs
 *   node tools/check-since-claims.mjs --list
 *
 * Why this exists.
 *
 * `check:versions` says in its own output that historical mentions "are fine
 * and are not checked". It rejects a version AHEAD of package.json, which stops
 * us dating something to a release that does not exist, and that is all. So a
 * claim dated to the wrong past release passes every gate. On 8 October 2026
 * two of the five such claims in `llms.txt` -- the file written specifically so
 * that a model will believe it -- were wrong by two releases: `deliveryFetch`
 * was dated 0.20.0 and shipped in 0.18.0, and the typed error code was dated
 * 0.20.0 and shipped in 0.19.1. They were found by accident, while a blind
 * find-and-replace broke them, and not by anything that runs.
 *
 * "Since V" is two claims, and both are checked:
 *
 *   1. the thing is true in V, and
 *   2. the thing is NOT true in the version published immediately before V.
 *
 * The second one is the one that matters. Dating a feature late passes a
 * presence check against the cited version, every time: `deliveryFetch` was
 * present in 0.20.0, which is exactly why "since 0.20.0" looked fine.
 *
 * Each claim must be declared in CLAIMS below with a probe. Discovery is from
 * the files, so a new "since" sentence fails the build until somebody writes
 * down what it asserts -- the alternative is a hand-written list that silently
 * stops covering the page it was written for.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@filelayer/core';

/** Surfaces a stranger or an agent reads. Discovery runs over exactly these. */
const SURFACES = [
  'README.md',
  'llms.txt',
  'packages/core/llms.txt',
  'docs/QUICKSTART.md',
  'docs/guides/deleting-files-and-orphaned-objects.md',
  'docs/guides/expiring-and-revocable-file-links.md',
  'docs/guides/multi-tenant-file-access.md',
  'docs/guides/private-file-uploads.md',
  'docs/guides/serving-private-files.md',
  'skills/filelayer-integration/SKILL.md',
  'skills/filelayer-integration/references/direct-upload.md',
  'skills/filelayer-integration/references/errors.md',
  'skills/filelayer-integration/references/node-http.md',
  'skills/filelayer-integration/references/range-and-media.md',
  'skills/filelayer-integration/references/sharing-and-links.md',
  'skills/filelayer-integration/references/whatwg-runtimes.md',
];

const SINCE = /\b[Ss]ince\s+`?(\d+\.\d+\.\d+)`?/g;

/**
 * `match` is a literal substring that must appear on the claiming line, and it
 * is how a declaration is tied to a sentence rather than to a version number.
 * Two claims dated to the same release in the same file stay distinguishable.
 *
 * Probes:
 *   export  -- the name is a module export of the installed package
 *   method  -- the name appears in the published type declarations as a method
 *   ships   -- the literal text appears in the named file inside the tarball
 */
const CLAIMS = [
  {
    match: 'it REFUSES a database that already has the schema',
    probe: { kind: 'ships', file: 'schema.sql', text: 'filelayer_schema_version' },
    note: 'schema.sql stamps a version table and refuses a database that has one.',
  },
  {
    match: 'not idempotent, and since `0.15.0` it refuses rather than',
    probe: { kind: 'ships', file: 'schema.sql', text: 'filelayer_schema_version' },
    note: 'The same claim as above, on the quickstart.',
  },
  {
    match: 'authorize first and then hand the browser a presigned `PUT`',
    probe: { kind: 'method', name: 'createUpload' },
    note: 'Pre-authorized direct upload.',
  },
  {
    match: '`deliveryFetch(fl, { principal })` is the same two routes',
    probe: { kind: 'export', name: 'deliveryFetch' },
    note: 'The WHATWG-runtime handler.',
  },
  {
    match: 'deliberately broken applications, each with exactly one property wrong',
    probe: { kind: 'export', name: 'auditIntegration' },
    note: "The harness that audits the adopter's own integration.",
  },
  {
    match: '`e.code` is the safe field.',
    probe: { kind: 'export', name: 'ERROR_CODES' },
    note: 'The typed code union and the generated catalogue.',
  },
  {
    match: 'is an MCP server over an instance',
    probe: { kind: 'ships', file: 'dist/mcp.js', text: 'registerTool' },
    note: 'The MCP server. Probed as a shipped file rather than an export, because it is a subpath entry and not re-exported from the main one -- on purpose, so that the SDK is not a hard import for everyone.',
  },
  {
    match: 'is in the npm tarball',
    probe: { kind: 'ships', file: 'skills/filelayer-integration/SKILL.md', text: 'Adding user files' },
    note: 'The Agent Skill shipping inside the package.',
  },
  {
    match: 'reports whether the bucket serves an UNAUTHENTICATED read',
    probe: { kind: 'ships', file: 'dist/cli.js', text: 'anonymous-read-probe' },
    note: 'The bucket probe in `doctor`.',
  },
  {
    match: 'Both are READ-ONLY and neither applies a migration',
    probe: { kind: 'ships', file: 'dist/cli.js', text: 'filelayer schema status' },
    note: "The CLI. Probed as a shipped file because it is a `bin` target, not an export.",
  },
  {
    match: '**`AsOption` now carries `ip` and `userAgent`**',
    probe: { kind: 'ships', file: 'dist/simple.d.ts', text: 'userAgent?: string' },
    note: 'Audit context on the facade tier.',
  },
];

let failures = 0;
const fail = (what, detail) => {
  failures++;
  console.error(`  FAIL  ${what}\n        ${detail}`);
};

// -----------------------------------------------------------------------------
// Discovery.
// -----------------------------------------------------------------------------
const found = [];
for (const rel of SURFACES) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    console.error(
      `check-since-claims: ${rel} is in the surface list and does not exist. A list\n` +
        'that names a missing file is not checking the file that replaced it.',
    );
    process.exit(2);
  }
  const lines = readFileSync(abs, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const m of line.matchAll(SINCE)) {
      found.push({ file: rel, line: i + 1, version: m[1], text: line });
    }
  });
}

if (found.length === 0) {
  console.error(
    'check-since-claims: no "since <version>" claim found on any surface. That is\n' +
      'almost certainly a broken pattern rather than a repository with no history.',
  );
  process.exit(2);
}

// Tie each occurrence to exactly one declaration.
const work = [];
for (const f of found) {
  const hits = CLAIMS.filter((c) => f.text.includes(c.match));
  if (hits.length === 0) {
    fail(
      `${f.file}:${f.line} dates something to ${f.version} and is not declared`,
      'Add an entry to CLAIMS in this file with a `match` substring from that line\n' +
        '        and a probe saying what the claim asserts. There is no default: an\n' +
        '        undeclared date is an unchecked date.',
    );
    continue;
  }
  if (hits.length > 1) {
    fail(
      `${f.file}:${f.line} matches ${hits.length} declarations`,
      `Ambiguous: ${hits.map((h) => JSON.stringify(h.match)).join(', ')}. Make the\n` +
        '        `match` substrings specific enough to pick one line each.',
    );
    continue;
  }
  work.push({ ...f, claim: hits[0] });
}

const unused = CLAIMS.filter((c) => !work.some((w) => w.claim === c));
for (const c of unused) {
  fail(
    `the declaration ${JSON.stringify(c.match)} matches no line`,
    'It is a check for a sentence that has been edited or deleted. Update or remove it.',
  );
}

if (process.argv.includes('--list')) {
  for (const w of work) {
    console.log(`${w.file}:${w.line}  since ${w.version}  ${w.claim.probe.kind}:` +
      `${w.claim.probe.name ?? w.claim.probe.file}`);
  }
  process.exit(failures > 0 ? 1 : 0);
}

// -----------------------------------------------------------------------------
// The published version list, for "the one before V".
// -----------------------------------------------------------------------------
const cmp = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

let published;
try {
  const res = await fetch(`https://registry.npmjs.org/${PKG}`, {
    headers: { accept: 'application/json' },
  });
  published = Object.keys((await res.json()).versions).sort(cmp);
} catch (e) {
  console.error(
    `check-since-claims: could not read the published version list: ${e.message}\n` +
      'This check cannot run without it, and passing anyway would report a\n' +
      'verification that did not happen.',
  );
  process.exit(2);
}

const localVersion = JSON.parse(
  readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'),
).version;

const installs = new Map();
function install(version) {
  if (installs.has(version)) return installs.get(version);
  const dir = mkdtempSync(join(tmpdir(), `fl-since-${version}-`));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true }));
  execFileSync(
    'npm',
    ['install', `${PKG}@${version}`, '--no-audit', '--no-fund', '--prefer-online'],
    { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
  );
  installs.set(version, join(dir, 'node_modules', PKG));
  return installs.get(version);
}

/** Does the probe hold in this installed copy? */
async function holds(probe, root) {
  if (probe.kind === 'ships') {
    try {
      return readFileSync(join(root, probe.file), 'utf8').includes(probe.text);
    } catch {
      return false;
    }
  }
  if (probe.kind === 'method') {
    const dist = join(root, 'dist');
    if (!existsSync(dist)) return false;
    return readdirSync(dist)
      .filter((f) => f.endsWith('.d.ts'))
      .some((f) => new RegExp(`\\b${probe.name}\\s*\\(`).test(readFileSync(join(dist, f), 'utf8')));
  }
  const mod = await import(join(root, 'dist/index.js'));
  return probe.name in mod;
}

// -----------------------------------------------------------------------------
// Check. One probe per distinct (claim, version) pair; the same sentence on two
// surfaces is one question.
// -----------------------------------------------------------------------------
const seen = new Set();
for (const w of work) {
  const key = `${w.claim.match}@${w.version}`;
  if (seen.has(key)) continue;
  seen.add(key);

  const { probe } = w.claim;
  const label = `${probe.kind}:${probe.name ?? `${probe.file}/${probe.text}`}`;

  if (!published.includes(w.version)) {
    // The release being prepared is not a wrong claim. `check:versions` already
    // refuses a version ahead of package.json, so a claim dated to the local
    // version and not yet on the registry is a pending publish, and failing
    // here would mean no release could ever document its own new feature. Said
    // out loud rather than skipped silently, because what it means is that this
    // particular claim is unverified until the publish happens -- and then
    // `check:published` is the gate that notices.
    //
    // This is the second time today the same mistake went into a gate: the
    // first version of `check:published` compared the served README against the
    // working tree, which turned every README edit red until a publish.
    // Verifying against the registry is right; punishing unreleased work is
    // not, and the two are easy to conflate.
    if (w.version === localVersion) {
      console.log(
        `  ${label}: dated ${w.version}, which is this checkout's version and is not ` +
          'published yet. UNVERIFIED until it is.',
      );
      continue;
    }
    fail(
      `${w.file}:${w.line} dates ${label} to ${w.version}, which was never published`,
      `Published: ${published.join(', ')}`,
    );
    continue;
  }

  const idx = published.indexOf(w.version);
  const before = idx > 0 ? published[idx - 1] : null;

  let inCited;
  try {
    inCited = await holds(probe, install(w.version));
  } catch (e) {
    fail(`${w.version} could not be installed or inspected`, String(e.message).slice(0, 200));
    continue;
  }

  if (!inCited) {
    fail(
      `${w.file}:${w.line} says ${label} dates from ${w.version}, and ${w.version} does not have it`,
      'The claim is wrong in the direction a reader notices: they install the\n' +
        '        version you named and the thing is not there.',
    );
    continue;
  }

  if (before === null) {
    console.log(`  ${w.version} is the earliest published version; "since" has nothing before it.`);
    continue;
  }

  let inPrevious;
  try {
    inPrevious = await holds(probe, install(before));
  } catch (e) {
    fail(`${before} could not be installed or inspected`, String(e.message).slice(0, 200));
    continue;
  }

  if (inPrevious) {
    fail(
      `${w.file}:${w.line} says ${label} dates from ${w.version}; ${before} already had it`,
      'This is the failure mode a presence check cannot see: a feature dated LATE\n' +
        '        is present in the version named, so everything looks right. Find the\n' +
        `        first release that has it and date the sentence to that one.`,
    );
  } else {
    console.log(`  ${label}: present in ${w.version}, absent in ${before}. Claim holds.`);
  }
}

for (const dir of installs.values()) {
  rmSync(join(dir, '..', '..'), { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\ncheck-since-claims: ${failures} failure(s).`);
  process.exit(1);
}
console.log(
  `check-since-claims: clean. ${found.length} dated claim(s) across ${SURFACES.length} ` +
    `surface(s); ${seen.size} checked against the published tarballs.`,
);
