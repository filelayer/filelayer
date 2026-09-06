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
 * Exit code 0 means the published artifact works. Anything else names the step
 * that broke.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(ROOT, 'packages', 'core');
const KEEP = process.argv.includes('--keep');

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
// The consumer program. This string is written into the empty directory and is
// the only thing that runs there. It imports by bare specifier and never
// references a path into this repository.
// -----------------------------------------------------------------------------
const FLOW = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const t0 = Date.now();
// Steps 0 (pack) and 1 (install) were performed by the orchestrator before this
// program existed, so the consumer-side count continues from there.
let n = 1;
const started = [];
function step(name) {
  n++;
  started.push(name);
  process.stdout.write('  ' + String(n).padStart(2, ' ') + '. ' + name.padEnd(44, '.'));
}
function ok(note = '') {
  process.stdout.write(' ok' + (note ? '  (' + note + ')' : '') + '\n');
}

// ---------------------------------------------------------------- 2. import --
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

// ------------------------------------------------------------- 3. configure --
step('configure an instance');
const fl = await Filelayer.quickstart({ baseUrl: 'https://files.example.test' });
assert.equal(fl.baseUrl, 'https://files.example.test');
// schema.sql must be resolvable from the installed layout or nobody can
// provision a real database.
assert.ok(existsSync(core.SCHEMA_PATH), 'SCHEMA_PATH does not exist: ' + core.SCHEMA_PATH);
assert.ok(existsSync(pkgRoot + '/schema.sql'), 'schema.sql is not at the package root');
assert.ok((await core.loadSchemaSql()).includes('CREATE TABLE'), 'schema.sql does not look like a schema');
ok('PGlite + memory storage');

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

console.log('\nverify-release: PASS - ' + n + ' steps, ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('The published tarball installs from nothing and performs the full lifecycle.\n');
`;

// -----------------------------------------------------------------------------
// Orchestration
// -----------------------------------------------------------------------------

console.log('verify-release: the empty-directory test\n');

// --- 1. pack -----------------------------------------------------------------
process.stdout.write('   0. pack packages/core ...........................');
const packDir = mkdtempSync(join(tmpdir(), 'filelayer-pack-'));
const packed = run('npm', ['pack', '--pack-destination', packDir, '--silent'], { cwd: CORE });
if (packed.status !== 0) die('pack', packed.stderr || packed.stdout);
const tarballName = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
if (!tarballName) die('pack', 'npm pack produced no tarball in ' + packDir);
const tarball = join(packDir, tarballName);
console.log(' ok  (' + tarballName + ')');

// --- 2. an empty directory ---------------------------------------------------
process.stdout.write('   1. npm install into an empty directory ..........');
const consumer = mkdtempSync(join(tmpdir(), 'filelayer-consumer-'));
mkdirSync(consumer, { recursive: true });
// A consumer has a package.json; they do not have our repository. Nothing here
// references ROOT, and npm is run with `--no-package-lock --ignore-scripts` so
// the install cannot reach back into the source tree or run our build.
writeFileSync(
  join(consumer, 'package.json'),
  JSON.stringify({ name: 'filelayer-consumer', private: true, version: '0.0.0', type: 'module' }, null, 2) + '\n',
);
const install = run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball], {
  cwd: consumer,
  env: { ...process.env, npm_config_update_notifier: 'false' },
});
if (install.status !== 0) die('npm install (from the packed tarball)', install.stderr || install.stdout);
console.log(' ok');

// --- 3. run the consumer program ---------------------------------------------
writeFileSync(join(consumer, 'flow.mjs'), FLOW);
const flow = run(process.execPath, ['flow.mjs'], {
  cwd: consumer,
  stdio: 'inherit',
  // Deliberately NOT inheriting NODE_PATH or NODE_OPTIONS: no path back here.
  env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
});

if (!KEEP) {
  rmSync(packDir, { recursive: true, force: true });
  rmSync(consumer, { recursive: true, force: true });
} else {
  console.log(`(kept: ${consumer}, ${tarball})`);
}

if (flow.status !== 0) {
  console.error(`\nverify-release: FAILED (consumer program exited ${flow.status})\n`);
  process.exit(flow.status ?? 1);
}
process.exit(0);
