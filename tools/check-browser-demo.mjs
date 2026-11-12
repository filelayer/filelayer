#!/usr/bin/env node
/**
 * THE IN-BROWSER DEMO SAYS WHAT IT DOES, ON THE VERSION IT NAMES.
 *
 *     npm run check:browser-demo
 *     node tools/check-browser-demo.mjs --self-test
 *
 * examples/in-the-browser is what a reader opens from the "Open in StackBlitz"
 * button. Three things about it can go stale without anything failing, and
 * this check holds each:
 *
 *   1. THE PIN. Its package.json pins @filelayer/core to one exact version,
 *      because StackBlitz installs from npm. That version must be the one in
 *      packages/core/package.json: bump-version rewrites both together, and
 *      this is what notices if it did not.
 *   2. THE OUTPUT. The README prints what the demo prints, so a reader sees the
 *      result without waiting for the install. The demo is run here, against
 *      the PACKED tarball (at release time the pinned version is not on npm
 *      yet), and its output must equal the README's block line by line. Only
 *      the file id, the link secret and the timestamps are normalized, because
 *      they differ on every run.
 *   3. THE RESULT. Steps 4 and 7 must be refusals and step 9 a valid chain; a
 *      demo that printed "ALLOWED" would otherwise be copied into the README by
 *      the next person to refresh it.
 *
 * --self-test plants a wrong pin, an edited README line, and a demo that
 * skips the revoke, and requires each to be refused.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const DEMO = join(ROOT, 'examples', 'in-the-browser');

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24, timeout: 300_000, ...opts });
  return { status: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}` };
};

const normalize = (text) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\/d\/[A-Za-z0-9_-]{20,}/g, '/d/<secret>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<time>')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l, i, a) => !(l === '' && (i === 0 || a[i - 1] === '')))
    .join('\n')
    .trim();

export function readmeBlock(readme) {
  const at = readme.indexOf('## What it prints');
  const open = readme.indexOf('```\n', at);
  const close = readme.indexOf('\n```', open + 4);
  if (at < 0 || open < 0 || close < 0) return null;
  return readme.slice(open + 4, close);
}

export function pinProblems(demoPkg, corePkg) {
  const pinned = demoPkg.dependencies?.['@filelayer/core'];
  return pinned === corePkg.version
    ? []
    : [`examples/in-the-browser/package.json pins @filelayer/core ${pinned}; packages/core is ${corePkg.version}`];
}

export function outputProblems(actual, readme) {
  const block = readmeBlock(readme);
  if (block === null) return ['examples/in-the-browser/README.md has no "## What it prints" code block'];
  const out = [];
  const a = normalize(actual).split('\n');
  const b = normalize(block).split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      out.push(`README and demo differ at line ${i + 1}:\n    demo:   ${a[i] ?? '(nothing)'}\n    README: ${b[i] ?? '(nothing)'}`);
      break;
    }
  }
  if (!/^4\. [\s\S]*?-> refused: 404/m.test(actual)) out.push('step 4 is not a refusal');
  if (!/^7\. [\s\S]*?-> refused: 404/m.test(actual)) out.push('step 7 is not a refusal');
  if (!/-> valid=true, \d+ events checked/.test(actual)) out.push('step 9 is not a valid chain');
  if (/ALLOWED/.test(actual)) out.push('the demo printed ALLOWED');
  return out;
}

/** Pack the library, install it and the pinned PGlite beside a copy of the demo, run it. */
function runDemo(work, mutateDemo) {
  const pack = run('npm', ['pack', '--pack-destination', work], { cwd: CORE });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (pack.status !== 0 || !tgz) throw new Error(`npm pack failed:\n${pack.out}${pack.err}`);
  const app = join(work, 'demo');
  cpSync(DEMO, app, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
  const pglite = pkg.dependencies['@electric-sql/pglite'];
  writeFileSync(join(app, 'package.json'), JSON.stringify({ ...pkg, dependencies: {} }, null, 2));
  const i = run('npm', ['install', '--no-audit', '--no-fund', join(work, tgz), `@electric-sql/pglite@${pglite}`], { cwd: app });
  if (i.status !== 0) throw new Error(`npm install failed:\n${i.out}${i.err}`);
  mutateDemo?.(app);
  const r = run(process.execPath, ['demo.mjs'], { cwd: app });
  if (r.status !== 0) throw new Error(`the demo exited ${r.status}:\n${r.out}${r.err}`);
  return r.out;
}

const demoPkg = JSON.parse(readFileSync(join(DEMO, 'package.json'), 'utf8'));
const corePkg = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'));
const readme = readFileSync(join(DEMO, 'README.md'), 'utf8');
const work = mkdtempSync(join(tmpdir(), 'filelayer-browser-demo-'));

try {
  if (process.argv.includes('--self-test')) {
    let bad = 0;
    const control = (name, ok) => {
      if (!ok) bad++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    };
    control(
      'a pin that is not the package version is refused',
      pinProblems({ dependencies: { '@filelayer/core': '0.0.1' } }, corePkg).length === 1 && pinProblems(demoPkg, corePkg).length === 0,
    );
    const real = runDemo(work);
    control('the real demo matches the real README', outputProblems(real, readme).length === 0);
    control(
      'an edited README line is refused',
      outputProblems(real, readme.replace('2 downloads left', '3 downloads left')).some((p) => p.startsWith('README and demo differ')),
    );
    rmSync(work, { recursive: true, force: true });
    const skipped = runDemo(mkdtempSync(join(tmpdir(), 'filelayer-browser-demo-')), (app) => {
      const p = join(app, 'demo.mjs');
      const s = readFileSync(p, 'utf8');
      if (!s.includes('await fl.shares.revoke(')) throw new Error('self-test: the demo changed shape; update the control');
      writeFileSync(p, s.replace('await fl.shares.revoke(share.grantId, { as: \'alice\' });', ''));
    });
    const p = outputProblems(skipped, readme);
    control('a demo that skips the revoke is refused (step 7 ALLOWED)', p.includes('step 7 is not a refusal'));
    console.log(`check-browser-demo --self-test: ${4 - bad}/4 controls behaved`);
    process.exit(bad ? 1 : 0);
  }

  const problems = pinProblems(demoPkg, corePkg);
  const out = runDemo(work);
  problems.push(...outputProblems(out, readme));
  if (problems.length) {
    console.error(problems.map((p) => `  - ${p}`).join('\n'));
    console.error('\ncheck-browser-demo: FAILED.');
    process.exit(1);
  }
  console.log(
    `check-browser-demo: clean. The demo pins @filelayer/core ${corePkg.version}, runs on the packed tarball, ` +
      'and prints exactly what its README shows (ids, secret and times aside).',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
