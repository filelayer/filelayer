/**
 * GROUP GRANT SUBJECTS -- RFC-001.
 *
 *     grant_subject := actor | org | role | link | anonymous
 *
 * A grant's subject is a PRINCIPAL SET. `org` and `role` are the missing middle
 * between "one person" and "everyone", and they are resolved BY JOIN against
 * `membership`, never by fanning a group out into per-member rows.
 *
 * The invariants this file asserts, in the order the RFC states them:
 *
 *   I1/P3/P8  the subject org must be in the same PROJECT as the file, by
 *             composite foreign key. Cross-ORG within a project is legal and is
 *             the point; cross-PROJECT is unrepresentable.
 *   I2/P7     a grant is live only while its subject org is live.
 *   I3/P4     group grants are ordinary rows: revocable, delegable, and killed
 *             transitively by revoking an ancestor.
 *   I4/P5     `via` gains `grant:org` / `grant:role`, and the audit event names
 *             the membership that conferred access.
 *   I5/P1     there is still no boolean anywhere that opens a file to a
 *             population.
 *   I6        DELEGATION MAY ATTENUATE AUTHORITY BUT MAY NEVER AMPLIFY SUBJECT
 *             BREADTH. Enforced in the engine AND in the kernel, so it binds a
 *             caller issuing raw SQL. Tested both ways, every case.
 *
 * ...and the property the whole design exists for:
 *
 *   MEMBERSHIP CHANGES CHANGE ACCESS ON THE NEXT REQUEST, WITHOUT
 *   RECOMPUTATION. Asserted by comparing every `file_grant` row before and
 *   after a join and a leave: not one row is written, updated, or touched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authorize,
  DELEGABLE_SUBJECT_TYPES,
  type GrantSubjectType,
  type OrgRole,
} from '../src/authz.ts';
import { createTestDb } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { newWorld, bytes, rejects, dbRejects, type World } from './helpers.ts';

const ROLES: OrgRole[] = ['viewer', 'member', 'admin', 'owner'];

/**
 * Two orgs in ONE project: `home` owns the document, `partner` is the other
 * company. This is the shape of every case the RFC opens with -- the job board,
 * the client portal, the supplier -- and it is the shape a synthetic robot actor
 * plus an impedance-matching table used to be needed for.
 */
interface TwoOrgs extends World {
  alice: string; // owner of `home`
  home: string;
  bosses: string; // owner of `partner`
  partner: string;
  members: Record<OrgRole, string>; // one actor of `partner` at each role
  fileId: string;
}

async function twoOrgs(): Promise<TwoOrgs> {
  const w = await newWorld();
  const alice = (await w.fl.createActor('alice')).id;
  const bosses = (await w.fl.createActor('bosses')).id;
  const home = (await w.fl.createOrg('home', 'Home', { ownerActorId: alice })).id;
  const partner = (await w.fl.createOrg('partner', 'Partner', { ownerActorId: bosses })).id;

  const members = {} as Record<OrgRole, string>;
  for (const role of ROLES) {
    if (role === 'owner') {
      members.owner = bosses;
      continue;
    }
    const id = (await w.fl.createActor(`partner-${role}`)).id;
    await w.fl.addMember({ actorId: bosses }, partner, id, role);
    members[role] = id;
  }

  const file = await w.fl.upload({ actorId: alice }, home, {
    name: 'cv.pdf',
    contentType: 'application/pdf',
    body: bytes('CONFIDENTIAL CV'),
    // private throughout: nothing here may be explained by the role path.
    visibility: 'private',
  });

  return { ...w, alice, home, bosses, partner, members, fileId: file.id };
}

const can = async (w: World, actorId: string | null, fileId: string, cap = 'read' as const) =>
  (await authorize(w.fl.store, { actorId }, fileId, cap)).allow;

/** Every column of every grant row, ordered -- a fingerprint of the table. */
async function grantSnapshot(w: World): Promise<string> {
  const { rows } = await w.db.query<{ s: string | null }>(
    `SELECT coalesce(string_agg(t.r, '|' ORDER BY t.r), '') AS s
       FROM (SELECT g::text AS r FROM file_grant g) t`,
  );
  return rows[0]!.s ?? '';
}

// =============================================================================
// THE SUBJECT TYPES THEMSELVES
// =============================================================================

describe('RFC-001: org and role are grant subjects, not a new mechanism', () => {
  it('an `org` grant reaches EVERY member of the named org, at any role', async () => {
    const w = await twoOrgs();
    for (const role of ROLES) {
      assert.equal(await can(w, w.members[role], w.fileId), false, `${role} before the grant`);
    }
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    for (const role of ROLES) {
      assert.equal(await can(w, w.members[role], w.fileId), true, `${role} after the grant`);
    }
    // ...and nobody else. An actor in no org matches nothing.
    const stranger = (await w.fl.createActor('stranger')).id;
    assert.equal(await can(w, stranger, w.fileId), false);
    assert.equal(await can(w, null, w.fileId), false, 'anonymous matched a group grant');
  });

  it('a `role` grant applies the floor, and the floor is a threshold over the existing enum', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'admin' },
    });
    assert.equal(await can(w, w.members.viewer, w.fileId), false);
    assert.equal(await can(w, w.members.member, w.fileId), false);
    assert.equal(await can(w, w.members.admin, w.fileId), true);
    assert.equal(await can(w, w.members.owner, w.fileId), true);
  });

  it('every floor behaves as "that role or above", exhaustively', async () => {
    for (const floor of ROLES) {
      const w = await twoOrgs();
      await w.fl.share({ actorId: w.alice }, w.fileId, {
        subject: { type: 'role', orgId: w.partner, minRole: floor },
      });
      const rank = ROLES.indexOf(floor);
      for (const held of ROLES) {
        assert.equal(
          await can(w, w.members[held], w.fileId),
          ROLES.indexOf(held) >= rank,
          `floor=${floor} held=${held}`,
        );
      }
    }
  });

  it('`org` is `role` with the floor at viewer -- the two agree exactly', async () => {
    const a = await twoOrgs();
    await a.fl.share({ actorId: a.alice }, a.fileId, {
      subject: { type: 'org', orgId: a.partner },
    });
    const b = await twoOrgs();
    await b.fl.share({ actorId: b.alice }, b.fileId, {
      subject: { type: 'role', orgId: b.partner, minRole: 'viewer' },
    });
    for (const role of ROLES) {
      assert.equal(await can(a, a.members[role], a.fileId), await can(b, b.members[role], b.fileId));
    }
  });

  it('a group grant carries capabilities like any other grant, and only what it was given', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'member' },
      capabilities: ['read', 'write'],
    });
    const p = { actorId: w.members.admin };
    assert.equal((await authorize(w.fl.store, p, w.fileId, 'read')).allow, true);
    assert.equal((await authorize(w.fl.store, p, w.fileId, 'write')).allow, true);
    assert.equal((await authorize(w.fl.store, p, w.fileId, 'delete')).allow, false);
    assert.equal((await authorize(w.fl.store, p, w.fileId, 'share')).allow, false);
  });

  it('I3: a group grant is an ordinary row -- revoking it is immediate for the whole population', async () => {
    const w = await twoOrgs();
    const g = await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    assert.equal(await can(w, w.members.viewer, w.fileId), true);
    await w.fl.revoke({ actorId: w.alice }, g.grantId);
    for (const role of ROLES) {
      assert.equal(await can(w, w.members[role], w.fileId), false, `${role} after revoke`);
    }
    // One revoked row. Nothing cascaded, nothing was fanned out to undo.
    const { rows } = await w.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_grant WHERE file_id = $1`,
      [w.fileId],
    );
    assert.equal(Number(rows[0]!.n), 1);
  });

  it('I3: a group grant expires, and caps downloads, like any other grant', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
      maxDownloads: 1,
    });
    const p = { actorId: w.members.member };
    await w.fl.read(p, w.fileId);
    await rejects(() => w.fl.read(p, w.fileId), 404);
    // The cap binds the CREDENTIAL, so it is spent for the whole population --
    // a second member does not get a fresh budget.
    await rejects(() => w.fl.read({ actorId: w.members.viewer }, w.fileId), 404);

    const w2 = await twoOrgs();
    await w2.db.query(
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, capabilities, expires_at)
       VALUES ($1,$2,'org',$3,'{read}'::grant_capability[], now() - interval '1 hour')`,
      [w2.fileId, w2.home, w2.partner],
    );
    assert.equal(await can(w2, w2.members.owner, w2.fileId), false, 'an expired org grant allowed');
  });

  it('the group grant is visible and describable in listGrants', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'admin' },
    });
    const grants = await w.fl.listGrants({ actorId: w.alice }, w.fileId);
    const g = grants.find((x) => x.subjectType === 'role')!;
    assert.ok(g, 'the role grant is not listed');
    assert.equal(g.subjectOrgId, w.partner);
    assert.equal(g.subjectMinRole, 'admin');
    assert.equal(g.subjectId, null);
    assert.equal(g.live, true);
  });

  it('I5: a group grant is a ROW, not a flag -- there is still no boolean that opens a file', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    // No new column on `file`, and `visibility` is untouched by sharing.
    const { rows } = await w.db.query<Record<string, unknown>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'file'`,
    );
    const names = rows.map((r) => String(r['column_name']));
    for (const n of names) {
      assert.equal(
        /^(is_|allow_|public|shared|open)/.test(n),
        false,
        `a population-opening boolean appeared on file: ${n}`,
      );
    }
    const f = await w.fl.stat({ actorId: w.alice }, w.fileId);
    assert.equal(f.visibility, 'private');
  });
});

// =============================================================================
// THE PROPERTY THE WHOLE DESIGN EXISTS FOR
// =============================================================================

describe('membership changes access on the NEXT REQUEST, with no recomputation', () => {
  /**
   * THE HEADLINE PROPERTY, AND THE ONLY WAY TO PROVE IT.
   *
   * "Access changes immediately" is not provable by timing; it is provable by
   * showing there was nothing to change. So this test fingerprints every column
   * of every `file_grant` row before and after a join and a leave, and asserts
   * the fingerprint is byte-identical while the ANSWER flips. If a future
   * implementation ever materializes a group into per-member rows -- which is
   * the obvious "optimization" -- the fingerprint moves and this fails.
   */
  it('adding a member grants access, and writes NO grant row', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const newcomer = (await w.fl.createActor('newcomer')).id;
    assert.equal(await can(w, newcomer, w.fileId), false);

    const before = await grantSnapshot(w);
    const beforeCount = (
      await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM file_grant`)
    ).rows[0]!.n;

    await w.fl.addMember({ actorId: w.bosses }, w.partner, newcomer, 'viewer');

    assert.equal(await can(w, newcomer, w.fileId), true, 'the join did not confer access');
    const after = await grantSnapshot(w);
    const afterCount = (
      await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM file_grant`)
    ).rows[0]!.n;

    assert.equal(afterCount, beforeCount, 'a grant row was created by a membership change');
    assert.equal(after, before, 'a grant row was MODIFIED by a membership change');
  });

  it('removing a member revokes access, and writes NO grant row', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    assert.equal(await can(w, w.members.viewer, w.fileId), true);

    const before = await grantSnapshot(w);
    const beforeCount = (
      await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM file_grant`)
    ).rows[0]!.n;

    await w.fl.removeMember({ actorId: w.bosses }, w.partner, w.members.viewer);

    assert.equal(await can(w, w.members.viewer, w.fileId), false, 'the leave did not end access');
    const after = await grantSnapshot(w);
    const afterCount = (
      await w.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM file_grant`)
    ).rows[0]!.n;

    assert.equal(afterCount, beforeCount, 'a grant row was deleted by a membership change');
    assert.equal(after, before, 'a grant row was MODIFIED by a membership change');
  });

  it('a ROLE CHANGE moves a person across the floor in both directions, still with no grant write', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'admin' },
    });
    const before = await grantSnapshot(w);
    const target = w.members.member;
    assert.equal(await can(w, target, w.fileId), false);

    await w.fl.addMember({ actorId: w.bosses }, w.partner, target, 'admin');
    assert.equal(await can(w, target, w.fileId), true, 'promotion did not confer access');

    await w.fl.addMember({ actorId: w.bosses }, w.partner, target, 'viewer');
    assert.equal(await can(w, target, w.fileId), false, 'demotion did not remove access');

    assert.equal(await grantSnapshot(w), before, 'a role change touched a grant row');
  });

  it('the same is true of the LISTING path: no grant row, and the set answer moves too', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const newcomer = (await w.fl.createActor('list-newcomer')).id;
    const seen = async () =>
      (await w.fl.listFiles({ actorId: newcomer }, w.home, { limit: 50 })).files.map((f) => f.id);

    assert.deepEqual(await seen(), []);
    const before = await grantSnapshot(w);
    await w.fl.addMember({ actorId: w.bosses }, w.partner, newcomer, 'member');
    assert.deepEqual(await seen(), [w.fileId], 'the set query did not see the new membership');
    assert.equal(await grantSnapshot(w), before);
  });

  it('there is no materialization: N members cost N membership rows and ONE grant row', async () => {
    const w = await twoOrgs();
    for (let i = 0; i < 25; i++) {
      const id = (await w.fl.createActor(`bulk-${i}`)).id;
      await w.fl.addMember({ actorId: w.bosses }, w.partner, id, 'member');
    }
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const { rows } = await w.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_grant WHERE file_id = $1`,
      [w.fileId],
    );
    assert.equal(Number(rows[0]!.n), 1, 'the group was fanned out into per-member rows');
  });
});

// =============================================================================
// I1 / P3 / P8 -- CROSS-ORG YES, CROSS-PROJECT UNREPRESENTABLE
// =============================================================================

describe('I1: the subject org must be in the same PROJECT as the file', () => {
  it('a CROSS-ORG grant inside one project works -- this is the point of the feature', async () => {
    const w = await twoOrgs();
    // The grant's own org is the FILE's org; the subject org is a different
    // tenant entirely. Both facts hold on the same row.
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const { rows } = await w.db.query<{ org_id: string; subject_org_id: string }>(
      `SELECT org_id, subject_org_id FROM file_grant WHERE file_id = $1`,
      [w.fileId],
    );
    assert.equal(rows[0]!.org_id, w.home);
    assert.equal(rows[0]!.subject_org_id, w.partner);
    assert.notEqual(rows[0]!.org_id, rows[0]!.subject_org_id);
    assert.equal(await can(w, w.members.member, w.fileId), true);
  });

  it('the DATABASE refuses a subject org in another project (composite FK, not a WHERE clause)', async () => {
    const { db } = await createTestDb();
    const storage = new MemoryStorage();
    const a = new Filelayer(db, storage, { baseUrl: 'https://a.test' });
    const pb = (await a.createProject('customer-b', 'Customer B')).id;
    const b = new Filelayer(db, storage, { baseUrl: 'https://b.test', projectId: pb });

    const alice = (await a.createActor('a-alice')).id;
    const orgA = (await a.createOrg('a-org', 'A', { ownerActorId: alice })).id;
    const mallory = (await b.createActor('b-mallory')).id;
    const orgB = (await b.createOrg('b-org', 'B', { ownerActorId: mallory })).id;

    const file = await a.upload({ actorId: alice }, orgA, {
      name: 'a.pdf',
      contentType: 'application/pdf',
      body: bytes('A'),
    });

    // Raw SQL, engine bypassed entirely. `project_id` is derived from the
    // file's org by trigger, so the composite FK has nothing to negotiate with.
    await dbRejects(
      db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, capabilities)
       VALUES ($1,$2,'org',$3,'{read}'::grant_capability[])`,
      [file.id, orgA, orgB],
      /file_grant_subject_org_id_project_id_fkey|foreign key/i,
    );

    // ...and through the API it is the uniform 404, not a constraint error and
    // not a message that would confirm the org id resolves to a row somewhere.
    await rejects(
      () => a.share({ actorId: alice }, file.id, { subject: { type: 'org', orgId: orgB } }),
      404,
      'not_found',
    );
  });

  it('a subject org that does not exist at all is the same 404', async () => {
    const w = await twoOrgs();
    await rejects(
      () =>
        w.fl.share({ actorId: w.alice }, w.fileId, {
          subject: { type: 'org', orgId: '00000000-0000-4000-8000-0000000000ff' },
        }),
      404,
      'not_found',
    );
    await rejects(
      () =>
        w.fl.share({ actorId: w.alice }, w.fileId, {
          subject: { type: 'org', orgId: 'not-a-uuid' },
        }),
      404,
      'not_found',
    );
  });

  it('the file-owning org may name ITSELF, and that is just an explicit org grant', async () => {
    const w = await twoOrgs();
    const bystander = (await w.fl.createActor('home-viewer')).id;
    await w.fl.addMember({ actorId: w.alice }, w.home, bystander, 'viewer');
    // Private file, viewer role, not the owner: no role-derived access.
    assert.equal(await can(w, bystander, w.fileId), false);
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.home },
    });
    assert.equal(await can(w, bystander, w.fileId), true);
  });
});

// =============================================================================
// I2 / P7 -- THE SUBJECT ORG IS PART OF THE GRANT'S SCOPE
// =============================================================================

describe('I2: a grant is live only while its SUBJECT ORG is live', () => {
  it('deleting the subject org kills the grants held by its members', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    assert.equal(await can(w, w.members.admin, w.fileId), true);

    await w.fl.softDeleteOrg(w.partner);
    for (const role of ROLES) {
      assert.equal(
        await can(w, w.members[role], w.fileId),
        false,
        `${role} still had access after their org was deleted`,
      );
    }
    // ...and the set query agrees, for the same reason, in the same predicate.
    const page = await w.fl.listFiles({ actorId: w.members.admin }, w.home, { limit: 50 });
    assert.deepEqual(page.files, []);
  });

  it('restoring the subject org revives exactly what its deletion suspended', async () => {
    const w = await twoOrgs();
    const kept = await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const alsoRevoked = await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'viewer' },
    });
    // Independently revoked BEFORE the delete: it must stay revoked after the
    // restore, exactly as the actor case does.
    await w.fl.revoke({ actorId: w.alice }, alsoRevoked.grantId);

    await w.fl.softDeleteOrg(w.partner);
    assert.equal(await can(w, w.members.admin, w.fileId), false);
    await w.fl.restoreOrg(w.partner);
    assert.equal(await can(w, w.members.admin, w.fileId), true, 'restore did not revive the grant');

    const grants = await w.fl.listGrants({ actorId: w.alice }, w.fileId);
    assert.equal(grants.find((g) => g.id === kept.grantId)!.live, true);
    assert.equal(grants.find((g) => g.id === alsoRevoked.grantId)!.live, false);
  });

  it('deletion is DERIVED: nothing is written to any grant when the subject org dies', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const before = await grantSnapshot(w);
    await w.fl.softDeleteOrg(w.partner);
    assert.equal(await grantSnapshot(w), before, 'org deletion cascaded a write into file_grant');
    await w.fl.restoreOrg(w.partner);
    assert.equal(await grantSnapshot(w), before);
  });

  it('a dead subject org also stops the DOWNLOAD path, not merely the decision', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    await w.fl.read({ actorId: w.members.member }, w.fileId); // works
    await w.fl.softDeleteOrg(w.partner);
    await rejects(() => w.fl.read({ actorId: w.members.member }, w.fileId), 404);
    // `consume_download` re-evaluates scope liveness under the row locks, so
    // the grant cannot spend a download in the window after the decision either.
    const { rows } = await w.db.query<{ granted: boolean }>(
      `SELECT granted FROM consume_download((SELECT id FROM file_grant WHERE file_id = $1 LIMIT 1))`,
      [w.fileId],
    );
    assert.equal(rows[0]!.granted, false);
  });

  it('you cannot delegate from a grant whose subject org is dead', async () => {
    const w = await twoOrgs();
    const g = await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
      capabilities: ['read', 'share'],
    });
    await w.fl.softDeleteOrg(w.partner);
    const outsider = (await w.fl.createActor('deleg-target')).id;
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id, capabilities)
       VALUES ($1,$2,$3,'actor',$4,'{read}'::grant_capability[])`,
      [w.fileId, w.home, g.grantId, outsider],
      /grant_parent_not_live/,
    );
  });
});

// =============================================================================
// I6 -- SUBJECT BREADTH MAY NOT BE AMPLIFIED BY DELEGATION
// =============================================================================
//
// The six cases the RFC enumerates, each asserted TWICE: once through the API
// (where the engine refuses, with a reason and an audit event) and once through
// raw SQL (where the kernel refuses, because a rule that lives only in
// application code binds only the application).

describe('I6: delegation may attenuate authority but never amplify subject breadth', () => {
  /**
   * Give `holder` a delegable grant of the named subject type and return it.
   * The issuer is always the file's org owner, whose authority is ROLE-DERIVED
   * and who may therefore mint anything -- that asymmetry IS the invariant.
   */
  async function grantDerivedIssuer(w: TwoOrgs, kind: 'org' | 'actor' | 'link') {
    if (kind === 'actor') {
      const holder = (await w.fl.createActor(`contractor-${Math.random()}`)).id;
      const g = await w.fl.share({ actorId: w.alice }, w.fileId, {
        subject: { type: 'actor', actorId: holder },
        capabilities: ['read', 'share'],
      });
      return { principal: { actorId: holder }, grantId: g.grantId };
    }
    if (kind === 'org') {
      const g = await w.fl.share({ actorId: w.alice }, w.fileId, {
        subject: { type: 'org', orgId: w.partner },
        capabilities: ['read', 'share'],
      });
      return { principal: { actorId: w.members.member }, grantId: g.grantId };
    }
    // A `link` grant is read-only by CHECK constraint, so a link holder can
    // never reach `share` at all. It is still exercised at the SQL level below.
    const g = await w.fl.share({ actorId: w.alice }, w.fileId, { subject: { type: 'link' } });
    return { principal: { actorId: null, linkSecret: g.secret! }, grantId: g.grantId };
  }

  it('the delegable set is exactly {actor, link}, and it is stated once', () => {
    assert.deepEqual([...DELEGABLE_SUBJECT_TYPES].sort(), ['actor', 'link']);
    const all: GrantSubjectType[] = ['actor', 'org', 'role', 'link', 'anonymous'];
    const forbidden = all.filter((t) => !DELEGABLE_SUBJECT_TYPES.includes(t));
    assert.deepEqual(forbidden.sort(), ['anonymous', 'org', 'role']);
  });

  // --- case 1: org grant -> delegate to actor = ALLOWED ----------------------
  it('org grant -> delegate to ACTOR: ALLOWED', async () => {
    const w = await twoOrgs();
    const { principal, grantId } = await grantDerivedIssuer(w, 'org');
    const target = (await w.fl.createActor('t1')).id;
    const child = await w.fl.share(principal, w.fileId, {
      subject: { type: 'actor', actorId: target },
      capabilities: ['read'],
    });
    assert.equal(child.parentGrantId, grantId, 'the delegation is not bound to its parent');
    assert.equal(await can(w, target, w.fileId), true);

    // I3/P4 still holds through a group parent: revoke the parent and the child
    // dies with it, at any depth, with no cascading write.
    await w.fl.revoke({ actorId: w.alice }, grantId);
    assert.equal(await can(w, target, w.fileId), false, 'the child outlived its group parent');
  });

  it('org grant -> delegate to ACTOR is accepted at the SQL level too', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'org');
    const target = (await w.fl.createActor('t1-sql')).id;
    const { rows } = await w.db.query<{ id: string }>(
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id, capabilities)
       VALUES ($1,$2,$3,'actor',$4,'{read}'::grant_capability[]) RETURNING id`,
      [w.fileId, w.home, grantId, target],
    );
    assert.ok(rows[0]!.id, 'the kernel refused a legal delegation -- I6 is over-broad');
  });

  // --- case 2: org grant -> delegate to link = ALLOWED (if attenuation holds) -
  it('org grant -> delegate to LINK: ALLOWED when capability attenuation holds', async () => {
    const w = await twoOrgs();
    const { principal, grantId } = await grantDerivedIssuer(w, 'org');
    const child = await w.fl.share(principal, w.fileId, {
      subject: { type: 'link' },
      capabilities: ['read'],
    });
    assert.equal(child.parentGrantId, grantId);
    const d = await w.fl.redeem(child.secret!);
    assert.equal(d.file.id, w.fileId);
    // ...and it is still attenuated in the OTHER dimension: the child may not
    // carry a capability the group grant did not hold.
    await rejects(
      () =>
        w.fl.share(principal, w.fileId, {
          subject: { type: 'actor', actorId: w.members.viewer },
          capabilities: ['delete'],
        }),
      403,
      'forbidden',
    );
  });

  it('org grant -> delegate to LINK is accepted at the SQL level too', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'org');
    const { rows } = await w.db.query<{ id: string }>(
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, secret_hash, capabilities)
       VALUES ($1,$2,$3,'link','deadbeef','{read}'::grant_capability[]) RETURNING id`,
      [w.fileId, w.home, grantId],
    );
    assert.ok(rows[0]!.id, 'the kernel refused a legal link delegation');
  });

  // --- case 3: org grant -> delegate to org = DENIED -------------------------
  it('org grant -> delegate to ORG: DENIED', async () => {
    const w = await twoOrgs();
    const { principal } = await grantDerivedIssuer(w, 'org');
    const third = (await w.fl.createOrg('third', 'Third', { ownerActorId: w.alice })).id;
    const err = await rejects(
      () => w.fl.share(principal, w.fileId, { subject: { type: 'org', orgId: third } }),
      403,
      'forbidden',
    );
    assert.equal(err.reason, 'subject_breadth_amplification');
  });

  it('org grant -> delegate to ORG is refused by the KERNEL, engine bypassed', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'org');
    const third = (await w.fl.createOrg('third-sql', 'Third', { ownerActorId: w.alice })).id;
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_org_id, capabilities)
       VALUES ($1,$2,$3,'org',$4,'{read}'::grant_capability[])`,
      [w.fileId, w.home, grantId, third],
      /grant_subject_amplification/,
    );
  });

  // --- case 4: actor grant -> delegate to org = DENIED -----------------------
  it('actor grant -> delegate to ORG: DENIED', async () => {
    const w = await twoOrgs();
    const { principal } = await grantDerivedIssuer(w, 'actor');
    const err = await rejects(
      () => w.fl.share(principal, w.fileId, { subject: { type: 'org', orgId: w.partner } }),
      403,
      'forbidden',
    );
    assert.equal(err.reason, 'subject_breadth_amplification');
    // The `role` form is the same refusal: naming a floor does not make a
    // population narrower than "one person".
    const err2 = await rejects(
      () =>
        w.fl.share(principal, w.fileId, {
          subject: { type: 'role', orgId: w.partner, minRole: 'owner' },
        }),
      403,
    );
    assert.equal(err2.reason, 'subject_breadth_amplification');
    // Nothing was written.
    const { rows } = await w.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM file_grant WHERE subject_org_id IS NOT NULL`,
    );
    assert.equal(Number(rows[0]!.n), 0);
  });

  it('actor grant -> delegate to ORG is refused by the KERNEL, engine bypassed', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'actor');
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_org_id, capabilities)
       VALUES ($1,$2,$3,'org',$4,'{read}'::grant_capability[])`,
      [w.fileId, w.home, grantId, w.partner],
      /grant_subject_amplification/,
    );
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_org_id,
                               subject_min_role, capabilities)
       VALUES ($1,$2,$3,'role',$4,'viewer','{read}'::grant_capability[])`,
      [w.fileId, w.home, grantId, w.partner],
      /grant_subject_amplification/,
    );
  });

  // --- case 5: link grant -> delegate to org = DENIED ------------------------
  it('link grant -> delegate to ORG: DENIED (and a link cannot reach share at all)', async () => {
    const w = await twoOrgs();
    const { principal } = await grantDerivedIssuer(w, 'link');
    // A link grant is read-only by CHECK, so the attempt does not even reach
    // I6 -- it is refused for want of `share`, as a 404. Both refusals are
    // load-bearing and this asserts the outer one.
    await rejects(
      () => w.fl.share(principal, w.fileId, { subject: { type: 'org', orgId: w.partner } }),
      404,
    );
  });

  it('link grant -> delegate to ORG is refused by the KERNEL, engine bypassed', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'link');
    // The SQL path is the one that matters here: it bypasses both the
    // read-only CHECK on the PARENT and the engine, and I6 still refuses.
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_org_id, capabilities)
       VALUES ($1,$2,$3,'org',$4,'{read}'::grant_capability[])`,
      [w.fileId, w.home, grantId, w.partner],
      /grant_subject_amplification/,
    );
  });

  // --- case 6: grant-derived -> anonymous = DENIED ---------------------------
  it('grant-derived -> ANONYMOUS: DENIED', async () => {
    const w = await twoOrgs();
    for (const kind of ['actor', 'org'] as const) {
      const fresh = await twoOrgs();
      const { principal } = await grantDerivedIssuer(fresh, kind);
      const err = await rejects(
        () => fresh.fl.share(principal, fresh.fileId, { subject: { type: 'anonymous' } }),
        403,
        'forbidden',
      );
      assert.equal(err.reason, 'subject_breadth_amplification', `from a ${kind} grant`);
      assert.equal(await can(fresh, null, fresh.fileId), false);
    }
    // The file's own org owner CAN publish it -- role-derived authority may
    // mint any subject. Without this, the test would pass for the wrong reason.
    await w.fl.share({ actorId: w.alice }, w.fileId, { subject: { type: 'anonymous' } });
    assert.equal(await can(w, null, w.fileId), true);
  });

  it('grant-derived -> ANONYMOUS is refused by the KERNEL, engine bypassed', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'actor');
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, capabilities)
       VALUES ($1,$2,$3,'anonymous','{read}'::grant_capability[])`,
      [w.fileId, w.home, grantId],
      /grant_subject_amplification/,
    );
  });

  // --- the invariant cannot be walked around by a second statement -----------
  it('a delegated grant cannot be WIDENED by a later UPDATE', async () => {
    const w = await twoOrgs();
    const { grantId } = await grantDerivedIssuer(w, 'org');
    const target = (await w.fl.createActor('widen-target')).id;
    const { rows } = await w.db.query<{ id: string }>(
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id, capabilities)
       VALUES ($1,$2,$3,'actor',$4,'{read}'::grant_capability[]) RETURNING id`,
      [w.fileId, w.home, grantId, target],
    );
    // Attenuation that binds only at INSERT is attenuation a second statement
    // walks around. The trigger fires on the subject columns for this reason.
    await dbRejects(
      w.db,
      `UPDATE file_grant
          SET subject_type = 'org', subject_id = NULL, subject_org_id = $2
        WHERE id = $1`,
      [rows[0]!.id, w.partner],
      /grant_subject_amplification/,
    );
  });

  it('a ROOT grant is unaffected: role-derived authority may mint every subject type', async () => {
    const w = await twoOrgs();
    // Alice is the owner of the file's org. All five subject types, no parent.
    const target = (await w.fl.createActor('root-target')).id;
    for (const subject of [
      { type: 'actor', actorId: target },
      { type: 'org', orgId: w.partner },
      { type: 'role', orgId: w.partner, minRole: 'admin' },
      { type: 'link' },
      { type: 'anonymous' },
    ] as const) {
      const g = await w.fl.share({ actorId: w.alice }, w.fileId, { subject });
      assert.equal(g.parentGrantId, null, `${subject.type} was minted with a parent`);
    }
  });
});

// =============================================================================
// I4 / P5 -- THE AUDIT EVENT NAMES THE MEMBERSHIP THAT CONFERRED ACCESS
// =============================================================================

describe('I4: `via` gains grant:org and grant:role, and the event says which membership', () => {
  async function lastAllow(w: World, fileId: string) {
    const { rows } = await w.db.query<Record<string, unknown>>(
      `SELECT context FROM audit_event
        WHERE file_id = $1 AND decision = 'allow' AND action = 'file.read'
        ORDER BY id DESC LIMIT 1`,
      [fileId],
    );
    const raw = rows[0]!['context'];
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
  }

  it('an org-grant allow records via=grant:org, the subject org, and the role held', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const d = await authorize(w.fl.store, { actorId: w.members.member }, w.fileId, 'read');
    assert.equal(d.allow === true && d.via, 'grant:org');

    const ctx = await lastAllow(w, w.fileId);
    assert.equal(ctx['via'], 'grant:org');
    assert.equal(ctx['viaOrgId'], w.partner);
    assert.equal(ctx['viaMinRole'], null, 'an org grant has no floor');
    assert.equal(ctx['viaRole'], 'member', 'the conferring membership is not identified');
  });

  it('a role-grant allow records via=grant:role, the floor, and the role held', async () => {
    const w = await twoOrgs();
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'admin' },
    });
    const d = await authorize(w.fl.store, { actorId: w.members.owner }, w.fileId, 'read');
    assert.equal(d.allow === true && d.via, 'grant:role');

    const ctx = await lastAllow(w, w.fileId);
    assert.equal(ctx['via'], 'grant:role');
    assert.equal(ctx['viaOrgId'], w.partner);
    assert.equal(ctx['viaMinRole'], 'admin');
    assert.equal(ctx['viaRole'], 'owner');
  });

  it('a compliance auditor can answer "why did this succeed?" from the log alone', async () => {
    const w = await twoOrgs();
    const g = await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'role', orgId: w.partner, minRole: 'member' },
    });
    await w.fl.read({ actorId: w.members.admin }, w.fileId);
    const { rows } = await w.db.query<Record<string, unknown>>(
      `SELECT actor_id, grant_id, context FROM audit_event
        WHERE file_id = $1 AND decision = 'allow' AND action = 'file.read'
        ORDER BY id DESC LIMIT 1`,
      [w.fileId],
    );
    const raw = rows[0]!['context'];
    const ctx = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    // WHO, through WHICH GRANT, by virtue of WHICH MEMBERSHIP: all on one row.
    assert.equal(rows[0]!['actor_id'], w.members.admin);
    assert.equal(rows[0]!['grant_id'], g.grantId);
    assert.equal(ctx['viaOrgId'], w.partner);
    assert.equal(ctx['viaRole'], 'admin');
  });

  it('non-group allows are unchanged: no membership fields are added to them', async () => {
    const w = await twoOrgs();
    const target = (await w.fl.createActor('plain')).id;
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'actor', actorId: target },
    });
    await authorize(w.fl.store, { actorId: target }, w.fileId, 'read');
    const ctx = await lastAllow(w, w.fileId);
    assert.equal(ctx['via'], 'grant:actor');
    assert.equal('viaOrgId' in ctx, false);
    assert.equal('viaRole' in ctx, false);
  });

  it('a named actor grant wins the attribution over a group grant on the same file', async () => {
    const w = await twoOrgs();
    // The same person is reachable both ways. `via` must report the narrower,
    // more specific path, because that is the one a compliance auditor asked about.
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'org', orgId: w.partner },
    });
    const specific = await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'actor', actorId: w.members.admin },
    });
    const d = await authorize(w.fl.store, { actorId: w.members.admin }, w.fileId, 'read');
    assert.equal(d.allow === true && d.via, 'grant:actor');
    assert.equal(d.allow === true && d.grantId, specific.grantId);
  });

  it('the I6 refusal is audited with a reason, not merely thrown', async () => {
    const w = await twoOrgs();
    const holder = (await w.fl.createActor('audited-contractor')).id;
    await w.fl.share({ actorId: w.alice }, w.fileId, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['read', 'share'],
    });
    await rejects(
      () =>
        w.fl.share({ actorId: holder }, w.fileId, { subject: { type: 'org', orgId: w.partner } }),
      403,
    );
    const { rows } = await w.db.query<Record<string, unknown>>(
      `SELECT reason, context FROM audit_event
        WHERE action = 'grant.create' AND decision = 'deny' ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0]!['reason'], 'subject_breadth_amplification');
    const raw = rows[0]!['context'];
    const ctx = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    assert.equal(ctx['requestedSubjectType'], 'org');
    assert.equal(ctx['via'], 'grant:actor');
  });
});

// =============================================================================
// THE SCHEMA'S OWN COHERENCE
// =============================================================================

describe('the schema refuses an incoherent group subject', () => {
  it('an org/role grant may not also name an actor or carry a secret', async () => {
    const w = await twoOrgs();
    for (const [sql, params] of [
      [
        `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, subject_id, capabilities)
         VALUES ($1,$2,'org',$3,$4,'{read}'::grant_capability[])`,
        [w.fileId, w.home, w.partner, w.alice],
      ],
      [
        `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, secret_hash, capabilities)
         VALUES ($1,$2,'org',$3,'abc','{read}'::grant_capability[])`,
        [w.fileId, w.home, w.partner],
      ],
      // 'org' with a floor: the floor belongs to 'role' and nowhere else.
      [
        `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, subject_min_role, capabilities)
         VALUES ($1,$2,'org',$3,'admin','{read}'::grant_capability[])`,
        [w.fileId, w.home, w.partner],
      ],
      // 'role' without a floor.
      [
        `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, capabilities)
         VALUES ($1,$2,'role',$3,'{read}'::grant_capability[])`,
        [w.fileId, w.home, w.partner],
      ],
      // 'org' with no subject org at all.
      [
        `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities)
         VALUES ($1,$2,'org','{read}'::grant_capability[])`,
        [w.fileId, w.home],
      ],
      // ...and an ACTOR grant may not smuggle a subject org onto itself.
      [
        `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, subject_org_id, capabilities)
         VALUES ($1,$2,'actor',$3,$4,'{read}'::grant_capability[])`,
        [w.fileId, w.home, w.alice, w.partner],
      ],
    ] as Array<[string, unknown[]]>) {
      await dbRejects(w.db, sql, params, /grant_subject_coherent/);
    }
  });

  it('a group grant on a file in another tenant is still unrepresentable (P3 unchanged)', async () => {
    const w = await twoOrgs();
    const other = await w.fl.upload({ actorId: w.bosses }, w.partner, {
      name: 'theirs.pdf',
      contentType: 'application/pdf',
      body: bytes('THEIRS'),
    });
    await dbRejects(
      w.db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id, capabilities)
       VALUES ($1,$2,'org',$3,'{read}'::grant_capability[])`,
      [other.id, w.home, w.partner],
      /file_grant_file_id_org_id_fkey|foreign key/i,
    );
  });
});

// =============================================================================
// THE TIERED API
// =============================================================================

describe('shares.create exposes the new subjects with names an agent can infer', () => {
  it('withOrg shares with a whole tenant; withOrg + minRole applies the floor', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://t.test' });

    await fl.orgs.create('acme', { owner: 'alice', name: 'Acme' });
    await fl.orgs.create('partner', { owner: 'boss', name: 'Partner' });
    await fl.orgs.setRole('partner', 'junior', 'viewer', { as: 'boss' });
    const f = await fl.files.put(bytes('CV'), { org: 'acme', owner: 'alice' });

    await fl.shares.create(f.id, { as: 'alice', withOrg: 'partner' });
    assert.ok(await fl.files.get(f.id, { as: 'junior' }));
    assert.ok(await fl.files.get(f.id, { as: 'boss' }));

    const f2 = await fl.files.put(bytes('BOARD'), { org: 'acme', owner: 'alice' });
    await fl.shares.create(f2.id, { as: 'alice', withOrg: 'partner', minRole: 'admin' });
    await rejects(() => fl.files.get(f2.id, { as: 'junior' }), 404);
    assert.ok(await fl.files.get(f2.id, { as: 'boss' }));
  });

  it('withOrg does NOT auto-provision a tenant: an unknown org is 404', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://t.test' });
    await fl.orgs.create('acme', { owner: 'alice' });
    const f = await fl.files.put(bytes('X'), { org: 'acme', owner: 'alice' });
    await rejects(
      () => fl.shares.create(f.id, { as: 'alice', withOrg: 'typo-corp' }),
      404,
      'not_found',
    );
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM org WHERE external_id = 'typo-corp'`,
    );
    assert.equal(Number(rows[0]!.n), 0, 'a typo in an org name provisioned a tenant');
  });

  it('an ambiguous subject is refused rather than silently resolved', async () => {
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://t.test' });
    await fl.orgs.create('acme', { owner: 'alice' });
    const f = await fl.files.put(bytes('X'), { org: 'acme', owner: 'alice' });
    await rejects(
      () => fl.shares.create(f.id, { as: 'alice', withUser: 'bob', withOrg: 'acme' }),
      400,
    );
    await rejects(() => fl.shares.create(f.id, { as: 'alice', minRole: 'admin' }), 400);
  });
});
