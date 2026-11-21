/**
 * A client for the contract, and the world every hidden check starts from.
 * It speaks only HTTP: nothing here knows how an implementation stores
 * anything, so the same checks run unchanged against both arms.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export function client(baseUrl, adminToken) {
  async function call(method, path, { as, body, headers = {} } = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(as !== undefined ? { 'x-user-id': as } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    const text = bytes.toString('utf8');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* bytes, not JSON */
    }
    const h = {};
    res.headers.forEach((v, k) => (h[k] = v));
    return { status: res.status, json, text, bytes, headers: h };
  }
  const adminAudit = async () =>
    (await call('GET', '/admin/audit?limit=10000', { headers: { 'x-admin-token': adminToken } })).json?.events ?? [];
  return { call, adminAudit, baseUrl };
}

const b64 = (s) => Buffer.from(s).toString('base64');

/**
 * An id that does not exist, in the same shape as a real one of this
 * implementation: a UUID for a UUID, the same prefix and length for
 * `doc_<hex>`, a large number for a number, otherwise the same characters'
 * classes. A missing id that is shaped differently from the real ones can be
 * refused for being malformed, which would test the parser rather than the
 * existence oracle (cold review: the ghosts used to copy arm B's format).
 */
export function ghostLike(id) {
  const s = String(id);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return randomUUID();
  const m = s.match(/^(.*[_-])([0-9a-f]+)$/i);
  if (m) return m[1] + randomBytes(m[2].length).toString('hex').slice(0, m[2].length);
  if (/^\d+$/.test(s)) return String(Number(s) + 1_000_000_007);
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  return s.replace(/[0-9]/g, () => pick('0123456789')).replace(/[a-z]/g, () => pick('abcdefghijklmnopqrstuvwxyz'))
    .replace(/[A-Z]/g, () => pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
}

/**
 * Two orgs. Acme (orgA): alice owner, adam admin, mallory member, vera viewer.
 * Beta (orgB): bob owner, eve member. Two documents in Acme, uploaded by alice.
 */
export async function buildWorld(c) {
  const tag = Math.random().toString(36).slice(2, 8);
  const user = async (name) => {
    const r = await c.call('POST', '/users', { body: { email: `${name}.${tag}@example.test` } });
    if (r.status !== 201 || !r.json?.id) throw new Error(`POST /users for ${name} answered ${r.status}`);
    return r.json.id;
  };
  const w = {};
  for (const n of ['alice', 'adam', 'mallory', 'vera', 'bob', 'eve']) w[n] = await user(n);
  const org = async (as, name) => {
    const r = await c.call('POST', '/orgs', { as, body: { name } });
    if (r.status !== 201 || !r.json?.id) throw new Error(`POST /orgs answered ${r.status}`);
    return r.json.id;
  };
  w.orgA = await org(w.alice, 'Acme');
  w.orgB = await org(w.bob, 'Beta');
  const member = async (orgId, as, target, role) => {
    const r = await c.call('PUT', `/orgs/${orgId}/members/${target}`, { as, body: { role } });
    if (r.status !== 200) throw new Error(`PUT member ${role} answered ${r.status}`);
  };
  await member(w.orgA, w.alice, w.adam, 'admin');
  await member(w.orgA, w.alice, w.mallory, 'member');
  await member(w.orgA, w.alice, w.vera, 'viewer');
  await member(w.orgB, w.bob, w.eve, 'member');
  w.upload = async (as, orgId, name, contentType, content) => {
    const r = await c.call('POST', `/orgs/${orgId}/documents`, {
      as, body: { name, contentType, content: b64(content) },
    });
    if (r.status !== 201 || !r.json?.id) throw new Error(`upload answered ${r.status}: ${r.text.slice(0, 200)}`);
    return r.json.id;
  };
  w.docA = await w.upload(w.alice, w.orgA, 'a.txt', 'text/plain', 'DOC-A-SECRET');
  w.docA2 = await w.upload(w.alice, w.orgA, 'a2.txt', 'text/plain', 'DOC-A2-MARKER');
  w.docA2Marker = 'DOC-A2-MARKER';
  w.ghostUser = `usr_${'0'.repeat(24)}`;
  // Missing ids shaped like this implementation's real ones, and one of the
  // other common shape, so F14 sees both.
  w.ghostDoc = ghostLike(w.docA);
  w.ghostDocs = Array.from({ length: 8 }, () => ghostLike(w.docA));
  w.ghostDocOtherShape = /^[0-9a-f]{8}-/i.test(String(w.docA)) ? `doc_${'0'.repeat(24)}` : '00000000-0000-4000-8000-000000000000';
  w.docAPrivate = null; // the contract has no per-document visibility
  w.docAExpired = null; // the contract has no document expiry
  return w;
}

export const tokenOf = (url) => (typeof url === 'string' ? url.split('/s/').pop() : undefined);
