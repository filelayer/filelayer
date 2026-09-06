#!/usr/bin/env node
/**
 * Fail the build if a documented install command does not work.
 *
 *   node tools/check-install-commands.mjs              # check, exit 1 on a hit
 *   node tools/check-install-commands.mjs --list       # every command found
 *   node tools/check-install-commands.mjs --self-test  # the negative control only
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT
 * -----------------------------------------------------------------------------
 *
 * 0.4.0 declared `@electric-sql/pglite` as an optional peer dependency at
 * `^0.3.11`, and told the reader to install it with a command that carried no
 * version at all. The package's `latest` on npm is a 0.5.x release, outside that
 * range. A developer who typed what we wrote could therefore end up with a
 * version the peer range does not admit, and npm refuses the whole tree:
 *
 *   npm error Could not resolve dependency:
 *   npm error peerOptional @electric-sql/pglite@"^0.3.11" from @filelayer/core@0.4.0
 *
 * That is a hard stop in the first minute, reached by following our own
 * instructions. The class of defect -- a documented command that does not run --
 * is invisible to every other check in this repository, because all of them read
 * the software rather than the sentences that tell a stranger how to start it.
 *
 * -----------------------------------------------------------------------------
 * WHAT IS CHECKED
 * -----------------------------------------------------------------------------
 *
 *   1. UNPINNED.   No tracked file contains an install command that names a
 *                  version-constrained package without a version constraint.
 *                  Every occurrence, in prose, in a fenced block, in a CI step,
 *                  in a string literal in the source.
 *
 *   2. RANGE.      Every constraint that IS written must denote exactly the
 *                  range `packages/core/package.json` declares for that package.
 *                  This is a semver comparison of intervals, not a string
 *                  compare, and it is deliberately two-directional: widening the
 *                  peer range without touching the docs fails here, and pinning
 *                  the docs somewhere the peer range does not admit fails here.
 *                  No network, no registry, no install.
 *
 *   3. VERBATIM.   The files a first user actually reads -- the README, the
 *                  quickstart, and the error message in `src/db.ts` -- each
 *                  contain the canonical command, character for character. If
 *                  they cannot agree with each other they cannot be trusted to
 *                  agree with the manifest.
 *
 *   4. MANIFEST.   `packages/core/package.json` still declares the package as an
 *                  OPTIONAL peer, still declares zero runtime dependencies, and
 *                  its own devDependency range sits inside the peer range.
 *
 * `tools/verify-release.mjs` reads `documentedInstallCommand()` from this file
 * and runs THAT STRING in its empty-directory test, rather than a command of its
 * own. A gate that types its own version of the instructions is not testing the
 * instructions.
 *
 * -----------------------------------------------------------------------------
 * THE NEGATIVE CONTROL
 * -----------------------------------------------------------------------------
 *
 * A checker that has never rejected anything is a green tick of unknown value.
 * `runNegativeControl()` feeds the detector a set of commands whose correct
 * classification is known -- including the exact unpinned command 0.4.0 shipped
 * -- and fails if any of them is classified wrongly. It runs on EVERY
 * invocation, before the real scan, so the scan's result is only reported by a
 * detector that has just demonstrated it can say no.
 *
 * Those fixtures are assembled at run time from `PKG` rather than written out as
 * literals. If the broken command appeared verbatim in this file, this file
 * would be a tracked file containing the very thing it forbids.
 *
 * -----------------------------------------------------------------------------
 * KNOWN LIMIT
 * -----------------------------------------------------------------------------
 *
 * Detection is line-based: an install command split across two lines with a
 * backslash continuation is not seen. That shape does not occur here and adding
 * it would trade a real increase in false positives for a hypothetical catch.
 * The limit is written down rather than left to be discovered.
 */

import { readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_PKG = 'packages/core/package.json';

/**
 * The packages whose install commands must carry a version.
 *
 * `rangeFrom` names the field in packages/core/package.json that is the single
 * source of truth for the range. Nothing in this file hard-codes a version.
 */
const POLICY = [{ pkg: '@electric-sql/pglite', rangeFrom: 'peerDependencies' }];

/** The files that must contain the canonical command exactly. */
const VERBATIM_IN = ['README.md', 'docs/QUICKSTART.md', 'packages/core/src/db.ts'];

/** Where the canonical command is read from. The first thing a stranger opens. */
const CANONICAL_SOURCE = 'README.md';

// -----------------------------------------------------------------------------
// A very small semver: enough for caret, tilde and exact pins, and loud about
// anything else. An unparseable range is a failure, never a pass -- a checker
// that shrugs at input it does not understand is worse than no checker.
// -----------------------------------------------------------------------------

/** `1.2.3` -> [1, 2, 3]. Pre-release and build metadata are dropped. */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * A range as a half-open interval `[min, max)`.
 *
 * Caret on a 0.x version is the case that matters here and the one people get
 * wrong: `^0.3.11` is `>=0.3.11 <0.4.0`, NOT `<1.0.0`. That is precisely why
 * 0.5.8 is outside the declared range.
 */
export function rangeInterval(range) {
  const r = String(range).trim();
  const bare = r.replace(/^[\^~]/, '');
  const v = parseVersion(bare);
  if (!v) return null;
  const [x, y, z] = v;
  if (r.startsWith('^')) {
    if (x > 0) return { min: v, max: [x + 1, 0, 0] };
    if (y > 0) return { min: v, max: [x, y + 1, 0] };
    return { min: v, max: [x, y, z + 1] };
  }
  if (r.startsWith('~')) return { min: v, max: [x, y + 1, 0] };
  return { min: v, max: [x, y, z + 1] }; // an exact pin
}

/** True when every version `a` admits is also admitted by `b`. */
export function rangeSubset(a, b) {
  const ia = rangeInterval(a);
  const ib = rangeInterval(b);
  if (!ia || !ib) return false;
  return cmp(ia.min, ib.min) >= 0 && cmp(ia.max, ib.max) <= 0;
}

/** True when the two ranges admit exactly the same versions. */
export function rangeEquivalent(a, b) {
  return rangeSubset(a, b) && rangeSubset(b, a);
}

/** True when a concrete version falls inside a range. */
export function satisfies(version, range) {
  const v = parseVersion(version);
  const i = rangeInterval(range);
  if (!v || !i) return false;
  return cmp(v, i.min) >= 0 && cmp(v, i.max) < 0;
}

// -----------------------------------------------------------------------------
// The detector.
// -----------------------------------------------------------------------------

/** An install verb, in the four package managers a reader might be using. */
const VERB = /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/g;

/**
 * Characters that end one shell command and begin another.
 *
 * A backtick is in the list because a Markdown code span is the documentary
 * form of the same boundary: in "`npm install @filelayer/core` also needs
 * `<package>`" the verb and the package name share a line but not a command,
 * and without this the sentence reads as an unversioned install.
 */
const COMMAND_BREAK = /[;&|`]/;

/**
 * A token that cannot be an argument to a package manager: it is prose that
 * happens to sit between a verb and a package name on the same line.
 */
const NOT_AN_ARGUMENT = /[(),!?:*]|\.\.|\.$/;

/**
 * Every install command in `text` that names `pkg`.
 *
 * Returns `{ line, command, range }`, where `range` is null when the command
 * carries no version constraint and `command` is the canonical rendering:
 * the verb, the flags in the order they were written, and the package spec in
 * double quotes. Canonicalising rather than slicing the raw text is what lets
 * the same command be recognised inside a fenced block, inside backticks in a
 * sentence, and inside a JavaScript string literal.
 */
export function findInstallCommands(text, pkg) {
  const out = [];
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    let at = -1;
    while ((at = line.indexOf(pkg, at + 1)) !== -1) {
      const after = line.slice(at + pkg.length);
      // A subpath import (`.../contrib/pgcrypto`) is not an install target.
      if (after.startsWith('/')) continue;

      // The nearest install verb to the left, with no command break between it
      // and the package name.
      VERB.lastIndex = 0;
      let verb = null;
      for (let m; (m = VERB.exec(line)); ) {
        if (m.index + m[0].length > at) break;
        verb = m;
      }
      if (!verb) continue;
      const between = line.slice(verb.index + verb[0].length, at);
      if (COMMAND_BREAK.test(between)) continue;

      const flags = between
        .split(/\s+/)
        .map((t) => t.replace(/["'`]/g, ''))
        .filter(Boolean);
      if (flags.some((t) => NOT_AN_ARGUMENT.test(t))) continue;

      const m = /^@([^\s"'`]+)/.exec(after);
      const range = m ? m[1] : null;
      const spec = range ? `"${pkg}@${range}"` : pkg;

      out.push({
        line: i + 1,
        range,
        command: [verb[0].replace(/\s+/g, ' '), ...flags, spec].join(' '),
      });
    }
  });
  return out;
}

// -----------------------------------------------------------------------------
// The negative control.
// -----------------------------------------------------------------------------

/**
 * Classify one command the way the checker would, given the declared range.
 * `unpinned` | `wrong-range` | `unparseable-range` | `ok`.
 */
export function classify(found, declaredRange) {
  if (found.range === null) return 'unpinned';
  if (!rangeInterval(found.range)) return 'unparseable-range';
  return rangeEquivalent(found.range, declaredRange) ? 'ok' : 'wrong-range';
}

/**
 * Prove the detector rejects what it claims to reject.
 *
 * Every fixture is built from `PKG` at run time, so that this file never itself
 * contains an unpinned install command. Returns a list of failures; empty means
 * the detector behaved.
 */
export function runNegativeControl(pkg, declaredRange) {
  const P = pkg;
  const interval = rangeInterval(declaredRange);
  if (!interval) {
    return { failures: [`the declared range "${declaredRange}" is not one this check can parse`], checked: 0 };
  }
  // The first version the declared range does NOT admit, as a caret range: for
  // `^0.3.11` that is `^0.4.0`, which is exactly the mistake 0.4.0's unversioned
  // command let a developer make.
  const above = '^' + interval.max.join('.');
  // An exact pin one version below the floor, when there is one.
  const [x, y, z] = interval.min;
  const below = z > 0 ? `${x}.${y}.${z - 1}` : y > 0 ? `${x}.${y - 1}.0` : x > 0 ? `${x - 1}.0.0` : null;

  const cases = [
    // The exact command 0.4.0 shipped, in the four shapes it was written in.
    { name: 'the 0.4.0 command, bare', text: `npm install --save-dev ${P}`, expect: 'unpinned' },
    { name: 'bare, short flags', text: `npm i -D ${P}`, expect: 'unpinned' },
    { name: 'bare, pnpm', text: `pnpm add -D ${P}`, expect: 'unpinned' },
    { name: 'bare, yarn', text: `yarn add --dev ${P}`, expect: 'unpinned' },
    { name: 'bare, bun', text: `bun add --dev ${P}`, expect: 'unpinned' },
    {
      name: 'bare, inside a fenced block',
      text: '```bash\nnpm install --save-dev ' + P + '\n```',
      expect: 'unpinned',
    },
    {
      name: 'bare, inside a sentence in backticks',
      text: 'Then run `npm install --save-dev ' + P + '` and you are done.',
      expect: 'unpinned',
    },
    {
      name: 'bare, inside a JavaScript string literal',
      text: `const cmd = 'npm install --save-dev ${P}';`,
      expect: 'unpinned',
    },
    { name: 'bare, inside a YAML run: step', text: `        run: npm install -D ${P}`, expect: 'unpinned' },
    // Pinned, but not where the manifest says. These two ranges are DERIVED
    // from the declared one rather than written down: a control with a
    // hard-coded "wrong" version stops being a control the day that version
    // becomes the right one, and it does so silently.
    { name: 'pinned above the declared range', text: `npm install -D "${P}@${above}"`, expect: 'wrong-range' },
    ...(below ? [{ name: 'pinned below the declared range', text: `npm install -D "${P}@${below}"`, expect: 'wrong-range' }] : []),
    { name: 'pinned to a dist-tag, not a version', text: `npm install -D "${P}@latest"`, expect: 'unparseable-range' },
    // The correct command, in the shapes it is written in.
    { name: 'the corrected command', text: `npm install --save-dev "${P}@${declaredRange}"`, expect: 'ok' },
    { name: 'the corrected command, unquoted', text: `npm install --save-dev ${P}@${declaredRange}`, expect: 'ok' },
  ];

  const failures = [];
  for (const c of cases) {
    const found = findInstallCommands(c.text, P);
    if (found.length !== 1) {
      failures.push(`${c.name}: expected 1 command, detector found ${found.length}`);
      continue;
    }
    const got = classify(found[0], declaredRange);
    if (got !== c.expect) failures.push(`${c.name}: expected "${c.expect}", detector said "${got}"`);
  }

  // The other half of a control: text that must NOT be read as an install
  // command. A detector that flags everything is as useless as one that flags
  // nothing, and it is the shape that gets a check deleted.
  const quiet = [
    { name: 'a manifest dependency line', text: `    "${P}": "^0.5.8",` },
    { name: 'an import statement', text: `import { PGlite } from '${P}';`},
    { name: 'a subpath import', text: `import { pgcrypto } from '${P}/contrib/pgcrypto';` },
    { name: 'prose naming the package', text: `The helper needs ${P} and says so.` },
    { name: 'a different command after a break', text: `npm install pg; node -e "require('${P}')"` },
    {
      // The shape that made this control worth writing: one line of prose, an
      // install command for a DIFFERENT package inside a code span, and the
      // package named again later as prose. Read naively it looks unversioned.
      name: 'an unrelated install command earlier in the same line of prose',
      text:
        '- **`npm install @filelayer/core` installs no runtime dependencies.** ' +
        'quickstart() additionally needs `' + P + '`, an optional peer dependency.',
    },
    {
      name: 'prose with the package name in a sentence after a verb',
      text: `To install it you need ${P} present, so npm install will report it.`,
    },
  ];
  for (const c of quiet) {
    const found = findInstallCommands(c.text, P);
    if (found.length !== 0) {
      failures.push(`${c.name}: must not be read as an install command, detector found ${found.length}`);
    }
  }

  return { failures, checked: cases.length + quiet.length };
}

// -----------------------------------------------------------------------------
// Repository state.
// -----------------------------------------------------------------------------

const corePkg = JSON.parse(readFileSync(join(ROOT, CORE_PKG), 'utf8'));

/** The declared range for one policy entry. Throws rather than defaulting. */
function declaredRangeFor(entry) {
  const range = corePkg[entry.rangeFrom]?.[entry.pkg];
  if (!range) {
    throw new Error(
      `${CORE_PKG} declares no "${entry.pkg}" in "${entry.rangeFrom}". ` +
        `That field is the source of truth for the documented install command.`,
    );
  }
  return range;
}

/** Tracked files worth reading: text, not enormous, not vendored. */
function trackedTextFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !f.includes('node_modules/'));

  return files.filter((rel) => {
    let st;
    try {
      st = statSync(join(ROOT, rel));
    } catch {
      return false; // deleted in the working tree
    }
    if (!st.isFile() || st.size > 4 * 1024 * 1024) return false;
    return !readFileSync(join(ROOT, rel)).subarray(0, 4096).includes(0);
  });
}

/**
 * The canonical command, read out of the README.
 *
 * Exported because `tools/verify-release.mjs` installs THIS STRING in its
 * empty-directory test. If the README and the gate can drift, the gate is not
 * testing the README.
 */
export function documentedInstallCommand(pkg = POLICY[0].pkg) {
  const text = readFileSync(join(ROOT, CANONICAL_SOURCE), 'utf8');
  const all = findInstallCommands(text, pkg);
  const found = all.filter((f) => f.range !== null);
  if (found.length === 0) {
    const bare = all.filter((f) => f.range === null);
    throw new Error(
      `${CANONICAL_SOURCE} contains no version-pinned install command for ${pkg}.` +
        (bare.length
          ? `\nIt gives an install command with no version constraint, at ` +
            bare.map((f) => `${CANONICAL_SOURCE}:${f.line}`).join(', ') +
            `:\n  ${bare[0].command}\n` +
            `That is the 0.4.0 defect. Run \`npm run check:install\` for the detail.`
          : ` The release gate reads the command from there; there is nothing to read.`),
    );
  }
  const distinct = [...new Set(found.map((f) => f.command))];
  if (distinct.length > 1) {
    throw new Error(
      `${CANONICAL_SOURCE} gives ${distinct.length} different install commands for ${pkg}:\n` +
        distinct.map((c) => '  ' + c).join('\n'),
    );
  }
  return distinct[0];
}

/** Split a command into argv, honouring one level of quoting. */
export function shellWords(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m; (m = re.exec(command)); ) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// -----------------------------------------------------------------------------
// CLI
// -----------------------------------------------------------------------------

function main(argv) {
  const listOnly = argv.includes('--list');
  const selfTestOnly = argv.includes('--self-test');
  const problems = [];
  const all = [];

  // --- the negative control, first, always ----------------------------------
  let controlled = 0;
  for (const entry of POLICY) {
    const declared = declaredRangeFor(entry);
    const { failures, checked } = runNegativeControl(entry.pkg, declared);
    controlled += checked;
    if (failures.length) {
      console.error('\ncheck-install-commands: THE DETECTOR IS BROKEN\n');
      console.error(
        'The negative control failed, so nothing this check says about the repository\n' +
          'means anything. Fix findInstallCommands()/classify() before reading further.\n',
      );
      for (const f of failures) console.error('  ' + f);
      console.error('');
      process.exit(2);
    }
  }
  console.log(`check-install-commands: negative control passed (${controlled} cases).`);
  if (selfTestOnly) process.exit(0);

  // --- 1 + 2: every install command in every tracked file -------------------
  const files = trackedTextFiles();
  for (const entry of POLICY) {
    const declared = declaredRangeFor(entry);
    for (const rel of files) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      if (!text.includes(entry.pkg)) continue;
      for (const found of findInstallCommands(text, entry.pkg)) {
        const verdict = classify(found, declared);
        all.push({ rel, ...found, verdict, declared, pkg: entry.pkg });
        if (verdict === 'ok') continue;
        problems.push({
          where: `${rel}:${found.line}`,
          what: found.command,
          why:
            verdict === 'unpinned'
              ? `no version constraint. ${CORE_PKG} declares "${entry.pkg}" at ` +
                `"${declared}" (${entry.rangeFrom}), and the package's "latest" on npm is ` +
                `outside it, so this command can install a version the peer range does not ` +
                `admit and npm then refuses the tree with ERESOLVE.`
              : verdict === 'unparseable-range'
                ? `"${found.range}" is not a version range this check can evaluate. A ` +
                  `dist-tag moves; a documented install command must not.`
                : `pinned at "${found.range}", but ${CORE_PKG} declares "${declared}" ` +
                  `(${entry.rangeFrom}). The two must denote the same versions: if the ` +
                  `supported range moved, this command has to move with it, and if it did ` +
                  `not move, this command is wrong.`,
        });
      }
    }
  }

  if (listOnly) {
    for (const f of all) {
      console.log(`  ${f.verdict.padEnd(18)} ${f.rel}:${f.line}\n${' '.repeat(21)}${f.command}`);
    }
    console.log(`\n${all.length} install command(s) across ${files.length} tracked file(s).`);
    process.exit(problems.length ? 1 : 0);
  }

  // --- 3: the files a first user reads say the same thing --------------------
  let canonical = null;
  try {
    canonical = documentedInstallCommand();
  } catch (e) {
    problems.push({ where: CANONICAL_SOURCE, what: '(no command found)', why: e.message });
  }
  if (canonical) {
    for (const rel of VERBATIM_IN) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      if (!text.includes(canonical)) {
        problems.push({
          where: rel,
          what: canonical,
          why:
            `does not appear here, character for character. ${CANONICAL_SOURCE}, the ` +
            `quickstart and the error a caller actually sees have to be one instruction; ` +
            `the release gate runs the one in ${CANONICAL_SOURCE}.`,
        });
      }
    }
  }

  // --- 4: the manifest still says what the command assumes -------------------
  const runtimeDeps = Object.keys(corePkg.dependencies ?? {});
  if (runtimeDeps.length) {
    problems.push({
      where: CORE_PKG,
      what: runtimeDeps.join(', '),
      why: 'the package declares runtime dependencies; it is supposed to declare none.',
    });
  }
  for (const entry of POLICY) {
    const declared = declaredRangeFor(entry);
    if (corePkg.peerDependenciesMeta?.[entry.pkg]?.optional !== true) {
      problems.push({
        where: CORE_PKG,
        what: entry.pkg,
        why: 'is not marked optional in peerDependenciesMeta, so a consumer who never calls the test helper is warned about a package they do not need.',
      });
    }
    const dev = corePkg.devDependencies?.[entry.pkg];
    if (dev && !rangeSubset(dev, declared)) {
      problems.push({
        where: CORE_PKG,
        what: `devDependencies.${entry.pkg} = "${dev}"`,
        why: `is outside the declared ${entry.rangeFrom} range "${declared}", so the suite runs against a version the package does not claim to support.`,
      });
    }
  }

  if (problems.length === 0) {
    const pinned = all.filter((f) => f.verdict === 'ok').length;
    console.log(
      `check-install-commands: clean. ${pinned} install command(s) in ${files.length} ` +
        `tracked file(s), every one version-constrained to the declared range.`,
    );
    for (const entry of POLICY) {
      console.log(`  ${entry.pkg}  ${entry.rangeFrom} ${declaredRangeFor(entry)}`);
    }
    if (canonical) console.log(`  documented command: ${canonical}`);
    process.exit(0);
  }

  console.error('\ncheck-install-commands: FAILED\n');
  console.error(
    'A command this repository tells a developer to run does not do what the\n' +
      'manifest says it does. Fix the command, or fix the manifest -- but not\n' +
      'neither, because the first person to follow the instructions finds out.\n',
  );
  for (const p of problems) {
    console.error(`  ${p.where}`);
    console.error(`    ${p.what}`);
    console.error(`      ${p.why}`);
    console.error('');
  }
  console.error(`${problems.length} problem(s).\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
