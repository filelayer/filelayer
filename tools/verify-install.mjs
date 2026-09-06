#!/usr/bin/env node
/**
 * Prove that a CONSUMER can use the packed package.
 *
 *   node tools/verify-install.mjs <dir-containing-node_modules/@filelayer/core>
 *
 * Everything here is done the way an application would do it: resolve
 * `@filelayer/core` by specifier from the consumer's directory, not by path
 * into this repository. Running `npm test` inside the source tree cannot fail
 * the way an install fails, which is exactly how the package came to be
 * publishable and unusable:
 *
 *   * `exports` pointed at `./src/index.ts`, and Node refuses to strip types
 *     from files under node_modules -- so every import threw
 *     ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING;
 *   * `schema.sql` has to be resolvable from the installed layout, or nobody
 *     can provision a database;
 *   * the `.d.ts` files have to be where `types` says they are, or every
 *     TypeScript consumer sees `any`.
 *
 * This asserts all three, plus one end-to-end round trip through the real
 * authorization engine against real (in-process) Postgres.
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const consumerDir = resolve(process.argv[2] ?? process.cwd());
const require = createRequire(pathToFileURL(join(consumerDir, 'index.js')));

function step(name) {
  process.stdout.write(`  ${name} ... `);
}
function ok() {
  process.stdout.write('ok\n');
}

console.log(`verify-install: consumer directory ${consumerDir}`);

// --- 1. the specifier resolves, and to compiled JavaScript -------------------
step('resolve "@filelayer/core"');
const entry = require.resolve('@filelayer/core');
assert.match(entry, /\.js$/, `entry point must be JavaScript, got ${entry}`);
assert.match(entry, /node_modules/, 'must be resolving the installed copy');
ok();

// --- 2. it imports ----------------------------------------------------------
step('import it');
const core = await import(pathToFileURL(entry).href);
ok();

// --- 3. the public API is present -------------------------------------------
step('public API surface');
for (const name of [
  'Filelayer',
  'FilelayerError',
  'MemoryStorage',
  'S3Storage',
  'PostgresStore',
  'authorize',
  'fileDownloadRoute',
  'shareDownloadRoute',
  'toResponse',
  'createTestDb',
  'loadSchemaSql',
  'SCHEMA_PATH',
]) {
  assert.ok(name in core, `missing export: ${name}`);
}
ok();

// --- 4. type declarations shipped and point at something --------------------
step('type declarations');
const pkgPath = require.resolve('@filelayer/core/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const pkgRoot = pkgPath.replace(/[/\\]package\.json$/, '');
assert.ok(pkg.types, '"types" is not declared');
assert.ok(existsSync(join(pkgRoot, pkg.types)), `"types" points at a missing file: ${pkg.types}`);
assert.ok(
  readFileSync(join(pkgRoot, pkg.types), 'utf8').includes('export'),
  'the root declaration file exports nothing',
);
ok();

// --- 5. schema.sql is reachable ---------------------------------------------
step('schema.sql is reachable from the install');
assert.ok(existsSync(core.SCHEMA_PATH), `SCHEMA_PATH does not exist: ${core.SCHEMA_PATH}`);
const sql = await core.loadSchemaSql();
assert.ok(sql.includes('CREATE TABLE project'), 'schema.sql does not look like the schema');
assert.ok(
  existsSync(join(pkgRoot, 'schema.sql')),
  'schema.sql is not at the package root, so `psql -f node_modules/@filelayer/core/schema.sql` is a lie',
);
ok();

// --- 6. it actually works ---------------------------------------------------
step('end-to-end: put, read, deny, publish, unpublish');
const fl = await core.Filelayer.quickstart({ baseUrl: 'https://example.test' });
const body = new TextEncoder().encode('installed-and-working');

const priv = await fl.files.put(body, { owner: 'user_a', name: 'private.txt' });
const got = await fl.files.get(priv.id, { as: 'user_a' });
assert.equal(new TextDecoder().decode(got.body), 'installed-and-working');
assert.ok(got.headers['x-content-type-options'], 'delivery headers are missing');

await assert.rejects(
  () => fl.files.get(priv.id, { as: 'user_b' }),
  (e) => e instanceof core.FilelayerError && e.status === 404,
  'a stranger must get a 404',
);

const pub = await fl.files.put(body, { public: true, name: 'avatar.png' });
assert.ok(pub.url, 'a public put must return a URL');
await fl.files.get(pub.id); // anonymous read of a published file
await fl.files.unpublish(pub.id);
await assert.rejects(
  () => fl.files.get(pub.id),
  (e) => e instanceof core.FilelayerError && e.status === 404,
  'unpublish must take the anonymous read away',
);
ok();

console.log('\nverify-install: PASS — the packed tarball installs, imports and works.\n');
