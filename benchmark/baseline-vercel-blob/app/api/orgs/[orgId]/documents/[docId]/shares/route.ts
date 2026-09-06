import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';
import { requireMember, loadDoc, canCreateShare, HttpError } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { mintShareToken, hashPassword } from '@/lib/shares';
import { currentUser, route, newId } from '@/app/api/_lib/handler';

export const POST = (
  request: Request,
  ctx: { params: Promise<{ orgId: string; docId: string }> }
) =>
  route(async () => {
    const { orgId, docId } = await ctx.params;
    const actor = currentUser(request);
    const role = await requireMember(orgId, actor, 'viewer');
    if (!canCreateShare(role)) throw new HttpError(403, 'forbidden');
    await loadDoc(orgId, docId, ['ready']);

    const { expiresInSeconds, password, maxDownloads } = (await request.json()) as {
      expiresInSeconds?: number;
      password?: string;
      maxDownloads?: number | null;
    };
    if (!Number.isInteger(expiresInSeconds) || (expiresInSeconds as number) <= 0) {
      throw new HttpError(400, 'invalid_expiry');
    }
    if (
      maxDownloads !== undefined && maxDownloads !== null &&
      (!Number.isInteger(maxDownloads) || maxDownloads <= 0)
    ) {
      throw new HttpError(400, 'invalid_max_downloads');
    }

    const { token, tokenHash } = mintShareToken();
    const pw = password ? await hashPassword(password) : null;
    const shareId = newId('shr');
    const expiresAt = new Date(Date.now() + (expiresInSeconds as number) * 1000);

    await sql`
      INSERT INTO shares (id, org_id, document_id, created_by, token_hash,
                          password_hash, password_salt, expires_at, max_downloads)
      VALUES (${shareId}, ${orgId}, ${docId}, ${actor}, ${tokenHash},
              ${pw?.hash ?? null}, ${pw?.salt ?? null}, ${expiresAt.toISOString()},
              ${maxDownloads ?? null})
    `;
    await appendAudit({
      orgId, actorKind: 'user', actorId: actor, action: 'share.created',
      subjectType: 'share', subjectId: shareId,
      metadata: {
        documentId: docId,
        expiresAt: expiresAt.toISOString(),
        hasPassword: Boolean(password),
        maxDownloads: maxDownloads ?? null,
      },
    });

    // The URL points at OUR function, never at a blob URL. That is what makes
    // it revocable.
    return NextResponse.json(
      {
        shareId,
        url: `${process.env.PUBLIC_BASE_URL}/s/${token}`,
        expiresAt: expiresAt.toISOString(),
      },
      { status: 201 }
    );
  });
