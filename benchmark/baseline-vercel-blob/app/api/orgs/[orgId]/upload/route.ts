import { NextResponse } from 'next/server';
import { issueSignedToken } from '@vercel/blob';
import { handleUploadPresigned, type HandleUploadPresignedBody } from '@vercel/blob/client';
import { sql } from '@/lib/db';
import { requireMember, HttpError } from '@/lib/authz';
import { appendAudit } from '@/lib/audit';
import { blobExists } from '@/lib/blob';
import { currentUser, route } from '@/app/api/_lib/handler';

/**
 * Client-upload authorization route.
 * Doc: https://vercel.com/docs/vercel-blob/vercel-signed-urls#handleuploadpresigned
 *
 * Vercel's own docs put the warning in bold: "You must authenticate and
 * authorize the user inside this function — otherwise your upload route allows
 * anonymous uploads to your Blob store." That warning is doing an enormous
 * amount of work. There is no default-deny here: an empty `getSignedToken`
 * that just returns a token is a valid, working, anonymous-write endpoint.
 *
 * THE SHARPEST EDGE IN THIS ENTIRE BASELINE:
 * `issueSignedToken()` called with no `pathname` "Defaults to a whole-store
 * wildcard" (doc, Signed URLs page). With default `operations: ['get']` and a
 * default validity of one hour, a single careless call mints a credential that
 * can read EVERY blob in the store — that is, every document belonging to every
 * organization. Nothing in the type system, the linter or the runtime objects.
 * The `pathname` argument below is therefore not an optimisation; it is the
 * tenancy boundary.
 */
export const POST = (request: Request, ctx: { params: Promise<{ orgId: string }> }) =>
  route(async () => {
    const { orgId } = await ctx.params;
    const body = (await request.json()) as HandleUploadPresignedBody;

    const jsonResponse = await handleUploadPresigned({
      body,
      request,
      getSignedToken: async (pathname) => {
        const actor = currentUser(request);
        await requireMember(orgId, actor, 'member');

        // The browser chose `pathname`. Bind it to a slot this user actually
        // reserved in THIS org. Anything else is rejected outright — no
        // prefix-matching, no normalisation, no "starts with orgs/<id>/".
        const rows = await sql`
          SELECT id, content_type FROM documents
           WHERE blob_pathname = ${pathname}
             AND org_id = ${orgId}
             AND uploader_id = ${actor}
             AND status = 'pending'
        `;
        if (rows.length === 0) throw new HttpError(403, 'unknown_pathname');

        return {
          token: await issueSignedToken({
            pathname, // NEVER omit. See the block comment above.
            operations: ['put'],
            allowedContentTypes: [rows[0].content_type],
            maximumSizeInBytes: 100 * 1024 * 1024,
            validUntil: Date.now() + 10 * 60 * 1000,
          }),
          urlOptions: {
            allowedContentTypes: [rows[0].content_type],
            maximumSizeInBytes: 100 * 1024 * 1024,
            validUntil: Date.now() + 10 * 60 * 1000,
            // Must be false: the pathname is the join key back to Postgres.
            // With a random suffix the uploaded blob has a pathname the
            // database has never seen and the document is orphaned on arrival.
            addRandomSuffix: false,
            allowOverwrite: false,
          },
        };
      },

      /**
       * Fires as a signed webhook FROM Vercel Blob TO this route.
       *
       * Documented limitation: "This callback won't fire on localhost." The
       * happy path therefore cannot be exercised in local development at all,
       * which is why the `/complete` fallback below exists and why it is the
       * fallback that will actually be load-bearing in practice.
       */
      onUploadCompleted: async ({ blob }) => {
        const rows = await sql`
          UPDATE documents
             SET status = 'ready', blob_url = ${blob.url}, etag = ${blob.etag},
                 completed_at = now()
           WHERE blob_pathname = ${blob.pathname} AND status = 'pending'
          RETURNING id, org_id, uploader_id, name
        `;
        if (rows.length === 0) return; // duplicate delivery; webhook retries.
        await appendAudit({
          orgId: rows[0].org_id,
          actorKind: 'user',
          actorId: rows[0].uploader_id,
          action: 'document.uploaded',
          subjectType: 'document',
          subjectId: rows[0].id,
          metadata: { name: rows[0].name, via: 'client_upload_webhook' },
        });
      },
    });

    return NextResponse.json(jsonResponse);
  });
