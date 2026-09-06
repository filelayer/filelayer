// convex/audit.ts  --  APPLICATION CODE (counted)
// WRITTEN TO SPEC. NOT EXECUTED.
//
// Audit trail read surface. Restricted to org admins -- by these two lines of
// imperative code and nothing else. Postgres would let you express the same
// rule as an RLS policy plus a withheld UPDATE/DELETE grant, so that even a
// future buggy query could not read or rewrite the log. Convex has no
// equivalent: every server function has unrestricted read and write access to
// every table, and `internal` only hides functions from clients.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requireUser, requireRole } from "./model/auth";
import { verifyChain } from "./model/audit";

export const listForOrg = query({
  args: { orgId: v.id("orgs"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireRole(ctx, args.orgId, user._id, "admin");
    return ctx.db
      .query("auditLog")
      .withIndex("by_org_seq", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Verify the hash chain.
 *
 * Note the scaling problem, which is not hypothetical: this reads every audit
 * row for the org in a single query. Convex queries have a document-read limit
 * and are billed per document read, so on a busy org this stops being runnable
 * long before the log stops being useful. A production version needs
 * checkpointing -- verify only since the last known-good sequence, and persist
 * that checkpoint -- which is additional code not written here.
 */
export const verify = query({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireRole(ctx, args.orgId, user._id, "admin");
    return verifyChain(ctx, args.orgId);
  },
});

/**
 * Head hash, for anchoring outside the deployment. Publishing this somewhere
 * the deployment's own credentials cannot reach is the only way to make the
 * chain resistant, rather than merely evident, to tampering by code running
 * inside the deployment. The anchoring itself is not implemented.
 */
export const head = query({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireRole(ctx, args.orgId, user._id, "admin");
    const last = await ctx.db
      .query("auditLog")
      .withIndex("by_org_seq", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .first();
    return last === null ? null : { seq: last.seq, hash: last.hash };
  },
});
