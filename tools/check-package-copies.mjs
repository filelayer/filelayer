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

import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COPIES, PKG_DIR } from './package-copies.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');


const problems = [];
const fail = (where, msg) => problems.push({ where, msg });

// -----------------------------------------------------------------------------
// COMPLETENESS, for the one directory that grows.
//
// `COPIES` above is hand-written, and that is right for it: every entry carries
// a reason the file ships, which is worth more than the line it costs. But a
// hand-written list of a GROWING directory has a silent failure -- add a fifth
// guide and it simply is not checked, and a checker that was never pointed at a
// file reports success. That is the same defect as the one fixed in
// `check-doc-samples.mjs` on 7 October 2026, found the same way: by adding a
// guide and watching which gates stayed quiet.
//
// So the list stays, and this makes the list prove it is complete. Adding a
// guide now fails here until somebody writes down why it ships.
// -----------------------------------------------------------------------------
{
  const listed = new Set(COPIES.map((c) => c.file));
  // BOTH LEVELS OF `docs/`, not just the guides. The directory itself was
  // enumerated here -- QUICKSTART, LIVE-S3-TESTS, VERIFY-WHAT-YOU-INSTALLED --
  // with discovery only one level down, so a new page at `docs/` top level
  // would have been checked by nothing while `files: ["docs"]` happily shipped
  // whatever was in `packages/core/docs/` instead. Four such pages arrived on
  // 14 October 2026 when the README was thinned.
  const onDisk = [
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`),
    ...readdirSync(join(ROOT, 'docs/guides')).map((f) => `docs/guides/${f}`),
  ];
  for (const file of onDisk.sort()) {
    if (!listed.has(file)) {
      fail(
        file,
        'exists under docs/ and is not in COPIES, so nothing checks that the npm package ' +
          'ships it or that the two copies agree. Add an entry saying why it ships -- or, if it ' +
          'genuinely should not ship, say THAT in the entry and give it no package copy.',
      );
    }
  }
}

// -----------------------------------------------------------------------------
// THE SAME COMPLETENESS QUESTION FOR `examples/`, WHICH IS WHERE IT BIT.
//
// `examples/nextjs` shipped on 7 October 2026 and was NOT in the tarball: the
// list above was hand-written, nobody added seven lines to it, and `files` in
// package.json says `examples`, so the directory was simply absent from the
// published package. Every gate passed. The only reason it was caught is that
// somebody read a `npm publish --dry-run` listing and noticed an absence --
// which is not a check, it is luck.
//
// Four files are deliberately NOT byte-identical: the tier examples and the
// vault import `../../packages/core/src/index.ts` in the checkout and
// `../../src/index.ts` in the package, because the same relative path cannot
// mean the same thing from two different depths. They are named here with that
// reason, so "not in COPIES" stops being a silent state: a file under
// `examples/` is either compared, or listed here as knowingly different.
// -----------------------------------------------------------------------------
const EXAMPLES_REWRITTEN = new Map([
  ['examples/tier1-avatar/app.ts', 'imports the library by relative path, which differs by depth'],
  ['examples/tier2-user-files/app.ts', 'imports the library by relative path, which differs by depth'],
  ['examples/tier3-org-roles/app.ts', 'imports the library by relative path, which differs by depth'],
  ['examples/vault/server.ts', 'imports the library by relative path, which differs by depth'],
]);

{
  const listed = new Set(COPIES.map((c) => c.file));
  const walk = (dir) => {
    const out = [];
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) out.push(...walk(rel));
      else out.push(rel);
    }
    return out;
  };
  for (const file of walk('examples').sort()) {
    if (listed.has(file) || EXAMPLES_REWRITTEN.has(file)) continue;
    fail(
      file,
      'exists under examples/ and is neither in COPIES nor in EXAMPLES_REWRITTEN, so nothing ' +
        'checks that the npm package ships it. `files` in package.json says `examples`, which ' +
        'ships whatever is in packages/core/examples -- not whatever is in examples/. Add it to ' +
        'COPIES with a reason, or to EXAMPLES_REWRITTEN with the reason it cannot be identical.',
    );
  }
  // And the reverse: a file named as knowingly-different must actually exist in
  // both places, or the exemption is excusing nothing and hiding a deletion.
  for (const [file, why] of EXAMPLES_REWRITTEN) {
    for (const side of [join(ROOT, file), join(ROOT, PKG_DIR, file)]) {
      if (!existsSync(side)) {
        fail(file, `is in EXAMPLES_REWRITTEN ("${why}") but ${side} does not exist.`);
      }
    }
  }
}

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
const shippedEntries = corePkg.files ?? [];

/**
 * npm's `files` SHIPS A DIRECTORY WHOLE, so `"examples"` publishes everything
 * under it and a membership test against the literal path is the wrong question.
 *
 * The first version of this check asked exactly that question, and the answer it
 * gave was "add examples/vault/package.json to files" for each of nine paths.
 * A checker that demands a verbose list where npm accepts a short one teaches
 * people to work around the checker.
 */
const isShipped = (relPath) =>
  shippedEntries.some((e) => relPath === e || relPath.startsWith(`${e.replace(/\/+$/, '')}/`));

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
for (const { file, why, versionStamp, rewrite } of COPIES) {
  const rootRel = file;
  const pkgRel = `${PKG_DIR}/${file}`;
  const rootAbs = join(ROOT, rootRel);
  const pkgAbs = join(ROOT, pkgRel);

  let verdict = compareBytes(rootAbs, pkgAbs);

  // A DECLARED REWRITE IS STILL AN EXACT COMPARISON, against a different
  // expected string. See the note on the four example files in COPIES.
  //
  // CHECKED WHENEVER A REWRITE IS DECLARED, not only when the plain byte
  // comparison already said "differs". That condition was `verdict ===
  // 'differs'` until 14 October 2026, and it made this gate blind to the one
  // mistake it exists to catch: a plain `cp` of the root file over the package
  // copy leaves them BYTE-IDENTICAL, so the verdict was 'identical', so the
  // rewrite was never consulted, so the gate passed on a package copy whose
  // declared rewrite had been destroyed.
  //
  // That is not hypothetical. I did it to docs/QUICKSTART.md that morning,
  // this gate said clean, and `check:links` is what noticed -- a gate catching
  // another gate's blind spot by luck. An identical copy is now a FAILURE when
  // a rewrite is declared, because identical is precisely what it must not be.
  if (rewrite && verdict !== 'missing-a' && verdict !== 'missing-both') {
    const root = readFileSync(rootAbs, 'utf8');
    let expected = root;
    for (const [from, to] of rewrite) {
      if (!root.includes(from)) {
        fail(
          rootRel,
          `has a declared rewrite for the package copy, and the pattern it rewrites is no ` +
            `longer in this file:\n      ${from}\n    Either the import moved (update the ` +
            `rewrite in tools/package-copies.mjs in this commit) or the rewrite is ` +
            `obsolete (delete it). Leaving it would make the two copies compare as plain ` +
            `byte-identical again, which is the state that shipped a test suite that could ` +
            `not run.`,
        );
      }
      expected = expected.split(from).join(to);
    }
    if (verdict !== 'missing-b') {
      const actual = readFileSync(pkgAbs, 'utf8');
      if (actual === expected) {
        verdict = 'identical';
      } else if (actual === root) {
        fail(
          pkgRel,
          `is a byte-for-byte copy of ${rootRel}, and this file declares a rewrite, so ` +
            `byte-for-byte is WRONG. Somebody ran \`cp\` instead of \`npm run sync:copies\`. ` +
            `The rewrite exists because a relative path cannot be correct at both locations, ` +
            `and an install is where the broken one is read.\n    npm run sync:copies`,
        );
        verdict = 'identical';
      } else {
        verdict = 'differs';
      }
    }
  }
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

  if (!isShipped(file)) {
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

const withRewrites = COPIES.filter((c) => c.rewrite).length;

if (problems.length === 0) {
  console.log(
    // NOT "byte-identical", which is what this line said and is not true of
    // all of them. The ones with a declared rewrite must differ from the root
    // in exactly the declared way, and saying "byte-identical" about a set that
    // includes them is the kind of summary that makes a reader stop checking.
    `check-package-copies: clean. ${COPIES.length} file(s) match the repository root ` +
      `(${withRewrites} through a declared rewrite, the rest byte for byte), tracked, ` +
      `shipped and stamped ${VERSION}; ` +
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
