// Reference implementation, arm B: the contract on Postgres and S3 with no
// permissions library. Every rule in REQUIREMENTS.md is enforced here.
import express from 'express';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const MAX_BYTES = 10 * 1024 * 1024;
const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
const ROLES = Object.keys(RANK);
const NOT_FOUND = { error: 'not_found' };

const newId = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isStr = (v, lo, hi) => typeof v === 'string' && v.length >= lo && v.length <= hi;

async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 32);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}
async function checkPassword(pw, stored) {
  const [salt, key] = stored.split(':');
  const got = await scryptAsync(pw, Buffer.from(salt, 'hex'), 32);
  return timingSafeEqual(got, Buffer.from(key, 'hex'));
}

// A name in a header: an ASCII fallback with anything unsafe replaced, and the
// exact name in RFC 5987 form. No input can add or end a header.
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendBytes(res, doc, bytes) {
  res.status(200);
  res.set('Content-Type', doc.content_type);
  res.set('Content-Disposition', disposition(doc.name));
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, no-store');
  res.set('Content-Length', String(bytes.length));
  res.end(bytes);
}

const docJson = (d) => ({
  id: d.id,
  name: d.name,
  contentType: d.content_type,
  size: d.size,
  createdAt: d.created_at.toISOString(),
  uploadedBy: d.uploaded_by,
});

export function createApp({ db, storage, baseUrl, adminToken }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16mb' }));

  const audit = (e) =>
    db.query(
      `INSERT INTO audit_events (action, decision, actor_id, org_id, document_id, share_id, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [e.action, e.decision, e.actorId ?? null, e.orgId ?? null, e.documentId ?? null, e.shareId ?? null, e.reason ?? null],
    );
  const one = async (sql, args) => (await db.query(sql, args)).rows[0] ?? null;
  const fail = (res, status, error) => res.status(status).json({ error });

  // The caller, and their role in the org named in the path. A user id that is
  // not registered and a registered non-member come out the same: role null.
  async function standing(req, orgId) {
    const userId = req.get('x-user-id') || null;
    const org = await one('SELECT id FROM orgs WHERE id = $1', [orgId]);
    const m = userId && org
      ? await one('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [orgId, userId])
      : null;
    return { userId, orgExists: !!org, role: m?.role ?? null };
  }

  // Wraps an org-scoped handler: no header is 401, a non-member is 404 and the
  // refusal is recorded.
  const orgRoute = (action, handler) => async (req, res, next) => {
    try {
      const s = await standing(req, req.params.orgId);
      if (!s.userId) return fail(res, 401, 'unauthenticated');
      if (!s.role) {
        await audit({
          action, decision: 'deny', actorId: s.userId,
          orgId: s.orgExists ? req.params.orgId : null,
          documentId: req.params.documentId ?? null, shareId: req.params.shareId ?? null,
          reason: 'not_a_member',
        });
        return res.status(404).json(NOT_FOUND);
      }
      const deny = async (status, reason, extra = {}) => {
        await audit({ action, decision: 'deny', actorId: s.userId, orgId: req.params.orgId, reason, ...extra });
        return status === 404 ? res.status(404).json(NOT_FOUND) : fail(res, status, reason);
      };
      const allow = (extra = {}) =>
        audit({ action, decision: 'allow', actorId: s.userId, orgId: req.params.orgId, ...extra });
      await handler(req, res, { ...s, orgId: req.params.orgId, deny, allow });
    } catch (e) {
      next(e);
    }
  };

  const liveDoc = (orgId, docId) =>
    one('SELECT * FROM documents WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL', [docId, orgId]);

  app.get('/health', (_req, res) => res.status(200).json({ ok: true }));

  app.post('/users', async (req, res, next) => {
    try {
      const email = req.body?.email;
      if (!isStr(email, 3, 254)) return fail(res, 400, 'invalid_request');
      const id = newId('usr');
      const r = await db.query(
        'INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING RETURNING id',
        [id, email],
      );
      if (r.rowCount === 0) return fail(res, 409, 'email_taken');
      res.status(201).json({ id, email });
    } catch (e) {
      next(e);
    }
  });

  app.post('/orgs', async (req, res, next) => {
    try {
      const userId = req.get('x-user-id') || null;
      const user = userId ? await one('SELECT id FROM users WHERE id = $1', [userId]) : null;
      if (!user) return fail(res, 401, 'unauthenticated');
      const name = req.body?.name;
      if (!isStr(name, 1, 100)) return fail(res, 400, 'invalid_request');
      const id = newId('org');
      const c = await db.connect();
      try {
        await c.query('BEGIN');
        await c.query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [id, name]);
        await c.query(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, userId]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      } finally {
        c.release();
      }
      await audit({ action: 'org.create', decision: 'allow', actorId: userId, orgId: id });
      res.status(201).json({ id, name });
    } catch (e) {
      next(e);
    }
  });

  // --- members ---------------------------------------------------------------

  app.get('/orgs/:orgId/members', orgRoute('member.list', async (_req, res, s) => {
    const { rows } = await db.query('SELECT user_id, role FROM memberships WHERE org_id = $1 ORDER BY user_id', [s.orgId]);
    res.json({ members: rows.map((r) => ({ userId: r.user_id, role: r.role })) });
  }));

  // Who may set `target` from `current` to `next`, for a caller holding `mine`.
  function memberChangeRefusal(mine, current, next) {
    if (RANK[mine] < RANK.admin) return 'insufficient_role';
    if (mine === 'admin' && (current === 'owner' || next === 'owner')) return 'insufficient_role';
    return null;
  }
  const ownerCount = async (orgId) =>
    Number((await one(`SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`, [orgId])).n);

  app.put('/orgs/:orgId/members/:userId', orgRoute('member.set_role', async (req, res, s) => {
    const target = req.params.userId;
    const role = req.body?.role;
    if (!ROLES.includes(role)) return fail(res, 400, 'invalid_request');
    if (!(await one('SELECT id FROM users WHERE id = $1', [target]))) return fail(res, 400, 'unknown_user');
    const current = (await one('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [s.orgId, target]))?.role ?? null;
    const refusal = memberChangeRefusal(s.role, current, role);
    if (refusal) return s.deny(403, refusal);
    if (current === 'owner' && role !== 'owner' && (await ownerCount(s.orgId)) <= 1) return s.deny(409, 'last_owner');
    await db.query(
      `INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [s.orgId, target, role],
    );
    await s.allow();
    res.status(200).json({ userId: target, role });
  }));

  app.delete('/orgs/:orgId/members/:userId', orgRoute('member.remove', async (req, res, s) => {
    const target = req.params.userId;
    const current = (await one('SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2', [s.orgId, target]))?.role ?? null;
    if (!current) return s.deny(404, 'not_found');
    if (RANK[s.role] < RANK.admin || (s.role === 'admin' && current === 'owner')) return s.deny(403, 'insufficient_role');
    if (current === 'owner' && (await ownerCount(s.orgId)) <= 1) return s.deny(409, 'last_owner');
    await db.query('DELETE FROM memberships WHERE org_id = $1 AND user_id = $2', [s.orgId, target]);
    await s.allow();
    res.status(204).end();
  }));

  // --- documents -------------------------------------------------------------

  app.get('/orgs/:orgId/documents', orgRoute('document.list', async (_req, res, s) => {
    const { rows } = await db.query(
      'SELECT * FROM documents WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id',
      [s.orgId],
    );
    await s.allow();
    res.json({ documents: rows.map(docJson) });
  }));

  app.post('/orgs/:orgId/documents', orgRoute('document.upload', async (req, res, s) => {
    if (s.role === 'viewer') return s.deny(403, 'insufficient_role');
    const { name, contentType, content } = req.body ?? {};
    if (!isStr(name, 1, 255) || !isStr(contentType, 1, 255) || typeof content !== 'string') {
      return fail(res, 400, 'invalid_request');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) return fail(res, 400, 'invalid_request');
    const bytes = Buffer.from(content, 'base64');
    if (bytes.length > MAX_BYTES) return fail(res, 413, 'too_large');
    const id = newId('doc');
    const key = `${s.orgId}/${id}`;
    await storage.put(key, bytes, contentType);
    const doc = await one(
      `INSERT INTO documents (id, org_id, name, content_type, size, storage_key, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, s.orgId, name, contentType, bytes.length, key, s.userId],
    );
    await s.allow({ documentId: id });
    res.status(201).json(docJson(doc));
  }));

  app.get('/orgs/:orgId/documents/:documentId', orgRoute('document.read', async (req, res, s) => {
    const doc = await liveDoc(s.orgId, req.params.documentId);
    if (!doc) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    const bytes = await storage.get(doc.storage_key);
    await s.allow({ documentId: doc.id });
    sendBytes(res, doc, bytes);
  }));

  app.delete('/orgs/:orgId/documents/:documentId', orgRoute('document.delete', async (req, res, s) => {
    const doc = await liveDoc(s.orgId, req.params.documentId);
    if (!doc) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    const mayDelete = RANK[s.role] >= RANK.admin || (s.role === 'member' && doc.uploaded_by === s.userId);
    if (!mayDelete) return s.deny(403, 'insufficient_role', { documentId: doc.id });
    await db.query('UPDATE documents SET deleted_at = now() WHERE id = $1', [doc.id]);
    await storage.del(doc.storage_key);
    await s.allow({ documentId: doc.id });
    res.status(204).end();
  }));

  // --- shares ----------------------------------------------------------------

  const shareJson = (r) => ({
    id: r.id,
    documentId: r.document_id,
    createdBy: r.created_by,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    hasPassword: r.password_hash !== null,
    maxDownloads: r.max_downloads,
    downloadCount: r.download_count,
    revoked: r.revoked_at !== null,
  });

  app.post('/orgs/:orgId/documents/:documentId/shares', orgRoute('share.create', async (req, res, s) => {
    const doc = await liveDoc(s.orgId, req.params.documentId);
    if (!doc) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    if (s.role === 'viewer') return s.deny(403, 'insufficient_role', { documentId: doc.id });
    const { expiresInSeconds, password, maxDownloads } = req.body ?? {};
    if (!isInt(expiresInSeconds, 1, 604800)) return fail(res, 400, 'invalid_request');
    if (password !== undefined && !isStr(password, 1, 128)) return fail(res, 400, 'invalid_request');
    if (maxDownloads !== undefined && !isInt(maxDownloads, 1, 1000)) return fail(res, 400, 'invalid_request');
    const token = randomBytes(32).toString('base64url');
    const id = newId('shr');
    const row = await one(
      `INSERT INTO shares (id, org_id, document_id, token_hash, created_by, expires_at, password_hash, max_downloads)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6), $7, $8) RETURNING *`,
      [id, s.orgId, doc.id, sha256(token), s.userId, expiresInSeconds,
       password === undefined ? null : await hashPassword(password), maxDownloads ?? null],
    );
    await s.allow({ documentId: doc.id, shareId: id });
    res.status(201).json({ id, url: `${baseUrl}/s/${token}`, expiresAt: row.expires_at.toISOString() });
  }));

  app.get('/orgs/:orgId/documents/:documentId/shares', orgRoute('share.list', async (req, res, s) => {
    const doc = await liveDoc(s.orgId, req.params.documentId);
    if (!doc) return s.deny(404, 'not_found', { documentId: req.params.documentId });
    if (s.role === 'viewer') return s.deny(403, 'insufficient_role', { documentId: doc.id });
    const { rows } = await db.query('SELECT * FROM shares WHERE document_id = $1 ORDER BY created_at DESC, id', [doc.id]);
    await s.allow({ documentId: doc.id });
    res.json({ shares: rows.map(shareJson) });
  }));

  app.delete('/orgs/:orgId/shares/:shareId', orgRoute('share.revoke', async (req, res, s) => {
    const share = await one('SELECT * FROM shares WHERE id = $1 AND org_id = $2', [req.params.shareId, s.orgId]);
    if (!share) return s.deny(404, 'not_found', { shareId: req.params.shareId });
    const mayRevoke = RANK[s.role] >= RANK.admin || (s.role === 'member' && share.created_by === s.userId);
    if (!mayRevoke) return s.deny(403, 'insufficient_role', { shareId: share.id, documentId: share.document_id });
    await db.query('UPDATE shares SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1', [share.id]);
    await s.allow({ shareId: share.id, documentId: share.document_id });
    res.status(204).end();
  }));

  app.get('/s/:token', async (req, res, next) => {
    try {
      const share = await one(
        `SELECT s.*, d.name, d.content_type, d.storage_key, d.deleted_at AS doc_deleted
           FROM shares s JOIN documents d ON d.id = s.document_id
          WHERE s.token_hash = $1`,
        [sha256(req.params.token)],
      );
      const refuse = async (reason, status = 404) => {
        await audit({
          action: 'share.download', decision: 'deny', actorId: null,
          orgId: share?.org_id ?? null, documentId: share?.document_id ?? null, shareId: share?.id ?? null, reason,
        });
        return status === 404 ? res.status(404).json(NOT_FOUND) : fail(res, status, reason);
      };
      if (!share) return refuse('unknown_token');
      if (share.revoked_at) return refuse('revoked');
      if (share.doc_deleted) return refuse('document_deleted');
      if (share.expires_at <= new Date()) return refuse('expired');
      if (share.password_hash) {
        const given = req.get('x-share-password');
        if (!given || !(await checkPassword(given, share.password_hash))) return refuse('wrong_password', 401);
      }
      // The cap, decided by one conditional UPDATE so concurrent requests
      // cannot both take the last download.
      const taken = await db.query(
        `UPDATE shares SET download_count = download_count + 1
          WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()
            AND (max_downloads IS NULL OR download_count < max_downloads)
          RETURNING id`,
        [share.id],
      );
      if (taken.rowCount === 0) return refuse('exhausted');
      const bytes = await storage.get(share.storage_key);
      await audit({ action: 'share.download', decision: 'allow', actorId: null, orgId: share.org_id, documentId: share.document_id, shareId: share.id });
      sendBytes(res, share, bytes);
    } catch (e) {
      next(e);
    }
  });

  // --- audit -----------------------------------------------------------------

  const eventJson = (r) => ({
    at: r.at.toISOString(),
    action: r.action,
    decision: r.decision,
    actorId: r.actor_id,
    orgId: r.org_id,
    documentId: r.document_id,
    shareId: r.share_id,
    reason: r.reason,
  });
  const limitOf = (v, dflt, max) => {
    const n = Number(v ?? dflt);
    return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
  };

  app.get('/orgs/:orgId/audit', orgRoute('audit.read', async (req, res, s) => {
    if (RANK[s.role] < RANK.admin) return s.deny(403, 'insufficient_role');
    const limit = limitOf(req.query.limit, 100, 1000);
    if (limit === null) return fail(res, 400, 'invalid_request');
    await s.allow();
    const { rows } = await db.query('SELECT * FROM audit_events WHERE org_id = $1 ORDER BY seq DESC LIMIT $2', [s.orgId, limit]);
    res.json({ events: rows.map(eventJson) });
  }));

  app.get('/admin/audit', async (req, res, next) => {
    try {
      const given = Buffer.from(req.get('x-admin-token') ?? '');
      const want = Buffer.from(adminToken ?? '');
      if (!adminToken || given.length !== want.length || !timingSafeEqual(given, want)) {
        return fail(res, 401, 'unauthenticated');
      }
      const limit = limitOf(req.query.limit, 1000, 10000);
      if (limit === null) return fail(res, 400, 'invalid_request');
      const { rows } = await db.query('SELECT * FROM audit_events ORDER BY seq DESC LIMIT $1', [limit]);
      res.json({ events: rows.map(eventJson) });
    } catch (e) {
      next(e);
    }
  });

  app.use((_req, res) => res.status(404).json(NOT_FOUND));
  // Malformed JSON, an oversized body, anything thrown: never a stack trace.
  app.use((err, _req, res, _next) => {
    if (err?.type === 'entity.too.large') return fail(res, 413, 'too_large');
    if (err?.type === 'entity.parse.failed' || err?.status === 400) return fail(res, 400, 'invalid_request');
    console.error(err);
    return fail(res, 500, 'internal');
  });
  return app;
}
