#!/usr/bin/env node
/**
 * RUNS THE TEST SUITE AND RECORDS WHAT IT ACTUALLY COUNTED.
 *
 * WHY THIS EXISTS. `check-version-claims` compared the test counts on the
 * public surfaces WITH EACH OTHER and never with a test run. On 3 October 2026
 * the suite ran 397 tests across 105 suites while TRUST.md,
 * ARCHITECTURE-PROGRESSIVE.md (three places) and PUBLISH-RUNBOOK.md all said
 * 375 across 94 -- and the gate reported clean, because they agreed. Four
 * public surfaces carried the same wrong number and the check whose job was
 * exactly this could not see it: consistency is not accuracy.
 *
 * So the number now comes from a run. This wrapper executes the suite, streams
 * its output through unchanged, and writes the TAP totals to
 * `.measured/suite-counts.json`. `check-version-claims` reads that file and
 * FAILS if it is missing or stale, rather than quietly checking less.
 *
 * TAP, not the spec reporter, and the parse is `/^# tests (\d+)$/m`. The
 * reporter formats are not interchangeable: a guard in CI once looked for
 * `# pass` in spec output, found nothing, and passed a red suite. Anchoring on
 * the line start and requiring the number is what makes a format change a
 * failure here rather than a silence.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages/core');

const child = spawn(
  process.execPath,
  ['--test', '--experimental-strip-types', 'test/*.test.ts'],
  { cwd: PKG, shell: true, stdio: ['ignore', 'pipe', 'inherit'] },
);

let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});

const code = await new Promise((r) => child.on('exit', r));

const num = (label) => {
  const m = new RegExp(`^# ${label} (\\d+)$`, 'm').exec(out);
  return m ? Number(m[1]) : null;
};
const counts = {
  tests: num('tests'),
  suites: num('suites'),
  pass: num('pass'),
  fail: num('fail'),
  skipped: num('skipped'),
  at: new Date().toISOString(),
};

if (counts.tests === null || counts.suites === null || counts.pass === null) {
  console.error(
    '\nrun-suite: could not parse the TAP totals out of the run, so no counts were\n' +
      'recorded. The reporter format has changed; fix the patterns in this file.\n',
  );
  process.exit(1);
}

mkdirSync(join(ROOT, '.measured'), { recursive: true });
writeFileSync(join(ROOT, '.measured/suite-counts.json'), `${JSON.stringify(counts, null, 2)}\n`);
console.log(
  `\nrun-suite: recorded ${counts.tests} test(s) across ${counts.suites} suite(s), ` +
    `${counts.pass} passing, ${counts.fail} failing, ${counts.skipped} skipped.`,
);

// A red suite stays red. The counts are recorded either way, because a gate
// that cannot read the counts of a failing run tells you the wrong thing about
// why it failed.
process.exit(code ?? 1);
