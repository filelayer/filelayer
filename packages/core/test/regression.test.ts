/**
 * REGRESSION SUITE FOR THE SECURITY REVIEW FINDINGS
 *
 * One suite per fixed finding. Every test in this file was run against the
 * PRE-FIX tree and observed to fail there. A regression test that has never
 * been seen to fail is a regression test you have no reason to believe.
 *
 * The world is built with raw SQL rather than through `Filelayer.addMember`, so
 * that this file could be dropped into the pre-fix tree unchanged and still
 * exercise the property rather than an API signature change. The one exception
 * is the membership suite, whose whole subject IS the signature: `addMember`
 * used to take no principal, and no test can express "this should have been
 * authorized" against an API that has nowhere to put the caller.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import type { Capability, OrgRole, Principal } from '../src/authz.ts';
import { bytes, text, rejects } from './helpers.ts';

const P = (actorId: string | null, extra: Partial<Principal> = {}): Principal => ({
  actorId,
  ...extra,
});

interface World {
  db: Queryable;
  storage: MemoryStorage;
  fl: Filelayer;
  org: string;
  owner: string;
  file: { id: string; storageKey: string };
  actor(label: string, role?: OrgRole | null): Promise<string>;
}

/**
 * Membership is written directly so this file works against both trees.
 * Everything under test is reached through the public API.
 */
async function world(fileOpts: { visibility?: 'private' | 'org' } = {}): Promise<World> {
  const { db } = await createTestDb();
  const storage = new MemoryStorage();
  const fl = new Filelayer(db, storage, { baseUrl: 'https://files.example.test' });

  const org = (
    await db.query<{ id: string }>(
      `INSERT INTO org (external_id, name) VALUES ('acme','Acme') RETURNING id`,
    )
  ).rows[0]!.id;

  let n = 0;
  const actor = async (label: string, role: OrgRole | null = null): Promise<string> => {
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO actor (external_id) VALUES ($1) RETURNING id`,
        [`${label}-${n++}`],
      )
    ).rows[0]!.id;
    if (role) {
      await db.query(
        `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, actor_id) DO UPDATE SET role = EXCLUDED.role`,
        [org, id, role],
      );
    }
    return id;
  };

  const owner = await actor('owner', 'owner');
  const file = await fl.upload({ actorId: owner }, org, {
    name: 'confidential.pdf',
    contentType: 'application/pdf',
    body: bytes('SECRET'),
    ...(fileOpts.visibility ? { visibility: fileOpts.visibility } : {}),
  });

  return { db, storage, fl, org, owner, file, actor };
}

// =============================================================================
// Delegated grants may not outlive their parent (P4, transitive)
// =============================================================================

describe('recursive grant liveness', () => {
  it('a chain of five delegated grants dies the instant the ROOT is revoked', async () => {
    // The depth is the point. A one-level test would pass against an
    // implementation that special-cased "my parent", which is exactly the kind
    // of fix that looks right and is not.
    const w = await world();
    const links: string[] = [];
    const grants: string[] = [];

    // The root: an actor grant carrying read + share.
    let holder = await w.actor('d0');
    let issuer: Principal = P(w.owner);
    for (let depth = 0; depth < 5; depth++) {
      const g = await w.fl.share(issuer, w.file.id, {
        subject: { type: 'actor', actorId: holder },
        capabilities: ['read', 'share'],
      });
      grants.push(g.grantId);
      if (depth > 0) {
        assert.equal(
          g.parentGrantId,
          grants[depth - 1],
          `grant at depth ${depth} must record its parent`,
        );
      } else {
        assert.equal(g.parentGrantId, null, 'the root has no parent');
      }

      // Each holder also mints a share LINK, so we can prove the URLs die too.
      const link = await w.fl.share(P(holder), w.file.id, {
        subject: { type: 'link' },
        capabilities: ['read'],
      });
      links.push(link.secret!);

      issuer = P(holder);
      holder = await w.actor(`d${depth + 1}`);
    }

    assert.equal(grants.length, 5);
    assert.equal(links.length, 5);

    // Everything works before the revocation.
    for (const secret of links) {
      assert.equal(text((await w.fl.redeem(secret)).body), 'SECRET');
    }
    const liveBefore = await w.db.query(`SELECT count(*)::int c FROM live_grant`);
    assert.equal(Number((liveBefore.rows[0] as { c: number }).c), 10);

    // Revoke ONLY the root.
    await w.fl.revoke(P(w.owner), grants[0]!);

    // Every descendant, at every depth, is dead -- with no cascading write.
    const { rows: stillRevoked } = await w.db.query<{ c: number }>(
      `SELECT count(*)::int c FROM file_grant WHERE revoked_at IS NOT NULL`,
    );
    assert.equal(Number(stillRevoked[0]!.c), 1, 'exactly one row was written to');

    const { rows: live } = await w.db.query<{ c: number }>(`SELECT count(*)::int c FROM live_grant`);
    assert.equal(Number(live[0]!.c), 0, 'and yet nothing in the tree is live');

    for (const secret of links) {
      await rejects(() => w.fl.redeem(secret), 404);
    }
  });

  it('revoking a MIDDLE link kills its subtree and spares its ancestors', async () => {
    const w = await world();
    const a = await w.actor('mid-a');
    const b = await w.actor('mid-b');
    const c = await w.actor('mid-c');

    const gA = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: a },
      capabilities: ['read', 'share'],
    });
    const gB = await w.fl.share(P(a), w.file.id, {
      subject: { type: 'actor', actorId: b },
      capabilities: ['read', 'share'],
    });
    const gC = await w.fl.share(P(b), w.file.id, {
      subject: { type: 'actor', actorId: c },
      capabilities: ['read'],
    });

    await w.fl.revoke(P(w.owner), gB.grantId);

    assert.equal(text((await w.fl.read(P(a), w.file.id)).body), 'SECRET', 'the ancestor survives');
    await rejects(() => w.fl.read(P(b), w.file.id), 404);
    await rejects(() => w.fl.read(P(c), w.file.id), 404);

    const summaries = await w.fl.listGrants(P(w.owner), w.file.id);
    const byId = new Map(summaries.map((g) => [g.id, g]));
    assert.equal(byId.get(gA.grantId)!.live, true);
    assert.equal(byId.get(gB.grantId)!.live, false);
    assert.equal(byId.get(gC.grantId)!.live, false);
    assert.equal(byId.get(gC.grantId)!.revokedAt, null, 'the leaf was never revoked itself');
  });

  it('the two independent liveness formulations agree on every row', async () => {
    // `grant_is_live` walks UP from one grant; `live_grant_recursive` walks
    // DOWN from the live roots. They are written separately on purpose: one
    // implementation agreeing with itself proves nothing.
    const w = await world();
    const a = await w.actor('agree-a');
    const b = await w.actor('agree-b');
    const gA = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: a },
      capabilities: ['read', 'share'],
      maxDownloads: 2,
    });
    const gB = await w.fl.share(P(a), w.file.id, {
      subject: { type: 'actor', actorId: b },
      capabilities: ['read', 'share'],
    });
    await w.fl.share(P(b), w.file.id, { subject: { type: 'link' }, capabilities: ['read'] });
    await w.fl.share(P(w.owner), w.file.id, { subject: { type: 'anonymous' } });

    const check = async (label: string) => {
      const { rows } = await w.db.query<{ c: number }>(
        `SELECT count(*)::int AS c FROM (
             (SELECT id FROM live_grant EXCEPT SELECT id FROM live_grant_recursive)
             UNION ALL
             (SELECT id FROM live_grant_recursive EXCEPT SELECT id FROM live_grant)
           ) d`,
      );
      assert.equal(Number(rows[0]!.c), 0, `formulations disagree ${label}`);
    };

    await check('with a healthy tree');
    await w.fl.revoke(P(w.owner), gB.grantId);
    await check('after revoking a middle node');
    await w.db.query(`UPDATE file_grant SET expires_at = now() - interval '1s' WHERE id = $1`, [
      gA.grantId,
    ]);
    await check('after expiring the root');
  });

  it('lineage is immutable, so a liveness cycle cannot be created', async () => {
    const w = await world();
    const a = await w.actor('cycle-a');
    const g1 = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: a },
      capabilities: ['read', 'share'],
    });
    const g2 = await w.fl.share(P(a), w.file.id, {
      subject: { type: 'actor', actorId: a },
      capabilities: ['read'],
    });

    // Re-parenting the root under its own child would make liveness circular.
    await assert.rejects(
      () =>
        w.db.query(`UPDATE file_grant SET parent_grant_id = $1 WHERE id = $2`, [
          g2.grantId,
          g1.grantId,
        ]),
      /grant_lineage_immutable/,
    );
    // A grant cannot be its own parent either.
    await assert.rejects(
      () =>
        w.db.query(`UPDATE file_grant SET parent_grant_id = id WHERE id = $1`, [g1.grantId]),
      /grant_no_self_parent|grant_lineage_immutable/,
    );
  });

  it('a delegated grant cannot point at a different file (structural)', async () => {
    const w = await world();
    const other = await w.fl.upload({ actorId: w.owner }, w.org, {
      name: 'other.pdf',
      contentType: 'application/pdf',
      body: bytes('OTHER'),
    });
    const a = await w.actor('xfile');
    const parent = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: a },
      capabilities: ['read', 'share'],
    });
    await assert.rejects(
      () =>
        w.db.query(
          `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id, capabilities)
           VALUES ($1,$2,$3,'actor',$4,ARRAY['read']::grant_capability[])`,
          [other.id, w.org, parent.grantId, a],
        ),
      /violates foreign key constraint/i,
    );
  });
});

// =============================================================================
// Capability amplification
// =============================================================================

/**
 * FOUND WHILE IMPLEMENTING RFC-001, and it predates it.
 *
 * `getActorGrants` had no ORDER BY. `resolveStanding` attributes an allow to
 * the FIRST returned grant that carries the requested capability, and on the
 * share path that grant becomes the child's `parent_grant_id` -- the ceiling
 * the attenuation trigger measures against. So when a principal held more than
 * one grant on a file, WHICH ONE became the parent was heap order: undefined,
 * and observably dependent on row width, page packing and VACUUM. Adding two
 * nullable columns to `file_grant` was enough to flip it, and a delegation that
 * had always succeeded began failing with `grant_capability_amplification`.
 *
 * Fail-closed, so never a disclosure -- but a `share()` whose outcome depends
 * on physical storage is not a semantics anyone can document.
 */
describe('delegation picks its parent deterministically, not in heap order', () => {
  it('a principal holding several grants delegates from the OLDEST, every time', async () => {
    const w = await world();
    const holder = await w.actor('multi-holder', 'viewer');

    // Oldest first, and it is the BROAD one. The narrow `{share}` grant that
    // arrives later must not become the ceiling.
    const broad = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['read', 'share'],
    });
    await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['share'],
    });

    // The store must hand them back in creation order regardless of layout.
    const seen = await w.fl.store.getActorGrants(w.file.id, holder);
    assert.deepEqual(
      seen.map((g) => g.capabilities.slice().sort().join('+')),
      ['read+share', 'share'],
      'getActorGrants returned an undefined order',
    );

    // ...so delegating the full held set succeeds, and is parented to `broad`.
    const target = await w.actor('multi-target');
    const child = await w.fl.share(P(holder), w.file.id, {
      subject: { type: 'actor', actorId: target },
      capabilities: ['read', 'share'],
    });
    assert.equal(child.parentGrantId, broad.grantId);

    // Repeat: the answer must not drift as more rows land on the page.
    for (let i = 0; i < 3; i++) {
      const again = await w.fl.share(P(holder), w.file.id, {
        subject: { type: 'actor', actorId: target },
        capabilities: ['read'],
      });
      assert.equal(again.parentGrantId, broad.grantId, `iteration ${i}`);
    }
  });
});

describe('attenuation lives in the engine and the schema, not in the API', () => {
  it('every proper superset of the held capabilities is refused', async () => {
    const w = await world();
    const holder = await w.actor('att-holder', 'viewer');
    await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['read', 'share'],
    });

    const forbidden: Capability[][] = [
      ['write'],
      ['delete'],
      ['read', 'write'],
      ['read', 'delete'],
      ['share', 'delete'],
      ['read', 'write', 'delete', 'share'],
    ];
    for (const caps of forbidden) {
      await rejects(
        () =>
          w.fl.share(P(holder), w.file.id, {
            subject: { type: 'actor', actorId: holder },
            capabilities: caps,
          }),
        403,
        'forbidden',
      );
    }

    // Positive control: subsets of what they hold go through.
    for (const caps of [['read'], ['share'], ['read', 'share']] as Capability[][]) {
      const g = await w.fl.share(P(holder), w.file.id, {
        subject: { type: 'actor', actorId: holder },
        capabilities: caps,
      });
      assert.ok(g.grantId);
    }

    // And the escalation they were reaching for still does not exist.
    await rejects(() => w.fl.delete(P(holder), w.file.id), 404);
    assert.equal(text((await w.fl.read(P(w.owner), w.file.id)).body), 'SECRET');
  });

  it('the refusal is audited, naming what was asked for and what was held', async () => {
    const w = await world();
    const holder = await w.actor('att-audit', 'viewer');
    await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: holder },
      capabilities: ['share'],
    });
    await rejects(
      () =>
        w.fl.share(P(holder), w.file.id, {
          subject: { type: 'actor', actorId: holder },
          capabilities: ['delete'],
        }),
      403,
    );
    const log = await w.fl.store.listAudit(w.org, { decision: 'deny' });
    const e = log.find((x) => x.reason === 'attenuation_violation');
    assert.ok(e, 'the attempt must be on the record');
    assert.deepEqual(e.context['requested'], ['delete']);
    assert.deepEqual(e.context['held'], ['share']);
  });
});

// =============================================================================
// File-level default deny
// =============================================================================

describe('files are private by default', () => {
  it('the DATABASE default is the restrictive one, not just the API default', async () => {
    const w = await world();
    const { rows } = await w.db.query<{ visibility: string }>(
      `INSERT INTO file (org_id, owner_id, name, content_type, storage_key, state)
       VALUES ($1,$2,'raw.pdf','application/pdf','raw-key','ready')
       RETURNING visibility`,
      [w.org, w.owner],
    );
    assert.equal(rows[0]!.visibility, 'private');
  });

  it('org visibility is per file, so one shared document does not open the rest', async () => {
    const w = await world();
    const staff = await w.actor('f4-staff', 'member');
    const shared = await w.fl.upload({ actorId: w.owner }, w.org, {
      name: 'handbook.pdf',
      contentType: 'application/pdf',
      body: bytes('HANDBOOK'),
      visibility: 'org',
    });
    assert.equal(text((await w.fl.read(P(staff), shared.id)).body), 'HANDBOOK');
    await rejects(() => w.fl.read(P(staff), w.file.id), 404);
  });
});

// =============================================================================
// The download reservation must fail closed
// =============================================================================

describe('consume_download fails closed', () => {
  it('a refusal is an explicit (false, 0) row, not the absence of a row', async () => {
    const w = await world();
    const link = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'link' },
      maxDownloads: 1,
    });
    await w.fl.redeem(link.secret!);

    const { rows } = await w.db.query<{ granted: boolean; remaining: number | null }>(
      `SELECT granted, remaining FROM consume_download($1)`,
      [link.grantId],
    );
    assert.equal(rows.length, 1, 'exactly one row, so `rows[0]?.granted ?? true` cannot fail open');
    assert.equal(rows[0]!.granted, false);

    // The same for a grant id that does not exist at all.
    const ghost = await w.db.query<{ granted: boolean }>(
      `SELECT granted FROM consume_download($1)`,
      ['00000000-0000-0000-0000-0000000000ff'],
    );
    assert.equal(ghost.rows.length, 1);
    assert.equal(ghost.rows[0]!.granted, false);

    // And the store layer refuses anything that is not literally true.
    assert.deepEqual(await w.fl.store.consumeDownload(link.grantId), {
      granted: false,
      remaining: 0,
    });
    assert.deepEqual(await w.fl.store.consumeDownload('not-a-uuid'), {
      granted: false,
      remaining: 0,
    });
  });
});

// =============================================================================
// Membership management
// =============================================================================
// This is the one suite that cannot be expressed against the pre-fix API at
// all: `addMember(orgId, actorId, role)` has nowhere to put the caller.

describe('membership changes are authorization decisions', () => {
  it('the org-capability table is total and enumerated', async () => {
    // Hand-written from the documented model, like the file matrix. 4 roles x
    // 3 org capabilities = 12 cells.
    const EXPECTED: Record<string, boolean> = {
      'viewer|create_file': false,
      'viewer|manage_members': false,
      'viewer|read_audit': false,
      'member|create_file': true,
      'member|manage_members': false,
      'member|read_audit': false,
      'admin|create_file': true,
      'admin|manage_members': true,
      'admin|read_audit': true,
      'owner|create_file': true,
      'owner|manage_members': true,
      'owner|read_audit': true,
    };
    const { orgCapabilities } = await import('../src/authz.ts');
    let checked = 0;
    for (const role of ['viewer', 'member', 'admin', 'owner'] as OrgRole[]) {
      for (const cap of ['create_file', 'manage_members', 'read_audit'] as const) {
        const key = `${role}|${cap}`;
        assert.notEqual(EXPECTED[key], undefined, `missing cell ${key}`);
        assert.equal(orgCapabilities(role).has(cap), EXPECTED[key], `mismatch at ${key}`);
        checked++;
      }
    }
    assert.equal(checked, 12);
    assert.equal(Object.keys(EXPECTED).length, 12);
  });

  it('every membership change emits exactly one audit event', async () => {
    const w = await world();
    const target = await w.actor('m-target');
    const before = (
      await w.db.query<{ c: number }>(
        `SELECT count(*)::int c FROM audit_event WHERE action LIKE 'member%'`,
      )
    ).rows[0]!.c;

    await w.fl.addMember(P(w.owner), w.org, target, 'member');
    await w.fl.addMember(P(w.owner), w.org, target, 'admin');
    await w.fl.removeMember(P(w.owner), w.org, target);
    await rejects(() => w.fl.addMember(P(target), w.org, target, 'owner'), 404);

    const { rows } = await w.db.query<{ action: string; decision: string }>(
      `SELECT action, decision FROM audit_event WHERE action LIKE 'member%' ORDER BY id`,
    );
    assert.equal(rows.length - Number(before), 4, 'four attempts, four events');
    const tail = rows.slice(rows.length - 4);
    assert.deepEqual(
      tail.map((r) => `${r.action}:${r.decision}`),
      ['member.add:allow', 'member.role_change:allow', 'member.remove:allow', 'member.add:deny'],
    );
  });

  it('the self-promotion attack is closed and leaves a trace', async () => {
    const w = await world();
    const outsider = await w.actor('outsider');
    await rejects(() => w.fl.addMember(P(outsider), w.org, outsider, 'owner'), 404);
    await rejects(() => w.fl.read(P(outsider), w.file.id), 404);
    const { rows } = await w.db.query<{ c: number }>(
      `SELECT count(*)::int c FROM audit_event
        WHERE action = 'member.add' AND decision = 'deny' AND actor_id = $1`,
      [outsider],
    );
    assert.equal(Number(rows[0]!.c), 1);
  });

  it('membership grants nothing retroactively: the audit log is still admin-only', async () => {
    const w = await world();
    const member = await w.actor('m-reader', 'member');
    await rejects(() => w.fl.auditLog(P(member), w.org, {}), 404);
    await rejects(() => w.fl.verifyAuditChain(P(member), w.org), 404);
    assert.ok((await w.fl.auditLog(P(w.owner), w.org, {})).length > 0);
  });
});

// =============================================================================
// Revoke authority follows the delegation tree
// =============================================================================
// Found while building the recursive-liveness fix, not carried over from the
// review.

describe('holding `share` does not confer revoke over other people’s grants', () => {
  it('a delegated share-holder cannot revoke a grant outside their own subtree', async () => {
    const w = await world();
    const contractor = await w.actor('rev-contractor');
    const parent = await w.fl.share(P(w.owner), w.file.id, {
      subject: { type: 'actor', actorId: contractor },
      capabilities: ['read', 'share'],
    });
    // An unrelated link, issued by the owner, that the contractor has nothing
    // to do with.
    const partner = await w.fl.share(P(w.owner), w.file.id, { subject: { type: 'link' } });

    await rejects(() => w.fl.revoke(P(contractor), partner.grantId), 404);
    assert.equal(text((await w.fl.redeem(partner.secret!)).body), 'SECRET', 'still works');

    // What they CAN revoke is their own subtree: the link they issued...
    const own = await w.fl.share(P(contractor), w.file.id, { subject: { type: 'link' } });
    await w.fl.revoke(P(contractor), own.grantId);
    await rejects(() => w.fl.redeem(own.secret!), 404);
    // ...and the authority they were given in the first place.
    await w.fl.revoke(P(contractor), parent.grantId);
    await rejects(() => w.fl.read(P(contractor), w.file.id), 404);

    // The refusal is on the record.
    const log = await w.fl.store.listAudit(w.org, { decision: 'deny' });
    assert.ok(log.some((e) => e.reason === 'foreign_grant' && e.grantId === partner.grantId));
  });

  it('role-derived authority still carries revoke over every grant on the file', async () => {
    const w = await world();
    const admin = await w.actor('rev-admin', 'admin');
    const link = await w.fl.share(P(w.owner), w.file.id, { subject: { type: 'link' } });
    await w.fl.revoke(P(admin), link.grantId);
    await rejects(() => w.fl.redeem(link.secret!), 404);
  });
});

// =============================================================================
// No dead code in the decision path
// =============================================================================

describe('the file-state gate has no vestigial branch', () => {
  it('authz.ts contains no capabilityRequiresLiveFile', async () => {
    // The old gate read `if (deleted || capabilityRequiresLiveFile(cap)) { if
    // (deleted) {...} }`, where the function unconditionally returned true. It
    // read like an intended-but-unimplemented distinction in the most
    // security-critical function in the codebase, which is the worst possible
    // place for one.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../src/authz.ts', import.meta.url), 'utf8');
    assert.equal(src.includes('capabilityRequiresLiveFile'), false);
  });
});
