/**
 * A MEMBER SHARES A COLLEAGUE'S FILE: refused by default, allowed by one grant.
 *
 * The case the productivity pilot of 26 Nov 2026 found untested and
 * undocumented on the agent surfaces: two agent-built apps called
 * `share()` as a member on a file another member uploaded, got 404, and
 * shipped; a third split the grant in two and got 403. README, llms.txt, the
 * integration skill and QUICKSTART now state the rule and the recipe; these
 * tests are what those paragraphs rest on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Filelayer } from '../src/filelayer.ts';

const utf8 = (s: string) => new TextEncoder().encode(s);

async function world() {
  const fl = await Filelayer.quickstart();
  await fl.orgs.create('acme', { owner: 'olga' });
  await fl.orgs.setRole('acme', 'alice', 'member', { as: 'olga' });
  await fl.orgs.setRole('acme', 'bob', 'member', { as: 'olga' });
  await fl.orgs.setRole('acme', 'vic', 'viewer', { as: 'olga' });
  const put = (name: string) => fl.files.put(utf8(name), { org: 'acme', owner: 'alice', visibility: 'org', name });
  return { fl, put };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    const err = e as { status?: number; code?: string; reason?: string };
    return { status: err.status, code: err.code, reason: err.reason };
  }
};

test('by default a member reads a colleague\'s org-visible file and cannot share it', async () => {
  const { fl, put } = await world();
  try {
    const f = await put('q3.txt');
    assert.equal((await fl.files.get(f.id, { as: 'bob' })).name, 'q3.txt');
    assert.deepEqual(await refusal(fl.shares.create(f.id, { as: 'bob', expiresIn: 60 })), {
      status: 404,
      code: 'not_found',
      reason: 'insufficient_role',
    });
    // The uploader and an admin can.
    assert.ok((await fl.shares.create(f.id, { as: 'alice', expiresIn: 60 })).secret);
    assert.ok((await fl.shares.create(f.id, { as: 'olga', expiresIn: 60 })).secret);
  } finally {
    await fl.close();
  }
});

test('the recipe: one grant to the org with read and share lets members share, and viewers still cannot', async () => {
  const { fl, put } = await world();
  try {
    const f = await put('q3.txt');
    await fl.shares.create(f.id, { as: 'alice', withOrg: 'acme', minRole: 'member', capabilities: ['read', 'share'] });

    const link = await fl.shares.create(f.id, { as: 'bob', expiresIn: 60 });
    assert.ok(link.secret, 'bob, a member, shares alice\'s file');
    const got = await fl.shares.redeem(link.secret!);
    assert.equal(new TextDecoder().decode(got.body), 'q3.txt');

    assert.equal((await fl.files.get(f.id, { as: 'vic' })).name, 'q3.txt', 'a viewer still reads');
    assert.deepEqual(await refusal(fl.shares.create(f.id, { as: 'vic', expiresIn: 60 })), {
      status: 404,
      code: 'not_found',
      reason: 'insufficient_role',
    });

    // And the trail names the member who shared, not the uploader.
    const created = await fl.orgs.audit('acme', { as: 'olga', action: 'grant.create', user: 'bob' });
    assert.equal(created.filter((e) => e.decision === 'allow').length, 1);
  } finally {
    await fl.close();
  }
});

test('capabilities are not combined across grants: share without read cannot create a link', async () => {
  const { fl, put } = await world();
  try {
    const f = await put('q3.txt');
    await fl.shares.create(f.id, { as: 'alice', withOrg: 'acme', minRole: 'viewer', capabilities: ['read'] });
    await fl.shares.create(f.id, { as: 'alice', withOrg: 'acme', minRole: 'member', capabilities: ['share'] });
    assert.deepEqual(await refusal(fl.shares.create(f.id, { as: 'bob', expiresIn: 60 })), {
      status: 403,
      code: 'forbidden',
      reason: 'grant_capability_amplification',
    });
  } finally {
    await fl.close();
  }
});
