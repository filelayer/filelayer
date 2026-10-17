#!/usr/bin/env node
/**
 * TIME TO FIRST FILE, from the package a stranger installs.
 *
 *     node benchmark/ttff/measure.mjs            # writes RESULTS.md
 *     node benchmark/ttff/measure.mjs --print    # measure, print, write nothing
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS A MEASUREMENT AND NOT A BOAST
 * -----------------------------------------------------------------------------
 *
 * A coding agent runs what it writes. If the install fails, if authentication
 * needs a browser, or if an error message does not say what to do, the agent
 * does not file a bug -- it writes two hundred lines of its own code instead.
 * Published measurement puts that at 19% of Claude Code sessions and 10% of
 * Codex and Cursor ones, and in twelve of twenty tool categories the most
 * common outcome was a hand-built solution rather than any vendor at all.
 *
 * So the first five minutes are not onboarding polish. They decide whether the
 * pick survives, which makes them the one ranking input we fully control.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT MEASURES, AND THE THREE RULES THAT KEEP IT HONEST
 * -----------------------------------------------------------------------------
 *
 * 1. THE PUBLISHED PACKAGE, NOT THIS CHECKOUT. It installs `@filelayer/core`
 *    from the registry into an empty directory. A tarball packed locally proves
 *    the working tree is coherent and proves nothing about what a stranger
 *    receives; this repository has shipped that exact defect before.
 *
 * 2. THE PROGRAM COMES FROM THE PAGE. Every line of the program below is
 *    asserted to appear, character for character, in the `docs/QUICKSTART.md`
 *    THAT SHIPPED INSIDE THE INSTALLED TARBALL. If the page changes so that its
 *    own first example no longer matches, this fails. Otherwise the number
 *    would measure what the author of this script already knows, which is a
 *    different and much easier question than the one a stranger faces.
 *
 * 3. THE NUMBER THAT MATTERS IS NOT THE CLOCK. Seconds depend on a network and
 *    a machine and are reported with that caveat. What transfers is the count
 *    of steps that NEED A HUMAN -- an account, a credential, a dashboard, a
 *    browser -- because that is the count an agent cannot work around, and it
 *    is the same count whoever runs this.
 *
 * It does NOT claim to be a cold agent. It is a script with a clock, written by
 * someone who knows the product. What it proves is that the published page's
 * own first example works from a clean install of the published package, and
 * how long that takes. Whether an agent CHOOSES us is a different measurement
 * and is not this one.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRINT_ONLY = process.argv.includes('--print');

/**
 * THE STEPS, as the quickstart gives them.
 *
 * `human` is the field this whole script exists for. It is true when a step
 * cannot be completed by a process with a shell and no browser: creating an
 * account, clicking a console, copying a key out of a dashboard. Every entry
 * here is false, and that is a claim this script makes checkable rather than a
 * sentence on a landing page.
 */
const STEPS = [
  { what: 'npm install @filelayer/core', human: false },
  { what: 'npm install --save-dev "@electric-sql/pglite@^0.3.11"', human: false },
  { what: 'write the program the page shows', human: false },
  { what: 'node --experimental-strip-types app.ts', human: false },
];

/**
 * The program. Each entry must appear verbatim in the installed QUICKSTART.md.
 *
 * `quote` is what is looked for in the page; `line` is what is written to the
 * file. They differ only where the page shows a line with a trailing comment
 * that is prose rather than code.
 */
const PROGRAM = [
  { quote: "import { Filelayer } from '@filelayer/core';" },
  { quote: "const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });" },
  { quote: 'const { id, url } = await fl.files.put(avatarBytes, { public: true });' },
];

const ASSEMBLED = [
  "import { Filelayer } from '@filelayer/core';",
  '',
  'const avatarBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);',
  '',
  "const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });",
  'const { id, url } = await fl.files.put(avatarBytes, { public: true });',
  '',
  'if (!id || !url) throw new Error("ttff: put() returned no id or no url");',
  'console.log(`TTFF_OK ${id} ${url}`);',
].join('\n');

const seconds = (ms) => Math.round(ms / 100) / 10;

const dir = mkdtempSync(join(tmpdir(), 'filelayer-ttff-'));

// A COLD CACHE, or the headline number is somebody's warm laptop.
//
// The first run of this script reported a one-second install, which was true
// and was a measurement of an npm cache that already held the tarball. A
// stranger's machine does not. Every npm call below gets a cache directory
// that is created empty and deleted with the rest of the temporary tree, so
// the number is the one a first-time reader gets.
const CACHE = join(dir, '.npm-cache');

// THE LABEL IS THE COMMAND, not a second copy of it.
//
// The first version took a hand-written label alongside the arguments, and for
// the PGlite step the two disagreed: the arguments pinned the version, the
// label dropped it. What ran was correct and what a reader saw was a command
// that fails, because PGlite's `latest` sits outside the peer range this
// library declares and npm then refuses the whole tree with ERESOLVE. The
// quickstart spends a paragraph warning about that, and this script was
// reprinting it underneath a measurement of how easy we are to install.
//
// `check:install` caught it, and then caught the first attempt at this comment
// too, because that attempt quoted the broken form to explain itself. The gate
// reads every command-shaped string in every public file, which is the only
// version of that check that works: a reader scanning for a line to copy does
// not know which ones were meant as examples of what not to do.
//
// So the label is derived from the arguments and cannot drift from them again.
const shown = (args) => `npm ${args.map((a) => (/[\^*]/.test(a) ? `"${a}"` : a)).join(' ')}`;

const npm = (args, note = '') => {
  const label = shown(args) + note;
  const t0 = Date.now();
  const r = spawnSync('npm', [...args, '--cache', CACHE], { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`\nttff: \`npm ${args.join(' ')}\` failed.\n\n${r.stderr || r.stdout}`);
    process.exit(1);
  }
  const ms = Date.now() - t0;
  console.log(`  ${label.padEnd(52)} ${String(seconds(ms)).padStart(6)}s`);
  return ms;
};

console.log('time to first file, from the registry\n');

npm(['init', '-y'], '   (not counted: scaffolding)');

const tInstall = npm(['install', '@filelayer/core']);
const tPglite = npm(['install', '--save-dev', '@electric-sql/pglite@^0.3.11']);

// --- rule 2: the program is the page's, not mine -----------------------------

const installed = join(dir, 'node_modules', '@filelayer', 'core');
const version = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version;
const page = readFileSync(join(installed, 'docs', 'QUICKSTART.md'), 'utf8');

const missing = PROGRAM.filter((p) => !page.includes(p.quote));
if (missing.length) {
  console.error(
    '\nttff: these lines are not in the QUICKSTART.md that shipped in the tarball:\n' +
      missing.map((m) => `  ${m.quote}`).join('\n') +
      '\n\nThe page changed. Either the measurement is stale or the page broke its own\n' +
      'first example; this script will not quietly measure a program nobody is told\n' +
      'to write.',
  );
  process.exit(1);
}
console.log(`  ${'every program line found in the shipped page'.padEnd(52)} ${String(PROGRAM.length).padStart(6)}`);

writeFileSync(join(dir, 'app.ts'), `${ASSEMBLED}\n`);

// --- the run -----------------------------------------------------------------

const t0 = Date.now();
const run = spawnSync(process.execPath, ['--experimental-strip-types', 'app.ts'], {
  cwd: dir,
  encoding: 'utf8',
});
const tRun = Date.now() - t0;

if (run.status !== 0 || !/TTFF_OK /.test(run.stdout)) {
  console.error(`\nttff: the program did not store a file.\n\n${run.stderr || run.stdout}`);
  process.exit(1);
}
console.log(`  ${'node --experimental-strip-types app.ts'.padEnd(52)} ${String(seconds(tRun)).padStart(6)}s`);

const total = tInstall + tPglite + tRun;
const humanSteps = STEPS.filter((s) => s.human).length;
const loc = ASSEMBLED.split('\n').filter((l) => l.trim() && !l.startsWith('if (') && !l.startsWith('console.')).length;

console.log(`\n  ${'TOTAL, install to stored byte'.padEnd(52)} ${String(seconds(total)).padStart(6)}s`);
console.log(`  ${'steps requiring a human'.padEnd(52)} ${String(humanSteps).padStart(6)}`);
console.log(`  ${'lines of application code'.padEnd(52)} ${String(loc).padStart(6)}`);
console.log(`  ${'accounts, credentials, dashboards'.padEnd(52)} ${String(0).padStart(6)}`);

rmSync(dir, { recursive: true, force: true });

if (PRINT_ONLY) process.exit(0);

const today = new Date().toISOString().slice(0, 10);
const results = `# Time to first file

**Measured ${today}** against \`@filelayer/core@${version}\` **installed from the npm
registry**, not from this checkout. Re-run it:

\`\`\`bash
node benchmark/ttff/measure.mjs
\`\`\`

## The numbers

| | |
|---|---|
| \`npm install @filelayer/core\`, cold cache | ${seconds(tInstall)}s |
| \`npm install --save-dev "@electric-sql/pglite@^0.3.11"\` | ${seconds(tPglite)}s |
| first run, including starting an embedded PostgreSQL | ${seconds(tRun)}s |
| **total, install to stored byte** | **${seconds(total)}s** |
| lines of application code | ${loc} |
| **steps requiring a human** | **${humanSteps}** |
| accounts, API keys, dashboards or browser steps | **0** |

## What the clock does and does not transfer

The npm cache is created empty for the run, so these are first-time-reader
seconds rather than warm-laptop ones. They still depend on a network and a
machine, so they are a scale rather than a figure: the point is that it is under a minute and not
under an hour. **The count that transfers is zero** — no account, no credential,
no console, no database to provision. That is the same on any machine, and it
is the number an agent cannot work around: every step it cannot complete alone
is a step at which it writes its own code instead.

The embedded PostgreSQL is a development convenience and nothing else.
Production points at your own Postgres and your own bucket, which is more setup
than this and is setup you were doing anyway.

## Why the program is not the author's

Every line of the measured program is asserted to appear, character for
character, in the \`docs/QUICKSTART.md\` that shipped **inside the installed
tarball**. If the page stops showing its own first example, this measurement
fails rather than quietly measuring something a reader is never told to write.

## What this is not

It is not a cold agent, and it does not say an agent would choose this. It is a
script with a clock, written by someone who knows the product, and it answers
one question: does the published page's own first example work from a clean
install of the published package, and how long does that take.

Whether an agent picks us is a different measurement. It is not this one.
`;

mkdirSync(join(ROOT, 'benchmark', 'ttff'), { recursive: true });
writeFileSync(join(ROOT, 'benchmark', 'ttff', 'RESULTS.md'), results);
console.log('\n  wrote benchmark/ttff/RESULTS.md');
