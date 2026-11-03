#!/usr/bin/env node
/**
 * EVERY NUMBER IN THIS DIRECTORY, FROM A FRESH CLONE, IN ONE COMMAND.
 *
 *     node benchmark/run.mjs                 # install, measure, write RESULTS.md
 *     node benchmark/run.mjs --no-install    # reuse the node_modules already here
 *     node benchmark/run.mjs --print         # measure and print; write nothing
 *
 * What it runs, in order, and what each one measures:
 *
 *   1. npm ci in benchmark/, benchmark/baseline-supabase/ and
 *      benchmark/baseline-raw-s3/. benchmark/package.json pins the
 *      @filelayer/core under test to one published version, so the Filelayer
 *      numbers are about what npm serves, not about this checkout.
 *   2. count-loc.mjs --published: application lines per implementation, one
 *      counter, rules in loc.manifest.json.
 *   3. count-decisions.mjs: security-sensitive decisions per implementation,
 *      summed from decisions.json.
 *   4. count-tiers.mjs --published: lines per tier, from the examples that ship
 *      in the published tarball.
 *   5. adversarial/run.mjs --published: 26 attacks against every implementation
 *      that can be executed. Writes adversarial/RESULTS.md.
 *   6. ttff/measure.mjs --print: install to first stored file, from the npm
 *      registry. This is the one step that needs the network beyond npm ci.
 *
 * No account, no credential and no environment variable is needed. Nothing here
 * talks to a cloud service: the Supabase implementation runs on PGlite with the
 * platform schema emulated, and the raw-S3 one against a local store that
 * verifies SigV4. Two implementations (Convex, Vercel Blob) have no executable
 * form and are reported as not run, never as passing.
 *
 * Exit code: non-zero if any step fails to run, or if any executed
 * implementation reports an error rather than a verdict. A BREACH in a
 * comparison implementation is a result, not a failure of this script.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const INSTALL = !args.includes('--no-install');
const PRINT = args.includes('--print');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`Node >= 22.18 is required (TypeScript type stripping); this is ${process.version}.`);
  process.exit(2);
}

function run(label, cmd, argv, { cwd = HERE, okCodes = [0] } = {}) {
  process.stdout.write(`\n== ${label}\n`);
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
  const out = `${r.stdout ?? ''}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
  if (r.error || !okCodes.includes(r.status)) {
    console.error(out.split('\n').slice(-30).join('\n'));
    console.error(`\n${label}: failed (exit ${r.status ?? r.error?.message}).`);
    process.exit(1);
  }
  return r.stdout.trim();
}

if (INSTALL) {
  for (const dir of ['.', 'baseline-supabase', 'baseline-raw-s3']) {
    run(`npm ci in benchmark/${dir === '.' ? '' : `${dir}/`}`, 'npm', ['ci', '--no-audit', '--no-fund'], {
      cwd: join(HERE, dir),
    });
  }
}

const pkgDir = dirname(createRequire(join(HERE, 'package.json')).resolve('@filelayer/core/package.json'));
const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version;
console.log(`\n@filelayer/core under test: ${version}, from npm`);

const node = process.execPath;
const loc = run('application lines of code', node, [join(HERE, 'count-loc.mjs'), '--published']);
const decisions = run('security-sensitive decisions', node, [join(HERE, 'count-decisions.mjs')]);
const tiers = run('lines per tier', node, [join(HERE, 'count-tiers.mjs'), '--published']);
// Exit 1 here means a comparison implementation was breached, which is a result.
const adversarial = run(
  'shared adversarial suite',
  node,
  ['--experimental-strip-types', join(HERE, 'adversarial', 'run.mjs'), '--published', '--md'],
  { okCodes: [0, 1] },
);
const errored = [...adversarial.matchAll(/^\| \S+ \| .*$/gm)].some((m) => /\| ERROR \|/.test(m[0]));
if (errored || !adversarial.includes('| filelayer |')) {
  console.error(adversarial);
  console.error('\nshared adversarial suite: an implementation reported an error instead of a verdict.');
  process.exit(1);
}
const ttff = run('time to first file, from the registry', node, [join(HERE, 'ttff', 'measure.mjs'), '--print']);

const fence = (s) => `\`\`\`\n${s}\n\`\`\``;
const section = (text, from, to) => {
  const i = text.indexOf(from);
  const j = text.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error(`adversarial/run.mjs --md no longer prints "${from}" before "${to}"`);
  return text.slice(i, j).trim();
};
const today = new Date().toISOString().slice(0, 10);
const report = [
  '# Results',
  '',
  `Generated by \`node benchmark/run.mjs\` on ${today}, Node ${process.version}, ${process.platform}-${process.arch}.`,
  `Filelayer is \`@filelayer/core@${version}\` as installed from npm (pinned in \`benchmark/package.json\`).`,
  'Seconds depend on the machine and the network; every other figure is the same on any machine.',
  '',
  '## Application lines of code',
  '',
  fence(loc),
  '',
  '## Security-sensitive decisions',
  '',
  fence(decisions),
  '',
  '## Lines per tier',
  '',
  fence(tiers),
  '',
  '## Shared adversarial suite',
  '',
  'The full matrix, with every attack, is in [`adversarial/RESULTS.md`](adversarial/RESULTS.md).',
  '',
  section(adversarial, '## The ', '## Tallies over every').replace(/^## /gm, '### '),
  '',
  '## Time to first file',
  '',
  fence(ttff),
  '',
].join('\n');

if (PRINT) {
  console.log(`\n${report}`);
} else {
  writeFileSync(join(HERE, 'adversarial', 'RESULTS.md'), `${adversarial}\n`);
  writeFileSync(join(HERE, 'RESULTS.md'), report);
  console.log('\nwrote benchmark/RESULTS.md and benchmark/adversarial/RESULTS.md');
}
