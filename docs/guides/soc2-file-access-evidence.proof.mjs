#!/usr/bin/env node
/**
 * THE RECORDS QUOTED IN `soc2-file-access-evidence.md`, REPRODUCIBLE.
 *
 *     node docs/guides/soc2-file-access-evidence.proof.mjs
 *
 * Runs the guide's code in the guide's order and prints the audit trail it
 * leaves after each section, which is what the guide quotes. PGlite runs
 * Postgres in-process, so nothing needs to be installed beyond the package and
 * `@electric-sql/pglite`. About five seconds.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file ships in the tarball, so it finds the library from a checkout or
// from an install, as the other proofs do.
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  join(HERE, '..', '..', 'packages', 'core', 'src', 'index.ts'), // the checkout
  join(HERE, '..', '..', 'src', 'index.ts'), // an install
];
const entry = process.env.FILELAYER_ENTRY ?? CANDIDATES.find(existsSync);
if (!entry) {
  console.error(`could not find the library from ${HERE}; looked in:\n  ${CANDIDATES.join('\n  ')}`);
  process.exit(1);
}
const { Filelayer } = await import(entry);

const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
let seen = 0;
const newLines = async () => {
  const all = await fl.orgs.audit('acme', { as: 'alice' });
  // The audit read is itself recorded; it is not part of what each section did.
  const lines = all.filter((e) => e.action !== 'audit.read').map((e) => e.summary.replace(/^\S+ /, ''));
  const fresh = lines.slice(seen);
  seen = lines.length;
  return fresh;
};

// ---- "Access is decided in one place, and refusals are recorded" ----------
await fl.orgs.create('acme', { owner: 'alice' });
await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
await fl.orgs.create('globex', { owner: 'eve' });
const { id } = await fl.files.put(new TextEncoder().encode('payroll'), {
  org: 'acme', owner: 'alice', name: 'payroll.csv',
});
assert.equal(await fl.files.get(id, { as: 'bob' }).catch((e) => e.status), 404);
assert.equal(await fl.files.get(id, { as: 'eve' }).catch((e) => e.status), 404);
const one = await newLines();
console.log('--- section 1 ---\n' + one.join('\n'));
assert.deepEqual(one.map((l) => l.split(' ').slice(0, 3).join(' ')), [
  'alice member.bootstrap allow',
  'alice member.add allow',
  'alice file.create allow',
  'bob file.read deny:insufficient_role',
  'eve file.read deny:no_membership',
]);

// ---- "Granting and removing access leaves a record of both" ---------------
await fl.shares.create(id, { as: 'alice', withUser: 'bob', expiresIn: 3600 });
assert.ok(await fl.files.get(id, { as: 'bob' }));
await fl.shares.unshare(id, { as: 'alice', user: 'bob' });
assert.equal(await fl.files.get(id, { as: 'bob' }).catch((e) => e.status), 404);
await fl.orgs.removeMember('acme', 'bob', { as: 'alice' });
const two = await newLines();
console.log('--- section 2 ---\n' + two.join('\n'));
for (const want of ['alice grant.create allow', 'bob file.read allow', 'alice grant.revoke allow', 'bob file.read deny:grant_revoked', 'alice member.remove allow']) {
  assert.ok(two.some((l) => l.startsWith(want)), `section 2 records "${want}"`);
}

// ---- "Showing that the record was not edited" -----------------------------
const result = await fl.orgs.verifyAudit('acme', { as: 'alice' });
console.log('--- section 3 ---\nverifyAudit:', JSON.stringify({ valid: result.valid, checked: result.checked, attestedGaps: result.attestedGaps }));
assert.equal(result.valid, true);
assert.equal(result.attestedGaps, 0);

// Reading the trail is admin or owner only.
await assert.rejects(fl.orgs.audit('acme', { as: 'eve' }), (e) => e.status === 404 || e.status === 403);
await fl.orgs.setRole('acme', 'carol', 'member', { as: 'alice' });
await assert.rejects(fl.orgs.audit('acme', { as: 'carol' }), (e) => e.status === 404 || e.status === 403);

console.log('\nsoc2-file-access-evidence proof: every record the guide quotes was produced.');
