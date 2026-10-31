#!/usr/bin/env node
/**
 * WHAT THE TARBALL MUST NOT CARRY, read from what npm would actually pack.
 *
 *     node tools/check-tarball-excludes.mjs
 *     node tools/check-tarball-excludes.mjs --self-test
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * `packages/core/skills/*\/evals/` is grading material: the scenarios the skill
 * was measured on and the write-up of that measurement. An installed skill
 * never reads it. It shipped anyway, because `files` named `skills` as a whole
 * directory, and on 31 October 2026 the only page about this project that we
 * did not write was an automated scanner issue (aryan2621/antidote#768) rating
 * the tarball "high" for prompt-injection-like text under `skills/`. Scenario
 * files are, by construction, text written to look like instructions to an
 * agent. They stay in the repository, where they are linked from
 * docs/AGENT-SKILL.md and llms.txt, and leave the tarball.
 *
 * This reads `npm pack --dry-run`, not `files`: a declaration is what we meant
 * and the pack list is what a stranger receives (D020).
 *
 * IT ALSO REQUIRES THE SKILL ITSELF TO SHIP. An exclusion that removed the
 * whole `skills/` directory would pass a check that only looked for `evals/`,
 * and the shipped skill is a product surface (D019). So each skill's SKILL.md
 * must be in the pack list too.
 *
 * Seen failing before it was trusted: run against the 0.34.0 tree with
 * `"skills"` still in `files`, it named both evals files and exited 1.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages', 'core');

// A path segment named exactly `evals`, at any depth. `evaluating.md` or an
// `evaluations/` directory are different names and are not matched.
const FORBIDDEN = [
  { re: /(^|\/)evals(\/|$)/, why: 'skill grading material; not read by an installed skill' },
];

export function judge(paths, requiredSkills) {
  const problems = [];
  if (paths.length === 0) {
    problems.push('npm pack listed no files, so nothing was checked');
    return problems;
  }
  for (const p of paths) {
    for (const { re, why } of FORBIDDEN) {
      if (re.test(p)) problems.push(`${p}: must not ship (${why})`);
    }
  }
  const set = new Set(paths);
  for (const name of requiredSkills) {
    const want = `skills/${name}/SKILL.md`;
    if (!set.has(want)) problems.push(`${want}: missing from the tarball; the exclusion removed the skill itself`);
  }
  return problems;
}

function selfTest() {
  const cases = [
    { name: 'planted evals file', paths: ['skills/a/SKILL.md', 'skills/a/evals/evals.json'], skills: ['a'], fails: true },
    { name: 'evals at the package root', paths: ['skills/a/SKILL.md', 'evals/x.md'], skills: ['a'], fails: true },
    { name: 'evals directory entry alone', paths: ['skills/a/SKILL.md', 'skills/a/evals'], skills: ['a'], fails: true },
    { name: 'skill dropped entirely', paths: ['dist/index.js'], skills: ['a'], fails: true },
    { name: 'empty pack list', paths: [], skills: [], fails: true },
    { name: 'similar names are allowed', paths: ['skills/a/SKILL.md', 'docs/evaluating.md', 'skills/a/evaluations/x.md'], skills: ['a'], fails: false },
    { name: 'clean', paths: ['skills/a/SKILL.md', 'skills/a/references/x.md'], skills: ['a'], fails: false },
  ];
  let bad = 0;
  for (const c of cases) {
    const failed = judge(c.paths, c.skills).length > 0;
    const ok = failed === c.fails;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name} (expected ${c.fails ? 'refusal' : 'pass'})`);
  }
  console.log(`check-tarball-excludes --self-test: ${cases.length - bad}/${cases.length} controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

if (process.argv.includes('--self-test')) selfTest();

const skillsDir = join(PKG, 'skills');
const requiredSkills = existsSync(skillsDir)
  ? readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

let paths;
try {
  // --ignore-scripts: `prepack` only compiles dist/, which does not decide
  // what is excluded, and this gate should not rebuild as a side effect.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: PKG,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  paths = JSON.parse(out)[0].files.map((f) => f.path);
} catch (e) {
  console.error(`check-tarball-excludes: FAILED\n\n  - npm pack --dry-run failed, so nothing was checked: ${e.message}`);
  process.exit(1);
}

const problems = judge(paths, requiredSkills);
if (problems.length) {
  console.error('check-tarball-excludes: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n  Fix `files` in packages/core/package.json: exclude with a "!" entry, never by');
  console.error('  dropping the directory that contains it. Then re-run.');
  process.exit(1);
}
console.log(`check-tarball-excludes: clean (${paths.length} packed files; no evals/; ${requiredSkills.length} skill(s) present)`);
