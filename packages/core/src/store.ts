/**
 * STORE LAYER
 *
 * Implements `AuthzDeps` (see authz.ts) against PostgreSQL.
 *
 * The authorization grant lookups below MUST read through the `live_grant`
 * view, never `file_grant`. The liveness predicate -- not revoked, not expired,
 * under cap, AND the same for every ancestor of the grant -- is expressed
 * exactly once, in the schema, and every caller inherits it. If a future query
 * here reaches for `file_grant` directly it has silently opted out of
 * revocation, expiry and delegation control, which is P4, which is the product.
 * The view is the enforcement point, not a convenience.
 *
 * The one deliberate exception is `findGrantBySecret`, which reads
 * `file_grant`. It exists so that a denial can be ATTRIBUTED and EXPLAINED in
 * the audit log, and the engine never uses its result to allow anything. It is
 * named to make that obvious and it is the only such query in the file.
 *
 * ------------------------------------------------------------------------
 * TRUST BOUNDARY. EVERY METHOD ON `PostgresStore` IS UNAUTHORIZED.
 * ------------------------------------------------------------------------
 * This class is the engine's DEPENDENCY surface (`AuthzDeps`), not an API.
 * `getFile`, `getActorGrants`, `listAuthorizedFiles`, `listAudit`,
 * `verifyAuditChain` and `consumeDownload` all take resource ids and no
 * principal, because the engine has already established standing before it
 * calls them -- that is the division of labour. They are the same shape as the
 * defect fixed in `Filelayer.getFileRecord`, and they are safe only because
 * they are not reachable from the developer's surface.
 *
 * The rule that keeps that true, stated so it can be enforced in review:
 * `@filelayer/sdk` -- the only thing a customer touches in a hosted deployment
 * -- MUST NOT re-export `PostgresStore`, `Filelayer.store`, or `store.db`. A
 * developer holding `store.db` holds arbitrary SQL over every tenant in the
 * hosted database, which is precisely the connection a hosted deployment exists
 * to take away from them.
 */

import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  AuditInput,
  AuthzDeps,
  Capability,
  FileRef,
  FileVisibility,
  GrantRow,
  GrantSubjectType,
  ListedFile,
  ListPredicate,
  ListQuery,
  OrgRole,
} from './authz.ts';
import type { Queryable } from './db.ts';

import { membershipCells, type MembershipCell } from './authz.ts';

const scrypt = promisify(_scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

const SCRYPT_KEYLEN = 32;

// -----------------------------------------------------------------------------
// Row shapes as they come back from Postgres
// -----------------------------------------------------------------------------

interface DbGrant {
  id: string;
  file_id: string;
  org_id: string;
  parent_grant_id: string | null;
  subject_type: GrantSubjectType;
  subject_id: string | null;
  subject_org_id: string | null;
  subject_min_role: OrgRole | null;
  capabilities: Capability[] | string;
  secret_hash: string | null;
  password_hash: string | null;
  expires_at: Date | null;
  max_downloads: number | null;
  download_count: number;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: Date;
  /** Not a column: the role the joining actor holds, on the group-grant path. */
  matched_role?: OrgRole;
}

export interface FileRow extends FileRef {
  name: string;
  contentType: string;
  sizeBytes: number | null;
  storageProvider: string;
  storageKey: string;
  createdAt: Date;
}

export interface AuditRow {
  id: number;
  orgId: string | null;
  occurredAt: Date;
  action: string;
  decision: 'allow' | 'deny';
  reason: string | null;
  actorId: string | null;
  fileId: string | null;
  grantId: string | null;
  ip: string | null;
  userAgent: string | null;
  context: Record<string, unknown>;
  prevHash: string | null;
  hash: string;
}

/**
 * PGlite returns text[] as a JS array already; node-postgres does too. This
 * guard exists because a raw text round-trip ('{read,write}') would otherwise
 * silently produce a single-element array containing the literal braces, and a
 * capability check against that string would deny everything -- fail closed,
 * but confusingly.
 */
export function toCapabilities(v: Capability[] | string): Capability[] {
  if (Array.isArray(v)) return v;
  return String(v)
    .replace(/^\{|\}$/g, '')
    .split(',')
    .filter(Boolean) as Capability[];
}

function toGrantRow(r: DbGrant): GrantRow {
  return {
    id: r.id,
    fileId: r.file_id,
    orgId: r.org_id,
    parentGrantId: r.parent_grant_id ?? null,
    subjectType: r.subject_type,
    subjectOrgId: r.subject_org_id ?? null,
    subjectMinRole: r.subject_min_role ?? null,
    ...(r.matched_role !== undefined && r.matched_role !== null
      ? { matchedRole: r.matched_role }
      : {}),
    capabilities: toCapabilities(r.capabilities),
    passwordHash: r.password_hash,
    expiresAt: r.expires_at ? new Date(r.expires_at) : null,
    maxDownloads: r.max_downloads,
    downloadCount: r.download_count,
    revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
  };
}

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

/**
 * The project every row belongs to when nobody named one. Mirrors the row
 * inserted by schema.sql; see the PROJECT section there for why it exists.
 */
export const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-0000000f11e1';

export interface StoreOptions {
  /**
   * The customer application this store speaks for (P8).
   *
   * In a hosted deployment the API layer resolves a project from the request's
   * API key and constructs a store bound to it. A bound store CANNOT see a
   * file, an org or a listing belonging to any other project: the scope is
   * applied in the SQL, not checked afterwards, so there is no branch to forget.
   *
   * This is defence in depth, not the primary control -- the primary control is
   * the composite foreign keys in schema.sql, which make a cross-project
   * reference unrepresentable. It is here because it also bounds audit-chain
   * flooding: a caller who guesses an org UUID belonging to a DIFFERENT project
   * cannot reach that org's audit chain at all, because `orgExists` returns
   * false and the denial goes to the system chain.
   *
   * `null` means unscoped, which is correct for a single-project deployment and
   * for the control plane. It is not the default.
   */
  projectId?: string | null;
}

export class PostgresStore implements AuthzDeps {
  readonly db: Queryable;
  /** Null means unscoped. See StoreOptions. */
  readonly projectId: string | null;

  constructor(db: Queryable, opts: StoreOptions = {}) {
    this.db = db;
    this.projectId = opts.projectId === undefined ? DEFAULT_PROJECT_ID : opts.projectId;
  }

  /**
   * The same store, bound to a different connection -- in practice, to an open
   * transaction.
   *
   * This is what puts the audit write in the same transaction as the mutation
   * it records. The engine calls `deps.audit()`; if `deps` is a store bound to
   * the transaction, the event and the mutation commit or roll back together,
   * and `audit_append()`'s advisory lock is held across BOTH rather than across
   * one autocommit statement. `projectId` rides along, so a transactional store
   * cannot accidentally become an unscoped one.
   */
  withDb(db: Queryable): PostgresStore {
    return new PostgresStore(db, { projectId: this.projectId });
  }

  now(): Date {
    return new Date();
  }

  // --- AuthzDeps ------------------------------------------------------------

  async getFile(fileId: string): Promise<FileRef | null> {
    if (!isUuid(fileId)) return null; // a malformed id is "not found", not a 500
    const { rows } = await this.db.query<{
      id: string;
      org_id: string;
      owner_id: string | null;
      state: 'pending' | 'ready' | 'deleted';
      visibility: FileVisibility;
      expires_at: Date | null;
      retain_until: Date | null;
      deleted_at: Date | null;
    }>(
      `SELECT id, org_id, owner_id, state, visibility, expires_at, retain_until, deleted_at
         FROM file WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
      [fileId, this.projectId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      orgId: r.org_id,
      ownerId: r.owner_id,
      // A soft-deleted row is 'deleted' regardless of the state column, so a
      // half-applied delete cannot leave a readable file behind.
      state: r.deleted_at ? 'deleted' : r.state,
      visibility: r.visibility,
      expiresAt: r.expires_at ? new Date(r.expires_at) : null,
      retainUntil: r.retain_until ? new Date(r.retain_until) : null,
    };
  }

  /**
   * "Is there an org here that this store may speak about?"
   *
   * A soft-deleted org is not one, and neither is an org whose PROJECT is
   * soft-deleted -- deleting a customer must not leave their tenants
   * addressable. Nor is an org in a different project.
   *
   * The return value decides which audit chain a denial is written to, so this
   * predicate is also the thing that keeps a probe at another project's org id
   * off that org's chain.
   */
  async orgExists(orgId: string): Promise<boolean> {
    if (!isUuid(orgId)) return false;
    const { rows } = await this.db.query(
      `SELECT 1 FROM org o
         JOIN project p ON p.id = o.project_id
        WHERE o.id = $1
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND ($2::uuid IS NULL OR o.project_id = $2::uuid)`,
      [orgId, this.projectId],
    );
    return rows.length > 0;
  }

  /**
   * Membership confers nothing when the org, the project, or the ACTOR
   * has been soft-deleted (P7).
   *
   * The actor clause is the one that was missing. `deleted_at` existed on
   * `actor` and nothing read it, so a "deleted" user kept every role-derived
   * capability they had -- which made the column decorative and made the answer
   * to "what does deleting a user do?" depend on which method you asked.
   */
  async getMembership(orgId: string, actorId: string): Promise<OrgRole | null> {
    if (!isUuid(orgId) || !isUuid(actorId)) return null;
    const { rows } = await this.db.query<{ role: OrgRole }>(
      `SELECT m.role FROM membership m
         JOIN org o     ON o.id = m.org_id
         JOIN project p ON p.id = o.project_id
         JOIN actor a   ON a.id = m.actor_id
        WHERE m.org_id = $1 AND m.actor_id = $2
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND a.deleted_at IS NULL
          AND ($3::uuid IS NULL OR o.project_id = $3::uuid)`,
      [orgId, actorId, this.projectId],
    );
    return rows[0]?.role ?? null;
  }

  async countOwners(orgId: string): Promise<number> {
    if (!isUuid(orgId)) return 0;
    const { rows } = await this.db.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM membership WHERE org_id = $1 AND role = 'owner'`,
      [orgId],
    );
    return Number(rows[0]?.c ?? 0);
  }

  /**
   * live_grant only.
   *
   * THE ORDER BY IS LOAD-BEARING, and its absence was a latent defect found
   * while adding the group subject types. `resolveStanding` attributes an allow
   * to the FIRST grant in this result that supplies the requested capability,
   * and on the delegation path that grant becomes the new grant's
   * `parent_grant_id` -- so it decides the ceiling the attenuation trigger will
   * measure the child against. With no ORDER BY, Postgres returned heap order,
   * which is not a defined order at all: it changes with page layout, with
   * VACUUM, and (this is how it surfaced) with the width of the row. A
   * principal holding several grants on one file could therefore have a
   * `share()` call succeed or fail depending on physical storage.
   *
   * Oldest-first makes the choice deterministic and makes it the sensible one:
   * the authority you were given first is the one you delegate from, and it is
   * the same rule `getAnonymousGrant` already applies. See the note on the
   * residual union-vs-parent gap in `authorizeShare`.
   */
  async getActorGrants(fileId: string, actorId: string): Promise<GrantRow[]> {
    if (!isUuid(fileId) || !isUuid(actorId)) return [];
    const { rows } = await this.db.query<DbGrant>(
      `SELECT * FROM live_grant
        WHERE file_id = $1 AND subject_type = 'actor' AND subject_id = $2
        ORDER BY created_at ASC, id ASC`,
      [fileId, actorId],
    );
    return rows.map(toGrantRow);
  }

  /**
   * live_grant only. THE GROUP-GRANT PATH (RFC-001).
   *
   * ONE JOIN. Not a fan-out table, not a cached member list, not a
   * materialized view -- a join against `membership`, evaluated on this
   * request. That is the whole implementation of "membership changes must
   * change access on the next request, without recomputation": there is
   * nothing to recompute, because nothing was ever computed. Adding a member
   * makes the join match; removing one makes it stop matching; no `file_grant`
   * row is read, written, or even looked at during either operation. The test
   * that asserts this counts grant rows before and after a join and a leave.
   *
   * The membership half carries the same three liveness clauses `getMembership`
   * applies -- org, project and actor not soft-deleted -- because a group grant
   * must not confer through a membership that confers nothing on its own. The
   * SUBJECT ORG's own deletion is handled one level down, inside
   * `grant_scope_is_live` (I2), so it binds `consume_download` and the
   * attenuation trigger as well and not merely this query.
   *
   * `subject_min_role` is compared against the held role by tuple membership
   * in the DERIVED cell list -- see `membershipCellSql` -- so the threshold is
   * not restated in SQL here or in `listAuthorizedFiles`.
   */
  async getGroupGrants(fileId: string, actorId: string): Promise<GrantRow[]> {
    if (!isUuid(fileId) || !isUuid(actorId)) return [];
    const { rows } = await this.db.query<DbGrant>(
      `SELECT g.*, m.role AS matched_role
         FROM live_grant g
         JOIN membership m ON m.org_id = g.subject_org_id AND m.actor_id = $2::uuid
         JOIN org so       ON so.id = m.org_id
         JOIN project sp   ON sp.id = so.project_id
         JOIN actor sa     ON sa.id = m.actor_id
        WHERE g.file_id = $1::uuid
          AND g.subject_type IN ('org', 'role')
          AND so.deleted_at IS NULL
          AND sp.deleted_at IS NULL
          AND sa.deleted_at IS NULL
          AND ($3::uuid IS NULL OR so.project_id = $3::uuid)
          AND ${membershipCellSql(membershipCells())}
        ORDER BY g.created_at ASC, g.id ASC`,
      [fileId, actorId, this.projectId],
    );
    return rows.map(toGrantRow);
  }

  /** live_grant only. Lookup is by hash; the plaintext never reaches the DB. */
  async findLiveGrantBySecret(secretHash: string): Promise<GrantRow | null> {
    const { rows } = await this.db.query<DbGrant>(
      `SELECT * FROM live_grant
        WHERE subject_type = 'link' AND secret_hash = $1
        LIMIT 1`,
      [secretHash],
    );
    return rows[0] ? toGrantRow(rows[0]) : null;
  }

  /**
   * ATTRIBUTION ONLY -- never an authorization input.
   *
   * Reads `file_grant`, so it sees revoked, expired, exhausted and
   * ancestor-dead grants. The engine calls it exclusively on paths that have
   * already denied, in order to name the grant in the audit event and record
   * WHY the link stopped working. Any future use of this result to grant
   * access is a P4 violation and should fail review.
   */
  async findGrantBySecret(secretHash: string): Promise<GrantRow | null> {
    const { rows } = await this.db.query<DbGrant>(
      `SELECT * FROM file_grant
        WHERE subject_type = 'link' AND secret_hash = $1
        LIMIT 1`,
      [secretHash],
    );
    return rows[0] ? toGrantRow(rows[0]) : null;
  }

  async isDescendantOf(ancestorId: string, grantId: string): Promise<boolean> {
    if (!isUuid(ancestorId) || !isUuid(grantId)) return false;
    const { rows } = await this.db.query(
      `SELECT 1 FROM grant_ancestry($1) WHERE id = $2`,
      [grantId, ancestorId],
    );
    return rows.length > 0;
  }

  /** live_grant only. */
  async getAnonymousGrant(fileId: string): Promise<GrantRow | null> {
    if (!isUuid(fileId)) return null;
    const { rows } = await this.db.query<DbGrant>(
      `SELECT * FROM live_grant
        WHERE file_id = $1 AND subject_type = 'anonymous'
        ORDER BY created_at ASC
        LIMIT 1`,
      [fileId],
    );
    return rows[0] ? toGrantRow(rows[0]) : null;
  }

  /**
   * THE SET FORM OF THE DECISION.
   *
   * One query, one round trip, for the same predicate `authorize()` evaluates
   * per file. Read it against `resolveStanding()` in authz.ts -- the three OR
   * branches are the three sources of authority, in the same order, with the
   * same conditions:
   *
   *   1. org role      -> membership x the DERIVED role-cell list
   *   2. actor grant   -> live_grant, subject_type='actor', subject_id=caller
   *   3. anonymous     -> the EARLIEST live anonymous grant, read only
   *
   * ...and the lifecycle gate is the DERIVED lifecycle-cell list.
   *
   * The role and lifecycle tuples are not written here. They are generated by
   * `listPredicate()` from `fileCapabilities()` and `lifecycleDenial()`, so
   * changing the role model changes this query automatically. The tuples are
   * still validated against the enum vocabulary before interpolation, because a
   * generated string that reaches SQL unchecked is a generated string that can
   * be made to reach SQL unchecked.
   *
   * `now` is passed in rather than read from the database so that the point
   * check and the set query cannot disagree about what time it is. Grant
   * liveness still uses the database clock, via `live_grant`, in BOTH paths.
   *
   * Ordering is (created_at, id) ascending -- total, because id is unique --
   * and pagination is keyset, not OFFSET, so a concurrent insert cannot make a
   * row skip a page.
   */
  async listAuthorizedFiles(q: ListQuery): Promise<ListedFile[]> {
    if (!isUuid(q.orgId)) return [];
    if (q.actorId !== null && !isUuid(q.actorId)) return [];

    const lifecycle = lifecycleSql(q.predicate);
    const roles = roleCellSql(q.predicate);
    if (lifecycle === null) return []; // no state is usable for this capability
    // The GROUP branch (RFC-001). Structurally identical to `getGroupGrants`:
    // the same join, the same three membership-liveness clauses, the same
    // derived threshold cells. It is written twice only in the sense that the
    // whole union is -- which is exactly what the differential test in
    // test/listing.test.ts exists to police, and why that test's corpus now
    // contains org and role grants.
    //
    // No capability branch, mirroring `resolveStanding`: a group grant may
    // carry any capability, so it is consulted for all of them.
    const group = `OR EXISTS (
                   SELECT 1
                     FROM live_grant g
                     JOIN membership m ON m.org_id = g.subject_org_id AND m.actor_id = $2::uuid
                     JOIN org so       ON so.id = m.org_id
                     JOIN project sp   ON sp.id = so.project_id
                     JOIN actor sa     ON sa.id = m.actor_id
                    WHERE g.file_id = f.id
                      AND g.subject_type IN ('org', 'role')
                      AND so.deleted_at IS NULL
                      AND sp.deleted_at IS NULL
                      AND sa.deleted_at IS NULL
                      AND ($6::uuid IS NULL OR so.project_id = $6::uuid)
                      AND ${membershipCellSql(q.predicate.membershipCells ?? [])}
                      AND $4::grant_capability = ANY (g.capabilities)
                 )`;
    const anon = q.predicate.anonymousEligible
      ? `OR EXISTS (
             SELECT 1 FROM (
               SELECT g2.capabilities
                 FROM live_grant g2
                WHERE g2.file_id = f.id AND g2.subject_type = 'anonymous'
                ORDER BY g2.created_at ASC
                LIMIT 1
             ) ag
            WHERE $4::grant_capability = ANY (ag.capabilities)
          )`
      : '';

    const params: unknown[] = [
      q.orgId,
      q.actorId,
      q.now.toISOString(),
      q.predicate.capability,
      Math.max(1, Math.min(q.limit, LIST_MAX_LIMIT)),
      this.projectId,
    ];
    let cursorClause = '';
    if (q.cursor) {
      params.push(q.cursor.createdAt.toISOString(), q.cursor.id);
      cursorClause = `AND (f.created_at, f.id) > ($7::timestamptz, $8::uuid)`;
    }

    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT f.id, f.org_id, f.owner_id, f.name, f.content_type, f.size_bytes,
              f.storage_provider, f.storage_key, f.state, f.visibility,
              f.expires_at, f.retain_until,
              f.created_at, f.deleted_at
         FROM file f
        WHERE f.org_id = $1::uuid
          AND ($6::uuid IS NULL OR f.project_id = $6::uuid)
          AND ${lifecycle}
          AND (
                ${roles === null
                  ? 'false'
                  : `EXISTS (
                   SELECT 1
                     FROM membership m
                     JOIN org o     ON o.id = m.org_id
                     JOIN project p ON p.id = o.project_id
                     JOIN actor a   ON a.id = m.actor_id
                    WHERE m.org_id = f.org_id
                      AND m.actor_id = $2::uuid
                      AND o.deleted_at IS NULL
                      AND p.deleted_at IS NULL
                      AND a.deleted_at IS NULL
                      AND (m.role::text,
                           coalesce(f.owner_id = $2::uuid, false),
                           f.visibility::text) IN ${roles}
                 )`}
             OR EXISTS (
                   SELECT 1 FROM live_grant g
                    WHERE g.file_id = f.id
                      AND g.subject_type = 'actor'
                      AND g.subject_id = $2::uuid
                      AND $4::grant_capability = ANY (g.capabilities)
                 )
             ${group}
             ${anon}
              )
          ${cursorClause}
        ORDER BY f.created_at ASC, f.id ASC
        LIMIT $5`,
      params,
    );
    return rows.map(toListedFile);
  }

  /**
   * Link secrets are 256 bits of CSPRNG output, so they are not guessable and
   * not enumerable; an unsalted SHA-256 is the correct primitive here (it must
   * be deterministic to be indexable, and there is no low-entropy input to
   * protect). Passwords are the opposite case and use scrypt below.
   */
  async hashSecret(secret: string): Promise<string> {
    return createHash('sha256').update(secret, 'utf8').digest('hex');
  }

  async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, SCRYPT_KEYLEN);
    return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    const parts = hash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1]!, 'base64');
    const expected = Buffer.from(parts[2]!, 'base64');
    const actual = await scrypt(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  // --- Audit (P5) -----------------------------------------------------------

  /**
   * Hash chain. Each event commits to its predecessor in the same chain, where
   * a chain is an org -- or the SYSTEM chain, `org_id IS NULL`, for decisions
   * with no tenant to attribute them to.
   *
   * The digest now covers EVERY forensically relevant column, not the
   * seven it used to cover. `reason`, `grant_id`, `ip`, `user_agent` and
   * `context` are exactly the fields an incident responder relies on and
   * exactly the fields an attacker would rewrite; leaving them outside the
   * commitment made the chain decorative for the questions that matter.
   *
   * JSON encoding rather than string concatenation because concatenation is
   * ambiguous: ('ab','c') and ('a','bc') would hash identically and a forger
   * could shift field boundaries. `context` is canonicalised with sorted keys
   * at every level, because jsonb does not preserve key order and the digest
   * must survive the round trip through the database.
   *
   * CONCURRENCY -- fixed. This used to be a SELECT of the last hash
   * followed by an INSERT, from here, in two statements -- atomic only under a
   * single writer, and a chain FORK under two. It is now one call to
   * `audit_append()`, which takes `pg_advisory_xact_lock` on the chain, reads
   * the predecessor and inserts, all inside one statement and therefore one
   * transaction. See the long comment on that function in schema.sql, including
   * what PGlite can and cannot prove about it.
   *
   * The canonical encoding still lives here and only here: this method computes
   * everything in the digest input EXCEPT the predecessor hash (which it cannot
   * know without racing) and hands it over as `hash_tail`. The database
   * prepends the predecessor it read under the lock. `verifyAuditChain` then
   * recomputes the entire digest in TypeScript on read, so the SQL side and the
   * TypeScript side are checked against each other by every chain verification
   * in the suite.
   *
   * CHAIN FLOODING -- AND WHY IT IS NOT FIXED HERE.
   *
   * An unauthenticated caller who guesses an org UUID can cause denials to be
   * appended to that tenant's chain. Under the per-chain lock above that is
   * worse than storage growth: the tenant's own requests each take the same
   * lock on the way through their audit write, so a flood is a latency attack
   * on that tenant's whole request path, not merely noise in their log. (That
   * interaction is new with the per-chain lock and is worth stating on its own.)
   *
   * It still does not belong in this function:
   *
   *  - P5 says every decision is recorded, INCLUDING denials, because denials
   *    are the security-relevant events. Any in-engine mitigation is a rule for
   *    DROPPING audit events, and a log with a "we stop recording under load"
   *    clause is worthless in exactly the incident it exists for.
   *  - The engine cannot distinguish a flood from reconnaissance. They are the
   *    same request; only the rate differs, and rate is not observable from
   *    inside a single decision.
   *  - Admission control is the layer that can see it, and it belongs above the
   *    engine.
   *
   * WHAT IS FIXED HERE: the blast radius. `orgExists` is project-scoped, so a
   * caller can only reach a tenant chain inside a project they are already
   * authenticated for; probes at every other org id land on the system chain.
   * The exposure goes from "any internet caller can degrade any tenant" to "an
   * authenticated customer can degrade their own tenant" -- a quota question.
   * That reduction is asserted in test/semantics.test.ts.
   *
   * WHAT REMAINS AN OPERATIONAL REQUIREMENT ON THE API LAYER. Stated as a
   * requirement, not a hope, and repeated in SEMANTICS.md:
   *
   *   R1. Every request carries a project credential; no project, no engine.
   *   R2. Rate limit per (project, source address) BEFORE the engine runs.
   *   R3. Cap per-project audit append rate and shed with 429 -- never by
   *       dropping a decision that was actually made.
   *   R4. Alert on SYSTEM-chain append rate. That chain is where unattributable
   *       probes go, so its rate is the enumeration signal.
   */
  async audit(event: AuditInput): Promise<void> {
    const occurredAt = this.now();
    const ip = normalizeIp(event.ip);
    const context: Record<string, unknown> = { ...(event.context ?? {}) };
    // An address we cannot store as `inet` is kept verbatim in `context` rather
    // than thrown away or, worse, passed to the cast: a malformed
    // X-Forwarded-For must not be able to abort the audit write, because an
    // audit write that fails takes the whole request with it.
    if (event.ip !== undefined && event.ip !== null && ip === null) {
      context['rawIp'] = String(event.ip).slice(0, 64);
    }
    const fields = {
      // The predecessor is supplied by the database, under the chain lock.
      prevHash: null,
      orgId: event.orgId,
      occurredAt,
      action: event.action,
      decision: event.decision,
      reason: event.reason ?? null,
      actorId: event.actorId,
      fileId: event.fileId,
      grantId: event.grantId ?? null,
      ip,
      userAgent: event.userAgent ?? null,
      context,
    };

    await this.db.query(
      `SELECT id FROM audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
      [
        event.orgId,
        occurredAt.toISOString(),
        event.action,
        event.decision,
        fields.reason,
        event.actorId,
        event.fileId,
        fields.grantId,
        fields.ip,
        fields.userAgent,
        JSON.stringify(fields.context),
        auditHashTail(fields),
      ],
    );
  }

  async listAudit(
    orgId: string | null,
    filter: {
      decision?: 'allow' | 'deny';
      fileId?: string;
      actorId?: string;
      action?: string;
      limit?: number;
    } = {},
  ): Promise<AuditRow[]> {
    const params: unknown[] = [orgId];
    const clauses = ['org_id IS NOT DISTINCT FROM $1'];
    if (filter.decision) {
      params.push(filter.decision);
      clauses.push(`decision = $${params.length}`);
    }
    if (filter.fileId) {
      params.push(filter.fileId);
      clauses.push(`file_id = $${params.length}`);
    }
    if (filter.actorId) {
      params.push(filter.actorId);
      clauses.push(`actor_id = $${params.length}`);
    }
    if (filter.action) {
      params.push(filter.action);
      clauses.push(`action = $${params.length}`);
    }
    params.push(Math.min(filter.limit ?? 500, 5000));
    const { rows } = await this.db.query<Record<string, never>>(
      `${AUDIT_COLUMNS}
        WHERE ${clauses.join(' AND ')}
        ORDER BY id ASC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map(mapAuditRow);
  }

  /**
   * Full chain replay. Returns the first inconsistency found, if any.
   * Pass `null` to verify the system chain.
   */
  async verifyAuditChain(orgId: string | null): Promise<AuditChainResult> {
    const { rows } = await this.db.query<Record<string, never>>(
      `${AUDIT_COLUMNS} WHERE org_id IS NOT DISTINCT FROM $1 ORDER BY id ASC`,
      [orgId],
    );
    const events = rows.map(mapAuditRow);
    let prev: string | null = null;
    for (const e of events) {
      if (e.prevHash !== prev) {
        return {
          valid: false,
          checked: events.length,
          brokenAt: e.id,
          problem: 'prev_hash_mismatch',
        };
      }
      const expected = auditHash({
        prevHash: e.prevHash,
        orgId: e.orgId,
        occurredAt: e.occurredAt,
        action: e.action,
        decision: e.decision,
        reason: e.reason,
        actorId: e.actorId,
        fileId: e.fileId,
        grantId: e.grantId,
        ip: e.ip,
        userAgent: e.userAgent,
        context: e.context,
      });
      if (expected !== e.hash) {
        return { valid: false, checked: events.length, brokenAt: e.id, problem: 'hash_mismatch' };
      }
      prev = e.hash;
    }
    return { valid: true, checked: events.length };
  }

  // --- Counters (P6) --------------------------------------------------------

  /**
   * The conditional write *is* the reservation, and it charges the whole
   * ancestor chain (see `consume_download` in schema.sql). Never read the
   * counter and then decide -- see the "naive" comparison in the test suite for
   * what that costs.
   *
   * The function now always returns exactly one row, and this reads
   * `granted === true` rather than defaulting a missing value. Both halves of
   * that had to change: an explicit `(false, 0)` row makes the SQL side
   * unambiguous, and an explicit `=== true` makes the TypeScript side fail
   * closed even if the SQL side is ever replaced with something that returns
   * nothing at all.
   */
  async consumeDownload(grantId: string): Promise<{ granted: boolean; remaining: number | null }> {
    if (!isUuid(grantId)) return { granted: false, remaining: 0 };
    const { rows } = await this.db.query<{ granted: boolean; remaining: number | null }>(
      `SELECT granted, remaining FROM consume_download($1)`,
      [grantId],
    );
    const r = rows[0];
    if (!r || r.granted !== true) return { granted: false, remaining: 0 };
    return { granted: true, remaining: r.remaining === null ? null : Number(r.remaining) };
  }

  // --- Metering -------------------------------------------------------------

  async recordUsage(orgId: string, kind: 'authz' | 'read' | 'write', bytes = 0): Promise<void> {
    const col = kind === 'authz' ? 'authz_checks' : kind === 'read' ? 'file_reads' : 'file_writes';
    await this.db.query(
      `INSERT INTO usage_daily (org_id, day, ${col}, bytes_egressed)
       VALUES ($1, current_date, 1, $2)
       ON CONFLICT (org_id, day) DO UPDATE
         SET ${col} = usage_daily.${col} + 1,
             bytes_egressed = usage_daily.bytes_egressed + EXCLUDED.bytes_egressed`,
      [orgId, bytes],
    );
  }

  /**
   * Distinct actors who own a file on a given day. `usage_daily` counts events;
   * this counts PEOPLE, which is the quantity authorization load actually
   * tracks -- the graph walk behind every decision grows with the number of
   * distinct holders, not with how many bytes they hold. Idempotent per
   * (org, day, actor).
   */
  async recordFileOwner(orgId: string, actorId: string): Promise<void> {
    if (!isUuid(orgId) || !isUuid(actorId)) return;
    await this.db.query(
      `INSERT INTO file_owning_user_daily (org_id, day, actor_id)
       VALUES ($1, current_date, $2)
       ON CONFLICT (org_id, day, actor_id) DO NOTHING`,
      [orgId, actorId],
    );
  }
}

/**
 * A page is bounded so that one request cannot be turned into an unbounded
 * scan, and so that the single audit event's `fileIds` array stays bounded too.
 */
export const LIST_MAX_LIMIT = 200;
export const LIST_DEFAULT_LIMIT = 50;

/** Enum labels are `[a-z_]+` by construction. Assert it rather than assume it. */
function enumLiteral(v: string): string {
  if (!/^[a-z_]+$/.test(v)) throw new Error(`unexpected enum literal: ${v}`);
  return `'${v}'`;
}

/**
 * `(role, is_owner, visibility) IN ((...),(...))`, generated from the derived
 * cells. Returns null when the capability is unreachable by any role, so the
 * caller can substitute a constant `false` -- `IN ()` is a syntax error, and a
 * generator that emits a syntax error under a fail-CLOSED input is a generator
 * that will one day be "fixed" by removing the branch.
 */
function roleCellSql(p: ListPredicate): string | null {
  if (p.roleCells.length === 0) return null;
  return `(${p.roleCells
    .map((c) => `(${enumLiteral(c.role)}, ${c.isOwner}, ${enumLiteral(c.visibility)})`)
    .join(', ')})`;
}

/**
 * `(floor, held role) IN ((...),(...))` -- the group-grant threshold, generated
 * from the derived cells rather than written as `m.role >= g.subject_min_role`.
 *
 * WHY NOT JUST `>=`. Postgres would happily compare two `org_role` values by
 * their DECLARATION ORDER in the enum, and it would be correct today. It would
 * also be a second, independent statement of the role ordering, sitting in SQL,
 * agreeing with `ROLE_RANK` in authz.ts only by coincidence -- and reordering
 * the enum (or inserting a value into the middle of it, which
 * `ALTER TYPE ... ADD VALUE BEFORE` permits) would silently change who can read
 * what, with no test failing. Generating the pairs from `roleMeets()` keeps one
 * definition of the ordering, in TypeScript, where the point check reads it.
 *
 * A `role` grant with no floor is not representable (the CHECK requires one)
 * and an `org` grant's NULL floor reads as 'viewer', which is what the coalesce
 * says.
 *
 * Returns `false` when the cell list is empty, for the same reason
 * `roleCellSql` returns null: `IN ()` is a syntax error, and a generator that
 * crashes on a fail-CLOSED input is a generator someone will "fix".
 */
export function membershipCellSql(cells: readonly MembershipCell[]): string {
  if (cells.length === 0) return 'false';
  const tuples = cells
    .map((c) => `(${enumLiteral(c.minRole)}, ${enumLiteral(c.role)})`)
    .join(', ');
  return `(coalesce(g.subject_min_role::text, 'viewer'), m.role::text) IN (${tuples})`;
}

/**
 * The lifecycle gate. `state` is the EFFECTIVE state -- a soft-deleted row is
 * 'deleted' whatever the state column says, exactly as `getFile()` maps it, so
 * a half-applied delete cannot leave a listable file behind.
 */
function lifecycleSql(p: ListPredicate): string | null {
  if (p.lifecycleCells.length === 0) return null;
  const tuples = p.lifecycleCells
    .map((c) => `(${enumLiteral(c.state)}, ${c.expired}, ${c.retained})`)
    .join(', ');
  return `(
            CASE WHEN f.deleted_at IS NOT NULL THEN 'deleted' ELSE f.state::text END,
            (f.expires_at IS NOT NULL AND f.expires_at <= $3::timestamptz),
            (f.retain_until IS NOT NULL AND f.retain_until > $3::timestamptz)
          ) IN (${tuples})`;
}

function toListedFile(r: Record<string, unknown>): ListedFile {
  return {
    id: r['id'] as string,
    orgId: r['org_id'] as string,
    ownerId: (r['owner_id'] as string | null) ?? null,
    name: r['name'] as string,
    contentType: r['content_type'] as string,
    sizeBytes: r['size_bytes'] == null ? null : Number(r['size_bytes']),
    storageProvider: r['storage_provider'] as string,
    storageKey: r['storage_key'] as string,
    state: r['deleted_at'] ? 'deleted' : (r['state'] as 'pending' | 'ready' | 'deleted'),
    visibility: r['visibility'] as FileVisibility,
    expiresAt: r['expires_at'] ? new Date(r['expires_at'] as string) : null,
    retainUntil: r['retain_until'] ? new Date(r['retain_until'] as string) : null,
    createdAt: new Date(r['created_at'] as string),
  };
}

export interface AuditChainResult {
  valid: boolean;
  checked: number;
  brokenAt?: number;
  problem?: 'prev_hash_mismatch' | 'hash_mismatch';
}

const AUDIT_COLUMNS = `SELECT id, org_id, occurred_at, action, decision, reason, actor_id,
              file_id, grant_id, host(ip) AS ip, user_agent, context, prev_hash, hash
         FROM audit_event`;

export interface AuditHashInput {
  prevHash: string | null;
  orgId: string | null;
  occurredAt: Date;
  action: string;
  decision: string;
  actorId: string | null;
  fileId: string | null;
  reason?: string | null;
  grantId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  context?: Record<string, unknown> | null;
}

/**
 * Canonical JSON: object keys sorted at every depth, so a value that has been
 * through jsonb (which does not preserve insertion order) hashes identically to
 * the value that was written.
 */
export function canonicalJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v && typeof v === 'object') {
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalJson(src[k]);
    return out;
  }
  return v === undefined ? null : v;
}

/**
 * Everything in the digest input EXCEPT the predecessor hash, as the tail of a
 * JSON array -- i.e. `orgId,...,context]`, with no leading bracket.
 *
 * This split is what lets `audit_append()` (schema.sql) take the chain lock,
 * read the predecessor and compute the digest in ONE statement without any of
 * the canonical encoding being duplicated in SQL. The database performs one
 * concatenation:
 *
 *     '[' || to_json(prev_hash) || ',' || tail
 *
 * `prevHash` is the first element of the array for exactly this reason, and
 * moving it would silently break the chain -- which is why the ordering is
 * asserted by a test rather than left to a comment.
 */
export function auditHashTail(input: Omit<AuditHashInput, 'prevHash'>): string {
  return JSON.stringify([
    input.orgId,
    input.occurredAt.toISOString(),
    input.action,
    input.decision,
    input.reason ?? null,
    input.actorId,
    input.fileId,
    input.grantId ?? null,
    input.ip ?? null,
    input.userAgent ?? null,
    canonicalJson(input.context ?? {}),
  ]).slice(1); // drop the leading '['; the database supplies it with prev_hash
}

export function auditHash(input: AuditHashInput): string {
  const canonical = `[${JSON.stringify(input.prevHash)},${auditHashTail(input)}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function mapAuditRow(r: Record<string, unknown>): AuditRow {
  const rawContext = r['context'];
  return {
    id: Number(r['id']),
    orgId: (r['org_id'] as string | null) ?? null,
    occurredAt: new Date(r['occurred_at'] as string),
    action: r['action'] as string,
    decision: r['decision'] as 'allow' | 'deny',
    reason: (r['reason'] as string | null) ?? null,
    actorId: (r['actor_id'] as string | null) ?? null,
    fileId: (r['file_id'] as string | null) ?? null,
    grantId: (r['grant_id'] as string | null) ?? null,
    ip: (r['ip'] as string | null) ?? null,
    userAgent: (r['user_agent'] as string | null) ?? null,
    context:
      typeof rawContext === 'string'
        ? (JSON.parse(rawContext) as Record<string, unknown>)
        : ((rawContext as Record<string, unknown> | null) ?? {}),
    prevHash: (r['prev_hash'] as string | null) ?? null,
    hash: r['hash'] as string,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_RE = /^[0-9a-f:]{2,45}$/i;

/**
 * Accept only what `inet` will take back out unchanged.
 *
 * Two reasons this is not paranoia. First, `host(inet)` is what the chain
 * verifier reads, so any value Postgres would normalise (a CIDR suffix, for
 * instance) would silently break tamper-evidence for every subsequent event.
 * Second, an unparseable address would raise on INSERT, and since the audit
 * write is on the critical path of every request, that turns a malformed
 * `X-Forwarded-For` header into an outage.
 */
export function normalizeIp(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length === 0 || s.length > 45 || s.includes('/')) return null;
  if (IPV4_RE.test(s)) {
    return s.split('.').every((o) => Number(o) <= 255 && String(Number(o)) === o) ? s : null;
  }
  if (!s.includes(':') || !IPV6_RE.test(s.replace(/\.\d{1,3}/g, ''))) return null;
  // ::ffff:1.2.3.4 and friends: the tail must still be a legal dotted quad.
  const tail = s.slice(s.lastIndexOf(':') + 1);
  if (tail.includes('.') && !IPV4_RE.test(tail)) return null;
  return s;
}
