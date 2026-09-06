import express from 'express';
import crypto from 'node:crypto';
import {
  HttpError, requireMember, canManageDocument, canCreateShare,
  canRevokeShare, canReadAudit, canAssignRole, membership, ROLES,
} from './authz.mjs';
import { appendAudit, verifyChain } from './audit.mjs';
import { mintShareToken, hashToken, hashPassword, verifyPassword, shareState } from './shares.mjs';
import { DOWNLOAD_URL_TTL_SECONDS } from './storage.mjs';

const id = (p) => `${p}_${crypto.randomBytes(12).toString('hex')}`;

/**
 * Runs `fn` inside a transaction that holds a row lock on the org, so audit
 * chain appends are serialised. Every mutating route MUST go through this;
 * forgetting it forks the audit chain silently.
 */
async function inOrgTx(db, orgId, fn) {
  return db.transaction(async (tx) => {
    await tx.query('SELECT id FROM orgs WHERE id = $1 FOR UPDATE', [orgId]);
    return fn(tx);
  });
}

export function createApp({ db, storage, shareDelivery = 'proxy', baseUrl = 'http://localhost:3000' }) {
  const app = express();
  app.use(express.json());

  /**
   * Stand-in for a real session layer. A production build would use signed
   * cookies / OIDC here; that plumbing is identical across every baseline and
   * is excluded from the LOC count.
   */
  app.use((req, _res, next) => {
    req.userId = req.get('x-user-id') ?? null;
    next();
  });
  const requireUser = (req) => {
    if (!req.userId) throw new HttpError(401, 'unauthenticated');
    return req.userId;
  };

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

  // ---------------------------------------------------------------- orgs

  app.post('/users', wrap(async (req, res) => {
    const userId = id('usr');
    await db.query('INSERT INTO users (id, email) VALUES ($1, $2)', [userId, req.body.email]);
    res.status(201).json({ id: userId, email: req.body.email });
  }));

  app.post('/orgs', wrap(async (req, res) => {
    const userId = requireUser(req);
    const orgId = id('org');
    await db.transaction(async (tx) => {
      await tx.query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [orgId, req.body.name]);
      await tx.query(
        'INSERT INTO memberships (org_id, user_id, role) VALUES ($1, $2, $3)',
        [orgId, userId, 'owner']
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: userId, action: 'org.created',
        subjectType: 'org', subjectId: orgId, metadata: { name: req.body.name },
      });
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: userId, action: 'membership.created',
        subjectType: 'user', subjectId: userId, metadata: { role: 'owner' },
      });
    });
    res.status(201).json({ id: orgId, name: req.body.name });
  }));

  app.post('/orgs/:orgId/members', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId } = req.params;
    const actorRole = await requireMember(db, orgId, actor, 'admin');
    const { userId, role } = req.body;
    if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    if (!canAssignRole(actorRole, null, role)) throw new HttpError(403, 'forbidden');

    await inOrgTx(db, orgId, async (tx) => {
      await tx.query(
        `INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [orgId, userId, role]
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'membership.created',
        subjectType: 'user', subjectId: userId, metadata: { role },
      });
    });
    res.status(201).json({ orgId, userId, role });
  }));

  app.patch('/orgs/:orgId/members/:userId', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId, userId } = req.params;
    const actorRole = await requireMember(db, orgId, actor, 'admin');
    const target = await membership(db, orgId, userId);
    if (!target) throw new HttpError(404, 'not_found');
    const { role } = req.body;
    if (!ROLES.includes(role)) throw new HttpError(400, 'invalid_role');
    if (!canAssignRole(actorRole, target, role)) throw new HttpError(403, 'forbidden');

    // Never let the last owner be demoted — otherwise the org is unadministrable.
    if (target === 'owner' && role !== 'owner') {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'`,
        [orgId]
      );
      if (rows[0].n <= 1) throw new HttpError(409, 'last_owner');
    }

    await inOrgTx(db, orgId, async (tx) => {
      await tx.query(
        'UPDATE memberships SET role = $3 WHERE org_id = $1 AND user_id = $2',
        [orgId, userId, role]
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'membership.role_changed',
        subjectType: 'user', subjectId: userId, metadata: { from: target, to: role },
      });
    });
    res.json({ orgId, userId, role });
  }));

  // ----------------------------------------------------------- documents

  // Two-phase upload: reserve a row, hand back a short-lived presigned PUT,
  // then have the client confirm. See REPORT.md §6 for the four failure
  // interleavings this creates.
  app.post('/orgs/:orgId/documents', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId } = req.params;
    await requireMember(db, orgId, actor, 'member');
    const { name, contentType } = req.body;
    if (!name || !contentType) throw new HttpError(400, 'invalid_body');

    const docId = id('doc');
    const key = storage.keyFor(orgId, docId);
    await db.query(
      `INSERT INTO documents (id, org_id, uploader_id, name, content_type, storage_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [docId, orgId, actor, name, contentType, key]
    );
    const uploadUrl = await storage.presignUpload(key, contentType);
    res.status(201).json({ documentId: docId, uploadUrl, requiredContentType: contentType });
  }));

  app.post('/orgs/:orgId/documents/:docId/complete', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId, docId } = req.params;
    await requireMember(db, orgId, actor, 'member');
    const doc = await loadDoc(db, orgId, docId, ['pending']);
    if (doc.uploader_id !== actor) throw new HttpError(403, 'forbidden');

    // Trust nothing the client says about the object: ask S3.
    const meta = await storage.head(doc.storage_key);
    if (!meta.exists) throw new HttpError(409, 'object_missing');

    await inOrgTx(db, orgId, async (tx) => {
      await tx.query(
        `UPDATE documents SET status='ready', size_bytes=$2, completed_at=now() WHERE id=$1`,
        [docId, meta.size]
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'document.uploaded',
        subjectType: 'document', subjectId: docId,
        metadata: { name: doc.name, size: meta.size },
      });
    });
    res.json({ documentId: docId, status: 'ready', size: meta.size });
  }));

  app.get('/orgs/:orgId/documents', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId } = req.params;
    await requireMember(db, orgId, actor, 'viewer');
    const { rows } = await db.query(
      `SELECT id, name, content_type, size_bytes, uploader_id, created_at
         FROM documents WHERE org_id = $1 AND status = 'ready' ORDER BY created_at DESC`,
      [orgId]
    );
    res.json({ documents: rows });
  }));

  app.get('/orgs/:orgId/documents/:docId/download', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId, docId } = req.params;
    await requireMember(db, orgId, actor, 'viewer');
    const doc = await loadDoc(db, orgId, docId, ['ready']);

    const url = await storage.presignDownload(doc.storage_key, {
      filename: doc.name,
      contentType: doc.content_type,
    });
    await inOrgTx(db, orgId, (tx) =>
      appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'document.downloaded',
        subjectType: 'document', subjectId: docId,
        // We log that we ISSUED a URL. We cannot log whether it was used, how
        // many times, or from where — S3 access logs are the only source for
        // that and they are delayed and in a different system. REPORT.md §7.
        metadata: { via: 'presigned_url', ttlSeconds: DOWNLOAD_URL_TTL_SECONDS },
      })
    );
    res.json({ url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS });
  }));

  app.delete('/orgs/:orgId/documents/:docId', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId, docId } = req.params;
    const role = await requireMember(db, orgId, actor, 'member');
    const doc = await loadDoc(db, orgId, docId, ['ready', 'pending']);
    if (!canManageDocument(role, doc, actor)) throw new HttpError(403, 'forbidden');

    await inOrgTx(db, orgId, async (tx) => {
      await tx.query(`UPDATE documents SET status='deleted', deleted_at=now() WHERE id=$1`, [docId]);
      await tx.query(
        `UPDATE shares SET revoked_at = now() WHERE document_id = $1 AND revoked_at IS NULL`,
        [docId]
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'document.deleted',
        subjectType: 'document', subjectId: docId, metadata: {},
      });
    });
    // Object deletion is a separate system and can fail independently of the
    // transaction above. Orphans are reaped by sweepOrphans(). REPORT.md §8.
    await storage.remove(doc.storage_key).catch(() => {});
    res.status(204).end();
  }));

  // -------------------------------------------------------------- shares

  app.post('/orgs/:orgId/documents/:docId/shares', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId, docId } = req.params;
    const role = await requireMember(db, orgId, actor, 'viewer');
    if (!canCreateShare(role)) throw new HttpError(403, 'forbidden');
    await loadDoc(db, orgId, docId, ['ready']);

    const { expiresInSeconds, password, maxDownloads } = req.body;
    if (!Number.isInteger(expiresInSeconds) || expiresInSeconds <= 0) {
      throw new HttpError(400, 'invalid_expiry');
    }
    if (maxDownloads !== undefined && maxDownloads !== null &&
        (!Number.isInteger(maxDownloads) || maxDownloads <= 0)) {
      throw new HttpError(400, 'invalid_max_downloads');
    }

    const { token, tokenHash } = mintShareToken();
    const pw = password ? await hashPassword(password) : null;
    const shareId = id('shr');
    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    await inOrgTx(db, orgId, async (tx) => {
      await tx.query(
        `INSERT INTO shares (id, org_id, document_id, created_by, token_hash,
                             password_hash, password_salt, expires_at, max_downloads)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [shareId, orgId, docId, actor, tokenHash, pw?.hash ?? null, pw?.salt ?? null,
         expiresAt.toISOString(), maxDownloads ?? null]
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'share.created',
        subjectType: 'share', subjectId: shareId,
        metadata: { documentId: docId, expiresAt: expiresAt.toISOString(),
                    hasPassword: Boolean(password), maxDownloads: maxDownloads ?? null },
      });
    });
    res.status(201).json({
      shareId,
      url: `${baseUrl}/s/${token}`,
      expiresAt: expiresAt.toISOString(),
    });
  }));

  app.post('/orgs/:orgId/shares/:shareId/revoke', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId, shareId } = req.params;
    const role = await requireMember(db, orgId, actor, 'viewer');
    const { rows } = await db.query(
      'SELECT * FROM shares WHERE id = $1 AND org_id = $2', [shareId, orgId]
    );
    const share = rows[0];
    if (!share) throw new HttpError(404, 'not_found');
    if (!canRevokeShare(role, share, actor)) throw new HttpError(403, 'forbidden');

    await inOrgTx(db, orgId, async (tx) => {
      await tx.query(
        'UPDATE shares SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [shareId]
      );
      await appendAudit(tx, {
        orgId, actorKind: 'user', actorId: actor, action: 'share.revoked',
        subjectType: 'share', subjectId: shareId, metadata: { documentId: share.document_id },
      });
    });
    res.status(204).end();
  }));

  async function loadShareByToken(token) {
    const { rows } = await db.query(
      `SELECT s.*, d.name AS doc_name, d.content_type AS doc_content_type,
              d.storage_key, d.status AS doc_status, d.size_bytes
         FROM shares s JOIN documents d ON d.id = s.document_id
        WHERE s.token_hash = $1`,
      [hashToken(token)]
    );
    return rows[0] ?? null;
  }

  app.get('/s/:token', wrap(async (req, res) => {
    const share = await loadShareByToken(req.params.token);
    if (!share) throw new HttpError(404, 'not_found');
    const state = shareState(share);
    if (state !== 'active') throw new HttpError(410, state);
    res.json({
      name: share.doc_name,
      size: share.size_bytes === null ? null : Number(share.size_bytes),
      requiresPassword: Boolean(share.password_hash),
      expiresAt: share.expires_at,
      downloadsRemaining:
        share.max_downloads === null ? null : share.max_downloads - share.download_count,
    });
  }));

  /**
   * Anonymous share download. This is the crux of the whole benchmark.
   *
   * The share link CANNOT be a presigned S3 URL, because a presigned URL is a
   * bearer token that S3 will honour until its own expiry no matter what the
   * database says. "Revocation takes effect immediately even for links
   * already issued" is therefore only satisfiable if every byte is authorised
   * by us at request time. So the default delivery mode proxies the object
   * through this process.
   *
   * `shareDelivery: 'redirect'` is the cheap alternative a team under egress
   * pressure will reach for: validate, then 302 to a short-TTL presigned URL.
   * It is provided so the benchmark can measure exactly what it costs you —
   * see the revocation-window test. It fails OPEN for the length of the TTL.
   */
  app.post('/s/:token/download', wrap(async (req, res) => {
    const share = await loadShareByToken(req.params.token);
    if (!share) throw new HttpError(404, 'not_found');

    if (share.password_hash) {
      const supplied = req.body?.password;
      const ok = typeof supplied === 'string' &&
        (await verifyPassword(supplied, share.password_hash, share.password_salt));
      if (!ok) {
        await inOrgTx(db, share.org_id, (tx) =>
          appendAudit(tx, {
            orgId: share.org_id, actorKind: 'anonymous', actorId: null,
            action: 'share.password_failed', subjectType: 'share', subjectId: share.id,
            metadata: { ip: req.ip },
          })
        );
        throw new HttpError(401, 'bad_password');
      }
    }

    // Single atomic statement: re-checks revocation, expiry and the download
    // cap and consumes one unit, all under one row lock. Doing this as a
    // read-then-write would let two concurrent requests both pass a
    // max_downloads=1 check.
    const { rows } = await db.query(
      `UPDATE shares SET download_count = download_count + 1
        WHERE id = $1
          AND revoked_at IS NULL
          AND expires_at > now()
          AND (max_downloads IS NULL OR download_count < max_downloads)
        RETURNING download_count`,
      [share.id]
    );
    if (rows.length === 0) throw new HttpError(410, shareState(share));
    if (share.doc_status !== 'ready') throw new HttpError(410, 'document_unavailable');

    await inOrgTx(db, share.org_id, (tx) =>
      appendAudit(tx, {
        orgId: share.org_id, actorKind: 'anonymous', actorId: null,
        action: 'share.downloaded', subjectType: 'share', subjectId: share.id,
        metadata: { documentId: share.document_id, ip: req.ip,
                    downloadCount: rows[0].download_count, delivery: shareDelivery },
      })
    );

    if (shareDelivery === 'redirect') {
      const url = await storage.presignDownload(share.storage_key, {
        filename: share.doc_name, contentType: share.doc_content_type, ttl: 30,
      });
      return res.status(302).set('location', url).end();
    }

    const obj = await storage.getStream(share.storage_key);
    res.set({
      'content-type': share.doc_content_type,
      'content-length': String(obj.size),
      'content-disposition': `attachment; filename="${share.doc_name.replace(/"/g, '')}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    });
    obj.stream.pipe(res);
  }));

  // --------------------------------------------------------------- audit

  app.get('/orgs/:orgId/audit', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId } = req.params;
    const role = await requireMember(db, orgId, actor, 'viewer');
    if (!canReadAudit(role)) throw new HttpError(403, 'forbidden');
    const { rows } = await db.query(
      `SELECT org_seq, actor_kind, actor_id, action, subject_type, subject_id, metadata, at, hash
         FROM audit_log WHERE org_id = $1 ORDER BY org_seq ASC LIMIT 500`,
      [orgId]
    );
    res.json({ entries: rows });
  }));

  app.get('/orgs/:orgId/audit/verify', wrap(async (req, res) => {
    const actor = requireUser(req);
    const { orgId } = req.params;
    const role = await requireMember(db, orgId, actor, 'viewer');
    if (!canReadAudit(role)) throw new HttpError(403, 'forbidden');
    res.json(await verifyChain(db, orgId));
  }));

  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.code });
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}

/** Loads a document, enforcing the org boundary in the same query. */
async function loadDoc(db, orgId, docId, statuses) {
  const { rows } = await db.query(
    `SELECT * FROM documents WHERE id = $1 AND org_id = $2`, [docId, orgId]
  );
  const doc = rows[0];
  if (!doc || !statuses.includes(doc.status)) throw new HttpError(404, 'not_found');
  return doc;
}

/**
 * Lifecycle reaper. Must run on a schedule (cron / Lambda / worker) because
 * nothing in S3 or Postgres does any of this for you:
 *  1. `pending` documents whose presigned upload URL has long expired and
 *     which were never confirmed — delete the row and any stray object.
 *  2. Expired / exhausted shares — nothing to delete, but they should stop
 *     being counted; kept for the audit trail.
 *  3. Objects in the bucket with no `ready` row (a client that PUT to a
 *     presigned URL and then never called /complete). Finding these requires
 *     a full bucket LIST reconciled against the database.
 */
export async function sweepOrphans(db, storage, { pendingGraceSeconds = 900 } = {}) {
  const { rows } = await db.query(
    `SELECT id, org_id, storage_key FROM documents
      WHERE status = 'pending' AND created_at < now() - ($1 || ' seconds')::interval`,
    [pendingGraceSeconds]
  );
  let removed = 0;
  for (const doc of rows) {
    await storage.remove(doc.storage_key).catch(() => {});
    await db.query(`DELETE FROM documents WHERE id = $1`, [doc.id]);
    removed++;
  }
  return { abandonedUploadsReaped: removed };
}
