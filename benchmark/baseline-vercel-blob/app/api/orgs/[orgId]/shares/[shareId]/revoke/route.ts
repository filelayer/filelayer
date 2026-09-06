import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireMember, canRevokeShare, HttpError } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { currentUser, route } from '@/app/api/_lib/handler';

/**
 * Immediate revocation. One UPDATE. It takes effect on the very next request
 * because every share download goes through our Function.
 *
 * There is no blob-store-side action to take, no cache to purge, no signed
 * token to hunt down — because we never handed the recipient anything other
 * than an opaque token that only means something to us. This is the whole
 * argument for proxied delivery, and on a private Vercel Blob store it is the
 * only option anyway.
 */
export const POST = (
  request: Request,
  ctx: { params: Promise<{ orgId: string; shareId: string }> }
) =>
  route(async () => {
    const { orgId, shareId } = await ctx.params;
    const actor = currentUser(request);
    const role = await requireMember(orgId, actor, 'viewer');

    const rows = await sql`
      SELECT * FROM shares WHERE id = ${shareId} AND org_id = ${orgId}
    `;
    const share = rows[0];
    if (!share) throw new HttpError(404, 'not_found');
    if (!canRevokeShare(role, share, actor)) throw new HttpError(403, 'forbidden');

    await sql`
      UPDATE shares SET revoked_at = now()
       WHERE id = ${shareId} AND revoked_at IS NULL
    `;
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'share.revoked',
      subjectType: 'share', subjectId: shareId,
      metadata: { documentId: share.document_id },
    });
    return new NextResponse(null, { status: 204 });
  });
