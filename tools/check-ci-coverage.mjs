#!/usr/bin/env node
/**
 * EVERY GATE IN `npm run verify` HAS A STEP IN THE WORKFLOW.
 *
 *   node tools/check-ci-coverage.mjs
 *   node tools/check-ci-coverage.mjs --self-test
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * `.github/workflows/ci.yml` names every gate by hand. It already carries a
 * comment recording what that costs: six gates were written, wired into
 * `npm run verify`, and left out of the workflow, so for weeks they ran only on
 * the machine of whoever remembered to type `npm run verify` -- and the point of
 * a gate is to run on the commits nobody was worried about.
 *
 * On 5 October 2026 it happened again, twice, in the same session that fixed
 * four other instances of the same shape. `check:guides` went out in a commit
 * CI reported green, having never executed it. `check:suite-install` would have
 * gone out the same way an hour later.
 *
 * A comment describing a trap does not stop anybody walking into it. So this
 * reads the verify chain out of `package.json`, reads the workflow, and refuses
 * the build when something in the first has no step in the second.
 *
 * REGISTRATION IS NOT COVERAGE, one level up: every other gate here asks
 * whether a claim in a document is true, and none of them asked whether the
 * gates themselves are wired to anything. This is the gate that watches the
 * list of gates, and it is in the workflow too, so it checks itself.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const WORKFLOW = '.github/workflows/ci.yml';

/**
 * Scripts the workflow runs some other way. Each needs a reason and the
 * command the workflow actually uses, which is checked for, so this cannot
 * become a place to park things that stopped running.
 */
const RUN_DIFFERENTLY = {
  adversarial: {
    runs: 'node benchmark/adversarial/run.mjs filelayer',
    why: 'it is a separate job with its own matrix, not a step in the gates job.',
  },
  typecheck: { runs: 'npm run typecheck', why: 'run under its own step name.' },
  build: { runs: 'npm run build', why: 'run as part of the publish-shape checks.' },
  'test:counted': {
    runs: 'tools/run-suite.mjs',
    why: 'CI runs the suite through the Node version matrix rather than this wrapper.',
  },
};

function gatesInVerify(pkg) {
  return pkg.scripts.verify
    .split('&&')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('npm run '))
    .map((s) => s.slice('npm run '.length).trim());
}

function missing(gates, workflow) {
  const out = [];
  for (const g of gates) {
    if (new RegExp(`npm run ${g.replace(/[:]/g, '[:]')}(\\s|$)`, 'm').test(workflow)) continue;
    const alt = RUN_DIFFERENTLY[g];
    if (alt && workflow.includes(alt.runs)) continue;
    out.push(
      alt
        ? `${g}: declared as run differently (${alt.why}) but the workflow does not contain ` +
          `\`${alt.runs}\`. Either the workflow changed or the declaration is stale.`
        : `${g}: is in \`npm run verify\` and has no step in ${WORKFLOW}. It runs only for ` +
          'whoever types `npm run verify`, which is nobody on the commits that matter.\n' +
          '      Add a step, or declare it in RUN_DIFFERENTLY with the command CI uses and why.',
    );
  }
  return out;
}

// --- controls ---------------------------------------------------------------
const CONTROLS = [
  {
    name: 'a gate absent from the workflow is reported',
    ok: () => missing(['check:invented'], 'jobs:\n  steps:\n    - run: npm run check:links\n').length === 1,
  },
  {
    name: 'a gate present in the workflow is not reported',
    ok: () => missing(['check:links'], '    - run: npm run check:links\n').length === 0,
  },
  {
    name: 'a prefix is not mistaken for the whole name',
    ok: () => missing(['check:web-samples'], '    - run: npm run check:web\n').length === 1,
  },
  {
    name: 'a RUN_DIFFERENTLY entry whose command is gone is reported',
    ok: () => missing(['adversarial'], 'nothing like it here').length === 1,
  },
];

const bad = CONTROLS.filter((c) => {
  try {
    return !c.ok();
  } catch {
    return true;
  }
}).map((c) => c.name);

if (process.argv.includes('--self-test')) {
  if (bad.length) {
    console.error(`controls DID NOT behave:\n  - ${bad.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`check-ci-coverage: ${CONTROLS.length} controls correct.`);
  process.exit(0);
}

// --- the run ----------------------------------------------------------------
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const workflow = readFileSync(join(ROOT, WORKFLOW), 'utf8');
const gates = gatesInVerify(pkg);
const problems = [...bad.map((b) => `this gate's own control failed: ${b}`), ...missing(gates, workflow)];

if (problems.length) {
  console.error(`\ncheck-ci-coverage: FAILED\n\n${problems.map((p) => `  - ${p}`).join('\n\n')}\n`);
  process.exit(1);
}

console.log(
  `check-ci-coverage: clean. All ${gates.length} gate(s) in \`npm run verify\` have a step in ` +
    `${WORKFLOW} (${Object.keys(RUN_DIFFERENTLY).length} declared as run differently); ` +
    `${CONTROLS.length} controls correct.`,
);
