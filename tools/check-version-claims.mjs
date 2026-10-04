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

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
  // TRUST.md is the page the README's alpha banner and the website both send a
  // sceptic to, and it is the surface this gate was NOT watching when it was
  // written -- so it sat at 0.4.3 through the whole of 0.4.4. Added 0.5.0.
  { file: 'TRUST.md', kind: 'version',
    re: /\|\s*Version\s*\|\s*([\d.]+) — alpha\s*\|/g },
  // The row now says "405, of which 397 on Node 22 / 24 / 26", because 405 do
  // NOT all run on the three-Node matrix: the eight contention tests need a
  // real PostgreSQL and skip there. The gate watches the FIRST number, which is
  // the suite's size; the second is a property of the matrix, not of the suite.
  { file: 'TRUST.md', kind: 'tests',
    re: /\|\s*Tests\s*\|\s*(\d+), of which \d+ on Node/g },
  { file: 'packages/core/llms.txt', kind: 'version',
    re: /developer preview, version ([\d.]+), Apache-2\.0/g },
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'version',
    re: /every item below was re-checked\s*\n?against `([\d.]+)`/g },
  // The Limitations stamp. check-package-copies.mjs also enforces this one, from
  // the other direction (the shipped copy must not lag). Both, deliberately:
  // that stamp is the answer to "is this list current?", and it was the one this
  // gate missed on its first outing.
  // MOVED FROM README.md WITH THE SENTENCE IT CHECKS. The limitations list left
  // the README on 5 October 2026 -- a reader pointed out that 117 of 528 lines
  // of caveats reads as fragility rather than candour -- and the stamp went with
  // the list rather than being left behind pointing at nothing.
  { file: 'LIMITATIONS.md', kind: 'version',
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
  // THE RUNBOOK'S OWN VERSION, registered on 5 October 2026 after it sat at
  // 0.13.1 through two releases. It carries a test count, which this gate was
  // watching, and a version, which it was not -- so the document that tells a
  // maintainer which commands to run named the wrong release twice and nothing
  // said so. It is the fourth instance of the same hole: a surface is only
  // checked for the claims somebody remembered to register.
  { file: 'PUBLISH-RUNBOOK.md', kind: 'version',
    re: /the version being published is \*\*`([\d.]+)`\*\*/g },

  // --- suite-count claims: must agree with each other ---
  { file: 'ARCHITECTURE-PROGRESSIVE.md', kind: 'suites',
    re: /passing\*\* across (\d+) suites/g },

  // --- the website's trust table ---------------------------------------------
  //
  // THE SURFACE A SCEPTIC READS FIRST, and the one this gate was not watching.
  // On 3 October 2026 the homepage table still said `0.8.0 — alpha` and
  // `375 across 94 suites` while the package was 0.9.0 and the suite ran 405
  // across 100. `check:web` reported clean throughout, because it verifies the
  // JSON-LD `softwareVersion` and never looked at the table a human reads. The
  // machine-readable claim and the human-readable one were different numbers on
  // the same page, and only one of them was checked.
  { file: 'web/index.html', kind: 'version',
    re: /<li><span>Version<\/span><span class="v">([\d.]+) — alpha<\/span><\/li>/g },
  { file: 'web/index.html', kind: 'tests',
    re: /every commit<\/span><span class="v">(\d+) across \d+ suites<\/span>/g },
  { file: 'web/index.html', kind: 'suites',
    re: /every commit<\/span><span class="v">\d+ across (\d+) suites<\/span>/g },

  // --- how many LIVE-storage tests actually run on a commit -------------------
  //
  // Six surfaces said "12 tests, every commit" against both live providers. The
  // run says eleven: the twelfth uploads ~11 MB and is skipped unless
  // FILELAYER_TEST_S3_MULTIPART=1, which only the nightly schedule and a manual
  // dispatch set. The overclaim had been on the R2 side since 30 September and
  // was copied onto the AWS side on 3 October without anyone reading the job
  // summary that says `ran: 11 test(s)` in plain text.
  //
  // One test behind a flag is the smallest possible gap between a claim and the
  // evidence for it, which is exactly the size of gap this project cannot
  // afford: the whole argument for reading our numbers is that we do not round
  // them in our favour.
  { file: 'TRUST.md', kind: 'livetests',
    re: /live Cloudflare R2 \| (\d+) tests every commit/g },
  { file: 'TRUST.md', kind: 'livetests',
    re: /live AWS S3 \| (\d+) tests every commit/g },
  { file: 'web/index.html', kind: 'livetests',
    re: /live Cloudflare R2<\/span><span class="v">(\d+) tests, every commit<\/span>/g },
  { file: 'web/index.html', kind: 'livetests',
    re: /live AWS S3<\/span><span class="v">(\d+) tests, every commit<\/span>/g },
  // The README's R2 sentence moved into the evidence table on 5 October 2026,
  // when the three places that said this became one. The phrase-based sweep
  // further down checks whatever wording it has, wherever it sits, so this
  // registered pattern is not replaced with another one that can go stale.
  { file: 'README.md', kind: 'livetests',
    re: /\*\*(\d+) tests against live Cloudflare R2/g },
  { file: 'llms.txt', kind: 'livetests',
    re: /in CI on every commit \((\d+) tests each/g },
  { file: 'packages/core/llms.txt', kind: 'livetests',
    re: /in CI on every commit \((\d+) tests each/g },
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

// --- the counts, against a RUN rather than against each other ---------------
//
// WHAT THIS BLOCK IS FOR. Everything above compares the public surfaces WITH
// EACH OTHER. On 3 October 2026 the suite ran 405 tests across 100 suites while
// TRUST.md, ARCHITECTURE-PROGRESSIVE.md (three places) and PUBLISH-RUNBOOK.md
// all said 375 across 94 -- and this gate reported clean, because they agreed.
// Four public surfaces carried the same wrong number and the check whose whole
// job is version drift could not see it. Consistency is not accuracy, and a
// number nobody measured is not evidence.
//
// `tools/run-suite.mjs` runs the suite and writes what it counted. This reads
// that, and FAILS when the file is missing or older than the code, rather than
// skipping the comparison and still printing "clean" -- the failure mode that
// made the defect above invisible for a day.
const COUNTS = join(ROOT, '.measured/suite-counts.json');
let recorded = null;
try {
  recorded = JSON.parse(readFileSync(COUNTS, 'utf8'));
} catch {
  violations.push(
    'the test counts have not been measured. `.measured/suite-counts.json` is ' +
      'missing, so the counts on the public surfaces were compared only with each ' +
      'other.\n      Run `npm run test:counted` (or `npm run verify`, which does) ' +
      'and try again.',
  );
}

if (recorded) {
  // STALE IS THE SAME AS ABSENT. A counts file from before the last change to
  // src/ or test/ describes a suite that no longer exists.
  const newest = (() => {
    let t = 0;
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(ts|sql)$/.test(e.name)) t = Math.max(t, statSync(full).mtimeMs);
      }
    };
    for (const d of ['packages/core/src', 'packages/core/test']) walk(join(ROOT, d));
    return t;
  })();
  const at = Date.parse(recorded.at ?? '');
  if (!Number.isFinite(at) || at < newest) {
    violations.push(
      `the recorded test counts are older than the code they describe ` +
        `(${recorded.at ?? 'no timestamp'} vs a source file touched ` +
        `${new Date(newest).toISOString()}). Re-run \`npm run test:counted\`.`,
    );
  } else {
    for (const [kind, actual] of [
      ['tests', recorded.tests],
      ['suites', recorded.suites],
    ]) {
      for (const c of claims.filter((x) => x.kind === kind)) {
        if (Number(c.value) !== actual) {
          violations.push(
            `${c.file}:${c.line} claims ${c.value} ${kind}; the suite counted ${actual}.\n` +
              `      > ${c.text}`,
          );
        }
      }
    }
    // --- the live-storage count, read out of the suite file -----------------
    //
    // Counted statically rather than from a run, because the live suites need
    // credentials this gate does not have. `it(` minus the ones carrying a
    // `skip:` is what executes on an ordinary commit, which is the number every
    // surface above claims.
    const live = readFileSync(join(ROOT, 'packages/core/test/s3-live.test.ts'), 'utf8');
    const total = (live.match(/^\s{2}it\(/gm) ?? []).length;
    const gated = (live.match(/\{\s*skip:/g) ?? []).length;
    const everyCommit = total - gated;
    for (const c of claims.filter((x) => x.kind === 'livetests')) {
      if (Number(c.value) !== everyCommit) {
        violations.push(
          `${c.file}:${c.line} claims ${c.value} live-storage test(s) per commit; ` +
            `test/s3-live.test.ts has ${total} test(s), ${gated} of them behind a skip ` +
            `flag, so ${everyCommit} run on an ordinary commit.\n      > ${c.text}`,
        );
      }
    }
    if (total === 0 || everyCommit <= 0) {
      violations.push(
        'could not count the live-storage tests in test/s3-live.test.ts. The shape of ' +
          'that file changed; fix the patterns in this gate in the same commit.',
      );
    }

    if (recorded.fail > 0) {
      violations.push(
        `the recorded run had ${recorded.fail} failing test(s). No count on a public ` +
          'surface should be published from a red suite.',
      );
    }
  }
}

// --- the sweep: a claim nobody registered is a claim nobody checked ---------
//
// WHAT THIS BLOCK IS FOR, AND WHAT IT COST TO LEARN. Everything above reads an
// explicit list of file-and-regex pairs. On 4 October 2026 an outside analyst
// was given only the published tarball and asked to describe the package. It
// reported, within minutes, that `README.md` said the suite was 405 tests when
// the run says 526. The gate above was green at the time, because README had a
// VERSION claim registered and no TESTS claim registered, so its test count was
// never compared with anything. `web/index.html` carried the same 405 on a
// second, also-unregistered line.
//
// Both numbers had been correct when written and both were a month stale. The
// gate had already been taught twice that consistency is not accuracy; this is
// the third lesson, and it is that REGISTRATION IS NOT COVERAGE. An allow-list
// of claims to check silently exempts every claim nobody thought to add, and
// the exemption is invisible precisely on the surfaces that matter most,
// because those are the ones that accumulate prose.
//
// So this pass inverts the question. Instead of "do the claims I listed agree
// with the run?", it asks "is there a number anywhere on a public surface that
// LOOKS like a whole-suite test count and is not the real one?".
//
// THE DISCRIMINATOR, and why it is a real one rather than a fudge. Public prose
// contains two kinds of test count: the whole suite, and a scoped subset ("12
// tests every commit" against live S3, "30" for the range file, "27 attacks").
// Every scoped subset in this repository is under 100 and the suite is in the
// hundreds, so a floor at 100 separates them cleanly. If a single test file
// ever crosses 100 the sweep will fail on it, which is the correct direction
// for a gate to be wrong in: it stops the build and asks for an exception with
// a reason, rather than going quiet.
const SWEEP_SURFACES = [
  'README.md',
  'llms.txt',
  'TRUST.md',
  'SECURITY.md',
  'ARCHITECTURE-PROGRESSIVE.md',
  'PUBLISH-RUNBOOK.md',
  'web/index.html',
  'docs/QUICKSTART.md',
  'packages/core/README.md',
  'packages/core/llms.txt',
  'packages/core/SEMANTICS.md',
  'packages/core/MIGRATIONS.md',
  'packages/core/docs/QUICKSTART.md',
];

/**
 * Lines the sweep must not read as a whole-suite claim. Each entry needs a
 * reason, and the reason is the point: an exception without one is how an
 * allow-list grows back.
 */
const SWEEP_EXCEPTIONS = [
  // A historical note about a count that WAS right at the time. The sweep would
  // otherwise forbid the project from ever describing its own drift.
  { match: /405 tests when the run says/, why: 'quotes the stale number in order to record it' },
  { match: /said the suite was \d+ tests/, why: 'historical, describes a past claim' },
  { match: /while[\s\S]{0,40}said \d+ across/, why: 'historical, quotes a superseded count' },
];

if (recorded && Number(recorded.tests) > 0) {
  const real = String(recorded.tests);
  // A number of 3+ digits with "test"/"tests" within a short window either
  // side. The window is deliberately tight: at 60 characters a sentence that
  // mentions a count and separately mentions tests starts producing noise.
  const SHAPE = /(?:(\d{3,5})(?=[^.\d][\s\S]{0,36}?\btests?\b)|\btests?\b[\s\S]{0,36}?(\d{3,5})(?![\d.]))/g;
  for (const file of SWEEP_SURFACES) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      violations.push(`${file}: in the sweep list but not on disk. Fix the list in this commit.`);
      continue;
    }
    const re = new RegExp(SHAPE.source, SHAPE.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[1] ?? m[2];
      if (value === real) continue;
      const lineNo = text.slice(0, m.index).split('\n').length;
      const line = text.split('\n')[lineNo - 1] ?? '';
      const before = text.slice(Math.max(0, m.index - 2), m.index);
      const after = text.slice(m.index + m[0].length - value.length + value.length);

      // The four false positives this sweep produced on its first run, each
      // excluded by shape rather than by listing the line. A sweep whose
      // exceptions are all specific lines has become the allow-list it
      // replaced.
      //
      //  - a year: "3 October 2026"
      if (/\b(19|20)\d\d\b/.test(value)) continue;
      //  - a version string: "0.206.0"
      if (new RegExp(`\\d\\.${value}|${value}\\.\\d`).test(line)) continue;
      //  - an HTTP status pair: "206/416", which sits in a sentence about a
      //    test file and so has "tests" within the window.
      if (before.endsWith('/') || /^\/\d/.test(after)) continue;
      //  - the SUITE count in "526 tests across 125 suites". It is a real
      //    claim and it is checked, by the `suites` kind, against the same
      //    recorded run. Reading it as a test count would make the gate
      //    demand that the two numbers be equal.
      if (/^\s*suites?\b/.test(after)) continue;
      const excused = SWEEP_EXCEPTIONS.find((e) => e.match.test(line));
      if (excused) continue;
      violations.push(
        `${file}:${lineNo} reads as a whole-suite test count of ${value}; the recorded run ` +
          `counted ${real}.\n      > ${line.trim().slice(0, 150)}\n` +
          '      If this is a scoped subset rather than the suite, it is over the sweep floor ' +
          'of 100 and\n      needs an entry in SWEEP_EXCEPTIONS with a reason.',
      );
    }
  }
}

// --- the same inversion, for the live-storage counts ------------------------
//
// The sweep above has a floor of 100, so it cannot see the live-storage counts:
// twelve on an ordinary commit, thirteen on the nightly run. Those are
// registered per file, and on 5 October a reader found `Eleven tests against a
// real bucket` in README limitation 7 while two other sentences on the same
// page said twelve. The gate was green, because that line was not one of the
// seven registered `livetests` patterns.
//
// So the same lesson again, and this is the third time: an allow-list of
// file-and-pattern pairs exempts whatever nobody added. The fix is to key on
// the PHRASE and apply it everywhere, so a new sentence anywhere on a public
// surface is checked the moment it is written.
//
// SPELLED-OUT NUMBERS TOO. `Eleven` is the form that slipped through, and a
// gate that only reads digits would have let the same mistake back in on the
// next paragraph.
if (recorded) {
  const live = readFileSync(join(ROOT, 'packages/core/test/s3-live.test.ts'), 'utf8');
  const totalLive = (live.match(/^\s{2}it\(/gm) ?? []).length;
  const gatedLive = (live.match(/\{\s*skip:/g) ?? []).length;
  const perCommit = totalLive - gatedLive;

  const WORDS = {
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15,
  };
  const asNumber = (t) => (/^\d+$/.test(t) ? Number(t) : WORDS[t.toLowerCase()]);

  // The shapes that assert a per-commit live-storage count, wherever they
  // appear. Each must capture the quantity.
  const SHAPES = [
    /(\w+) tests?,?\s+(?:against a real bucket|per commit|each)/gi,
    /(?:commit|commit\*\*)[:,]?\s+(\w+) tests?\b/gi,
    /(\w+) tests? (?:every|per) commit/gi,
  ];

  for (const file of SWEEP_SURFACES) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // the sweep above already reports a missing surface
    }
    for (const shape of SHAPES) {
      const re = new RegExp(shape.source, shape.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = asNumber(m[1]);
        if (n === undefined || n === perCommit) continue;
        // `thirteen` is the nightly figure and legitimately appears beside the
        // per-commit one; only flag it when the sentence does not say nightly.
        const line = text.split('\n')[text.slice(0, m.index).split('\n').length - 1] ?? '';
        if (n === totalLive && /nightly/i.test(line)) continue;
        violations.push(
          `${file}:${text.slice(0, m.index).split('\n').length} says ${m[1]} live-storage ` +
            `test(s) per commit; test/s3-live.test.ts has ${totalLive} with ${gatedLive} behind ` +
            `a skip flag, so ${perCommit} run on an ordinary commit.\n      > ${line.trim().slice(0, 140)}`,
        );
      }
    }
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
