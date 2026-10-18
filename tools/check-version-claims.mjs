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

import { execFileSync } from 'node:child_process';
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
    re: /\|\s*Tests\s*\|\s*(\d+), all of them against a real PostgreSQL/g },
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
  // THE LOCK FILE'S OWN VERSION.
  //
  // Registered on 7 October 2026 after finding it at 0.15.1 while package.json
  // said 0.17.0 -- two releases of drift that nothing noticed, because the lock
  // file is not published and so was not on any surface this gate watched.
  // It is still the file `npm ci` reads, in CI and on a contributor's machine,
  // and a number in it that disagrees with the package is a number somebody
  // will eventually trust. Both occurrences: the root `version` and the `""`
  // entry in `packages`.
  // Anchored on the package NAME, because a bare `"version"` pattern matches
  // every dependency in the file -- which the first version of this entry did,
  // reporting twenty violations about `nanoid`.
  { file: 'packages/core/package-lock.json', kind: 'version',
    re: /"name":\s*"@filelayer\/core",\s*\n\s*"version":\s*"(\d+\.\d+\.\d+)"/g },

  // HOW MANY CHECKS THE STARTER'S `verify.mjs` RUNS.
  //
  // Registered on 7 October 2026 because the three surfaces that stated this
  // number gave three different answers: the starter's own README said twenty,
  // llms.txt said twenty-five, and the script has twenty-four call sites. Both
  // published figures were wrong, in opposite directions, and nothing noticed
  // because the number was prose.
  //
  // The README spells it in words, which is how it drifted in the first place:
  // a figure you cannot grep is a figure nobody re-checks.
  // The pattern captures WHATEVER word is there, not the correct one. Pinning
  // `(Twenty-four)` would have made this registration match only when it was
  // already right -- a check that cannot observe the failure it exists for, and
  // the same defect this file's own header is about.
  { file: 'examples/starter/README.md', kind: 'startercheck',
    re: /^([A-Za-z][A-Za-z-]*) checks over HTTP/gm, words: true },
  { file: 'llms.txt', kind: 'startercheck',
    re: /over HTTP in (\d+) checks/g },
  { file: 'packages/core/llms.txt', kind: 'startercheck',
    re: /over HTTP in (\d+) checks/g },
];

/**
 * Spelled-out numerals, for the one claim that is written in words. Only the
 * values this project has actually used: a longer table would be inventing
 * requirements, and an unknown word fails loudly below rather than passing.
 */
const WORDS = {
  twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23,
  'twenty-four': 24, 'twenty-five': 25, 'twenty-six': 26, 'twenty-seven': 27,
};

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
      found.push({ file: c.file, kind: c.kind, value: m[1], line, words: c.words === true, text: m[0].replace(/\s+/g, ' ') });
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

    // --- the starter's check count, read out of the script ------------------
    //
    // Counted statically, like the live tests above: running it needs a booted
    // starter and a database, which this gate does not have. `check(` minus its
    // own definition is the number of assertions the script makes.
    const verify = readFileSync(join(ROOT, 'examples/starter/verify.mjs'), 'utf8');
    const calls = (verify.match(/\bcheck\(/g) ?? []).length;
    const defs = (verify.match(/function check\(/g) ?? []).length;
    const checks = calls - defs;
    if (checks <= 0) {
      violations.push(
        'could not count the checks in examples/starter/verify.mjs. The shape of that ' +
          'file changed; fix the patterns in this gate in the same commit.',
      );
    }
    for (const c of claims.filter((x) => x.kind === 'startercheck')) {
      const claimed = c.words ? WORDS[String(c.value).toLowerCase()] : Number(c.value);
      if (claimed === undefined) {
        violations.push(
          `${c.file}:${c.line} spells a number this gate cannot read: "${c.value}". Add it ` +
            `to WORDS, or write the digits.\n      > ${c.text}`,
        );
      } else if (claimed !== checks) {
        violations.push(
          `${c.file}:${c.line} claims ${c.value} check(s) in the starter's verify.mjs; ` +
            `the script makes ${checks}.\n      > ${c.text}`,
        );
      }
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
/**
 * THE SURFACES, DISCOVERED -- AND WHY THIS WAS THE LAST LIST TO FALL.
 *
 * This was thirteen hand-written paths. The repository tracks eighty-four
 * documents, and the seventy-one it did not name were never swept at all --
 * including every shipped guide, both copies of the Agent Skill, the example
 * READMEs, and `ROADMAP.md`, which claimed "**Done.** 547 tests ship in the
 * tarball" while the recorded run counted 649.
 *
 * The irony is worth keeping. The comment immediately above explains that this
 * pass exists BECAUSE a list of specific claims leaves the surfaces that
 * accumulate prose unguarded, and says it "inverts the question" to ask whether
 * any public surface carries a number that looks like a suite count and is not
 * the real one. The inversion was right. It was then applied to an enumerated
 * domain, so it could only ever answer that question about a thirteenth of the
 * documents, and the one real stale claim in the repository was sitting in the
 * other eleven-twelfths.
 *
 * Fourth list in this repository to do this, and the second today.
 *
 * So: every tracked `.md`, `.txt` and `.html` is swept. An exemption goes in
 * NOT_SWEPT below with a reason, and a dead exemption fails the build.
 */
const NOT_SWEPT = [
  {
    path: 'packages/core/CHANGELOG.md',
    why:
      'Historical by construction: every entry is headed by the version it describes, ' +
      'and 118 of its lines name a version in the past tense. Sweeping it would ' +
      'require an exception per release.',
  },
  {
    path: 'web/README.md',
    why:
      'The notes on how the site is built and what has gone wrong with it before. ' +
      'Its version numbers are incident records ("the page carried v0.7.0 in two ' +
      'places"), which is the one thing a current-state sweep cannot read.',
  },
  {
    path: 'architecture/TIER5-DESIGN-NOTE.md',
    why: 'A design note dated to the version that prompted it; it argues about 0.3.0 throughout.',
  },
  {
    path: 'benchmark/load/RESULTS.md',
    why: 'A measurement of a specific past build. The version stamp IS the result.',
  },
  {
    path: 'benchmark/baseline-vercel-blob/REPORT.md',
    why:
      "Quantifies the BASELINES' test suites, not ours (\"Baseline 1's 312\"). Checked " +
      'before exempting: no file under benchmark/baseline-* states a test count for ' +
      'Filelayer, so nothing of ours goes unguarded by this.',
  },
  {
    path: 'packages/core/migrations/README.md',
    why:
      'Describes the schema as it stood at each version, including the 0.4.4 floor ' +
      'below which there is no earlier schema to migrate from.',
  },
];

const SWEEP_SURFACES = (() => {
  const tracked = (() => {
    try {
      return execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\0')
        .filter((f) => /\.(md|txt|html)$/.test(f))
        .sort();
    } catch (e) {
      // Say WHY, rather than returning an empty list and letting the guard
      // below report a missing checkout. The first version of this swallowed
      // the error, `execFileSync` was not imported in this file, and the
      // message that came out blamed git -- a check that misdiagnoses itself
      // costs more time than one that crashes.
      console.error(`check-version-claims: could not list tracked documents: ${e.message}`);
      process.exit(2);
    }
  })();
  if (tracked.length === 0) {
    console.error(
      'check-version-claims: git tracks no documents. This sweep would pass by finding\n' +
        '  nothing, which is not the same as passing. It needs a checkout.',
    );
    process.exit(2);
  }
  const dead = NOT_SWEPT.filter((x) => !tracked.includes(x.path));
  if (dead.length > 0) {
    console.error(
      `check-version-claims: ${dead.length} sweep exemption(s) match no tracked document: ` +
        `${dead.map((x) => x.path).join(', ')}.\n\n` +
        '  Remove them. An exemption that matches nothing reads as a decision and does\n' +
        '  nothing, and the next document to land at that path inherits it silently.',
    );
    process.exit(2);
  }
  const exempt = new Set(NOT_SWEPT.map((x) => x.path));
  return tracked.filter((f) => !exempt.has(f));
})();

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
      //  - a BARE HTTP status code. The pair form above caught "206/416" and
      //    nothing else, so a lone `200` or `500` walked straight through -- and
      //    this collision is sharper than it looks, because the sentences that
      //    contain a status code are often sentences about tests: "the expiry
      //    test fails with `200`" puts the word inside the 36-character window
      //    by itself.
      //
      //    Two shapes, both about how the number is WRITTEN rather than which
      //    number it is, because a list of allowed status codes would be a list
      //    again:
      //
      //      `200`  in backticks is a literal being quoted, not prose counting
      //             something. A suite count is never written in code font.
      //      500s   pluralised. "Compiler errors, test failures and 500s" -- a
      //             test count is never pluralised as a number.
      const vAt = m.index + m[0].lastIndexOf(value);
      if (text[vAt - 1] === '`' && text[vAt + value.length] === '`') continue;
      if (/^s\b/.test(text.slice(vAt + value.length))) continue;
      //      a 404  an article in front of it. "test 26 asserts it is a 404" --
      //             a count of tests is never introduced by "a" or "an", and a
      //             status code almost always is.
      if (/\b(?:an?)\s+$/.test(text.slice(Math.max(0, vAt - 6), vAt))) continue;
      //  - the SUITE count in "526 tests across 125 suites". It is a real
      //    claim and it is checked, by the `suites` kind, against the same
      //    recorded run. Reading it as a test count would make the gate
      //    demand that the two numbers be equal.
      if (/^\s*suites?\b/.test(after)) continue;
      // A PASSING COUNT IS NOT EXEMPTED HERE, and the attempt to exempt it is
      // worth recording. On 5 October 2026 llms.txt gained "547 tests, 539
      // passing, 8 skipped" and this sweep flagged the 539, so a rule was
      // added allowing a value that equals the recorded run's pass count. CI
      // rejected it within minutes, correctly: this repository's recorded run
      // happens on a machine WITH a real PostgreSQL, where the concurrency
      // suite executes and the pass count is 547 with nothing skipped. The
      // procedure we publish to strangers uses PGlite and no server, where it
      // is 539 with eight skipped. Both runs are real and neither is the
      // other's expectation, so no single recorded number could validate that
      // sentence.
      //
      // The sentence was removed instead. A pass/skip breakdown belongs in
      // `docs/VERIFY-WHAT-YOU-INSTALLED.md`, where `check:suite-install` runs
      // the procedure and compares the output against the table on every
      // commit. A number checked by a runner beats a number exempted from a
      // sweep.
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

// --- the same inversion again, for HOW OFTEN THE SCHEMA HAS CHANGED ---------
//
// THE SIXTH INSTANCE, and the first REPEAT: this exact defect was found and
// fixed by hand once already. The 0.15.0 changelog carries the entry
// "two public surfaces understated how often the schema has changed", and the
// fix was to write the right numbers into README.md and TRUST.md. Nothing was
// built to keep them right, so they drifted again — and by 0.33.0 the two
// pages carried SEVEN figures between them and every one was wrong:
//
//   README.md   "changed seven times", "thirteen numbered entries",
//               "eight of which carry forward SQL"
//   TRUST.md    "changed six times", "ten numbered entries",
//               "six of them with forward SQL", "Two of the ten"
//
// Truth at that moment: fifteen entries, twelve schema changes, ten with
// forward SQL, two unverifiable. Both pages understated the cost of adopting
// us, which is the direction that flatters us, on the two pages whose whole
// argument is that we do not do that. An outside reader quoted the README's
// figure back at us before this was noticed.
//
// A HAND FIX IS NOT A FIX when the number has to move again at the next schema
// change. This derives all four quantities from `migrations/manifest.json` —
// which is already machine-readable because a reader's migration runner
// enumerates it — and then reads every tracked document for sentences that
// state any of them, by PHRASE rather than by address, for the reasons the
// three sweeps above give at length.
//
// THE ARITHMETIC IS CHECKED TOO, and that is the half a count cannot do on its
// own: a schema change either ships a runnable file or is one of the entries
// that predate the oldest tag, so `schema changes = with SQL + unverifiable`
// must hold. Add an entry and forget its file and this says so, instead of
// waiting for the prose to disagree with itself.
{
  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'packages/core/migrations/manifest.json'), 'utf8'),
  );
  const entries = manifest.expects;
  const withSql = manifest.migrations.length;
  const unverifiable = manifest.unverifiable.length;
  const schemaChanges = entries - manifest.noSchemaChange.length;

  // The manifest and the prose have to be counting the same thing. If someone
  // adds an Entry heading and not a manifest bump, every figure below is
  // derived from a stale number and the sweep would enforce the wrong answer
  // confidently — which is worse than not checking.
  const migrationsMd = readFileSync(join(ROOT, 'packages/core/MIGRATIONS.md'), 'utf8');
  const headings = (migrationsMd.match(/^### Entry \d+ —/gm) ?? []).length;
  if (headings !== entries) {
    violations.push(
      `packages/core/MIGRATIONS.md has ${headings} "### Entry" heading(s) but ` +
        `migrations/manifest.json says expects: ${entries}. One of them is stale, and ` +
        'every published migration figure is derived from the manifest.',
    );
  }
  if (schemaChanges !== withSql + unverifiable) {
    violations.push(
      `migrations/manifest.json does not add up: ${entries} entries minus ` +
        `${manifest.noSchemaChange.length} that change no schema is ${schemaChanges} schema ` +
        `changes, but ${withSql} have a file and ${unverifiable} are marked unverifiable ` +
        `(${withSql + unverifiable}). A schema change either ships SQL or predates the ` +
        'oldest tag; there is no third case.',
    );
  }

  const NUM = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
    fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
    twenty: 20,
  };
  const asNum = (t) => (/^\d+$/.test(t) ? Number(t) : NUM[String(t).toLowerCase()]);

  // Each shape captures a quantity and names which derived figure it is
  // asserting. Spelled-out numbers included, because both pages spell them:
  // "thirteen numbered entries" is the form that drifted, and a gate that only
  // read digits would have watched neither page.
  const SHAPES = [
    { what: 'numbered entries', expect: entries,
      re: /\b(\w+) numbered entr(?:y|ies)/gi },
    { what: 'schema changes', expect: schemaChanges,
      re: /schema (?:has|may change before 1\.0, and \*{0,2}has)\s*\*{0,2}changed\*{0,2}\s+\*{0,2}(\w+)\*{0,2} times?/gi },
    { what: 'entries carrying forward SQL', expect: withSql,
      re: /\b(\w+) of (?:them|which|these) (?:with|carry|carries|have|has|ship|ships) forward SQL/gi },
    { what: 'entries that cannot be verified', expect: unverifiable,
      re: /\b(\w+) of the \w+ cannot be verified/gi },
  ];

  for (const file of SWEEP_SURFACES) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      continue; // the sweep above already reports a missing surface
    }
    for (const shape of SHAPES) {
      const re = new RegExp(shape.re.source, shape.re.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const n = asNum(m[1]);
        // Not a quantity at all -- "a numbered entry", "each of which carries
        // forward SQL". Those are correct however the counts move.
        if (n === undefined) continue;
        if (n === shape.expect) continue;
        const lineNo = text.slice(0, m.index).split('\n').length;
        const line = text.split('\n')[lineNo - 1] ?? '';
        violations.push(
          `${file}:${lineNo} says ${m[1]} ${shape.what}; migrations/manifest.json ` +
            `gives ${shape.expect}.\n      > ${line.trim().slice(0, 140)}`,
        );
      }
    }
  }
}

// --- the same inversion, for the VERSION claims -----------------------------
//
// THE FIFTH INSTANCE, and the first one a stranger could see. On 5 October 2026
// the published homepage carried `v0.13.0` twice -- in the eyebrow under the
// navigation and in the alpha banner directly under the hero, the two most
// prominent pieces of status text on the page -- while the trust table lower
// down said `0.15.1`. Three releases apart, on one page, with this gate green.
//
// Green because `web/index.html` had a `version` claim REGISTERED, and the
// registered pattern was the trust-table `<li>`. The two prose mentions use
// different markup, so they were never read. The page had been wrong since
// 0.14.0 and the only reason it surfaced is that somebody fetched the live site
// and read it.
//
// Same lesson, fifth time: AN ALLOW-LIST OF LOCATIONS EXEMPTS WHATEVER NOBODY
// ADDED, and it does so most reliably on the surfaces that accumulate prose.
// The two sweeps above fixed this for test counts and live-storage counts by
// keying on the claim's PHRASE instead of its address. This does it for
// versions, and the discriminator is the one thing a version string cannot hide.
//
// -----------------------------------------------------------------------------
// THE DISCRIMINATOR
// -----------------------------------------------------------------------------
//
// A public surface mentions two kinds of version, and the difference is
// grammatical rather than positional:
//
//   HISTORICAL -- "fixed in 0.6.0", "since 0.14.0", "created before 0.15.0",
//   "we ran the suite against 0.5.8", "this changed in 0.6.0". Every one of
//   these is correct forever and must never be rewritten. Every one of them
//   also carries a DATING WORD immediately in front of the number.
//
//   CURRENT-STATE -- "v0.13.0 alpha", "Version 0.15.1 — alpha". These claim
//   "this is what you get today" and have no dating word, because a dating word
//   would make them historical.
//
// So: deny by default, and pass a version only when it equals the current one,
// or when the construction in front of it dates it. That is an allow-list of
// about twenty WORDS rather than of files and regexes -- and the difference that
// matters is that a new surface, or a new paragraph on an old one, is covered
// the moment it is written instead of when somebody remembers to register it.
//
// A dating word in front of a current-state claim is not a hole worth closing:
// "the current version is in 0.13.0" is not a sentence anybody writes.

/** `a` is a later semver than `b`. Both are `x.y.z` with numeric parts. */
function newerThan(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i];
  }
  return false;
}

const DATING = [
  'in', 'since', 'before', 'after', 'until', 'through', 'against', 'from',
  'at', 'of', 'by', 'to', 'than', 'predates', 'between', 'via', 'and',
  'was', 'were', 'landed', 'shipped', 'introduced', 'added', 'fixed',
  // `published` earns its place from two real sentences -- "measured against
  // the published 0.11.0" and "an engineer deploying the published 0.11.0" --
  // where the preposition that dates the claim is three words back and an
  // adjective sits in the slot this sweep reads. "the published X" cannot be a
  // claim about the present, because the thing published now is X+n.
  'published',
];

/**
 * Versions that are neither ours nor historical. Each needs a reason.
 */
const VERSION_SWEEP_EXCEPTIONS = [
  {
    match: /pglite@[\^~]?\d|pglite\b[\s\S]{0,40}0\.\d+\.\d+|PGlite[\s\S]{0,60}0\.\d+\.\d+/,
    why: "a DEPENDENCY's version, not ours. @electric-sql/pglite is pinned to 0.3.x and the "
      + 'constraint is load-bearing: npm’s `latest` is 0.5.x and installing it makes the tree '
      + 'refuse with ERESOLVE.',
  },
  {
    match: /`0\.3\.0` through `0\.5\.3`|0\.3\.0.{0,12}through/,
    why: 'a RANGE in the security policy’s advisory table. The first endpoint has no dating '
      + 'word in front of it because `through` sits between the two.',
  },
];

/**
 * The sweep itself, over (file, text) pairs rather than over the disk, so that
 * `--self-test` can hand it text whose verdict is known. A sweep that has only
 * ever been run against a tree that passes is indistinguishable from one that
 * cannot fail, and this one has already been wrong once in a way a green run
 * could not show: the first version's pattern could not match `v0.13.0`.
 *
 * @param {Array<{file: string, text: string}>} entries
 * @returns {string[]} one message per hit
 */
function sweepVersions(entries) {
  const out = [];
  // THE `v?` IS NOT COSMETIC, and leaving it out is how this sweep failed on its
  // first run: `\b0\.` has no word boundary between the `v` and the `0` of
  // `v0.13.0`, so the pattern skipped exactly the form the defect was written
  // in. The gate built to catch the homepage's two stale version strings could
  // not see either of them. Same shape as the four defects it was written for --
  // an instrument that reads a form the artifact does not use -- and the reason
  // it was caught in a minute rather than a month is that this was checked
  // against the two known-bad lines instead of against a green run.
  const SHAPE = /\bv?0\.\d+\.\d+\b/g;
  for (const { file, text } of entries) {
    // MIGRATIONS.md is excluded, and the reason is structural rather than a
    // convenience: every version in it is the `introduced_in` of a numbered
    // historical entry, so the file is one long list of dated claims and has no
    // current-state claim for this sweep to check. Its agreement with the
    // library is verified by `test/schema-version.test.ts`, which compares the
    // manifest against SCHEMA_VERSION, and by `check:migrations`, which
    // executes every entry between the two tags it names.
    if (/MIGRATIONS\.md$/.test(file)) continue;
    // PUBLISH-RUNBOOK.md is excluded for a different reason, and it is worth
    // being explicit because an exclusion is how an allow-list grows back. The
    // runbook is an operator document written as a WORKED EXAMPLE of the first
    // public release, so `0.3.0` appears a dozen times inside literal commands
    // and inside the rollback section's `npm deprecate` / `npm unpublish`
    // illustrations. None of those is a claim about the present, and rewriting
    // them to the current version every release is exactly the manual upkeep
    // this sweep exists to remove. Its one current-state claim -- "the version
    // being published is X" -- is registered above and checked on every commit,
    // which is the claim an operator acts on.
    if (/PUBLISH-RUNBOOK\.md$/.test(file)) continue;
    const re = new RegExp(SHAPE.source, SHAPE.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[0].replace(/^v/, '');
      if (value === VERSION) continue;
      const lineNo = text.slice(0, m.index).split('\n').length;
      const line = text.split('\n')[lineNo - 1] ?? '';

      // A VERSION THAT DOES NOT EXIST YET IS NEVER HISTORICAL, SO THE DATING
      // WORD DOES NOT EXCUSE IT.
      //
      // Checked before the dating-word rule below, deliberately. Twice on
      // 7 October 2026 a sentence was written about the version the work was
      // GOING to ship in -- "until `0.18.0` the Next.js user did not", "since
      // 0.19.0 `code` was a union" -- and committed while the registry still
      // said the previous number. The first was caught by reading a diff. The
      // second was pushed, in `llms.txt`, which ships: a published file telling
      // a reader about a release that did not exist.
      //
      // The sweep let both through because `until` and `since` are dating
      // words, and a dating word is how a sentence about the PAST is supposed
      // to look. Nothing noticed that the number was in the future, which no
      // past tense can make true.
      if (newerThan(value, VERSION)) {
        out.push(
          `${file}:${lineNo} names \`${value}\`, which is AHEAD of packages/core/package.json ` +
            `(${VERSION}).\n      > ${line.trim().slice(0, 150)}\n` +
            '      A version that has not shipped cannot be written about in the past tense.\n' +
            '      Either publish it first, or write the sentence without naming a version.',
        );
        continue;
      }

      // The 40 characters in front of the number, with the decoration a version
      // wears in prose stripped off: backticks, quotes, bold, a `v` prefix, and
      // HTML entities and tags from the website.
      const lead = text
        .slice(Math.max(0, m.index - 40), m.index)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&[a-z]+;/g, ' ')
        .replace(/[`"'*’]|\bv(?=$)/g, '')
        .trimEnd();
      const word = (lead.match(/([A-Za-z]+)[\s:,(\[]*$/) ?? [])[1]?.toLowerCase();
      if (word && DATING.includes(word)) continue;

      const excused = VERSION_SWEEP_EXCEPTIONS.find((e) => e.match.test(line));
      if (excused) continue;

      out.push(
        `${file}:${lineNo} states \`${value}\` as a current version; packages/core/package.json ` +
          `says ${VERSION}.\n      > ${line.trim().slice(0, 150)}\n` +
          '      If this is a historical statement, put a dating word in front of it ' +
          `(${DATING.slice(0, 6).join(', ')}, …)\n      so it reads as one and stays true. ` +
          'If it is neither ours nor historical, it needs an entry in\n' +
          '      VERSION_SWEEP_EXCEPTIONS with a reason.',
      );
    }
  }
  return out;
}

{
  const entries = [];
  for (const file of SWEEP_SURFACES) {
    try {
      entries.push({ file, text: readFileSync(join(ROOT, file), 'utf8') });
    } catch {
      // the test-count sweep already reports a missing surface
    }
  }
  violations.push(...sweepVersions(entries));
}

// --- the freshness stamp, tied to the changelog -----------------------------
//
// WHY A DATE AND NOT JUST A VERSION. `llms.txt` is the one surface written to be
// fetched, cached and vendored by somebody else's tooling, so it is the surface
// most likely to be read long after it was written. On 4 October 2026 an
// evaluator declined Filelayer and quoted our own sentence saying the storage
// adapter had never run against live AWS. That sentence had been true when
// written, was false by the time it was read, and the copy the evaluator held
// carried nothing that said which. A version number alone does not fix that: a
// stale copy states a stale version with equal confidence.
//
// So the file now names its own date and names the one request that cannot be
// stale. This gate exists because a freshness stamp that is itself allowed to go
// stale is worse than none: it converts "I do not know how old this is" into a
// confident wrong answer. The date must equal the changelog's date for the
// current version, so cutting a release cannot leave it behind.
{
  const changelog = readFileSync(join(ROOT, 'packages/core/CHANGELOG.md'), 'utf8');
  const entry = new RegExp(`^## \\[${VERSION.replace(/\./g, '\\.')}\\] — (\\d{4}-\\d\\d-\\d\\d)`, 'm');
  const released = (changelog.match(entry) ?? [])[1];
  if (!released) {
    violations.push(
      `packages/core/CHANGELOG.md has no dated entry for ${VERSION}. The freshness stamp in ` +
        'llms.txt is checked against it, so there is nothing to check against.',
    );
  }
  for (const file of ['llms.txt', 'packages/core/llms.txt']) {
    let text;
    try {
      text = readFileSync(join(ROOT, file), 'utf8');
    } catch {
      violations.push(`${file}: not on disk, so the freshness stamp could not be checked.`);
      continue;
    }
    const m = text.match(/Freshness: this file describes version ([\d.]+) and was written on (\d{4}-\d\d-\d\d)\./);
    if (!m) {
      violations.push(
        `${file} has no freshness stamp. It is the surface most likely to be read from a cache, ` +
          'so it must state the version it describes and the date it was written.\n' +
          '      Expected: `Freshness: this file describes version X and was written on YYYY-MM-DD.`',
      );
      continue;
    }
    if (m[1] !== VERSION) {
      violations.push(`${file}: the freshness stamp says version ${m[1]}; package.json says ${VERSION}.`);
    }
    if (released && m[2] !== released) {
      violations.push(
        `${file}: the freshness stamp is dated ${m[2]}; CHANGELOG.md dates ${VERSION} ` +
          `${released}. A stamp that lags the release it describes tells a reader the file is ` +
          'fresher or older than it is, which is the failure it exists to prevent.',
      );
    }
  }
}

// --- negative control: the gate must fail on a value it should reject --------
const control = (() => {
  const bad = [{ file: 'SECURITY.md', kind: 'version', value: '0.3.0', line: 0, text: '(control)' }];
  return bad[0].value !== VERSION;
})();

/**
 * The version sweep's own controls. Each fixture is text whose verdict is known
 * in advance, and HALF OF THEM MUST FAIL -- a sweep is only as good as the
 * things it rejects, and the two `v`-prefixed cases are here because the first
 * version of this sweep passed them silently.
 *
 * `fixture.html` and `fixture.md` are names that are not in SWEEP_SURFACES, so
 * the two filename exclusions above do not apply to them.
 */
const SWEEP_CONTROLS = [
  // --- must be REJECTED -----------------------------------------------------
  {
    hits: true,
    file: 'fixture.html',
    text: '<p class="eyebrow">Apache-2.0 &middot; v0.13.0 alpha</p>',
    why: 'the homepage eyebrow, verbatim. The `v` prefix is the form that escaped '
      + 'the first version of this sweep.',
  },
  {
    hits: true,
    file: 'fixture.html',
    text: '<b>Alpha. Developer preview.</b> v0.13.0. The schema can still change.',
    why: 'the homepage alpha banner, verbatim.',
  },
  {
    hits: true,
    file: 'fixture.md',
    text: '| Version | 0.13.0 — alpha |',
    why: 'a table cell with no word in front of the number at all. The sweep must '
      + 'not read "no dating word" as "dated".',
  },
  {
    hits: true,
    file: 'fixture.md',
    text: 'The current release is 0.13.0 and the schema may change.',
    why: 'plain prose stating a stale version as the present state.',
  },
  // --- must be ACCEPTED -----------------------------------------------------
  {
    hits: false,
    file: 'fixture.md',
    text: 'Both landed in 0.13.0, and the behaviour changed in 0.6.0.',
    why: 'two historical statements. These must never be rewritten, so the sweep '
      + 'must not demand it.',
  },
  {
    hits: false,
    file: 'fixture.md',
    text: 'verifyAuditChain() reads the chain in pages of 2,000 since `0.14.0`.',
    why: 'historical, with the version in backticks: the decoration must be '
      + 'stripped before the preceding word is read.',
  },
  {
    hits: false,
    file: 'fixture.md',
    text: 'measured against the published 0.11.0. Reads never auto-provision.',
    why: 'historical, with an adjective between the preposition and the number.',
  },
  {
    hits: false,
    file: 'fixture.md',
    text: 'npm install --save-dev "@electric-sql/pglite@^0.3.11"',
    why: "a DEPENDENCY's version. Ours is not the only version on the page.",
  },
  {
    hits: false,
    file: 'fixture.md',
    text: `The current release is ${VERSION}.`,
    why: 'a current-state claim that is correct. The sweep must pass it without '
      + 'needing a dating word.',
  },
];

const sweepControl = (() => {
  const failures = [];
  for (const c of SWEEP_CONTROLS) {
    const got = sweepVersions([{ file: c.file, text: c.text }]).length > 0;
    if (got !== c.hits) {
      failures.push(
        `      ${c.hits ? 'SHOULD HAVE FAILED' : 'SHOULD HAVE PASSED'}: ${JSON.stringify(c.text)}\n` +
          `        ${c.why}`,
      );
    }
  }
  return failures;
})();

if (process.argv.includes('--self-test')) {
  const ok = control && sweepControl.length === 0;
  if (ok) {
    console.log(
      `check-version-claims: negative control passed; the version sweep ` +
        `agreed with all ${SWEEP_CONTROLS.length} controls ` +
        `(${SWEEP_CONTROLS.filter((c) => c.hits).length} of which must fail).`,
    );
  } else {
    if (!control) console.error('control DID NOT FAIL');
    if (sweepControl.length) {
      console.error('the version sweep disagreed with its own controls:\n' + sweepControl.join('\n'));
    }
  }
  process.exit(ok ? 0 : 1);
}

// A control that disagrees is a broken instrument, so it fails the ordinary run
// too rather than only the self-test.
if (sweepControl.length) {
  violations.push(
    'the version sweep disagreed with its own controls, so every version verdict in ' +
      'this run is unreliable:\n' + sweepControl.join('\n'),
  );
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
  // Both numbers, because one of them alone was read as the other. "32 claims
  // across 12 public surfaces" is the DECLARED set -- the claims someone wrote
  // down -- and it was the only figure printed while the sweep that is supposed
  // to catch the undeclared ones covered thirteen files out of eighty-four. A
  // reader checking whether this gate had reach saw "12 public surfaces" and
  // had no way to learn that it was not the answer to that question.
  `check-version-claims: clean. ${claims.length} declared claim(s) across ` +
    `${new Set(claims.map((c) => c.file)).size} surface(s) all say ${VERSION}, ` +
    `${t} tests, ${s} suites; negative control correct. Swept for undeclared ` +
    `claims: ${SWEEP_SURFACES.length} of ${SWEEP_SURFACES.length + NOT_SWEPT.length} ` +
    `tracked document(s), ${NOT_SWEPT.length} exempt with a reason.`,
);
