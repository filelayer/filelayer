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

test('the link a member creates through the recipe is a child of the org grant', async () => {
  const { fl, put } = await world();
  try {
    const f = await put('q3.txt');
    const orgGrant = await fl.shares.create(f.id, {
      as: 'alice',
      withOrg: 'acme',
      minRole: 'member',
      capabilities: ['read', 'share'],
    });
    const link = await fl.shares.create(f.id, { as: 'bob', expiresIn: 60 });
    assert.equal(link.parentGrantId, orgGrant.grantId);
    // Admins and owners are "member and above" too, and do not need the grant: they share by role.
    assert.equal((await fl.shares.create(f.id, { as: 'olga', expiresIn: 60 })).parentGrantId, null);
  } finally {
    await fl.close();
  }
});

test('a grant of the member\'s own, or an older one to the org, with share and no read still refuses with the org grant in place', async () => {
  const { fl, put } = await world();
  try {
    const f = await put('q3.txt');
    // First, and so older: a grant to bob himself with `share` alone.
    await fl.shares.create(f.id, { as: 'alice', withUser: 'bob', capabilities: ['share'] });
    // Then the correct org grant.
    await fl.shares.create(f.id, { as: 'alice', withOrg: 'acme', minRole: 'member', capabilities: ['read', 'share'] });
    assert.deepEqual(await refusal(fl.shares.create(f.id, { as: 'bob', expiresIn: 60 })), {
      status: 403,
      code: 'forbidden',
      reason: 'grant_capability_amplification',
    });
    // Removing the older grant is the fix: the org grant then supplies both.
    await fl.shares.unshare(f.id, { as: 'alice', user: 'bob' });
    assert.ok((await fl.shares.create(f.id, { as: 'bob', expiresIn: 60 })).secret);

    // The member's own grants come before grants to an org whatever their age:
    // the same grant issued AFTER the org grant refuses the same way.
    await fl.shares.create(f.id, { as: 'alice', withUser: 'bob', capabilities: ['share'] });
    assert.equal((await refusal(fl.shares.create(f.id, { as: 'bob', expiresIn: 60 })))?.reason, 'grant_capability_amplification');

    // Between two grants to the org, the older one is used.
    const g = await put('older-org-grant.txt');
    await fl.shares.create(g.id, { as: 'alice', withOrg: 'acme', capabilities: ['share'] });
    await fl.shares.create(g.id, { as: 'alice', withOrg: 'acme', minRole: 'member', capabilities: ['read', 'share'] });
    assert.equal((await refusal(fl.shares.create(g.id, { as: 'bob', expiresIn: 60 })))?.reason, 'grant_capability_amplification');
    const h = await put('newer-org-grant.txt');
    await fl.shares.create(h.id, { as: 'alice', withOrg: 'acme', minRole: 'member', capabilities: ['read', 'share'] });
    await fl.shares.create(h.id, { as: 'alice', withOrg: 'acme', capabilities: ['share'] });
    assert.ok((await fl.shares.create(h.id, { as: 'bob', expiresIn: 60 })).secret);
  } finally {
    await fl.close();
  }
});

test('files uploaded before the recipe: an admin issues the org grant, nobody acts as the uploader', async () => {
  const { fl, put } = await world();
  try {
    const f = await put('old.txt');
    const orgGrant = await fl.shares.create(f.id, {
      as: 'olga',
      withOrg: 'acme',
      minRole: 'member',
      capabilities: ['read', 'share'],
    });
    assert.equal(orgGrant.parentGrantId, null, 'issued on the admin\'s role, not delegated');
    assert.ok((await fl.shares.create(f.id, { as: 'bob', expiresIn: 60 })).secret);
  } finally {
    await fl.close();
  }
});

test('what the recipe hands every member, and how the org grant bounds it', async () => {
  const { fl, put } = await world();
  try {
    // Unbounded org grant: a member's link has no expiry and no cap unless the member sets one,
    // a member can pass read and share to somebody outside the org, and that person can share on.
    const open = await put('open.txt');
    await fl.shares.create(open.id, { as: 'alice', withOrg: 'acme', minRole: 'member', capabilities: ['read', 'share'] });
    const forever = await fl.shares.create(open.id, { as: 'bob' });
    assert.equal(forever.expiresAt, null);
    assert.equal(forever.maxDownloads, null);
    await fl.shares.create(open.id, { as: 'bob', withUser: 'outsider', capabilities: ['read', 'share'] });
    const onward = await fl.shares.create(open.id, { as: 'outsider' });
    assert.ok(onward.secret, 'somebody who is not in the org shares on');

    // What bob issued outlives his membership.
    await fl.orgs.removeMember('acme', 'bob', { as: 'olga' });
    assert.equal(new TextDecoder().decode((await fl.shares.redeem(forever.secret!)).body), 'open.txt');
    assert.equal(new TextDecoder().decode((await fl.shares.redeem(onward.secret!)).body), 'open.txt');

    // Bounded org grant: every child, however deep, ends when the org grant ends.
    const bounded = await put('bounded.txt');
    const parent = await fl.shares.create(bounded.id, {
      as: 'alice',
      withOrg: 'acme',
      minRole: 'member',
      capabilities: ['read', 'share'],
      expiresIn: 3600,
    });
    await fl.orgs.setRole('acme', 'carol', 'member', { as: 'olga' });
    const capped = await fl.shares.create(bounded.id, { as: 'carol' });
    assert.ok(capped.expiresAt && parent.expiresAt);
    assert.ok(new Date(capped.expiresAt!).getTime() <= new Date(parent.expiresAt!).getTime());
    const longer = await fl.shares.create(bounded.id, { as: 'carol', expiresIn: 86400 });
    assert.ok(new Date(longer.expiresAt!).getTime() <= new Date(parent.expiresAt!).getTime());

    // Revoking the org grant stops what came from it.
    await fl.shares.redeem(capped.secret!);
    await fl.shares.revoke(parent.grantId, { as: 'alice' });
    assert.equal((await refusal(fl.shares.redeem(capped.secret!)))?.status, 404);

    // maxDownloads on the org grant is one budget for everything under it.
    const budget = await put('budget.txt');
    await fl.shares.create(budget.id, {
      as: 'alice',
      withOrg: 'acme',
      minRole: 'member',
      capabilities: ['read', 'share'],
      maxDownloads: 2,
    });
    const one = await fl.shares.create(budget.id, { as: 'carol' });
    const two = await fl.shares.create(budget.id, { as: 'carol', maxDownloads: 100 });
    assert.equal(two.maxDownloads, 2);
    await fl.shares.redeem(one.secret!);
    await fl.shares.redeem(two.secret!);
    assert.equal((await refusal(fl.shares.redeem(one.secret!)))?.status, 404);

    // withOrg is not held to the file's own org: another org of the project gets the file.
    await fl.orgs.create('globex', { owner: 'gina' });
    const other = await put('other-org.txt');
    await fl.shares.create(other.id, { as: 'alice', withOrg: 'globex', capabilities: ['read'] });
    assert.equal((await fl.files.get(other.id, { as: 'gina' })).name, 'other-org.txt');
  } finally {
    await fl.close();
  }
});
