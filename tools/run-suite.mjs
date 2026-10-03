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
 * THE REPORTER IS PINNED, and the parser reads both formats anyway.
 *
 * This file shipped without `--test-reporter`, relying on Node's default, and
 * CI failed on the first run. Node's default is the spec reporter on some
 * versions and TAP on others: the sandbox this was written in emitted
 * `# tests 405` and the CI runner emitted `ℹ tests 405`, so a parser tested
 * locally could not have seen it. That is the third time a reporter format has
 * cost this repository a build -- a guard once looked for `# pass` in spec
 * output, found nothing, and passed a RED suite.
 *
 * So: `--test-reporter=tap` makes the format a decision rather than an
 * inherited default, and TOTALS below accepts either prefix in case something
 * in the environment overrides the flag. The patterns are anchored at the line
 * start and require the number, so a format this does not know about is a
 * failure here rather than a silence. `--self-test` checks both against
 * captured real output from both reporters.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages/core');

/**
 * `# tests 405` (tap) or `ℹ tests 405` (spec). Anchored, and the number is
 * required, so an unrecognised format produces no match and this file exits 1.
 */
const total = (out, label) => {
  const m = new RegExp(`^(?:# |\u2139 )${label} (\\d+)$`, 'm').exec(out);
  return m ? Number(m[1]) : null;
};

// --- self-test: both reporters, captured from real runs ---------------------
if (process.argv.includes('--self-test')) {
  const tap = '# tests 405\n# suites 100\n# pass 397\n# fail 0\n# skipped 8\n';
  // From the CI run that this flag exists because of:
  // https://github.com/filelayer/filelayer/actions/runs/37148075117
  const spec = 'ℹ tests 405\nℹ suites 100\nℹ pass 405\nℹ fail 0\nℹ skipped 0\n';
  const cases = [
    ['tap', tap, 405, 100, 397],
    ['spec', spec, 405, 100, 405],
    // Negative control: a format with no number must not parse as something.
    ['garbage', 'tests: many\npass: all\n', null, null, null],
  ];
  let bad = 0;
  for (const [name, text, tests, suites, pass] of cases) {
    const got = [total(text, 'tests'), total(text, 'suites'), total(text, 'pass')];
    const want = [tests, suites, pass];
    const ok = got.every((v, i) => v === want[i]);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(got)}`);
    if (!ok) bad++;
  }
  // And the flag is actually passed, which is the primary defence.
  const pinned = readFileSync(fileURLToPath(import.meta.url), 'utf8').includes(
    "'--test-reporter=tap'",
  );
  console.log(`${pinned ? 'PASS' : 'FAIL'}  the reporter is pinned in the spawn arguments`);
  if (!pinned) bad++;
  process.exit(bad ? 1 : 0);
}

const child = spawn(
  process.execPath,
  ['--test', '--test-reporter=tap', '--experimental-strip-types', 'test/*.test.ts'],
  { cwd: PKG, shell: true, stdio: ['ignore', 'pipe', 'inherit'] },
);

let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});

const code = await new Promise((r) => child.on('exit', r));

const counts = {
  tests: total(out, 'tests'),
  suites: total(out, 'suites'),
  pass: total(out, 'pass'),
  fail: total(out, 'fail'),
  skipped: total(out, 'skipped'),
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
