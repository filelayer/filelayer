#!/usr/bin/env node
/**
 * Run the controls that the publish guards carry, and count them.
 *
 *     node tools/check-publish-guards.mjs
 *     node tools/check-publish-guards.mjs --self-test
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *
 * `tools/refuse-unverified-publish.mjs` has carried a `--self-test` since the
 * day it was written. Nothing ran it. Not `verify`, not CI, not a test file --
 * a grep on 13 October 2026 found it referenced from its own source and
 * nowhere else. It was written in the same hour as the guard it protects, and
 * it has never been executed by anything but a human typing it once.
 *
 * That is the shape this project keeps finding: the apparatus that checks the
 * product is itself unchecked. A control nobody runs cannot fail, so it cannot
 * tell you anything, and it will quietly stop matching the code it guards --
 * which is strictly worse than having no control, because the file still says
 * `--self-test` and reading that is reassuring.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT COUNTS THEM
 * ---------------------------------------------------------------------------
 *
 * Running the self-tests and checking they exit 0 would pass against a
 * `--self-test` that had been gutted to `process.exit(0)`. Registration is not
 * coverage: the breadth has to be asserted, not assumed.
 *
 * So each guard declares how many controls it must have, and the gate fails if
 * it finds fewer. Deleting a control is then a failing build rather than a
 * quieter one. The floors are minimums, so adding controls needs no edit here;
 * removing one does, which is the point -- the edit is where somebody has to
 * write down why.
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each guard, its self-test, and the number of controls it must still have.
 *
 * `floor` is the count as of the last time somebody looked. `pattern` pulls the
 * count out of the output, so a self-test that stops reporting one is also a
 * failure -- silence is not a pass.
 */
const GUARDS = [
  {
    script: 'tools/refuse-unverified-publish.mjs',
    what: 'refuses an upload whose tree was not verified',
    // One control: a stamp from a different tree must be refused. That is the
    // only failure mode that matters for a content-addressed stamp, and the
    // one a date-based or boolean stamp would get wrong.
    floor: 1,
    pattern: /control passed/,
    counts: (out) => (/control passed/.test(out) ? 1 : 0),
  },
  {
    script: 'tools/is-published.mjs',
    what: 'answers "is this version on npm?" without mistaking lag for absence',
    // Eight as written on 13 October: six classification cases plus the two
    // lag-window boundary checks.
    floor: 8,
    pattern: /(\d+) controls correct/,
    counts: (out) => Number(out.match(/(\d+) controls correct/)?.[1] ?? 0),
  },
];

if (process.argv.includes('--self-test')) {
  // The control for the gate itself, BEFORE it runs anything: a self-test that
  // exits 0 and says nothing must be rejected, because that is exactly what a
  // gutted one looks like. Placed first because a `--self-test` that also did
  // the real work would be two things, which is the defect `verified-stamp.mjs`
  // was split out to fix.
  const silent = GUARDS[1].pattern.test('all good!\n');
  console.log(
    silent
      ? 'check-publish-guards: control DID NOT FAIL: a silent self-test was accepted.'
      : 'check-publish-guards: control passed (a self-test reporting no count is rejected).',
  );
  process.exit(silent ? 1 : 0);
}

let failed = 0;
const lines = [];

for (const guard of GUARDS) {
  let out;
  try {
    out = execFileSync('node', [join(ROOT, guard.script), '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error(
      `check-publish-guards: ${guard.script} --self-test FAILED (exit ${err.status}).\n` +
        `  This guard ${guard.what}.\n` +
        `${(err.stdout ?? '') + (err.stderr ?? '')}`,
    );
    failed++;
    continue;
  }

  if (!guard.pattern.test(out)) {
    console.error(
      `check-publish-guards: ${guard.script} --self-test exited 0 but reported no\n` +
        `  control count. A self-test that passes silently is indistinguishable from\n` +
        `  one that was gutted to \`process.exit(0)\`.\n\n${out}`,
    );
    failed++;
    continue;
  }

  const n = guard.counts(out);
  if (n < guard.floor) {
    console.error(
      `check-publish-guards: ${guard.script} now has ${n} control(s), down from\n` +
        `  ${guard.floor}. A control was removed. If that is deliberate, lower the floor\n` +
        '  in this file and say why in the commit -- the edit is the record.',
    );
    failed++;
    continue;
  }

  lines.push(`  ${guard.script}: ${n} control(s) (floor ${guard.floor})`);
}

if (failed > 0) process.exit(1);

console.log(
  `check-publish-guards: clean. ${GUARDS.length} publish guard(s), controls run and counted.\n` +
    lines.join('\n'),
);
