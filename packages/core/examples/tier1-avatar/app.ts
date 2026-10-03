/**
 * TIER 1 -- a public avatar.
 *
 * The entire integration. No org, no user, no role and no grant appears in the
 * developer's mental model: three statements below the imports.
 *
 * What you get that a public bucket does not give you:
 *   - `unpublish()` works on URLs already printed, indexed and shared
 *   - the public read is in the audit log
 *   - user-uploaded HTML/SVG is served inert (nosniff + sandbox CSP + attachment)
 *
 * What you do NOT get, stated up front: no CDN, no range requests, no image
 * transforms, no direct-to-storage browser upload, and a byte path that costs
 * us money on public traffic. See ARCHITECTURE-PROGRESSIVE.md, "Where Filelayer
 * is not worth using today".
 *
 * Run: npm --prefix packages/core run example:tier1
 */

import { createServer } from 'node:http';
import { Filelayer, fileDownloadRoute } from '../../packages/core/src/index.ts';

export async function tier1(avatar: Uint8Array) {
  const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
  const { id, url } = await fl.files.put(avatar, { public: true, name: 'avatar.png' });
  return { fl, id, url: url! };
}

/**
 * The serving half.
 *
 * `principal: () => ({ actorId: null })` is the whole configuration: every
 * request to this route is an anonymous caller, so a file is reachable through
 * this route only if it carries a live anonymous grant. There is no other access
 * rule for you to write here. The one thing still on you is outside this file:
 * the object bucket must be private.
 */
export function tier1Server(fl: Filelayer) {
  const route = fileDownloadRoute(fl, {
    prefix: '/f',
    disposition: 'inline', // an avatar should render, not download
    principal: () => ({ actorId: null }),
  });
  return createServer((req, res) => {
    void route(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
}

// --- boot --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const { fl, url } = await tier1(png);
  tier1Server(fl).listen(3000, () => console.log(`avatar at ${url}`));
}
