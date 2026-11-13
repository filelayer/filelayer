/**
 * ONE INSTANCE, SHARED BY EVERY ROUTE.
 *
 * Next.js module-scope state survives between requests in a warm server, and
 * that is what you want here: a `Filelayer` holds a connection pool, and
 * constructing one per request exhausts Postgres under any real load.
 *
 * `quickstart()` is the throwaway: Postgres in-process, bytes in memory, gone
 * when the process exits. It is here so this example runs with nothing
 * installed and nothing provisioned. For a real deployment, replace the body
 * of `getFilelayer()` with the three lines in QUICKSTART §7 -- your own
 * `pg.Pool`, `S3Storage`, and the schema applied once -- and nothing else in
 * this example changes.
 */

import { Filelayer } from '@filelayer/core';

let instance: Promise<Filelayer> | null = null;

export function getFilelayer(): Promise<Filelayer> {
  // Assigned before awaiting, so two requests arriving together share one
  // instance rather than racing to build two. Awaiting first and then
  // assigning is the version of this that looks correct and is not.
  instance ??= (async () => {
    const fl = await Filelayer.quickstart({ baseUrl: process.env.BASE_URL ?? 'http://localhost:3000' });
    // ORGS ARE CREATED ON PURPOSE. In your app this call belongs where a
    // workspace is created (sign-up, "new team"), once, with its first owner.
    // An upload never creates an org: the routes take the org from the session
    // and Filelayer refuses a caller who is not a member of it. The demo has
    // one workspace, created here because there is no sign-up to create it.
    await fl.orgs.create('acme', { name: 'Acme', owner: 'alice' });
    return fl;
  })();
  return instance;
}

/**
 * WHO IS ASKING. The one function you must replace.
 *
 * Return the user id from YOUR session -- NextAuth, Clerk, a cookie you signed,
 * whatever you use. The routes hand it to Filelayer as `{ as: userId }`, which
 * is your own id space; Filelayer resolves it and refuses an id it has never
 * seen rather than quietly treating the request as anonymous.
 *
 * Returning `null` means an anonymous caller, and anonymous is not a bypass: it
 * can only reach a file that carries an explicit anonymous grant.
 *
 * This example reads a header so it can be driven without a browser. DO NOT
 * SHIP THIS: a header any client can set is not authentication.
 */
export async function currentUser(req: Request): Promise<string | null> {
  return req.headers.get('x-demo-user');
}

/**
 * WHICH ORG. Also from your session, never from the request.
 *
 * The organization the signed-in user is working in: Clerk's active
 * organization, a claim in your JWT, a column on your user row. A route that
 * reads the org from the form or the query string lets the client choose which
 * tenant it writes into, and that choice is the first thing an attacker
 * changes.
 *
 * The demo has one workspace, so every signed-in user is working in it, and
 * Filelayer still refuses one who is not a member.
 */
export async function currentOrg(req: Request): Promise<string | null> {
  return (await currentUser(req)) ? 'acme' : null;
}
