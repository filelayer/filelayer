import { sql } from '@/lib/db';
import {
  requireMember, membership, canAssignRole, ROLES, type Role, HttpError,
} from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { currentUser, route } from '@/app/api/_lib/handler';

export const PATCH = (
  request: Request,
  ctx: { params: Promise<{ orgId: string; userId: string }> }
) =>
  route(async () => {
    const { orgId, userId } = await ctx.params;
    const actor = currentUser(request);
    const actorRole = await requireMember(orgId, actor, 'admin');

    const target = await membership(orgId, userId);
    if (!target) throw new HttpError(404, 'not_found');

    const { role } = (await request.json()) as { role: Role };
    if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    if (!canAssignRole(actorRole, target, role)) throw new HttpError(403, 'forbidden');

    // An org with no owner cannot be administered by anyone, ever again.
    if (target === 'owner' && role !== 'owner') {
      const rows = await sql`
        SELECT count(*)::int AS n FROM memberships
         WHERE org_id = ${orgId} AND role = 'owner'
      `;
      if (rows[0].n <= 1) throw new HttpError(409, 'last_owner');
    }

    await sql`
      UPDATE memberships SET role = ${role}
       WHERE org_id = ${orgId} AND user_id = ${userId}
    `;
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'membership.role_changed',
      subjectType: 'user', subjectId: userId, metadata: { from: target, to: role },
    });
    return { orgId, userId, role };
  });
