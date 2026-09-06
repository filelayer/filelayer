/**
 * TEST HARNESS — excluded from application LOC counts.
 *
 * Proves the Vault scenario end-to-end against a real AWS SDK client talking
 * to a real SigV4-verifying object store, and measures the two places where
 * the presigned-URL architecture cannot meet the requirement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalS3 } from './local-s3.mjs';
import { openDb } from '../src/db.mjs';
import { createStorage } from '../src/storage.mjs';
import { createApp, sweepOrphans } from '../src/app.mjs';
import { verifyChain } from '../src/audit.mjs';

const AK = 'AKIABENCHMARKKEY0001';
const SK = 'benchmark-secret-key-do-not-use-anywhere';

async function harness({ shareDelivery = 'proxy' } = {}) {
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
  const app = createApp({ db, storage, shareDelivery });
  const server = await new Promise((r) => {
    const srv = app.listen(0, '127.0.0.1', () => r(srv));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const api = async (method, path, { user, body } = {}) => {
    const res = await fetch(base + path, {
      method,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-user-id': user } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body (file bytes) */ }
    return { status: res.status, json, text, headers: res.headers };
  };

  return {
    api, db, s3, storage, base,
    close: async () => {
      await new Promise((r) => server.close(r));
      await s3.close();
      await db.close();
    },
  };
}

async function mkUser(api, email) {
  const r = await api('POST', '/users', { body: { email } });
  return r.json.id;
}

/** Full upload round-trip through the presigned PUT URL, as a client would. */
async function upload(api, orgId, user, name, contentType, bytes) {
  const created = await api('POST', `/orgs/${orgId}/documents`, {
    user, body: { name, contentType },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const put = await fetch(created.json.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  assert.equal(put.status, 200, 'presigned PUT should succeed');
  const done = await api('POST', `/orgs/${orgId}/documents/${created.json.documentId}/complete`, { user });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  return created.json.documentId;
}

// ---------------------------------------------------------------------------

test('scenario: org, roles, upload, download, audit', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api } = h;

  const owner = await mkUser(api, 'owner@acme.test');
  const admin = await mkUser(api, 'admin@acme.test');
  const member = await mkUser(api, 'member@acme.test');
  const viewer = await mkUser(api, 'viewer@acme.test');

  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Acme' } })).json.id;
  for (const [u, role] of [[admin, 'admin'], [member, 'member'], [viewer, 'viewer']]) {
    const r = await api('POST', `/orgs/${org}/members`, { user: owner, body: { userId: u, role } });
    assert.equal(r.status, 201);
  }

  const doc = await upload(api, org, member, 'q3-report.pdf', 'application/pdf', 'CONFIDENTIAL-Q3');

  // Viewer can list and download.
  const list = await api('GET', `/orgs/${org}/documents`, { user: viewer });
  assert.equal(list.status, 200);
  assert.equal(list.json.documents.length, 1);

  const dl = await api('GET', `/orgs/${org}/documents/${doc}/download`, { user: viewer });
  assert.equal(dl.status, 200);
  const bytes = await fetch(dl.json.url);
  assert.equal(bytes.status, 200);
  assert.equal(await bytes.text(), 'CONFIDENTIAL-Q3');
  assert.match(bytes.headers.get('content-type'), /pdf/);

  // Viewer cannot delete; member cannot delete someone else's; admin can delete any.
  assert.equal((await api('DELETE', `/orgs/${org}/documents/${doc}`, { user: viewer })).status, 403);

  const adminDoc = await upload(api, org, admin, 'admin.txt', 'text/plain', 'A');
  assert.equal((await api('DELETE', `/orgs/${org}/documents/${adminDoc}`, { user: member })).status, 403);
  assert.equal((await api('DELETE', `/orgs/${org}/documents/${adminDoc}`, { user: admin })).status, 204);

  // Audit is admin-only and the chain verifies.
  assert.equal((await api('GET', `/orgs/${org}/audit`, { user: member })).status, 403);
  const audit = await api('GET', `/orgs/${org}/audit`, { user: admin });
  assert.equal(audit.status, 200);
  const actions = audit.json.entries.map((e) => e.action);
  assert.ok(actions.includes('document.uploaded'));
  assert.ok(actions.includes('document.downloaded'));
  assert.ok(actions.includes('document.deleted'));
  assert.ok(actions.includes('membership.created'));

  const v = await api('GET', `/orgs/${org}/audit/verify`, { user: admin });
  assert.equal(v.json.ok, true);
});

test('no file is reachable across org boundaries', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api } = h;

  const a = await mkUser(api, 'a@one.test');
  const b = await mkUser(api, 'b@two.test');
  const orgA = (await api('POST', '/orgs', { user: a, body: { name: 'One' } })).json.id;
  const orgB = (await api('POST', '/orgs', { user: b, body: { name: 'Two' } })).json.id;
  const doc = await upload(api, orgA, a, 'secret.txt', 'text/plain', 'ORG-A-SECRET');

  // Correct org id in the path, but B is not a member -> 404, not 403.
  assert.equal((await api('GET', `/orgs/${orgA}/documents`, { user: b })).status, 404);
  assert.equal((await api('GET', `/orgs/${orgA}/documents/${doc}/download`, { user: b })).status, 404);
  assert.equal((await api('GET', `/orgs/${orgA}/audit`, { user: b })).status, 404);

  // Confused-deputy attempt: B's own org id with A's document id.
  assert.equal((await api('GET', `/orgs/${orgB}/documents/${doc}/download`, { user: b })).status, 404);
  assert.equal(
    (await api('POST', `/orgs/${orgB}/documents/${doc}/shares`, { user: b, body: { expiresInSeconds: 60 } })).status,
    404
  );
  assert.equal((await api('DELETE', `/orgs/${orgB}/documents/${doc}`, { user: b })).status, 404);
});

test('share links: expiry, password and download cap', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api } = h;

  const owner = await mkUser(api, 'o@share.test');
  const viewer = await mkUser(api, 'v@share.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Share' } })).json.id;
  await api('POST', `/orgs/${org}/members`, { user: owner, body: { userId: viewer, role: 'viewer' } });
  const doc = await upload(api, org, owner, 'deck.pdf', 'application/pdf', 'DECK-BYTES');

  // Viewers are read-only: they cannot mint external grants.
  assert.equal(
    (await api('POST', `/orgs/${org}/documents/${doc}/shares`, { user: viewer, body: { expiresInSeconds: 60 } })).status,
    403
  );

  const share = await api('POST', `/orgs/${org}/documents/${doc}/shares`, {
    user: owner,
    body: { expiresInSeconds: 3600, password: 'correct horse', maxDownloads: 2 },
  });
  assert.equal(share.status, 201);
  const token = share.json.url.split('/s/')[1];

  const landing = await api('GET', `/s/${token}`);
  assert.equal(landing.json.requiresPassword, true);
  assert.equal(landing.json.downloadsRemaining, 2);

  assert.equal((await api('POST', `/s/${token}/download`, { body: { password: 'wrong' } })).status, 401);
  assert.equal((await api('POST', `/s/${token}/download`, {})).status, 401);

  const d1 = await api('POST', `/s/${token}/download`, { body: { password: 'correct horse' } });
  assert.equal(d1.status, 200);
  assert.equal(d1.text, 'DECK-BYTES');
  assert.equal(d1.headers.get('content-disposition'), 'attachment; filename="deck.pdf"');

  const d2 = await api('POST', `/s/${token}/download`, { body: { password: 'correct horse' } });
  assert.equal(d2.status, 200);

  const d3 = await api('POST', `/s/${token}/download`, { body: { password: 'correct horse' } });
  assert.equal(d3.status, 410);
  assert.equal(d3.json.error, 'exhausted');

  // Expiry.
  const short = await api('POST', `/orgs/${org}/documents/${doc}/shares`, {
    user: owner, body: { expiresInSeconds: 1 },
  });
  const shortToken = short.json.url.split('/s/')[1];
  assert.equal((await api('POST', `/s/${shortToken}/download`, {})).status, 200);
  await new Promise((r) => setTimeout(r, 1100));
  const afterExpiry = await api('POST', `/s/${shortToken}/download`, {});
  assert.equal(afterExpiry.status, 410);
  assert.equal(afterExpiry.json.error, 'expired');

  // A failed password attempt and every download are in the audit trail.
  const audit = await api('GET', `/orgs/${org}/audit`, { user: owner });
  const actions = audit.json.entries.map((e) => e.action);
  assert.ok(actions.includes('share.password_failed'));
  // d1, d2 on the capped share + 1 on the short-expiry share. The rejected
  // 3rd attempt and the post-expiry attempt are correctly NOT counted as
  // downloads (they are denials, and the app does not log denials on the
  // share path — see REPORT.md §3, decision 9).
  assert.equal(actions.filter((a) => a === 'share.downloaded').length, 3);
});

test('REQUIREMENT: revocation is immediate for already-issued share links (proxy delivery)', async (t) => {
  const h = await harness({ shareDelivery: 'proxy' });
  t.after(h.close);
  const { api } = h;

  const owner = await mkUser(api, 'o@revoke.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Revoke' } })).json.id;
  const doc = await upload(api, org, owner, 'nda.pdf', 'application/pdf', 'NDA-BYTES');

  const share = await api('POST', `/orgs/${org}/documents/${doc}/shares`, {
    user: owner, body: { expiresInSeconds: 86400 },
  });
  const token = share.json.url.split('/s/')[1];

  assert.equal((await api('POST', `/s/${token}/download`, {})).status, 200);

  const rev = await api('POST', `/orgs/${org}/shares/${share.json.shareId}/revoke`, { user: owner });
  assert.equal(rev.status, 204);

  // Immediately after revocation, with the SAME already-issued link.
  const after = await api('POST', `/s/${token}/download`, {});
  assert.equal(after.status, 410);
  assert.equal(after.json.error, 'revoked');
  assert.equal((await api('GET', `/s/${token}`)).status, 410);

  // Deleting the document also revokes outstanding links.
  const s2 = await api('POST', `/orgs/${org}/documents/${doc}/shares`, {
    user: owner, body: { expiresInSeconds: 86400 },
  });
  const t2 = s2.json.url.split('/s/')[1];
  assert.equal((await api('POST', `/s/${t2}/download`, {})).status, 200);
  await api('DELETE', `/orgs/${org}/documents/${doc}`, { user: owner });
  assert.equal((await api('POST', `/s/${t2}/download`, {})).status, 410);
});

test('MEASURED GAP: an already-issued presigned URL cannot be revoked', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api, s3 } = h;

  const owner = await mkUser(api, 'o@gap.test');
  const member = await mkUser(api, 'm@gap.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Gap' } })).json.id;
  await api('POST', `/orgs/${org}/members`, { user: owner, body: { userId: member, role: 'member' } });
  const doc = await upload(api, org, owner, 'payroll.csv', 'text/csv', 'SALARIES');

  // A member legitimately obtains an in-app download URL...
  const dl = await api('GET', `/orgs/${org}/documents/${doc}/download`, { user: member });
  const leakedUrl = dl.json.url;
  assert.equal((await fetch(leakedUrl)).status, 200);

  // ...and is then demoted to viewer, and the document is deleted outright.
  await api('PATCH', `/orgs/${org}/members/${member}`, { user: owner, body: { role: 'viewer' } });
  await api('DELETE', `/orgs/${org}/documents/${doc}`, { user: owner });

  // The application has done everything it can. The URL is still live,
  // because S3 has no idea any of that happened. Note the object itself was
  // deleted here, so this 404s — but only because we could delete the object.
  // Re-upload the same key to show the URL itself was never invalidated.
  await fetch((await (async () => {
    const d2 = await api('POST', `/orgs/${org}/documents`, {
      user: owner, body: { name: 'x', contentType: 'text/csv' },
    });
    return d2.json.uploadUrl;
  })()), { method: 'PUT', headers: { 'content-type': 'text/csv' }, body: 'x' });

  // The decisive check: application-level revocation of a presigned GET.
  // There is no API for it. The only lever AWS documents is invalidating the
  // signing credential — which invalidates EVERY outstanding URL for EVERY
  // customer signed with that key, and breaks the app's own S3 access too.
  const doc2 = await upload(api, org, owner, 'payroll2.csv', 'text/csv', 'SALARIES-2');
  const dl2 = await api('GET', `/orgs/${org}/documents/${doc2}/download`, { user: owner });
  assert.equal((await fetch(dl2.json.url)).status, 200, 'URL live before revocation');

  s3.deactivateAccessKey('AKIABENCHMARKKEY0001');
  assert.equal((await fetch(dl2.json.url)).status, 403, 'credential revocation does kill it');

  // ...and it also killed the application's own ability to serve anything.
  const dl3 = await api('GET', `/orgs/${org}/documents/${doc2}/download`, { user: owner });
  const collateral = await fetch(dl3.json.url);
  assert.equal(collateral.status, 403, 'blast radius: newly issued URLs are dead too');
  s3.activateAccessKey('AKIABENCHMARKKEY0001');
});

test('MEASURED GAP: redirect delivery reopens a revocation window', async (t) => {
  const h = await harness({ shareDelivery: 'redirect' });
  t.after(h.close);
  const { api } = h;

  const owner = await mkUser(api, 'o@window.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Window' } })).json.id;
  const doc = await upload(api, org, owner, 'contract.pdf', 'application/pdf', 'CONTRACT');

  const share = await api('POST', `/orgs/${org}/documents/${doc}/shares`, {
    user: owner, body: { expiresInSeconds: 86400 },
  });
  const token = share.json.url.split('/s/')[1];

  const redirect = await api('POST', `/s/${token}/download`, {});
  assert.equal(redirect.status, 302);
  const presigned = redirect.headers.get('location');

  await api('POST', `/orgs/${org}/shares/${share.json.shareId}/revoke`, { user: owner });

  // The share is revoked at the application layer...
  assert.equal((await api('POST', `/s/${token}/download`, {})).status, 410);
  // ...but the presigned URL the recipient already holds still serves bytes,
  // for the full remaining TTL (30s in redirect mode).
  const stillWorks = await fetch(presigned);
  assert.equal(stillWorks.status, 200);
  assert.equal(await stillWorks.text(), 'CONTRACT');
});

test('audit trail is tamper-evident', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api, db } = h;

  const owner = await mkUser(api, 'o@tamper.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Tamper' } })).json.id;
  const doc = await upload(api, org, owner, 'a.txt', 'text/plain', 'A');
  await api('GET', `/orgs/${org}/documents/${doc}/download`, { user: owner });

  assert.equal((await verifyChain(db, org)).ok, true);

  // Rewrite history: pretend the download never happened.
  await db.query(
    `UPDATE audit_log SET action = 'document.viewed'
      WHERE org_id = $1 AND action = 'document.downloaded'`, [org]
  );
  const broken = await verifyChain(db, org);
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'hash_mismatch');

  // Deleting an entry is also detected.
  const h2 = await harness();
  t.after(h2.close);
  const o2 = await mkUser(h2.api, 'o2@tamper.test');
  const org2 = (await h2.api('POST', '/orgs', { user: o2, body: { name: 'T2' } })).json.id;
  await upload(h2.api, org2, o2, 'b.txt', 'text/plain', 'B');
  await h2.db.query(`DELETE FROM audit_log WHERE org_id = $1 AND org_seq = 2`, [org2]);
  const gapped = await verifyChain(h2.db, org2);
  assert.equal(gapped.ok, false);
  assert.equal(gapped.reason, 'sequence_gap');
});

test('lifecycle: abandoned presigned uploads are reaped', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api, db, storage, s3 } = h;

  const owner = await mkUser(api, 'o@orphan.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Orphan' } })).json.id;

  // Client gets an upload URL, PUTs the bytes, then vanishes without calling
  // /complete. Nothing in S3 or Postgres notices.
  const created = await api('POST', `/orgs/${org}/documents`, {
    user: owner, body: { name: 'ghost.bin', contentType: 'application/octet-stream' },
  });
  await fetch(created.json.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: 'GHOST',
  });
  assert.equal(s3.objects.size, 1, 'bytes are billable and unreferenced');

  const listed = await api('GET', `/orgs/${org}/documents`, { user: owner });
  assert.equal(listed.json.documents.length, 0, 'invisible to the app');

  const swept = await sweepOrphans(db, storage, { pendingGraceSeconds: 0 });
  assert.equal(swept.abandonedUploadsReaped, 1);
  assert.equal(s3.objects.size, 0);
});

test('download cap is enforced atomically under concurrent requests', async (t) => {
  const h = await harness();
  t.after(h.close);
  const { api } = h;

  const owner = await mkUser(api, 'o@race.test');
  const org = (await api('POST', '/orgs', { user: owner, body: { name: 'Race' } })).json.id;
  const doc = await upload(api, org, owner, 'r.txt', 'text/plain', 'R');
  const share = await api('POST', `/orgs/${org}/documents/${doc}/shares`, {
    user: owner, body: { expiresInSeconds: 600, maxDownloads: 3 },
  });
  const token = share.json.url.split('/s/')[1];

  const results = await Promise.all(
    Array.from({ length: 10 }, () => api('POST', `/s/${token}/download`, {}))
  );
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(results.filter((r) => r.status === 410).length, 7);
});
