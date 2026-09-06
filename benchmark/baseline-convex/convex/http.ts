// convex/http.ts  --  APPLICATION CODE (counted)
// WRITTEN TO SPEC. NOT EXECUTED.
//
// The only two paths by which bytes leave the system. Both follow the pattern
// Convex's docs prescribe for "files requiring access control on every
// request":
//
//   "For files requiring access control on every request, serve files directly
//    from HTTP actions. The HTTP action should authenticate the request and
//    check that the caller can access the file before returning bytes."
//   -- https://docs.convex.dev/file-storage/serve-files#serving-files-from-http-actions
//
// DEVIATION, AND WHY. The doc's example returns `new Response(blob)`, which
// caps responses at 20MB (https://docs.convex.dev/functions/http-actions#limits)
// and streams every byte through Convex compute. A document workspace cannot
// accept a 20MB ceiling, so after authenticating we 302 to a 30-second R2
// presigned URL instead. This is a synthesis of the two things the docs
// recommend separately (HTTP-action authz + the R2 component for expiring
// URLs); no single doc page describes it. It removes the size cap and the
// egress cost, and it introduces the residual revocation window analysed in
// REPORT.md §9. The `?inline=1` branch keeps the documented small-file path
// for cases where the redirect is unacceptable.
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { presign, PRESIGNED_TTL_SEC } from "./r2";
import { derive, constantTimeEqual } from "./shares";

const http = httpRouter();

const CORS = {
  "Access-Control-Allow-Origin": process.env.CLIENT_ORIGIN!,
  Vary: "origin",
};

// ---------------------------------------------------------------------------
// 1. Authenticated in-app download.
//    Auth comes from the Authorization: Bearer <jwt> header, per
//    https://docs.convex.dev/auth/functions-auth#http-actions
// ---------------------------------------------------------------------------
http.route({
  path: "/download",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const identity = await ctx.auth.getUserIdentity();
    // getUserIdentity() returns null rather than throwing. Forgetting this
    // branch makes the endpoint anonymous, and nothing else would catch it.
    if (identity === null) return new Response("Unauthorized", { status: 401 });

    const url = new URL(request.url);
    const documentId = url.searchParams.get("documentId") as Id<"documents"> | null;
    if (documentId === null) return new Response("Bad request", { status: 400 });

    // Authorization is resolved server-side from the document id. The caller
    // never supplies, and never learns, an R2 key.
    const resolved = await ctx.runQuery(internal.documents.resolveForReader, {
      documentId,
      subject: identity.subject,
    });
    // Same 404 for "no such document" and "not yours", so document ids in
    // other orgs are not probeable.
    if (resolved === null) return new Response("Not found", { status: 404 });

    await ctx.runMutation(internal.shares.recordMemberDownload, {
      orgId: resolved.orgId,
      userId: resolved.userId,
      documentId,
    });

    if (url.searchParams.get("inline") === "1") {
      // The documented "serve bytes from the HTTP action" path, adapted: the
      // R2 component exposes no `getBlob`, so the action must presign and then
      // fetch its own URL. Every byte therefore crosses the network twice and
      // the response is still capped at 20MB.
      const upstream = await fetch(await presign(resolved.key));
      if (!upstream.ok) return new Response("Not found", { status: 404 });
      return new Response(upstream.body, {
        headers: { ...CORS, "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream" },
      });
    }

    return new Response(null, {
      status: 302,
      headers: { ...CORS, Location: await presign(resolved.key) },
    });
  }),
});

// ---------------------------------------------------------------------------
// 2. Anonymous share-link redemption.
//    Unauthenticated by design. Everything that protects the document is in
//    this handler and in shares.claimDownload.
// ---------------------------------------------------------------------------
http.route({
  pathPrefix: "/s/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const token = url.pathname.slice("/s/".length);
    const password = url.searchParams.get("password");

    const link = await ctx.runQuery(internal.shares.byToken, { token });
    // No audit record is possible here: with no valid token there is no org to
    // attribute the attempt to. Share-token brute force is therefore invisible
    // to the audit trail and must be caught by rate limiting instead --
    // which Convex does not provide, so it is a component you add.
    if (link === null) return deny(404, "not_found");

    if (link.revokedAt !== undefined) {
      await record(ctx, link.orgId, link._id, "revoked");
      return deny(410, "revoked");
    }
    if (link.expiresAt <= Date.now()) {
      await record(ctx, link.orgId, link._id, "expired");
      return deny(410, "expired");
    }

    if (link.passwordHash !== undefined) {
      if (password === null) {
        await record(ctx, link.orgId, link._id, "password_required");
        return deny(401, "password_required");
      }
      const candidate = await derive(password, link.passwordSalt!);
      if (!constantTimeEqual(candidate, link.passwordHash)) {
        await record(ctx, link.orgId, link._id, "bad_password");
        return deny(403, "bad_password");
      }
    }

    // Re-checks revocation, expiry, cap and document state INSIDE a
    // transaction, because everything above ran outside one and could be
    // stale. Convex's serializable mutations make the increment race-free.
    const claim = await ctx.runMutation(internal.shares.claimDownload, {
      shareLinkId: link._id,
    });
    if (!claim.ok) {
      await record(ctx, link.orgId, link._id, claim.reason);
      return deny(410, claim.reason);
    }

    return new Response(null, {
      status: 302,
      headers: {
        Location: await presign(claim.key),
        "Cache-Control": "no-store",
        "X-Residual-Revocation-Window-Sec": String(PRESIGNED_TTL_SEC),
      },
    });
  }),
});

http.route({
  path: "/download",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, {
    headers: {
      ...CORS,
      "Access-Control-Allow-Methods": "GET",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  })),
});

function deny(status: number, reason: string) {
  return new Response(JSON.stringify({ error: reason }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function record(ctx: any, orgId: any, shareLinkId: any, reason: string) {
  await ctx.runMutation(internal.shares.recordDenied, { orgId, shareLinkId, reason });
}

export default http;
