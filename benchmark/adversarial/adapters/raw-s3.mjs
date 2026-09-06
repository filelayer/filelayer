/**
 * Adapter: baseline-raw-s3, driven through its own express app over HTTP,
 * against the SigV4-verifying local object store its own test harness uses.
 *
 * NOTHING IN THE BASELINE IS MODIFIED. If an attack cannot be expressed against
 * this implementation, the attack records n/a with a reason -- it is never
 * scored as a pass, and the baseline is never made to look worse than it is.
 */
import { createLocalS3 } from '../../baseline-raw-s3/test/local-s3.mjs';
import { openDb } from '../../baseline-raw-s3/src/db.mjs';
import { createStorage } from '../../baseline-raw-s3/src/storage.mjs';
import { createApp } from '../../baseline-raw-s3/src/app.mjs';

const AK = 'AKIAADVERSARIALKEY01';
const SK = 'adversarial-secret-key-do-not-use';

export const meta = {
  name: 'raw-s3',
  executable: true,
  singleBackend: true,
  note: 'src/app.mjs over HTTP + a real SigV4-verifying local S3, share delivery = proxy (its default)',
};

export async function create() {
  const s3 = createLocalS3({ accessKeyId: AK, secretAccessKey: SK });
  const s3Port = await s3.listen(0);
  const db = await openDb();
  const storage = createStorage({
    endpoint: `http://127.0.0.1:${s3Port}`,
    region: 'auto',
    bucket: 'vault',
    accessKeyId: AK,
    secretAccessKey: SK,
  });
  const app = createApp({ db, storage, shareDelivery: 'proxy' });
  const server = await new Promise((r) => {
    const srv = app.listen(0, '127.0.0.1', () => r(srv));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, { as, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(as ? { 'x-user-id': as } : {}),
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

  const user = async (email) => (await call('POST', '/users', { body: { email } })).json.id;

  const alice = await user('alice@a.test');
  const adam = await user('adam@a.test');
  const mallory = await user('mallory@a.test');
  const bob = await user('bob@b.test');
  const eve = await user('eve@b.test');

  const orgA = (await call('POST', '/orgs', { as: alice, body: { name: 'Acme' } })).json.id;
  const orgB = (await call('POST', '/orgs', { as: bob, body: { name: 'Beta' } })).json.id;
  await call('POST', `/orgs/${orgA}/members`, { as: alice, body: { userId: adam, role: 'admin' } });
  await call('POST', `/orgs/${orgA}/members`, { as: alice, body: { userId: mallory, role: 'member' } });
  await call('POST', `/orgs/${orgB}/members`, { as: bob, body: { userId: eve, role: 'member' } });

  // Two-phase presigned upload, which is this platform's real flow.
  const upload = async (name, contentType, payload) => {
    const created = await call('POST', `/orgs/${orgA}/documents`, {
      as: alice,
      body: { name, contentType },
    });
    await fetch(created.json.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: payload,
    });
    await call('POST', `/orgs/${orgA}/documents/${created.json.documentId}/complete`, { as: alice });
    return created.json.documentId;
  };

  const docA = await upload('a.txt', 'text/plain', 'DOC-A-SECRET');
  const docA2 = await upload('a2.txt', 'text/plain', 'DOC-A2-MARKER');

  const w = {
    alice, adam, mallory, bob, eve,
    orgA, orgB,
    docA, docA2,
    docAPrivate: null, // no per-file visibility axis on this platform
    docAExpired: null, // no file-level expiry on this platform
    docA2Marker: 'DOC-A2-MARKER',
    ghostUser: 'usr_00000000000000000000000000',
    ghostDoc: 'doc_00000000000000000000000000',
    ghostDocs: Array.from({ length: 8 }, (_, i) => `doc_ghost${String(i).padStart(20, '0')}`),
  };

  const auditCount = async (org) => {
    if (org === null) return 0; // there is no system chain on this platform
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1`, [
      org,
    ]);
    return Number(rows[0].n);
  };

  return {
    w,
    singleBackend: true,
    close: async () => {
      await new Promise((r) => server.close(r));
      await s3.close();
      await db.close();
    },

    /**
     * The in-app read path issues a PRESIGNED URL; it does not serve bytes. So
     * there are no application response headers to inspect, and reporting
     * their absence as a defect would be a lie about this baseline.
     *
     * For the record, established by reading `src/storage.mjs:presignDownload`:
     * the application DOES pass `ResponseContentDisposition: attachment;
     * filename=...` and `ResponseContentType`, which real S3 honours. The local
     * SigV4 harness does not implement those overrides, so the property is
     * correct-by-code-reading and simply not executable here. The delivery
     * attacks therefore record n/a with that reason, which is the honest
     * verdict and NOT a mark against the baseline.
     */
    read: async ({ as, org, doc }) => {
      const r = await call('GET', `/orgs/${org}/documents/${doc}/download`, { as });
      return {
        status: r.status,
        json: r.json,
        headers: null,
        headersNote:
          'the in-app read issues a presigned URL rather than serving bytes. The application ' +
          'does request ResponseContentDisposition=attachment and ResponseContentType, which ' +
          'real S3 honours; the local harness does not implement those overrides, so this ' +
          'cannot be executed here. Correct by code reading, unverified by execution.',
      };
    },
    list: async ({ as, org }) => {
      const r = await call('GET', `/orgs/${org}/documents`, { as });
      return { status: r.status, ids: (r.json?.documents ?? []).map((d) => d.id) };
    },
    del: ({ as, org, doc }) => call('DELETE', `/orgs/${org}/documents/${doc}`, { as }),

    share: async ({ as, org, doc, opts }) => {
      const r = await call('POST', `/orgs/${org}/documents/${doc}/shares`, {
        as,
        body: {
          expiresInSeconds: opts.expiresInSec ?? 3600,
          ...(opts.maxDownloads ? { maxDownloads: opts.maxDownloads } : {}),
          ...(opts.password ? { password: opts.password } : {}),
        },
      });
      return {
        status: r.status,
        token: r.json?.url?.split('/').pop(),
        shareId: r.json?.shareId,
      };
    },
    redeem: async ({ token, password }) => {
      const r = await call('POST', `/s/${token}/download`, {
        body: password === undefined ? {} : { password },
      });
      return {
        status: r.status,
        body: r.text,
        headers: r.headers,
        deliveredBytes: r.status === 200,
      };
    },
    revoke: ({ as, org, shareId }) => call('POST', `/orgs/${org}/shares/${shareId}/revoke`, { as }),
    expireShare: async ({ shareId }) => {
      await db.query(`UPDATE shares SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
        shareId,
      ]);
      return { status: 204 };
    },
    shareState: async ({ shareId }) => {
      const { rows } = await db.query(`SELECT download_count FROM shares WHERE id = $1`, [shareId]);
      return { downloadCount: Number(rows[0]?.download_count ?? 0) };
    },
    listShares: async () => ({ status: 404, shares: [] }), // no such endpoint

    setRole: ({ as, org, target, role }) =>
      call('POST', `/orgs/${org}/members`, { as, body: { userId: target, role } }),

    audit: async ({ as, org }) => {
      const r = await call('GET', `/orgs/${org}/audit`, { as });
      const events = r.json?.events ?? (Array.isArray(r.json) ? r.json : []);
      return { status: r.status, events };
    },
    auditEvents: async ({ org }) => {
      const { rows } = await db.query(`SELECT action FROM audit_log WHERE org_id = $1`, [org]);
      return rows;
    },
    countAudit: ({ org }) => auditCount(org),

    uploadHtml: async () => ({ doc: await upload('evil.html', 'text/html', '<script>x</script>') }),
    uploadNamed: async ({ name }) => ({ doc: await upload(name, 'text/plain', 'x') }),

    delegate: async () => ({
      unsupported: true,
      detail:
        'this platform has no delegation model: a share link is an opaque token with no ' +
        'lineage, so there is no "pass on the authority you were given" operation to attack. ' +
        'Recorded as n/a, not as a defence.',
    }),
  };
}
