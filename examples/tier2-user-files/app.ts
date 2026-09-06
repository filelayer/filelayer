/**
 * TIER 2 -- user-owned private files.
 *
 * One concept added: an owner. Everything else is unchanged from tier 1, and
 * nothing from tiers 3-5 has to be understood.
 *
 * The property this buys, and it is the one people get wrong by hand: a file
 * uploaded with `{ owner: 'alice' }` is readable through Filelayer by alice, by
 * her org's admins and owners, and by nobody else. Not by bob, not by an
 * anonymous caller holding the id, and not by someone who learns the storage key
 * -- the key is not an input to the decision, given a private bucket. There is
 * no `WHERE user_id = ?` in this file, because there is no query in this file.
 * There is also no RLS policy underneath it: a client that queries the `file`
 * table directly bypasses all of the above.
 *
 * Run: npm --prefix packages/core run example:tier2
 */

import { createServer } from 'node:http';
import { Filelayer, FilelayerError } from '../../packages/core/src/index.ts';

export async function tier2(fl: Filelayer) {
  const doc = new TextEncoder().encode('alice private notes');
  const { id } = await fl.files.put(doc, { owner: 'alice', name: 'notes.txt' });
  return { id };
}

/**
 * A minimal app around it.
 *
 * The only Filelayer-shaped line in the route is `files.get(id, { as })`. The
 * 404 is decided by the library; there is no conditional here whose outcome
 * depends on who the caller is.
 */
export function tier2App(fl: Filelayer) {
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname.split('/').filter(Boolean);
    const as = req.headers['x-user-id'] as string | undefined;
    if (path[0] === 'files' && path[1]) {
      try {
        const f = await fl.files.get(path[1], as ? { as } : {});
        // `f.headers`, not a hand-written content-type: the library decides how
        // these bytes are allowed to reach a browser.
        res.writeHead(200, f.headers);
        return res.end(f.body);
      } catch (e) {
        return res.writeHead(e instanceof FilelayerError ? e.status : 500).end();
      }
    }
    return res.writeHead(404).end();
  });
}

// --- boot --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3001' });
  const { id } = await tier2(fl);
  tier2App(fl).listen(3001, () =>
    console.log(`try: curl -H 'x-user-id: alice' localhost:3001/files/${id}`),
  );
}
