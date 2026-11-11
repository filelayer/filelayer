/**
 * EVERY BYTE FILELAYER SERVES, IN ONE FILE.
 *
 * `app/[...filelayer]/route.ts` catches `/f/<id>` (an authorized read) and
 * `/d/<secret>` (a share link). `deliveryFetch` answers both and returns
 * `null` for anything else, so your own routes are untouched -- a catch-all
 * that swallowed them would be worse than no catch-all.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `deliveryHandler`
 * ---------------------------------------------------------------------------
 *
 * The `node:http` handler, `deliveryHandler`, takes `(req, res)` with a Node
 * `ServerResponse`. An App Router route handler is `(Request) => Response`.
 * They are not the same shape and the node one cannot be mounted here --
 * which is the single thing a developer coming from the README most needs to
 * be told, and until `0.18.0` nothing said it.
 *
 * `deliveryFetch` is the same two routes with the same rules: `Range` parsed,
 * `206` derived from `Content-Range`, `416` carrying the object's size, a
 * credential in the query string refused, a malformed path segment answered
 * rather than thrown, and the `401` that tells a client to retry a password
 * link as a POST. Hand-writing those is thirty lines with five ways to be
 * subtly wrong.
 */

import { deliveryFetch } from '@filelayer/core';
import { getFilelayer, currentUser } from '../../lib/filelayer';

async function handler(req: Request): Promise<Response> {
  const fl = await getFilelayer();

  const serve = deliveryFetch(fl, {
    principal: async (r) => ({ as: await currentUser(r) }),
    // THE CLIENT ADDRESS IS YOURS TO DECIDE. A `Request` has no socket, so the
    // only candidate is a header, and a header is written by whoever spoke
    // last. Filelayer will not read one on its own, because on a directly
    // reachable deployment that is the client choosing what the audit log says
    // about them. Uncomment the line that matches YOUR edge, or record no
    // address, which is the honest default.
    //
    // clientIp: (r) => r.headers.get('x-forwarded-for')?.split(',')[0]?.trim(),
    userAgent: (r) => r.headers.get('user-agent') ?? undefined,
  });

  return (await serve(req)) ?? new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}

// GET is the read. POST is a password-protected share link, which must carry
// the password in a body -- there is no supported way to put it in the URL.
// HEAD answers the headers of the GET, so a cache or a link checker is told
// the same thing a browser would be.
export const GET = handler;
export const POST = handler;
export const HEAD = handler;

/**
 * NOTHING HERE IS CACHED, AND NOTHING NEEDS TO SAY SO. Authorization is per
 * request and the answer changes the moment a grant is revoked. Route handlers
 * are not cached unless you opt in, and every handler in this file reads the
 * request (its URL, its headers) and queries the database, which keeps it out
 * of any prerender, with or without `cacheComponents`. Until 0.35.3 this file
 * also exported `dynamic = 'force-dynamic'`; Next 16 with `cacheComponents`
 * (the default in a new create-next-app project) refuses to build with it.
 * Do not add `'use cache'` to anything that decides or serves a read.
 */
