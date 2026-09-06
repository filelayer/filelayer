import { list } from '@vercel/blob';
import { sql } from '@/lib/db';
import { deleteBlob } from '@/lib/blob';
import { route } from '@/app/api/_lib/handler';

/**
 * Lifecycle reaper. Wired up in `vercel.json` as a Cron Job.
 *
 * There is no equivalent of an S3 lifecycle rule in Vercel Blob: no expiry, no
 * transition to colder storage, no automatic abort of incomplete multipart
 * uploads. Every byte you ever wrote stays and is billed at $0.023/GB-month
 * until you personally delete it. So all three of these sweeps are code you
 * must write and keep working.
 *
 * SECURITY NOTE: Vercel Cron requests must be authenticated. Vercel sends
 * `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set. Without the
 * check below this is a public endpoint that deletes customer data.
 */
export const GET = (request: Request) =>
  route(async () => {
    if (request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 1. Reserved document slots that were never uploaded to.
    const stale = await sql`
      SELECT id, blob_pathname FROM documents
       WHERE status = 'pending' AND created_at < now() - interval '1 hour'
    `;
    for (const doc of stale) {
      await deleteBlob(doc.blob_pathname).catch(() => {});
      await sql`DELETE FROM documents WHERE id = ${doc.id}`;
    }

    // 2. Blobs with no row at all — an upload that landed while the database
    //    write failed, or a row deleted without its blob. Finding these needs a
    //    full paginated list() of the entire store reconciled against
    //    Postgres. Every list() page is a billable Advanced Operation, and
    //    Advanced Operations are rate limited (Pro: 4,500/min), so on a store
    //    with millions of blobs this sweep is itself a capacity problem.
    let cursor: string | undefined;
    let orphanedBlobs = 0;
    do {
      const page = await list({ cursor, limit: 1000, prefix: 'orgs/' });
      const pathnames = page.blobs.map((b) => b.pathname);
      const known = await sql`
        SELECT blob_pathname FROM documents
         WHERE blob_pathname = ANY(${pathnames}) AND status <> 'deleted'
      `;
      const knownSet = new Set(known.map((r: { blob_pathname: string }) => r.blob_pathname));
      for (const pathname of pathnames) {
        if (!knownSet.has(pathname)) {
          await deleteBlob(pathname);
          orphanedBlobs++;
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);

    return { staleSlotsReaped: stale.length, orphanedBlobsReaped: orphanedBlobs };
  });
