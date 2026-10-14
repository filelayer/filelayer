#!/usr/bin/env node
/**
 * Move the version across every surface that states it, and nowhere else.
 *
 *     npm run bump:version -- 0.33.0
 *     npm run bump:version -- 0.33.0 --check     # report, write nothing
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Releasing 0.32.0 took four attempts and THREE of them were one hand-written
 * find-and-replace doing three different kinds of damage:
 *
 *   1. A historical sentence falsified. `{ since, until }` arrived in 0.31.0;
 *      "since `0.31.0`" became "since `0.32.0`", which is a false statement
 *      about our own history on two surfaces.
 *   2. A bare table cell missed. `docs/VERIFY-WHAT-YOU-INSTALLED.md` holds the
 *      suite counts as `| 155 |`, and a pattern written for prose
 *      ("155 suites") does not see it -- so the row a stranger compares their
 *      own output against was left stale by an edit whose entire purpose was to
 *      move it.
 *   3. Two git refs read as version numbers. `manifest.json`'s
 *      `verifiedAgainst.from` and `.to` are refs that `check:migrations` checks
 *      out. Rewriting `v0.31.0` to `v0.32.0` pointed them at a tag that did not
 *      exist and took down the only gate that proves a migration produces the
 *      schema it claims.
 *
 * Each fix was correct and none addressed the cause: a release touches thirty
 * files and THREE CATEGORIES OF STRING THAT LOOK IDENTICAL and must be treated
 * differently. Writing the pattern freehand each time is the same mistake as
 * typing `cp` instead of `npm run sync:copies`.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CATEGORIES
 * ---------------------------------------------------------------------------
 *
 *   CURRENT-STATE CLAIM -- "pre-1.0 (`0.32.0`)", "Filelayer 0.32.0, alpha".
 *   Replaced. This is the only category that moves.
 *
 *   DATED HISTORICAL CLAIM -- "since `0.31.0`", "present in 0.30.0", "Fixed in
 *   0.6.0", a changelog heading. NEVER touched. These are statements about the
 *   past and moving one makes it false. `check:since` verifies a sample of them
 *   against the published tarballs, which is how defect 1 was eventually
 *   caught -- after it had shipped into two files.
 *
 *   GIT REF -- `v0.31.0`. NEVER touched, and the discriminator is embarrassingly
 *   simple once seen: a version carrying a `v` prefix is a tag, not a claim.
 *   The hand-written pattern matched `0.31.0` INSIDE `v0.31.0`, which is the
 *   whole of defect 3.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not touch the test counts. Those come from a measured run
 * (`npm run test:counted`, and the install figures from
 * `check:suite-runs-from-install`), and a tool that edited them would be
 * writing numbers nobody measured -- the defect `check:versions` exists to
 * catch. Defect 2 above was a count, not a version, and the lesson it teaches
 * is that counts are a separate job and not that this tool should grow to
 * cover them.
 *
 * It does not commit, does not tag, and does not publish.
 *
 * And it REPORTS EVERY LINE IT DECLINED TO TOUCH. That report is the actual
 * safety mechanism: a skip rule nobody reads is a skip rule that is wrong in
 * silence.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages/core/package.json');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const target = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
const from = pkg.version;

if (!target) {
  console.error(
    `bump-version: give the new version.\n\n  npm run bump:version -- <version>\n\n` +
      `  This checkout is ${from}.`,
  );
  process.exit(2);
}

// A bump that goes backwards or nowhere is a typo, and the consequence of
// acting on it is thirty files edited in the wrong direction.
const cmp = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
if (cmp(target, from) <= 0) {
  console.error(
    `bump-version: ${target} is not ahead of ${from}. Refusing.\n` +
      '  Pre-1.0 versioning only moves forward; see MIGRATIONS.md section 1.',
  );
  process.exit(2);
}

// -----------------------------------------------------------------------------
// WHOLE FILES THAT ARE HISTORY, and are never rewritten by a release.
// -----------------------------------------------------------------------------
const NEVER = [
  // Every heading in it is a dated claim about a release that happened.
  'packages/core/CHANGELOG.md',
  // Entry N says which versions it moves between. All of them are history.
  'packages/core/MIGRATIONS.md',
];

/**
 * A line that dates something to a version is a statement about the past.
 *
 * Generous on purpose: a false negative here falsifies our own history on a
 * public surface, and a false positive only means one line needs a human. The
 * report at the end is what makes the trade safe.
 */
const DATED = [
  /\b[Ss]ince\s+`?\d+\.\d+\.\d+/,
  /\b(?:present|absent)\s+in\s+`?\d+\.\d+\.\d+/,
  /\b(?:Fixed|fixed|introduced|Introduced|added|Added|removed|Removed|renamed|Renamed)\s+in\s+`?\d+\.\d+\.\d+/,
  /\bintroducedIn\b/,
  /\bintroduced_in\b/,
  /\buntil\s+`?\d+\.\d+\.\d+/,
  /\bin\s+`?\d+\.\d+\.\d+`?,?\s+(?:which|when|and)\b/,
  /\bverifiedAgainst\b/,
  /"(?:from|to)":\s*"v?\d+\.\d+\.\d+"/,
];

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean)
  .filter((f) => /\.(md|txt|html|json|ts|mjs|sql|yml|yaml)$/.test(f))
  .filter((f) => existsSync(join(ROOT, f)));

// A `v` prefix means a git tag. Matching the bare version inside one is the
// whole of defect 3, so the lookbehind is the fix and it is the only clever
// thing in this file.
const BARE = new RegExp(`(?<![\\w.v])${from.replace(/\./g, '\\.')}(?![\\w.])`, 'g');

const changed = [];
const skipped = [];
const skippedFiles = [];

for (const rel of tracked) {
  if (NEVER.includes(rel)) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    const hits = text.split('\n').filter((l) => BARE.test(l)).length;
    if (hits > 0) skippedFiles.push({ rel, hits });
    continue;
  }

  const abs = join(ROOT, rel);
  const lines = readFileSync(abs, 'utf8').split('\n');
  let touched = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!BARE.test(line)) continue;
    if (DATED.some((re) => re.test(line))) {
      skipped.push({ rel, line: i + 1, text: line.trim().slice(0, 110) });
      continue;
    }
    lines[i] = line.replace(BARE, target);
    touched++;
  }

  if (touched > 0) {
    changed.push({ rel, touched });
    if (!CHECK_ONLY) writeFileSync(abs, lines.join('\n'));
  }
}

// package.json and the lock carry the version as data rather than as prose, and
// `BARE` already caught them above -- but the lock states it twice and the
// package once, so they are asserted rather than assumed.
if (!CHECK_ONLY) {
  const after = JSON.parse(readFileSync(PKG, 'utf8'));
  if (after.version !== target) {
    console.error(
      `bump-version: packages/core/package.json still says ${after.version}.\n` +
        '  The version is the one string that MUST move, so this is a failure and not a skip.',
    );
    process.exit(1);
  }
}

// -----------------------------------------------------------------------------
// The report, which is the point
// -----------------------------------------------------------------------------
const verb = CHECK_ONLY ? 'would change' : 'changed';
console.log(`bump-version: ${from} -> ${target}\n`);
console.log(`  ${verb} ${changed.length} file(s):`);
for (const c of changed) console.log(`    ${c.rel}  (${c.touched} line(s))`);

if (skippedFiles.length > 0) {
  console.log(`\n  left alone entirely, because they are history:`);
  for (const f of skippedFiles) console.log(`    ${f.rel}  (${f.hits} mention(s) of ${from})`);
}

if (skipped.length > 0) {
  console.log(
    `\n  LEFT ALONE, ${skipped.length} line(s) that date something to ${from}.` +
      '\n  READ THESE. A dated claim moved forward becomes a false statement about\n' +
      '  our own history, and that is what this tool exists to stop:',
  );
  for (const s of skipped) console.log(`    ${s.rel}:${s.line}\n      ${s.text}`);
}

console.log(
  `\n  Counts are NOT touched by this tool. Re-measure them:\n` +
    '    npm run test:counted\n' +
    '  and take the install-shape figures for docs/VERIFY-WHAT-YOU-INSTALLED.md\n' +
    '  from `npm run check:suite-install`, which compares every row of its table.\n\n' +
    '  Then: npm run sync:copies && npm run check:versions && npm run check:since',
);
