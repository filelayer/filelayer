/**
 * FILELAYER AUTHORIZATION ENGINE
 *
 * Every access question in the system is answered here. There is deliberately
 * no second path. Reads, writes, deletes, shares, signed-URL redemptions,
 * membership changes, file creation and audit access all resolve through this
 * module, against one decision core (`allow` / `deny`).
 *
 * The engine has exactly two resource scopes:
 *
 *   authorize()     (actor, file, capability)      -- file-scoped
 *   authorizeOrg()  (actor, org,  org capability)  -- org-scoped
 *
 * The org scope exists because some privileges are not about a file: creating
 * one, reading the audit log, and changing who is in the organization. Those
 * used to be hand-rolled checks in the API layer or entirely absent.
 * Membership is a privilege change like any other, so it goes through
 * the same path, with the same deny reasons and the same audit guarantee.
 *
 * WHY ONE ENGINE MATTERS MORE THAN IT LOOKS:
 * The design goal is to minimise the "number of security-sensitive decisions a
 * developer must make". In a hand-rolled integration built directly on Supabase,
 * Convex or Vercel, that number scales with the number of *places* the
 * developer touches files:
 * every route, every RLS policy, every presign call is an independent chance
 * to leak. Here the developer makes none of them, because there is exactly one
 * place a decision can be made and it is not in the application.
 *
 * INVARIANTS (mirrored from schema.sql, enforced here in code):
 *   P1 deny by default          - DENY unless a rule fires, at the file
 *                                 boundary as well as the tenant boundary
 *   P2 no ambient authority     - storage keys/URLs/ids are never inputs
 *   P4 URL <= permission        - redemption re-validates the grant AND its
 *                                 whole ancestor chain, always
 *   P5 audit every decision     - every return path emits exactly one event,
 *                                 including decisions with no tenant to charge
 *
 * EVALUATION ORDER IS A SECURITY PROPERTY:
 *   1. Does the file exist?           -> no: deny, audit to the system chain
 *   2. Does the caller have STANDING? -> no: deny, and say nothing more
 *   3. Does their standing carry the requested capability?
 *   4. Only then: lifecycle gates (deleted / expired / not ready / retained)
 *
 * Steps 1-3 are indistinguishable to the caller: everything is 404. The
 * lifecycle statuses that are NOT 404 (410 Gone, 409 retention hold) are only
 * ever reachable by someone who has already proven they may perform the
 * operation, so they cannot be used to probe for the existence of a file.
 * Previously these gates ran first and the API layer patched over the resulting
 * oracle; that patch is gone.
 */

export type Capability = 'read' | 'write' | 'delete' | 'share';
export type OrgRole = 'viewer' | 'member' | 'admin' | 'owner';
export type FileVisibility = 'private' | 'org';
export type FileState = 'pending' | 'ready' | 'deleted';

export const ALL_CAPABILITIES: readonly Capability[] = ['read', 'write', 'delete', 'share'];
const ALL_ROLES: readonly OrgRole[] = ['viewer', 'member', 'admin', 'owner'];
const ALL_VISIBILITIES: readonly FileVisibility[] = ['private', 'org'];
const ALL_STATES: readonly FileState[] = ['pending', 'ready', 'deleted'];

/**
 * Privileges that are not about a particular file.
 *
 * Deliberately a closed, tiny set for the same reason `org_role` is: an
 * unbounded permission vocabulary is an authorization model nobody can audit.
 */
export type OrgCapability = 'create_file' | 'manage_members' | 'read_audit';

/** Ordered so comparisons are possible. Higher index = strictly more power. */
const ROLE_RANK: Record<OrgRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

/**
 * A grant's subject is a PRINCIPAL SET (RFC-001). See the `grant_subject` note
 * in schema.sql for the full reasoning; the ordering that matters here is
 *
 *     actor  <  role  <=  org  <  anonymous          (link is orthogonal)
 *
 * and it is what I6 attenuates over.
 */
export type GrantSubjectType = 'actor' | 'org' | 'role' | 'link' | 'anonymous';

/**
 * The subject types an issuer whose authority is GRANT-DERIVED may mint (I6).
 *
 * `actor` names one person and `link` is a bearer credential for one file;
 * neither widens the population the issuer could already reach. `org`, `role`
 * and `anonymous` all do, so a delegate may not create them at any depth.
 *
 * Exported so the rule is nameable in one place and testable directly, and so
 * that adding a sixth subject type forces a decision about it here rather than
 * silently defaulting to "delegable".
 */
export const DELEGABLE_SUBJECT_TYPES: readonly GrantSubjectType[] = ['actor', 'link'];

/**
 * THE ROLE THRESHOLD, DEFINED ONCE.
 *
 * `subject_min_role` is a floor over the existing four-value `org_role` enum
 * and nothing more -- no custom roles, no nesting, no configurable inheritance.
 * A `role` grant matches a principal holding `actual` iff this returns true; an
 * `org` grant is the same question with `min = 'viewer'`.
 *
 * Both the point check (`getGroupGrants`) and the set query
 * (`listAuthorizedFiles`) need this rule in SQL. Neither restates it: both are
 * generated from `membershipCells()` below, which is generated from this
 * function, exactly as the role matrix is generated from `fileCapabilities()`.
 */
export function roleMeets(actual: OrgRole, min: OrgRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[min];
}

/** One (floor, held) pair for which the threshold holds. */
export interface MembershipCell {
  minRole: OrgRole;
  role: OrgRole;
}

/**
 * Every (floor, held) pair that satisfies `roleMeets`. 4 x 4 = 16 probes of a
 * pure function; 10 cells survive. This is the whole group-membership rule, in
 * a form SQL can test with a tuple `IN` list.
 */
export function membershipCells(): MembershipCell[] {
  const cells: MembershipCell[] = [];
  for (const minRole of ALL_ROLES) {
    for (const role of ALL_ROLES) {
      if (roleMeets(role, minRole)) cells.push({ minRole, role });
    }
  }
  return cells;
}

export interface Principal {
  /** Null means anonymous: a caller presenting only a link secret. */
  actorId: string | null;
  /** Present only when redeeming a share link. */
  linkSecret?: string;
  /** Present only when the share link is password protected. */
  password?: string;
  ip?: string;
  userAgent?: string;
}

export interface FileRef {
  id: string;
  orgId: string;
  ownerId: string | null;
  state: 'pending' | 'ready' | 'deleted';
  visibility: FileVisibility;
  expiresAt: Date | null;
  retainUntil: Date | null;
}

export type Decision =
  | { allow: true; via: AuthzPath; grantId?: string; remainingDownloads?: number | null }
  | { allow: false; reason: DenyReason };

/**
 * Where an allow came from. `grant:org` and `grant:role` are the group paths
 * (RFC-001, I4): the audit event records not just that a grant conferred
 * access, but WHICH MEMBERSHIP did -- the subject org, the floor the grant
 * asked for, and the role the caller actually held in that org. Someone reading
 * the audit log can still answer "why did this succeed?" without joining
 * anything.
 */
export type AuthzPath =
  | 'owner'
  | 'role'
  | 'grant:actor'
  | 'grant:org'
  | 'grant:role'
  | 'grant:link'
  | 'grant:anonymous';

export type DenyReason =
  | 'file_not_found'
  | 'file_deleted'
  | 'file_expired'
  | 'file_not_ready'
  | 'no_membership'
  | 'insufficient_role'
  | 'no_grant'
  | 'grant_revoked'
  | 'grant_expired'
  | 'grant_exhausted'
  | 'grant_ancestor_dead'
  | 'grant_wrong_capability'
  | 'bad_link_secret'
  | 'bad_password'
  | 'foreign_grant'
  | 'retention_hold'
  | 'attenuation_violation'
  /**
   * I6 (RFC-001). The issuer's authority was grant-derived and they asked to
   * mint a subject wider than `actor` or `link`. Capability attenuation stops
   * you doing more; this stops you reaching more people.
   */
  | 'subject_breadth_amplification'
  | 'role_escalation'
  | 'superior_target'
  | 'last_owner';

/**
 * What each org role may do to a file in its own org.
 *
 * Deliberately small and total. Every cell is enumerated -- there is no
 * fallthrough, no "and also if", no special case. A reviewer can read this
 * table in ten seconds and know the entire role model, which is the point:
 * an authorization model you cannot hold in your head is one you cannot audit.
 *
 * `visibility` closes the "every viewer in an org could read every file in it"
 * defect. Under the default ('private') a file is not
 * visible to the org at large at all; membership alone buys nothing at the file
 * boundary. Org admins and owners keep full access under both settings, because
 * retention, deletion and legal hold are their responsibility, and a control
 * the accountable party cannot exercise is not a control.
 */
export function fileCapabilities(
  role: OrgRole,
  isOwner: boolean,
  visibility: FileVisibility,
): Set<Capability> {
  const none = new Set<Capability>();
  const readOnly = new Set<Capability>(['read']);
  const full = new Set<Capability>(['read', 'write', 'delete', 'share']);

  switch (role) {
    case 'viewer':
      // Viewers never do more than read, and under 'private' they read only
      // what is theirs.
      return isOwner || visibility === 'org' ? readOnly : none;
    case 'member':
      // Members fully control their own files, and may read others' in the org
      // only when the file was created org-visible.
      if (isOwner) return full;
      return visibility === 'org' ? readOnly : none;
    case 'admin':
    case 'owner':
      return full;
  }
}

/**
 * What each org role may do to the organization itself.
 *
 * The same shape as the file table above, and enumerated for the same reason.
 * `manage_members` is admin+: membership is the most powerful thing in the
 * system, because it is the thing that confers everything else.
 */
export function orgCapabilities(role: OrgRole): Set<OrgCapability> {
  switch (role) {
    case 'viewer':
      return new Set<OrgCapability>();
    case 'member':
      return new Set<OrgCapability>(['create_file']);
    case 'admin':
    case 'owner':
      return new Set<OrgCapability>(['create_file', 'manage_members', 'read_audit']);
  }
}

export interface AuthzDeps {
  getFile(fileId: string): Promise<FileRef | null>;
  orgExists(orgId: string): Promise<boolean>;
  getMembership(orgId: string, actorId: string): Promise<OrgRole | null>;
  countOwners(orgId: string): Promise<number>;
  /** Live grants only: the store must apply the `live_grant` predicate. */
  getActorGrants(fileId: string, actorId: string): Promise<GrantRow[]>;
  /**
   * Live GROUP grants ('org' / 'role') on this file that this actor matches
   * through a live membership (RFC-001).
   *
   * THE CONTRACT THAT MAKES THE HEADLINE PROPERTY TRUE: this is a JOIN against
   * `membership`, evaluated now. It is never a lookup into a materialized
   * member list, and the engine never caches its result across requests. That
   * is what makes "membership changes must change access on the next request,
   * without recomputation" true BY CONSTRUCTION rather than by a background job
   * that is usually up to date. An implementation of `AuthzDeps` that fans a
   * group grant out into per-member rows satisfies the type and breaks the
   * product.
   *
   * The returned rows carry `matchedRole` -- the role the actor actually holds
   * in the subject org -- so the audit event can record which membership
   * conferred access (I4).
   */
  getGroupGrants(fileId: string, actorId: string): Promise<GrantRow[]>;
  findLiveGrantBySecret(secretHash: string): Promise<GrantRow | null>;
  /**
   * ANY grant with this secret hash, live or not. Used ONLY to attribute and
   * classify a denial (P5) -- never to authorize. Without it a revoked,
   * expired or capped-out link is indistinguishable from a forged one, and the
   * compliance log cannot answer "why did my link stop working".
   */
  findGrantBySecret(secretHash: string): Promise<GrantRow | null>;
  /** Is `grantId` the same grant as, or delegated from, `ancestorId`? */
  isDescendantOf(ancestorId: string, grantId: string): Promise<boolean>;
  getAnonymousGrant(fileId: string): Promise<GrantRow | null>;
  /**
   * The set form of the decision. Given a predicate DERIVED from the same
   * `fileCapabilities` / `lifecycleDenial` functions the point check uses, the
   * store returns the files in one org for which that predicate holds.
   *
   * It takes a `ListPredicate`, not a WHERE clause. There is no way for a
   * caller to widen it, and no way to call it without one.
   */
  listAuthorizedFiles(query: ListQuery): Promise<ListedFile[]>;
  hashSecret(secret: string): Promise<string>;
  verifyPassword(password: string, hash: string): Promise<boolean>;
  audit(event: AuditInput): Promise<void>;
  now(): Date;
}

export interface GrantRow {
  id: string;
  fileId: string;
  orgId: string;
  parentGrantId: string | null;
  subjectType: GrantSubjectType;
  /** Set for 'org' and 'role' grants: the org whose members are the subject. */
  subjectOrgId: string | null;
  /** Set for 'role' grants only: the floor. Null on 'org' reads as 'viewer'. */
  subjectMinRole: OrgRole | null;
  /**
   * For a group grant resolved for a specific principal: the role that
   * principal actually holds in `subjectOrgId`. Not a column -- it comes out of
   * the membership join that matched -- and it exists so the audit event can
   * name WHICH MEMBERSHIP conferred access (I4) without a second query.
   */
  matchedRole?: OrgRole;
  capabilities: Capability[];
  passwordHash: string | null;
  expiresAt: Date | null;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: Date | null;
}

export interface AuditInput {
  /** Null is the SYSTEM chain: a decision with no tenant to charge it to. */
  orgId: string | null;
  action: string;
  decision: 'allow' | 'deny';
  reason?: string;
  actorId: string | null;
  fileId: string | null;
  grantId?: string | null;
  ip?: string;
  userAgent?: string;
  context?: Record<string, unknown>;
}

// =============================================================================
// STANDING -- "is this caller recognised on this file at all?"
// =============================================================================

interface Standing {
  /** True iff the principal holds at least one capability on this file. */
  recognised: boolean;
  role: OrgRole | null;
  capabilities: Set<Capability>;
  /** The grant that supplied the requested capability, if any. */
  grant: GrantRow | null;
  via: AuthzPath | null;
  /**
   * Set when resolution must terminate immediately with this reason. The only
   * case is a link secret presented with a bad or missing password, which is
   * answerable only to someone already holding the secret.
   */
  halt: { reason: DenyReason; grantId?: string } | null;
}

/**
 * Classify why a grant we can see is not live, for the audit log only.
 *
 * A grant that is self-consistent but still absent from `live_grant` is one
 * whose ancestor chain is dead: that is P4 working, and the log should say so
 * rather than reporting a forged secret.
 */
function deadGrantReason(g: GrantRow, now: Date): DenyReason {
  if (g.revokedAt) return 'grant_revoked';
  if (g.expiresAt && g.expiresAt <= now) return 'grant_expired';
  if (g.maxDownloads !== null && g.downloadCount >= g.maxDownloads) return 'grant_exhausted';
  return 'grant_ancestor_dead';
}

/**
 * @param complete when true, consult every source of authority even after the
 *   requested capability has been found. The fast path stops as soon as it can
 *   answer the question asked, which is right for an access check and wrong for
 *   delegation: attenuation compares against everything the issuer holds, and a
 *   partially-resolved set would refuse to pass on authority the issuer really
 *   has. Only the share path pays for it.
 */
async function resolveStanding(
  deps: AuthzDeps,
  principal: Principal,
  file: FileRef,
  capability: Capability,
  now: Date,
  complete = false,
): Promise<Standing> {
  const capabilities = new Set<Capability>();
  const acc: { via: AuthzPath | null; grant: GrantRow | null; role: OrgRole | null } = {
    via: null,
    grant: null,
    role: null,
  };

  /** Absorb a capability set; report whether it supplied the one we need. */
  const take = (caps: Iterable<Capability>, path: AuthzPath, g: GrantRow | null): boolean => {
    let got = false;
    for (const c of caps) {
      capabilities.add(c);
      if (c === capability) got = true;
    }
    if (got && acc.via === null) {
      acc.via = path;
      acc.grant = g;
    }
    return got;
  };

  const settled = (halt: Standing['halt'] = null): Standing => ({
    recognised: capabilities.size > 0,
    role: acc.role,
    capabilities,
    grant: acc.grant,
    via: acc.via,
    halt,
  });

  // --- org role -------------------------------------------------------------
  if (principal.actorId) {
    acc.role = await deps.getMembership(file.orgId, principal.actorId);
    if (acc.role) {
      const caps = fileCapabilities(acc.role, file.ownerId === principal.actorId, file.visibility);
      if (take(caps, 'role', null) && !complete) return settled();
    }

    // --- explicit actor grants ---------------------------------------------
    // A member of the org without the capability may still hold an explicit
    // grant, so we accumulate rather than deciding here.
    const grants = await deps.getActorGrants(file.id, principal.actorId);
    for (const g of grants) {
      if (take(g.capabilities, 'grant:actor', g) && !complete) return settled();
    }

    // --- group grants: 'org' and 'role' (RFC-001) --------------------------
    // Consulted AFTER the actor grants, so a grant naming this person by name
    // wins the `via` attribution over one that reaches them as part of a
    // population. Both are ordinary grant rows; nothing here is a special case
    // in liveness, revocation, delegation or capability handling.
    //
    // ONE EXTRA QUERY, resolved by JOIN. No fan-out, no materialized member
    // list, nothing cached: add or remove a member and the very next call to
    // this function sees it, with no grant row touched.
    const groupGrants = await deps.getGroupGrants(file.id, principal.actorId);
    for (const g of groupGrants) {
      const path: AuthzPath = g.subjectType === 'role' ? 'grant:role' : 'grant:org';
      if (take(g.capabilities, path, g) && !complete) return settled();
    }

    if (acc.via !== null && !complete) return settled();
  }

  // --- link grants ----------------------------------------------------------
  if (principal.linkSecret) {
    const hash = await deps.hashSecret(principal.linkSecret);
    const live = await deps.findLiveGrantBySecret(hash);

    // The grant must belong to the file being requested. Without this check a
    // valid link for file A would authorize file B -- the classic confused
    // deputy. It is one line and it is the whole ballgame.
    if (live && live.fileId === file.id) {
      if (live.passwordHash) {
        const ok =
          principal.password !== undefined &&
          (await deps.verifyPassword(principal.password, live.passwordHash));
        if (!ok) return settled({ reason: 'bad_password', grantId: live.id });
      }
      if (take(live.capabilities, 'grant:link', live) && !complete) return settled();
    } else if (!live) {
      // Attribution only, never authorization: if the secret is real but the
      // grant (or an ancestor of it) is dead, the log records which grant and
      // why. This is what makes an exhausted or revoked link visible in the
      // compliance record instead of looking like a forged one.
      const any = await deps.findGrantBySecret(hash);
      if (any && any.fileId === file.id) {
        return settled({ reason: deadGrantReason(any, now), grantId: any.id });
      }
    }
  }

  // --- anonymous grants -----------------------------------------------------
  // Note this is NOT a "public" flag on the file. It is an explicitly created,
  // individually revocable, individually auditable grant row (P1). Anonymous
  // grants are read-only by CHECK constraint, so there is nothing to look up
  // when a stronger capability was asked for -- unless we are resolving the
  // full set for delegation.
  if (capability === 'read' || complete) {
    const anon = await deps.getAnonymousGrant(file.id);
    if (anon) take(anon.capabilities, 'grant:anonymous', anon);
  }

  return settled();
}

/** The reason to report when a principal has no standing on a file at all. */
function noStandingReason(principal: Principal, role: OrgRole | null): DenyReason {
  if (principal.actorId) return role ? 'insufficient_role' : 'no_membership';
  if (principal.linkSecret) return 'bad_link_secret';
  return 'no_grant';
}

/**
 * File lifecycle gates, in order of severity. Null means the file is usable.
 *
 * Retention holds block deletion even for org owners. This is the point of
 * retention: it must bind the people who would otherwise be able to override
 * it, or it is not a compliance control.
 */
function lifecycleDenial(file: FileRef, capability: Capability, now: Date): DenyReason | null {
  if (file.state === 'deleted') return 'file_deleted';
  if (file.expiresAt && file.expiresAt <= now) return 'file_expired';
  if (file.state === 'pending' && capability === 'read') return 'file_not_ready';
  if (capability === 'delete' && file.retainUntil && file.retainUntil > now) {
    return 'retention_hold';
  }
  return null;
}

// =============================================================================
// THE FILE DECISION
// =============================================================================

interface FileResolution {
  decision: Decision;
  file: FileRef | null;
  standing: Standing | null;
}

/**
 * The whole file-scoped decision, exactly once, emitting exactly one event.
 * `authorize` and `authorizeShare` both run through here so that asking a
 * second question about the same request cannot cost a second audit event or a
 * second round of queries.
 */
async function decideFile(
  deps: AuthzDeps,
  principal: Principal,
  fileId: string,
  capability: Capability,
  complete = false,
): Promise<FileResolution> {
  const now = deps.now();
  const file = await deps.getFile(fileId);

  // --- 1. Existence ---------------------------------------------------------
  // Audited against the SYSTEM chain: there is no tenant to charge an
  // enumeration probe to, and inventing one would itself leak whether the file
  // exists. Dropping the event -- which is what we used to do -- made a file-id
  // sweep completely invisible.
  if (!file) {
    return {
      decision: await deny(deps, null, principal, fileId, capability, 'file_not_found'),
      file: null,
      standing: null,
    };
  }

  // --- 2. Standing ----------------------------------------------------------
  const standing = await resolveStanding(deps, principal, file, capability, now, complete);
  const out = (decision: Decision): FileResolution => ({ decision, file, standing });

  if (standing.halt) {
    return out(
      await deny(
        deps,
        file.orgId,
        principal,
        fileId,
        capability,
        standing.halt.reason,
        standing.halt.grantId,
      ),
    );
  }
  if (!standing.recognised) {
    return out(
      await deny(
        deps,
        file.orgId,
        principal,
        fileId,
        capability,
        noStandingReason(principal, standing.role),
      ),
    );
  }

  // --- 3. Capability --------------------------------------------------------
  if (!standing.capabilities.has(capability)) {
    return out(
      await deny(
        deps,
        file.orgId,
        principal,
        fileId,
        capability,
        standing.role ? 'insufficient_role' : 'grant_wrong_capability',
      ),
    );
  }

  // --- 4. Lifecycle ---------------------------------------------------------
  // Reached only by a caller who both has standing and holds the capability,
  // so a 410 or a 409 here tells an attacker nothing they did not already have
  // the authority to learn.
  const lifecycle = lifecycleDenial(file, capability, now);
  if (lifecycle) {
    return out(
      await deny(deps, file.orgId, principal, fileId, capability, lifecycle, standing.grant?.id),
    );
  }

  return out(
    await allow(deps, file.orgId, principal, fileId, capability, standing.via!, standing.grant),
  );
}

/** THE authorization decision. */
export async function authorize(
  deps: AuthzDeps,
  principal: Principal,
  fileId: string,
  capability: Capability,
): Promise<Decision> {
  return (await decideFile(deps, principal, fileId, capability)).decision;
}

// =============================================================================
// THE SET DECISION -- "which files may this principal see?"
// =============================================================================
//
// Listing is the highest-frequency operation in a document workspace and
// historically the highest-yield IDOR surface. Until the authorized listing
// primitive below existed, Filelayer had no
// answer for it at all: the only bulk-ish path was `getFileRecord()`, which
// took no principal (that is now private -- see the note on it in filelayer.ts
// -- and `stat()` is the authorized replacement), and a developer who needed a
// listing screen had to hand-roll SQL over `file` and reimplement org scoping,
// visibility, ownership, the role matrix and the grant union themselves --
// which is precisely the work the product claims to have removed.
//
// THE PROBLEM THIS CREATES, STATED HONESTLY.
// `authorize()` is a POINT check: it resolves one (principal, file) pair by
// running queries and TypeScript. A listing screen needs a SET answer over
// thousands of rows. Calling the point check per row is O(n) round trips and
// does not survive a real corpus. So the predicate has to be expressible in
// SQL -- and the moment the same rule exists in two languages, they can drift,
// and a drift in the widening direction is a cross-tenant leak that no test
// written against `authorize()` would catch. This is the hand-rolled-check
// problem in a new place: a second authorization path.
//
// HOW WE AVOID WRITING IT TWICE.
// The role matrix and the lifecycle gates are TOTAL FUNCTIONS OVER A FINITE
// DOMAIN: 4 roles x 2 ownerships x 2 visibilities = 16 cells, and 3 states x
// expired x retained = 12 cells. So we do not re-express them in SQL. We
// ENUMERATE the domain and call `fileCapabilities()` and `lifecycleDenial()` --
// the exact functions `authorize()` calls -- to derive the set of cells that
// carry the capability. The SQL is then a membership test against a generated
// tuple list. There is still exactly one definition of the role model and one
// definition of the lifecycle gates, and it is the one in this file.
//
// The group-grant threshold (`subject_min_role`) is handled the same way: the
// 16 (floor, held role) pairs are enumerated by `membershipCells()` from
// `roleMeets()`, and the SQL tests a tuple against that list rather than
// writing `m.role >= g.subject_min_role`, which would be a second, independent
// statement of the role ordering living in the enum's declaration order.
//
// WHAT IS STILL EXPRESSED TWICE: the SHAPE of the union (role OR actor-grant OR
// group-grant OR anonymous-grant) and the join structure. That is why the differential test in
// `test/listing.test.ts` exists and why it is the most important test in the
// suite: over a randomized corpus of orgs, roles, visibilities, ownerships,
// grants, delegations, revocations and expiries, it asserts
//
//     listFiles(p, org, cap)  ==  { f in org : authorize(p, f, cap).allow }
//
// element for element. If those ever diverge, the set query is leaking.
//
// SCOPE BOUNDARY (deliberate, and enforced rather than documented): a principal
// carrying a `linkSecret` cannot list. A link is a bearer credential for ONE
// file; "list everything this link can see" is not a meaningful question, and
// answering it would require resolving a password challenge across a result
// set. Attempting it is refused, not silently ignored.

export interface RoleCell {
  role: OrgRole;
  isOwner: boolean;
  visibility: FileVisibility;
}

export interface LifecycleCell {
  state: FileState;
  expired: boolean;
  retained: boolean;
}

export interface ListPredicate {
  capability: Capability;
  /** Every (role, ownership, visibility) cell whose role-derived caps hold it. */
  roleCells: RoleCell[];
  /** Every (state, expired, retained) cell that survives the lifecycle gate. */
  lifecycleCells: LifecycleCell[];
  /**
   * Every (grant floor, held role) pair satisfying the group-grant threshold.
   * Derived from `roleMeets()`, so the set query tests the same rule the point
   * check applies rather than restating `>=` in SQL.
   */
  membershipCells: MembershipCell[];
  /** Whether an anonymous grant can supply this capability at all. */
  anonymousEligible: boolean;
}

export interface ListQuery {
  orgId: string;
  actorId: string | null;
  predicate: ListPredicate;
  now: Date;
  limit: number;
  cursor: { createdAt: Date; id: string } | null;
}

/** The subset of file columns listing returns. Same shape the store reads. */
export interface ListedFile extends FileRef {
  name: string;
  contentType: string;
  sizeBytes: number | null;
  /**
   * An object's location is (provider, key), not key alone -- that pair is what
   * `file_storage_key_idx` makes unique. Code that carried only the key was the
   * shape of the bug that let `storage_provider` be hardcoded to 'memory' and go
   * unnoticed: nothing downstream ever read the column, so nothing ever
   * disagreed with it.
   */
  storageProvider: string;
  storageKey: string;
  createdAt: Date;
}

/**
 * Derive the set predicate from the point-check functions.
 *
 * Pure, total, and cheap enough to call per request (28 function calls). It is
 * called per request rather than memoised so that it cannot go stale against a
 * hot-reloaded or monkey-patched role table.
 */
export function listPredicate(capability: Capability): ListPredicate {
  const roleCells: RoleCell[] = [];
  for (const role of ALL_ROLES) {
    for (const isOwner of [false, true]) {
      for (const visibility of ALL_VISIBILITIES) {
        if (fileCapabilities(role, isOwner, visibility).has(capability)) {
          roleCells.push({ role, isOwner, visibility });
        }
      }
    }
  }

  // A fixed reference clock: we are probing a pure function, not reading time.
  const now = new Date(1_000_000);
  const past = new Date(now.getTime() - 1000);
  const future = new Date(now.getTime() + 1000);
  const lifecycleCells: LifecycleCell[] = [];
  for (const state of ALL_STATES) {
    for (const expired of [false, true]) {
      for (const retained of [false, true]) {
        const probe: FileRef = {
          id: '',
          orgId: '',
          ownerId: null,
          state,
          visibility: 'private',
          expiresAt: expired ? past : null,
          retainUntil: retained ? future : null,
        };
        if (lifecycleDenial(probe, capability, now) === null) {
          lifecycleCells.push({ state, expired, retained });
        }
      }
    }
  }

  // Mirrors `resolveStanding`: the anonymous grant is consulted only for
  // `read` on the access path. (Anonymous grants are read-only by CHECK, so
  // this is belt and braces -- but the point check has the branch, so the set
  // query must have it too or the two are not the same predicate.)
  //
  // Group grants have NO capability branch: unlike anonymous, they may carry
  // any capability, so they are consulted for every capability -- which is
  // exactly what `resolveStanding` does. The membership cells are the whole of
  // the extra rule, and they are derived, not written.
  return {
    capability,
    roleCells,
    lifecycleCells,
    membershipCells: membershipCells(),
    anonymousEligible: capability === 'read',
  };
}

export interface ListResult {
  files: ListedFile[];
  /** True when another page exists. Derived from a +1 over-fetch, not a count. */
  hasMore: boolean;
  /** The role the caller holds in the org, for the audit event. */
  role: OrgRole | null;
}

/**
 * THE set-scoped authorization decision.
 *
 * Note what this does NOT do: it does not gate on org membership before
 * running the query. That would be a SECOND, different rule -- and it would be
 * WRONG, because a grant may be issued to an actor who is not a member of the
 * owning org at all. Such an actor's `authorize(read)` returns allow, so their
 * `listFiles` must return that file, or the two disagree and the set query is
 * not the access model.
 *
 * The empty set is therefore the correct answer for a caller with no standing,
 * and it is also the answer for an org that does not exist. That symmetry is
 * deliberate: a 404 for "no such org" against a 200 for "org you cannot see"
 * would rebuild the existence oracle that the evaluation order closes.
 *
 * AUDIT: ONE event per call, not one per file. Reasoning in full, because it is
 * a judgement call, and the reasons are recorded here:
 *
 *  - The principal made ONE decision request and the engine evaluated ONE
 *    predicate. N events would describe an operation that did not happen: the
 *    caller did not access N files, they enumerated their own authorized set.
 *  - N events would put N hash-chain writes on the critical path of a read.
 *    The chain is serialized per org (see the chain-append note in store.ts),
 *    so a 200-row page would
 *    serialize 200 writes behind one lock. That is not a cost trade, it is an
 *    availability defect.
 *  - It would make unauthenticated chain flooding trivially worse: one
 *    request would append a page's worth of events.
 *  - A per-file loop would also emit a DENY for every file the caller may not
 *    see, which in a tenant with 100k files is 100k rows per listing screen.
 *
 * What is NOT given up: the event records the predicate (capability), the
 * caller's role, the result cardinality and the returned ids, so "what did this
 * principal learn the existence of, and when" is answerable from the log. And
 * an empty result from a caller with no standing is recorded as a DENY with the
 * same reason vocabulary the point check uses, so enumeration of a tenant by a
 * non-member still shows up in a `decision = 'deny'` query.
 */
export async function authorizeList(
  deps: AuthzDeps,
  principal: Principal,
  orgId: string,
  opts: { capability: Capability; limit: number; cursor: { createdAt: Date; id: string } | null },
): Promise<ListResult> {
  const now = deps.now();
  const exists = await deps.orgExists(orgId);
  const role =
    exists && principal.actorId ? await deps.getMembership(orgId, principal.actorId) : null;

  // One row over the page size, so "is there another page" costs nothing. A
  // count(*) would have to evaluate the predicate over the whole tenant, which
  // is both slow and a way to measure a tenant you cannot read.
  //
  // NOTE: the query runs whether or not `orgExists` said yes, and `exists` is
  // used ONLY to decide which audit chain the event belongs to. Gating the
  // query on it would be a precondition the point check does not have.
  //
  // This is where a stale-scope defect was found. `getMembership` joined `org` on
  // `deleted_at IS NULL` and `getActorGrants` did not, so a soft-deleted org
  // stopped conferring membership while leaving outstanding grants alive:
  // `authorize()` still allowed a grant-holder to read those files, and a
  // version of this function that skipped the query returned LESS than
  // `authorize()` permitted. Fail-closed, and still a divergence, and the
  // differential test caught it.
  //
  // That is now closed in the schema (`grant_scope_is_live`), so BOTH sides
  // return nothing for a deleted org -- and they return nothing for the same
  // reason, evaluated in the same predicate, rather than by two functions that
  // happen to agree. The structure here is unchanged on purpose: `exists`
  // still selects a chain and never gates a query.
  const fetched = await deps.listAuthorizedFiles({
    orgId,
    actorId: principal.actorId,
    predicate: listPredicate(opts.capability),
    now,
    limit: opts.limit + 1,
    cursor: opts.cursor,
  });
  const hasMore = fetched.length > opts.limit;
  const files = hasMore ? fetched.slice(0, opts.limit) : fetched;

  const empty = files.length === 0;
  await deps.audit({
    // An org we cannot confirm goes to the system chain, exactly as
    // `authorizeOrg` does, and for the same reason.
    orgId: exists ? orgId : null,
    action: 'file.list',
    decision: empty ? 'deny' : 'allow',
    ...(empty ? { reason: noStandingReason(principal, role) } : {}),
    actorId: principal.actorId,
    fileId: null,
    ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
    ...(principal.userAgent !== undefined ? { userAgent: principal.userAgent } : {}),
    context: {
      ...(exists ? {} : { chain: 'system', orgId }),
      capability: opts.capability,
      role,
      count: files.length,
      fileIds: files.map((f) => f.id),
      paged: opts.cursor !== null,
      hasMore,
    },
  });

  return { files, hasMore, role };
}

// =============================================================================
// DELEGATION -- attenuation is an authorization question
// =============================================================================

export type ShareDecision =
  | {
      allow: true;
      via: AuthzPath;
      /**
       * The grant the issuer's authority came from, or null when it came from
       * an org role. This becomes the child's `parent_grant_id`, and it is what
       * makes revocation transitive (P4).
       */
      parentGrantId: string | null;
      /** Everything the issuer holds; the child may not exceed this. */
      held: Capability[];
    }
  | { allow: false; reason: DenyReason };

/**
 * May this principal mint a grant on this file carrying these capabilities, to
 * this kind of subject?
 *
 * Three questions, and all three belong here rather than in the API layer:
 *
 *   1. May they share at all?
 *   2. Is what they are handing out a SUBSET of what they hold?   (capability)
 *   3. Is who they are handing it to no WIDER than they may reach? (I6, breadth)
 *
 * (2) used to live in `filelayer.share()`, which meant any second entry point
 * built on `authorize()` silently reintroduced the escalation: a holder
 * of `{share}` minting themselves `{delete}`. It is an authorization question,
 * so the authorization engine answers it. The schema enforces the same rule
 * again on the row itself, because a rule that exists only in application code
 * binds only the application.
 *
 * (3) is the same argument in the other dimension, and it is new (RFC-001, I6).
 * Attenuation over capabilities says what a delegate may DO; without a rule
 * over subject breadth, a contractor holding one `{read, share}` grant could
 * re-grant to an entire organization -- or to `anonymous` -- and every
 * capability check would pass, because the child's set is a subset. Authority
 * derived from an ORG ROLE (`via` of 'role' or 'owner') may name any subject;
 * authority derived from a GRANT may name only an `actor` or mint a `link`.
 *
 * The engine refuses first, so the refusal is a decision with a reason and an
 * audit event. The trigger in schema.sql refuses the same row again, so the
 * rule holds for a caller issuing raw SQL. Same structure, same reasoning, as
 * capability attenuation.
 *
 * -----------------------------------------------------------------------------
 * KNOWN GAP, RECORDED RATHER THAN HIDDEN: `held` IS A UNION, `parentGrantId` IS
 * ONE ROW.
 * -----------------------------------------------------------------------------
 * `held` is the union of every capability the issuer holds from every source,
 * while `parentGrantId` is the SINGLE grant that supplied `share`. When a
 * principal holds several grants on one file, the engine can therefore approve
 * a capability set that no single ancestor covers -- and the attenuation
 * trigger, which compares the child against its ONE parent, then refuses the
 * INSERT. The outcome is a 403 rather than a disclosure, so the failure is
 * fail-CLOSED and P4 is intact; what is wrong is that a legitimate delegation
 * can be refused, and which one depends on the order the grants come back in.
 *
 * That order is now defined (`getActorGrants` sorts oldest-first) so the
 * behaviour is at least deterministic and reproducible. Closing the gap
 * properly means either picking the parent that covers the requested set, or
 * minting one child per contributing ancestor, and both are changes to the
 * delegation model rather than to this rule. Out of scope for RFC-001; flagged
 * here so it is a decision rather than an accident.
 */
export async function authorizeShare(
  deps: AuthzDeps,
  principal: Principal,
  fileId: string,
  requested: readonly Capability[],
  opts: { subjectType?: GrantSubjectType } = {},
): Promise<ShareDecision> {
  const resolved = await decideFile(deps, principal, fileId, 'share', true);
  if (!resolved.decision.allow) return { allow: false, reason: resolved.decision.reason };

  const held = resolved.standing!.capabilities;
  for (const cap of requested) {
    if (!held.has(cap)) {
      await deps.audit({
        orgId: resolved.file!.orgId,
        action: 'grant.create',
        decision: 'deny',
        reason: 'attenuation_violation',
        actorId: principal.actorId,
        fileId,
        ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
        context: { requested: [...requested], held: [...held] },
      });
      return { allow: false, reason: 'attenuation_violation' };
    }
  }

  // I6. `grantId` is set exactly when the authority that carried `share` came
  // from a grant rather than from an org role -- it is the same value that
  // becomes `parent_grant_id` below, which is what makes the engine's rule and
  // the trigger's rule the same rule rather than two rules that agree.
  const parentGrantId = resolved.decision.grantId ?? null;
  const subjectType = opts.subjectType;
  if (
    parentGrantId !== null &&
    subjectType !== undefined &&
    !DELEGABLE_SUBJECT_TYPES.includes(subjectType)
  ) {
    await deps.audit({
      orgId: resolved.file!.orgId,
      action: 'grant.create',
      decision: 'deny',
      reason: 'subject_breadth_amplification',
      actorId: principal.actorId,
      fileId,
      grantId: parentGrantId,
      ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
      context: {
        requestedSubjectType: subjectType,
        via: resolved.decision.via,
        delegableSubjectTypes: [...DELEGABLE_SUBJECT_TYPES],
      },
    });
    return { allow: false, reason: 'subject_breadth_amplification' };
  }

  return {
    allow: true,
    via: resolved.decision.via,
    // Authority derived from an org role has no parent grant; authority
    // derived from a grant does, and the child is bound to it forever.
    parentGrantId: resolved.decision.grantId ?? null,
    held: [...held],
  };
}

/**
 * May this principal revoke this grant?
 *
 * Found during the review of the delegation work and fixed with it: holding
 * `share` on a file used to mean holding revoke over EVERY grant on that file.
 * A contractor given a delegated `{read, share}` could therefore revoke the
 * owner's unrelated share links -- not a disclosure, but a straightforward
 * denial of service against the file's other recipients, and a strange thing
 * for "you may pass this on" to imply.
 *
 * The rule mirrors the delegation model rather than adding a new one:
 *
 *   - authority from an org ROLE (admin, owner, or the file's own owner)
 *     carries revoke over every grant on the file, as before;
 *   - authority from a GRANT carries revoke only over that grant's own subtree,
 *     which is exactly the authority it was given.
 */
export async function authorizeRevoke(
  deps: AuthzDeps,
  principal: Principal,
  grant: { id: string; fileId: string; orgId: string },
): Promise<Decision> {
  const resolved = await decideFile(deps, principal, grant.fileId, 'share');
  if (!resolved.decision.allow) return resolved.decision;

  const via = resolved.decision.grantId ?? null;
  if (via === null || grant.id === via || (await deps.isDescendantOf(via, grant.id))) {
    return resolved.decision;
  }

  await deps.audit({
    orgId: grant.orgId,
    action: 'grant.revoke',
    decision: 'deny',
    reason: 'foreign_grant',
    actorId: principal.actorId,
    fileId: grant.fileId,
    grantId: grant.id,
    ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
    context: { viaGrantId: via },
  });
  return { allow: false, reason: 'foreign_grant' };
}

// =============================================================================
// THE ORG DECISION
// =============================================================================

export async function authorizeOrg(
  deps: AuthzDeps,
  principal: Principal,
  orgId: string,
  capability: OrgCapability,
  opts: { action?: string; emitAllow?: boolean } = {},
): Promise<Decision> {
  const action = opts.action ?? `org.${capability}`;
  const emitAllow = opts.emitAllow ?? true;

  // An org we cannot see is audited to the system chain, for the same reason a
  // file we cannot see is: attributing the event would confirm the org id, and
  // the audit row's own foreign key would fail anyway.
  const exists = await deps.orgExists(orgId);
  if (!exists || !principal.actorId) {
    return denyOrg(deps, exists ? orgId : null, principal, orgId, action, 'no_membership');
  }

  const role = await deps.getMembership(orgId, principal.actorId);
  if (!role) return denyOrg(deps, orgId, principal, orgId, action, 'no_membership');
  if (!orgCapabilities(role).has(capability)) {
    return denyOrg(deps, orgId, principal, orgId, action, 'insufficient_role');
  }

  if (emitAllow) {
    await deps.audit({
      orgId,
      action,
      decision: 'allow',
      actorId: principal.actorId,
      fileId: null,
      ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
      ...(principal.userAgent !== undefined ? { userAgent: principal.userAgent } : {}),
      context: { via: 'role', role, capability },
    });
  }
  return { allow: true, via: 'role' };
}

/**
 * May this principal set `targetActorId` to `newRole` (null = remove them)?
 *
 * Membership is the privilege that confers every other privilege, so the rules
 * are stated here rather than left to the application:
 *
 *   - you must hold `manage_members` (admin or owner);
 *   - you may not grant a role above your own -- otherwise `admin` is just
 *     `owner` with an extra step;
 *   - you may not modify anyone who currently outranks you;
 *   - you may not remove or demote the last owner, because an org nobody
 *     administers cannot honour a retention hold or a deletion request.
 *
 * Exactly one audit event is emitted per attempt, allow or deny. A membership
 * change that leaves no trace is indistinguishable from a breach after the
 * fact.
 */
export async function authorizeMembershipChange(
  deps: AuthzDeps,
  principal: Principal,
  orgId: string,
  targetActorId: string,
  newRole: OrgRole | null,
): Promise<Decision> {
  const orgReal = await deps.orgExists(orgId);
  const currentRole = orgReal ? await deps.getMembership(orgId, targetActorId) : null;
  const action =
    newRole === null ? 'member.remove' : currentRole === null ? 'member.add' : 'member.role_change';

  const base = await authorizeOrg(deps, principal, orgId, 'manage_members', {
    action,
    emitAllow: false,
  });
  if (!base.allow) return base;

  const actorRole = (await deps.getMembership(orgId, principal.actorId!))!;
  const context = { targetActorId, fromRole: currentRole, toRole: newRole, byRole: actorRole };

  const settle = async (reason: DenyReason | null): Promise<Decision> => {
    await deps.audit({
      orgId,
      action,
      decision: reason ? 'deny' : 'allow',
      ...(reason ? { reason } : {}),
      actorId: principal.actorId,
      fileId: null,
      ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
      ...(principal.userAgent !== undefined ? { userAgent: principal.userAgent } : {}),
      context,
    });
    return reason ? { allow: false, reason } : { allow: true, via: 'role' };
  };

  if (currentRole !== null && ROLE_RANK[currentRole] > ROLE_RANK[actorRole]) {
    return settle('superior_target');
  }
  if (newRole !== null && ROLE_RANK[newRole] > ROLE_RANK[actorRole]) {
    return settle('role_escalation');
  }
  if (currentRole === 'owner' && newRole !== 'owner' && (await deps.countOwners(orgId)) <= 1) {
    return settle('last_owner');
  }
  return settle(null);
}

// =============================================================================
// DECISION CORE -- the only places an access event is written
// =============================================================================

/**
 * I4. For a group grant, "why did this succeed?" is not answered by `via`
 * alone -- the caller is one of a population, and a compliance auditor needs to know
 * which membership put them in it. The event already carries `actor_id` and
 * `grant_id`, so the missing half is the subject org, the floor the grant
 * asked for, and the role the caller actually held. All three come out of the
 * membership join that already matched; none of them costs a second query.
 */
function membershipContext(grant: GrantRow | null): Record<string, unknown> {
  if (!grant || grant.subjectOrgId === null) return {};
  return {
    viaOrgId: grant.subjectOrgId,
    viaMinRole: grant.subjectMinRole,
    ...(grant.matchedRole !== undefined ? { viaRole: grant.matchedRole } : {}),
  };
}

async function allow(
  deps: AuthzDeps,
  orgId: string,
  p: Principal,
  fileId: string,
  capability: Capability,
  via: AuthzPath,
  grant: GrantRow | null,
): Promise<Decision> {
  await deps.audit({
    orgId,
    action: `file.${capability}`,
    decision: 'allow',
    actorId: p.actorId,
    fileId,
    grantId: grant?.id ?? null,
    ...(p.ip !== undefined ? { ip: p.ip } : {}),
    ...(p.userAgent !== undefined ? { userAgent: p.userAgent } : {}),
    context: { via, ...membershipContext(grant) },
  });
  return {
    allow: true,
    via,
    ...(grant ? { grantId: grant.id } : {}),
    remainingDownloads:
      grant == null || grant.maxDownloads == null ? null : grant.maxDownloads - grant.downloadCount,
  };
}

async function deny(
  deps: AuthzDeps,
  orgId: string | null,
  p: Principal,
  fileId: string,
  capability: Capability,
  reason: DenyReason,
  grantId?: string,
): Promise<Decision> {
  await deps.audit({
    orgId,
    action: `file.${capability}`,
    decision: 'deny',
    reason,
    actorId: p.actorId,
    fileId,
    grantId: grantId ?? null,
    ...(p.ip !== undefined ? { ip: p.ip } : {}),
    ...(p.userAgent !== undefined ? { userAgent: p.userAgent } : {}),
    ...(orgId === null ? { context: { chain: 'system' } } : {}),
  });
  return { allow: false, reason };
}

async function denyOrg(
  deps: AuthzDeps,
  auditOrgId: string | null,
  p: Principal,
  orgId: string,
  action: string,
  reason: DenyReason,
): Promise<Decision> {
  await deps.audit({
    orgId: auditOrgId,
    action,
    decision: 'deny',
    reason,
    actorId: p.actorId,
    fileId: null,
    ...(p.ip !== undefined ? { ip: p.ip } : {}),
    ...(p.userAgent !== undefined ? { userAgent: p.userAgent } : {}),
    context: auditOrgId === null ? { chain: 'system', orgId } : { orgId },
  });
  return { allow: false, reason };
}

/**
 * Emit an audit event for a decision that never reached the engine because the
 * credential presented could not be resolved to anything at all -- a link
 * secret matching no grant. There is no file and no tenant, so it goes to the
 * system chain. A truncated hash of the presented secret is recorded so a
 * brute-force sweep is correlatable; it is a 48-bit prefix of a SHA-256, not
 * the credential, and it is useless without the original.
 */
export async function auditUnresolvedSecret(
  deps: AuthzDeps,
  principal: Principal,
  secretHash: string,
): Promise<void> {
  await deps.audit({
    orgId: null,
    action: 'file.read',
    decision: 'deny',
    reason: 'bad_link_secret',
    actorId: principal.actorId,
    fileId: null,
    ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
    ...(principal.userAgent !== undefined ? { userAgent: principal.userAgent } : {}),
    context: { chain: 'system', secretHashPrefix: secretHash.slice(0, 12) },
  });
}

/**
 * The refusals the schema raises on its own account (see the attenuation
 * trigger in schema.sql).
 *
 * The engine refuses these cases first, so a trigger firing means the engine
 * and the schema disagree -- which is a bug worth an alert, not a stack trace
 * in a caller's face. The vocabulary lives here, next to the rules it mirrors,
 * so that the two cannot drift apart in separate files.
 */
const SCHEMA_REFUSAL =
  /^(grant_capability_amplification|grant_subject_amplification|grant_parent_not_live|grant_parent_exhausted|grant_parent_missing|grant_delegation_too_deep|grant_lineage_immutable)/;

export function schemaRefusal(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  return SCHEMA_REFUSAL.test(message) ? message.split(':')[0]! : null;
}

/**
 * Collapse internal deny reasons into what the caller is told.
 *
 * Internally we record precisely why access was denied, because that is what
 * makes the audit log useful for incident response. Externally we return 404
 * for everything that would otherwise confirm a file's existence -- otherwise
 * the error message becomes an enumeration oracle across tenants.
 *
 * Grant-level lifecycle reasons (revoked / expired / exhausted / ancestor dead)
 * collapse to 404 as well. A 410 "your link is used up" would be friendlier and
 * is reachable only by someone holding a 256-bit secret, so the leak is
 * theoretical -- but it costs nothing to make a dead link indistinguishable
 * from a forged one, and the audit log carries the true reason for the operator
 * who actually needs it.
 *
 * The asymmetry between what we log and what we return is intentional and is
 * the kind of decision a hand-rolled integration requires developers to make
 * themselves, in every route, correctly, every time.
 */
export function toPublicError(reason: DenyReason): { status: number; code: string } {
  switch (reason) {
    case 'bad_password':
      return { status: 401, code: 'password_required' };
    case 'file_expired':
      return { status: 410, code: 'gone' };
    case 'retention_hold':
      return { status: 409, code: 'retention_hold' };
    // Attenuation and membership-management refusals are answered to a caller
    // who has already proven standing and already knows the resource exists:
    // 403 leaks nothing and is far more useful than a 404.
    case 'attenuation_violation':
    case 'subject_breadth_amplification':
    case 'role_escalation':
    case 'superior_target':
    case 'last_owner':
      return { status: 403, code: 'forbidden' };
    default:
      return { status: 404, code: 'not_found' };
  }
}
