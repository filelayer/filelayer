import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireMember } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { pathnameFor } from '@/lib/blob';
import { currentUser, route, newId } from '@/app/api/_lib/handler';

/**
 * Reserve a document slot BEFORE the client is allowed to upload.
 *
 * This exists because of a specific Vercel Blob hazard: in the client-upload
 * flow the BROWSER chooses the pathname and passes it to your route handler.
 * If the server signs whatever pathname it is handed, a user in org B can
 * upload straight into `orgs/<orgA>/...`. Reserving the pathname here means
 * the upload route only has to check "does this exact pathname correspond to a
 * pending row this user created in this org", which is a much harder check to
 * get wrong than string-prefix validation.
 */
export const POST = (request: Request, ctx: { params: Promise<{ orgId: string }> }) =>
  route(async () => {
    const { orgId } = await ctx.params;
    const actor = currentUser(request);
    await requireMember(orgId, actor, 'member');

    const { name, contentType } = (await request.json()) as {
      name?: string;
      contentType?: string;
    };
    if (!name || !contentType) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
    }

    const docId = newId('doc');
    const pathname = pathnameFor(orgId, docId);
    await sql`
      INSERT INTO documents (id, org_id, uploader_id, name, content_type, blob_pathname, status)
      VALUES (${docId}, ${orgId}, ${actor}, ${name}, ${contentType}, ${pathname}, 'pending')
    `;

    return NextResponse.json(
      { documentId: docId, pathname, uploadUrl: `/api/orgs/${orgId}/upload` },
      { status: 201 }
    );
  });

export const GET = (request: Request, ctx: { params: Promise<{ orgId: string }> }) =>
  route(async () => {
    const { orgId } = await ctx.params;
    const actor = currentUser(request);
    await requireMember(orgId, actor, 'viewer');
    const documents = await sql`
      SELECT id, name, content_type, size_bytes, uploader_id, created_at
        FROM documents WHERE org_id = ${orgId} AND status = 'ready'
       ORDER BY created_at DESC
    `;
    return { documents };
  });
