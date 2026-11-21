// Reference implementation, arm A: the contract on @filelayer/core.
//
// Filelayer decides access to documents and shares, stores the bytes, counts
// downloads and keeps the audit trail. This file adds what the contract asks
// for that Filelayer does not do:
//   - registered users and org names, in two small tables of our own;
//   - "a non-member gets 404 on every org route", checked before Filelayer;
//   - the contract's status codes where Filelayer answers differently (it
//     answers 404 to a member who lacks a capability, the contract 403);
//   - members of an org may share any of its documents, granted per document
//     at upload with a role grant;
//   - listings Filelayer has no API for (members, the operator's view of the
//     whole trail), read from its tables;
//   - the contract's event names, mapped from Filelayer's.
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { FilelayerError } from '@filelayer/core';

const MAX_BYTES = 10 * 1024 * 1024;
const ROLES = ['owner', 'admin', 'member', 'viewer'];
const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const NOT_FOUND = { error: 'not_found' };
const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, lo, hi) => typeof v === 'string' && v.length >= lo && v.length <= hi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Filelayer's event names, as the contract names them.
const ACTIONS = {
  'org.create': 'org.create',
  'member.bootstrap': 'org.create',
  'member.add': 'member.set_role',
  'member.role_change': 'member.set_role',
  'member.remove': 'member.remove',
  'file.create': 'document.upload',
  'file.upload_complete': 'document.upload',
  'file.list': 'document.list',
  'file.read': 'document.read',
  'file.access': 'document.read',
  'file.delete': 'document.delete',
  'grant.create': 'share.create',
  'grant.list': 'share.list',
  'grant.revoke': 'share.revoke',
  'file.deliver': 'share.download',
  'audit.read': 'audit.read',
};

export function createApp({ db, fl, baseUrl, adminToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16mb' }));
  const one = async (sql, args) => (await db.query(sql, args)).rows[0] ?? null;
  const fail = (res, status, error) => res.status(status).json({ error });

  // Our own audit events, for the decisions Filelayer never sees, written to
  // Filelayer's trail so there is one trail.
  async function record(e) {
    await fl.store.audit({
      orgId: e.orgId ? await fl.ids.orgId(e.orgId) : null,
      action: e.action,
      decision: e.decision,
      ...(e.reason ? { reason: e.reason } : {}),
      actorId: e.actorId ? await fl.ids.actorId(e.actorId) : null,
      fileId: e.documentId && UUID.test(e.documentId) ? e.documentId : null,
      ...(e.shareId && UUID.test(e.shareId) ? { grantId: e.shareId } : {}),
      context: {
        as: e.actorId ?? null,
        ...(e.documentId ? { documentId: e.documentId } : {}),
        ...(e.shareId ? { shareId: e.shareId } : {}),
      },
    });
  }

  async function standing(req, orgId) {
    const userId = req.get('x-user-id') || null;
    const org = await one('SELECT id FROM app_org WHERE id = $1', [orgId]);
    let role = null;
    if (userId && org) {
      const [o, a] = [await fl.ids.orgId(orgId), await fl.ids.actorId(userId)];
      role = o && a ? await fl.store.getMembership(o, a) : null;
    }
    return { userId, orgExists: !!org, role };
  }

  // Filelayer's refusal, in the contract's terms, for a caller who IS a member
  // and may know the resource exists.
  const statusFor = (e) => {
    if (!(e instanceof FilelayerError)) throw e;
    if (e.reason === 'last_owner') return 409;
    if (e.status === 401) return 401;
    if (e.status === 400) return 400;
    if (e.status === 413) return 413;
    return 403;
  };

  const orgRoute = (action, handler) => async (req, res, next) => {
    try {
      const s = await standing(req, req.params.orgId);
      if (!s.userId) return fail(res, 401, 'unauthenticated');
      if (!s.role) {
        await record({
          action, decision: 'deny', actorId: s.userId, orgId: s.orgExists ? req.params.orgId : null,
          documentId: req.params.documentId, shareId: req.params.shareId, reason: 'not_a_member',
        });
        return res.status(404).json(NOT_FOUND);
      }
      const deny = async (status, reason, extra = {}) => {
        await record({ action, decision: 'deny', actorId: s.userId, orgId: req.params.orgId, reason, ...extra });
        return status === 404 ? res.status(404).json(NOT_FOUND) : fail(res, status, reason);
      };
      await handler(req, res, { ...s, orgId: req.params.orgId, deny });
    } catch (e) {
      next(e);
    }
  };

  // The document, if it is a live document of THIS org. Filelayer authorizes
  // by the file's own org; the route names one too, and they must agree.
  async function docInOrg(s, docId) {
    if (!UUID.test(docId)) return null;
    try {
      const f = await fl.files.stat(docId, { as: s.userId });
      return f.orgId === (await fl.ids.orgId(s.orgId)) && f.state === 'ready' ? f : null;
    } catch (e) {
      if (e instanceof FilelayerError && e.status === 404) return null;
      throw e;
    }
  }
  const externalIds = async (uuids) => {
    const ids = [...new Set(uuids.filter(Boolean))];
    if (!ids.length) return new Map();
    const { rows } = await db.query('SELECT id, external_id FROM actor WHERE id = ANY($1::uuid[])', [ids]);
    return new Map(rows.map((r) => [r.id, r.external_id]));
  };
  const docJson = (f, owners) => ({
    id: f.id,
    name: f.name,
    contentType: f.contentType,
    size: Number(f.sizeBytes ?? 0),
    createdAt: new Date(f.createdAt).toISOString(),
    uploadedBy: owners.get(f.ownerId) ?? null,
  });
  const serve = (res, got) => {
    res.status(200);
    for (const [k, v] of Object.entries(got.headers)) res.set(k, v);
    res.set('Cache-Control', 'private, no-store');
    res.end(Buffer.from(got.body));
  };

  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  app.post('/users', async (req, res, next) => {
    try {
      const email = req.body?.email;
      if (!isStr(email, 3, 254)) return fail(res, 400, 'invalid_request');
      const id = newId('usr');
      const r = await db.query('INSERT INTO app_user (id, email) VALUES ($1,$2) ON CONFLICT (email) DO NOTHING', [id, email]);
      if (r.rowCount === 0) return fail(res, 409, 'email_taken');
      res.status(201).json({ id, email });
    } catch (e) {
      next(e);
    }
  });

  app.post('/orgs', async (req, res, next) => {
    try {
      const userId = req.get('x-user-id') || null;
      if (!userId || !(await one('SELECT id FROM app_user WHERE id = $1', [userId]))) return fail(res, 401, 'unauthenticated');
      const name = req.body?.name;
      if (!isStr(name, 1, 100)) return fail(res, 400, 'invalid_request');
      const id = newId('org');
      await fl.orgs.create(id, { name, owner: userId });
      await db.query('INSERT INTO app_org (id, name) VALUES ($1,$2)', [id, name]);
      res.status(201).json({ id, name });
    } catch (e) {
      next(e);
    }
  });

  // --- members ---------------------------------------------------------------

  app.get('/orgs/:orgId/members', orgRoute('member.list', async (_req, res, s) => {
    // Filelayer 0.36.0 has no members listing; its membership table is the truth.
    const { rows } = await db.query(
      `SELECT a.external_id AS user_id, m.role FROM membership m
         JOIN org o ON o.id = m.org_id JOIN actor a ON a.id = m.actor_id
        WHERE o.external_id = $1 AND a.deleted_at IS NULL ORDER BY a.external_id`,
      [s.orgId],
    );
    res.json({ members: rows.map((r) => ({ userId: r.user_id, role: r.role })) });
  }));

  app.put('/orgs/:orgId/members/:userId', orgRoute('member.set_role', async (req, res, s) => {
    const role = req.body?.role;
    if (!ROLES.includes(role)) return fail(res, 400, 'invalid_request');
    if (!(await one('SELECT id FROM app_user WHERE id = $1', [req.params.userId]))) return fail(res, 400, 'unknown_user');
    try {
      await fl.orgs.setRole(s.orgId, req.params.userId, role, { as: s.userId });
    } catch (e) {
      return fail(res, statusFor(e), e.reason ?? e.code);
    }
    res.status(200).json({ userId: req.params.userId, role });
  }));

  app.delete('/orgs/:orgId/members/:userId', orgRoute('member.remove', async (req, res, s) => {
    const [o, a] = [await fl.ids.orgId(s.orgId), await fl.ids.actorId(req.params.userId)];
    if (!a || !(await fl.store.getMembership(o, a))) return s.deny(404, 'not_found');
    try {
      await fl.orgs.removeMember(s.orgId, req.params.userId, { as: s.userId });
    } catch (e) {
      return fail(res, statusFor(e), e.reason ?? e.code);
    }
    res.status(204).end();
  }));

  // --- documents -------------------------------------------------------------

  app.get('/orgs/:orgId/documents', orgRoute('document.list', async (_req, res, s) => {
    const files = [];
    let cursor = null;
    do {
      const page = await fl.files.list({ org: s.orgId, as: s.userId, limit: 100, cursor });
      files.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    files.sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt));
    const owners = await externalIds(files.map((f) => f.ownerId));
    res.json({ documents: files.map((f) => docJson(f, owners)) });
  }));

  app.post('/orgs/:orgId/documents', orgRoute('document.upload', async (req, res, s) => {
    if (s.role === 'viewer') return s.deny(403, 'insufficient_role');
    const { name, contentType, content } = req.body ?? {};
    if (!isStr(name, 1, 255) || !isStr(contentType, 1, 255) || typeof content !== 'string') return fail(res, 400, 'invalid_request');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) return fail(res, 400, 'invalid_request');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length > MAX_BYTES) return fail(res, 413, 'too_large');
    const put = await fl.files.put(bytes, { org: s.orgId, owner: s.userId, name, contentType, visibility: 'org' });
    // Members may share any document they can read (the brief); Filelayer's
    // default gives a member read-only on others' org-visible files, so grant
    // read and share to the org's members on this one.
    await fl.shares.create(put.id, { as: s.userId, withOrg: s.orgId, minRole: 'member', capabilities: ['read', 'share'] });
    const f = await fl.files.stat(put.id, { as: s.userId });
    res.status(201).json(docJson(f, new Map([[f.ownerId, s.userId]])));
  }));

  app.get('/orgs/:orgId/documents/:documentId', orgRoute('document.read', async (req, res, s) => {
    const f = await docInOrg(s, req.params.documentId);
    if (!f) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    serve(res, await fl.files.get(f.id, { as: s.userId }));
  }));

  app.delete('/orgs/:orgId/documents/:documentId', orgRoute('document.delete', async (req, res, s) => {
    const f = await docInOrg(s, req.params.documentId);
    if (!f) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    try {
      await fl.files.delete(f.id, { as: s.userId });
    } catch (e) {
      return fail(res, statusFor(e), e.reason ?? e.code);
    }
    res.status(204).end();
  }));

  // --- shares ----------------------------------------------------------------

  app.post('/orgs/:orgId/documents/:documentId/shares', orgRoute('share.create', async (req, res, s) => {
    const f = await docInOrg(s, req.params.documentId);
    if (!f) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    if (s.role === 'viewer') return s.deny(403, 'insufficient_role', { documentId: f.id });
    const { expiresInSeconds, password, maxDownloads } = req.body ?? {};
    if (!isInt(expiresInSeconds, 1, 604800)) return fail(res, 400, 'invalid_request');
    if (password !== undefined && !isStr(password, 1, 128)) return fail(res, 400, 'invalid_request');
    if (maxDownloads !== undefined && !isInt(maxDownloads, 1, 1000)) return fail(res, 400, 'invalid_request');
    let sh;
    try {
      sh = await fl.shares.create(f.id, {
        as: s.userId, expiresIn: expiresInSeconds,
        ...(password !== undefined ? { password } : {}),
        ...(maxDownloads !== undefined ? { maxDownloads } : {}),
      });
    } catch (e) {
      return fail(res, statusFor(e), e.reason ?? e.code);
    }
    res.status(201).json({ id: sh.grantId, url: `${baseUrl}/s/${sh.secret}`, expiresAt: new Date(sh.expiresAt).toISOString() });
  }));

  app.get('/orgs/:orgId/documents/:documentId/shares', orgRoute('share.list', async (req, res, s) => {
    const f = await docInOrg(s, req.params.documentId);
    if (!f) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    if (s.role === 'viewer') return s.deny(403, 'insufficient_role', { documentId: f.id });
    const grants = (await fl.shares.list(f.id, { as: s.userId })).filter((g) => g.subjectType === 'link');
    const creators = await externalIds(grants.map((g) => g.createdBy));
    res.json({
      shares: grants.map((g) => ({
        id: g.id,
        documentId: f.id,
        createdBy: creators.get(g.createdBy) ?? null,
        createdAt: new Date(g.createdAt).toISOString(),
        expiresAt: new Date(g.expiresAt).toISOString(),
        hasPassword: g.hasPassword,
        maxDownloads: g.maxDownloads,
        downloadCount: g.downloadCount,
        revoked: g.revokedAt !== null,
      })),
    });
  }));

  app.delete('/orgs/:orgId/shares/:shareId', orgRoute('share.revoke', async (req, res, s) => {
    const id = req.params.shareId;
    const g = UUID.test(id)
      ? await one(
          `SELECT g.id, g.created_by, g.file_id FROM file_grant g JOIN org o ON o.id = g.org_id
            WHERE g.id = $1 AND o.external_id = $2 AND g.subject_type = 'link'`,
          [id, s.orgId],
        )
      : null;
    if (!g) return s.deny(404, 'not_found', { shareId: id });
    // The contract: a member revokes only the links they created. Filelayer
    // lets anyone who may share the document revoke its links.
    if (RANK[s.role] < RANK.admin && g.created_by !== (await fl.ids.actorId(s.userId))) {
      return s.deny(403, 'insufficient_role', { shareId: id, documentId: g.file_id });
    }
    try {
      await fl.shares.revoke(id, { as: s.userId });
    } catch (e) {
      return fail(res, statusFor(e), e.reason ?? e.code);
    }
    res.status(204).end();
  }));

  app.get('/s/:token', async (req, res, next) => {
    try {
      const password = req.get('x-share-password');
      let got;
      try {
        got = await fl.shares.redeem(req.params.token, password !== undefined ? { password } : {});
      } catch (e) {
        if (e instanceof FilelayerError && e.status === 401) return fail(res, 401, 'password_required');
        if (e instanceof FilelayerError && e.status < 500) return res.status(404).json(NOT_FOUND);
        throw e;
      }
      serve(res, got);
    } catch (e) {
      next(e);
    }
  });

  // --- audit -----------------------------------------------------------------

  // Filelayer records a share-link download, and a redemption of an unknown
  // secret, as a read by nobody: in this service the only anonymous read is a
  // share link, and the contract calls it share.download.
  const actionOf = (r) =>
    (r.action === 'file.read' || r.action === 'file.access') && r.actor?.resolution === 'anonymous'
      ? 'share.download'
      : (ACTIONS[r.action] ?? r.action);
  const eventJson = (r, ctx = r.context ?? {}) => ({
    at: new Date(r.occurredAt).toISOString(),
    action: actionOf(r),
    decision: r.decision,
    actorId: r.actor?.resolution === 'anonymous' ? null : (ctx.as ?? r.actor?.externalId ?? null),
    orgId: r.org?.externalId ?? null,
    documentId: r.fileId ?? ctx.documentId ?? ctx.rawFileId ?? null,
    shareId: r.grantId ?? ctx.shareId ?? null,
    reason: r.reason ?? null,
  });
  const limitOf = (v, dflt, max) => {
    const n = Number(v ?? dflt);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  };

  app.get('/orgs/:orgId/audit', orgRoute('audit.read', async (req, res, s) => {
    const limit = limitOf(req.query.limit, 100, 1000);
    if (limit === null) return fail(res, 400, 'invalid_request');
    let rows;
    try {
      rows = await fl.orgs.audit(s.orgId, { as: s.userId, limit });
    } catch (e) {
      return fail(res, statusFor(e), e.reason ?? e.code);
    }
    rows.sort((x, y) => new Date(y.occurredAt) - new Date(x.occurredAt) || y.id - x.id);
    res.json({ events: rows.map((r) => eventJson(r)) });
  }));

  app.get('/admin/audit', async (req, res, next) => {
    try {
      const given = Buffer.from(req.get('x-admin-token') ?? '');
      const want = Buffer.from(adminToken ?? '');
      if (!adminToken || given.length !== want.length || !timingSafeEqual(given, want)) return fail(res, 401, 'unauthenticated');
      const limit = limitOf(req.query.limit, 1000, 10000);
      if (limit === null) return fail(res, 400, 'invalid_request');
      // Filelayer 0.36.0 has no operator reader for every chain at once, the
      // unattributed one included; one per org plus the system chain.
      const orgs = (await db.query('SELECT o.id FROM org o JOIN app_org a ON a.id = o.external_id')).rows.map((r) => r.id);
      const chains = await Promise.all([null, ...orgs].map((o) => fl.store.listAuditResolved(o, { limit })));
      const rows = chains.flat().sort((x, y) => new Date(y.occurredAt) - new Date(x.occurredAt) || y.id - x.id).slice(0, limit);
      res.json({ events: rows.map((r) => eventJson(r)) });
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => res.status(404).json(NOT_FOUND));
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return fail(res, 413, 'too_large');
    if (err?.type === 'entity.parse.failed' || err?.status === 400) return fail(res, 400, 'invalid_request');
    if (err instanceof FilelayerError && err.status < 500) return fail(res, err.status, err.code);
    console.error(err);
    return fail(res, 500, 'internal');
  });
  return app;
}
