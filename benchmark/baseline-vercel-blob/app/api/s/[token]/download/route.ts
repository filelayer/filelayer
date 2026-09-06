import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { appendAudit } from '@/lib/audit';
import { getBlobStream } from '@/lib/blob';
import { hashToken, verifyPassword, shareState } from '@/lib/shares';
import { route } from '@/app/api/_lib/handler';

/**
 * Anonymous share download — the crux of the benchmark.
 *
 * On this platform the correct implementation is also the natural one. A
 * private blob has no publicly fetchable URL at all, so the only way to serve
 * it is through this Function, which means the revocation check below runs
 * before every byte. "Revocation takes effect immediately even for links
 * already issued" is satisfied by construction, not by discipline.
 *
 * THE TRAP: `issueSignedToken` + `presignUrl` exist, and using them here to
 * avoid the streaming cost would be an obvious-looking optimisation. It would
 * silently break the requirement. A Vercel signed URL is a bearer token
 * verified at the CDN with no callback into your application; nothing you can
 * do in Postgres invalidates one. `validUntil` is capped at 7 days, and the
 * only lever comparable to AWS's "deactivate the signing credential" is
 * rotating the store's read-write token, which breaks the whole application.
 * So: signed URLs are deliberately NOT used on this path. See REPORT.md §9.
 */
export const POST = (request: Request, ctx: { params: Promise<{ token: string }> }) =>
  route(async () => {
    const { token } = await ctx.params;
    const rows = await sql`
      SELECT s.*, d.name AS doc_name, d.content_type AS doc_content_type,
             d.blob_pathname, d.status AS doc_status
        FROM shares s JOIN documents d ON d.id = s.document_id
       WHERE s.token_hash = ${hashToken(token)}
    `;
    const share = rows[0];
    if (!share) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    if (share.password_hash) {
      const body = (await request.json().catch(() => ({}))) as { password?: string };
      const ok =
        typeof body.password === 'string' &&
        (await verifyPassword(body.password, share.password_hash, share.password_salt));
      if (!ok) {
        await appendAudit({
          orgId: share.org_id,
          actorKind: 'anonymous',
          actorId: null,
          action: 'share.password_failed',
          subjectType: 'share',
          subjectId: share.id,
          metadata: { ip: request.headers.get('x-forwarded-for') },
        });
        return NextResponse.json({ error: 'bad_password' }, { status: 401 });
      }
    }

    // One atomic statement re-checks revocation, expiry and the cap and
    // consumes a unit. Serverless concurrency makes read-then-write
    // catastrophically wrong here: N cold starts all pass a maxDownloads=1
    // check simultaneously.
    const consumed = await sql`
      UPDATE shares SET download_count = download_count + 1
       WHERE id = ${share.id}
         AND revoked_at IS NULL
         AND expires_at > now()
         AND (max_downloads IS NULL OR download_count < max_downloads)
      RETURNING download_count
    `;
    if (consumed.length === 0) {
      return NextResponse.json({ error: shareState(share) }, { status: 410 });
    }
    if (share.doc_status !== 'ready') {
      return NextResponse.json({ error: 'document_unavailable' }, { status: 410 });
    }

    const result = await getBlobStream(share.blob_pathname, { useCache: true });
    if (result.status !== 200) {
      return NextResponse.json({ error: 'blob_missing' }, { status: 502 });
    }

    await appendAudit({
      orgId: share.org_id,
      actorKind: 'anonymous',
      actorId: null,
      action: 'share.downloaded',
      subjectType: 'share',
      subjectId: share.id,
      metadata: {
        documentId: share.document_id,
        downloadCount: consumed[0].download_count,
        ip: request.headers.get('x-forwarded-for'),
      },
    });

    return new NextResponse(result.body!.stream, {
      headers: {
        'Content-Type': share.doc_content_type,
        'Content-Disposition': `attachment; filename="${String(share.doc_name).replace(/"/g, '')}"`,
        'X-Content-Type-Options': 'nosniff',
        // no-store, not no-cache: a revoked link must not be replayable from
        // the recipient's own disk cache.
        'Cache-Control': 'private, no-store',
      },
    });
  });
