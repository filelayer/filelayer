/**
 * The first install an agent types, with PGlite and no version.
 *
 *     node tools/check-pglite-install.mjs              # this tree's tarball
 *     node tools/check-pglite-install.mjs --self-test  # must fail on 0.35.3
 *
 * Until 0.35.4 `@electric-sql/pglite` was an optional peer dependency at
 * `^0.3.11`. npm enforces an optional peer's range once the peer is installed,
 * and PGlite's `latest` was a 0.5.x release. Measured with npm 10.9: installing
 * both in one command lets npm choose a 0.3.x PGlite and succeeds, but a
 * project that already has PGlite, which an install with no version makes
 * 0.5.x, then fails to add @filelayer/core with ERESOLVE: no tree at all, at
 * the first contact. 0.35.4 drops the peer, supports `^0.3.11 || ^0.5.8`, and
 * checks the version when PGlite is loaded. This check holds all of it, from
 * empty directories with a new npm cache:
 *
 *   1. PGlite's `latest`, installed first with no version and the packed
 *      tarball added after, installs, and `quickstart()` starts and stores a
 *      file; the same with both in one command;
 *   2. a published PGlite outside the range installs too, and `quickstart()`
 *      refuses it with the FilelayerError `pglite_unsupported_version`, whose
 *      message carries the install command that fixes it;
 *   3. that command, run in that project, makes `quickstart()` start.
 *
 * `--self-test` adds @filelayer/core@0.35.3 from npm to a project with an
 * unversioned PGlite and requires the ERESOLVE. Needs the network for npm.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside } from './check-upstream-range.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const FIX = 'npm install --save-dev "@electric-sql/pglite@^0.3.11"';
const OUT_OF_RANGE = '0.4.6'; // published, and outside ^0.3.11 || ^0.5.8 || ^0.6.0
const RANGE = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).devDependencies['@electric-sql/pglite'];
const SELF_TEST = process.argv.includes('--self-test');

const work = mkdtempSync(join(tmpdir(), 'filelayer-pglite-install-'));
const fail = (msg) => {
  console.error(`\ncheck-pglite-install: ${msg}\n`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
};

function cleanEnv(dir) {
  const env = { ...process.env, npm_config_cache: join(dir, '.npm-cache') };
  for (const k of Object.keys(env)) {
    if (k.toLowerCase().startsWith('npm_') && k !== 'npm_config_cache') delete env[k];
  }
  return env;
}

function project(name) {
  const d = mkdtempSync(join(work, `${name}-`));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: `probe-${name}`, private: true, type: 'module' }));
  return d;
}

function install(dir, specs) {
  return spawnSync('npm', ['install', '--no-audit', '--no-fund', ...specs], {
    cwd: dir,
    env: cleanEnv(dir),
    encoding: 'utf8',
  });
}

function startQuickstart(dir) {
  const probe = `
    import { Filelayer } from '@filelayer/core';
    try {
      const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost' });
      await fl.orgs.create('acme', { owner: 'alice' });
      const { id } = await fl.files.put(new TextEncoder().encode('hello'), { org: 'acme', owner: 'alice', name: 'a.txt' });
      console.log(JSON.stringify({ started: true, id }));
      process.exit(0);
    } catch (e) {
      console.log(JSON.stringify({ started: false, name: e?.name, code: e?.code, message: String(e?.message) }));
      process.exit(0);
    }`;
  writeFileSync(join(dir, 'probe.mjs'), probe);
  const r = spawnSync(process.execPath, ['probe.mjs'], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
  const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return { started: false, unparsed: `${r.stdout}${r.stderr}`.slice(-600) };
  }
}

if (SELF_TEST) {
  const dir = project('old');
  const first = install(dir, ['@electric-sql/pglite']);
  if (first.status !== 0) fail(`self-test: installing PGlite alone failed:\n${first.stderr}`);
  const r = install(dir, ['@filelayer/core@0.35.3']);
  const out = `${r.stdout}${r.stderr}`;
  if (r.status === 0 || !/ERESOLVE/.test(out)) {
    fail(`self-test: adding @filelayer/core@0.35.3 to a project with an unversioned PGlite did not ERESOLVE (exit ${r.status}); the check could not tell the defect from the fix`);
  }
  console.log('check-pglite-install --self-test: adding 0.35.3 to a project that has an unversioned PGlite is refused with ERESOLVE, which step 1 requires the tarball not to be.');
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

const pack = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: CORE, encoding: 'utf8' });
const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
if (pack.status !== 0 || !tgz) fail(`npm pack failed:\n${pack.stdout}${pack.stderr}`);
const tarball = join(work, tgz);
const versionIn = (dir) =>
  JSON.parse(spawnSync('npm', ['ls', '@electric-sql/pglite', '--json'], { cwd: dir, env: cleanEnv(dir), encoding: 'utf8' }).stdout)
    .dependencies?.['@electric-sql/pglite']?.version;
const tail = (r) => `${r.stdout}${r.stderr}`.slice(-1500);

// 1. PGlite's latest, in both orders: installs with no ERESOLVE, and
// quickstart() starts and stores a file. If npm's latest has left the
// supported range (an upstream release, as 0.6.0 did on 23 November 2026),
// the right answer is the refusal step 2 requires, and this is not where that
// is reported: the CI job "upstream release outside supported range"
// (tools/check-upstream-range.mjs) is. So here a latest outside the range
// must install and be refused cleanly, and nothing more.
const startsOrRefuses = (s, v, what) => {
  if (inside(v, RANGE)) {
    if (!s.started) fail(`${what} (PGlite ${v}, inside ${RANGE}), quickstart() did not start and store a file: ${JSON.stringify(s)}`);
  } else if (s.started || s.code !== 'pglite_unsupported_version') {
    fail(`${what} (PGlite ${v}, OUTSIDE ${RANGE}), quickstart() did not refuse with pglite_unsupported_version: ${JSON.stringify(s)}`);
  }
};
const first = project('first');
const r0 = install(first, ['@electric-sql/pglite']);
if (r0.status !== 0) fail(`installing PGlite alone failed:\n${tail(r0)}`);
const r1 = install(first, [tarball]);
if (r1.status !== 0) fail(`adding the tarball to a project with an unversioned PGlite failed (exit ${r1.status}):\n${tail(r1)}`);
const latest = versionIn(first);
startsOrRefuses(startQuickstart(first), latest, "with PGlite's latest");
const together = project('together');
const r2 = install(together, [tarball, '@electric-sql/pglite']);
if (r2.status !== 0) fail(`the tarball and an unversioned PGlite in one command failed (exit ${r2.status}):\n${tail(r2)}`);
startsOrRefuses(startQuickstart(together), versionIn(together), 'installed together');
if (!inside(latest, RANGE)) {
  console.log(`check-pglite-install: note: PGlite's latest (${latest}) is outside ${RANGE}; quickstart() refuses it cleanly. The job "upstream release outside supported range" reports it.`);
}

// 2. A published PGlite outside the supported range: refused, with the fix.
const outside = project('outside');
const r3 = install(outside, [tarball, `@electric-sql/pglite@${OUT_OF_RANGE}`]);
if (r3.status !== 0) fail(`installing the tarball beside PGlite ${OUT_OF_RANGE} failed (exit ${r3.status}):\n${tail(r3)}`);
const s3 = startQuickstart(outside);
if (s3.started) fail(`quickstart() started on PGlite ${OUT_OF_RANGE}, outside ${RANGE}`);
if (s3.code !== 'pglite_unsupported_version' || !String(s3.message).includes(FIX)) {
  fail(`quickstart() on PGlite ${OUT_OF_RANGE} did not refuse with pglite_unsupported_version and the command:\n${JSON.stringify(s3, null, 2)}`);
}

// 3. The command the error gives, run where the error was raised, works.
const r4 = spawnSync('sh', ['-c', FIX + ' --no-audit --no-fund'], { cwd: outside, env: cleanEnv(outside), encoding: 'utf8' });
if (r4.status !== 0) fail(`the command the error gives failed:\n${tail(r4)}`);
const s4 = startQuickstart(outside);
if (!s4.started) fail(`after the command the error gives (PGlite ${versionIn(outside)}), quickstart() did not start: ${JSON.stringify(s4)}`);

console.log(
  `check-pglite-install: clean. The tarball installs beside PGlite's latest (${latest}) in both orders with no ERESOLVE, ` +
    `and quickstart() ${inside(latest, RANGE) ? 'starts and stores a file' : 'refuses it cleanly, as outside the range'}; PGlite ${OUT_OF_RANGE} is refused with pglite_unsupported_version and the command, ` +
    `and the command makes it start.`,
);
rmSync(work, { recursive: true, force: true });
