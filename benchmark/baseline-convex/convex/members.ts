// convex/members.ts  --  APPLICATION CODE (counted)
// WRITTEN TO SPEC. NOT EXECUTED.
import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { orgRole } from "./schema";
import { requireUser, requireRole, roleInOrg, Forbidden } from "./model/auth";
import { appendAudit } from "./model/audit";

export const list = query({
  args: { orgId: v.id("orgs") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await requireRole(ctx, args.orgId, user._id, "viewer");
    return ctx.db
      .query("orgMembers")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
  },
});

/**
 * Change a member's role.
 *
 * Two escalation guards, both of which must be written by hand and neither of
 * which any type or schema constraint expresses:
 *   - an admin may not create or modify an `owner`;
 *   - nobody may promote themselves.
 */
export const setRole = mutation({
  args: {
    orgId: v.id("orgs"),
    targetUserId: v.id("users"),
    role: orgRole,
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const actorRole = await requireRole(ctx, args.orgId, user._id, "admin");

    if (args.targetUserId === user._id) throw new Forbidden("Cannot change your own role");

    const target = await ctx.db
      .query("orgMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.targetUserId),
      )
      .unique();
    if (target === null) throw new Forbidden("Not a member");

    // Only an owner may mint an owner or demote one.
    if ((args.role === "owner" || target.role === "owner") && actorRole !== "owner") {
      throw new Forbidden("Only an owner may change owners");
    }

    await ctx.db.patch(target._id, { role: args.role });
    await appendAudit(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actorKind: "user",
      action: "permission_change",
      subject: { targetUserId: args.targetUserId, from: target.role, to: args.role },
    });
    return { ok: true };
  },
});

export const remove = mutation({
  args: { orgId: v.id("orgs"), targetUserId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    const actorRole = await requireRole(ctx, args.orgId, user._id, "admin");

    const target = await ctx.db
      .query("orgMembers")
      .withIndex("by_org_user", (q) =>
        q.eq("orgId", args.orgId).eq("userId", args.targetUserId),
      )
      .unique();
    if (target === null) throw new Forbidden("Not a member");
    if (target.role === "owner" && actorRole !== "owner") throw new Forbidden();

    // "The last owner cannot be removed." Expressing this needs a count over
    // the whole org, which is a table scan of orgMembers on every removal.
    // Cheap here; it is a real cost on a 10,000-member org.
    if (target.role === "owner") {
      const owners = (
        await ctx.db
          .query("orgMembers")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .collect()
      ).filter((m) => m.role === "owner");
      if (owners.length <= 1) throw new Forbidden("Cannot remove the last owner");
    }

    await ctx.db.delete(target._id);
    await appendAudit(ctx, {
      orgId: args.orgId,
      actorId: user._id,
      actorKind: "user",
      action: "permission_change",
      subject: { targetUserId: args.targetUserId, from: target.role, to: null },
    });

    // Removal takes effect on the very next authorization check, because the
    // role is read from the database on every call rather than from a token
    // claim. No staleness window. This is a genuine advantage of the
    // check-in-function model over JWT-embedded roles.
    return { ok: true };
  },
});

/** No RLS means the caller's own membership set is also an explicit query. */
export const myOrgs = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    const memberships = await ctx.db
      .query("orgMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return Promise.all(
      memberships.map(async (m) => ({
        orgId: m.orgId,
        role: m.role,
        name: (await ctx.db.get(m.orgId))?.name ?? null,
      })),
    );
  },
});

export { roleInOrg };
