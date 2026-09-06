#!/usr/bin/env node
/**
 * THE RELEASE GATE: can a stranger use what we publish?
 *
 *   node tools/verify-release.mjs [--keep]
 *
 * Every other check in this repository runs against the source tree. This one
 * deliberately cannot see the source tree. It:
 *
 *   1. packs `packages/core` into a tarball, exactly as `npm publish` would;
 *   2. creates a directory that has never contained anything;
 *   3. `npm install`s the tarball into it, with no registry access to us and
 *      no path back into this repository;
 *   4. writes a consumer program into that directory and runs it there, with
 *      `cwd` inside it, resolving `@filelayer/core` as a BARE SPECIFIER;
 *   5. drives the full advertised lifecycle and asserts every step:
 *
 *        install -> import -> configure -> create -> upload -> read
 *              -> authorize (a denial must actually deny)
 *              -> share -> revoke (the revoked link must actually die)
 *              -> audit (the trail must read back, and verify)
 *
 * The point of the shape is that a failure here is a failure a USER would have
 * had. `npm test` in the source tree cannot reproduce it: the package once
 * shipped `exports` pointing at TypeScript source, which passes every in-tree
 * test and throws ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING for every real
 * consumer.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS SCRIPT INSTALLS PGLITE HALFWAY THROUGH
 * -----------------------------------------------------------------------------
 *
 * `@electric-sql/pglite` -- an embedded WASM PostgreSQL -- is an OPTIONAL PEER
 * dependency of this package, not a dependency. A production install therefore
 * contains no database at all, which is the whole premise: you point Filelayer
 * at YOUR Postgres. Only two functions need pglite, `createTestDb()` and the
 * `Filelayer.quickstart()` built on it, and both are test/development helpers.
 *
 * So the gate runs the consumer directory in two shapes, in this order:
 *
 *   PHASE 1, PRODUCTION SHAPE. The tarball and nothing else. Assert the install
 *     drags in zero production dependencies, that the package imports with no
 *     database on disk, and that calling `createTestDb()` there fails with an
 *     error that NAMES the package and the install command -- not a raw
 *     ERR_MODULE_NOT_FOUND thrown from somewhere inside our `dist`.
 *     Then, if FILELAYER_VERIFY_DATABASE_URL points at a scratch database, run
 *     the ENTIRE advertised lifecycle in that same pglite-free directory, over
 *     `pg` and real Postgres. That is the direct proof that a production
 *     consumer is unaffected by the packaging. Without the variable the step is
 *     skipped, loudly, on one line -- it is not silently dropped.
 *
 *   PHASE 2, HELPER SHAPE. Install pglite, then run the SAME lifecycle
 *     assertions through `Filelayer.quickstart()`. This is the documented
 *     five-line quickstart, so it has to keep working, and it is the only part
 *     of this file that needs pglite. The install is explicit and belongs to the
 *     CONSUMER's dev dependencies, never to ours.
 *
 *     The command it runs is READ OUT OF README.md, by
 *     `documentedInstallCommand()` in tools/check-install-commands.mjs. It is
 *     not written here. 0.4.0 shipped an install command that could not resolve
 *     against its own peer range, and this gate did not catch it for one
 *     reason: the gate typed its own command. A gate that writes its own version
 *     of the instructions is testing itself, not the instructions.
 *
 * The lifecycle assertions are written once, in `LIFECYCLE`, and run in both
 * shapes. Two copies would drift, and the copy that drifts is always the one
 * that is not the default.
 *
 * Exit code 0 means the published artifact works. Anything else names the step
 * that broke.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { documentedInstallCommand, shellWords, satisfies } from './check-install-commands.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(ROOT, 'packages', 'core');
const KEEP = process.argv.includes('--keep');

/** The optional peer dependency. Named once so the two phases cannot disagree. */
const PGLITE = '@electric-sql/pglite';

/** The range the published package declares. Read, not written. */
const PGLITE_RANGE = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8'))
  .peerDependencies?.[PGLITE];

/**
 * The install command README.md gives a first user, character for character.
 * Phases 2 and 3 run THIS. See the header for why it is not written out here.
 */
const DOC_INSTALL = (() => {
  try {
    return documentedInstallCommand(PGLITE);
  } catch (e) {
    die('reading the documented install command', e.message);
  }
})();

/** A scratch Postgres for the production-shape lifecycle. Optional; see above. */
const DB_URL = process.env.FILELAYER_VERIFY_DATABASE_URL ?? '';

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  return r;
}

function die(stage, detail) {
  console.error(`\nverify-release: FAILED at "${stage}"\n`);
  if (detail) console.error(detail.trim() + '\n');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// The consumer programs. These strings are written into the empty directory and
// are the only things that run there. They import by bare specifier and never
// reference a path into this repository.
// -----------------------------------------------------------------------------

/** Numbered-step output, shared by every consumer program below. */
const REPORTING = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const t0 = Date.now();
let n = 0;
function step(name) {
  n++;
  process.stdout.write('  ' + String(n).padStart(2, ' ') + '. ' + name.padEnd(44, '.'));
}
function ok(note = '') {
  process.stdout.write(' ok' + (note ? '  (' + note + ')' : '') + '\n');
}
`;

/**
 * PHASE 1. What a production consumer's node_modules actually looks like.
 *
 * Everything here is asserted with pglite absent from the directory. If any of
 * it starts needing pglite, the package has quietly acquired a runtime database
 * again and this is where that is caught.
 */
const PROBE = REPORTING + String.raw`
step('the install pulled in no database');
let found = null;
try {
  found = require.resolve('@electric-sql/pglite');
} catch {
  /* expected: nothing depends on it */
}
assert.equal(
  found,
  null,
  '@electric-sql/pglite resolved at ' + found + ' -- installing @filelayer/core must not ' +
    'install an embedded Postgres. It is an OPTIONAL PEER dependency, not a dependency.',
);
ok('no @electric-sql/pglite on disk');

step('it imports with no database installed');
const core = await import('@filelayer/core');
for (const name of [
  'Filelayer', 'FilelayerError', 'MemoryStorage', 'S3Storage', 'PostgresStore',
  'authorize', 'fileDownloadRoute', 'shareDownloadRoute', 'toResponse',
  'createTestDb', 'loadSchemaSql', 'SCHEMA_PATH',
]) {
  assert.ok(name in core, 'missing export: ' + name);
}
assert.equal(typeof core.createTestDb, 'function', 'createTestDb is no longer exported');
// The production constructors must be usable with nothing else installed.
const storage = new core.MemoryStorage();
assert.equal(typeof storage.put, 'function');
new core.S3Storage({
  endpoint: 'https://example.r2.cloudflarestorage.com',
  bucket: 'b', region: 'auto', accessKeyId: 'k', secretAccessKey: 's',
});
ok('full public surface, no install warning');

step('createTestDb() explains itself');
const failure = await core.createTestDb().then(
  () => null,
  (e) => e,
);
assert.ok(failure, 'createTestDb() RESOLVED with no pglite installed');
// The whole point. A consumer must not have to decode Node's resolver.
assert.ok(
  !/ERR_MODULE_NOT_FOUND|Cannot find package/.test(failure.message),
  'a raw module-resolution error reached the caller:\n' + failure.message,
);
assert.match(failure.message, /@electric-sql\/pglite/, 'the error does not name the package');
// The command in the error must be the command in README.md, character for
// character, and it must carry a version. 0.4.0's carried none, which is how a
// developer following it could land outside the declared peer range.
const DOCUMENTED = ${JSON.stringify(DOC_INSTALL)};
assert.match(
  DOCUMENTED,
  /@\^?\d+\.\d+\.\d+/,
  'the documented install command carries no version constraint: ' + DOCUMENTED,
);
assert.ok(
  failure.message.includes(DOCUMENTED),
  'the error does not give the documented install command.\n' +
    '  README.md says:  ' + DOCUMENTED + '\n' +
    '  the error says:\n' + failure.message,
);
assert.match(failure.message, /DATABASE_URL/, 'the error does not point at the production path');
assert.ok(failure.cause, 'the underlying resolution error was discarded rather than chained');
ok('names the package and the command');

console.log('');
console.log('     the message a consumer actually sees:');
console.log('     +' + '-'.repeat(72));
for (const line of failure.message.replace(/\n+$/, '').split('\n')) {
  console.log('     | ' + line);
}
console.log('     +' + '-'.repeat(72));
console.log('');

console.log('verify-release: production shape OK - ' + n + ' checks, ' +
  ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('Installing @filelayer/core installs a library, not a database.\n');
`;

/**
 * The advertised lifecycle. Runs twice: once against a real Postgres in the
 * production-shaped directory, once against PGlite via `quickstart()`.
 * `fl` is provided by the phase-specific preamble spliced in above it.
 */
const LIFECYCLE = String.raw`
step('configure a tenant and its owner');
const org = await fl.orgs.create('acme', { name: 'Acme Inc', owner: 'alice' });
assert.ok(org.id, 'orgs.create returned no id');
ok('org acme, owner alice');

// ----------------------------------------------------------- 4. create file --
step('create a file');
const TEXT = 'contract-v1: the bytes a customer would actually store';
const created = await fl.files.put(new TextEncoder().encode(TEXT), {
  org: 'acme', owner: 'alice', name: 'contract.txt', contentType: 'text/plain',
});
assert.ok(created.id, 'put returned no id');
assert.equal(created.name, 'contract.txt');
assert.equal(created.size, TEXT.length);
ok(created.id.slice(0, 8) + '...');

// --------------------------------------------------------------- 5. upload --
// A non-trivial binary payload, so this exercises the storage adapter rather
// than a short string that could survive a broken write.
step('upload binary content (64 KiB)');
const blob = new Uint8Array(64 * 1024);
for (let i = 0; i < blob.length; i++) blob[i] = (i * 31 + 7) & 0xff;
blob.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG magic
const uploaded = await fl.files.put(blob, { org: 'acme', owner: 'alice', name: 'scan.png' });
assert.equal(uploaded.size, blob.length, 'stored size disagrees with what we sent');
assert.equal(uploaded.contentType, 'image/png', 'content type was not sniffed from magic bytes');
const statted = await fl.files.stat(uploaded.id, { as: 'alice' });
assert.equal(statted.sizeBytes, blob.length, 'stat disagrees with the upload');
ok(blob.length + ' bytes, sniffed image/png');

// ----------------------------------------------------------------- 6. read --
step('read it back as the owner');
const got = await fl.files.get(created.id, { as: 'alice' });
assert.equal(new TextDecoder().decode(got.body), TEXT, 'the bytes came back different');
assert.equal(got.headers['x-content-type-options'], 'nosniff', 'delivery headers missing');
assert.match(got.headers['cache-control'], /no-store/, 'no-store missing: revocation would be cacheable');
const gotBin = await fl.files.get(uploaded.id, { as: 'alice' });
assert.equal(gotBin.body.length, blob.length, 'binary length changed in the round trip');
assert.ok(Buffer.from(gotBin.body).equals(Buffer.from(blob)), 'binary content changed in the round trip');
ok('byte-exact, headers present');

// ------------------------------------------------------------ 7. authorize --
// The step that matters. An authorization layer that never denies is a
// permission-shaped no-op, so each of these MUST throw.
step('authorize: a denial actually denies');
async function mustDeny(label, fn) {
  await assert.rejects(fn, (e) => {
    assert.ok(e instanceof FilelayerError, label + ': expected FilelayerError, got ' + e);
    assert.equal(e.status, 404, label + ': expected 404, got ' + e.status);
    return true;
  }, label + ': WAS NOT DENIED');
}
// bob is a real, registered member of acme -- so this is an authorization
// decision, not a "who?" lookup miss.
await fl.files.put(new TextEncoder().encode('bobs own file'), { org: 'acme', owner: 'bob', name: 'bob.txt' });
await mustDeny('registered non-owner reading a private file', () => fl.files.get(created.id, { as: 'bob' }));
await mustDeny('anonymous caller reading a private file', () => fl.files.get(created.id));
await mustDeny('unregistered caller (no silent downgrade)', () => fl.files.get(created.id, { as: 'mallory' }));
// and a member of another tenant entirely
await fl.orgs.create('globex', { owner: 'carol' });
await mustDeny('cross-tenant read', () => fl.files.get(created.id, { as: 'carol' }));
ok('4 denials, all 404');

// ---------------------------------------------------------------- 8. share --
step('share it as a revocable link');
const share = await fl.shares.create(created.id, { as: 'alice', expiresIn: 3600, maxDownloads: 5 });
assert.ok(share.grantId, 'share returned no grantId');
assert.ok(share.secret, 'share returned no secret -- there is nothing to hand out');
const redeemed = await fl.shares.redeem(share.secret);
assert.equal(new TextDecoder().decode(redeemed.body), TEXT, 'the share link delivered the wrong bytes');
assert.equal(redeemed.remainingDownloads, 4, 'the download cap did not decrement');
ok('link redeems, cap 5 -> 4');

// --------------------------------------------------------------- 9. revoke --
step('revoke: the live link stops working');
await fl.shares.revoke(share.grantId, { as: 'alice' });
await mustDeny('redeeming a revoked share link', () => fl.shares.redeem(share.secret));
// the same must be true of a published file's public URL
const published = await fl.files.publish(uploaded.id, { as: 'alice' });
assert.ok(published.url.startsWith('https://files.example.test/f/'), 'publish returned ' + published.url);
await fl.files.get(uploaded.id);                       // anonymous read now works
const un = await fl.files.unpublish(uploaded.id, { as: 'alice' });
assert.equal(un.revoked, 1, 'unpublish revoked ' + un.revoked + ' grants, expected 1');
await mustDeny('anonymous read after unpublish', () => fl.files.get(uploaded.id));
ok('link dead, public URL dead');

// ---------------------------------------------------------------- 10. audit --
step('audit: read the trail back');
const trail = await fl.orgs.audit('acme', { as: 'alice', limit: 500 });
assert.ok(Array.isArray(trail) && trail.length > 0, 'the audit log is empty');
const actions = new Set(trail.map((r) => r.action));
for (const required of ['file.create', 'file.read', 'grant.create', 'grant.revoke']) {
  assert.ok(actions.has(required), 'no "' + required + '" event in the audit trail');
}
// P5: denials are the events worth having.
const denials = trail.filter((r) => r.decision === 'deny');
assert.ok(denials.length > 0, 'not one denial was recorded -- P5 is not holding');
ok(trail.length + ' events, ' + denials.length + ' denials');

step('audit: the hash chain verifies');
const chain = await fl.orgs.verifyAudit('acme', { as: 'alice' });
assert.equal(chain.valid, true, 'the audit chain does not verify: ' + JSON.stringify(chain));
assert.ok(chain.checked > 0, 'the chain check inspected nothing');
ok(chain.checked + ' entries chained');

step('audit: another tenant cannot read it');
await mustDeny('reading another tenant audit log', () => fl.orgs.audit('acme', { as: 'carol' }));
ok();
`;

/** Import, entry-point and licence assertions. Identical in both phases. */
const IMPORT_AND_LICENCE = String.raw`
step('import  @filelayer/core (bare specifier)');
const entry = require.resolve('@filelayer/core');
assert.match(entry, /node_modules/, 'must resolve the INSTALLED copy, not a source checkout');
assert.match(entry, /\.js$/, 'entry must be compiled JavaScript, got ' + entry);
const core = await import('@filelayer/core');
const { Filelayer, FilelayerError } = core;
assert.equal(typeof Filelayer, 'function');
ok('dist/index.js');

// legal metadata has to survive packing, or the licence grant is not in the artifact
step('license files present in the install');
const pkgPath = require.resolve('@filelayer/core/package.json');
const pkgRoot = pkgPath.replace(/[/\\]package\.json$/, '');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
assert.equal(pkg.license, 'Apache-2.0', 'package.json license must be Apache-2.0, got ' + pkg.license);
for (const f of ['LICENSE', 'NOTICE']) {
  assert.ok(existsSync(pkgRoot + '/' + f), f + ' is missing from the installed package');
}
const lic = readFileSync(pkgRoot + '/LICENSE', 'utf8');
assert.ok(lic.includes('Apache License'), 'LICENSE is not the Apache licence');
assert.ok(lic.includes('Version 2.0, January 2004'), 'LICENSE is not version 2.0');
assert.ok(!/LICENSE NOT YET CHOSEN/.test(lic), 'LICENSE is still the placeholder');
ok('LICENSE + NOTICE, Apache-2.0');

// Packaging is a claim about what a consumer is made to install. Assert it from
// inside the install rather than from our package.json, which is the copy that
// could be right while the tarball is wrong.
step('the package declares no runtime dependencies');
assert.deepEqual(
  Object.keys(pkg.dependencies ?? {}),
  [],
  'the published package declares dependencies: ' + JSON.stringify(pkg.dependencies),
);
assert.ok(
  pkg.peerDependenciesMeta?.['@electric-sql/pglite']?.optional === true,
  '@electric-sql/pglite must be declared an OPTIONAL peer dependency, so that a consumer ' +
    'who wants createTestDb() is told what to install and a consumer who does not gets no ' +
    'install warning',
);
ok('0 deps, pglite optional-peer');
`;

/** PHASE 1's optional lifecycle: real Postgres, over `pg`, with no pglite. */
const CONSTRUCT_POSTGRES = String.raw`
step('configure an instance: pg.Pool + real Postgres');
const { Pool } = await import('pg');
const pool = new Pool({ connectionString: process.env.FILELAYER_VERIFY_DATABASE_URL });
// Provision exactly the documented way: apply the schema.sql that shipped in
// the tarball. A scratch database is required and is reset first, because
// schema.sql creates its tables unconditionally.
assert.ok(existsSync(core.SCHEMA_PATH), 'SCHEMA_PATH does not exist: ' + core.SCHEMA_PATH);
assert.ok(existsSync(pkgRoot + '/schema.sql'), 'schema.sql is not at the package root');
const schemaSql = await core.loadSchemaSql();
assert.ok(schemaSql.includes('CREATE TABLE'), 'schema.sql does not look like a schema');
await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
await pool.query('CREATE SCHEMA public');
await pool.query(schemaSql);
const fl = new Filelayer(pool, new core.MemoryStorage(), { baseUrl: 'https://files.example.test' });
assert.equal(fl.baseUrl, 'https://files.example.test');
const { rows: ver } = await pool.query('SELECT version() AS v');
ok(String(ver[0].v).split(' ').slice(0, 2).join(' '));
`;

const TEARDOWN_POSTGRES = String.raw`
await pool.end();
`;

/** PHASE 2's lifecycle: the documented quickstart, which is PGlite-backed. */
const CONSTRUCT_QUICKSTART = String.raw`
step('configure an instance: Filelayer.quickstart()');
const fl = await Filelayer.quickstart({ baseUrl: 'https://files.example.test' });
assert.equal(fl.baseUrl, 'https://files.example.test');
// schema.sql must be resolvable from the installed layout or nobody can
// provision a real database.
assert.ok(existsSync(core.SCHEMA_PATH), 'SCHEMA_PATH does not exist: ' + core.SCHEMA_PATH);
assert.ok(existsSync(pkgRoot + '/schema.sql'), 'schema.sql is not at the package root');
assert.ok((await core.loadSchemaSql()).includes('CREATE TABLE'), 'schema.sql does not look like a schema');
ok('PGlite + memory storage');
`;

const flowSource = ({ construct, teardown = '', banner }) =>
  REPORTING +
  IMPORT_AND_LICENCE +
  construct +
  LIFECYCLE +
  teardown +
  String.raw`
console.log('\nverify-release: ` +
  banner +
  String.raw` - ' + n + ' steps, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's\n');
`;

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------

console.log('verify-release: the empty-directory test\n');

// --- pack --------------------------------------------------------------------
process.stdout.write('   pack packages/core .............................');
const packDir = mkdtempSync(join(tmpdir(), 'filelayer-pack-'));
const packed = run('npm', ['pack', '--pack-destination', packDir, '--silent'], { cwd: CORE });
if (packed.status !== 0) die('pack', packed.stderr || packed.stdout);
const tarballName = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
if (!tarballName) die('pack', 'npm pack produced no tarball in ' + packDir);
const tarball = join(packDir, tarballName);
console.log(' ok  (' + tarballName + ')');

// --- an empty directory ------------------------------------------------------
process.stdout.write('   npm install into an empty directory ............');
const consumer = mkdtempSync(join(tmpdir(), 'filelayer-consumer-'));
mkdirSync(consumer, { recursive: true });
// A consumer has a package.json; they do not have our repository. Nothing here
// references ROOT, and npm is run with `--no-package-lock --ignore-scripts` so
// the install cannot reach back into the source tree or run our build.
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'filelayer-consumer', private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n',
);
const npmEnv = { ...process.env, npm_config_update_notifier: 'false' };
const npmInstall = (args, stage) => {
  const r = run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...args], {
    cwd: consumer,
    env: npmEnv,
  });
  if (r.status !== 0) die(stage, r.stderr || r.stdout);
  return r;
};
const install = npmInstall([tarball], 'npm install (from the packed tarball)');
// An optional peer dependency that is missing must not warn. A consumer who
// never calls createTestDb() should see nothing at all about pglite.
const installNoise = (install.stderr || '') + (install.stdout || '');
if (/pglite/i.test(installNoise)) {
  die(
    'npm install (from the packed tarball)',
    'the install mentioned pglite, so it is either being installed or being warned about:\n' +
      installNoise,
  );
}
console.log(' ok');

const runInConsumer = (file, source, stage) => {
  writeFileSync(join(consumer, file), source);
  const r = run(process.execPath, [file], {
    cwd: consumer,
    stdio: 'inherit',
    // Deliberately NOT inheriting NODE_PATH or NODE_OPTIONS: no path back here.
    env: { ...npmEnv, NODE_PATH: '', NODE_OPTIONS: '' },
  });
  if (r.status !== 0) cleanupAndExit(r.status ?? 1, stage);
};

function cleanup() {
  if (KEEP) {
    console.log(`(kept: ${consumer}, ${tarball})`);
    return;
  }
  rmSync(packDir, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
}

function cleanupAndExit(code, stage) {
  cleanup();
  console.error(`\nverify-release: FAILED (${stage} exited ${code})\n`);
  process.exit(code);
}

// --- PHASE 1: the shape a production consumer installs -----------------------
console.log('\nPHASE 1 - production shape: the tarball and nothing else\n');
runInConsumer('probe.mjs', PROBE, 'the production-shape probe');

if (DB_URL) {
  process.stdout.write('   npm install pg (the consumer\'s driver) ........');
  npmInstall(['pg'], 'npm install pg');
  console.log(' ok');
  console.log('\n   full lifecycle over real Postgres, still with no pglite installed:\n');
  runInConsumer(
    'flow-postgres.mjs',
    flowSource({
      construct: CONSTRUCT_POSTGRES,
      teardown: TEARDOWN_POSTGRES,
      banner: 'PASS (production shape, real Postgres, no pglite)',
    }),
    'the production-shape lifecycle',
  );
} else {
  console.log(
    '\n   SKIPPED: the production-shape lifecycle over real Postgres.\n' +
      '   Set FILELAYER_VERIFY_DATABASE_URL to a SCRATCH database (its `public`\n' +
      '   schema is dropped and recreated) to run the whole advertised lifecycle\n' +
      '   with no pglite on disk. CI sets it from a service container.\n',
  );
}

// --- PHASE 2: + the optional peer dependency, for the documented quickstart ---
//
// `Filelayer.quickstart()` starts an in-process WASM Postgres, so it needs
// @electric-sql/pglite. That package is deliberately NOT a dependency of
// @filelayer/core (see the header), which means the gate has to install it
// here, explicitly, into the CONSUMER's dev dependencies -- exactly as the
// documentation tells a reader to do before their first quickstart. If this
// line is ever removed, phase 2 fails with the message asserted in phase 1.
//
// The command is README.md's, read at run time. Not a copy of it.
console.log('\nPHASE 2 - helper shape: + ' + PGLITE + ' (the consumer\'s devDependency)\n');
const docArgs = shellWords(DOC_INSTALL);
if (docArgs[0] !== 'npm' || docArgs[1] !== 'install') {
  die(
    'the documented install command',
    'README.md gives "' + DOC_INSTALL + '", which this gate does not know how to run.\n' +
      'It executes the documented command rather than one of its own, so the command\n' +
      'has to stay an `npm install`.',
  );
}
console.log('   README.md tells a first user to run:');
console.log('     $ ' + DOC_INSTALL + '\n');
process.stdout.write('   running exactly that ...........................');
npmInstall(docArgs.slice(2), 'the documented install command: ' + DOC_INSTALL);
console.log(' ok');

// It resolved -- but to WHAT? An install that succeeds because npm quietly
// picked a version other than the one the reader asked for is still a broken
// instruction, and it is the shape that hid this defect: with the tarball
// already in place, npm will silently walk `latest` back into the peer range,
// so a bare command "worked" here while failing for a real user whose project
// already had the package.
process.stdout.write('   the version it installed is in range ...........');
const installedManifest = join(consumer, 'node_modules', ...PGLITE.split('/'), 'package.json');
const installedVersion = JSON.parse(readFileSync(installedManifest, 'utf8')).version;
if (!satisfies(installedVersion, PGLITE_RANGE)) {
  die(
    'the documented install command',
    'it installed ' + PGLITE + '@' + installedVersion + ', which is outside the peer\n' +
      'range this package declares (' + PGLITE_RANGE + '). The command and the manifest\n' +
      'disagree, and the developer following the command is the one who finds out.',
  );
}
console.log(' ok  (' + installedVersion + ' satisfies ' + PGLITE_RANGE + ')');
console.log('');
runInConsumer(
  'flow-quickstart.mjs',
  flowSource({
    construct: CONSTRUCT_QUICKSTART,
    banner: 'PASS (quickstart shape, PGlite)',
  }),
  'the quickstart lifecycle',
);

// --- PHASE 3: the other order -----------------------------------------------
//
// Phases 1 and 2 install the tarball first and pglite second. In that order npm
// can rescue a bad instruction: the peer range is already on disk, so it walks
// `latest` back to something the range admits and the install "succeeds". That
// is exactly why 0.4.0's unversioned command passed this gate and failed for
// real people.
//
// A developer whose project ALREADY uses pglite adds @filelayer/core the other
// way round, and there is nothing left to rescue: whatever the documented
// command put on disk is what the peer range has to admit, or npm refuses the
// tree with ERESOLVE. So run the documented command in a directory that has
// never contained anything, then add the package on top.
console.log('\nPHASE 3 - the other order: the documented command first, then the package\n');
const reverse = mkdtempSync(join(tmpdir(), 'filelayer-reverse-'));
writeFileSync(
  join(reverse, 'package.json'),
  JSON.stringify({ name: 'filelayer-reverse', private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n',
);
const reverseInstall = (args, stage) => {
  const r = run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...args], {
    cwd: reverse,
    env: npmEnv,
  });
  if (r.status !== 0) {
    if (!KEEP) rmSync(reverse, { recursive: true, force: true });
    die(stage, r.stderr || r.stdout);
  }
  return r;
};
console.log('     $ ' + DOC_INSTALL);
console.log('     $ npm install @filelayer/core\n');
process.stdout.write('   the documented command, in an empty directory ..');
reverseInstall(docArgs.slice(2), 'the documented install command, in an empty directory');
console.log(' ok');
process.stdout.write('   then @filelayer/core on top of it ..............');
reverseInstall(
  [tarball],
  'npm install @filelayer/core on top of the documented pglite install\n\n' +
    'This is ERESOLVE: the version the documented command installs is not one the\n' +
    'declared peer range admits. It is the defect 0.4.1 fixed, and a developer\n' +
    'whose project already uses pglite hits it on their first command.',
);
console.log(' ok  (no dependency-resolution error)');
if (!KEEP) rmSync(reverse, { recursive: true, force: true });
else console.log('   (kept: ' + reverse + ')');

cleanup();
console.log('\nThe published tarball installs from nothing and performs the full lifecycle.');
console.log('The install command it documents resolves against the range it declares.\n');
process.exit(0);
