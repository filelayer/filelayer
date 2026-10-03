/**
 * TIER 3 -- organizations, roles, private files.
 *
 * Two concepts added: a tenant (`org:`) and a role. Sharing, expiry, download
 * caps and audit (tier 4) still do not appear.
 *
 * Note what did NOT change from tier 2: `put` and `get` have the same shape.
 * Promoting an app from "user files" to "multi-tenant" is adding `org:` to a
 * call, not migrating a data model -- which is the property the whole tier
 * exercise exists to demonstrate.
 *
 * Run: npm --prefix packages/core run example:tier3
 */

import { Filelayer } from '../../packages/core/src/index.ts';

export async function tier3(fl: Filelayer) {
  await fl.orgs.create('acme', { name: 'Acme Inc', owner: 'ceo' });
  await fl.orgs.setRole('acme', 'analyst', 'member', { as: 'ceo' });
  await fl.orgs.setRole('acme', 'auditor', 'viewer', { as: 'ceo' });

  const deck = new TextEncoder().encode('Q4 board deck');
  const { id: privateId } = await fl.files.put(deck, { org: 'acme', owner: 'ceo' });

  const handbook = new TextEncoder().encode('Employee handbook');
  const { id: sharedId } = await fl.files.put(handbook, {
    org: 'acme',
    owner: 'ceo',
    visibility: 'org', // every member may read; the default is `private`
  });

  return { privateId, sharedId };
}

// --- boot --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const fl = await Filelayer.quickstart();
  const { privateId, sharedId } = await tier3(fl);
  const ok = async (p: Promise<unknown>) => p.then(() => 'read').catch(() => 'denied');
  console.log('analyst -> board deck     :', await ok(fl.files.get(privateId, { as: 'analyst' })));
  console.log('analyst -> handbook       :', await ok(fl.files.get(sharedId, { as: 'analyst' })));
  console.log('auditor  -> handbook      :', await ok(fl.files.get(sharedId, { as: 'auditor' })));
  console.log('ceo      -> board deck    :', await ok(fl.files.get(privateId, { as: 'ceo' })));
}
