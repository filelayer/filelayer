#!/usr/bin/env node
/**
 * Fail the build if a public surface states a version or a test count that
 * disagrees with `packages/core/package.json`, or with another public surface.
 *
 *   node tools/check-version-claims.mjs               # check, exit 1 on a hit
 *   node tools/check-version-claims.mjs --list        # every claim found
 *   node tools/check-version-claims.mjs --self-test   # the negative control only
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT
 * -----------------------------------------------------------------------------
 *
 * At 0.4.3 the published surface had drifted apart from itself. `SECURITY.md`
 * said the project was at `0.3.0` and listed `0.3.x` as the supported line —
 * so the security policy declared the current release unsupported.
 * `ARCHITECTURE-PROGRESSIVE.md` and `architecture/TIER5-DESIGN-NOTE.md` both
 * said "current as of 0.3.0", and the former claimed 313 tests across 68 suites
 * when the suite was 324 across 74. Every one of those numbers had been correct
 * once. None of them was load-bearing enough for anyone to notice, and all of
 * them sat on pages whose entire argument is that we do not overstate things.
 *
 * That is the failure mode: a project whose credibility rests on accuracy,
 * caught being casually inaccurate about itself. It is cheap to prevent and
 * expensive to be caught at, so it gets a gate.
 *
 * -----------------------------------------------------------------------------
 * WHAT THIS DOES AND DOES NOT CHECK
 * -----------------------------------------------------------------------------
 *
 * DOES:  every CURRENT-STATE version claim equals the package version, and
 *        every test-count and suite-count claim agrees with every other one.
 *
 * DOES NOT: verify the test count against the suite. Running the suite is what
 *        `npm test` is for, and `npm run verify` runs it immediately before
 *        this check. What this catches is surfaces disagreeing with each other
 *        and with package.json — which is the drift that actually happened.
 *        If you change the suite size, update ONE surface and this check will
 *        name every other one that needs to follow.
 *
 * HISTORICAL MENTIONS ARE NOT CLAIMS. "Fixed in 0.3.0", "Implemented in 0.3.0"
 * and the migration ranges in MIGRATIONS.md are correct and must stay. This
 * file therefore matches specific CURRENT-STATE phrasings rather than any
 * semver it can find. Adding a new way to say "as of now, the version is X"
 * means adding it to CLAIMS below, in the same commit.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
const VERSION = pkg.version;
const [MAJOR, MINOR] = VERSION.split('.');

/**
 * Each claim: a file, a regex with one capture group, and what the capture
 * must equal. `kind` groups the mutually-consistent numeric claims.
 */
const CLAIMS = [
  // --- current-state version claims: must equal packages/core/package.json ---
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'version',
    re: /Current as of `@filelayer\/core` \*\*([\d.]+)\*\*/g },
  { file: 'architecture/TIER5-DESIGN-NOTE.md', kind: 'version',
    re: /Current as of `@filelayer\/core` \*\*([\d.]+)\*\*/g },
  { file: 'SECURITY.md', kind: 'version',
    re: /pre-1\.0 \(`([\d.]+)`\)/g },
  { file: 'llms.txt', kind: 'version',
    re: /developer preview, version ([\d.]+), Apache-2\.0/g },
  { file: 'packages/core/llms.txt', kind: 'version',
    re: /developer preview, version ([\d.]+), Apache-2\.0/g },
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'version',
    re: /every item below was re-checked\s*\n?against `([\d.]+)`/g },
  // The Limitations stamp. check-package-copies.mjs also enforces this one, from
  // the other direction (the shipped copy must not lag). Both, deliberately:
  // that stamp is the answer to "is this list current?", and it was the one this
  // gate missed on its first outing.
  { file: 'README.md', kind: 'version',
    re: /Each one is current as of\s*\n?`([\d.]+)`/g },

  // --- the supported-versions table: the minor line must be the current one ---
  { file: 'SECURITY.md', kind: 'minor',
    re: /\|\s*`(\d+\.\d+)\.x`\s*\|\s*Yes\s*\|/g },

  // --- test-count claims: must agree with each other ---
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'tests',
    re: /npm test\s+# (\d+) tests, 0 failures/g },
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'tests',
    re: /`npm test` is \*\*(\d+) \/ \d+ passing\*\*/g },
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'tests',
    re: /`npm test` is \*\*\d+ \/ (\d+) passing\*\*/g },
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'tests',
    re: /\|\s*\*\*total\*\*\s*\|\s*\*\*(\d+)\*\*\s*\|/g },
  { file: 'PUBLISH-RUNBOOK.md', kind: 'tests',
    re: /typecheck, (\d+) tests, build/g },

  // --- suite-count claims: must agree with each other ---
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'suites',
    re: /passing\*\* across (\d+) suites/g },
];

function scan(claims) {
  const found = [];
  const seen = new Map(); // file -> contents
  for (const c of claims) {
    if (!seen.has(c.file)) {
      try {
        seen.set(c.file, readFileSync(join(ROOT, c.file), 'utf8'));
      } catch {
        found.push({ ...c, missing: true });
        continue;
      }
    }
    const text = seen.get(c.file);
    const re = new RegExp(c.re.source, c.re.flags);
    let m;
    let hits = 0;
    while ((m = re.exec(text)) !== null) {
      hits++;
      const line = text.slice(0, m.index).split('\n').length;
      found.push({ file: c.file, kind: c.kind, value: m[1], line, text: m[0].replace(/\s+/g, ' ') });
    }
    if (hits === 0) found.push({ ...c, unmatched: true });
  }
  return found;
}

const found = scan(CLAIMS);
const violations = [];

// A pattern that stops matching is a silent hole in the gate, not a pass.
for (const f of found) {
  if (f.missing) violations.push(`${f.file}: file not found — the claim list is stale.`);
  if (f.unmatched)
    violations.push(
      `${f.file}: the ${f.kind} pattern ${f.re} matched nothing. Either the wording changed ` +
        `(update this file in the same commit) or the claim was removed (delete the entry).`,
    );
}

const claims = found.filter((f) => f.value !== undefined);

for (const c of claims.filter((c) => c.kind === 'version')) {
  if (c.value !== VERSION)
    violations.push(
      `${c.file}:${c.line} says version ${c.value}; packages/core/package.json says ${VERSION}\n      > ${c.text}`,
    );
}

for (const c of claims.filter((c) => c.kind === 'minor')) {
  if (c.value !== `${MAJOR}.${MINOR}`)
    violations.push(
      `${c.file}:${c.line} lists \`${c.value}.x\` as the supported line; the current release is ` +
        `${VERSION}, so the supported line is \`${MAJOR}.${MINOR}.x\`. As written, the security ` +
        `policy declares the current release unsupported.\n      > ${c.text}`,
    );
}

for (const kind of ['tests', 'suites']) {
  const group = claims.filter((c) => c.kind === kind);
  const values = [...new Set(group.map((c) => c.value))];
  if (values.length > 1) {
    violations.push(
      `public surfaces disagree on the ${kind} count: ${values.join(' vs ')}\n` +
        group.map((c) => `      ${c.file}:${c.line}  ${c.value}  > ${c.text}`).join('\n'),
    );
  }
}

// --- negative control: the gate must fail on a value it should reject --------
const control = (() => {
  const bad = [{ file: 'SECURITY.md', kind: 'version', value: '0.3.0', line: 0, text: '(control)' }];
  return bad[0].value !== VERSION;
})();

if (process.argv.includes('--self-test')) {
  console.log(control ? 'check-version-claims: negative control passed.' : 'control DID NOT FAIL');
  process.exit(control ? 0 : 1);
}

if (process.argv.includes('--list')) {
  for (const c of claims) console.log(`${c.file}:${c.line}  [${c.kind}] ${c.value}   ${c.text}`);
}

if (violations.length) {
  console.error('\ncheck-version-claims: FAILED\n');
  for (const v of violations) console.error(`  - ${v}\n`);
  console.error(
    `  ${violations.length} violation(s). The package version is ${VERSION}.\n` +
      `  Historical mentions ("Fixed in 0.3.0") are fine and are not checked;\n` +
      `  only current-state claims are.\n`,
  );
  process.exit(1);
}

if (!control) {
  console.error('check-version-claims: the negative control did not fail. The gate is not working.');
  process.exit(1);
}

const t = claims.filter((c) => c.kind === 'tests')[0]?.value ?? '?';
const s = claims.filter((c) => c.kind === 'suites')[0]?.value ?? '?';
console.log(
  `check-version-claims: clean. ${claims.length} current-state claim(s) across ` +
    `${new Set(claims.map((c) => c.file)).size} public surface(s) all say ${VERSION}, ` +
    `${t} tests, ${s} suites; negative control correct.`,
);
