/**
 * UPLOAD AND LIST. `POST /api/files` and `GET /api/files`.
 *
 * The bytes go through your server here, which is the default and the simple
 * one: you see them, so the size is bounded by counting and the type is
 * decided from the content rather than from what the client declared. For
 * large files, `createUpload()` signs a PUT straight to the bucket instead --
 * see the private-file-uploads guide, including the part about why a presigned
 * PUT does not constrain the body.
 */

import { getFilelayer, currentUser } from '../../../lib/filelayer.ts';

const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const form = await req.formData();
  const file = form.get('file');
  const org = String(form.get('org') ?? '');
  if (!(file instanceof File)) return json({ error: 'no file in the form' }, 400);
  if (!org) return json({ error: 'no org' }, 400);

  // BOUNDED BEFORE IT IS READ. `file.size` is known without touching the body,
  // so an oversized upload is refused rather than buffered and then refused.
  if (file.size > MAX_BYTES) return json({ error: 'payload_too_large', limit: MAX_BYTES }, 413);

  const fl = await getFilelayer();
  try {
    // No content type is passed on purpose: Filelayer sniffs it from the magic
    // bytes. `file.type` is whatever the browser said, and a declared
    // `text/html` served back inline is stored XSS against your own origin.
    const { id } = await fl.files.put(new Uint8Array(await file.arrayBuffer()), {
      org,
      owner: user,
      name: file.name,
    });
    // `publicUrl` is the path the catch-all route above serves.
    return json({ id, url: `/f/${id}` }, 201);
  } catch (err) {
    return fromFilelayerError(err);
  }
}

export async function GET(req: Request): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const org = new URL(req.url).searchParams.get('org');
  if (!org) return json({ error: 'no org' }, 400);

  const fl = await getFilelayer();
  try {
    // Listing is authorized, not filtered afterwards: this returns the files
    // this user may see, which is not the same as "the org's files".
    const page = await fl.files.list({ as: user, org });
    return json(page);
  } catch (err) {
    return fromFilelayerError(err);
  }
}

export const dynamic = 'force-dynamic';

// -----------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A `FilelayerError` carries a stable `code` and the HTTP `status` it should
 * produce. It also carries `reason`, which is the internal detail and is
 * DELIBERATELY NOT SERIALIZED here: `not_found` and "you are not a member of
 * that org" are the same answer to a caller who should not learn the
 * difference.
 */
function fromFilelayerError(err: unknown): Response {
  const e = err as { status?: number; code?: string };
  if (typeof e?.status === 'number' && typeof e.code === 'string') {
    return json({ error: e.code }, e.status);
  }
  throw err;
}
