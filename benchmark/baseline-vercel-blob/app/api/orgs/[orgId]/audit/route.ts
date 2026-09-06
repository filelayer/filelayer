import { sql } from '@/lib/db';
import { requireMember, canReadAudit, HttpError } from '@/lib/authz';
import { verifyChain } from '@/lib/audit';
import { currentUser, route } from '@/app/api/_lib/handler';

export const GET = (request: Request, ctx: { params: Promise<{ orgId: string }> }) =>
  route(async () => {
    const { orgId } = await ctx.params;
    const actor = currentUser(request);
    const role = await requireMember(orgId, actor, 'viewer');
    if (!canReadAudit(role)) throw new HttpError(403, 'forbidden');

    if (new URL(request.url).searchParams.get('verify') === '1') {
      return verifyChain(orgId);
    }

    const entries = await sql`
      SELECT org_seq, actor_kind, actor_id, action, subject_type, subject_id,
             metadata, at, hash
        FROM audit_log WHERE org_id = ${orgId} ORDER BY org_seq ASC LIMIT 500
    `;
    return { entries };
  });
