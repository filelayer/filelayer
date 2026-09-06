import { NextResponse } from 'next/server';
import { requireMember, loadDoc } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { getBlobStream } from '@/lib/blob';
import { currentUser, route } from '@/app/api/_lib/handler';

/**
 * In-app download for an org member.
 *
 * This is the pattern Vercel documents for private storage: authenticate,
 * `get()`, stream. Note what it means structurally — on this platform the
 * DEFAULT, IDIOMATIC delivery path already runs your authorization check on
 * every single byte-serving request. There is no equivalent of "hand the user
 * a presigned URL and hope", because private blob URLs simply do not work
 * without a credential. That is a real architectural advantage over raw S3 and
 * it is the single best thing about this baseline. See REPORT.md §9.
 *
 * Two doc-mandated details that are easy to miss:
 *  1. "avoid relying on middleware for auth... always verify auth directly in
 *     your route handler, right next to the get() call." Auth in Next.js
 *     middleware is the obvious place to put it and is explicitly wrong here.
 *  2. If you set no Cache-Control, Vercel sends
 *     `public, max-age=0, must-revalidate`. The word `public` on a response
 *     carrying a private document is not what you want in front of any
 *     intermediary. `private, no-store` is set explicitly below.
 */
export const GET = (
  request: Request,
  ctx: { params: Promise<{ orgId: string; docId: string }> }
) =>
  route(async () => {
    const { orgId, docId } = await ctx.params;
    const actor = currentUser(request);
    await requireMember(orgId, actor, 'viewer');
    const doc = await loadDoc(orgId, docId, ['ready']);

    const result = await getBlobStream(doc.blob_pathname, {
      ifNoneMatch: request.headers.get('if-none-match') ?? undefined,
      // Document bytes are immutable once `ready`, so the CDN cache is safe
      // and saves Fast Origin Transfer on every read.
      useCache: true,
    });

    if (result.status === 404) {
      // The row says ready, the store says gone. Divergence between two
      // systems that have no shared transaction. See REPORT.md §7.
      return NextResponse.json({ error: 'blob_missing' }, { status: 502 });
    }

    await appendAudit({
      orgId,
      actorKind: 'user',
      actorId: actor,
      action: 'document.downloaded',
      subjectType: 'document',
      subjectId: docId,
      metadata: { notModified: result.status === 304 },
    });

    if (result.status === 304) {
      return new NextResponse(null, {
        status: 304,
        headers: { ETag: result.etag!, 'Cache-Control': 'private, no-store' },
      });
    }

    return new NextResponse(result.body!.stream, {
      headers: {
        'Content-Type': result.body!.contentType,
        'Content-Disposition': `attachment; filename="${doc.name.replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        ETag: result.body!.etag,
        'Cache-Control': 'private, no-store',
      },
    });
  });
