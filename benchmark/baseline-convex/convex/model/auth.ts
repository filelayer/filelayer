// convex/model/auth.ts  --  APPLICATION CODE (counted)
//
// WRITTEN TO SPEC. NOT EXECUTED.
//
// The entire authorization model for Vault. In Supabase this would be RLS
// policies enforced by the database on every statement. In Convex there is no
// such layer, so these are ordinary functions that every single query,
// mutation and HTTP action must remember to call.
//
// Docs: https://docs.convex.dev/auth/functions-auth
//       ctx.auth.getUserIdentity() returns null when unauthenticated; it never
//       throws, so an omitted null-check silently proceeds.
//
// READ THIS: Convex public functions (`query`, `mutation`, `action`) are
// callable by anyone who knows the deployment URL, authenticated or not.
// A public query that forgets `requireUser` is world-readable. There is no
// backstop. This is the single most important structural fact about this
// baseline and it is why the security-decision count in REPORT.md is
// per-function rather than per-policy.
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

export type Ctx = QueryCtx | MutationCtx;
export type Role = Doc<"orgMembers">["role"];

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export class Forbidden extends Error {
  constructor(msg = "Forbidden") {
    super(msg);
    this.name = "Forbidden";
  }
}

/** Resolve the caller. Throws if unauthenticated or unknown. */
export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Forbidden("Unauthenticated");
  const user = await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
    .unique();
  if (user === null) throw new Forbidden("Unknown user");
  return user;
}

/** The caller's role in an org, or null. Read on every authorization check. */
export async function roleInOrg(
  ctx: Ctx,
  orgId: Id<"orgs">,
  userId: Id<"users">,
): Promise<Role | null> {
  const m = await ctx.db
    .query("orgMembers")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
  return m?.role ?? null;
}

export async function requireRole(
  ctx: Ctx,
  orgId: Id<"orgs">,
  userId: Id<"users">,
  atLeast: Role,
): Promise<Role> {
  const role = await roleInOrg(ctx, orgId, userId);
  if (role === null) throw new Forbidden("Not a member of this org");
  if (RANK[role] < RANK[atLeast]) throw new Forbidden("Insufficient role");
  return role;
}

/**
 * Load a document AND check the caller may read it.
 *
 * This function exists because `ctx.db.get(documentId)` returns ANY document
 * by id with no tenant scoping whatsoever. Cross-org IDOR is the default
 * behaviour of the database; only this check prevents it. Every code path
 * that touches a document id must go through here or its sibling below.
 */
export async function loadReadableDocument(
  ctx: Ctx,
  user: Doc<"users">,
  documentId: Id<"documents">,
): Promise<Doc<"documents">> {
  const doc = await ctx.db.get(documentId);
  if (doc === null || doc.deletedAt !== undefined) {
    // Deliberately the same error as "not yours": distinguishing the two would
    // let an outsider probe for the existence of another org's document ids.
    throw new Forbidden("Not found");
  }
  const role = await roleInOrg(ctx, doc.orgId, user._id);
  if (role === null) throw new Forbidden("Not found");
  return doc;
}

/** Admins manage anything in their org; members manage what they uploaded. */
export async function loadManageableDocument(
  ctx: Ctx,
  user: Doc<"users">,
  documentId: Id<"documents">,
): Promise<Doc<"documents">> {
  const doc = await loadReadableDocument(ctx, user, documentId);
  const role = await roleInOrg(ctx, doc.orgId, user._id);
  const isAdmin = role === "admin" || role === "owner";
  if (!isAdmin && doc.uploaderId !== user._id) throw new Forbidden();
  return doc;
}

/**
 * Object keys are `${orgId}/${documentId}/${filename}`. A filename containing
 * a '/' would change that structure. Unlike the Supabase baseline nothing
 * downstream parses the key for authorization -- authorization is always by
 * document id -- but a crafted key can still collide with another org's
 * prefix in R2 listings and in the metadata table, so it is sanitised anyway.
 */
export function safeFilename(raw: string): string {
  const base = raw.split("/").pop()!.split("\\").pop()!;
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  if (clean.length === 0) throw new Error("invalid filename");
  return clean.slice(0, 200);
}

export const objectKey = (
  orgId: Id<"orgs">,
  documentId: Id<"documents">,
  filename: string,
) => `${orgId}/${documentId}/${filename}`;
