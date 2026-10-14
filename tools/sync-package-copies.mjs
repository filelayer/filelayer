#!/usr/bin/env node
/**
 * Write the package copies from the declarations, instead of by hand.
 *
 *     npm run sync:copies
 *     npm run sync:copies -- --check      # report, write nothing
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * `npm run check:copies` tells you the two copies of a file disagree. It has
 * never told you how to make them agree, so the answer has always been a
 * `cp` typed by hand -- and `cp` is wrong for some of these files.
 *
 * `docs/QUICKSTART.md` links to `SEMANTICS.md`, which sits at
 * `packages/core/SEMANTICS.md` in the checkout and at the package ROOT in the
 * tarball. The same relative path cannot be correct in both, so the package
 * copy carries a declared rewrite: `../packages/core/SEMANTICS.md` becomes
 * `../SEMANTICS.md`. A plain `cp` destroys it. The file still looks right, the
 * bytes compare equal, and the link is broken for the one reader this project
 * claims to design for: an install with no browser.
 *
 * I did exactly that on 14 October 2026 while thinning the README, and
 * `check:links` and `check:install-reach` caught it. That was the fourth time
 * this quarter I had copied into `packages/core/` by hand and got it wrong.
 * AGENTS.md has said "change one, copy it to the other" the whole time. A rule
 * broken four times is not a rule, it is a note -- so this is the rule, as a
 * command that cannot forget the rewrite because it reads the same
 * declarations the gate does.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WILL NOT DO
 * ---------------------------------------------------------------------------
 *
 * It does not create the root file, stage anything, or invent a declaration.
 * A file in `COPIES` with no root original is reported and skipped: that is
 * either a deleted document or a typo, and guessing which one is how a tool
 * like this deletes somebody's work. Adding a new shipped file still means
 * writing down WHY it ships, in `tools/package-copies.mjs`, by hand.
 *
 * It is deliberately not part of `npm run verify`. A chain that silently
 * repairs what the next gate is about to check would make `check:copies`
 * incapable of failing, and a gate that cannot fail is the thing this
 * repository keeps finding in its own tooling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { COPIES, PKG_DIR, ROOT } from './package-copies.mjs';

const CHECK_ONLY = process.argv.includes('--check');

/** What the package copy of `file` must contain, rewrites applied. */
function intended(file, rewrite) {
  let text = readFileSync(join(ROOT, file), 'utf8');
  for (const [from, to] of rewrite ?? []) {
    if (!text.includes(from)) {
      return {
        error:
          `declares a rewrite whose pattern is not in the root file:\n      ${from}\n` +
          '    The source moved, or the rewrite is obsolete. Fix the declaration in\n' +
          '    tools/package-copies.mjs rather than writing a copy that silently stops\n' +
          '    being rewritten.',
      };
    }
    text = text.split(from).join(to);
  }
  return { text };
}

let written = 0;
let already = 0;
const problems = [];

for (const { file, rewrite } of COPIES) {
  const rootAbs = join(ROOT, file);
  const pkgAbs = join(ROOT, PKG_DIR, file);

  if (!existsSync(rootAbs)) {
    problems.push(
      `${file}\n    is declared in COPIES and does not exist at the repository root. Either it\n` +
        '    was deleted (remove its declaration, in the same commit) or the path is a\n' +
        '    typo. Not guessed at, and not written.',
    );
    continue;
  }

  const { text, error } = intended(file, rewrite);
  if (error) {
    problems.push(`${file}\n    ${error}`);
    continue;
  }

  const current = existsSync(pkgAbs) ? readFileSync(pkgAbs, 'utf8') : null;
  if (current === text) {
    already++;
    continue;
  }

  const how = rewrite ? ` (${rewrite.length} rewrite(s) applied)` : '';
  if (CHECK_ONLY) {
    console.log(`  would write  ${PKG_DIR}/${file}${how}`);
  } else {
    mkdirSync(dirname(pkgAbs), { recursive: true });
    writeFileSync(pkgAbs, text);
    console.log(`  wrote  ${PKG_DIR}/${file}${how}`);
  }
  written++;
}

if (problems.length > 0) {
  console.error(`\nsync-package-copies: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}\n`);
  process.exit(1);
}

const verb = CHECK_ONLY ? 'would update' : 'updated';
console.log(
  `sync-package-copies: ${verb} ${written} of ${COPIES.length} declared copy(s); ` +
    `${already} already current.` +
    (written > 0 && !CHECK_ONLY
      ? '\n  Stage them and run `npm run check:copies` -- this wrote files, it did not verify them.'
      : ''),
);
