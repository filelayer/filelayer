/**
 * THE DIFFERENTIAL TEST.
 *
 * `listFiles` answers, in ONE SQL query, the question `authorize()` answers one
 * file at a time. Two implementations of one predicate is exactly the structure
 * that produces a silent leak: the point check is what the security tests
 * exercise, the set query is what the listing screen actually calls, and a
 * widening drift in the set query is a cross-tenant disclosure that no test
 * written against `authorize()` would ever see.
 *
 * So this file asserts the only property that makes the pair safe:
 *
 *     for every capability c, every principal p, every org o:
 *        set(listFiles(p, o, c))  ==  { f in o : authorize(p, f, c).allow }
 *
 * over a randomized corpus of orgs, actors, roles, visibilities, ownerships,
 * direct grants, delegated grants, revocations, expiries, download caps,
 * retention holds, soft deletes and pending uploads. Equality, not containment
 * -- a set query that is too NARROW is a bug too, and one that would otherwise
 * be discovered by a customer.
 *
 * The corpus is generated from a seeded PRNG so a failure is reproducible: the
 * seed is printed in the assertion message.
 *
 * NOTE ON THE ORACLE. `authorize()` writes an audit event per call, so running
 * it over the whole corpus is what makes these tests slow. That cost is the
 * point: the oracle is the real production code path, not a reimplementation of
 * it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import {
  ALL_CAPABILITIES,
  authorize,
  fileCapabilities,
  listPredicate,
  membershipCells,
  roleMeets,
  type Capability,
  type OrgRole,
  type Principal,
} from '../src/authz.ts';
import { membershipCellSql } from '../src/store.ts';
import { bytes, rejects } from './helpers.ts';

// -----------------------------------------------------------------------------
// A tiny deterministic PRNG (mulberry32). No dependency, reproducible seeds.
// -----------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES: OrgRole[] = ['viewer', 'member', 'admin', 'owner'];

interface Corpus {
  db: Queryable;
  fl: Filelayer;
  orgs: string[];
  actors: string[];
  /** Every file id we created, by org. */
  filesByOrg: Map<string, string[]>;
  principals: Principal[];
}

/**
 * Build a world that exercises every branch of `resolveStanding` and every
 * branch of `lifecycleDenial`.
 *
 * Written with raw SQL for the parts that the public API refuses to create
 * (expired grants, soft-deleted files, a grant to a non-member) precisely
 * because the set query must agree with the point check on rows the API would
 * not have produced. A predicate that is only correct for well-formed data is
 * not a predicate, it is a coincidence.
 */
async function buildCorpus(seed: number, size = 'normal' as 'normal' | 'small'): Promise<Corpus> {
  const rand = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const { db } = await createTestDb();
  const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://t.test' });

  const nOrgs = size === 'small' ? 2 : 3;
  const nActorsPerOrg = 4;
  const nFiles = size === 'small' ? 8 : 14;

  const orgs: string[] = [];
  const actors: string[] = [];
  const filesByOrg = new Map<string, string[]>();
  const owners: string[] = [];

  // A pool of actors, some of whom belong to no org at all.
  for (let i = 0; i < nOrgs * nActorsPerOrg + 3; i++) {
    actors.push((await fl.createActor(`actor-${seed}-${i}`)).id);
  }

  for (let o = 0; o < nOrgs; o++) {
    const owner = actors[o * nActorsPerOrg]!;
    const org = (await fl.createOrg(`org-${seed}-${o}`, `Org ${o}`, { ownerActorId: owner })).id;
    orgs.push(org);
    owners.push(owner);
    filesByOrg.set(org, []);
    for (let m = 1; m < nActorsPerOrg; m++) {
      await fl.addMember({ actorId: owner }, org, actors[o * nActorsPerOrg + m]!, pick(ROLES));
    }
  }

  // Files: every visibility, several owners, and the awkward lifecycle states.
  for (let o = 0; o < nOrgs; o++) {
    const org = orgs[o]!;
    const orgActors = actors.slice(o * nActorsPerOrg, (o + 1) * nActorsPerOrg);
    for (let f = 0; f < nFiles; f++) {
      // Upload as an actor who can create: owner always can.
      const uploader = rand() < 0.5 ? owners[o]! : pick(orgActors);
      let id: string;
      try {
        const rec = await fl.upload({ actorId: uploader }, org, {
          name: `f${o}-${f}.bin`,
          contentType: 'application/octet-stream',
          body: bytes(`payload ${o}/${f}`),
          visibility: rand() < 0.5 ? 'org' : 'private',
          ...(rand() < 0.15 ? { retainFor: 3600 } : {}),
        });
        id = rec.id;
      } catch {
        // A viewer cannot create; fall back to the owner so the corpus keeps
        // its shape.
        const rec = await fl.upload({ actorId: owners[o]! }, org, {
          name: `f${o}-${f}.bin`,
          contentType: 'application/octet-stream',
          body: bytes(`payload ${o}/${f}`),
          visibility: rand() < 0.5 ? 'org' : 'private',
        });
        id = rec.id;
      }
      filesByOrg.get(org)!.push(id);

      // Lifecycle mutations the public API will not perform for us.
      const roll = rand();
      if (roll < 0.1) {
        await db.query(`UPDATE file SET state = 'pending' WHERE id = $1`, [id]);
      } else if (roll < 0.2) {
        // `retain_until <= expires_at` is a CHECK, so an expired file cannot
        // also carry a future retention hold. Clearing it keeps the row legal.
        await db.query(
          `UPDATE file SET expires_at = now() - interval '1 hour', retain_until = NULL
            WHERE id = $1`,
          [id],
        );
      } else if (roll < 0.28) {
        await db.query(`UPDATE file SET deleted_at = now() WHERE id = $1`, [id]);
      } else if (roll < 0.33) {
        // A file whose owner has been deleted: owner_id is NULL. The `isOwner`
        // comparison must not treat NULL as "matches everybody".
        await db.query(`UPDATE file SET owner_id = NULL WHERE id = $1`, [id]);
      }
    }
  }

  // Grants: direct, delegated, cross-org-subject, revoked, expired, exhausted.
  for (const [org, ids] of filesByOrg) {
    const o = orgs.indexOf(org);
    for (const id of ids) {
      if (rand() < 0.45) {
        // A grant to ANY actor in the pool -- including one in another org and
        // one in no org at all. This is legal, and it is the case that breaks a
        // "listing requires membership" design.
        const subject = pick(actors);
        const caps: Capability[] = rand() < 0.3 ? ['read', 'share'] : ['read'];
        await db.query(
          `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities,
                                   expires_at, max_downloads, revoked_at)
           VALUES ($1,$2,'actor',$3,$4::grant_capability[],$5,$6,$7)`,
          [
            id,
            org,
            subject,
            `{${caps.join(',')}}`,
            rand() < 0.2 ? new Date(Date.now() - 3600_000).toISOString() : null,
            rand() < 0.2 ? 1 : null,
            rand() < 0.2 ? new Date().toISOString() : null,
          ],
        );
      }
      if (rand() < 0.15) {
        await db.query(
          `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities, revoked_at)
           VALUES ($1,$2,'anonymous','{read}'::grant_capability[],$3)`,
          [id, org, rand() < 0.3 ? new Date().toISOString() : null],
        );
      }
      // GROUP GRANTS (RFC-001). The subject org is picked from the whole pool,
      // so the corpus contains same-org group grants, CROSS-ORG ones (the case
      // the feature exists for), and -- because the last org is soft-deleted at
      // the end of this function -- group grants whose subject org is dead.
      // Every role floor appears, including floors no member of the named org
      // reaches, which is the case where the point check and the set query
      // would disagree if either restated the threshold instead of deriving it.
      if (rand() < 0.35) {
        const subjectOrg = pick(orgs);
        const isRole = rand() < 0.5;
        const caps: Capability[] = rand() < 0.25 ? ['read', 'share'] : ['read'];
        await db.query(
          `INSERT INTO file_grant (file_id, org_id, subject_type, subject_org_id,
                                   subject_min_role, capabilities, expires_at, revoked_at)
           VALUES ($1,$2,$3,$4,$5,$6::grant_capability[],$7,$8)`,
          [
            id,
            org,
            isRole ? 'role' : 'org',
            subjectOrg,
            isRole ? pick(ROLES) : null,
            `{${caps.join(',')}}`,
            rand() < 0.15 ? new Date(Date.now() - 3600_000).toISOString() : null,
            rand() < 0.15 ? new Date().toISOString() : null,
          ],
        );
      }
      // A delegation chain, so recursive liveness is in play on both sides.
      if (rand() < 0.15) {
        const parent = await db.query<{ id: string }>(
          `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities)
           VALUES ($1,$2,'actor',$3,'{read,share}'::grant_capability[]) RETURNING id`,
          [id, org, actors[o * 4]!],
        );
        // Some of these files were soft-deleted above, and a grant on a
        // deleted file is no longer live, so the attenuation trigger refuses to
        // delegate from it. That refusal is the semantic under test, not a
        // corpus bug -- so it is tolerated HERE and asserted to be exactly the
        // documented refusal, rather than swallowed.
        let childId: string | null = null;
        try {
          const child = await db.query<{ id: string }>(
            `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id,
                                     capabilities)
             VALUES ($1,$2,$3,'actor',$4,'{read}'::grant_capability[]) RETURNING id`,
            [id, org, parent.rows[0]!.id, pick(actors)],
          );
          childId = child.rows[0]!.id;
        } catch (err) {
          assert.match((err as Error).message, /^grant_parent_not_live/);
        }
        // Kill the parent half the time: the child must die with it, in BOTH
        // the point check and the set query.
        if (childId !== null && rand() < 0.5) {
          await db.query(`UPDATE file_grant SET revoked_at = now() WHERE id = $1`, [
            parent.rows[0]!.id,
          ]);
        }
      }
    }
  }

  // A soft-deleted org. Deleting one used to kill memberships and leave grants
  // alive, which is the asymmetry this very test discovered. It now kills both,
  // so the corpus contains an org in which NOTHING is reachable by any path --
  // and the differential test still has to agree about that, element for
  // element, on both sides.
  if (size === 'normal') {
    await db.query(`UPDATE org SET deleted_at = now() WHERE id = $1`, [orgs[nOrgs - 1]!]);
  }

  const principals: Principal[] = [
    ...actors.map((a) => ({ actorId: a })),
    { actorId: null }, // anonymous
    { actorId: '00000000-0000-4000-8000-000000000001' }, // well-formed, unknown
  ];

  return { db, fl, orgs, actors, filesByOrg, principals };
}

/**
 * The oracle: the point check, per file, exactly as production runs it.
 *
 * `viaSeen` accumulates the authorization PATHS the corpus actually exercised.
 * A differential test over a corpus that never produces a group grant would
 * pass while proving nothing about group grants, so the paths are counted and
 * asserted rather than assumed.
 */
async function oracle(
  c: Corpus,
  principal: Principal,
  org: string,
  capability: Capability,
  viaSeen?: Map<string, number>,
): Promise<Set<string>> {
  const allowed = new Set<string>();
  for (const id of c.filesByOrg.get(org)!) {
    const d = await authorize(c.fl.store, principal, id, capability);
    if (d.allow) {
      allowed.add(id);
      if (viaSeen) viaSeen.set(d.via, (viaSeen.get(d.via) ?? 0) + 1);
    }
  }
  return allowed;
}

/** The subject: the set query, drained through every page. */
async function subject(
  c: Corpus,
  principal: Principal,
  org: string,
  capability: Capability,
  pageSize = 3,
): Promise<Set<string>> {
  const seen = new Set<string>();
  let cursor: string | null = null;
  let guard = 0;
  do {
    const page: { files: Array<{ id: string }>; nextCursor: string | null } = await c.fl.listFiles(
      principal,
      org,
      { capability, limit: pageSize, cursor },
    );
    for (const f of page.files) {
      assert.equal(seen.has(f.id), false, 'pagination returned the same file twice');
      seen.add(f.id);
    }
    cursor = page.nextCursor;
    assert.ok(guard++ < 200, 'pagination did not terminate');
  } while (cursor !== null);
  return seen;
}

describe('listFiles agrees with authorize(), exactly (the differential test)', () => {
  // Three independent corpora. Each one is a different random world; a leak
  // that depends on a particular shape has three chances to show up, and the
  // seeds are fixed so a failure is reproducible.
  for (const seed of [20260905, 424242, 7]) {
    it(`seed ${seed}: set equality on every capability, principal and org`, async () => {
      const c = await buildCorpus(seed);
      let comparisons = 0;
      let nonEmpty = 0;
      const viaSeen = new Map<string, number>();

      for (const org of c.orgs) {
        for (const principal of c.principals) {
          for (const capability of ALL_CAPABILITIES) {
            const expected = await oracle(c, principal, org, capability, viaSeen);
            const actual = await subject(c, principal, org, capability);
            comparisons++;
            if (expected.size > 0) nonEmpty++;

            const missing = [...expected].filter((x) => !actual.has(x));
            const extra = [...actual].filter((x) => !expected.has(x));
            assert.deepEqual(
              { missing, extra },
              { missing: [], extra: [] },
              `seed=${seed} org=${org} actor=${principal.actorId} cap=${capability}\n` +
                `  LEAK (in list, not authorized): ${extra.join(', ') || 'none'}\n` +
                `  LOSS (authorized, not listed):  ${missing.join(', ') || 'none'}`,
            );
          }
        }
      }

      // A test that compares two empty sets forever would pass vacuously. Assert
      // the corpus actually produced authorized results to compare.
      assert.ok(comparisons > 200, `expected a large comparison count, got ${comparisons}`);
      assert.ok(
        nonEmpty > comparisons * 0.05,
        `corpus too sparse to be meaningful: only ${nonEmpty}/${comparisons} non-empty`,
      );
      // ...and that it exercised the GROUP paths specifically. Without this the
      // test would keep passing if group grants silently stopped conferring
      // anything at all, which is the failure mode a set-vs-point comparison
      // cannot see on its own: both sides would agree on "nothing".
      const groupAllows = (viaSeen.get('grant:org') ?? 0) + (viaSeen.get('grant:role') ?? 0);
      assert.ok(
        groupAllows > 0,
        `seed=${seed}: the corpus produced no group-grant allows, so the ` +
          `differential comparison proves nothing about org/role subjects ` +
          `(paths seen: ${JSON.stringify(Object.fromEntries(viaSeen))})`,
      );
    });
  }

  it('a corpus of ONLY group grants: set equality still holds exactly', async () => {
    // The general corpus mixes every source of authority, so a group-grant leak
    // could in principle be masked by a role or actor-grant allow on the same
    // file. This world has nothing else in it: no anonymous grants, no actor
    // grants, and the reader is a member of NEITHER org that owns a file, so
    // every allow that happens is a group allow and every disagreement is one.
    const { db } = await createTestDb();
    const fl = new Filelayer(db, new MemoryStorage(), { baseUrl: 'https://t.test' });
    const rand = rng(31337);

    const owner = (await fl.createActor('go-owner')).id;
    const home = (await fl.createOrg('go-home', 'home', { ownerActorId: owner })).id;
    const partner = (await fl.createOrg('go-partner', 'partner', { ownerActorId: owner })).id;

    // Readers hold every role in the partner org, and one holds none at all.
    const readers: Array<{ id: string; role: OrgRole | null }> = [];
    for (const role of [...ROLES, null] as Array<OrgRole | null>) {
      const id = (await fl.createActor(`go-reader-${role ?? 'none'}`)).id;
      if (role) await fl.addMember({ actorId: owner }, partner, id, role);
      readers.push({ id, role });
    }

    const files: string[] = [];
    for (let i = 0; i < 12; i++) {
      const f = await fl.upload({ actorId: owner }, home, {
        name: `g${i}.bin`,
        contentType: 'application/octet-stream',
        body: bytes(`g${i}`),
        // 'private' throughout: `visibility='org'` would let the role path
        // answer, and only members of `home` have a role there anyway.
        visibility: 'private',
      });
      files.push(f.id);
      // Every floor, plus the floorless 'org' form, plus a grant naming the
      // WRONG org (home), which must confer nothing on a partner-only reader.
      const shape = i % 6;
      const subjectSpec =
        shape === 0
          ? ({ type: 'org', orgId: partner } as const)
          : shape === 5
            ? ({ type: 'org', orgId: home } as const)
            : ({ type: 'role', orgId: partner, minRole: ROLES[shape - 1]! } as const);
      const g = await fl.share({ actorId: owner }, f.id, {
        subject: subjectSpec,
        capabilities: rand() < 0.3 ? ['read', 'share'] : ['read'],
      });
      if (rand() < 0.25) await fl.revoke({ actorId: owner }, g.grantId);
    }

    const corpus: Corpus = {
      db,
      fl,
      orgs: [home],
      actors: readers.map((r) => r.id),
      filesByOrg: new Map([[home, files]]),
      principals: readers.map((r) => ({ actorId: r.id })),
    };

    let groupAllows = 0;
    for (const principal of corpus.principals) {
      for (const capability of ALL_CAPABILITIES) {
        const viaSeen = new Map<string, number>();
        const expected = await oracle(corpus, principal, home, capability, viaSeen);
        const actual = await subject(corpus, principal, home, capability);
        groupAllows += (viaSeen.get('grant:org') ?? 0) + (viaSeen.get('grant:role') ?? 0);
        assert.deepEqual(
          {
            missing: [...expected].filter((x) => !actual.has(x)),
            extra: [...actual].filter((x) => !expected.has(x)),
          },
          { missing: [], extra: [] },
          `group-only corpus: actor=${principal.actorId} cap=${capability}`,
        );
      }
    }
    assert.ok(groupAllows > 0, 'the group-only corpus authorized nothing at all');

    // The role FLOOR is real in both paths: the reader with no membership sees
    // nothing, and the viewer sees strictly less than the owner.
    const seen = async (id: string) =>
      (await fl.listFiles({ actorId: id }, home, { limit: 100 })).files.length;
    const none = readers.find((r) => r.role === null)!;
    const viewer = readers.find((r) => r.role === 'viewer')!;
    const ownerRole = readers.find((r) => r.role === 'owner')!;
    assert.equal(await seen(none.id), 0, 'a non-member matched a group grant');
    assert.ok(
      (await seen(viewer.id)) < (await seen(ownerRole.id)),
      'subject_min_role did not narrow anything: the floor is not being applied',
    );
  });

  it('the negative control: a deliberately widened predicate is caught', async () => {
    // If this test can pass with a broken predicate, it proves nothing. Here we
    // hand the store a predicate that claims every role cell carries `read`
    // regardless of visibility or ownership -- the exact mistake a hand-written
    // listing query makes -- and assert the comparison fails.
    const c = await buildCorpus(99, 'small');
    const org = c.orgs[0]!;
    const broken = {
      capability: 'read' as Capability,
      roleCells: ROLES.flatMap((role) =>
        [false, true].flatMap((isOwner) =>
          (['private', 'org'] as const).map((visibility) => ({ role, isOwner, visibility })),
        ),
      ),
      lifecycleCells: listPredicate('read').lifecycleCells,
      membershipCells: listPredicate('read').membershipCells,
      anonymousEligible: true,
    };

    let sawDivergence = false;
    for (const principal of c.principals) {
      if (!principal.actorId) continue;
      const expected = await oracle(c, principal, org, 'read');
      const leaked = await c.fl.store.listAuthorizedFiles({
        orgId: org,
        actorId: principal.actorId,
        predicate: broken,
        now: new Date(),
        limit: 100,
        cursor: null,
      });
      if (leaked.some((f) => !expected.has(f.id))) sawDivergence = true;
    }
    assert.equal(
      sawDivergence,
      true,
      'the differential comparison did not detect an over-permissive predicate; ' +
        'the corpus is not exercising visibility/ownership',
    );
  });
});

describe('listPredicate is derived from the role table, not restated', () => {
  it('every generated role cell agrees with fileCapabilities(), and no cell is missing', () => {
    for (const capability of ALL_CAPABILITIES) {
      const p = listPredicate(capability);
      let expectedCount = 0;
      for (const role of ROLES) {
        for (const isOwner of [false, true]) {
          for (const visibility of ['private', 'org'] as const) {
            const has = fileCapabilities(role, isOwner, visibility).has(capability);
            if (has) expectedCount++;
            const generated = p.roleCells.some(
              (c) => c.role === role && c.isOwner === isOwner && c.visibility === visibility,
            );
            assert.equal(generated, has, `${capability}/${role}/owner=${isOwner}/${visibility}`);
          }
        }
      }
      assert.equal(p.roleCells.length, expectedCount);
    }
  });

  it('the lifecycle cells exclude deleted, expired, and (for read) pending files', () => {
    const read = listPredicate('read');
    assert.equal(read.lifecycleCells.some((c) => c.state === 'deleted'), false);
    assert.equal(read.lifecycleCells.some((c) => c.expired), false);
    assert.equal(read.lifecycleCells.some((c) => c.state === 'pending'), false);
    // Delete is blocked by a retention hold, and only delete is.
    const del = listPredicate('delete');
    assert.equal(del.lifecycleCells.some((c) => c.retained), false);
    assert.equal(listPredicate('write').lifecycleCells.some((c) => c.retained), true);
    // Only `read` consults an anonymous grant, mirroring resolveStanding.
    assert.equal(read.anonymousEligible, true);
    assert.equal(listPredicate('share').anonymousEligible, false);
  });

  it('the membership cells are exactly roleMeets(), for every (floor, held) pair', () => {
    // The group threshold is the one rule the set query could plausibly have
    // restated as `m.role >= g.subject_min_role`. It is derived instead, so
    // assert the derivation is total and faithful: 16 pairs probed, 10 hold.
    const cells = membershipCells();
    let expected = 0;
    for (const minRole of ROLES) {
      for (const role of ROLES) {
        const holds = roleMeets(role, minRole);
        if (holds) expected++;
        assert.equal(
          cells.some((c) => c.minRole === minRole && c.role === role),
          holds,
          `floor=${minRole} held=${role}`,
        );
      }
    }
    assert.equal(cells.length, expected);
    assert.equal(expected, 10);
    // Every capability's predicate carries the same cells: a group grant is not
    // capability-gated the way an anonymous grant is.
    for (const capability of ALL_CAPABILITIES) {
      assert.deepEqual(listPredicate(capability).membershipCells, cells);
    }
  });

  it('the generated threshold SQL is a closed tuple list, not an inequality', () => {
    // If this ever becomes `>=`, the role ordering lives in the enum's
    // declaration order as well as in ROLE_RANK, and reordering the enum
    // silently changes who can read what. Assert the shape.
    const sql = membershipCellSql(membershipCells());
    assert.match(sql, /IN \(/);
    assert.equal(/[<>]=?/.test(sql), false, `threshold SQL contains a comparison: ${sql}`);
    assert.equal(membershipCellSql([]), 'false', 'an empty cell list must fail closed');
  });
});

describe('listFiles fails closed at its edges', () => {
  it('refuses a principal carrying a link secret rather than silently ignoring it', async () => {
    const c = await buildCorpus(11, 'small');
    await rejects(
      () => c.fl.listFiles({ actorId: null, linkSecret: 'anything' }, c.orgs[0]!),
      400,
      'link_principal_cannot_list',
    );
  });

  it('a malformed cursor is refused, not treated as "no cursor"', async () => {
    const c = await buildCorpus(12, 'small');
    await rejects(() => c.fl.listFiles({ actorId: null }, c.orgs[0]!, { cursor: 'nope' }), 400);
    await rejects(
      () =>
        c.fl.listFiles({ actorId: null }, c.orgs[0]!, {
          cursor: Buffer.from('2020-01-01T00:00:00.000Z|not-a-uuid').toString('base64url'),
        }),
      400,
    );
  });

  it('a nonexistent org and an org you cannot see are indistinguishable', async () => {
    const c = await buildCorpus(13, 'small');
    // A fresh actor, and no anonymous grants: a live anonymous grant is
    // readable by ANY principal, so leaving one in place would make this
    // assertion pass or fail on a coin flip.
    await c.db.query(`DELETE FROM file_grant WHERE subject_type = 'anonymous'`);
    const outsider = { actorId: (await c.fl.createActor('outsider-13')).id };
    const real = await c.fl.listFiles(outsider, c.orgs[0]!);
    const fake = await c.fl.listFiles(outsider, '00000000-0000-4000-8000-00000000dead');
    const junk = await c.fl.listFiles(outsider, 'not-a-uuid');
    assert.deepEqual(real, fake);
    assert.deepEqual(real, junk);
    assert.deepEqual(real.files, []);
  });

  it('the page size is clamped, so one request cannot become an unbounded scan', async () => {
    const c = await buildCorpus(14, 'small');
    const owner = { actorId: c.actors[0]! };
    const page = await c.fl.listFiles(owner, c.orgs[0]!, { limit: 10_000 });
    assert.ok(page.files.length <= 200);
    const one = await c.fl.listFiles(owner, c.orgs[0]!, { limit: 0 });
    assert.ok(one.files.length <= 1);
  });

  it('a list emits exactly ONE audit event, naming the files it disclosed', async () => {
    const c = await buildCorpus(15, 'small');
    const org = c.orgs[0]!;
    const before = await c.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'file.list'`,
    );
    const page = await c.fl.listFiles({ actorId: c.actors[0]! }, org, { limit: 100 });
    const after = await c.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'file.list'`,
    );
    assert.equal(Number(after.rows[0]!.n) - Number(before.rows[0]!.n), 1);

    const { rows } = await c.db.query<Record<string, unknown>>(
      `SELECT decision, reason, context FROM audit_event
        WHERE action = 'file.list' ORDER BY id DESC LIMIT 1`,
    );
    const ctx =
      typeof rows[0]!['context'] === 'string'
        ? JSON.parse(rows[0]!['context'] as string)
        : (rows[0]!['context'] as Record<string, unknown>);
    assert.equal(ctx['count'], page.files.length);
    assert.deepEqual(ctx['fileIds'], page.files.map((f) => f.id));
    assert.equal(ctx['capability'], 'read');
  });

  it('an empty list from a non-member is recorded as a DENY, so enumeration is visible', async () => {
    const c = await buildCorpus(16, 'small');
    // A freshly created actor: no membership anywhere, and no grant can name it
    // because it did not exist when the corpus was built. Anonymous grants are
    // cleared for the same reason -- they are readable by everyone, including
    // this actor, which would make the list non-empty for a legitimate reason.
    await c.db.query(`DELETE FROM file_grant WHERE subject_type = 'anonymous'`);
    const outsider = (await c.fl.createActor('outsider-16')).id;
    await c.fl.listFiles({ actorId: outsider }, c.orgs[0]!);
    const { rows } = await c.db.query<Record<string, unknown>>(
      `SELECT decision, reason FROM audit_event
        WHERE action = 'file.list' AND actor_id = $1 ORDER BY id DESC LIMIT 1`,
      [outsider],
    );
    assert.equal(rows[0]!['decision'], 'deny');
    assert.equal(rows[0]!['reason'], 'no_membership');
  });

  it('probing an org that does not exist goes to the SYSTEM chain, not a guessed tenant', async () => {
    const c = await buildCorpus(17, 'small');
    await c.fl.listFiles({ actorId: c.actors[0]! }, '00000000-0000-4000-8000-0000000000ff');
    const { rows } = await c.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE action = 'file.list' AND org_id IS NULL`,
    );
    assert.ok(Number(rows[0]!.n) >= 1);
  });
});
