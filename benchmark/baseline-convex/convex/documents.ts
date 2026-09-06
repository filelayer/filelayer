// convex/documents.ts  --  APPLICATION CODE (counted)
// WRITTEN TO SPEC. NOT EXECUTED.
//
// Every exported `query`/`mutation` in this file is a public endpoint reachable
// by anyone with the deployment URL. The first line of each handler is the
// authorization check. There is no framework-level enforcement that the line is
// present; deleting it produces working, silent, world-readable code.
import { v } from "convex/values";
import { query, mutation, internalQuery } from "./_generated/server";
import {
  requireUser,
  requireRole,
  roleInOrg,
  loadReadableDocument,
  loadManageableDocument,
  Forbidden,
} from "./model/auth";
import { appendAudit } from "./model/audit";

export const listForOrg = query({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    // Viewers included: "viewers read only" still means they read.
    await requireRole(ctx, args.orgId, user._id, "viewer");

    const docs = await ctx.db
      .query("documents")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    // Post-filter, because Convex index ranges cannot express "deletedAt is
    // unset" without a dedicated index field. Note this reads (and bills for)
    // every soft-deleted row in the org forever.
    return docs
      .filter((d) => d.deletedAt === undefined)
      .map((d) => ({
        _id: d._id,
        filename: d.filename,
        uploaderId: d.uploaderId,
        sizeBytes: d.sizeBytes,
        mimeType: d.mimeType,
        _creationTime: d._creationTime,
      }));
  },
});

export const get = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const doc = await loadReadableDocument(ctx, user, args.documentId);
    // Never return r2Key to a client. Possession of the key plus any function
    // that presigns by key would be a cross-tenant read.
    const { r2Key: _omitted, ...safe } = doc;
    return safe;
  },
});

export const softDelete = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const doc = await loadManageableDocument(ctx, user, args.documentId);

    await ctx.db.patch(args.documentId, { deletedAt: Date.now() });
    await appendAudit(ctx, {
      orgId: doc.orgId,
      actorId: user._id,
      actorKind: "user",
      action: "delete",
      subject: { documentId: args.documentId },
    });

    // NOTE: the R2 object is deliberately NOT deleted here. Deleting it is the
    // only way to invalidate outstanding presigned URLs, but it is also
    // irreversible, so "soft delete" and "revoke access to the bytes" cannot
    // both be satisfied. See REPORT.md §9.
    return { ok: true };
  },
});

/**
 * Internal: used by the HTTP actions in http.ts, which run outside the
 * database transaction and therefore cannot call the model helpers directly.
 * `internalQuery` is not reachable from any client.
 */
export const resolveForReader = internalQuery({
  args: { documentId: v.id("documents"), subject: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    if (user === null) return null;

    const doc = await ctx.db.get(args.documentId);
    if (doc === null || doc.deletedAt !== undefined || doc.r2Key === undefined) return null;

    const role = await roleInOrg(ctx, doc.orgId, user._id);
    if (role === null) return null;

    return { key: doc.r2Key, orgId: doc.orgId, userId: user._id };
  },
});

export const requireOrgAdmin = internalQuery({
  args: { orgId: v.id("orgs"), subject: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    if (user === null) throw new Forbidden();
    const role = await roleInOrg(ctx, args.orgId, user._id);
    if (role !== "admin" && role !== "owner") throw new Forbidden();
    return user._id;
  },
});
