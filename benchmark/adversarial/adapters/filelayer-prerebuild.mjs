/**
 * CALIBRATION ADAPTER: Filelayer as it was BEFORE the delivery and
 * authorization rebuild.
 *
 * WHY THIS EXISTS. The shared suite defends 27/27 on the current Filelayer
 * artifact. A suite that the implementation it was written alongside passes
 * perfectly is exactly the suite a reader should distrust -- it is
 * indistinguishable from a suite shaped, consciously or not, around what that
 * implementation already does.
 *
 * So the suite is calibrated against Filelayer's OWN previous artifact.
 * This adapter reproduces `examples/vault/server.ts` at revision 2 on every
 * axis the rebuild touched, using the same library underneath:
 *
 *   - the read path writes `{'content-type': file.contentType}` and nothing
 *     else (no nosniff, no Content-Disposition, no Cache-Control)
 *   - the share path is `GET /d/:secret?password=...`
 *   - `Content-Disposition` on the share path interpolates the filename
 *     unescaped: `filename="${file.name}"`
 *   - there is no listing endpoint at all
 *   - `audit_event.actor_id` carries the foreign key it used to carry
 *
 * Nothing else is reverted. If the suite has teeth, it must fail this. If it
 * does not fail this, the 27/27 above means nothing.
 *
 * This adapter is NOT a benchmark implementation and is never scored against
 * the baselines. It is a control.
 */
import { createServer } from 'node:http';
import { createTestDb } from '../../../packages/core/src/db.ts';
import { MemoryStorage } from '../../../packages/core/src/storage.ts';
import { Filelayer, FilelayerError } from '../../../packages/core/src/index.ts';

const b64 = (s) => Buffer.from(s).toString('base64');

export const meta = {
  name: 'filelayer-prerebuild',
  executable: true,
  singleBackend: true,
  control: true,
  note: 'CONTROL, not a benchmark entry: the pre-rebuild artifact, to prove the suite has teeth',
};

/** The revision-2 server, verbatim on the axes the rebuild changed. */
function createOldVaultApp(db, storage) {
  const files = new Filelayer(db, storage, { baseUrl: 'https://vault.example.com' });
  const send = (res, status, body) => {
    if (body === null) return res.writeHead(status).end();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const json = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://vault');
    const seg = url.pathname.split('/').filter(Boolean);
    const actorId = req.headers['x-actor-id'] ?? null;
    const principal = { actorId };
    try {
      if (req.method === 'POST' && seg[0] === 'orgs' && seg.length === 1) {
        const b = await json(req);
        return send(res, 201, await files.createOrg(b.externalId, b.name, { ownerActorId: b.ownerActorId }));
      }
      if (req.method === 'POST' && seg[0] === 'actors') {
        const b = await json(req);
        return send(res, 201, await files.createActor(b.externalId));
      }
      if (req.method === 'POST' && seg[0] === 'orgs' && seg[2] === 'members') {
        const b = await json(req);
        await files.addMember(principal, seg[1], b.actorId, b.role);
        return send(res, 204, null);
      }
      if (req.method === 'POST' && seg[0] === 'orgs' && seg[2] === 'files') {
        const b = await json(req);
        const file = await files.upload(principal, seg[1], {
          name: b.name,
          contentType: b.contentType,
          body: Buffer.from(b.contentBase64, 'base64'),
          ...(b.visibility ? { visibility: b.visibility } : {}),
        });
        return send(res, 201, { id: file.id, name: file.name });
      }
      // THE OLD READ PATH: content-type only, no nosniff, no disposition.
      if (req.method === 'GET' && seg[0] === 'files' && seg.length === 2) {
        const { file, body } = await files.read(principal, seg[1]);
        res.writeHead(200, { 'content-type': file.contentType });
        return res.end(body);
      }
      if (req.method === 'DELETE' && seg[0] === 'files' && seg.length === 2) {
        await files.delete(principal, seg[1]);
        return send(res, 204, null);
      }
      if (req.method === 'POST' && seg[0] === 'files' && seg[2] === 'shares') {
        const b = await json(req);
        return send(
          res,
          201,
          await files.share(principal, seg[1], {
            subject: b.actorId ? { type: 'actor', actorId: b.actorId } : { type: 'link' },
            ...(b.expiresInHours ? { expiresIn: b.expiresInHours * 3600 } : {}),
            ...(b.maxDownloads ? { maxDownloads: b.maxDownloads } : {}),
            ...(b.password ? { password: b.password } : {}),
          }),
        );
      }
      if (req.method === 'GET' && seg[0] === 'files' && seg[2] === 'shares') {
        return send(res, 200, await files.listGrants(principal, seg[1]));
      }
      if (req.method === 'DELETE' && seg[0] === 'shares' && seg.length === 2) {
        await files.revoke(principal, seg[1]);
        return send(res, 204, null);
      }
      // THE OLD SHARE PATH: password in the query string, no cache-control,
      // and the filename interpolated into content-disposition unescaped.
      if (req.method === 'GET' && seg[0] === 'd' && seg.length === 2) {
        const { file, body, remainingDownloads } = await files.redeem(seg[1], {
          ...(url.searchParams.get('password') ? { password: url.searchParams.get('password') } : {}),
        });
        res.writeHead(200, {
          'content-type': file.contentType,
          'content-disposition': `attachment; filename="${file.name}"`,
          'x-downloads-remaining': String(remainingDownloads ?? ''),
        });
        return res.end(body);
      }
      if (req.method === 'GET' && seg[0] === 'orgs' && seg[2] === 'audit') {
        return send(res, 200, await files.auditLog(principal, seg[1], {}));
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      if (err instanceof FilelayerError) return send(res, err.status, { error: err.code });
      return send(res, 500, { error: 'internal' });
    }
  });
}

export async function create() {
  const { db } = await createTestDb();
  // Restore the foreign key the rebuild removed. It let a deleted actor be
  // distinguished from one that never existed, and that identity oracle must be
  // present again in the control.
  await db.query(
    `ALTER TABLE audit_event ADD CONSTRAINT audit_event_actor_id_fkey
       FOREIGN KEY (actor_id) REFERENCES actor(id) ON DELETE SET NULL`,
  );

  const server = createOldVaultApp(db, new MemoryStorage());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { as, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(as ? { 'x-actor-id': as } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* bytes */
    }
    const headers = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, json, text, headers };
  };

  const actor = async (n) => (await call('POST', '/actors', { body: { externalId: n } })).json.id;
  const alice = await actor('alice');
  const adam = await actor('adam');
  const mallory = await actor('mallory');
  const bob = await actor('bob');
  const eve = await actor('eve');
  const orgA = (await call('POST', '/orgs', { body: { externalId: 'acme', ownerActorId: alice } })).json.id;
  const orgB = (await call('POST', '/orgs', { body: { externalId: 'beta', ownerActorId: bob } })).json.id;
  await call('POST', `/orgs/${orgA}/members`, { as: alice, body: { actorId: adam, role: 'admin' } });
  await call('POST', `/orgs/${orgA}/members`, { as: alice, body: { actorId: mallory, role: 'member' } });
  await call('POST', `/orgs/${orgB}/members`, { as: bob, body: { actorId: eve, role: 'member' } });

  const upload = async (name, ct, marker, extra = {}) =>
    (
      await call('POST', `/orgs/${orgA}/files`, {
        as: alice,
        body: { name, contentType: ct, contentBase64: b64(marker), ...extra },
      })
    ).json.id;

  const docA = await upload('a.txt', 'text/plain', 'DOC-A-SECRET', { visibility: 'org' });
  const docA2 = await upload('a2.txt', 'text/plain', 'DOC-A2-MARKER', { visibility: 'org' });
  const docAPrivate = await upload('p.txt', 'text/plain', 'OWNER-ONLY');
  const docAExpired = await upload('e.txt', 'text/plain', 'EXPIRED', { visibility: 'org' });
  await db.query(`UPDATE file SET expires_at = now() - interval '1 hour' WHERE id = $1`, [docAExpired]);

  const w = {
    alice, adam, mallory, bob, eve, orgA, orgB,
    docA, docA2, docAPrivate, docAExpired,
    docA2Marker: 'DOC-A2-MARKER',
    ghostUser: '00000000-0000-4000-8000-0000000000ee',
    ghostDoc: '00000000-0000-4000-8000-0000000000aa',
    ghostDocs: Array.from(
      { length: 8 },
      (_, i) => `00000000-0000-4000-8000-0000000000${(0xb0 + i).toString(16)}`,
    ),
  };

  return {
    w,
    singleBackend: true,
    close: async () => new Promise((r) => server.close(r)),
    read: ({ as, doc }) => call('GET', `/files/${doc}`, { as }),
    // No listing endpoint existed. Deliberately absent, so A3 records n/a --
    // which is itself the finding: the claim survived by omission.
    del: ({ as, doc }) => call('DELETE', `/files/${doc}`, { as }),
    share: async ({ as, doc, opts }) => {
      const r = await call('POST', `/files/${doc}/shares`, {
        as,
        body: {
          ...(opts.expiresInSec ? { expiresInHours: opts.expiresInSec / 3600 } : {}),
          ...(opts.maxDownloads ? { maxDownloads: opts.maxDownloads } : {}),
          ...(opts.password ? { password: opts.password } : {}),
        },
      });
      return { status: r.status, token: r.json?.secret, shareId: r.json?.grantId };
    },
    redeem: async ({ token, password }) => {
      const q = password === undefined ? '' : `?password=${encodeURIComponent(password)}`;
      const r = await call('GET', `/d/${token}${q}`);
      return { status: r.status, body: r.text, headers: r.headers, deliveredBytes: r.status === 200 };
    },
    revoke: ({ as, shareId }) => call('DELETE', `/shares/${shareId}`, { as }),
    expireShare: async ({ shareId }) => {
      await db.query(`UPDATE file_grant SET expires_at = now() - interval '1 hour' WHERE id = $1`, [shareId]);
      return { status: 204 };
    },
    shareState: async ({ shareId }) => {
      const { rows } = await db.query(`SELECT download_count FROM file_grant WHERE id = $1`, [shareId]);
      return { downloadCount: Number(rows[0]?.download_count ?? 0) };
    },
    listShares: async ({ as, doc }) => {
      const r = await call('GET', `/files/${doc}/shares`, { as });
      return { status: r.status, shares: r.json };
    },
    setRole: ({ as, org, target, role }) =>
      call('POST', `/orgs/${org}/members`, { as, body: { actorId: target, role } }),
    audit: async ({ as, org }) => {
      const r = await call('GET', `/orgs/${org}/audit`, { as });
      return { status: r.status, events: Array.isArray(r.json) ? r.json : [] };
    },
    auditEvents: async ({ org }) => {
      const { rows } = await db.query(`SELECT action FROM audit_event WHERE org_id = $1`, [org]);
      return rows;
    },
    countAudit: async ({ org }) => {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM audit_event WHERE org_id IS NOT DISTINCT FROM $1`,
        [org],
      );
      return Number(rows[0].n);
    },
    uploadHtml: async () => ({
      doc: await upload('evil.html', 'text/html', '<script>alert(1)</script>', { visibility: 'org' }),
    }),
    uploadNamed: async ({ name }) => ({
      doc: await upload(name, 'text/plain', 'x', { visibility: 'org' }),
    }),
    delegate: async () => ({
      unsupported: true,
      detail: 'not part of the calibration; see the current adapter',
    }),
  };
}
