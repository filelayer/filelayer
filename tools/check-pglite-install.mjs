/**
 * The first install an agent types, with PGlite and no version.
 *
 *     node tools/check-pglite-install.mjs              # this tree's tarball
 *     node tools/check-pglite-install.mjs --self-test  # must fail on 0.35.3
 *
 * Until 0.35.4 `@electric-sql/pglite` was an optional peer dependency at
 * `^0.3.11`. npm enforces an optional peer's range once the peer is installed,
 * and PGlite's `latest` is a 0.5.x release. Measured with npm 10.9: installing
 * both in one command lets npm choose a 0.3.x PGlite and succeeds, but a
 * project that already has PGlite, which an install with no version makes
 * 0.5.x, then fails to add @filelayer/core with ERESOLVE: no tree at all,
 * at the first contact. 0.35.4 drops the peer and checks the version when PGlite
 * is loaded instead. This check holds all of it, from empty directories with a
 * new npm cache:
 *
 *   1. both orders succeed with the packed tarball and PGlite unversioned: in
 *      one command, and PGlite first with the package added after;
 *   2. `Filelayer.quickstart()` then refuses with the FilelayerError
 *      `pglite_unsupported_version`, whose message carries the install command
 *      that fixes it, rather than failing somewhere later and stranger;
 *   3. with that command's version, `quickstart()` starts and stores a file.
 *
 * `--self-test` runs step 1 against @filelayer/core@0.35.3 from npm, which
 * still declares the peer, and requires the ERESOLVE. Needs the network for npm.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const FIX = 'npm install --save-dev "@electric-sql/pglite@^0.3.11"';
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

// 1. The installs an agent types: PGlite first and the package after, and both
// in one command.
const plain = project('plain');
const r0 = install(plain, ['@electric-sql/pglite']);
if (r0.status !== 0) fail(`installing PGlite alone failed:\n${r0.stderr}`);
const r1 = install(plain, [tarball]);
if (r1.status !== 0) {
  fail(`adding the tarball to a project with an unversioned PGlite failed (exit ${r1.status}):\n${`${r1.stdout}${r1.stderr}`.slice(-1500)}`);
}
const together = project('together');
const r2 = install(together, [tarball, '@electric-sql/pglite']);
if (r2.status !== 0) {
  fail(`installing the tarball and an unversioned PGlite in one command failed (exit ${r2.status}):\n${`${r2.stdout}${r2.stderr}`.slice(-1500)}`);
}
const got = JSON.parse(
  spawnSync('npm', ['ls', '@electric-sql/pglite', '--json'], { cwd: plain, env: cleanEnv(plain), encoding: 'utf8' }).stdout,
).dependencies?.['@electric-sql/pglite']?.version;

// 2. What it says when started, if npm chose a version outside 0.3.x.
const s1 = startQuickstart(plain);
if (/^0\.3\./.test(got ?? '')) {
  if (!s1.started) fail(`PGlite ${got} is in the supported line and quickstart() still failed: ${JSON.stringify(s1)}`);
  console.log(`check-pglite-install: npm resolved PGlite ${got}, inside the supported line; step 2 has nothing to refuse.`);
} else {
  if (s1.started) fail(`quickstart() started on PGlite ${got}, outside the supported 0.3.x line`);
  if (s1.code !== 'pglite_unsupported_version' || !String(s1.message).includes(FIX)) {
    fail(`quickstart() on PGlite ${got} did not refuse with pglite_unsupported_version and the install command:\n${JSON.stringify(s1, null, 2)}`);
  }
}

// 3. The command the error gives works.
const fixed = project('fixed');
const r3 = install(fixed, [tarball, '@electric-sql/pglite@^0.3.11']);
if (r3.status !== 0) fail(`the install the error recommends failed:\n${`${r3.stdout}${r3.stderr}`.slice(-1500)}`);
const s3 = startQuickstart(fixed);
if (!s3.started) fail(`with the recommended PGlite, quickstart() did not start: ${JSON.stringify(s3)}`);

console.log(
  `check-pglite-install: clean. The tarball installs beside an unversioned PGlite in both orders (PGlite first: npm chose ${got}) with no ERESOLVE; ` +
    `quickstart() refuses it with pglite_unsupported_version and the command that fixes it; with that command it starts and stores a file.`,
);
rmSync(work, { recursive: true, force: true });
