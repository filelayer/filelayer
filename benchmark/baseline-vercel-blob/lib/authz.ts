/**
 * Role model.
 *
 * NOTE: this file is substantively identical to
 * `../baseline-raw-s3/src/authz.mjs`. That is the finding, not laziness.
 * Vercel Blob supplies no ownership, tenancy or role concept whatsoever
 * ("There is no ownership model — you write every authorization check"), so
 * the authorization surface is exactly as large as it is on raw S3.
 */
import { sql } from './db';

export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1, viewer: 0 };

export class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

export async function membership(orgId: string, userId: string): Promise<Role | null> {
  const rows = await sql`
    SELECT role FROM memberships WHERE org_id = ${orgId} AND user_id = ${userId}
  `;
  return (rows[0]?.role as Role) ?? null;
}

/** 404 rather than 403 for non-members, so org existence is not probeable. */
export async function requireMember(
  orgId: string,
  userId: string,
  minRole: Role = 'viewer'
): Promise<Role> {
  const role = await membership(orgId, userId);
  if (!role) throw new HttpError(404, 'not_found');
  if (RANK[role] < RANK[minRole]) throw new HttpError(403, 'forbidden');
  return role;
}

export function canManageDocument(role: Role, doc: { uploader_id: string }, userId: string) {
  if (RANK[role] >= RANK.admin) return true;
  if (role === 'member') return doc.uploader_id === userId;
  return false;
}

/** See REPORT.md §3 decision 2 for why viewers cannot mint external grants. */
export function canCreateShare(role: Role) {
  return RANK[role] >= RANK.member;
}

export function canRevokeShare(role: Role, share: { created_by: string }, userId: string) {
  return RANK[role] >= RANK.admin || share.created_by === userId;
}

export function canReadAudit(role: Role) {
  return RANK[role] >= RANK.admin;
}

export function canAssignRole(actorRole: Role, targetCurrentRole: Role | null, newRole: Role) {
  if (RANK[actorRole] < RANK.admin) return false;
  if (actorRole === 'owner') return true;
  if (targetCurrentRole === 'owner' || newRole === 'owner') return false;
  return true;
}

/** Loads a document with the org boundary enforced in the same query. */
export async function loadDoc(orgId: string, docId: string, statuses: string[]) {
  const rows = await sql`
    SELECT * FROM documents WHERE id = ${docId} AND org_id = ${orgId}
  `;
  const doc = rows[0];
  if (!doc || !statuses.includes(doc.status)) throw new HttpError(404, 'not_found');
  return doc;
}
