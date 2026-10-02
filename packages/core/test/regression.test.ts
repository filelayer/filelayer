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

// =============================================================================
// THE 2026-10-02 ADVERSARIAL SWEEP
// =============================================================================
//
// Three independent agents attacked the published 0.5.3 in parallel. Five
// findings were reproduced against the PUBLISHED TARBALL, not against a working
// tree, and are fixed in 0.6.0. Every test below was observed to fail on 0.5.3.
//
// What they have in common is worth stating, because it is the lesson rather
// than the list: the authorization ENGINE held. 1,440 differential comparisons
// between `listFiles` and `authorize` over soft-delete axes the shipped corpus
// never touched, 54 delete/restore orderings, cross-tenant isolation,
// attenuation, lock ordering -- zero discrepancies. Every one of these five is
// in the surface AROUND the engine: the convenience facade, the HTTP helpers
// and the control plane. 343 tests and twelve gates did not see them.

describe('2026-10-02: the share route cannot be crashed by its own URL', () => {
  // `shareDownloadRoute` decoded the secret segment OUTSIDE its try. `GET /d/%%%`
  // -- no credential, no valid secret, four characters -- threw URIError, the
  // async handler rejected, node:http had nowhere to catch it, and the process
  // exited. Reachable through `deliveryHandler()`, the one-liner the quickstart,
  // the homepage and examples/vault all recommend.
  it('a malformed percent-escape is a 404, not an unhandled rejection', async () => {
    const { createServer } = await import('node:http');
    const { deliveryHandler } = await import('../src/delivery.ts');
    const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost' });
    const srv = createServer(deliveryHandler(fl));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      for (const path of ['/d/%%%', '/d/%E0%A4%A', '/d/%', '/f/%%%']) {
        const res = await fetch(`http://127.0.0.1:${port}${path}`);
        assert.equal(res.status, 404, `${path} should be a clean 404`);
        await res.text();
      }
      // Still serving: the point is that the process survived all of them.
      assert.equal((await fetch(`http://127.0.0.1:${port}/d/nope`)).status, 404);
    } finally {
      srv.close();
    }
  });

  it('a malformed file id is the same 404 as an unknown one, and is audited', async () => {
    // A non-uuid reached the audit write, whose `file_id` column is uuid, and
    // raised 22P02 -- not a FilelayerError, so the routes answered 500 for a
    // malformed id and 404 for a well-formed unknown one. An existence oracle on
    // the one input an internet user types, and the probe left no audit event at
    // all, because the write that would have recorded it was the write that
    // failed.
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const f = await fl.files.put(bytes('X'), { owner: 'alice' });
    for (const id of ['not-a-uuid', '../../etc/passwd', `${f.id} `]) {
      const err = await rejects(() => fl.files.get(id, { as: 'alice' }), 404);
      assert.equal(err.code, 'not_found');
    }
    const sweep = (await fl.store.listAudit(null, {})).filter(
      (e) => (e.context as Record<string, unknown> | null)?.['rawFileId'] !== undefined,
    );
    assert.ok(sweep.length >= 3, 'the probes must be legible on the system chain');
    assert.equal((await fl.store.verifyAuditChain(null)).valid, true);
  });

  it('the credential-in-the-query refusal does not depend on letter case', async () => {
    const { createServer } = await import('node:http');
    const { deliveryHandler } = await import('../src/delivery.ts');
    const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost' });
    const f = await fl.files.put(bytes('PRIVATEBYTES'), { owner: 'alice' });
    const sh = await fl.shares.create(f.id, { as: 'alice' });
    const srv = createServer(deliveryHandler(fl));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      for (const q of ['password=x', 'Password=x', 'PASSWORD=x', 'pass=x', 'Pass=x', 'ToKeN=x']) {
        const res = await fetch(`http://127.0.0.1:${port}/d/${sh.secret}?${q}`);
        assert.equal(res.status, 400, `?${q} must be refused`);
        assert.equal((await res.json() as { error: string }).error, 'credential_in_query');
      }
    } finally {
      srv.close();
    }
  });
});

describe('2026-10-02: the facade is never more permissive than the engine', () => {
  // `orgs.create()` is documented as idempotent, which invites calling it on
  // every signup. On an org that already existed it returned that org AND
  // bootstrapped the named identity as an OWNER of it -- no principal, no
  // authorization. `Filelayer.createOrg` refuses the same call.
  it('orgs.create on an existing tenant cannot mint an owner', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    await fl.orgs.create('acme', { name: 'Acme', owner: 'ceo' });
    const deck = await fl.files.put(bytes('BOARD DECK'), { org: 'acme', owner: 'ceo' });

    const err = await rejects(() => fl.orgs.create('acme', { owner: 'mallory' }), 409);
    assert.equal(err.code, 'org_exists');
    await rejects(() => fl.files.get(deck.id, { as: 'mallory' }), 404);
    await rejects(() => fl.orgs.audit('acme', { as: 'mallory' }), 404);

    // Still idempotent where idempotence is what was wanted: a retry.
    const again = await fl.orgs.create('acme', { owner: 'ceo' });
    assert.ok(again.id);
  });

  it('the implicit single-tenant workspace is not takeable either', async () => {
    // A tier-2 application that has never heard the word "org" was equally
    // exposed, because the default workspace is a real org with a known name.
    const { DEFAULT_WORKSPACE } = await import('../src/simple.ts');
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const a = await fl.files.put(bytes('ALICE PRIVATE NOTES'), { owner: 'alice' });
    await rejects(() => fl.orgs.create(DEFAULT_WORKSPACE, { owner: 'mallory' }), 409);
    await rejects(() => fl.files.get(a.id, { as: 'mallory' }), 404);
  });

  it('files.put does not auto-join an existing named tenant', async () => {
    // One byte into somebody else's tenant added the uploader as a `member`,
    // which is read access to every `visibility: 'org'` file in it. `addMember`
    // denies the same call.
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    await fl.orgs.create('acme', { owner: 'ceo' });
    const memo = await fl.files.put(bytes('ORG WIDE MEMO'), {
      org: 'acme', owner: 'ceo', visibility: 'org',
    });

    await rejects(() => fl.files.put(bytes('x'), { org: 'acme', owner: 'mallory' }), 403);
    await rejects(() => fl.files.get(memo.id, { as: 'mallory' }), 404);

    // The tenant's own people are unaffected.
    assert.ok((await fl.files.put(bytes('legit'), { org: 'acme', owner: 'ceo' })).id);
    assert.equal(text((await fl.files.get(memo.id, { as: 'ceo' })).body), 'ORG WIDE MEMO');
  });
});

describe('2026-10-02: a bound instance stays inside its project', () => {
  // `#setOrgDeleted` and `#setActorDeleted` both carried the project filter.
  // `#setProjectDeleted`, twelve lines below them, did not -- so a project-bound
  // instance could delete, and RESTORE, another customer's entire project.
  // Restoring is the worse direction: it silently re-arms every share link an
  // operator believed revoked when they terminated that customer.
  it('cannot soft-delete or restore another customer`s project', async () => {
    const { db } = await createTestDb();
    const storage = new MemoryStorage();
    const { DEFAULT_PROJECT_ID } = await import('../src/store.ts');
    const A = new Filelayer(db, storage, { baseUrl: 'http://x', projectId: DEFAULT_PROJECT_ID });
    const pB = (
      await db.query<{ id: string }>(
        `INSERT INTO project (key, name) VALUES ('cust-b','B') RETURNING id`,
      )
    ).rows[0]!.id;
    const B = new Filelayer(db, storage, { baseUrl: 'http://x', projectId: pB });
    const bob = (await B.createActor('bob')).id;
    const orgB = (await B.createOrg('bcorp', 'B Corp', { ownerActorId: bob })).id;
    const fB = await B.upload(P(bob), orgB, {
      name: 'b.pdf', contentType: 'application/pdf', body: bytes('B SECRET'),
    });

    await rejects(() => A.softDeleteProject(pB), 404);
    await rejects(() => A.restoreProject(pB), 404);
    assert.equal(text((await B.read(P(bob), fB.id)).body), 'B SECRET');

    // B may still administer its own project, and the control plane -- an
    // instance built with an EXPLICIT `projectId: null`, which is the only way
    // to be unscoped; omitting the option binds you to the default project --
    // may still reach any of them.
    await B.softDeleteProject(pB);
    await rejects(() => B.read(P(bob), fB.id), 404);
    const control = new Filelayer(db, storage, { baseUrl: 'http://x', projectId: null });
    await control.restoreProject(pB);
    assert.equal(text((await B.read(P(bob), fB.id)).body), 'B SECRET');
  });
});

describe('2026-10-02: a bound asked for is never silently dropped', () => {
  // `input.expiresIn ? ... : null` made the two falsy numbers mean "never
  // expires". `NaN` is what `Number(req.body.ttl)` gives for a missing field and
  // `0` is what someone writes meaning "immediately", so the most restrictive
  // value anyone could ask for produced the least restrictive outcome -- while
  // `-1`, which is nonsense, failed closed. The same shape as the password that
  // was accepted and never enforced in 0.5.0.
  it('expiresIn 0 and NaN are refused rather than meaning "forever"', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const f = await fl.files.put(bytes('S'), { owner: 'alice' });
    for (const bad of [0, NaN, Infinity, -1]) {
      await rejects(() => fl.shares.create(f.id, { as: 'alice', expiresIn: bad }), 400);
    }
    // A real bound still works, and still binds.
    const sh = await fl.shares.create(f.id, { as: 'alice', expiresIn: 3600 });
    assert.equal(text((await fl.shares.redeem(sh.secret, {})).body), 'S');
  });

  it('the same holds for upload expiry and retention', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    for (const field of ['expiresIn', 'retainFor'] as const) {
      for (const bad of [0, NaN, -5]) {
        await rejects(() => fl.files.put(bytes('S'), { owner: 'a', [field]: bad }), 400);
      }
    }
    assert.ok((await fl.files.put(bytes('S'), { owner: 'a', expiresIn: 60 })).id);
  });
});

// =============================================================================
/** Resolve a facade-created identity by its external id. `Identities` is internal. */
async function idOf(fl: Filelayer, table: 'actor' | 'org', externalId: string): Promise<string> {
  const { rows } = await fl.store.db.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE external_id = $1`,
    [externalId],
  );
  return rows[0]!.id;
}

// 0.7.0 -- the second adversarial sweep, 2 October 2026
// =============================================================================

describe('2026-10-02: an expired file is not a file nobody can delete', () => {
  // `lifecycleDenial` returned `file_expired` for EVERY capability, `delete`
  // included, while the gates on either side of it were already scoped --
  // `pending` to `read`, `retention_hold` to `delete`. `delete()` is the only
  // method that removes bytes and it authorizes `delete` first, and the orphan
  // collector skips any key that still has a row. So an expired file was
  // terminal in both directions at once: the row could not go and the bytes
  // could not be collected.
  it('the owner can delete a file that has already expired', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const f = await fl.files.put(bytes('E'), { owner: 'alice', expiresIn: 1 });
    await new Promise((r) => setTimeout(r, 1300));

    // Reading is still refused -- expiry gates USE, which is the part that works.
    await rejects(() => fl.files.get(f.id, { as: 'alice' }), 410);
    // Deleting is not use.
    await fl.files.delete(f.id, { as: 'alice' });
    await rejects(() => fl.files.get(f.id, { as: 'alice' }), 404);
  });

  it('but a retention hold still binds, which is the control that should', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const f = await fl.files.put(bytes('R'), { owner: 'alice', retainFor: 3600 });
    await rejects(() => fl.files.delete(f.id, { as: 'alice' }), 409);
  });
});

describe('2026-10-02: an org cannot be stripped of its last owner', () => {
  // `authorizeMembershipChange` read the target's role through `getMembership`,
  // which excludes soft-deleted actors. For a soft-deleted owner that returned
  // null, so `superior_target` and `last_owner` BOTH stood down and an admin
  // could delete the sole owner's membership -- an operation refused outright
  // while that owner was live. Restoring the actor afterwards brought back an
  // identity with no role and no way to get one.
  it('an admin cannot remove the sole owner once that owner is soft-deleted', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    await fl.orgs.create('acme', { owner: 'alice' });
    await fl.orgs.setRole('acme', 'mallory', 'admin', { as: 'alice' });

    const aliceId = await idOf(fl, 'actor', 'alice');
    const mallory = await idOf(fl, 'actor', 'mallory');
    const org = await idOf(fl, 'org', 'acme');
    await fl.softDeleteActor(aliceId);

    // Driven through the core API with explicit ids, because the point is the
    // GUARD. The facade would refuse earlier, on resolving a soft-deleted
    // external id, and that would prove nothing about `last_owner`.
    await rejects(() => fl.removeMember(P(mallory), org, aliceId), 403);
    await rejects(() => fl.addMember(P(mallory), org, aliceId, 'viewer'), 403);

    // And the tenant is still repairable, which is the property that matters.
    await fl.restoreActor(aliceId);
    await fl.orgs.setRole('acme', 'bob', 'member', { as: 'alice' });
  });

  it('createOrg leaves no half-built tenant when the owner does not exist', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const ghost = '00000000-0000-4000-8000-00000000dead';
    await assert.rejects(() => fl.createOrg('acme', 'Acme', { ownerActorId: ghost }));

    // The org INSERT used to commit on its own, burning the external id forever:
    // nobody held `manage_members`, so no principal could create the first
    // membership, and `createOrg` again hit the unique constraint.
    const { rows } = await fl.store.db.query(`SELECT id FROM org WHERE external_id = 'acme'`);
    assert.equal(rows.length, 0, 'the whole thing rolled back');
    const ok = await fl.orgs.create('acme', { owner: 'alice' });
    assert.ok(ok.id, 'and the name is still available');
  });
});

describe('2026-10-02: bytes are never written for a request that is refused', () => {
  it('retainFor beyond expiresIn is a 400, and leaves no orphan', async () => {
    const storage = new MemoryStorage();
    const { db } = await createTestDb();
    const fl = new Filelayer(db, storage, { baseUrl: 'http://x' });
    const alice = (await fl.createActor('alice')).id;
    const org = (await fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;

    // The constraint fired on the INSERT, which is AFTER storage.put(). Every
    // rejected attempt therefore cost an object, with no row and no audit event
    // to find it by -- a member could run up a storage bill in a loop.
    await rejects(
      () =>
        fl.upload(P(alice), org, {
          name: 'x', contentType: 'text/plain', body: bytes('x'),
          expiresIn: 60, retainFor: 600,
        }),
      400,
    );
    assert.deepEqual(storage.keys(), [], 'nothing was written');
  });

  it('maxDownloads 0 is a 400, not a raw check-constraint violation', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const f = await fl.files.put(bytes('S'), { owner: 'alice' });
    for (const bad of [0, -1, 1.5, 2 ** 31]) {
      await rejects(() => fl.shares.create(f.id, { as: 'alice', maxDownloads: bad }), 400);
    }
    const sh = await fl.shares.create(f.id, { as: 'alice', maxDownloads: 1 });
    assert.equal(text((await fl.shares.redeem(sh.secret, {})).body), 'S');
    // 404, not 403: a capped-out link is answered the same way as one that never
    // existed, which is the uniform-denial rule the whole surface keeps.
    await rejects(() => fl.shares.redeem(sh.secret, {}), 404);
  });
});

describe('2026-10-02: the collector cannot be talked out of its grace period', () => {
  // `Math.max(60, x)` clamps every finite number, so 0 and -Infinity were
  // harmless. `Math.max(60, NaN)` is NaN, `cutoff` becomes NaN, and
  // `lastModified > NaN` is false for everything -- the skip never fired and the
  // grace period vanished. `Number(process.env.GC_GRACE)` on a misspelled
  // variable is NaN, so a correct caller with a typo deleted uploads in flight.
  it('a non-finite olderThanSeconds is refused, not silently infinite', async () => {
    const storage = new MemoryStorage();
    const { db } = await createTestDb();
    const fl = new Filelayer(db, storage, { baseUrl: 'http://x' });
    await storage.put('in-flight/key', bytes('x'), 'text/plain');

    for (const bad of [NaN, Number('oops')]) {
      await rejects(() => fl.collectStorageOrphans({ olderThanSeconds: bad, dryRun: false }), 400);
    }
    assert.deepEqual(storage.keys(), ['in-flight/key'], 'the fresh object survives');
  });
});

describe('2026-10-02: verifying a chain tells you where its head is', () => {
  // Replay alone cannot detect truncation: remove the last n events and what
  // remains is perfectly consistent. The library cannot fix that from inside the
  // database -- an anchor stored here is editable by whoever deleted the rows --
  // so it owes the caller the value to pin OUTSIDE.
  it('verifyAuditChain returns the head id and hash', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    // Reading an audit chain needs `read_audit`, so alice has to be an OWNER --
    // `files.put` would only have made her a member of a tenant it created.
    await fl.orgs.create('acme', { owner: 'alice' });
    await fl.files.put(bytes('S'), { org: 'acme', owner: 'alice' });
    const org = await idOf(fl, 'org', 'acme');

    const r = await fl.verifyAuditChain(P(await idOf(fl, 'actor', 'alice')), org);
    assert.equal(r.valid, true);
    assert.ok(r.lastId !== null && r.lastHash !== null, 'the head is reported');

    const { rows } = await fl.store.db.query<{ id: number; hash: string }>(
      `SELECT id, hash FROM audit_event WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
      [org],
    );
    assert.equal(Number(r.lastId), Number(rows[0]!.id));
    assert.equal(r.lastHash, rows[0]!.hash);
  });

  it('TRUNCATE on the audit table is refused', async () => {
    const { db } = await createTestDb();
    await assert.rejects(() => db.query(`TRUNCATE audit_event`), /append-only/);
  });
});

describe('2026-10-02: an operation that audits nothing is a bug', () => {
  it('soft-deleting an actor with no memberships still writes an event', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    const loner = (await fl.createActor('loner')).id;

    const before = (
      await fl.store.db.query<{ c: number }>(`SELECT count(*)::int c FROM audit_event`)
    ).rows[0]!.c;
    await fl.softDeleteActor(loner);
    await fl.restoreActor(loner);
    const after = await fl.store.db.query<{ action: string; org_id: string | null }>(
      `SELECT action, org_id FROM audit_event ORDER BY id DESC LIMIT 2`,
    );
    assert.equal(
      (await fl.store.db.query<{ c: number }>(`SELECT count(*)::int c FROM audit_event`)).rows[0]!.c,
      before + 2,
    );
    assert.deepEqual(
      after.rows.map((r) => r.action).sort(),
      ['actor.delete', 'actor.restore'],
    );
    assert.ok(after.rows.every((r) => r.org_id === null), 'on the system chain');
  });
});

describe('2026-10-02: limit: 0 means zero, or it means refuse', () => {
  it('the two audit surfaces agree, and listFiles stops guessing', async () => {
    const fl = await Filelayer.quickstart({ baseUrl: 'http://x' });
    await fl.orgs.create('acme', { owner: 'alice' });
    await fl.files.put(bytes('S'), { org: 'acme', owner: 'alice' });
    await fl.files.put(bytes('T'), { org: 'acme', owner: 'alice' });

    // The facade discarded 0 by truthiness and returned the default page, while
    // the verbose call on the same data returned nothing.
    assert.deepEqual(await fl.orgs.audit('acme', { as: 'alice', limit: 0 }), []);
    // listFiles clamped 0 UP to one row: neither reading of the argument.
    const alice = await idOf(fl, 'actor', 'alice');
    const org = await idOf(fl, 'org', 'acme');
    await rejects(() => fl.listFiles(P(alice), org, { limit: 0 }), 400);
  });
});
