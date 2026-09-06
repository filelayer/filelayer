// convex/schema.ts  --  APPLICATION CODE (counted)
//
// WRITTEN TO SPEC. NOT EXECUTED. See REPORT.md.
//
// Docs: https://docs.convex.dev/database/schemas
//       https://docs.convex.dev/database/reading-data/indexes
//
// Note what is absent and cannot be added: there is no row-level security in
// Convex. Nothing in this schema restricts who may read a row. Every access
// rule for every table below lives in imperative checks inside functions, and
// a function that forgets to call them returns the row.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const orgRole = v.union(
  v.literal("owner"),
  v.literal("admin"),
  v.literal("member"),
  v.literal("viewer"),
);

export default defineSchema({
  users: defineTable({
    // `subject` from ctx.auth.getUserIdentity(). Stable per identity provider.
    subject: v.string(),
    email: v.string(),
  }).index("by_subject", ["subject"]),

  orgs: defineTable({
    name: v.string(),
  }),

  orgMembers: defineTable({
    orgId: v.id("orgs"),
    userId: v.id("users"),
    role: orgRole,
  })
    // by_org_user is the hot path: it is read on EVERY authorization check.
    .index("by_org_user", ["orgId", "userId"])
    .index("by_user", ["userId"])
    .index("by_org", ["orgId"]),

  documents: defineTable({
    orgId: v.id("orgs"),
    uploaderId: v.id("users"),
    filename: v.string(),
    // R2 object key: `${orgId}/${documentId}/${filename}`.
    // Nullable because the row is created BEFORE the upload completes.
    r2Key: v.optional(v.string()),
    sizeBytes: v.optional(v.number()),
    mimeType: v.optional(v.string()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_r2Key", ["r2Key"]),

  shareLinks: defineTable({
    orgId: v.id("orgs"),
    documentId: v.id("documents"),
    createdBy: v.id("users"),
    token: v.string(),
    expiresAt: v.number(),
    // PBKDF2-SHA256 derived key + salt, both hex. Null = no password.
    passwordHash: v.optional(v.string()),
    passwordSalt: v.optional(v.string()),
    maxDownloads: v.optional(v.number()),
    downloadCount: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_token", ["token"])
    .index("by_document", ["documentId"])
    .index("by_org", ["orgId"]),

  // Tamper-EVIDENT audit trail. One hash chain per org.
  // Convex mutations are serializable transactions with automatic OCC retry,
  // so appends to a chain need no explicit lock -- a genuine simplification
  // over the advisory-lock dance a SQL implementation requires.
  auditLog: defineTable({
    orgId: v.id("orgs"),
    seq: v.number(),
    actorId: v.optional(v.id("users")),
    actorKind: v.union(
      v.literal("user"),
      v.literal("share_link"),
      v.literal("system"),
    ),
    action: v.union(
      v.literal("upload"),
      v.literal("view"),
      v.literal("download"),
      v.literal("share"),
      v.literal("revoke"),
      v.literal("delete"),
      v.literal("permission_change"),
    ),
    subject: v.any(),
    occurredAt: v.number(),
    prevHash: v.string(),
    hash: v.string(),
  }).index("by_org_seq", ["orgId", "seq"]),
});
