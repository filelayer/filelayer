import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireMember, loadDoc, canManageDocument, HttpError } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { deleteBlob } from '@/lib/blob';
import { currentUser, route } from '@/app/api/_lib/handler';

export const DELETE = (
  request: Request,
  ctx: { params: Promise<{ orgId: string; docId: string }> }
) =>
  route(async () => {
    const { orgId, docId } = await ctx.params;
    const actor = currentUser(request);
    const role = await requireMember(orgId, actor, 'member');
    const doc = await loadDoc(orgId, docId, ['ready', 'pending']);
    if (!canManageDocument(role, doc, actor)) throw new HttpError(403, 'forbidden');

    // Database first, blob second. If the blob delete fails we have an orphan
    // (costs money, reaped by cron). If we deleted the blob first and the
    // database write failed we would have a document the app still lists and
    // cannot serve, which is worse.
    await sql`
      UPDATE documents SET status = 'deleted', deleted_at = now() WHERE id = ${docId}
    `;
    await sql`
      UPDATE shares SET revoked_at = now()
       WHERE document_id = ${docId} AND revoked_at IS NULL
    `;
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'document.deleted',
      subjectType: 'document', subjectId: docId, metadata: {},
    });

    // Documented: deletion may take up to a minute to clear the CDN cache.
    // Our authorization check runs in front of every read, so this does not
    // leak — but "the bytes are gone" is not true for up to 60 seconds, which
    // matters if you have told a customer otherwise.
    await deleteBlob(doc.blob_pathname).catch(() => {});

    return new NextResponse(null, { status: 204 });
  });
