/**
 * VAULT -- a B2B document workspace, built on Filelayer.
 *
 * This file is the ENTIRE integration: everything an application developer
 * writes to get orgs, roles, upload, per-role access, an authorized listing
 * screen, share links with expiry + password + download cap, revocation, and a
 * tamper-evident audit trail.
 *
 * Note what is absent from THIS FILE, because that absence is the product:
 *   - no authorization rules
 *   - no ownership checks in route handlers
 *   - no presigned-URL TTL to choose
 *   - no bucket ACL to get right
 *   - no "is this user in this org" WHERE clause
 *   - no "which files may this user see" query           <- new, see GET /files
 *   - no decision about which errors leak existence
 *   - no response headers to remember                    <- new, see delivery.ts
 *
 * What that absence is NOT: it is not a claim that database-level enforcement is
 * unnecessary. Filelayer is authorization middleware. Every access below goes
 * through authorize(); a direct SQL client would go through nothing. If your
 * threat model includes callers that reach Postgres without passing through this
 * file, you want RLS underneath, and the two compose fine.
 *
 * REVISION 3. Four things changed and all four were defects an independent
 * security review found in this file, not cosmetics:
 *   1. `GET /orgs/:id/files` exists. It was missing, and its absence was the
 *      only reason the "0 authorization lines" claim survived.
 *   2. Byte delivery is the library's job now. Both download paths are library
 *      routes, so `nosniff`, `Content-Disposition` and `Cache-Control:
 *      no-store` are not decisions made here.
 *   3. The share password is read from the request body. The old
 *      `GET /d/:secret?password=...` put a credential in access logs, proxy
 *      logs and browser history.
 *   4. `upload()` takes the authenticated principal, not a bare actor id out
 *      of the request body.
 *
 * Run:  npm --prefix packages/core run example
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  Filelayer,
  FilelayerError,
  MemoryStorage,
  createTestDb,
  fileDownloadRoute,
  shareDownloadRoute,
  type Queryable,
  type StorageAdapter,
} from '../../packages/core/src/index.ts';

// The app's own authentication. Every system needs this and Filelayer does not
// replace it: you tell Filelayer who the caller is, it tells you what they may
// do. Here a header stands in for whatever session/JWT layer the app already
// has.
function currentActor(req: IncomingMessage): string | null {
  return (req.headers['x-actor-id'] as string) ?? null;
}

export function createVaultApp(db: Queryable, storage: StorageAdapter) {
  const files = new Filelayer(db, storage, { baseUrl: 'https://vault.example.com' });

  // Both byte paths belong to the library. Everything that happens to a
  // document on its way to a browser -- content type, disposition, sniffing,
  // caching, referrer, framing -- is decided in delivery.ts, once, for every
  // application, instead of here, per route, per developer.
  const readFile = fileDownloadRoute(files, {
    principal: (req) => ({ actorId: currentActor(req) }),
  });
  const download = shareDownloadRoute(files);

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://vault');
    const seg = url.pathname.split('/').filter(Boolean);
    const actorId = currentActor(req);
    const principal = { actorId };

    try {
      // --- byte delivery, both paths ---------------------------------------
      if (await readFile(req, res)) return;
      if (await download(req, res)) return;

      // --- admin bootstrap: orgs, actors, roles ---------------------------
      if (req.method === 'POST' && seg[0] === 'orgs' && seg.length === 1) {
        const b = await json(req);
        // The org's first owner is created with the org, so there is never a
        // memberless org for someone to walk into.
        return send(res, 201, await files.createOrg(b.externalId, b.name, {
          ownerActorId: b.ownerActorId,
        }));
      }
      if (req.method === 'POST' && seg[0] === 'actors' && seg.length === 1) {
        const b = await json(req);
        return send(res, 201, await files.createActor(b.externalId));
      }
      if (req.method === 'POST' && seg[0] === 'orgs' && seg[2] === 'members') {
        const b = await json(req);
        await files.addMember(principal, seg[1]!, b.actorId, b.role);
        return send(res, 204, null);
      }
      if (req.method === 'DELETE' && seg[0] === 'orgs' && seg[2] === 'members' && seg[3]) {
        await files.removeMember(principal, seg[1]!, seg[3]);
        return send(res, 204, null);
      }

      // --- documents -------------------------------------------------------
      if (req.method === 'POST' && seg[0] === 'orgs' && seg[2] === 'files') {
        const b = await json(req);
        const file = await files.upload(principal, seg[1]!, {
          name: b.name,
          contentType: b.contentType,
          body: Buffer.from(b.contentBase64, 'base64'),
          // Files are private to their owner and the org's admins unless the
          // uploader asks for workspace-wide visibility. Not an authorization
          // rule: a declared property of the document, visible on the record.
          ...(b.visibility ? { visibility: b.visibility } : {}),
          ...(b.retainForDays ? { retainFor: b.retainForDays * 86400 } : {}),
        });
        return send(res, 201, { id: file.id, name: file.name });
      }
      // The listing screen. The highest-frequency operation in a document
      // workspace and historically the highest-yield IDOR surface -- and there
      // is no predicate here. No org filter, no visibility check, no owner
      // check, no role check, no union over grants. The set of files this
      // caller may read IS the return value of the call.
      if (req.method === 'GET' && seg[0] === 'orgs' && seg[2] === 'files') {
        const page = await files.listFiles(principal, seg[1]!, {
          ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor') } : {}),
          ...(url.searchParams.get('limit')
            ? { limit: Number(url.searchParams.get('limit')) }
            : {}),
        });
        return send(res, 200, {
          files: page.files.map((f) => ({
            id: f.id,
            name: f.name,
            contentType: f.contentType,
            sizeBytes: f.sizeBytes,
            visibility: f.visibility,
            ownerId: f.ownerId,
            createdAt: f.createdAt,
          })),
          nextCursor: page.nextCursor,
        });
      }
      if (req.method === 'DELETE' && seg[0] === 'files' && seg.length === 2) {
        await files.delete(principal, seg[1]!);
        return send(res, 204, null);
      }

      // --- sharing ---------------------------------------------------------
      if (req.method === 'POST' && seg[0] === 'files' && seg[2] === 'shares') {
        const b = await json(req);
        const share = await files.share(principal, seg[1]!, {
          subject: b.actorId ? { type: 'actor', actorId: b.actorId } : { type: 'link' },
          ...(b.expiresInHours ? { expiresIn: b.expiresInHours * 3600 } : {}),
          ...(b.maxDownloads ? { maxDownloads: b.maxDownloads } : {}),
          ...(b.password ? { password: b.password } : {}),
        });
        return send(res, 201, share);
      }
      if (req.method === 'GET' && seg[0] === 'files' && seg[2] === 'shares') {
        return send(res, 200, await files.listGrants(principal, seg[1]!));
      }
      if (req.method === 'DELETE' && seg[0] === 'shares' && seg.length === 2) {
        await files.revoke(principal, seg[1]!);
        return send(res, 204, null);
      }

      // --- compliance ------------------------------------------------------
      if (req.method === 'GET' && seg[0] === 'orgs' && seg[2] === 'audit') {
        const decision = url.searchParams.get('decision') as 'allow' | 'deny' | null;
        return send(
          res,
          200,
          await files.auditLog(principal, seg[1]!, decision ? { decision } : {}),
        );
      }
      if (req.method === 'GET' && seg[0] === 'orgs' && seg[2] === 'audit-integrity') {
        return send(res, 200, await files.verifyAuditChain(principal, seg[1]!));
      }

      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      // One catch. Filelayer has already collapsed the internal reason into a
      // status that does not leak existence, so there is nothing to decide.
      if (err instanceof FilelayerError) return send(res, err.status, { error: err.code });
      return send(res, 500, { error: 'internal' });
    }
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  if (body === null) return res.writeHead(status).end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

// --- boot --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await createTestDb();
  createVaultApp(db, new MemoryStorage()).listen(8787, () =>
    console.log('vault listening on http://localhost:8787'),
  );
}
