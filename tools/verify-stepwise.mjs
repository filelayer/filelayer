#!/usr/bin/env node
/**
 * Run every step of `npm run verify`, one at a time, remembering the results.
 *
 *     node tools/verify-stepwise.mjs                # run what has not passed yet
 *     node tools/verify-stepwise.mjs --list         # just show the steps and state
 *     node tools/verify-stepwise.mjs --reset        # forget previous results
 *     node tools/verify-stepwise.mjs --budget 100   # seconds per step (default 100)
 *     node tools/verify-stepwise.mjs check:links    # run only matching steps
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Two things kept going wrong, and they have the same shape.
 *
 * `npm run verify` takes longer than some environments allow in one command. A
 * sandbox with a two-minute ceiling cannot run it at all, so the habit becomes
 * running a hand-typed list of the quick `check:*` gates instead. That list is
 * an enumeration, and the gate it leaves out is invisible: eighteen of them
 * passed, `typecheck` was not among them because it is not called `check:`
 * anything, and CI failed on `typecheck` across three Node versions. The same
 * defect this project has a rule about, committed against its own gate list.
 *
 * And a step that cannot finish inside the budget is not the same as a step
 * that fails. Conflating them means either pretending it passed or treating it
 * as broken; `check:suite-install` takes five minutes and has twice been the
 * only unrun gate on a commit that CI then rejected. Here a timeout is its own
 * outcome, reported as UNRUN, and never counted as a pass.
 *
 * The steps are DISCOVERED by parsing the `verify` script out of package.json,
 * so a gate added to `verify` is picked up here with no second list to update.
 * If `verify` stops being a simple `&&` chain this refuses rather than guessing.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, '.measured', 'verify-stepwise.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const budget = Number(
  argv.includes('--budget') ? argv[argv.indexOf('--budget') + 1] : 100,
);
const filters = argv.filter((a) => !a.startsWith('--') && a !== String(budget));

// -----------------------------------------------------------------------------
// Discover the steps.
// -----------------------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const verify = pkg.scripts?.verify;
if (!verify) {
  console.error('verify-stepwise: package.json has no `verify` script.');
  process.exit(2);
}

const steps = verify.split('&&').map((s) => s.trim());
const bad = steps.filter((s) => !/^npm run [\w:-]+$/.test(s));
if (bad.length > 0) {
  console.error(
    'verify-stepwise: `verify` is no longer a plain chain of `npm run <script>`\n' +
      'separated by `&&`. These parts were not understood:\n\n' +
      bad.map((b) => `  ${b}`).join('\n') +
      '\n\nRefusing to guess, because a step this tool silently dropped would be a\n' +
      'gate nobody ran. Teach it the new shape.',
  );
  process.exit(2);
}
const names = steps.map((s) => s.replace('npm run ', ''));

if (new Set(names).size !== names.length) {
  console.error('verify-stepwise: `verify` runs the same script twice; dedupe it first.');
  process.exit(2);
}

// -----------------------------------------------------------------------------
// State. Keyed by the git tree hash, so results are forgotten the moment
// anything in the working tree changes. A remembered pass against different
// code is worse than no memory at all.
// -----------------------------------------------------------------------------
let tree = 'unknown';
try {
  // The TREE of the stash commit, not the commit. `git stash create` makes a
  // fresh commit object with a timestamp, so its hash differs on every call and
  // the state was never once reused -- the first version of this file re-ran
  // every step each time and looked, from the outside, exactly like a tool that
  // was working. A tree hash is content-addressed: identical content, identical
  // hash.
  const stash = execFileSync('git', ['stash', 'create'], { cwd: ROOT, encoding: 'utf8' }).trim();
  tree = execFileSync('git', ['rev-parse', `${stash || 'HEAD'}^{tree}`], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
} catch {
  /* not a git repository, or git unavailable: fall through to 'unknown' */
}

let state = { tree, results: {} };
if (!flag('--reset') && existsSync(STATE)) {
  try {
    const prev = JSON.parse(readFileSync(STATE, 'utf8'));
    if (prev.tree === tree) state = prev;
  } catch {
    /* unreadable state is no state */
  }
}

const save = () => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`);
};

const MARK = { pass: 'pass ', fail: 'FAIL ', unrun: 'UNRUN' };

if (flag('--list')) {
  for (const n of names) {
    const r = state.results[n];
    console.log(`  ${r ? MARK[r.outcome] : '  -  '}  ${n}`);
  }
  console.log(`\n${names.length} step(s) in \`npm run verify\`.`);
  process.exit(0);
}

// -----------------------------------------------------------------------------
// Run.
// -----------------------------------------------------------------------------
let ran = 0;
for (const name of names) {
  if (filters.length > 0 && !filters.some((f) => name.includes(f))) continue;
  if (state.results[name]?.outcome === 'pass' && filters.length === 0) continue;

  process.stdout.write(`  ${name.padEnd(26, '.')} `);
  const started = Date.now();
  const r = spawnSync('npm', ['run', '--silent', name], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: budget * 1000,
    maxBuffer: 1 << 28,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  ran++;

  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  const outcome = timedOut ? 'unrun' : r.status === 0 ? 'pass' : 'fail';
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;

  state.results[name] = {
    outcome,
    seconds: Number(secs),
    ...(outcome === 'pass' ? {} : { tail: out.trim().split('\n').slice(-12).join('\n') }),
  };
  save();

  console.log(
    outcome === 'pass'
      ? `pass (${secs}s)`
      : outcome === 'unrun'
        ? `UNRUN: exceeded ${budget}s, so nothing was verified`
        : `FAILED (${secs}s)`,
  );
  if (outcome === 'fail') {
    console.error(`\n${state.results[name].tail.replace(/^/gm, '      ')}\n`);
  }
}

// -----------------------------------------------------------------------------
// Report.
// -----------------------------------------------------------------------------
const by = (o) => names.filter((n) => state.results[n]?.outcome === o);
const missing = names.filter((n) => !state.results[n]);

console.log(
  `\nverify-stepwise: ${by('pass').length} passed, ${by('fail').length} failed, ` +
    `${by('unrun').length} exceeded the budget, ${missing.length} not attempted ` +
    `(${names.length} steps, ${ran} run now).`,
);

if (by('unrun').length > 0 || missing.length > 0) {
  console.log(
    '\nNOT VERIFIED here, and not the same as passing:\n' +
      [...by('unrun'), ...missing].map((n) => `  ${n}`).join('\n') +
      '\nRun these somewhere with more time, or let CI be the authority and say so.',
  );
}

process.exit(by('fail').length > 0 ? 1 : 0);
