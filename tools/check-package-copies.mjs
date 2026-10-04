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
    // NO STAMP, SINCE 0.16.0, AND THAT IS A CHANGE WORTH EXPLAINING. The stamp
    // was the "Each one is current as of `0.4.3`" sentence introducing the
    // limitations list, and the list moved to LIMITATIONS.md, where the stamp
    // went with it. Leaving the regex here would fail the build for a sentence
    // that is correctly somewhere else, and inventing a second version number
    // for this file would be one more hand-maintained figure that can only go
    // stale -- which is the defect this whole family of gates exists for. The
    // npm badge at the top of the README is the live answer.
    versionStamp: null,
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
  {
    // AT docs/ ON BOTH SIDES, so the link in llms.txt and the file on disk are
    // the same path as well as the same bytes.
    file: 'docs/QUICKSTART.md',
    why:
      'the install-to-first-file document. An agent integrating this package was ' +
      'told by llms.txt to start here, found it was the one Start-here file not ' +
      'in the tarball, and had to fetch it over the network. Measured 3 October 2026.',
    versionStamp: null,
    // SEMANTICS.md ships at the PACKAGE ROOT and lives at `packages/core/` in
    // the checkout, so the relative link to it cannot be the same string in
    // both copies. Rewritten rather than turned into a URL because this is a
    // document that ships, and the reader this file was written for has an
    // install and no browser. See the note on the example files below.
    rewrite: [['](../packages/core/SEMANTICS.md)', '](../SEMANTICS.md)']],
  },
  {
    file: 'LIMITATIONS.md',
    why:
      'the complete list of what this does not do. It was 117 of the README\'s ' +
      '528 lines until 5 October 2026, when a reader pointed out that reads as ' +
      'fragility rather than candour; moving it must not make it harder to ' +
      'reach, so it ships.',
    versionStamp: /as of\s+`(\d+\.\d+\.\d+)`/,
  },
  {
    file: 'TRUST.md',
    why:
      'the evidence table, and the document the README puts first. It was cited ' +
      'by absolute URL only, so the one reader this project claims to design for ' +
      '-- an install, no browser -- could not reach the numbers that decide ' +
      'whether to depend on this. Found 4 October 2026 by an analyst given only ' +
      'the tarball.',
    versionStamp: /\|\s*Version\s*\|\s*(\d+\.\d+\.\d+)\s*—/,
  },
  {
    file: 'SECURITY.md',
    why: 'how to report a vulnerability, and which versions are supported. A reviewer needs it offline.',
    versionStamp: /pre-1\.0 \(`(\d+\.\d+\.\d+)`\)/,
  },
  {
    file: 'docs/LIVE-S3-TESTS.md',
    why:
      'the CHANGELOG names it three times and `docs/` ships, so a reader who ' +
      'found `docs/` in their install went looking for it and came up empty.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/deleting-files-and-orphaned-objects.md',
    why: 'the fourth guide: the sweeper deletes on an absence, and a partial answer is an absence.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/deleting-files-and-orphaned-objects.proof.mjs',
    why: 'the script that demonstrates it, both directions.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/README.md',
    why: 'the index. With three guides this is a destination rather than loose files.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/multi-tenant-file-access.md',
    why: 'the third guide: RLS filters reads and does not stop a cross-tenant write.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/multi-tenant-file-access.proof.mjs',
    why: 'the script that demonstrates it, against a real PostgreSQL.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/private-file-uploads.md',
    why:
      'the second guide. It is the one where this library is NOT the answer to ' +
      'the main question, which is the point: a guide that only ever concludes ' +
      '"use us" is an advertisement, and nothing cites an advertisement.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/expiring-and-revocable-file-links.proof.mjs',
    why:
      'the script that produced the numbers in the guide beside it. It ships for ' +
      'the same reason the tests do: a measurement nobody can re-run is an ' +
      'assertion with a confident voice.',
    versionStamp: null,
  },
  {
    file: 'docs/guides/expiring-and-revocable-file-links.md',
    why:
      'the first of the guides: the answer to a question whose usual answer is ' +
      'wrong. It ships because the reader we most want is an agent with an ' +
      'install and no browser, and because llms.txt names it.',
    versionStamp: null,
  },
  ...[
    'examples/tier1-avatar/package.json',
    'examples/tier2-user-files/package.json',
    'examples/tier3-org-roles/package.json',
    'examples/vault/package.json',
    'examples/starter/server.ts',
    'examples/starter/verify.mjs',
    'examples/starter/README.md',
    'examples/starter/package.json',
    'examples/starter/.env.example',
  ].map((file) => ({
    file,
    why: 'a runnable example the documentation points at; shipping it is what makes it readable offline',
    versionStamp: null,
  })),

  // THE FOUR FILES THAT CANNOT BE BYTE-IDENTICAL, AND THE ONE LINE THAT DIFFERS.
  //
  // These four import the library by a RELATIVE path, and the two copies sit at
  // different depths, so one path cannot be correct in both places:
  //
  //   examples/tier1-avatar/app.ts                -> ../../packages/core/src/index.ts
  //   packages/core/examples/tier1-avatar/app.ts  -> ../src/index.ts
  //
  // Before 4 October the copies held the root's path verbatim, so from the copy
  // it resolved to `packages/core/packages/core/src/index.ts` and the copies
  // could not be imported at all. Nothing noticed, because the only thing that
  // imported these examples was `test/tiers.test.ts` and
  // `test/vault-example.test.ts` reaching THREE levels up to the root copies --
  // a path that itself escapes the package root in an install, so those 28
  // tests did not run for anyone using the shipped suite either. Two wrong
  // paths that cancelled out in the repository and failed together everywhere
  // else. Found by an outside analyst holding only the published tarball.
  //
  // The tests now import `../examples/`, the copies carry `../src/`, and both
  // resolve in the repository and in an install. The rewrite below is what
  // keeps the rest of these four files verified: it is applied to the root file
  // and the result must match the copy EXACTLY, and the check fails if the
  // pattern is absent from the root -- a rewrite rule that stops applying would
  // otherwise quietly collapse back into byte-identity and pass.
  ...[
    'examples/tier1-avatar/app.ts',
    'examples/tier2-user-files/app.ts',
    'examples/tier3-org-roles/app.ts',
    'examples/vault/server.ts',
  ].map((file) => ({
    file,
    why:
      'a runnable example the documentation points at, and one the shipped test suite ' +
      'imports, so the package copy must resolve the library from the package root',
    versionStamp: null,
    rewrite: [["'../../packages/core/src/index.ts'", "'../../src/index.ts'"]],
  })),
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
  if (rewrite && verdict === 'differs') {
    const root = readFileSync(rootAbs, 'utf8');
    let expected = root;
    for (const [from, to] of rewrite) {
      if (!root.includes(from)) {
        fail(
          rootRel,
          `has a declared rewrite for the package copy, and the pattern it rewrites is no ` +
            `longer in this file:\n      ${from}\n    Either the import moved (update the ` +
            `rewrite in tools/check-package-copies.mjs in this commit) or the rewrite is ` +
            `obsolete (delete it). Leaving it would make the two copies compare as plain ` +
            `byte-identical again, which is the state that shipped a test suite that could ` +
            `not run.`,
        );
      }
      expected = expected.split(from).join(to);
    }
    if (readFileSync(pkgAbs, 'utf8') === expected) verdict = 'identical';
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
