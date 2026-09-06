/**
 * THE SEMANTICS SUITE -- deletion, lifecycle, revocation, metering, ingest.
 *
 * Every test in this file encodes a DECISION, not an observation. Where a
 * question was previously an open ambiguity -- what a soft delete reaches, what
 * `maxDownloads` counts, whether the audit chain can fork, whose id space
 * `external_id` lives in, what the ingest boundary owns -- the test is named for
 * the answer we chose, and its comment says why that answer and not the other
 * one. If someone later changes the behaviour, the test that goes red should
 * tell them which product decision they are reversing.
 *
 * The prose companion is SEMANTICS.md. This file is the enforceable copy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestDb, type Queryable } from '../src/db.ts';
import { Filelayer } from '../src/filelayer.ts';
import { MemoryStorage } from '../src/storage.ts';
import { auditHash, auditHashTail, DEFAULT_PROJECT_ID } from '../src/store.ts';
import { newWorld, bytes, rejects, dbRejects, countAudit } from './helpers.ts';

// -----------------------------------------------------------------------------
// A tenant with one owner, one member, one outsider, one private file, and two
// live grants over it: a link and an actor grant. An anonymous grant is opt-in,
// because a file that anyone may read makes most denial assertions vacuous.
// -----------------------------------------------------------------------------

async function tenant(opts: { anonymous?: boolean } = {}) {
  const w = await newWorld();
  const alice = (await w.fl.createActor('alice')).id; // owner
  const anna = (await w.fl.createActor('anna')).id; // member
  const bob = (await w.fl.createActor('bob')).id; // outsider with a grant
  const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  await w.fl.addMember({ actorId: alice }, org, anna, 'member');

  const file = await w.fl.upload({ actorId: alice }, org, {
    name: 'plan.pdf',
    contentType: 'application/pdf',
    body: bytes('ACME CONFIDENTIAL'),
  });

  const link = await w.fl.share({ actorId: alice }, file.id, { subject: { type: 'link' } });
  const toBob = await w.fl.share({ actorId: alice }, file.id, {
    subject: { type: 'actor', actorId: bob },
  });
  const anon = opts.anonymous
    ? await w.fl.share({ actorId: alice }, file.id, { subject: { type: 'anonymous' } })
    : null;

  return { ...w, org, alice, anna, bob, file, link, toBob, anon };
}

/** Is this grant live according to the schema predicate itself? */
async function isLive(db: Queryable, grantId: string): Promise<boolean> {
  const { rows } = await db.query<{ live: boolean }>(`SELECT grant_is_live($1) AS live`, [grantId]);
  return Boolean(rows[0]!.live);
}

/**
 * The two INDEPENDENT liveness formulations must agree on every row. This is
 * the cross-check that makes "grant_is_live is correct" a stronger claim than
 * "grant_is_live agrees with itself": the soft-delete rule had to be added to
 * both formulations independently.
 */
async function livenessFormulationsAgree(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ id: string; fn: boolean; view: boolean }>(
    `SELECT g.id,
            grant_is_live(g.id) AS fn,
            EXISTS (SELECT 1 FROM live_grant_recursive r WHERE r.id = g.id) AS view
       FROM file_grant g`,
  );
  for (const r of rows) {
    assert.equal(
      Boolean(r.fn),
      Boolean(r.view),
      `grant_is_live and live_grant_recursive disagree on ${r.id}`,
    );
  }
  assert.ok(rows.length > 0, 'the cross-check must not pass vacuously');
}

// =============================================================================
// SOFT DELETE (a). DELETING A TENANT
// =============================================================================

describe('soft-deleting an ORG kills every grant in it, immediately', () => {
  /**
   * THE DECISION: everything dies.
   *
   * The alternative -- grants survive the tenant -- was the previous behaviour
   * and nobody chose it: `getMembership()` filtered on `org.deleted_at` and
   * `getActorGrants()` did not, so revoking a customer removed the OWNER's
   * access and left the CONTRACTOR's share links serving bytes. "We deleted
   * that tenant" has exactly one honest meaning, and it is this one.
   */
  it('a live share link, actor grant and anonymous grant all stop working the instant the org is deleted', async () => {
    const s = await tenant({ anonymous: true });

    // All three work first, so the test cannot pass vacuously.
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);
    assert.ok((await s.fl.read({ actorId: s.bob }, s.file.id)).body.byteLength > 0);
    assert.ok((await s.fl.read({ actorId: null }, s.file.id)).body.byteLength > 0);

    await s.fl.softDeleteOrg(s.org);

    await rejects(() => s.fl.redeem(s.link.secret!), 404);
    await rejects(() => s.fl.read({ actorId: s.bob }, s.file.id), 404);
    await rejects(() => s.fl.read({ actorId: null }, s.file.id), 404);
    // ...and membership-derived access is gone too, as it always was.
    await rejects(() => s.fl.read({ actorId: s.alice }, s.file.id), 404);
  });

  it('the SCHEMA is the enforcement point, not the application: live_grant is empty', async () => {
    const s = await tenant({ anonymous: true });
    const { rows: before } = await s.db.query(`SELECT id FROM live_grant`);
    assert.equal(before.length, 3);

    await s.fl.softDeleteOrg(s.org);

    // A future query that reaches for live_grant -- any query, from any writer,
    // including psql -- inherits the semantic. That is the whole reason this
    // lives in the predicate rather than in authz.ts.
    const { rows: after } = await s.db.query(`SELECT id FROM live_grant`);
    assert.deepEqual(after, []);
    await livenessFormulationsAgree(s.db);
  });

  it('is REVERSIBLE: restoring the org revives the same links, with no re-issue', async () => {
    const s = await tenant();
    await s.fl.softDeleteOrg(s.org);
    await rejects(() => s.fl.redeem(s.link.secret!), 404);

    await s.fl.restoreOrg(s.org);

    // The SAME secret, unmodified. Liveness is derived, so undelete costs
    // nothing and cannot restore a grant that was independently revoked.
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);
    assert.ok((await s.fl.read({ actorId: s.alice }, s.file.id)).body.byteLength > 0);
  });

  it('an independently revoked grant is NOT resurrected by undelete', async () => {
    const s = await tenant();
    await s.fl.revoke({ actorId: s.alice }, s.link.grantId);
    await s.fl.softDeleteOrg(s.org);
    await s.fl.restoreOrg(s.org);

    await rejects(() => s.fl.redeem(s.link.secret!), 404);
    assert.equal(await isLive(s.db, s.link.grantId), false);
    assert.equal(await isLive(s.db, s.toBob.grantId), true);
  });

  /**
   * THE DECISION on the retention/legal-hold interaction: soft-deleting a
   * tenant SUSPENDS ACCESS and PRESERVES EVIDENCE. It is not an erasure
   * primitive, it writes no row that a retention hold protects, and the audit
   * chain of the deleted tenant remains intact and verifiable.
   *
   * The alternative -- "delete the org, delete the data" -- would make tenant
   * deletion a way to destroy records under legal hold, which is the exact
   * failure the retention control exists to prevent. Erasure is a separate,
   * privileged operation gated on retention, and it is not this one.
   */
  it('does NOT defeat retention: the file, its hold, and the tenant audit chain all survive', async () => {
    const s = await tenant();
    const held = await s.fl.upload({ actorId: s.alice }, s.org, {
      name: 'held.pdf',
      contentType: 'application/pdf',
      body: bytes('UNDER LEGAL HOLD'),
      retainFor: 3600,
    });
    const before = await countAudit(s.db, s.org);

    await s.fl.softDeleteOrg(s.org);

    const { rows } = await s.db.query<{ n: number; retain: string | null; del: string | null }>(
      `SELECT count(*)::int AS n, max(retain_until::text) AS retain, max(deleted_at::text) AS del
         FROM file WHERE id = $1`,
      [held.id],
    );
    assert.equal(Number(rows[0]!.n), 1, 'the row is still there');
    assert.ok(rows[0]!.retain, 'the retention floor is untouched');
    assert.equal(rows[0]!.del, null, 'the FILE was not deleted; the ORG was');

    // The chain is unbroken and still verifiable through the deletion.
    const chain = await s.fl.store.verifyAuditChain(s.org);
    assert.equal(chain.valid, true);
    assert.ok(chain.checked > before, 'the deletion itself is on the record');

    // And the deletion is attributed, not silent.
    const log = await s.fl.store.listAudit(s.org, { action: 'org.delete' });
    assert.equal(log.length, 1);
  });

  it('listFiles and authorize still agree after the org is deleted: both return nothing', async () => {
    const s = await tenant();
    await s.fl.softDeleteOrg(s.org);
    for (const p of [{ actorId: s.alice }, { actorId: s.bob }, { actorId: null }]) {
      const page = await s.fl.listFiles(p, s.org);
      assert.deepEqual(page.files, []);
    }
  });
});

// =============================================================================
// SOFT DELETE (b). DELETING AN IDENTITY
// =============================================================================

describe('soft-deleting an ACTOR kills what they hold AND what they issued', () => {
  /** The easy half, and it did not exist: `actor.deleted_at` was decorative. */
  it('a deleted SUBJECT loses both their role-derived access and every grant made to them', async () => {
    const s = await tenant();
    assert.ok((await s.fl.read({ actorId: s.bob }, s.file.id)).body.byteLength > 0);

    await s.fl.softDeleteActor(s.bob);
    await rejects(() => s.fl.read({ actorId: s.bob }, s.file.id), 404);
    assert.equal(await isLive(s.db, s.toBob.grantId), false);

    // The membership half, on a different identity, so both are covered.
    const own = await s.fl.upload({ actorId: s.anna }, s.org, {
      name: 'annas.txt',
      contentType: 'text/plain',
      body: bytes('mine'),
    });
    assert.ok((await s.fl.read({ actorId: s.anna }, own.id)).body.byteLength > 0);
    await s.fl.softDeleteActor(s.anna);
    await rejects(() => s.fl.read({ actorId: s.anna }, own.id), 404);
  });

  /**
   * THE JUDGEMENT CALL, and the call is P4.
   *
   * "A signed URL may never outlive the permission that created it" is the
   * property this product is. A root grant is minted from the issuer's
   * role-derived authority; delete the identity and that authority no longer
   * exists, so the grant must go with it. The alternative is the "the intern
   * left two years ago and their Dropbox link still works" failure, which is
   * the failure we sell against.
   *
   * It is deliberately LOUD: deleting a prolific sharer revokes a lot of links
   * at once. That is the correct reading of the rule, not a side effect, and
   * SEMANTICS.md tells operators to expect it.
   */
  it('a deleted ISSUER takes their links with them, including links held by third parties', async () => {
    const s = await tenant({ anonymous: true });
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);
    assert.ok((await s.fl.read({ actorId: s.bob }, s.file.id)).body.byteLength > 0);

    // Alice issued all three grants. Deleting her kills all three, even though
    // none of them is ADDRESSED to her.
    await s.fl.softDeleteActor(s.alice);

    await rejects(() => s.fl.redeem(s.link.secret!), 404);
    await rejects(() => s.fl.read({ actorId: s.bob }, s.file.id), 404);
    await rejects(() => s.fl.read({ actorId: null }, s.file.id), 404);
    await livenessFormulationsAgree(s.db);
  });

  it('the whole delegated subtree below a deleted issuer dies with it, at any depth', async () => {
    const s = await tenant();
    // bob holds {read, share} and delegates onward to a link.
    await s.fl.share({ actorId: s.alice }, s.file.id, {
      subject: { type: 'actor', actorId: s.bob },
      capabilities: ['read', 'share'],
    });
    const delegated = await s.fl.share({ actorId: s.bob }, s.file.id, { subject: { type: 'link' } });
    assert.ok((await s.fl.redeem(delegated.secret!)).body.byteLength > 0);

    // Delete the MIDDLE of the chain, not the root.
    await s.fl.softDeleteActor(s.bob);
    await rejects(() => s.fl.redeem(delegated.secret!), 404);
    assert.equal(await isLive(s.db, delegated.grantId), false);

    // ...and Alice's own root link, issued by a living actor, is untouched.
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);
  });

  it('is REVERSIBLE: restoring the identity revives exactly what deleting it killed', async () => {
    const s = await tenant();
    await s.fl.softDeleteActor(s.alice);
    await rejects(() => s.fl.redeem(s.link.secret!), 404);
    await s.fl.restoreActor(s.alice);
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);
    assert.ok((await s.fl.read({ actorId: s.bob }, s.file.id)).body.byteLength > 0);
  });

  /**
   * THE DELIBERATE ASYMMETRY, stated as a test so nobody "fixes" it by
   * accident.
   *
   * Removing a MEMBERSHIP does not kill grants that member issued. Membership
   * removal is a role change inside a living tenant -- someone changed teams,
   * duties were transferred -- and mass-revoking a departing colleague's
   * customer-facing links as a side effect of a role edit would be a surprise
   * with real business cost. Identity DELETION is a different statement: this
   * person is gone. The operator who wants the strong effect has an operation
   * that produces it, and `listGrants` + `revoke` for anything narrower.
   */
  it('REMOVING a membership does NOT revoke grants that member issued (deletion is the strong verb)', async () => {
    const s = await tenant();
    const annas = await s.fl.upload({ actorId: s.anna }, s.org, {
      name: 'annas.pdf',
      contentType: 'application/pdf',
      body: bytes('annas work'),
    });
    const annasLink = await s.fl.share({ actorId: s.anna }, annas.id, { subject: { type: 'link' } });

    await s.fl.removeMember({ actorId: s.alice }, s.org, s.anna);

    // Anna herself can no longer reach it -- she has no standing at all.
    await rejects(() => s.fl.read({ actorId: s.anna }, annas.id), 404);
    // But the link she handed a customer keeps working, on purpose.
    assert.ok((await s.fl.redeem(annasLink.secret!)).body.byteLength > 0);

    // Deleting her, in contrast, does kill it.
    await s.fl.softDeleteActor(s.anna);
    await rejects(() => s.fl.redeem(annasLink.secret!), 404);
  });
});

// =============================================================================
// SOFT DELETE (c). DELETING A FILE
// =============================================================================

describe('a deleted FILE has no live grants, not merely unusable ones', () => {
  /**
   * `authorize()` already denied on a deleted file via the lifecycle gate, so
   * nothing was reachable. But `grant_is_live()` still said TRUE, which made
   * `live_grant` -- documented as THE enforcement point that every store query
   * must read through -- state something false. Any second consumer of that
   * view would have inherited the lie. The predicate now tells the truth.
   */
  it('deleting a file makes its grants non-live in the schema, and listGrants says so', async () => {
    const s = await tenant({ anonymous: true });
    assert.equal(await isLive(s.db, s.link.grantId), true);

    await s.fl.delete({ actorId: s.alice }, s.file.id);

    assert.equal(await isLive(s.db, s.link.grantId), false);
    assert.equal(await isLive(s.db, s.toBob.grantId), false);
    assert.equal(await isLive(s.db, s.anon!.grantId), false);
    const { rows } = await s.db.query(`SELECT id FROM live_grant`);
    assert.deepEqual(rows, []);
    await livenessFormulationsAgree(s.db);
  });

  it('a grant on a deleted file cannot be delegated from: the DATABASE refuses', async () => {
    const s = await tenant();
    await s.fl.share({ actorId: s.alice }, s.file.id, {
      subject: { type: 'actor', actorId: s.bob },
      capabilities: ['read', 'share'],
    });
    await s.fl.delete({ actorId: s.alice }, s.file.id);

    // Through the API the engine refuses first (the file is gone), and through
    // raw SQL the attenuation trigger refuses. Both doors, one semantic.
    await rejects(
      () => s.fl.share({ actorId: s.bob }, s.file.id, { subject: { type: 'link' } }),
      404,
    );
    const { rows } = await s.db.query<{ id: string }>(
      `SELECT id FROM file_grant WHERE subject_id = $1 AND 'share' = ANY(capabilities)`,
      [s.bob],
    );
    await dbRejects(
      s.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, capabilities, secret_hash)
       VALUES ($1,$2,$3,'link','{read}'::grant_capability[],'deadbeef')`,
      [s.file.id, s.org, rows[0]!.id],
      /grant_parent_not_live/,
    );
  });
});

// =============================================================================
// SOFT DELETE (d). DELETING A CUSTOMER
// =============================================================================

describe('soft-deleting a PROJECT revokes the whole customer', () => {
  it('every org, file and grant under a deleted project is dead, and restore brings it all back', async () => {
    const s = await tenant();
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);

    await s.fl.softDeleteProject(DEFAULT_PROJECT_ID);

    await rejects(() => s.fl.redeem(s.link.secret!), 404);
    await rejects(() => s.fl.read({ actorId: s.alice }, s.file.id), 404);
    const { rows } = await s.db.query(`SELECT id FROM live_grant`);
    assert.deepEqual(rows, []);

    await s.fl.restoreProject(DEFAULT_PROJECT_ID);
    assert.ok((await s.fl.redeem(s.link.secret!)).body.byteLength > 0);
  });

  it('a project-level action is recorded on the SYSTEM chain, not fanned out over tenants', async () => {
    const s = await tenant();
    const tenantBefore = await countAudit(s.db, s.org);
    await s.fl.softDeleteProject(DEFAULT_PROJECT_ID);
    // Not on the tenant chain: a control-plane action must not let one call
    // append an unbounded number of rows to an unbounded number of customer
    // chains. That is the ingest-boundary amplification concern in a different
    // costume.
    assert.equal(await countAudit(s.db, s.org), tenantBefore);
    const sys = await s.fl.store.listAudit(null, { action: 'project.delete' });
    assert.equal(sys.length, 1);
    assert.equal((await s.fl.store.verifyAuditChain(null)).valid, true);
  });
});

// =============================================================================
// WHAT `maxDownloads` COUNTS
// =============================================================================

describe('maxDownloads counts BYTE DELIVERIES, on every path', () => {
  /**
   * THE DECISION: charge on every delivery.
   *
   * It used to be charged only by `redeem()`. An actor grant with
   * `maxDownloads: 1` therefore permitted unlimited direct `read()` calls --
   * the cap was a lie on the path the SDK actually uses. The two alternatives
   * were rejected in the comment on `Filelayer.deliver()`: renaming it
   * `maxRedemptions` moves the ambiguity rather than closing it, and refusing
   * the field on non-link grants removes a capability instead of defining one.
   */
  it('N direct read() calls through a capped actor grant DO decrement it', async () => {
    const s = await tenant();
    const capped = await s.fl.share({ actorId: s.alice }, s.file.id, {
      subject: { type: 'actor', actorId: s.bob },
      maxDownloads: 2,
    });
    // The pre-existing uncapped grant to bob would mask the cap, so remove it.
    await s.fl.revoke({ actorId: s.alice }, s.toBob.grantId);

    const first = await s.fl.read({ actorId: s.bob }, s.file.id);
    assert.equal(first.remainingDownloads, 1);
    const second = await s.fl.read({ actorId: s.bob }, s.file.id);
    assert.equal(second.remainingDownloads, 0);
    await rejects(() => s.fl.read({ actorId: s.bob }, s.file.id), 404);

    assert.equal(await isLive(s.db, capped.grantId), false);
  });

  it('read() and redeem() draw on ONE budget shared across the delegation chain', async () => {
    const s = await tenant();
    await s.fl.revoke({ actorId: s.alice }, s.toBob.grantId);
    const parent = await s.fl.share({ actorId: s.alice }, s.file.id, {
      subject: { type: 'actor', actorId: s.bob },
      capabilities: ['read', 'share'],
      maxDownloads: 2,
    });
    const child = await s.fl.share({ actorId: s.bob }, s.file.id, { subject: { type: 'link' } });
    assert.equal(child.maxDownloads, 2, 'the child is clamped to the parent budget');

    // One direct read by bob spends one of the two...
    assert.equal((await s.fl.read({ actorId: s.bob }, s.file.id)).remainingDownloads, 1);
    // ...and one redemption of the delegated link spends the last one.
    assert.equal((await s.fl.redeem(child.secret!)).remainingDownloads, 0);

    await rejects(() => s.fl.redeem(child.secret!), 404);
    await rejects(() => s.fl.read({ actorId: s.bob }, s.file.id), 404);
    assert.equal(await isLive(s.db, parent.grantId), false);
  });

  /**
   * THE BOUNDARY of the rule, and it is the reason the rule is stated as "via a
   * grant" rather than "on every read": an administrator doing their job must
   * not silently spend a contractor's link budget.
   */
  it('a role-derived read does NOT charge anyone: the cap binds the CREDENTIAL, not the file', async () => {
    const s = await tenant();
    await s.fl.revoke({ actorId: s.alice }, s.toBob.grantId);
    const capped = await s.fl.share({ actorId: s.alice }, s.file.id, {
      subject: { type: 'actor', actorId: s.bob },
      maxDownloads: 1,
    });
    // The owner, and an admin exercising the retention/compliance access the
    // role matrix gives them. Neither is spending anyone's credential.
    await s.fl.addMember({ actorId: s.alice }, s.org, s.anna, 'admin');
    for (let i = 0; i < 5; i++) await s.fl.read({ actorId: s.alice }, s.file.id);
    for (let i = 0; i < 5; i++) await s.fl.read({ actorId: s.anna }, s.file.id);

    const { rows } = await s.db.query<{ c: number }>(
      `SELECT download_count AS c FROM file_grant WHERE id = $1`,
      [capped.grantId],
    );
    assert.equal(Number(rows[0]!.c), 0);
    assert.equal((await s.fl.read({ actorId: s.bob }, s.file.id)).remainingDownloads, 0);
  });

  it('stat() is metadata, not delivery, and never spends a download', async () => {
    const s = await tenant();
    await s.fl.revoke({ actorId: s.alice }, s.toBob.grantId);
    const capped = await s.fl.share({ actorId: s.alice }, s.file.id, {
      subject: { type: 'actor', actorId: s.bob },
      maxDownloads: 1,
    });
    for (let i = 0; i < 4; i++) {
      const rec = await s.fl.stat({ actorId: s.bob }, s.file.id);
      assert.equal(rec.name, 'plan.pdf');
    }
    const { rows } = await s.db.query<{ c: number }>(
      `SELECT download_count AS c FROM file_grant WHERE id = $1`,
      [capped.grantId],
    );
    assert.equal(Number(rows[0]!.c), 0);
    // The one delivery still works, so the cap was genuinely unspent.
    assert.ok((await s.fl.read({ actorId: s.bob }, s.file.id)).body.byteLength > 0);
  });

  it('the anonymous public path is capped too, so a public URL can be a budget', async () => {
    const w = await newWorld();
    const alice = (await w.fl.createActor('alice')).id;
    const org = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
    const file = await w.fl.upload({ actorId: alice }, org, {
      name: 'poster.png',
      contentType: 'image/png',
      body: bytes('POSTER'),
    });
    await w.fl.share({ actorId: alice }, file.id, {
      subject: { type: 'anonymous' },
      maxDownloads: 2,
    });
    assert.equal((await w.fl.read({ actorId: null }, file.id)).remainingDownloads, 1);
    assert.equal((await w.fl.read({ actorId: null }, file.id)).remainingDownloads, 0);
    await rejects(() => w.fl.read({ actorId: null }, file.id), 404);
  });
});

// =============================================================================
// THE AUDIT CHAIN CANNOT FORK
// =============================================================================

describe('the audit chain is appended under a per-chain lock', () => {
  it('the write path is a single statement that takes pg_advisory_xact_lock', async () => {
    const w = await newWorld();
    const { rows } = await w.db.query<{ def: string }>(
      `SELECT pg_get_functiondef(oid) AS def FROM pg_proc WHERE proname = 'audit_append'`,
    );
    assert.equal(rows.length, 1, 'there is exactly one append path');
    const def = rows[0]!.def;
    assert.match(def, /pg_advisory_xact_lock\(audit_chain_lock_key/);
    // The lock must be taken BEFORE the predecessor is read, or the window it
    // exists to close is still open.
    assert.ok(
      def.indexOf('pg_advisory_xact_lock') < def.indexOf('ORDER BY a.id DESC'),
      'the lock must precede the read of the predecessor',
    );
  });

  it('the lock key is per-chain: two orgs do not serialize against each other, and the system chain is its own', async () => {
    const w = await newWorld();
    const a = (await w.fl.createOrg('a')).id;
    const b = (await w.fl.createOrg('b')).id;
    const { rows } = await w.db.query<{ ka: string; kb: string; ks: string; ka2: string }>(
      `SELECT audit_chain_lock_key($1)::text AS ka,
              audit_chain_lock_key($2)::text AS kb,
              audit_chain_lock_key(NULL)::text AS ks,
              audit_chain_lock_key($1)::text AS ka2`,
      [a, b],
    );
    const r = rows[0]!;
    assert.equal(r.ka, r.ka2, 'the key is deterministic');
    assert.notEqual(r.ka, r.kb);
    assert.notEqual(r.ka, r.ks);
    assert.notEqual(r.kb, r.ks);
  });

  /**
   * The digest is now computed in SQL on write and in TypeScript on read. That
   * is only safe if the two agree bit for bit, so this asserts it directly
   * rather than relying on `verifyAuditChain` to notice later.
   */
  it('the SQL digest equals the TypeScript digest, field for field', async () => {
    const w = await newWorld();
    const occurredAt = new Date('2026-09-05T12:34:56.789Z');
    const fields = {
      orgId: null,
      occurredAt,
      action: 'file.read',
      decision: 'deny' as const,
      reason: 'no_grant',
      actorId: null,
      fileId: '11111111-2222-4333-8444-555555555555',
      grantId: null,
      ip: '203.0.113.9',
      userAgent: 'probe/1.0 "quoted" \\ backslash',
      context: { z: 1, a: { nested: 'é ☃', arr: [1, null, 'x'] } },
    };
    const { rows } = await w.db.query<{ hash: string; prev_hash: string | null }>(
      `SELECT hash, prev_hash FROM audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [
        fields.orgId,
        occurredAt.toISOString(),
        fields.action,
        fields.decision,
        fields.reason,
        fields.actorId,
        fields.fileId,
        fields.grantId,
        fields.ip,
        fields.userAgent,
        JSON.stringify(fields.context),
        auditHashTail(fields),
      ],
    );
    assert.equal(rows[0]!.hash, auditHash({ prevHash: rows[0]!.prev_hash, ...fields }));
  });

  it('prev_hash is the FIRST element of the digest, which is what makes the SQL side a concatenation and not a re-implementation', async () => {
    const fields = {
      orgId: null,
      occurredAt: new Date(0),
      action: 'x',
      decision: 'allow',
      actorId: null,
      fileId: null,
    };
    const tail = auditHashTail(fields);
    assert.equal(tail.startsWith('['), false, 'the tail carries no leading bracket');
    for (const prev of [null, 'abc']) {
      assert.equal(
        auditHash({ prevHash: prev, ...fields }),
        createHash('sha256')
          .update(`[${JSON.stringify(prev)},${tail}`, 'utf8')
          .digest('hex'),
      );
    }
    // ...and the tail is genuinely independent of the predecessor.
    assert.notEqual(auditHash({ prevHash: null, ...fields }), auditHash({ prevHash: 'abc', ...fields }));
  });

  /**
   * WHAT PGlite CANNOT PROVE, stated as a test name so it is impossible to
   * forget. PGlite is a single backend: two transactions cannot exist at the
   * same instant, so no test here can demonstrate contention, a waiting writer,
   * or a fork actually prevented. What this test does is show that the FORK
   * THE OLD CODE PRODUCED is detectable -- i.e. that the failure mode being
   * eliminated is real and observable -- and leave the serialization proof to a
   * multi-connection deployment suite.
   */
  it('CONTROL: a fork of the kind the old SELECT-then-INSERT could produce IS detected (PGlite cannot prove serialization)', async () => {
    const s = await tenant();
    const { rows } = await s.db.query<{ prev_hash: string | null; hash: string }>(
      `SELECT prev_hash, hash FROM audit_event WHERE org_id = $1 ORDER BY id DESC LIMIT 1`,
      [s.org],
    );
    assert.equal((await s.fl.store.verifyAuditChain(s.org)).valid, true);

    // Two writers that both read the same predecessor: this is exactly what the
    // unlocked SELECT-then-INSERT would have written under concurrency.
    await s.db.query(
      `INSERT INTO audit_event (org_id, action, decision, prev_hash, hash)
       VALUES ($1, 'file.read', 'allow', $2, 'forked')`,
      [s.org, rows[0]!.prev_hash],
    );
    const after = await s.fl.store.verifyAuditChain(s.org);
    assert.equal(after.valid, false);
    assert.equal(after.problem, 'prev_hash_mismatch');
  });
});

// =============================================================================
// THE CUSTOMER'S ID SPACE IS THE CUSTOMER'S
// =============================================================================

describe('external_id is scoped to the project, not global', () => {
  async function twoProjects() {
    const { db } = await createTestDb();
    const storage = new MemoryStorage();
    const a = new Filelayer(db, storage, { baseUrl: 'https://a.test' });
    const pb = (await a.createProject('customer-b', 'Customer B')).id;
    const b = new Filelayer(db, storage, { baseUrl: 'https://b.test', projectId: pb });
    return { db, storage, a, b, pb };
  }

  /**
   * THE DEFECT, and it was reachable from the most ergonomic entry point we
   * ship. Under a GLOBAL unique index on `external_id`, customer B calling
   * `files.put({ org: 'acme', owner: 'mallory' })` did not get an error: the
   * `ON CONFLICT (external_id) DO UPDATE ... RETURNING id` in `Identities.org`
   * returned CUSTOMER A's org id, and `Identities.membership` then added
   * mallory to A's tenant as a member. A common org name was a complete
   * cross-customer compromise.
   */
  it('two customers may both call their tenant "acme", and the second does not take over the first', async () => {
    const { a, b } = await twoProjects();
    const fileA = await a.files.put(bytes('A CONFIDENTIAL'), { org: 'acme', owner: 'alice' });
    const fileB = await b.files.put(bytes('B CONFIDENTIAL'), { org: 'acme', owner: 'mallory' });

    const orgA = await a.store.db.query<{ id: string }>(
      `SELECT id FROM org WHERE external_id = 'acme' AND project_id = $1`,
      [DEFAULT_PROJECT_ID],
    );
    const orgB = await a.store.db.query<{ id: string }>(
      `SELECT id FROM org WHERE external_id = 'acme' AND project_id <> $1`,
      [DEFAULT_PROJECT_ID],
    );
    assert.notEqual(orgA.rows[0]!.id, orgB.rows[0]!.id, 'two rows, not one shared row');

    // Mallory is a member of B's acme and of nothing in A's.
    const { rows: cross } = await a.store.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM membership m JOIN actor ac ON ac.id = m.actor_id
        WHERE m.org_id = $1 AND ac.external_id = 'mallory'`,
      [orgA.rows[0]!.id],
    );
    assert.equal(Number(cross[0]!.n), 0);

    assert.notEqual(fileA.id, fileB.id);
  });

  it("the same user id in two customers' apps is two different people", async () => {
    const { a, b } = await twoProjects();
    await a.files.put(bytes('A doc'), { org: 'acme', owner: 'alice' });
    await b.files.put(bytes('B doc'), { org: 'acme', owner: 'alice' });
    const { rows } = await a.store.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM actor WHERE external_id = 'alice'`,
    );
    assert.equal(Number(rows[0]!.n), 2);
  });

  it('a project-bound instance cannot read another project’s file even holding its UUID', async () => {
    const { a, b } = await twoProjects();
    const fileA = await a.files.put(bytes('A CONFIDENTIAL'), { org: 'acme', owner: 'alice' });
    const aliceA = (
      await a.store.db.query<{ id: string }>(
        `SELECT id FROM actor WHERE external_id = 'alice' AND project_id = $1`,
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]!.id;

    // The real id, the real owner, the wrong project.
    await rejects(() => b.read({ actorId: aliceA }, fileA.id), 404);
    await rejects(() => b.stat({ actorId: aliceA }, fileA.id), 404);
  });

  /**
   * THIS IS THE PART OF THE AUDIT-FLOODING EXPOSURE THAT IS STRUCTURALLY
   * FIXABLE. A caller who guesses an org UUID belonging to a different project
   * cannot append to that org's audit chain at all: `orgExists` is
   * project-scoped, so the denial is written to the system chain instead. The
   * remaining exposure -- an authenticated customer flooding their OWN tenant's
   * chain -- is a quota problem, and the ingest requirement is recorded in
   * SEMANTICS.md.
   */
  it('probing another project’s org id lands on the SYSTEM chain, not that tenant’s', async () => {
    const { a, b } = await twoProjects();
    await a.files.put(bytes('A doc'), { org: 'acme', owner: 'alice' });
    const orgA = (
      await a.store.db.query<{ id: string }>(
        `SELECT id FROM org WHERE external_id = 'acme' AND project_id = $1`,
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]!.id;

    const before = await countAudit(a.store.db, orgA);
    const beforeSystem = await countAudit(a.store.db, null);

    for (let i = 0; i < 5; i++) {
      const page = await b.listFiles({ actorId: null }, orgA);
      assert.deepEqual(page.files, []);
    }

    assert.equal(await countAudit(a.store.db, orgA), before, 'the victim tenant chain is untouched');
    assert.equal(await countAudit(a.store.db, null), beforeSystem + 5, 'the probes are still recorded');
    assert.equal((await a.store.verifyAuditChain(null)).valid, true);
  });

  it('the DATABASE refuses a cross-project membership and a cross-project grant subject', async () => {
    const { db, a, b } = await twoProjects();
    await a.files.put(bytes('A doc'), { org: 'acme', owner: 'alice', public: true });
    await b.files.put(bytes('B doc'), { org: 'acme', owner: 'mallory' });

    const orgA = (
      await db.query<{ id: string }>(
        `SELECT id FROM org WHERE external_id = 'acme' AND project_id = $1`,
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]!.id;
    const fileA = (
      await db.query<{ id: string }>(`SELECT id FROM file WHERE org_id = $1`, [orgA])
    ).rows[0]!.id;
    const mallory = (
      await db.query<{ id: string }>(
        `SELECT id FROM actor WHERE external_id = 'mallory' AND project_id <> $1`,
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]!.id;

    // P3, one level up: not "prevented by a WHERE clause" -- unrepresentable.
    await dbRejects(
      db,
      `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,'admin')`,
      [orgA, mallory],
      /foreign key|violates/i,
    );
    await dbRejects(
      db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities)
       VALUES ($1,$2,'actor',$3,'{read}'::grant_capability[])`,
      [fileA, orgA, mallory],
      /foreign key|violates/i,
    );
  });

  it('a file’s owner cannot be an identity from another project', async () => {
    const { db, a, b } = await twoProjects();
    await a.files.put(bytes('A doc'), { org: 'acme', owner: 'alice' });
    await b.files.put(bytes('B doc'), { org: 'acme', owner: 'mallory' });
    const orgA = (
      await db.query<{ id: string }>(
        `SELECT id FROM org WHERE external_id = 'acme' AND project_id = $1`,
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]!.id;
    const mallory = (
      await db.query<{ id: string }>(
        `SELECT id FROM actor WHERE external_id = 'mallory' AND project_id <> $1`,
        [DEFAULT_PROJECT_ID],
      )
    ).rows[0]!.id;
    await dbRejects(
      db,
      `INSERT INTO file (org_id, owner_id, name, content_type, storage_key)
       VALUES ($1,$2,'x','text/plain','k1')`,
      [orgA, mallory],
      /foreign key|violates/i,
    );
  });

  it('auto-provisioning never resurrects a deleted identity', async () => {
    const { a } = await twoProjects();
    await a.files.put(bytes('doc'), { owner: 'alice' });
    const alice = (
      await a.store.db.query<{ id: string }>(`SELECT id FROM actor WHERE external_id = 'alice'`)
    ).rows[0]!.id;
    await a.softDeleteActor(alice);
    await rejects(() => a.files.put(bytes('doc2'), { owner: 'alice' }), 404);
  });
});

// =============================================================================
// getFileRecord, and the sweep for principal-free resource access
// =============================================================================

describe('a resource id is not a question the system answers without a principal', () => {
  /**
   * `getFileRecord(fileId)` was PUBLIC, took no principal, and returned the
   * whole record for any file in the database -- name, size, owner, org,
   * storage key -- with no decision, no denial and no audit event. It sat under
   * an `// Internals` comment, which binds nobody.
   *
   * It is private now. `stat()` is the authorized replacement, and it is
   * authorized by the same engine, with the same 404, and the same audit event
   * as `read()`.
   */
  it('stat() denies a stranger and a foreign tenant exactly as read() does, and audits it', async () => {
    const s = await tenant();
    const mallory = (await s.fl.createActor('mallory')).id;

    const before = await countAudit(s.db, s.org);
    await rejects(() => s.fl.stat({ actorId: mallory }, s.file.id), 404, 'not_found');
    await rejects(() => s.fl.stat({ actorId: null }, s.file.id), 404, 'not_found');
    assert.ok(await countAudit(s.db, s.org) > before, 'the metadata probe is on the record');

    const denials = await s.fl.store.listAudit(s.org, { decision: 'deny' });
    assert.ok(denials.some((d) => d.actorId === mallory && d.action === 'file.read'));
  });

  it('stat() on an id that does not exist is a system-chain event, not a tenant one', async () => {
    const s = await tenant();
    const before = await countAudit(s.db, s.org);
    const beforeSystem = await countAudit(s.db, null);
    await rejects(
      () => s.fl.stat({ actorId: s.alice }, '11111111-2222-4333-8444-555555555555'),
      404,
    );
    assert.equal(await countAudit(s.db, s.org), before);
    assert.equal(await countAudit(s.db, null), beforeSystem + 1);
  });

  it('stat() returns the record to someone who is actually allowed to read it', async () => {
    const s = await tenant();
    const rec = await s.fl.stat({ actorId: s.alice }, s.file.id);
    assert.equal(rec.name, 'plan.pdf');
    assert.equal(rec.visibility, 'private');
  });
});
