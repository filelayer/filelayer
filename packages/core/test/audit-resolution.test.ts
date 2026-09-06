/**
 * "WHO TOUCHED THIS?" -- ANSWERED IN THE CALLER'S OWN WORDS.
 *
 * THE DEFECT. `auditLog()` answered the marquee question in internal uuids and
 * shipped no public way back. A developer who wrote `as: 'marco'` and
 * `org: 'acme'` got `97cf1649-dd8...` back and had to read `schema.sql`, find
 * the `actor` table and write SQL against it to turn the answer into the words
 * they had used ninety seconds earlier. It cost the first developer to try it
 * about eight minutes, on the one step the product exists to make good.
 *
 * WHAT THIS SUITE HOLDS DOWN. Six things, in the order they would be missed:
 *
 *   1. The answer is legible. The external ids the caller supplied come back,
 *      for the actor, the file and the org.
 *   2. The internal ids are still there, unchanged. This was additive; anything
 *      already reading `actorId` keeps working.
 *   3. A denial carries its reason AND the actor who was refused. This is the
 *      value moment -- `reason=grant_revoked` while the link still had six days
 *      of validity left -- and it is the row most likely to be read by a human
 *      under time pressure.
 *   4. Anonymous access says `anonymous`, not `null`. A link redemption has no
 *      actor; the answer must say so rather than hand back a null and leave the
 *      caller to decide what it meant.
 *   5. The system chain (`org_id IS NULL`) resolves rather than throwing.
 *   6. Resolution is project-scoped (P8) and costs ONE query, not N+1.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { DEFAULT_PROJECT_ID } from '../src/store.ts';
import { bytes, rejects } from './helpers.ts';

const CONTRACT = bytes('a contract nobody else may read');

/**
 * The scenario the first outside developer built, reduced to the parts that
 * bear on the audit answer.
 *
 * alice owns `acme`; `contract.pdf` is private in it; an external share link
 * carries seven days of validity and a cap of three; marco -- a named member --
 * is separately given read. Both are then revoked and both are refused. That
 * second refusal is the value moment: the reason is `grant_revoked` while the
 * link still has six days and two opens left.
 */
async function scenario(fl: Filelayer) {
  await fl.orgs.create('acme', { owner: 'alice' });
  const file = await fl.files.put(CONTRACT, {
    org: 'acme',
    owner: 'alice',
    name: 'contract.pdf',
    contentType: 'application/pdf',
  });

  // The external share link, redeemed once, then revoked.
  const link = await fl.shares.create(file.id, {
    as: 'alice',
    expiresIn: 7 * 86400,
    maxDownloads: 3,
  });
  await fl.shares.redeem(link.secret!);
  await fl.shares.revoke(link.grantId, { as: 'alice' });
  await rejects(() => fl.shares.redeem(link.secret!), 404);

  // The named recipient, who reads it, then loses it.
  await fl.orgs.setRole('acme', 'marco', 'member', { as: 'alice' });
  const direct = await fl.shares.create(file.id, { as: 'alice', withUser: 'marco' });
  await fl.files.get(file.id, { as: 'marco' });
  await fl.shares.revoke(direct.grantId, { as: 'alice' });
  await rejects(() => fl.files.get(file.id, { as: 'marco' }), 404);

  return { file, link, direct };
}

// =============================================================================
// 1. THE ANSWER IS LEGIBLE
// =============================================================================

describe('auditLog answers in the identifiers the caller supplied', () => {
  it('names marco, contract.pdf and acme -- not three uuids', async () => {
    const fl = await Filelayer.quickstart();
    const { file } = await scenario(fl);

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    assert.ok(log.length > 0, 'the trail is empty');

    // The external ids the developer actually typed are in the answer.
    const actors = new Set(log.map((e) => e.actor.label));
    assert.ok(actors.has('marco'), `no "marco" in the trail, got ${[...actors].join(', ')}`);
    assert.ok(actors.has('alice'));
    assert.ok(
      log.every((e) => e.org.label === 'acme'),
      'every event in acme\'s chain should say acme',
    );
    assert.ok(
      log.some((e) => e.file.label === 'contract.pdf'),
      'the file is never named',
    );

    // ...and they are on the typed fields, not only in the summary line.
    const marco = log.find((e) => e.actor.externalId === 'marco')!;
    assert.ok(marco, 'no event carries marco as an external id');
    assert.equal(marco.actor.resolution, 'resolved');
    assert.equal(marco.org.externalId, 'acme');
    assert.equal(marco.org.resolution, 'resolved');
  });

  it('keeps every internal id it has always returned, unchanged', async () => {
    // This is a PRESENTATION change. Something downstream may well be keyed on
    // the uuids, and replacing them rather than joining them would be a
    // breaking change wearing a usability costume.
    const fl = await Filelayer.quickstart();
    const { file } = await scenario(fl);

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const plain = await fl.store.listAudit(
      (await fl.store.db.query<{ id: string }>(
        `SELECT id FROM org WHERE external_id = 'acme'`,
      )).rows[0]!.id,
    );

    assert.equal(log.length, plain.length);
    for (let i = 0; i < log.length; i++) {
      const a = log[i]!;
      const b = plain[i]!;
      assert.equal(a.id, b.id);
      assert.equal(a.actorId, b.actorId, 'actorId must still be the uuid');
      assert.equal(a.fileId, b.fileId);
      assert.equal(a.orgId, b.orgId);
      assert.equal(a.hash, b.hash, 'the chain digest is untouched by presentation');
      // and the resolved view agrees with the id it was resolved from
      assert.equal(a.actor.id, b.actorId);
      assert.equal(a.file.id, b.fileId);
      assert.equal(a.org.id, b.orgId);
    }

    // The chain still verifies -- nothing here writes.
    assert.equal((await fl.orgs.verifyAudit('acme', { as: 'alice' })).valid, true);
    assert.ok(file.id);
  });

  it('every row prints without a null, an undefined or a uuid in it', async () => {
    const fl = await Filelayer.quickstart();
    await scenario(fl);
    const log = await fl.orgs.audit('acme', { as: 'alice' });

    for (const e of log) {
      assert.equal(typeof e.summary, 'string');
      assert.ok(e.summary.length > 0);
      assert.ok(!/\bundefined\b|\bnull\b/.test(e.summary), `unprintable summary: ${e.summary}`);
      for (const ref of [e.actor, e.file, e.org]) {
        assert.equal(typeof ref.label, 'string', 'a label may never be null');
        assert.ok(ref.label.length > 0);
      }
    }
  });
});

// =============================================================================
// 2. THE VALUE MOMENT: A DENIAL, ITS REASON, AND WHO WAS REFUSED
// =============================================================================

describe('a denial names the reason and the principal who was refused', () => {
  it('the revoked link reads as deny:grant_revoked against contract.pdf in acme', async () => {
    const fl = await Filelayer.quickstart();
    await scenario(fl);

    const denials = await fl.orgs.audit('acme', { as: 'alice', decision: 'deny' });
    const refusal = denials.find((e) => e.reason === 'grant_revoked');
    assert.ok(refusal, `no grant_revoked denial; reasons: ${denials.map((d) => d.reason)}`);
    assert.equal(refusal.decision, 'deny');
    assert.equal(refusal.file.label, 'contract.pdf');
    assert.equal(refusal.file.name, 'contract.pdf');
    assert.equal(refusal.org.label, 'acme');
    // The link had no actor behind it, and the row says so out loud.
    assert.equal(refusal.actor.label, 'anonymous');

    // The one line an operator reads under time pressure.
    assert.match(
      refusal.summary,
      /^\S+ anonymous file\.read deny:grant_revoked contract\.pdf @acme$/,
      `summary reads: ${refusal.summary}`,
    );
  });

  it('a NAMED principal who is refused is named, with the reason', async () => {
    const fl = await Filelayer.quickstart();
    await scenario(fl);

    const denials = await fl.orgs.audit('acme', { as: 'alice', decision: 'deny' });
    const marco = denials.find((e) => e.actor.externalId === 'marco');
    assert.ok(marco, 'marco was refused and the log does not say it was marco');
    assert.equal(marco.actor.label, 'marco');
    assert.equal(marco.actor.resolution, 'resolved');
    assert.equal(marco.actor.id, marco.actorId, 'the uuid is still there beside the name');
    assert.ok(marco.reason, 'a denial with no reason answers nothing');
    assert.equal(marco.file.label, 'contract.pdf');
    assert.match(marco.summary, new RegExp(` marco file\\.read deny:${marco.reason} `));
  });

  it('filtering by decision still narrows, and every denial is legible', async () => {
    const fl = await Filelayer.quickstart();
    await scenario(fl);
    const denials = await fl.orgs.audit('acme', { as: 'alice', decision: 'deny' });
    assert.ok(denials.length >= 2);
    assert.ok(denials.every((e) => e.decision === 'deny'));
    assert.ok(denials.every((e) => e.summary.includes('deny:')));
  });
});

// =============================================================================
// 3. ANONYMOUS IS A FACT, NOT A MISSING VALUE
// =============================================================================

describe('access with no actor is represented honestly', () => {
  it('a share-link redemption reads as `anonymous`, not as null', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'alice' });
    const file = await fl.files.put(CONTRACT, {
      org: 'acme',
      owner: 'alice',
      name: 'contract.pdf',
    });
    const share = await fl.shares.create(file.id, { as: 'alice', maxDownloads: 3 });
    await fl.shares.redeem(share.secret!);

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const anon = log.filter((e) => e.actorId === null);
    assert.ok(anon.length > 0, 'the redemption left no actor-less event');

    for (const e of anon) {
      assert.equal(e.actor.id, null);
      assert.equal(e.actor.externalId, null, 'nothing may be invented for a link');
      assert.equal(e.actor.label, 'anonymous');
      assert.equal(e.actor.resolution, 'anonymous');
      assert.ok(e.summary.includes(' anonymous '), e.summary);
    }
  });

  it('an event that is not about a file says so, and no file label is fabricated', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'alice' });
    await fl.orgs.setRole('acme', 'marco', 'member', { as: 'alice' });

    const log = await fl.orgs.audit('acme', { as: 'alice' });
    const membership = log.find((e) => e.action === 'member.add' && e.fileId === null);
    assert.ok(membership, 'no fileless member.add event');
    assert.equal(membership.file.id, null);
    assert.equal(membership.file.name, null);
    assert.equal(membership.file.label, 'none');
    assert.equal(membership.file.resolution, 'none');
    // ...and the summary simply omits it rather than printing "none".
    assert.ok(!membership.summary.includes(' none '), membership.summary);
  });
});

// =============================================================================
// 4. THE SYSTEM CHAIN HAS NO TENANT AND MUST NOT CRASH
// =============================================================================

describe('the system chain (org_id IS NULL) resolves rather than throwing', () => {
  it('reads back with org.label = "system"', async () => {
    const fl = await Filelayer.quickstart();
    await fl.orgs.create('acme', { owner: 'alice' });
    // A sweep against a link secret that resolves to nothing: no file, no
    // tenant. This is exactly the event that has no org to name.
    await rejects(() => fl.shares.redeem('not-a-real-secret'), 404);

    const system = await fl.store.listAuditResolved(null);
    assert.ok(system.length > 0, 'the probe was not recorded on the system chain');
    for (const e of system) {
      assert.equal(e.orgId, null);
      assert.equal(e.org.id, null);
      assert.equal(e.org.externalId, null);
      assert.equal(e.org.label, 'system');
      assert.equal(e.org.resolution, 'system');
      assert.ok(e.summary.endsWith('@system'), e.summary);
    }
  });
});

// =============================================================================
// 5. P8: RESOLUTION MAY NOT CROSS A PROJECT BOUNDARY
// =============================================================================

describe('resolution is scoped to the project, like every other read', () => {
  it('an id belonging to another customer resolves to nothing, not to their word for it', async () => {
    // An audit event may legitimately name an identifier from outside the
    // project -- a probe at a uuid that belongs to another application. If the
    // join were unscoped, tenant A's audit log would print tenant B's customer
    // vocabulary back at them, which is P8 reopened on a presentation axis.
    const { db } = await createTestDb();
    const storage = new MemoryStorage();
    const a = new Filelayer(db, storage, { baseUrl: 'https://a.test' });
    const pb = (await a.createProject('customer-b', 'Customer B')).id;
    const b = new Filelayer(db, storage, { baseUrl: 'https://b.test', projectId: pb });

    await a.orgs.create('acme', { owner: 'alice' });
    const fileA = await a.files.put(bytes('A CONFIDENTIAL'), {
      org: 'acme',
      owner: 'alice',
      name: 'contract.pdf',
    });

    // Customer B has their own 'mallory'. Their uuid is a perfectly well-formed
    // id, and presenting it against customer A's file is a denial that A's log
    // must record -- by uuid.
    await b.orgs.create('bcorp', { owner: 'mallory' });
    const mallory = (
      await db.query<{ id: string }>(
        `SELECT id FROM actor WHERE external_id = 'mallory' AND project_id = $1`,
        [pb],
      )
    ).rows[0]!.id;

    await rejects(() => a.read({ actorId: mallory }, fileA.id), 404);

    const denials = await a.orgs.audit('acme', { as: 'alice', decision: 'deny' });
    const probe = denials.find((e) => e.actorId === mallory);
    assert.ok(probe, 'the cross-project probe was not recorded in acme\'s chain');
    assert.equal(probe.actor.externalId, null, 'another customer\'s id space leaked');
    assert.notEqual(probe.actor.label, 'mallory');
    assert.equal(probe.actor.label, mallory, 'an unresolvable id keeps its uuid');
    assert.equal(probe.actor.resolution, 'unresolved');

    // The same must hold from B's side for A's identifiers.
    assert.equal(a.projectId, DEFAULT_PROJECT_ID);
    assert.equal(b.projectId, pb);
  });
});

// =============================================================================
// 6. ONE QUERY, NOT N+1
// =============================================================================

describe('the resolved read costs one query', () => {
  it('a trail of many events is still a single statement', async () => {
    const { db } = await createTestDb();
    let recording = false;
    const seen: string[] = [];
    const counting: Queryable = {
      query: (sql, params) => {
        if (recording) seen.push(sql);
        return db.query(sql, params);
      },
      ...(db.withTransaction ? { withTransaction: db.withTransaction.bind(db) } : {}),
    };
    const fl = new Filelayer(counting, new MemoryStorage(), { baseUrl: 'https://one.test' });

    await fl.orgs.create('acme', { owner: 'alice' });
    for (let i = 0; i < 12; i++) {
      const f = await fl.files.put(bytes(`doc ${i}`), {
        org: 'acme',
        owner: 'alice',
        name: `doc-${i}.txt`,
      });
      await fl.files.get(f.id, { as: 'alice' });
    }

    const orgId = (
      await db.query<{ id: string }>(`SELECT id FROM org WHERE external_id = 'acme'`)
    ).rows[0]!.id;

    recording = true;
    const log = await fl.store.listAuditResolved(orgId);
    recording = false;

    assert.ok(log.length >= 24, `expected a substantial trail, got ${log.length}`);
    assert.equal(
      seen.length,
      1,
      `resolution issued ${seen.length} statements for ${log.length} rows -- this is the N+1 the joins exist to avoid`,
    );
    assert.match(seen[0]!, /LEFT JOIN/);
  });
});
