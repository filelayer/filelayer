import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireMember, canAssignRole, ROLES, type Role, HttpError } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { currentUser, route } from '@/app/api/_lib/handler';

export const POST = (request: Request, ctx: { params: Promise<{ orgId: string }> }) =>
  route(async () => {
    const { orgId } = await ctx.params;
    const actor = currentUser(request);
    const actorRole = await requireMember(orgId, actor, 'admin');

    const { userId, role } = (await request.json()) as { userId: string; role: Role };
    if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    if (!canAssignRole(actorRole, null, role)) throw new HttpError(403, 'forbidden');

    await sql`
      INSERT INTO memberships (org_id, user_id, role)
      VALUES (${orgId}, ${userId}, ${role})
      ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role
    `;
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'membership.created',
      subjectType: 'user', subjectId: userId, metadata: { role },
    });
    return NextResponse.json({ orgId, userId, role }, { status: 201 });
  });
