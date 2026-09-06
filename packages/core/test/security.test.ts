/**
 * THE SECURITY PROPERTY SUITE
 *
 * Every test in this file is named for a property Filelayer sells. If a test
 * here goes red, the corresponding claim comes off the website.
 *
 * Rules this file holds itself to:
 *   - No test asserts on an internal implementation detail where the observable
 *     security behaviour is what matters.
 *   - Expected outcomes are written out by hand, never derived from the code
 *     under test (a table generated from `roleCapabilities` would prove only
 *     that the function equals itself).
 *   - Where a property cannot be fully proven in this environment, the test
 *     says so in its name and the limitation is stated in the comment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, type Capability, type OrgRole, type Principal } from '../src/authz.ts';
import { auditHash } from '../src/store.ts';
import { newWorld, bytes, text, rejects, dbRejects, countAudit } from './helpers.ts';

// -----------------------------------------------------------------------------
// Scenario builder: two orgs that must never see each other.
// -----------------------------------------------------------------------------

async function twoOrgs() {
  const w = await newWorld();

  const alice = (await w.fl.createActor('alice')).id; // owner of org A
  const anna = (await w.fl.createActor('anna')).id; // member of org A
  const bob = (await w.fl.createActor('bob')).id; // owner of org B
  const mallory = (await w.fl.createActor('mallory')).id; // member of no org

  // An org is created together with its first owner: there is no moment at
  // which an org exists with nobody accountable for it, and therefore no
  // "empty org" bootstrap path for an attacker to walk through.
  const orgA = (await w.fl.createOrg('acme', 'Acme', { ownerActorId: alice })).id;
  const orgB = (await w.fl.createOrg('initech', 'Initech', { ownerActorId: bob })).id;

  await w.fl.addMember({ actorId: alice }, orgA, anna, 'member');

  const fileA = await w.fl.upload({ actorId: alice }, orgA, {
    name: 'acme-plan.pdf',
    contentType: 'application/pdf',
    body: bytes('ACME CONFIDENTIAL'),
  });
  const fileB = await w.fl.upload({ actorId: bob }, orgB, {
    name: 'initech-payroll.csv',
    contentType: 'text/csv',
    body: bytes('INITECH PAYROLL'),
  });

  return { ...w, orgA, orgB, alice, anna, bob, mallory, fileA, fileB };
}

const P = (actorId: string | null, extra: Partial<Principal> = {}): Principal => ({
  actorId,
  ...extra,
});

// =============================================================================
// 1. CROSS-TENANT ISOLATION
// =============================================================================

describe('PROPERTY 1: cross-tenant isolation', () => {
  it('an actor in org A cannot read, delete, share, or list grants on a file in org B', async () => {
    const s = await twoOrgs();

    await rejects(() => s.fl.read(P(s.alice), s.fileB.id), 404, 'not_found');
    await rejects(() => s.fl.delete(P(s.alice), s.fileB.id), 404, 'not_found');
    await rejects(
      () => s.fl.share(P(s.alice), s.fileB.id, { subject: { type: 'link' } }),
      404,
      'not_found',
    );
    await rejects(() => s.fl.listGrants(P(s.alice), s.fileB.id), 404, 'not_found');

    // ...and the reverse direction, so the test cannot pass by accident of
    // org A simply having no files.
    await rejects(() => s.fl.read(P(s.bob), s.fileA.id), 404, 'not_found');
  });

  it('an actor cannot upload into an org they are not a member of', async () => {
    const s = await twoOrgs();
    await rejects(
      () =>
        s.fl.upload({ actorId: s.alice }, s.orgB, {
          name: 'trojan.pdf',
          contentType: 'application/pdf',
          body: bytes('x'),
        }),
      404,
    );
  });

  it('the DATABASE rejects a grant in org A that points at a file in org B (P3, structural)', async () => {
    const s = await twoOrgs();
    // This is the attack a WHERE clause would have to catch. Here it is not
    // caught, it is unrepresentable: the composite FK (file_id, org_id) ->
    // file(id, org_id) has no matching row.
    const msg = await dbRejects(
      s.db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities)
       VALUES ($1, $2, 'actor', $3, ARRAY['read']::grant_capability[])`,
      [s.fileB.id, s.orgA, s.alice],
      /foreign key|file_grant_file_id_org_id_fkey/i,
    );
    assert.match(msg, /violates foreign key constraint/i);

    // Sanity: the same insert with the CORRECT org succeeds, so the rejection
    // above is caused by the tenant mismatch and not by a malformed statement.
    await s.db.query(
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities)
       VALUES ($1, $2, 'actor', $3, ARRAY['read']::grant_capability[])`,
      [s.fileB.id, s.orgB, s.alice],
    );
  });

  it('a link secret issued in org A does not authorize a file in org B', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });

    // The secret works for its own file...
    const ok = await s.fl.redeem(share.secret!);
    assert.equal(text(ok.body), 'ACME CONFIDENTIAL');

    // ...and is inert against org B's file, presented directly.
    await rejects(
      () => s.fl.read(P(null, { linkSecret: share.secret! }), s.fileB.id),
      404,
      'not_found',
    );
  });

  it('a non-member of any org gets nothing', async () => {
    const s = await twoOrgs();
    await rejects(() => s.fl.read(P(s.mallory), s.fileA.id), 404);
    await rejects(() => s.fl.read(P(s.mallory), s.fileB.id), 404);
    await rejects(() => s.fl.read(P(null), s.fileA.id), 404);
  });
});

// =============================================================================
// 2. REVOCATION BEATS A LIVE URL (P4)
// =============================================================================

describe('PROPERTY 2: revocation beats a live URL (P4)', () => {
  it('the SAME share link stops working the instant the grant is revoked', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });

    const before = await s.fl.redeem(share.secret!);
    assert.equal(text(before.body), 'ACME CONFIDENTIAL');

    await s.fl.revoke(P(s.alice), share.grantId);

    // Same string, same file, no deletion, no key rotation, no waiting for a
    // TTL. This is the case Convex cannot express and Cloudinary documents as
    // a limitation.
    await rejects(() => s.fl.redeem(share.secret!), 404, 'not_found');

    // The file itself is untouched: revocation is not deletion.
    const still = await s.fl.read(P(s.alice), s.fileA.id);
    assert.equal(text(still.body), 'ACME CONFIDENTIAL');
  });

  it('revoking an actor grant immediately removes that actor’s access', async () => {
    const s = await twoOrgs();
    // Cross-org sharing by explicit invitation: org B's owner grants Alice
    // (an org A actor) read on an org B file.
    const share = await s.fl.share(P(s.bob), s.fileB.id, {
      subject: { type: 'actor', actorId: s.alice },
    });
    const got = await s.fl.read(P(s.alice), s.fileB.id);
    assert.equal(text(got.body), 'INITECH PAYROLL');

    await s.fl.revoke(P(s.bob), share.grantId);
    await rejects(() => s.fl.read(P(s.alice), s.fileB.id), 404);
  });

  it('a revoked grant is invisible to the live_grant view, not merely filtered by the caller', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    await s.fl.revoke(P(s.alice), share.grantId);

    const live = await s.db.query(`SELECT id FROM live_grant WHERE id = $1`, [share.grantId]);
    assert.equal(live.rows.length, 0);
    const raw = await s.db.query(`SELECT id FROM file_grant WHERE id = $1`, [share.grantId]);
    assert.equal(raw.rows.length, 1, 'the row must still exist, for the audit trail');
  });
});

// =============================================================================
// 3. CONFUSED DEPUTY
// =============================================================================

describe('PROPERTY 3: a valid link secret for file A does not authorize file B', () => {
  it('same org, two files, one secret: the secret is bound to its file', async () => {
    const s = await twoOrgs();
    const other = await s.fl.upload({ actorId: s.alice }, s.orgA, {
      name: 'salaries.xlsx',
      contentType: 'application/vnd.ms-excel',
      body: bytes('ACME SALARIES'),
    });

    const share = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });

    // Works for the file it was minted for.
    assert.equal(text((await s.fl.redeem(share.secret!)).body), 'ACME CONFIDENTIAL');

    // Inert against a sibling file in the same tenant. Same org, same owner,
    // same grant — only the file id differs.
    await rejects(() => s.fl.read(P(null, { linkSecret: share.secret! }), other.id), 404);

    const d = await authorize(s.fl.store, P(null, { linkSecret: share.secret! }), other.id, 'read');
    assert.equal(d.allow, false);
    assert.equal(d.allow === false && d.reason, 'bad_link_secret');
  });

  it('a garbage secret authorizes nothing', async () => {
    const s = await twoOrgs();
    await rejects(() => s.fl.redeem('not-a-real-secret'), 404);
    await rejects(
      () => s.fl.read(P(null, { linkSecret: 'not-a-real-secret' }), s.fileA.id),
      404,
    );
  });
});

// =============================================================================
// 4. ATOMIC DOWNLOAD CAP (P6)
// =============================================================================
//
// HONEST LIMITATION, STATED UP FRONT:
// PGlite is a single Postgres backend in WASM with one connection. Statements
// from concurrent JS promises are interleaved by the driver queue but executed
// one at a time, so this suite exercises the INTERLEAVING form of the race
// (many readers observe the counter before any writer advances it) and not the
// LOCK-CONTENTION form (two backends updating the same row simultaneously,
// where correctness depends on Postgres re-evaluating the UPDATE's WHERE clause
// against the locked, updated row under READ COMMITTED).
//
// What that weakens: this suite proves `consume_download` is not vulnerable to
// check-then-act. It does not, by itself, prove the row-lock path. That path is
// standard Postgres behaviour for a single conditional UPDATE and is the reason
// the reservation is written as one statement, but the claim rests on Postgres
// semantics, not on this test.
//
// To show the harness is capable of FAILING (i.e. that it is not a test that
// passes for everyone), the last test in this block runs the naive
// read-then-write implementation through the identical harness and asserts that
// it over-issues. If the harness could not detect a real TOCTOU bug, the passing
// tests above it would be worthless.

describe('PROPERTY 4: download caps are atomic (P6)', () => {
  it('max_downloads=1 with 20 concurrent redemptions yields exactly 1 success', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 1,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => s.fl.redeem(share.secret!)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, `expected exactly 1 success, got ${ok.length}`);
    assert.equal(failed.length, 19);

    const { rows } = await s.db.query<{ download_count: number }>(
      `SELECT download_count FROM file_grant WHERE id = $1`,
      [share.grantId],
    );
    assert.equal(Number(rows[0]!.download_count), 1, 'the counter must not exceed the cap');
  });

  it('max_downloads=5 with 50 concurrent redemptions yields exactly 5 successes', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 5,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 50 }, () => s.fl.redeem(share.secret!)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 5, `expected exactly 5 successes, got ${ok.length}`);

    const { rows } = await s.db.query<{ download_count: number }>(
      `SELECT download_count FROM file_grant WHERE id = $1`,
      [share.grantId],
    );
    assert.equal(Number(rows[0]!.download_count), 5);

    // Exhausted grants leave the live view, so the 6th attempt is a plain 404
    // rather than an error the caller has to interpret.
    await rejects(() => s.fl.redeem(share.secret!), 404);
  });

  it('CONTROL: the same harness DOES catch a naive read-then-write counter (proves the test can fail)', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 1,
    });

    // Remove the schema's backstop CHECK so we observe the application bug
    // itself rather than the database catching it. (That the CHECK exists at
    // all is a second line of defence and is asserted separately below.)
    await s.db.query(`ALTER TABLE file_grant DROP CONSTRAINT grant_downloads_within_cap`);

    const naiveConsume = async (grantId: string): Promise<boolean> => {
      const { rows } = await s.db.query<{ download_count: number; max_downloads: number | null }>(
        `SELECT download_count, max_downloads FROM file_grant WHERE id = $1`,
        [grantId],
      );
      const r = rows[0]!;
      if (r.max_downloads !== null && Number(r.download_count) >= Number(r.max_downloads)) {
        return false;
      }
      await s.db.query(
        `UPDATE file_grant SET download_count = download_count + 1 WHERE id = $1`,
        [grantId],
      );
      return true;
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => naiveConsume(share.grantId)),
    );
    const granted = results.filter(Boolean).length;
    assert.ok(
      granted > 1,
      `the naive implementation should over-issue under this harness; it granted ${granted}. ` +
        `If this is 1, the harness is not interleaving and the atomicity tests above prove nothing.`,
    );
  });

  it('the schema refuses to store a count above the cap even if application code tries', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 1,
    });
    await dbRejects(
      s.db,
      `UPDATE file_grant SET download_count = 99 WHERE id = $1`,
      [share.grantId],
      /grant_downloads_within_cap/,
    );
  });
});

// =============================================================================
// 5. EXPIRY IS SERVER-SIDE
// =============================================================================

describe('PROPERTY 5: expiry is enforced server-side, not encoded in a token', () => {
  it('an expired grant fails even with a perfectly valid, unmodified secret', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      expiresIn: 3600,
    });
    assert.equal(text((await s.fl.redeem(share.secret!)).body), 'ACME CONFIDENTIAL');

    // Move the expiry into the past. The secret is untouched and still valid
    // cryptographically — which is precisely the point: with a signed URL the
    // expiry lives in the token and the server has no say. Here it does.
    await s.db.query(`UPDATE file_grant SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      share.grantId,
    ]);

    await rejects(() => s.fl.redeem(share.secret!), 404);
    const live = await s.db.query(`SELECT 1 FROM live_grant WHERE id = $1`, [share.grantId]);
    assert.equal(live.rows.length, 0);
  });

  it('an expired FILE is unreachable even through a live, unexpired grant', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    await s.fl.redeem(share.secret!); // works while the file is live

    await s.db.query(`UPDATE file SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      s.fileA.id,
    ]);

    // The grant is still live by its own terms...
    const live = await s.db.query(`SELECT 1 FROM live_grant WHERE id = $1`, [share.grantId]);
    assert.equal(live.rows.length, 1);
    // ...and it still buys nothing, because the file gate runs first.
    await rejects(() => s.fl.redeem(share.secret!), 410, 'gone');
    // Members of the org are equally blocked.
    await rejects(() => s.fl.read(P(s.alice), s.fileA.id), 410, 'gone');
  });

  it('an expired grant does not consume a download slot', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 3,
    });
    await s.db.query(`UPDATE file_grant SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      share.grantId,
    ]);
    await rejects(() => s.fl.redeem(share.secret!), 404);
    const { rows } = await s.db.query<{ download_count: number }>(
      `SELECT download_count FROM file_grant WHERE id = $1`,
      [share.grantId],
    );
    assert.equal(Number(rows[0]!.download_count), 0);
  });
});

// =============================================================================
// 6. DENY BY DEFAULT (P1)
// =============================================================================

describe('PROPERTY 6: deny by default (P1)', () => {
  it('a brand new file is reachable by nobody outside the org: no members, no links, no anonymous', async () => {
    const s = await twoOrgs();
    const outsiders: Array<[string, Principal]> = [
      ['unauthenticated', P(null)],
      ['actor with no org', P(s.mallory)],
      ['owner of a different org', P(s.bob)],
      ['forged link secret', P(null, { linkSecret: 'a'.repeat(43) })],
    ];
    for (const [label, principal] of outsiders) {
      await rejects(() => s.fl.read(principal, s.fileA.id), 404);
      const d = await authorize(s.fl.store, principal, s.fileA.id, 'read');
      assert.equal(d.allow, false, `${label} must be denied`);
    }
    // There is no row anywhere that would have granted this. Absence is denial.
    const { rows } = await s.db.query(`SELECT count(*)::int c FROM file_grant WHERE file_id = $1`, [
      s.fileA.id,
    ]);
    assert.equal(Number((rows[0] as { c: number }).c), 0);
  });

  it('there is no "public" flag: public delivery requires an explicit, revocable grant row', async () => {
    const s = await twoOrgs();
    // Prove the schema has no boolean that could be flipped by accident.
    const { rows } = await s.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND data_type='boolean'`,
    );
    assert.deepEqual(rows, [], 'no boolean columns exist anywhere in the schema');

    await rejects(() => s.fl.read(P(null), s.fileA.id), 404);
    await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'anonymous' } });
    const got = await s.fl.read(P(null), s.fileA.id);
    assert.equal(text(got.body), 'ACME CONFIDENTIAL');
  });

  it('P1 holds at the FILE boundary too: an org member cannot read a private file', async () => {
    // P1 used to hold only at the TENANT boundary. Every role, including
    // `viewer`, could read every file in the org, so a document uploaded by the
    // CFO was readable by the whole workspace the moment it existed, with no
    // grant and no act of sharing. That was the defect.
    //
    // Files are now `private` by default: the owner and the org's admins, and
    // nobody else, until somebody shares.
    const s = await twoOrgs();
    const nosy = (await s.fl.createActor('nosy')).id;
    const colleague = (await s.fl.createActor('colleague')).id;
    await s.fl.addMember(P(s.alice), s.orgA, nosy, 'viewer');
    await s.fl.addMember(P(s.alice), s.orgA, colleague, 'member');

    assert.equal(s.fileA.visibility, 'private', 'the default must be the restrictive one');
    await rejects(() => s.fl.read(P(nosy), s.fileA.id), 404);
    await rejects(() => s.fl.read(P(colleague), s.fileA.id), 404);
    await rejects(() => s.fl.read(P(s.anna), s.fileA.id), 404);

    // The owner and the org's owner/admins still reach it -- otherwise nobody
    // could honour a retention hold or a deletion request.
    assert.equal(text((await s.fl.read(P(s.alice), s.fileA.id)).body), 'ACME CONFIDENTIAL');

    // ...and an explicit grant is all it takes to let one person in, which is
    // the point: access is a row, not an emergent property of a role table.
    await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: colleague },
    });
    assert.equal(text((await s.fl.read(P(colleague), s.fileA.id)).body), 'ACME CONFIDENTIAL');
    await rejects(() => s.fl.read(P(nosy), s.fileA.id), 404);
  });

  it('org-wide visibility is available, but only as an explicit choice at creation', async () => {
    const s = await twoOrgs();
    const nosy = (await s.fl.createActor('nosy2')).id;
    await s.fl.addMember(P(s.alice), s.orgA, nosy, 'viewer');

    const shared = await s.fl.upload({ actorId: s.alice }, s.orgA, {
      name: 'handbook.pdf',
      contentType: 'application/pdf',
      body: bytes('EMPLOYEE HANDBOOK'),
      visibility: 'org',
    });
    assert.equal(shared.visibility, 'org');
    assert.equal(text((await s.fl.read(P(nosy), shared.id)).body), 'EMPLOYEE HANDBOOK');
    // Still nothing for another tenant, and still read-only for a viewer.
    await rejects(() => s.fl.read(P(s.bob), shared.id), 404);
    await rejects(() => s.fl.delete(P(nosy), shared.id), 404);
  });
});

// =============================================================================
// 7. THE ROLE MATRIX IS TOTAL
// =============================================================================

describe('PROPERTY 7: the role matrix is total and enumerated', () => {
  // Written out by hand from the documented model. Deliberately NOT derived
  // from fileCapabilities(): a generated table proves only self-consistency.
  //
  // There are now two of these, because `visibility` is the second axis of the
  // file-level model. Both are enumerated in full; the suite asserts 64
  // cells and that the tables themselves contain exactly 64 entries, so a cell
  // cannot be quietly dropped.
  const EXPECTED_PRIVATE: Record<string, boolean> = {
    // Under the default, an org role buys nothing on someone else's file.
    'viewer|owner|read': true,
    'viewer|owner|write': false,
    'viewer|owner|delete': false,
    'viewer|owner|share': false,
    'viewer|other|read': false,
    'viewer|other|write': false,
    'viewer|other|delete': false,
    'viewer|other|share': false,

    'member|owner|read': true,
    'member|owner|write': true,
    'member|owner|delete': true,
    'member|owner|share': true,
    'member|other|read': false,
    'member|other|write': false,
    'member|other|delete': false,
    'member|other|share': false,

    // Admins and owners keep full access under both settings: retention,
    // deletion and legal hold are their responsibility.
    'admin|owner|read': true,
    'admin|owner|write': true,
    'admin|owner|delete': true,
    'admin|owner|share': true,
    'admin|other|read': true,
    'admin|other|write': true,
    'admin|other|delete': true,
    'admin|other|share': true,

    'owner|owner|read': true,
    'owner|owner|write': true,
    'owner|owner|delete': true,
    'owner|owner|share': true,
    'owner|other|read': true,
    'owner|other|write': true,
    'owner|other|delete': true,
    'owner|other|share': true,
  };

  const EXPECTED_ORG: Record<string, boolean> = {
    // role | owner? | capability -> allowed
    'viewer|owner|read': true,
    'viewer|owner|write': false,
    'viewer|owner|delete': false,
    'viewer|owner|share': false,
    'viewer|other|read': true,
    'viewer|other|write': false,
    'viewer|other|delete': false,
    'viewer|other|share': false,

    'member|owner|read': true,
    'member|owner|write': true,
    'member|owner|delete': true,
    'member|owner|share': true,
    'member|other|read': true,
    'member|other|write': false,
    'member|other|delete': false,
    'member|other|share': false,

    'admin|owner|read': true,
    'admin|owner|write': true,
    'admin|owner|delete': true,
    'admin|owner|share': true,
    'admin|other|read': true,
    'admin|other|write': true,
    'admin|other|delete': true,
    'admin|other|share': true,

    'owner|owner|read': true,
    'owner|owner|write': true,
    'owner|owner|delete': true,
    'owner|owner|share': true,
    'owner|other|read': true,
    'owner|other|write': true,
    'owner|other|delete': true,
    'owner|other|share': true,
  };

  const ROLES: OrgRole[] = ['viewer', 'member', 'admin', 'owner'];
  const CAPS: Capability[] = ['read', 'write', 'delete', 'share'];

  it('every (visibility x role x ownership x capability) cell matches the documented model', async () => {
    const s = await twoOrgs();
    const subject = (await s.fl.createActor('matrix-subject')).id;
    const somebodyElse = (await s.fl.createActor('matrix-other')).id;
    await s.fl.addMember(P(s.alice), s.orgA, somebodyElse, 'member');

    let checked = 0;
    for (const [visibility, table] of [
      ['private', EXPECTED_PRIVATE],
      ['org', EXPECTED_ORG],
    ] as const) {
      await s.db.query(`UPDATE file SET visibility = $1 WHERE id = $2`, [visibility, s.fileA.id]);
      for (const role of ROLES) {
        await s.fl.addMember(P(s.alice), s.orgA, subject, role);
        for (const ownership of ['owner', 'other'] as const) {
          await s.db.query(`UPDATE file SET owner_id = $1 WHERE id = $2`, [
            ownership === 'owner' ? subject : somebodyElse,
            s.fileA.id,
          ]);
          for (const cap of CAPS) {
            const key = `${role}|${ownership}|${cap}`;
            const expected = table[key];
            assert.notEqual(expected, undefined, `matrix is missing a cell: ${visibility} ${key}`);
            const d = await authorize(s.fl.store, P(subject), s.fileA.id, cap);
            assert.equal(d.allow, expected, `role matrix mismatch at ${visibility}|${key}`);
            checked++;
          }
        }
      }
    }
    assert.equal(
      checked,
      64,
      'the matrix must be total: 2 visibilities x 4 roles x 2 ownerships x 4 capabilities',
    );
    assert.equal(Object.keys(EXPECTED_ORG).length, 32);
    assert.equal(Object.keys(EXPECTED_PRIVATE).length, 32);
  });

  it('a grant can add a capability a role lacks, but never removes one the role has', async () => {
    const s = await twoOrgs();
    const viewer = (await s.fl.createActor('viewer-with-grant')).id;
    await s.fl.addMember(P(s.alice), s.orgA, viewer, 'viewer');

    // Viewer cannot share...
    let d = await authorize(s.fl.store, P(viewer), s.fileA.id, 'share');
    assert.equal(d.allow, false);
    assert.equal(d.allow === false && d.reason, 'insufficient_role');

    // ...until explicitly granted it.
    await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: viewer },
      capabilities: ['share'],
    });
    d = await authorize(s.fl.store, P(viewer), s.fileA.id, 'share');
    assert.equal(d.allow, true);
    assert.equal(d.allow === true && d.via, 'grant:actor');
  });
});

// =============================================================================
// 8. RETENTION
// =============================================================================

describe('PROPERTY 8: retention blocks deletion, including for the org owner', () => {
  it('the org owner cannot delete a file under a retention hold', async () => {
    const s = await twoOrgs();
    const held = await s.fl.upload({ actorId: s.alice }, s.orgA, {
      name: 'invoice-2026.pdf',
      contentType: 'application/pdf',
      body: bytes('LEGALLY REQUIRED'),
      retainFor: 3600,
    });

    // Alice is the org owner AND the file owner. Retention that the most
    // privileged principal can override is not a compliance control.
    const err = await rejects(() => s.fl.delete(P(s.alice), held.id), 409, 'retention_hold');
    assert.equal(err.reason, 'retention_hold');

    // The bytes are still there.
    assert.equal(text((await s.fl.read(P(s.alice), held.id)).body), 'LEGALLY REQUIRED');

    // And the attempt is on the record.
    const denials = await s.fl.auditLog(P(s.alice), s.orgA, { decision: 'deny' });
    assert.ok(denials.some((e) => e.reason === 'retention_hold' && e.fileId === held.id));
  });

  it('deletion succeeds once the retention window has passed', async () => {
    const s = await twoOrgs();
    const held = await s.fl.upload({ actorId: s.alice }, s.orgA, {
      name: 'invoice.pdf',
      contentType: 'application/pdf',
      body: bytes('x'),
      retainFor: 3600,
    });
    await rejects(() => s.fl.delete(P(s.alice), held.id), 409);
    await s.db.query(`UPDATE file SET retain_until = now() - interval '1 second' WHERE id = $1`, [
      held.id,
    ]);
    await s.fl.delete(P(s.alice), held.id);
    await rejects(() => s.fl.read(P(s.alice), held.id), 404);
    assert.equal(s.storage.keys().includes(held.storageKey), false, 'bytes must be gone too');
  });

  it('the schema refuses a retention floor that outlives the file expiry', async () => {
    const s = await twoOrgs();
    await dbRejects(
      s.db,
      `UPDATE file SET expires_at = now() + interval '1 hour',
                       retain_until = now() + interval '2 hours' WHERE id = $1`,
      [s.fileA.id],
      /file_retention_before_expiry/,
    );
  });
});

// =============================================================================
// 9. ANONYMOUS GRANTS ARE READ-ONLY
// =============================================================================

describe('PROPERTY 9: anonymous grants can never carry write, delete or share', () => {
  for (const caps of [
    ['write'],
    ['delete'],
    ['share'],
    ['read', 'write'],
    ['read', 'delete'],
    ['read', 'share'],
    ['read', 'write', 'delete', 'share'],
  ]) {
    it(`the DATABASE rejects an anonymous grant with capabilities {${caps.join(',')}}`, async () => {
      const s = await twoOrgs();
      await dbRejects(
        s.db,
        `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities)
         VALUES ($1, $2, 'anonymous', $3::grant_capability[])`,
        [s.fileA.id, s.orgA, `{${caps.join(',')}}`],
        /grant_anonymous_read_only/,
      );
    });
  }

  it('the API surface cannot smuggle the escalation past the constraint either', async () => {
    const s = await twoOrgs();
    await assert.rejects(
      () =>
        s.fl.share(P(s.alice), s.fileA.id, {
          subject: { type: 'anonymous' },
          capabilities: ['read', 'write'],
        }),
      /grant_anonymous_read_only/,
    );
  });

  it('an anonymous grant with exactly {read} is accepted, so the constraint is not vacuous', async () => {
    const s = await twoOrgs();
    const g = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'anonymous' } });
    assert.ok(g.grantId);
    assert.equal(g.secret, undefined, 'an anonymous grant has no secret to leak');
  });

  it('a subject-type/credential mismatch is unrepresentable', async () => {
    const s = await twoOrgs();
    // A 'link' grant with no secret would be a link anyone could redeem.
    await dbRejects(
      s.db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities)
       VALUES ($1, $2, 'link', ARRAY['read']::grant_capability[])`,
      [s.fileA.id, s.orgA],
      /grant_subject_coherent/,
    );
    // An 'anonymous' grant carrying a secret_hash would be two things at once.
    await dbRejects(
      s.db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities, secret_hash)
       VALUES ($1, $2, 'anonymous', ARRAY['read']::grant_capability[], 'deadbeef')`,
      [s.fileA.id, s.orgA],
      /grant_subject_coherent/,
    );
    // A grant with no capabilities at all is meaningless and rejected.
    await dbRejects(
      s.db,
      `INSERT INTO file_grant (file_id, org_id, subject_type, subject_id, capabilities)
       VALUES ($1, $2, 'actor', $3, ARRAY[]::grant_capability[])`,
      [s.fileA.id, s.orgA, s.alice],
      /grant_capabilities_nonempty/,
    );
  });
});

// =============================================================================
// 10. SECRETS ARE NOT RECOVERABLE FROM THE DATABASE
// =============================================================================

describe('PROPERTY 10: a database dump does not yield working share links', () => {
  it('no plaintext link secret or share password appears in ANY column of ANY table', async () => {
    const s = await twoOrgs();
    const password = 'correct-horse-battery-staple';
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      password,
      maxDownloads: 10,
    });
    const secret = share.secret!;
    // Exercise the link so that any incidental logging would have happened.
    await s.fl.redeem(secret, { password });

    const { rows: tables } = await s.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    assert.ok(tables.length >= 6, 'sanity: we should be scanning the whole schema');

    let scanned = 0;
    for (const t of tables) {
      const { rows } = await s.db.query<{ dump: string }>(
        `SELECT to_jsonb(x)::text AS dump FROM "${t.table_name}" x`,
      );
      for (const r of rows) {
        scanned++;
        assert.equal(
          r.dump.includes(secret),
          false,
          `plaintext link secret found in table ${t.table_name}`,
        );
        assert.equal(
          r.dump.includes(password),
          false,
          `plaintext share password found in table ${t.table_name}`,
        );
      }
    }
    assert.ok(scanned > 0, 'sanity: the scan must actually have read rows');

    // What IS stored: a SHA-256 of the secret, and a salted scrypt of the
    // password. Neither is usable without the original.
    const { rows: g } = await s.db.query<{ secret_hash: string; password_hash: string }>(
      `SELECT secret_hash, password_hash FROM file_grant WHERE id = $1`,
      [share.grantId],
    );
    assert.match(g[0]!.secret_hash, /^[0-9a-f]{64}$/);
    assert.match(g[0]!.password_hash, /^scrypt\$/);

    // The stored hash is not itself a credential: presenting it as the secret
    // must fail (otherwise a dump would still be enough).
    await rejects(() => s.fl.redeem(g[0]!.secret_hash, { password }), 404);
  });

  it('listGrants never returns a secret or password hash', async () => {
    const s = await twoOrgs();
    await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      password: 'hunter2',
    });
    const grants = await s.fl.listGrants(P(s.alice), s.fileA.id);
    assert.equal(grants.length, 1);
    const serialized = JSON.stringify(grants);
    assert.equal(serialized.includes('hunter2'), false);
    assert.equal(/secret/i.test(serialized), false);
    assert.equal(grants[0]!.hasPassword, true, 'but the UI can still say "password protected"');
  });

  it('the wrong password on a valid link is 401, and the right one works', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      password: 's3cret',
    });
    await rejects(() => s.fl.redeem(share.secret!), 401, 'password_required');
    await rejects(() => s.fl.redeem(share.secret!, { password: 'wrong' }), 401);
    const ok = await s.fl.redeem(share.secret!, { password: 's3cret' });
    assert.equal(text(ok.body), 'ACME CONFIDENTIAL');
  });

  it('a failed password attempt does not burn a download', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      password: 's3cret',
      maxDownloads: 1,
    });
    await rejects(() => s.fl.redeem(share.secret!, { password: 'wrong' }), 401);
    const ok = await s.fl.redeem(share.secret!, { password: 's3cret' });
    assert.equal(ok.remainingDownloads, 0);
  });
});

// =============================================================================
// 11. DENIALS ARE AUDITED
// =============================================================================

describe('PROPERTY 11: denials are audited (P5)', () => {
  it('one denied read produces exactly one deny event with the correct reason', async () => {
    const s = await twoOrgs();
    const before = await countAudit(s.db, s.orgB);

    await rejects(() => s.fl.read(P(s.alice), s.fileB.id), 404);

    const after = await s.fl.auditLog(P(s.bob), s.orgB, {});
    assert.equal(after.length - before, 1, 'exactly one event, not zero and not two');
    const e = after[after.length - 1]!;
    assert.equal(e.decision, 'deny');
    assert.equal(e.reason, 'no_membership');
    assert.equal(e.action, 'file.read');
    assert.equal(e.actorId, s.alice);
    assert.equal(e.fileId, s.fileB.id);
  });

  it('each distinct denial reason is recorded distinctly', async () => {
    const s = await twoOrgs();
    const viewer = (await s.fl.createActor('aud-viewer')).id;
    await s.fl.addMember(P(s.alice), s.orgA, viewer, 'viewer');

    await rejects(() => s.fl.delete(P(viewer), s.fileA.id), 404); // insufficient_role
    await rejects(() => s.fl.read(P(null, { linkSecret: 'nope' }), s.fileA.id), 404); // bad_link_secret

    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      password: 'p',
    });
    await rejects(() => s.fl.redeem(share.secret!, { password: 'q' }), 401); // bad_password

    const reasons = (await s.fl.auditLog(P(s.alice), s.orgA, { decision: 'deny' })).map(
      (e) => e.reason,
    );
    for (const expected of ['insufficient_role', 'bad_link_secret', 'bad_password']) {
      assert.ok(reasons.includes(expected), `missing deny reason ${expected}; got ${reasons}`);
    }
  });

  it('an exhausted download cap is audited as grant_exhausted', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 1,
    });
    await s.fl.redeem(share.secret!);
    await rejects(() => s.fl.redeem(share.secret!), 404);
    const denials = await s.fl.auditLog(P(s.alice), s.orgA, { decision: 'deny' });
    const e = denials.find((x) => x.reason === 'grant_exhausted');
    // An exhausted grant leaves `live_grant`, so it cannot be used to authorize
    // anything -- but it can still be RESOLVED, which is what lets the denial
    // be attributed to the right tenant and named for what it is. Before the
    // fix, "my link stopped working" produced nothing at all.
    assert.ok(e, `expected a grant_exhausted denial; got ${denials.map((x) => x.reason)}`);
    assert.equal(e.grantId, share.grantId, 'and it names the grant that ran out');
    assert.equal(e.fileId, s.fileA.id);
  });

  it('the audit log is admin-only: a member cannot read it', async () => {
    const s = await twoOrgs();
    await rejects(() => s.fl.auditLog(P(s.anna), s.orgA, {}), 404);
    await rejects(() => s.fl.auditLog(P(s.bob), s.orgA, {}), 404);
    await rejects(() => s.fl.auditLog(P(null), s.orgA, {}), 404);
    const ok = await s.fl.auditLog(P(s.alice), s.orgA, {});
    assert.ok(ok.length > 0);
  });

  it('an enumeration sweep against unknown file ids is recorded on the system chain', async () => {
    // P5 says every access decision is audited, including denials. It used not
    // to be: `authorize()` returned file_not_found with a null org and skipped
    // the audit entirely, so a file-id enumeration sweep -- the single most
    // characteristic reconnaissance pattern against an object store -- left
    // zero trace anywhere in the system.
    //
    // The events have no tenant to charge them to, and inventing one would
    // itself be an existence oracle, so they go to the system chain.
    const s = await twoOrgs();
    const before = await countAudit(s.db, null);
    const orgBefore = await countAudit(s.db, s.orgA);

    for (let i = 0; i < 25; i++) {
      await rejects(() => s.fl.read(P(s.mallory), crypto.randomUUID()), 404);
    }

    assert.equal(await countAudit(s.db, null), before + 25, '25 probes, 25 events');
    assert.equal(
      await countAudit(s.db, s.orgA),
      orgBefore,
      'and not one of them was attributed to a real tenant',
    );

    const { rows } = await s.db.query<{ reason: string; action: string }>(
      `SELECT reason, action FROM audit_event WHERE org_id IS NULL ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0]!.reason, 'file_not_found');
    assert.equal(rows[0]!.action, 'file.read');

    // The system chain is chained and verifiable like any other...
    assert.equal((await s.fl.store.verifyAuditChain(null)).valid, true);
    // ...and no tenant can read it: `auditLog` requires an org you administer.
    await rejects(() => s.fl.auditLog(P(s.alice), null as unknown as string, {}), 404);
  });

  it('a brute-force sweep against LINK SECRETS is recorded too', async () => {
    // Worse than file-id enumeration, because it is a sweep against the
    // credential itself. `redeem` used to throw before reaching the engine.
    const s = await twoOrgs();
    const before = await countAudit(s.db, null);
    for (let i = 0; i < 10; i++) {
      await rejects(() => s.fl.redeem(`forged-${i}`), 404);
    }
    assert.equal(await countAudit(s.db, null), before + 10);

    const { rows } = await s.db.query<{ reason: string; context: unknown }>(
      `SELECT reason, context FROM audit_event WHERE org_id IS NULL ORDER BY id DESC LIMIT 1`,
    );
    assert.equal(rows[0]!.reason, 'bad_link_secret');
    const ctx = (
      typeof rows[0]!.context === 'string' ? JSON.parse(rows[0]!.context as string) : rows[0]!.context
    ) as Record<string, string>;
    // Enough to correlate a sweep, not enough to be a credential: a 48-bit
    // prefix of the SHA-256 of what was presented.
    assert.match(ctx['secretHashPrefix']!, /^[0-9a-f]{12}$/);
  });
});

// =============================================================================
// 12. AUDIT IS APPEND-ONLY AND TAMPER-EVIDENT
// =============================================================================

describe('PROPERTY 12: the audit log is append-only and tamper-evident', () => {
  it('UPDATE and DELETE on audit_event are no-ops', async () => {
    const s = await twoOrgs();
    const { rows: before } = await s.db.query<{ c: number }>(
      `SELECT count(*)::int c FROM audit_event WHERE org_id = $1`,
      [s.orgA],
    );
    assert.ok(Number(before[0]!.c) > 0);

    const upd = await s.db.query(`UPDATE audit_event SET decision = 'allow', reason = NULL`);
    assert.equal(upd.affectedRows ?? 0, 0);

    const del = await s.db.query(`DELETE FROM audit_event`);
    assert.equal(del.affectedRows ?? 0, 0);

    const { rows: after } = await s.db.query<{ c: number }>(
      `SELECT count(*)::int c FROM audit_event WHERE org_id = $1`,
      [s.orgA],
    );
    assert.equal(Number(after[0]!.c), Number(before[0]!.c));
  });

  it('a clean chain verifies', async () => {
    const s = await twoOrgs();
    await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    await rejects(() => s.fl.read(P(s.mallory), s.fileA.id), 404);
    const r = await s.fl.verifyAuditChain(P(s.alice), s.orgA);
    assert.equal(r.valid, true);
    assert.ok(r.checked >= 3);
  });

  it('verifyAuditChain detects a forged row inserted out of chain', async () => {
    const s = await twoOrgs();
    assert.equal((await s.fl.verifyAuditChain(P(s.alice), s.orgA)).valid, true);

    // The forgery: an attacker with INSERT rights fabricates an "allow" that
    // never happened. INSERT is not blocked by the append-only rules, so the
    // chain is the only thing standing between them and a clean history.
    await s.db.query(
      `INSERT INTO audit_event (org_id, action, decision, actor_id, file_id, prev_hash, hash)
       VALUES ($1, 'file.read', 'allow', $2, $3, 'fabricated-prev', 'fabricated-hash')`,
      [s.orgA, s.mallory, s.fileA.id],
    );

    const r = await s.fl.verifyAuditChain(P(s.alice), s.orgA);
    assert.equal(r.valid, false);
    assert.equal(r.problem, 'prev_hash_mismatch');
    assert.ok(typeof r.brokenAt === 'number');
  });

  it('verifyAuditChain detects a DELETED row even when the rule is bypassed', async () => {
    const s = await twoOrgs();
    await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    await rejects(() => s.fl.read(P(s.mallory), s.fileA.id), 404);
    assert.equal((await s.fl.verifyAuditChain(P(s.alice), s.orgA)).valid, true);

    // Simulate an attacker who has reached the database as superuser and can
    // drop the protective rule. The chain must still catch them.
    await s.db.query(`ALTER TABLE audit_event DISABLE RULE audit_no_delete`);
    const { rows } = await s.db.query<{ id: number }>(
      `SELECT id FROM audit_event WHERE org_id = $1 ORDER BY id ASC OFFSET 1 LIMIT 1`,
      [s.orgA],
    );
    await s.db.query(`DELETE FROM audit_event WHERE id = $1`, [rows[0]!.id]);

    const r = await s.fl.verifyAuditChain(P(s.alice), s.orgA);
    assert.equal(r.valid, false, 'a deleted event must break the chain');
    assert.equal(r.problem, 'prev_hash_mismatch');
  });

  it('verifyAuditChain detects an in-place edit of a chained field', async () => {
    const s = await twoOrgs();
    await s.db.query(`ALTER TABLE audit_event DISABLE RULE audit_no_update`);
    const { rows } = await s.db.query<{ id: number }>(
      `SELECT id FROM audit_event WHERE org_id = $1 ORDER BY id ASC LIMIT 1`,
      [s.orgA],
    );
    await s.db.query(`UPDATE audit_event SET decision = 'deny' WHERE id = $1`, [rows[0]!.id]);
    const r = await s.fl.verifyAuditChain(P(s.alice), s.orgA);
    assert.equal(r.valid, false);
    assert.equal(r.problem, 'hash_mismatch');
  });

  it('the chain covers the FORENSIC fields, not just the structural ones', async () => {
    // The chain used to cover only (prev_hash, org_id, occurred_at, action,
    // decision, actor_id, file_id). An attacker who could write to the table
    // could therefore rewrite WHY a denial happened, WHICH grant was used and
    // FROM WHERE -- the exact fields an incident responder relies on -- and
    // `verifyAuditChain` still returned valid. That was the defect.
    //
    // Every one of those fields is now inside the commitment. Each is edited
    // independently below, so this cannot pass because of one lucky field.
    const edits = [
      `reason = 'routine_maintenance'`,
      `grant_id = '00000000-0000-0000-0000-0000000000ff'`,
      `ip = '10.0.0.1'`,
      `user_agent = 'not-the-real-agent'`,
      `context = '{"note":"nothing to see"}'::jsonb`,
    ];

    for (const edit of edits) {
      const s = await twoOrgs();
      await rejects(() => s.fl.read(P(s.mallory), s.fileA.id), 404);
      assert.equal((await s.fl.verifyAuditChain(P(s.alice), s.orgA)).valid, true);

      await s.db.query(`ALTER TABLE audit_event DISABLE RULE audit_no_update`);
      const { rows } = await s.db.query<{ id: number }>(
        `SELECT id FROM audit_event WHERE org_id = $1 AND decision = 'deny' ORDER BY id LIMIT 1`,
        [s.orgA],
      );
      await s.db.query(`UPDATE audit_event SET ${edit} WHERE id = $1`, [rows[0]!.id]);

      const r = await s.fl.verifyAuditChain(P(s.alice), s.orgA);
      assert.equal(r.valid, false, `an edit to ${edit} must break the chain`);
      assert.equal(r.problem, 'hash_mismatch');
      assert.equal(r.brokenAt, rows[0]!.id);
    }
  });

  it('the hash is a real commitment: recomputing with ANY covered field changed differs', async () => {
    const base = {
      prevHash: null,
      orgId: '00000000-0000-0000-0000-000000000001',
      occurredAt: new Date('2026-09-05T00:00:00.000Z'),
      action: 'file.read',
      decision: 'allow',
      reason: null,
      actorId: '00000000-0000-0000-0000-000000000002',
      fileId: '00000000-0000-0000-0000-000000000003',
      grantId: null,
      ip: null,
      userAgent: null,
      context: {},
    };
    const h = auditHash(base);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, auditHash({ ...base, decision: 'deny' }));
    assert.notEqual(h, auditHash({ ...base, action: 'file.delete' }));
    assert.notEqual(h, auditHash({ ...base, prevHash: 'x' }));
    assert.notEqual(h, auditHash({ ...base, occurredAt: new Date('2026-09-05T00:00:01.000Z') }));
    assert.notEqual(h, auditHash({ ...base, reason: 'no_membership' }));
    assert.notEqual(h, auditHash({ ...base, grantId: base.orgId }));
    assert.notEqual(h, auditHash({ ...base, ip: '10.0.0.1' }));
    assert.notEqual(h, auditHash({ ...base, userAgent: 'curl' }));
    assert.notEqual(h, auditHash({ ...base, context: { via: 'role' } }));
    assert.equal(h, auditHash({ ...base }));

    // ...but it is stable across jsonb key reordering, or the chain would break
    // on its own round trip through the database rather than on an attack.
    assert.equal(
      auditHash({ ...base, context: { a: 1, b: { y: 2, x: 3 } } }),
      auditHash({ ...base, context: { b: { x: 3, y: 2 }, a: 1 } }),
    );
  });

  it('every org has its own chain: activity in org B cannot be used to explain org A', async () => {
    const s = await twoOrgs();
    await s.fl.share(P(s.bob), s.fileB.id, { subject: { type: 'link' } });
    const a = await s.fl.verifyAuditChain(P(s.alice), s.orgA);
    const b = await s.fl.verifyAuditChain(P(s.bob), s.orgB);
    assert.equal(a.valid, true);
    assert.equal(b.valid, true);
    const { rows } = await s.db.query<{ org_id: string; prev_hash: string | null }>(
      `SELECT org_id, prev_hash FROM audit_event ORDER BY id`,
    );
    // The first event of each org starts a fresh chain.
    const firsts = new Map<string, string | null>();
    for (const r of rows) if (!firsts.has(r.org_id)) firsts.set(r.org_id, r.prev_hash);
    for (const [, prev] of firsts) assert.equal(prev, null);
  });
});

// =============================================================================
// 13. ERRORS DO NOT LEAK EXISTENCE
// =============================================================================

describe('PROPERTY 13: error responses are indistinguishable across "absent" and "not yours"', () => {
  it('a nonexistent file and another tenant’s file both return 404 not_found', async () => {
    const s = await twoOrgs();
    const ghost = crypto.randomUUID();

    const e1 = await rejects(() => s.fl.read(P(s.alice), ghost), 404);
    const e2 = await rejects(() => s.fl.read(P(s.alice), s.fileB.id), 404);
    assert.equal(e1.code, e2.code);
    assert.equal(e1.status, e2.status);
    assert.equal(e1.message, e2.message);

    // ...but the audit log knows the difference internally.
    const bLog = await s.fl.auditLog(P(s.bob), s.orgB, { decision: 'deny' });
    assert.ok(bLog.some((e) => e.fileId === s.fileB.id && e.reason === 'no_membership'));
  });

  it('an EXPIRED file in another tenant does not leak its existence via 410', async () => {
    // The naive implementation leaks here: authz.ts evaluates the file-level
    // expiry gate before establishing standing, and toPublicError maps
    // file_expired to 410 Gone. 410 vs 404 is a yes/no oracle for "does this
    // file id exist".
    const s = await twoOrgs();
    await s.db.query(`UPDATE file SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      s.fileB.id,
    ]);
    const ghost = crypto.randomUUID();

    const e1 = await rejects(() => s.fl.read(P(s.alice), ghost), 404);
    const e2 = await rejects(() => s.fl.read(P(s.alice), s.fileB.id), 404);
    const e3 = await rejects(() => s.fl.read(P(null), s.fileB.id), 404);
    assert.equal(e1.code, e2.code);
    assert.equal(e2.code, e3.code);
  });

  it('a RETENTION-HELD file in another tenant does not leak its existence via 409', async () => {
    const s = await twoOrgs();
    await s.db.query(`UPDATE file SET retain_until = now() + interval '1 hour' WHERE id = $1`, [
      s.fileB.id,
    ]);
    const ghost = crypto.randomUUID();
    const e1 = await rejects(() => s.fl.delete(P(s.alice), ghost), 404);
    const e2 = await rejects(() => s.fl.delete(P(s.alice), s.fileB.id), 404);
    assert.equal(e1.code, e2.code);
  });

  it('the ENGINE itself does not leak: standing is established before any lifecycle gate', async () => {
    // This is the test that matters, because it is about the engine rather
    // than the API wrapper. `authorize()` used to evaluate the file-level
    // lifecycle gates before establishing that the caller had any standing, and
    // `toPublicError` maps file_expired to 410 Gone -- so an unauthenticated
    // caller who guessed a file id got 410 for a real file and 404 for a fake
    // one. `Filelayer.raiseIfDenied` compensated for that, which meant any
    // second entry point built on authorize() reintroduced the oracle.
    //
    // The compensation is gone; the evaluation order is fixed instead.
    const { toPublicError } = await import('../src/authz.ts');
    const s = await twoOrgs();
    await s.db.query(`UPDATE file SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      s.fileB.id,
    ]);
    await s.db.query(`UPDATE file SET retain_until = now() + interval '1 hour' WHERE id = $1`, [
      s.fileA.id,
    ]);

    const status = async (p: Principal, id: string, cap: Capability = 'read') => {
      const d = await authorize(s.fl.store, p, id, cap);
      assert.equal(d.allow, false);
      return toPublicError((d as Extract<typeof d, { allow: false }>).reason).status;
    };

    // Expired file in another tenant vs. a file id that never existed.
    assert.equal(await status(P(s.alice), s.fileB.id), 404);
    assert.equal(await status(P(s.alice), crypto.randomUUID()), 404);
    assert.equal(await status(P(null), s.fileB.id), 404);

    // Retention hold, probed by someone with no standing: still 404, not 409.
    assert.equal(await status(P(s.bob), s.fileA.id, 'delete'), 404);
    assert.equal(await status(P(s.mallory), s.fileA.id, 'delete'), 404);

    // ...and an org member with no capability on a private file learns nothing
    // more than a total stranger does.
    assert.equal(await status(P(s.anna), s.fileA.id, 'delete'), 404);

    // The statuses that are NOT 404 remain available to those entitled to them,
    // so this is not passing by collapsing everything into one answer.
    const owner = await authorize(s.fl.store, P(s.alice), s.fileA.id, 'delete');
    assert.equal(owner.allow, false);
    assert.equal(
      toPublicError((owner as Extract<typeof owner, { allow: false }>).reason).status,
      409,
    );
    const ownerB = await authorize(s.fl.store, P(s.bob), s.fileB.id, 'read');
    assert.equal(
      toPublicError((ownerB as Extract<typeof ownerB, { allow: false }>).reason).status,
      410,
    );
  });

  it('revoke() is not a grant-id oracle', async () => {
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.bob), s.fileB.id, { subject: { type: 'link' } });
    const e1 = await rejects(() => s.fl.revoke(P(s.alice), share.grantId), 404);
    const e2 = await rejects(() => s.fl.revoke(P(s.alice), crypto.randomUUID()), 404);
    assert.equal(e1.code, e2.code);
    // ...and the grant still works for its legitimate holder afterwards.
    assert.equal(text((await s.fl.redeem(share.secret!)).body), 'INITECH PAYROLL');
  });
});

// =============================================================================
// 15. DELEGATION -- the findings that came out of building this
// =============================================================================

describe('PROPERTY 15: delegation cannot amplify or outlive the permission it came from', () => {
  it('a principal cannot mint a grant carrying a capability they do not hold', async () => {
    const s = await twoOrgs();
    const viewer = (await s.fl.createActor('delegate-viewer')).id;
    await s.fl.addMember(P(s.alice), s.orgA, viewer, 'viewer');

    // The viewer is given exactly one capability: share.
    await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: viewer },
      capabilities: ['share'],
    });
    await rejects(() => s.fl.delete(P(viewer), s.fileA.id), 404);

    // Without attenuation, this is a one-step escalation from "may pass this
    // on" to "may destroy it": the viewer mints themselves a delete grant.
    await rejects(
      () =>
        s.fl.share(P(viewer), s.fileA.id, {
          subject: { type: 'actor', actorId: viewer },
          capabilities: ['read', 'write', 'delete', 'share'],
        }),
      403,
      'forbidden',
    );

    // ...and the file is still there.
    await rejects(() => s.fl.delete(P(viewer), s.fileA.id), 404);
    assert.equal(text((await s.fl.read(P(s.alice), s.fileA.id)).body), 'ACME CONFIDENTIAL');
  });

  it('the DATABASE refuses an amplifying child even when the engine is bypassed', async () => {
    // The rule used to live only in `filelayer.share()`, which meant a psql
    // session, a migration or a second endpoint bypassed it entirely. It is now
    // enforced on the row.
    const s = await twoOrgs();
    const viewer = (await s.fl.createActor('sql-viewer')).id;
    const parent = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: viewer },
      capabilities: ['read', 'share'],
    });

    await dbRejects(
      s.db,
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id, capabilities)
       VALUES ($1, $2, $3, 'actor', $4, ARRAY['read','delete']::grant_capability[])`,
      [s.fileA.id, s.orgA, parent.grantId, viewer],
      /grant_capability_amplification/,
    );

    // Negative control: the same INSERT with an attenuated capability set is
    // accepted, so the rejection is caused by amplification and not by a
    // malformed statement.
    await s.db.query(
      `INSERT INTO file_grant (file_id, org_id, parent_grant_id, subject_type, subject_id, capabilities)
       VALUES ($1, $2, $3, 'actor', $4, ARRAY['read']::grant_capability[])`,
      [s.fileA.id, s.orgA, parent.grantId, viewer],
    );
  });

  it('attenuation is not over-broad: a granter CAN pass on what they do hold', async () => {
    const s = await twoOrgs();
    const contractor = (await s.fl.createActor('contractor')).id;
    const g = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: contractor },
      capabilities: ['read', 'share'],
    });
    assert.ok(g.grantId);
    const onward = await s.fl.share(P(contractor), s.fileA.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
    });
    assert.equal(text((await s.fl.redeem(onward.secret!)).body), 'ACME CONFIDENTIAL');
  });

  it('a delegated grant dies with the grant that created it (P4, transitive)', async () => {
    // P4: "a signed URL may never outlive the permission that created it."
    //
    // It used to. A grant carrying `share` let its holder mint a SECOND grant
    // with no expiry, no download cap and no link back to the first; revoking
    // the first left the second working, because `live_grant` had no notion of
    // a parent and `file_grant` had no parent_grant_id.
    //
    // Concretely: a contractor is given a 60-second, single-use, shareable
    // authority. They pass it on. You revoke theirs. Everything they issued
    // dies in the same instant.
    const s = await twoOrgs();
    const contractor = (await s.fl.createActor('f7-contractor')).id;

    const parent = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: contractor },
      capabilities: ['read', 'share'],
      expiresIn: 60,
      maxDownloads: 3,
    });

    const child = await s.fl.share(P(contractor), s.fileA.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
      // Asks for forever, and for unlimited downloads.
    });

    // ...and is given the parent's remaining lifetime and budget instead.
    assert.equal(child.parentGrantId, parent.grantId, 'the lineage is recorded');
    assert.ok(child.expiresAt, 'the child inherits the parent expiry');
    assert.equal(child.expiresAt!.getTime(), parent.expiresAt!.getTime());
    assert.equal(child.maxDownloads, 3, 'the child inherits the parent budget');

    // It works while the parent is alive...
    assert.equal(text((await s.fl.redeem(child.secret!)).body), 'ACME CONFIDENTIAL');

    // ...and stops the instant the parent is revoked. No cascading write, no
    // background job: liveness is evaluated over the chain.
    await s.fl.revoke(P(s.alice), parent.grantId);
    await rejects(() => s.fl.read(P(contractor), s.fileA.id), 404);
    await rejects(() => s.fl.redeem(child.secret!), 404);

    // The view agrees, so this is not an artifact of the API layer.
    const live = await s.db.query(`SELECT id FROM live_grant WHERE id = ANY($1::uuid[])`, [
      `{${parent.grantId},${child.grantId}}`,
    ]);
    assert.equal(live.rows.length, 0);
    // ...and both rows still exist, for the audit trail.
    const raw = await s.db.query(`SELECT id FROM file_grant WHERE id = ANY($1::uuid[])`, [
      `{${parent.grantId},${child.grantId}}`,
    ]);
    assert.equal(raw.rows.length, 2);

    // An operator listing what has been shared sees the child as dead, and can
    // see what killed it.
    const grants = await s.fl.listGrants(P(s.alice), s.fileA.id);
    const orphan = grants.find((g) => g.id === child.grantId)!;
    assert.equal(orphan.live, false);
    assert.equal(orphan.revokedAt, null, 'it was never revoked itself');
    assert.equal(orphan.parentGrantId, parent.grantId);
  });

  it('a child cannot outlive its parent even when it asks for longer', async () => {
    const s = await twoOrgs();
    const contractor = (await s.fl.createActor('f7-clamp')).id;
    const parent = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'actor', actorId: contractor },
      capabilities: ['read', 'share'],
      expiresIn: 60,
      maxDownloads: 2,
    });
    const child = await s.fl.share(P(contractor), s.fileA.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
      expiresIn: 86400 * 365,
      maxDownloads: 1000,
    });
    assert.equal(child.expiresAt!.getTime(), parent.expiresAt!.getTime());
    assert.equal(child.maxDownloads, 2);

    // The budget is shared, not duplicated: spending it through the child
    // spends it for the parent too, so two children cannot sell it twice.
    await s.fl.redeem(child.secret!);
    await s.fl.redeem(child.secret!);
    await rejects(() => s.fl.redeem(child.secret!), 404);
    const { rows } = await s.db.query<{ download_count: number }>(
      `SELECT download_count FROM file_grant WHERE id = $1`,
      [parent.grantId],
    );
    assert.equal(Number(rows[0]!.download_count), 2, 'the parent was charged for both');
    await rejects(() => s.fl.read(P(contractor), s.fileA.id), 404);
  });

  it('a link grant can never carry delete: the DATABASE says so', async () => {
    // A share link is a bearer credential that travels through mail clients,
    // chat logs and browser history. Anything it carries beyond `read` turns a
    // disclosure into a destruction. Only `anonymous` used to be constrained.
    const s = await twoOrgs();
    for (const caps of [['delete'], ['read', 'delete'], ['read', 'write'], ['read', 'share']]) {
      await dbRejects(
        s.db,
        `INSERT INTO file_grant (file_id, org_id, subject_type, capabilities, secret_hash)
         VALUES ($1, $2, 'link', $3::grant_capability[], 'deadbeef')`,
        [s.fileA.id, s.orgA, `{${caps.join(',')}}`],
        /grant_link_read_only/,
      );
    }
    // The API surface cannot smuggle it past either.
    await assert.rejects(
      () =>
        s.fl.share(P(s.alice), s.fileA.id, {
          subject: { type: 'link' },
          capabilities: ['read', 'delete'],
        }),
      /grant_link_read_only/,
    );
    // Positive control, so the constraint is not vacuous.
    const ok = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      capabilities: ['read'],
    });
    assert.equal(text((await s.fl.redeem(ok.secret!)).body), 'ACME CONFIDENTIAL');
  });

  it('membership management is authorized and audited like everything else', async () => {
    // `addMember` used to take no principal at all: any code path that reached
    // it could make anyone an owner of any org, and nothing was written to the
    // audit log. It was the single largest security-sensitive decision left to
    // the developer.
    const s = await twoOrgs();

    // An outsider cannot let themselves in...
    await rejects(() => s.fl.addMember(P(s.mallory), s.orgB, s.mallory, 'owner'), 404);
    await rejects(() => s.fl.read(P(s.mallory), s.fileB.id), 404);
    // ...nor can a member of the org, nor an unauthenticated caller.
    await rejects(() => s.fl.addMember(P(s.anna), s.orgA, s.mallory, 'owner'), 404);
    await rejects(() => s.fl.addMember(P(null), s.orgA, s.mallory, 'owner'), 404);
    // ...nor can the owner of a DIFFERENT org.
    await rejects(() => s.fl.addMember(P(s.bob), s.orgA, s.mallory, 'owner'), 404);

    // The org's own owner can, and it is on the record.
    await s.fl.addMember(P(s.alice), s.orgA, s.mallory, 'member');
    const events = await s.fl.auditLog(P(s.alice), s.orgA, {});
    const added = events.filter((e) => e.action === 'member.add' && e.decision === 'allow');
    assert.equal(added.length, 2, 'anna at setup, mallory just now');
    const last = added[added.length - 1]!;
    assert.equal(last.decision, 'allow');
    assert.equal(last.actorId, s.alice);
    assert.equal(last.context['targetActorId'], s.mallory);
    assert.equal(last.context['toRole'], 'member');

    // Refusals are recorded too -- that is the half that evidences an attempt.
    const denied = events.filter((e) => e.action === 'member.add' && e.decision === 'deny');
    assert.ok(denied.length >= 2, `expected refused membership changes on the record`);
    assert.ok(denied.every((e) => e.reason === 'insufficient_role' || e.reason === 'no_membership'));

    // A role change is a distinct action, not an indistinguishable upsert.
    await s.fl.addMember(P(s.alice), s.orgA, s.mallory, 'admin');
    const changes = (await s.fl.auditLog(P(s.alice), s.orgA, { action: 'member.role_change' }));
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.context['fromRole'], 'member');
    assert.equal(changes[0]!.context['toRole'], 'admin');
  });

  it('an admin cannot mint an owner, nor touch one, nor orphan the org', async () => {
    const s = await twoOrgs();
    const admin = (await s.fl.createActor('an-admin')).id;
    await s.fl.addMember(P(s.alice), s.orgA, admin, 'admin');

    // Privilege escalation by proxy: an admin who can create owners is an
    // owner with an extra step.
    await rejects(() => s.fl.addMember(P(admin), s.orgA, s.mallory, 'owner'), 403, 'forbidden');
    await rejects(() => s.fl.addMember(P(admin), s.orgA, admin, 'owner'), 403);
    // ...and they cannot demote or remove the person above them.
    await rejects(() => s.fl.addMember(P(admin), s.orgA, s.alice, 'viewer'), 403);
    await rejects(() => s.fl.removeMember(P(admin), s.orgA, s.alice), 403);
    // An admin CAN manage roles at or below their own.
    await s.fl.addMember(P(admin), s.orgA, s.mallory, 'member');
    await s.fl.removeMember(P(admin), s.orgA, s.mallory);

    // The last owner cannot walk out of the org and leave it unadministrable.
    await rejects(() => s.fl.removeMember(P(s.alice), s.orgA, s.alice), 403, 'forbidden');
    await rejects(() => s.fl.addMember(P(s.alice), s.orgA, s.alice, 'member'), 403);

    const denials = await s.fl.auditLog(P(s.alice), s.orgA, { decision: 'deny' });
    for (const reason of ['role_escalation', 'superior_target', 'last_owner']) {
      assert.ok(
        denials.some((e) => e.reason === reason),
        `missing membership deny reason ${reason}`,
      );
    }
  });

  it('a redemption refused by the download cap IS audited', async () => {
    // Once download_count reached max_downloads the grant left `live_grant`, so
    // `findLiveGrantBySecret` returned null and `redeem` threw before
    // `authorize` was ever called: "my link stopped working" was invisible in
    // the compliance log. Same root cause as the unaudited enumeration sweep --
    // liveness filtering happened before attribution.
    const s = await twoOrgs();
    const share = await s.fl.share(P(s.alice), s.fileA.id, {
      subject: { type: 'link' },
      maxDownloads: 1,
    });
    await s.fl.redeem(share.secret!);
    const before = await countAudit(s.db, s.orgA);
    for (let i = 0; i < 5; i++) await rejects(() => s.fl.redeem(share.secret!), 404);
    assert.equal(await countAudit(s.db, s.orgA), before + 5, 'five refusals, five events');

    const denials = await s.fl.auditLog(P(s.alice), s.orgA, { decision: 'deny' });
    const exhausted = denials.filter((e) => e.reason === 'grant_exhausted');
    assert.equal(exhausted.length, 5);
    assert.ok(exhausted.every((e) => e.grantId === share.grantId));
  });

  it('a revoked or expired link is audited with the reason, not as a forgery', async () => {
    const s = await twoOrgs();
    const revoked = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    const expired = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    await s.fl.revoke(P(s.alice), revoked.grantId);
    await s.db.query(`UPDATE file_grant SET expires_at = now() - interval '1s' WHERE id = $1`, [
      expired.grantId,
    ]);

    await rejects(() => s.fl.redeem(revoked.secret!), 404);
    await rejects(() => s.fl.redeem(expired.secret!), 404);

    const reasons = (await s.fl.auditLog(P(s.alice), s.orgA, { decision: 'deny' })).map(
      (e) => e.reason,
    );
    assert.ok(reasons.includes('grant_revoked'), `got ${reasons}`);
    assert.ok(reasons.includes('grant_expired'), `got ${reasons}`);
    // The caller still cannot tell any of these apart from a forged secret.
    const e1 = await rejects(() => s.fl.redeem(revoked.secret!), 404);
    const e2 = await rejects(() => s.fl.redeem('completely-made-up'), 404);
    assert.equal(e1.code, e2.code);
  });
});

// =============================================================================
// 14. LIFECYCLE / STATE
// =============================================================================

describe('PROPERTY 14: deleted files are unreachable by every path', () => {
  it('after delete, owner, admin, link holder and anonymous grant all get 404', async () => {
    const s = await twoOrgs();
    const link = await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'link' } });
    await s.fl.share(P(s.alice), s.fileA.id, { subject: { type: 'anonymous' } });

    await s.fl.delete(P(s.alice), s.fileA.id);

    await rejects(() => s.fl.read(P(s.alice), s.fileA.id), 404);
    await rejects(() => s.fl.read(P(s.anna), s.fileA.id), 404);
    await rejects(() => s.fl.redeem(link.secret!), 404);
    await rejects(() => s.fl.read(P(null), s.fileA.id), 404);
    assert.equal(s.storage.keys().includes(s.fileA.storageKey), false);
  });

  it('a pending (not yet uploaded) file is not readable', async () => {
    const s = await twoOrgs();
    await s.db.query(`UPDATE file SET state = 'pending' WHERE id = $1`, [s.fileA.id]);
    await rejects(() => s.fl.read(P(s.alice), s.fileA.id), 404);
  });
});
