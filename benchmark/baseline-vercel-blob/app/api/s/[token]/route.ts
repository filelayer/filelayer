import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { hashToken, shareState } from '@/lib/shares';
import { route } from '@/app/api/_lib/handler';

/** Share landing metadata. Deliberately leaks nothing but the file name. */
export const GET = (_request: Request, ctx: { params: Promise<{ token: string }> }) =>
  route(async () => {
    const { token } = await ctx.params;
    const rows = await sql`
      SELECT s.*, d.name AS doc_name, d.size_bytes, d.status AS doc_status
        FROM shares s JOIN documents d ON d.id = s.document_id
       WHERE s.token_hash = ${hashToken(token)}
    `;
    const share = rows[0];
    if (!share) return NextResponse.json({ error: 'not_found' }, { status: 404 });

    const state = shareState(share);
    if (state !== 'active') return NextResponse.json({ error: state }, { status: 410 });

    return {
      name: share.doc_name,
      size: share.size_bytes === null ? null : Number(share.size_bytes),
      requiresPassword: Boolean(share.password_hash),
      expiresAt: share.expires_at,
      downloadsRemaining:
        share.max_downloads === null ? null : share.max_downloads - share.download_count,
    };
  });
