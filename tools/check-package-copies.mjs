#!/usr/bin/env node
/**
 * Fail the build if the files `packages/core` ships from the repository root
 * are not byte-identical to the root originals, or are not there at all.
 *
 *   node tools/check-package-copies.mjs              # check, exit 1 on a hit
 *   node tools/check-package-copies.mjs --list       # the files and their sizes
 *   node tools/check-package-copies.mjs --self-test  # the negative control only
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT
 * -----------------------------------------------------------------------------
 *
 * Five files are the same file seen from two places: README.md, LICENSE,
 * NOTICE, llms.txt and openapi.json live at the repository root, where a person
 * reads them on GitHub, and inside `packages/core`, where they are what an
 * installed consumer -- or an agent with nothing but `node_modules` -- has to
 * read instead.
 *
 * Up to 0.4.2 the package copies were produced by the `prepack` script and
 * excluded from version control. That arrangement has two properties worth
 * naming, because only one of them is a bug:
 *
 *   * On a clean checkout the files do not exist until something runs `pack`.
 *     Every gate in this repository that reads "what the package ships" was
 *     therefore reading files that were absent, and silently passing. The
 *     publication-boundary check expands `packages/core/package.json` `files`
 *     against the disk and skips entries that are not there; on a fresh clone
 *     it skipped all three.
 *
 *   * There was no check that the copy matched the original. `copyFileSync`
 *     overwriting a stale file is reliable, but "reliable because the script is
 *     correct" is not the same as "verified", and the script was the only thing
 *     standing between the two copies.
 *
 * 0.4.3 tracks the copies instead of generating them. That trades a generation
 * step for a second source of truth, which is only an improvement if the second
 * source is verified rather than trusted. This file is that verification.
 *
 * NOTE ON WHAT THIS DOES *NOT* FIX. The empty `readme` in the npm packument for
 * `@filelayer/core` was NOT caused by the copies being generated at pack time.
 * npm re-reads the manifest AFTER `prepack` runs (`lib/commands/publish.js`:
 * "The purpose of re-reading the manifest is in case it changed"), so the
 * README was already reaching the registry. See CHANGELOG 0.4.3 for what the
 * cause actually is. This check makes the packaging verifiable; it is not the
 * remedy for that defect and must not be mistaken for it.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS CHECKED
 * -----------------------------------------------------------------------------
 *
 *   1. IDENTICAL.  Every file in COPIES exists at both paths and the two byte
 *                  strings are equal. Compared as bytes, not as text: a BOM, a
 *                  line ending or a trailing newline is a difference, and a
 *                  reader who diffs the tarball against GitHub would see it.
 *
 *   2. TRACKED.    Every copy is in `git ls-files`, so a clean checkout has it
 *                  before anything runs. This is the property the previous
 *                  arrangement lacked.
 *
 *   3. SHIPPED.    Every copy is named in `files` in packages/core/package.json.
 *                  A verified copy that does not ship is not a copy of
 *                  anything.
 *
 *   4. NOT GENERATED. `prepack` does not write any of them. Two mechanisms for
 *                  one file is how the copies drifted in the first place, and a
 *                  generator would overwrite what this check just verified.
 *
 *   5. VERSION.    Every version stamp inside the shipped files denotes the
 *                  version in packages/core/package.json. An agent reading
 *                  `llms.txt` out of `node_modules` has no other way to know
 *                  which release it is holding, and a stamp that lags is worse
 *                  than no stamp: it is a confident wrong answer.
 *
 * -----------------------------------------------------------------------------
 * THE NEGATIVE CONTROL
 * -----------------------------------------------------------------------------
 *
 * `runNegativeControl()` builds pairs of files in a temporary directory whose
 * correct classification is known -- identical, one byte different, differing
 * only in a trailing newline, one side missing, one side empty -- and fails if
 * the comparator classifies any of them wrongly. The empty-file case is there
 * on purpose: a comparator written with a truthiness test calls two empty files
 * equal AND calls an empty file "missing", and both mistakes look like a pass.
 *
 * It runs on EVERY invocation, before the real scan. A comparator that has
 * never rejected anything is a green tick of unknown value.
 */

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = 'packages/core';

/**
 * The files that exist at the repository root AND inside the package.
 *
 * `versionStamp` names a regular expression with one capture group that must
 * yield the published version. `null` means the file carries no version and is
 * not expected to. Nothing here hard-codes a version number.
 */
const COPIES = [
  {
    file: 'README.md',
    why: 'the first thing a stranger reads, on GitHub and in the tarball',
    // "Each one is current as of `0.4.3`; where a limitation has been lifted..."
    // `\s+` rather than a space: the sentence wraps, and a checker that breaks
    // on a reflowed paragraph teaches people to delete the checker.
    versionStamp: /as of\s+`(\d+\.\d+\.\d+)`/,
  },
  {
    file: 'LICENSE',
    why: 'the licence the package advertises must be the licence it ships',
    versionStamp: null,
  },
  {
    file: 'NOTICE',
    why: 'Apache-2.0 §4(d): the NOTICE travels with the distribution',
    versionStamp: null,
  },
  {
    file: 'llms.txt',
    why: 'the orientation file for an agent that has only node_modules',
    versionStamp: /\bversion (\d+\.\d+\.\d+)\b/,
  },
  {
    file: 'openapi.json',
    why: 'the machine-readable shape of the API, for the same reader',
    versionStamp: /"version":\s*"(\d+\.\d+\.\d+)"/,
  },
];

const problems = [];
const fail = (where, msg) => problems.push({ where, msg });

// -----------------------------------------------------------------------------
// The comparator. Everything else in this file is bookkeeping around it, and it
// is exported so the negative control tests the same function the scan uses.
// -----------------------------------------------------------------------------

/**
 * Compare two files as byte strings.
 *
 * Returns one of: 'identical', 'differs', 'missing-a', 'missing-b',
 * 'missing-both'. Deliberately never returns a boolean: "not identical" and
 * "not there" need different messages, and collapsing them is how a missing
 * file gets reported as a diff nobody can find.
 */
export function compareBytes(pathA, pathB) {
  const a = existsSync(pathA);
  const b = existsSync(pathB);
  if (!a && !b) return 'missing-both';
  if (!a) return 'missing-a';
  if (!b) return 'missing-b';
  const bufA = readFileSync(pathA);
  const bufB = readFileSync(pathB);
  return bufA.equals(bufB) ? 'identical' : 'differs';
}

/** The first byte offset at which two files differ, for the error message. */
function firstDifference(pathA, pathB) {
  const a = readFileSync(pathA);
  const b = readFileSync(pathB);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n; // one is a prefix of the other
}

// -----------------------------------------------------------------------------
// The negative control.
// -----------------------------------------------------------------------------

export function runNegativeControl() {
  const dir = mkdtempSync(join(tmpdir(), 'filelayer-copies-'));
  const p = (n) => join(dir, n);
  const cases = [];
  try {
    writeFileSync(p('same-a'), 'one\ntwo\n');
    writeFileSync(p('same-b'), 'one\ntwo\n');
    cases.push({ name: 'identical files', a: 'same-a', b: 'same-b', expect: 'identical' });

    writeFileSync(p('byte-a'), 'one\ntwo\n');
    writeFileSync(p('byte-b'), 'one\ntwO\n');
    cases.push({ name: 'one byte different', a: 'byte-a', b: 'byte-b', expect: 'differs' });

    writeFileSync(p('nl-a'), 'one\ntwo\n');
    writeFileSync(p('nl-b'), 'one\ntwo');
    cases.push({ name: 'trailing newline only', a: 'nl-a', b: 'nl-b', expect: 'differs' });

    writeFileSync(p('crlf-a'), 'one\ntwo\n');
    writeFileSync(p('crlf-b'), 'one\r\ntwo\r\n');
    cases.push({ name: 'line endings only', a: 'crlf-a', b: 'crlf-b', expect: 'differs' });

    writeFileSync(p('bom-a'), 'one\n');
    writeFileSync(p('bom-b'), '﻿one\n');
    cases.push({ name: 'byte-order mark only', a: 'bom-a', b: 'bom-b', expect: 'differs' });

    writeFileSync(p('only-a'), 'one\n');
    cases.push({ name: 'right side missing', a: 'only-a', b: 'absent-b', expect: 'missing-b' });
    cases.push({ name: 'left side missing', a: 'absent-a', b: 'only-a', expect: 'missing-a' });
    cases.push({ name: 'both missing', a: 'absent-a', b: 'absent-b', expect: 'missing-both' });

    // The two truthiness traps. An empty file IS a file, and two empty files
    // ARE identical; a comparator that reads content and tests it for truth
    // gets both of these wrong while looking like it works.
    writeFileSync(p('empty-a'), '');
    writeFileSync(p('empty-b'), '');
    cases.push({ name: 'two empty files', a: 'empty-a', b: 'empty-b', expect: 'identical' });
    writeFileSync(p('full-a'), 'one\n');
    cases.push({ name: 'empty vs non-empty', a: 'empty-a', b: 'full-a', expect: 'differs' });

    const wrong = [];
    for (const c of cases) {
      const got = compareBytes(p(c.a), p(c.b));
      if (got !== c.expect) wrong.push(`${c.name}: expected ${c.expect}, got ${got}`);
    }
    return { total: cases.length, wrong };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------

const control = runNegativeControl();
if (control.wrong.length) {
  console.error('\ncheck-package-copies: FAILED its own negative control\n');
  console.error('The comparator misclassified input whose answer is known. Its verdict on the');
  console.error('real files means nothing until this is fixed.\n');
  for (const w of control.wrong) console.error('    ' + w);
  console.error('');
  process.exit(1);
}

if (process.argv.includes('--self-test')) {
  console.log(
    `check-package-copies: negative control passed, ${control.total} classification(s).`,
  );
  process.exit(0);
}

const corePkg = JSON.parse(readFileSync(join(ROOT, PKG_DIR, 'package.json'), 'utf8'));
const VERSION = corePkg.version;
const shipped = new Set(corePkg.files ?? []);

let tracked;
try {
  tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter(Boolean),
  );
} catch (e) {
  console.error('\ncheck-package-copies: could not run `git ls-files`: ' + e.message + '\n');
  process.exit(1);
}

if (process.argv.includes('--list')) {
  for (const { file } of COPIES) {
    const rootAbs = join(ROOT, file);
    const pkgAbs = join(ROOT, PKG_DIR, file);
    const size = existsSync(rootAbs) ? readFileSync(rootAbs).length : '-';
    console.log(`${file.padEnd(14)} ${String(size).padStart(7)} bytes   ${compareBytes(rootAbs, pkgAbs)}`);
  }
  process.exit(0);
}

// 1 + 2 + 3 + 5, per file.
for (const { file, why, versionStamp } of COPIES) {
  const rootRel = file;
  const pkgRel = `${PKG_DIR}/${file}`;
  const rootAbs = join(ROOT, rootRel);
  const pkgAbs = join(ROOT, pkgRel);

  const verdict = compareBytes(rootAbs, pkgAbs);
  if (verdict === 'missing-a' || verdict === 'missing-both') {
    fail(rootRel, `does not exist. It is the canonical copy of a file the package ships (${why}).`);
  }
  if (verdict === 'missing-b' || verdict === 'missing-both') {
    fail(
      pkgRel,
      `does not exist. Since 0.4.3 this file is tracked, not generated: copy it from ` +
        `${rootRel} and commit it.\n    cp ${rootRel} ${pkgRel}`,
    );
  }
  if (verdict === 'differs') {
    const at = firstDifference(rootAbs, pkgAbs);
    fail(
      pkgRel,
      `differs from ${rootRel}, first at byte ${at}. These are one file in two places ` +
        `(${why}); an installed consumer reads the package copy and would see something ` +
        `GitHub does not show.\n    diff ${rootRel} ${pkgRel}\n    cp   ${rootRel} ${pkgRel}`,
    );
  }

  if (!tracked.has(pkgRel)) {
    fail(
      pkgRel,
      `is not tracked by git. A clean checkout would not have it, and every gate that ` +
        `reads "what the package ships" would skip it and pass.\n    git add ${pkgRel}`,
    );
  }

  if (!shipped.has(file)) {
    fail(
      `${PKG_DIR}/package.json`,
      `"files" does not list "${file}", so the verified copy is not published. Add it in ` +
        `the same commit, and add a glob for it to .internal-language.json "include".`,
    );
  }

  if (versionStamp && verdict !== 'missing-a' && verdict !== 'missing-both') {
    const text = readFileSync(rootAbs, 'utf8');
    const m = versionStamp.exec(text);
    if (!m) {
      fail(
        rootRel,
        `carries no version stamp matching /${versionStamp.source}/. Either the stamp was ` +
          `removed or its wording changed; a reader with only this file cannot tell which ` +
          `release they are holding.`,
      );
    } else if (m[1] !== VERSION) {
      fail(
        rootRel,
        `stamps version ${m[1]}, but ${PKG_DIR}/package.json says ${VERSION}. A stale stamp ` +
          `is a confident wrong answer to the one question this file exists to settle.`,
      );
    }
  }
}

// 4. `prepack` must not write any of them.
const prepack = corePkg.scripts?.prepack ?? '';
for (const { file } of COPIES) {
  if (prepack.includes(file)) {
    fail(
      `${PKG_DIR}/package.json`,
      `the "prepack" script names "${file}". Since 0.4.3 the copy is tracked and verified ` +
        `here; a generator would overwrite the file this check just approved and put the two ` +
        `mechanisms back in disagreement.\n    prepack: ${prepack}`,
    );
  }
}
if (/copyFileSync|\bcp\b/.test(prepack)) {
  fail(
    `${PKG_DIR}/package.json`,
    `the "prepack" script copies files into the package. Anything the package ships from ` +
      `the root belongs in COPIES in this file, tracked and compared, not generated at pack ` +
      `time.\n    prepack: ${prepack}`,
  );
}

if (problems.length === 0) {
  console.log(
    `check-package-copies: clean. ${COPIES.length} file(s) byte-identical to the repository ` +
      `root, tracked, shipped and stamped ${VERSION}; ` +
      `${control.total} negative-control classification(s) correct.`,
  );
  process.exit(0);
}

console.error('\ncheck-package-copies: FAILED\n');
console.error(
  'A file the npm package ships is not the file the repository root shows, or is not\n' +
    'where a clean checkout would find it.\n',
);
for (const p of problems) {
  console.error(`  ${p.where}`);
  console.error(`  ${'-'.repeat(p.where.length)}`);
  console.error(`  ${p.msg}\n`);
}
console.error(`${problems.length} problem(s).\n`);
process.exit(1);
