// =====================================================================
// src/platform/supabase.js
// =====================================================================
// *** NOT APPLICATION CODE. EXCLUDED FROM ALL LOC COUNTS. ***
//
// Emulation of the parts of a Supabase project that Supabase operates for
// you: the PostgREST/Storage request path (SET LOCAL ROLE + request.jwt.claims),
// the Storage object API, and signed-URL minting/verification.
//
// Fidelity notes, each traceable to a doc page:
//
//  * Per-request role + claims. PostgREST and the Storage API open a
//    transaction, `SET LOCAL ROLE` to anon/authenticated, and set the
//    `request.jwt.claims` GUC from the verified JWT. auth.uid()/auth.jwt()
//    read that GUC. Service key -> role `service_role`, which has BYPASSRLS.
//    https://supabase.com/docs/guides/storage/security/access-control
//
//  * Signed URLs are stateless JWTs signed with a per-project storage key that
//    is separate from the Auth JWT signing key, and are "not affected by
//    rotating or revoking Auth JWT legacy secret or signing key ... Signed
//    URLs remain valid until their expiry time regardless of any Auth key
//    changes. If you need to revoke signed URLs, contact Supabase support."
//    https://supabase.com/docs/guides/storage/serving/downloads
//    Consequently verifySignedUrl() below performs NO database lookup and NO
//    RLS evaluation. That is faithful, not a shortcut.
//
//  * createSignedUrl DOES require SELECT permission on the object at signing
//    time, so signing runs through RLS with operation `object.sign`.
// =====================================================================

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uJson = (o) => b64u(Buffer.from(JSON.stringify(o), 'utf8'));
const unb64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function sign(payload, secret) {
  const head = b64uJson({ alg: 'HS256', typ: 'JWT' });
  const body = b64uJson(payload);
  const mac = b64u(createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${mac}`;
}

function verify(token, secret, nowMs) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [head, body, mac] = parts;
  const expect = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const got = unb64u(mac);
  if (got.length !== expect.length || !timingSafeEqual(got, expect))
    return { ok: false, reason: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(unb64u(body).toString('utf8')); }
  catch { return { ok: false, reason: 'malformed' }; }
  if (typeof payload.exp === 'number' && nowMs / 1000 >= payload.exp)
    return { ok: false, reason: 'expired' };
  return { ok: true, payload };
}

export class SupabaseProject {
  // storageSigningKey is deliberately a DIFFERENT secret from jwtSecret.
  constructor(db, { jwtSecret, storageSigningKey, projectRef = 'demoproj', clock = () => Date.now() }) {
    this.db = db;
    this.jwtSecret = jwtSecret;
    this.storageSigningKey = storageSigningKey;
    this.projectRef = projectRef;
    this.now = clock;
    this.blobs = new Map();          // `${bucket}/${name}` -> Buffer (S3 stand-in)
    this.egress = [];                // observability for tests
  }

  issueAccessToken(userId, extraClaims = {}, ttlSec = 3600) {
    const iat = Math.floor(this.now() / 1000);
    return sign({ sub: userId, role: 'authenticated', iat, exp: iat + ttlSec, ...extraClaims },
                this.jwtSecret);
  }

  // ---- request path -------------------------------------------------
  async #tx(role, claims, operation, fn) {
    await this.db.exec('begin');
    try {
      await this.db.exec(`set local role ${role}`);
      await this.db.query('select set_config($1,$2,true)',
        ['request.jwt.claims', claims ? JSON.stringify(claims) : '']);
      await this.db.query('select set_config($1,$2,true)',
        ['storage.operation', operation || '']);
      const out = await fn({
        query: (sql, params = []) => this.db.query(sql, params),
        exec: (sql) => this.db.exec(sql),
      });
      await this.db.exec('commit');
      return out;
    } catch (e) {
      try { await this.db.exec('rollback'); } catch { /* already aborted */ }
      throw e;
    }
  }

  #claimsFor(accessToken) {
    const v = verify(accessToken, this.jwtSecret, this.now());
    if (!v.ok) throw new Error(`invalid access token: ${v.reason}`);
    return v.payload;
  }

  /** Run SQL exactly as PostgREST would for a logged-in user. */
  asUser(accessToken, fn, operation = '') {
    return this.#tx('authenticated', this.#claimsFor(accessToken), operation, fn);
  }
  asAnon(fn, operation = '') {
    return this.#tx('anon', { role: 'anon' }, operation, fn);
  }
  /** Service key: bypasses RLS entirely. */
  asService(fn, operation = '') {
    return this.#tx('service_role', { role: 'service_role' }, operation, fn);
  }

  // ---- storage API --------------------------------------------------
  async upload(accessToken, bucket, name, bytes, { mimeType = 'application/octet-stream' } = {}) {
    const claims = this.#claimsFor(accessToken);
    await this.#tx('authenticated', claims, 'object.upload', async (c) => {
      await c.query(
        `insert into storage.objects (bucket_id, name, owner_id, version, metadata)
         values ($1,$2,$3,$4,$5)`,
        [bucket, name, claims.sub, String(this.now()),
         JSON.stringify({ size: bytes.length, mimetype: mimeType })]);
    });
    this.blobs.set(`${bucket}/${name}`, Buffer.from(bytes));
    return { bucket, name };
  }

  /** GET /storage/v1/object/authenticated/{bucket}/{name} -- RLS applies. */
  async downloadAuthenticated(accessToken, bucket, name) {
    const rows = await this.asUser(accessToken, (c) =>
      c.query('select id from storage.objects where bucket_id=$1 and name=$2', [bucket, name]),
      'object.get_authenticated');
    if (rows.rows.length === 0) { const e = new Error('Object not found'); e.status = 404; throw e; }
    const blob = this.blobs.get(`${bucket}/${name}`);
    this.egress.push({ via: 'authenticated', bucket, name, at: this.now() });
    return blob;
  }

  async list(accessToken, bucket, prefix) {
    const r = await this.asUser(accessToken, (c) =>
      c.query('select name from storage.objects where bucket_id=$1 and name like $2 order by name',
              [bucket, `${prefix}%`]), 'object.list');
    return r.rows.map((x) => x.name);
  }

  /** storage.from(b).createSignedUrl(path, expiresIn) -- RLS-checked at sign time. */
  async createSignedUrl(accessToken, bucket, name, expiresInSec) {
    const r = await this.asUser(accessToken, (c) =>
      c.query('select id from storage.objects where bucket_id=$1 and name=$2', [bucket, name]),
      'object.sign');
    if (r.rows.length === 0) { const e = new Error('Object not found'); e.status = 400; throw e; }
    return this.#mint(bucket, name, expiresInSec);
  }

  /** Same call made with the service key: no RLS at all. */
  async createSignedUrlAsService(bucket, name, expiresInSec) {
    const r = await this.asService((c) =>
      c.query('select id from storage.objects where bucket_id=$1 and name=$2', [bucket, name]),
      'object.sign');
    if (r.rows.length === 0) { const e = new Error('Object not found'); e.status = 400; throw e; }
    return this.#mint(bucket, name, expiresInSec);
  }

  #mint(bucket, name, expiresInSec) {
    const iat = Math.floor(this.now() / 1000);
    const token = sign({ url: `${bucket}/${name}`, iat, exp: iat + expiresInSec },
                       this.storageSigningKey);
    return { signedUrl:
      `https://${this.projectRef}.supabase.co/storage/v1/object/sign/${bucket}/${name}?token=${token}` };
  }

  /**
   * GET on a signed URL. Signature + exp only. No DB read, no RLS, no
   * revocation list. This is the documented behaviour and it is the single
   * most consequential fact about this baseline.
   */
  async fetchSignedUrl(signedUrl) {
    const u = new URL(signedUrl);
    const m = u.pathname.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (!m) { const e = new Error('Bad request'); e.status = 400; throw e; }
    const bucket = decodeURIComponent(m[1]);
    const name = decodeURIComponent(m[2]);
    const v = verify(u.searchParams.get('token'), this.storageSigningKey, this.now());
    if (!v.ok) { const e = new Error(v.reason); e.status = 400; throw e; }
    if (v.payload.url !== `${bucket}/${name}`) {
      const e = new Error('token/path mismatch'); e.status = 400; throw e;
    }
    const blob = this.blobs.get(`${bucket}/${name}`);
    if (!blob) { const e = new Error('Object not found'); e.status = 404; throw e; }
    this.egress.push({ via: 'signed', bucket, name, at: this.now() });
    return blob;
  }

  /** storage.from(b).move(from, to) -- metadata rename + backend copy. */
  async moveAsService(bucket, from, to) {
    await this.asService((c) =>
      c.query('update storage.objects set name=$3, updated_at=now() where bucket_id=$1 and name=$2',
              [bucket, from, to]), 'object.move');
    const blob = this.blobs.get(`${bucket}/${from}`);
    this.blobs.delete(`${bucket}/${from}`);
    this.blobs.set(`${bucket}/${to}`, blob);
  }
}
