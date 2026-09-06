/**
 * Authorization model. Every rule here is hand-written; nothing in Postgres or
 * S3 enforces any of it. If a query in routes.mjs forgets to call one of these
 * helpers, the system leaks silently and no test, log or alarm fires.
 */

export const ROLES = ['owner', 'admin', 'member', 'viewer'];
const RANK = { owner: 3, admin: 2, member: 1, viewer: 0 };

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export async function membership(db, orgId, userId) {
  const { rows } = await db.query(
    'SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2',
    [orgId, userId]
  );
  return rows[0]?.role ?? null;
}

/** Throws 404 (not 403) on non-membership so org existence is not probeable. */
export async function requireMember(db, orgId, userId, minRole = 'viewer') {
  const role = await membership(db, orgId, userId);
  if (!role) throw new HttpError(404, 'not_found');
  if (RANK[role] < RANK[minRole]) throw new HttpError(403, 'forbidden');
  return role;
}

export function canReadDocument(role) {
  return RANK[role] >= RANK.viewer;
}

/** Admins/owners manage any org document; members manage only their own. */
export function canManageDocument(role, doc, userId) {
  if (RANK[role] >= RANK.admin) return true;
  if (role === 'member') return doc.uploader_id === userId;
  return false;
}

/**
 * DECISION (ambiguous in the spec, see REPORT.md §3): "any member can create a
 * share link for a document they can read" is read as *any org member with at
 * least the `member` role*. Viewers are read-only and cannot mint external
 * grants. Getting this wrong in either direction is invisible at runtime.
 */
export function canCreateShare(role) {
  return RANK[role] >= RANK.member;
}

/** Share creators may revoke their own; admins/owners may revoke any. */
export function canRevokeShare(role, share, userId) {
  if (RANK[role] >= RANK.admin) return true;
  return share.created_by === userId;
}

export function canReadAudit(role) {
  return RANK[role] >= RANK.admin;
}

export function canChangeRoles(role) {
  return RANK[role] >= RANK.admin;
}

/** Admins may not create, demote or remove owners; only owners may. */
export function canAssignRole(actorRole, targetCurrentRole, newRole) {
  if (!canChangeRoles(actorRole)) return false;
  if (actorRole === 'owner') return true;
  if (targetCurrentRole === 'owner' || newRole === 'owner') return false;
  return true;
}
