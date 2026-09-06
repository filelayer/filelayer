import { sql } from '@/lib/db';
import { requireMember, loadDoc, HttpError } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { blobExists } from '@/lib/blob';
import { currentUser, route } from '@/app/api/_lib/handler';

/**
 * Fallback confirmation path.
 *
 * `onUploadCompleted` is a webhook. It does not fire on localhost (documented),
 * it can be delayed, it can be retried, and it can fail. If a document is only
 * ever marked `ready` by the webhook, then in local development nothing ever
 * works and in production a dropped webhook silently loses a customer's
 * upload. So the client also calls this after `uploadPresigned` resolves, and
 * we ask the store directly.
 *
 * The cost of this belt-and-braces is that the transition to `ready` now has
 * two writers, which is why the UPDATE is guarded on `status = 'pending'` and
 * the audit append is conditional on it having actually changed a row.
 */
export const POST = (
  request: Request,
  ctx: { params: Promise<{ orgId: string; docId: string }> }
) =>
  route(async () => {
    const { orgId, docId } = await ctx.params;
    const actor = currentUser(request);
    await requireMember(orgId, actor, 'member');

    const doc = await loadDoc(orgId, docId, ['pending', 'ready']);
    if (doc.status === 'ready') return { documentId: docId, status: 'ready' };
    if (doc.uploader_id !== actor) throw new HttpError(403, 'forbidden');

    const meta = await blobExists(doc.blob_pathname);
    if (!meta.exists) throw new HttpError(409, 'object_missing');

    const rows = await sql`
      UPDATE documents SET status = 'ready', size_bytes = ${meta.size ?? null},
                           completed_at = now()
       WHERE id = ${docId} AND status = 'pending'
      RETURNING id
    `;
    if (rows.length > 0) {
      await appendAudit({
        orgId,
        actorKind: 'user',
        actorId: actor,
        action: 'document.uploaded',
        subjectType: 'document',
        subjectId: docId,
        metadata: { name: doc.name, size: meta.size ?? null, via: 'client_confirm' },
      });
    }
    return { documentId: docId, status: 'ready', size: meta.size ?? null };
  });
