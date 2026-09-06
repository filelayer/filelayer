// convex/variantA_convexFileStorage.ts  --  COMPARISON ARTEFACT (not counted)
// WRITTEN TO SPEC. NOT EXECUTED. NOT PART OF THE VAULT IMPLEMENTATION.
//
// This is Vault's storage layer written the *other* documented way: pure
// Convex File Storage, no Cloudflare, no second vendor. It is here so the
// report can state precisely what you give up by taking the R2 route, and
// precisely why the R2 route was taken.
//
// Docs followed exactly:
//   https://docs.convex.dev/file-storage/upload-files
//   https://docs.convex.dev/file-storage/serve-files
//   https://docs.convex.dev/file-storage/delete-files
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireUser, requireRole, loadManageableDocument, safeFilename } from "./model/auth";

// 1. UPLOAD -- three client round-trips, per the docs.
export const generateUploadUrl = mutation({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireRole(ctx, args.orgId, user._id, "member");
    // "In the first mutation that generates the upload URL you can control who
    //  can upload files to your Convex storage."
    return ctx.storage.generateUploadUrl();
  },
});

export const attachStorageId = mutation({
  args: { orgId: v.id("orgs"), storageId: v.id("_storage"), filename: v.string() },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireRole(ctx, args.orgId, user._id, "member");
    return ctx.db.insert("documents", {
      orgId: args.orgId,
      uploaderId: user._id,
      filename: safeFilename(args.filename),
      // In this variant the storage id would go in place of r2Key.
      r2Key: args.storageId,
    });
  },
});

// 2. DELETE
export const deleteFile = mutation({
  args: { documentId: v.id("documents") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const doc = await loadManageableDocument(ctx, user, args.documentId);
    if (doc.r2Key !== undefined) {
      await ctx.storage.delete(doc.r2Key as any);
    }
    await ctx.db.patch(args.documentId, { deletedAt: Date.now() });
  },
});

// =====================================================================
// 3. SERVE -- and this is where the variant dies for this scenario.
// =====================================================================
//
// Option A1: return ctx.storage.getUrl(storageId) from a query.
//
//   Convex's own docs, verbatim:
//     "anyone with the URL can access the file without another app-level
//      authorization check. The only way to revoke a file URL is by deleting
//      the file."
//     -- https://docs.convex.dev/file-storage/overview
//
//   Against the Vault requirements this means:
//     * "revocation takes effect immediately even for links already issued"
//       -> IMPOSSIBLE. Not "hard". The only revocation primitive is deleting
//          the file, which destroys it for everyone including the owner. The
//          docs' own suggested remedy is "upload it again and share the new
//          URL only with authorized users."
//     * expiry            -> IMPOSSIBLE. The URL does not expire.
//     * password          -> IMPOSSIBLE. Nothing sits in front of the URL.
//     * download cap      -> IMPOSSIBLE. Fetches are invisible to the app.
//     * audit of views    -> IMPOSSIBLE. Fetches never reach your code.
//     * cross-org safety  -> The URL is a bearer credential. Forward it out of
//                            the org and the org boundary is gone.
//
// Option A2: serve bytes from an HTTP action (the docs' answer for
//   "files requiring access control on every request").
//
//   This does restore per-request authorization, audit, password and cap --
//   the checks all become ordinary code, as in convex/http.ts. But:
//     * HTTP action request AND response bodies are capped at 20MB.
//       -- https://docs.convex.dev/functions/http-actions#limits
//       A B2B document workspace with a hard 20MB ceiling is not a product.
//     * every byte is served by Convex compute and billed as Convex egress
//       ($0.12/GB beyond the included tier), with no CDN in front.
//
// Neither option satisfies the scenario. That is why the primary
// implementation uses the Cloudflare R2 component, which the docs themselves
// point to twice for exactly this reason:
//   "If you need file URLs that automatically expire after some time, consider
//    the Cloudflare R2 component."
//
// The cost of that redirection is a second vendor, a second console, a second
// set of credentials, a CORS policy on the bucket, and five more environment
// variables. See REPORT.md §5.
