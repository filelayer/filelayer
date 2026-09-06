// convex/shares.ts  --  APPLICATION CODE (counted)
// WRITTEN TO SPEC. NOT EXECUTED.
//
// Share links: expiry + optional password + max download count + revocation.
// None of the four is provided by Convex File Storage or by the R2 component;
// all four are implemented here and enforced in convex/http.ts.
import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser, roleInOrg, loadReadableDocument, Forbidden } from "./model/auth";
import { appendAudit } from "./model/audit";

const PBKDF2_ROUNDS = 120_000;
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * PBKDF2 via Web Crypto, which is what the Convex default runtime offers.
 * (`node:crypto` would require a `"use node"` action, i.e. a separate function
 * invocation with its own cold start on every password check.)
 */
export async function derive(password: string, saltHex: string): Promise<string> {
  const salt = Uint8Array.from(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
      key,
      256,
    ),
  );
}

/** Constant-time comparison. `a === b` here would be a timing oracle. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return hex(buf.buffer);
}

/** Any member who can READ a document may share it -- viewers included. */
export const create = mutation({
  args: {
    documentId: v.id("documents"),
    expiresInSec: v.number(),
    password: v.optional(v.string()),
    maxDownloads: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const doc = await loadReadableDocument(ctx, user, args.documentId);

    // orgId is taken from the DOCUMENT, never from the caller. Accepting an
    // orgId argument here and trusting it would let a member of org A mint a
    // link whose orgId says A but whose document belongs to B.
    const orgId = doc.orgId;

    let passwordHash: string | undefined;
    let passwordSalt: string | undefined;
    if (args.password !== undefined) {
      passwordSalt = randomHex(16);
      passwordHash = await derive(args.password, passwordSalt);
    }

    const token = randomHex(32);
    const shareLinkId = await ctx.db.insert("shareLinks", {
      orgId,
      documentId: args.documentId,
      createdBy: user._id,
      token,
      expiresAt: Date.now() + args.expiresInSec * 1000,
      passwordHash,
      passwordSalt,
      maxDownloads: args.maxDownloads,
      downloadCount: 0,
    });

    await appendAudit(ctx, {
      orgId,
      actorId: user._id,
      actorKind: "user",
      action: "share",
      subject: {
        shareLinkId,
        documentId: args.documentId,
        expiresInSec: args.expiresInSec,
        hasPassword: args.password !== undefined,
        maxDownloads: args.maxDownloads ?? null,
      },
    });

    return { shareLinkId, url: `${process.env.PUBLIC_APP_ORIGIN}/s/${token}` };
  },
});

export const listForDocument = query({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await loadReadableDocument(ctx, user, args.documentId);
    const links = await ctx.db
      .query("shareLinks")
      .withIndex("by_document", (q) => q.eq("documentId", args.documentId))
      .collect();
    // The raw token must never leave the server for links the caller did not
    // create, or "list shares" becomes "steal shares".
    return links.map((l) => ({
      _id: l._id,
      createdBy: l.createdBy,
      expiresAt: l.expiresAt,
      hasPassword: l.passwordHash !== undefined,
      maxDownloads: l.maxDownloads ?? null,
      downloadCount: l.downloadCount,
      revokedAt: l.revokedAt ?? null,
      token: l.createdBy === user._id ? l.token : undefined,
    }));
  },
});

/**
 * Revoke. Immediate for every FUTURE redemption, because redemption goes
 * through convex/http.ts which reads this row.
 *
 * NOT immediate for a presigned R2 URL already handed out: that URL is an AWS
 * SigV4 signature validated by Cloudflare with no callback into Convex. It
 * stays valid until PRESIGNED_TTL_SEC elapses. See REPORT.md §9 for the two
 * ways to close that window and why neither is good.
 */
export const revoke = mutation({
  args: { shareLinkId: v.id("shareLinks") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const link = await ctx.db.get(args.shareLinkId);
    // ctx.db.get is unscoped: without these checks any user revokes any link
    // in any org.
    if (link === null) throw new Forbidden("Not found");
    const role = await roleInOrg(ctx, link.orgId, user._id);
    if (role === null) throw new Forbidden("Not found");
    const isAdmin = role === "admin" || role === "owner";
    if (!isAdmin && link.createdBy !== user._id) throw new Forbidden();
    if (link.revokedAt !== undefined) return { ok: true, alreadyRevoked: true };

    await ctx.db.patch(args.shareLinkId, { revokedAt: Date.now() });
    await appendAudit(ctx, {
      orgId: link.orgId,
      actorId: user._id,
      actorKind: "user",
      action: "revoke",
      subject: { shareLinkId: args.shareLinkId, documentId: link.documentId },
    });
    return { ok: true, alreadyRevoked: false };
  },
});

// ---------------------------------------------------------------------------
// Internal surface used by the unauthenticated HTTP action in http.ts.
// ---------------------------------------------------------------------------

export const byToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Doc<"shareLinks"> | null> =>
    ctx.db
      .query("shareLinks")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique(),
});

/**
 * Claim one download. This runs inside a single Convex mutation, which is a
 * serializable transaction, so the read-then-write is atomic and two
 * simultaneous redemptions of a link with one download left cannot both
 * succeed. Convex's transaction model makes this correct by construction; the
 * SQL equivalent has to be hand-written as one atomic UPDATE ... WHERE.
 */
export const claimDownload = internalMutation({
  args: { shareLinkId: v.id("shareLinks") },
  handler: async (ctx, args) => {
    const link = await ctx.db.get(args.shareLinkId);
    if (link === null) return { ok: false as const, reason: "not_found" };
    if (link.revokedAt !== undefined) return { ok: false as const, reason: "revoked" };
    if (link.expiresAt <= Date.now()) return { ok: false as const, reason: "expired" };
    if (link.maxDownloads !== undefined && link.downloadCount >= link.maxDownloads) {
      return { ok: false as const, reason: "download_limit" };
    }

    const doc = await ctx.db.get(link.documentId);
    if (doc === null || doc.deletedAt !== undefined || doc.r2Key === undefined) {
      return { ok: false as const, reason: "document_deleted" };
    }

    const downloadCount = link.downloadCount + 1;
    await ctx.db.patch(args.shareLinkId, { downloadCount });

    // Audited BEFORE the bytes are addressable. Over-reporting is the safe
    // direction for an audit trail.
    await appendAudit(ctx, {
      orgId: link.orgId,
      actorKind: "share_link",
      action: "download",
      subject: {
        shareLinkId: args.shareLinkId,
        documentId: link.documentId,
        downloadCount,
        maxDownloads: link.maxDownloads ?? null,
      },
    });

    return { ok: true as const, key: doc.r2Key, downloadCount };
  },
});

export const recordDenied = internalMutation({
  args: {
    orgId: v.id("orgs"),
    shareLinkId: v.id("shareLinks"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    await appendAudit(ctx, {
      orgId: args.orgId,
      actorKind: "share_link",
      action: "view",
      subject: { shareLinkId: args.shareLinkId, outcome: "denied", reason: args.reason },
    });
  },
});

export const recordMemberDownload = internalMutation({
  args: {
    orgId: v.id("orgs"),
    userId: v.id("users"),
    documentId: v.id("documents"),
  },
  handler: async (ctx, args) => {
    await appendAudit(ctx, {
      orgId: args.orgId,
      actorId: args.userId,
      actorKind: "user",
      action: "download",
      subject: { documentId: args.documentId, via: "http_action" },
    });
  },
});
