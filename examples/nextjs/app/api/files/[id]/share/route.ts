/**
 * SHARING. `POST /api/files/:id/share` and `DELETE /api/files/:id/share`.
 *
 * Two different operations that both get called "sharing" and are not the
 * same thing:
 *
 *   * a LINK, for someone who has no account with you. The secret is in the
 *     URL and is returned exactly once; only its SHA-256 is stored.
 *   * a NAMED USER, for someone who does. No secret exists, so there is
 *     nothing to leak and nothing to forward.
 *
 * Revoking them differs too, and it is the mistake worth avoiding: `revoke`
 * takes a GRANT id and removes one link. To remove a person's access you want
 * `unshare`, because `shares.create` is not idempotent -- two calls make two
 * grants, and revoking one of them leaves the other.
 */

import { getFilelayer, currentUser } from '../../../../../lib/filelayer.ts';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    withUser?: string;
    expiresIn?: number;
    maxDownloads?: number;
    password?: string;
  };

  const fl = await getFilelayer();
  try {
    if (body.withUser) {
      const grant = await fl.shares.create(id, { as: user, withUser: body.withUser });
      return json({ grantId: grant.grantId }, 201);
    }
    const link = await fl.shares.create(id, {
      as: user,
      ...(body.expiresIn ? { expiresIn: body.expiresIn } : {}),
      ...(body.maxDownloads ? { maxDownloads: body.maxDownloads } : {}),
      ...(body.password ? { password: body.password } : {}),
    });
    // `secret` is returned once and never again. If you do not hand it to the
    // user now, it is gone -- which is the property that makes the stored hash
    // worth anything.
    return json({ grantId: link.grantId, url: link.url, expiresAt: link.expiresAt }, 201);
  } catch (err) {
    return fromFilelayerError(err);
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await currentUser(req);
  if (!user) return json({ error: 'unauthenticated' }, 401);

  const { id } = await params;
  const url = new URL(req.url);
  const target = url.searchParams.get('user');
  const grantId = url.searchParams.get('grant');

  const fl = await getFilelayer();
  try {
    if (target) {
      // Every live grant this user holds on this file, not one of them.
      const { revoked } = await fl.shares.unshare(id, { as: user, user: target });
      return json({ revoked });
    }
    if (grantId) {
      await fl.shares.revoke(grantId, { as: user });
      return json({ revoked: 1 });
    }
    return json({ error: 'pass ?user= or ?grant=' }, 400);
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

function fromFilelayerError(err: unknown): Response {
  const e = err as { status?: number; code?: string };
  if (typeof e?.status === 'number' && typeof e.code === 'string') {
    return json({ error: e.code }, e.status);
  }
  throw err;
}
