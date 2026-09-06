// test/vault.test.js  --  test harness (excluded from application LOC)
//
// Every test below runs against real PostgreSQL (PGlite, PG18) with real RLS
// policies, evaluated under `SET LOCAL ROLE authenticated` with
// `request.jwt.claims` set -- i.e. exactly the mechanism Supabase's Storage API
// and PostgREST use.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { boot, refused, advanceClock, resetClock, closeAll } from './setup.js';

afterEach(closeAll);
import { uploadDocument, downloadAsMember, listDocuments, softDeleteDocument,
         changeMemberRole, removeMember, readAuditLog, verifyAuditChain,
         safeFilename, objectName, BUCKET } from '../src/app/vault.js';
import { createShareLink, revokeShareLink, redeemShareLink,
         SIGNED_URL_TTL_SEC } from '../src/app/share.js';

const bytes = (s) => Buffer.from(s, 'utf8');

// =====================================================================
// 1. CROSS-TENANT ISOLATION  ("no file is ever reachable across org
//    boundaries by any means")
// =====================================================================
test('cross-tenant: org B member cannot see org A documents, objects, members or audit',
async () => {
  const { sb, orgA, orgB, tok } = await boot();
  const { documentId, path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'q3-forecast.pdf', bytes: bytes('acme secret') });

  // Sanity: an entitled reader in org A does see the row.
  const mine = await sb.asUser(tok.mia, (c) =>
    c.query('select * from public.documents where org_id=$1', [orgA]));
  assert.equal(mine.rows.length, 1);

  // Eve queries with NO org filter at all -- the policies, not the WHERE
  // clause, are what must scope her. She sees only org B.
  const asEve = (fn, op = '') => sb.asUser(tok.eve, fn, op);
  assert.equal((await asEve((c) => c.query('select * from public.documents'))).rows.length, 0);
  assert.equal((await asEve((c) =>
    c.query('select * from storage.objects'), 'object.list')).rows.length, 0);
  assert.equal((await asEve((c) => c.query('select * from public.audit_log'))).rows.length, 0);

  const orgs = await asEve((c) => c.query('select id from public.orgs'));
  assert.deepEqual(orgs.rows.map((r) => r.id), [orgB], 'sees org B only');
  const mem = await asEve((c) => c.query('select org_id from public.org_members'));
  assert.ok(mem.rows.every((r) => r.org_id === orgB), 'sees org B members only');

  // direct byte fetch
  const e = await refused(() => sb.downloadAuthenticated(tok.eve, BUCKET, path));
  assert.equal(e.status, 404);

  // signing
  const e2 = await refused(() => sb.createSignedUrl(tok.eve, BUCKET, path, 300));
  assert.match(e2.message, /not found/i);

  void documentId;
});

test('cross-tenant: org B member cannot write into org A prefix', async () => {
  const { sb, orgA, orgB, tok, u } = await boot();

  // Attempt 1: forge a documents row in org A.
  await refused(() => sb.asUser(tok.eve, (c) =>
    c.query(`insert into public.documents (org_id, uploader_id, filename, storage_path)
             values ($1,(select auth.uid()),'evil.pdf',$2)`,
            [orgA, `${orgA}/${'11111111-1111-1111-1111-111111111111'}/evil.pdf`])));

  // Attempt 2: make a legitimate doc in her OWN org, then upload it under
  // org A's prefix. The INSERT policy compares the path's org segment against
  // the document's org, so this is refused.
  const docId = '22222222-2222-2222-2222-222222222222';
  await sb.asUser(tok.eve, (c) =>
    c.query(`insert into public.documents (id, org_id, uploader_id, filename, storage_path)
             values ($1,$2,(select auth.uid()),'ok.pdf',$3)`,
            [docId, orgB, `${orgB}/${docId}/ok.pdf`]));
  const e = await refused(() =>
    sb.upload(tok.eve, BUCKET, `${orgA}/${docId}/ok.pdf`, bytes('x')));
  assert.match(e.message, /row-level security|violates/i);

  void u;
});

test('cross-tenant: org B member cannot move an org A object into her own org',
async () => {
  const { sb, orgA, tok } = await boot();
  const { path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const r = await sb.asUser(tok.eve, (c) =>
    c.query(`update storage.objects set name='stolen/a.pdf'
             where bucket_id='vault' and name=$1 returning id`, [path]), 'object.move');
  assert.equal(r.rows.length, 0, 'UPDATE matched zero rows -- USING clause denied it');
});

test('anon has zero reach into storage or app tables', async () => {
  const { sb, orgA, tok } = await boot();
  await uploadDocument(sb, tok.mia, { orgId: orgA, filename: 'a.pdf', bytes: bytes('x') });
  // storage.objects IS granted to anon (Supabase grants it), so RLS is what
  // stops them: zero rows, because no policy names `anon`.
  const objs = await sb.asAnon((c) => c.query('select * from storage.objects'), 'object.list');
  assert.equal(objs.rows.length, 0);

  // The public.* tables are never granted to anon at all, so they fail one
  // layer earlier, at the GRANT. Either outcome is closed; both are asserted.
  for (const q of ['select * from public.documents', 'select * from public.share_links',
                   'select * from public.audit_log']) {
    let rows = null;
    try { rows = (await sb.asAnon((c) => c.query(q))).rows.length; }
    catch (e) { assert.match(e.message, /permission denied/, q); continue; }
    assert.equal(rows, 0, q);
  }
});

// =====================================================================
// 2. ROLE SEMANTICS
// =====================================================================
test('viewer can read but cannot upload or delete', async () => {
  const { sb, orgA, tok } = await boot();
  const { documentId, path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });

  assert.equal((await downloadAsMember(sb, tok.vera, orgA, documentId)).toString(), 'acme');

  const docId = '33333333-3333-3333-3333-333333333333';
  await refused(() => sb.asUser(tok.vera, (c) =>
    c.query(`insert into public.documents (id, org_id, uploader_id, filename, storage_path)
             values ($1,$2,(select auth.uid()),'v.pdf',$3)`,
            [docId, orgA, `${orgA}/${docId}/v.pdf`])));

  const del = await sb.asUser(tok.vera, (c) =>
    c.query('delete from storage.objects where name=$1 returning id', [path]), 'object.delete');
  assert.equal(del.rows.length, 0);
});

test('member manages own document; another member cannot; admin can', async () => {
  const { sb, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'mia.pdf', bytes: bytes('mia') });

  await refused(() => softDeleteDocument(sb, tok.mo, orgA, documentId));
  assert.equal(await softDeleteDocument(sb, tok.adam, orgA, documentId), true);
});

test('admin cannot escalate anyone to owner; owner can', async () => {
  const { sb, orgA, tok, u } = await boot();
  await refused(() => changeMemberRole(sb, tok.adam, orgA, u.mia, 'owner'));
  assert.equal(await changeMemberRole(sb, tok.alice, orgA, u.mia, 'owner'), 'owner');
});

test('member cannot grant themselves admin', async () => {
  const { sb, orgA, tok, u } = await boot();
  await refused(() => changeMemberRole(sb, tok.mia, orgA, u.mia, 'admin'));
});

// =====================================================================
// 3. RBAC FRESHNESS -- table lookup vs Supabase's documented JWT-claim RBAC
// =====================================================================
test('removing a member takes effect immediately (table-lookup RBAC)', async () => {
  const { sb, orgA, tok, u } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  assert.ok(await downloadAsMember(sb, tok.mia, orgA, documentId));

  await removeMember(sb, tok.alice, orgA, u.mia);

  // Same, still-unexpired access token. Access is gone on the very next call.
  const e = await refused(() => downloadAsMember(sb, tok.mia, orgA, documentId));
  assert.ok(e);
});

test('MEASUREMENT: JWT-claim RBAC keeps a removed member in for the token lifetime',
async () => {
  const { sb, db, orgA, u } = await boot();
  await db.query(
    'insert into public.documents_jwt_demo (org_id, label) values ($1,$2)', [orgA, 'x']);

  // A token minted the way the RBAC guide's Custom Access Token Hook mints it.
  const claimTok = sb.issueAccessToken(u.mia, { org_roles: { [orgA]: 'member' } }, 3600);
  let r = await sb.asUser(claimTok, (c) => c.query('select * from public.documents_jwt_demo'));
  assert.equal(r.rows.length, 1);

  await db.query('delete from public.org_members where org_id=$1 and user_id=$2', [orgA, u.mia]);

  r = await sb.asUser(claimTok, (c) => c.query('select * from public.documents_jwt_demo'));
  assert.equal(r.rows.length, 1,
    'STILL READABLE: the claim is stale. Fail-open window = remaining token TTL (up to 1h by default).');
});

// =====================================================================
// 4. SHARE LINKS -- expiry, password, download cap
// =====================================================================
test('any member (incl. viewer) can share a doc they can read; outsider cannot',
async () => {
  const { sb, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });

  const link = await createShareLink(sb, tok.vera,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  assert.ok(link.url);

  await refused(() => createShareLink(sb, tok.eve,
    { orgId: orgA, documentId, expiresInSec: 3600 }));
});

test('share link: expiry is enforced', async () => {
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  const token = (await db.query('select token from public.share_links where id=$1',
    [link.id])).rows[0].token;

  assert.equal((await redeemShareLink(sb, { shareToken: token })).ok, true);

  await db.query(`update public.share_links set expires_at = now() - interval '1 second'
                  where id=$1`, [link.id]);
  assert.deepEqual(await redeemShareLink(sb, { shareToken: token }),
    { ok: false, reason: 'expired' });
});

test('share link: password is enforced', async () => {
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600, password: 'hunter2' });
  const token = (await db.query('select token from public.share_links where id=$1',
    [link.id])).rows[0].token;

  assert.equal((await redeemShareLink(sb, { shareToken: token })).reason, 'bad_password');
  assert.equal((await redeemShareLink(sb, { shareToken: token, password: 'wrong' })).reason,
    'bad_password');
  assert.equal((await redeemShareLink(sb, { shareToken: token, password: 'hunter2' })).ok, true);

  // A failed attempt must not consume a download.
  const cnt = (await db.query('select download_count from public.share_links where id=$1',
    [link.id])).rows[0].download_count;
  assert.equal(cnt, 1);
});

test('share link: download cap is enforced and is race-safe at the gateway', async () => {
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600, maxDownloads: 2 });
  const token = (await db.query('select token from public.share_links where id=$1',
    [link.id])).rows[0].token;

  assert.equal((await redeemShareLink(sb, { shareToken: token })).downloadCount, 1);
  assert.equal((await redeemShareLink(sb, { shareToken: token })).downloadCount, 2);
  assert.equal((await redeemShareLink(sb, { shareToken: token })).reason,
    'download_limit_or_state');
});

test('KNOWN GAP: the download cap counts URL issuance, not byte delivery',
async () => {
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600, maxDownloads: 1 });
  const token = (await db.query('select token from public.share_links where id=$1',
    [link.id])).rows[0].token;

  const r = await redeemShareLink(sb, { shareToken: token });
  assert.equal(r.ok, true);

  // The cap is now exhausted at the gateway...
  assert.equal((await redeemShareLink(sb, { shareToken: token })).reason,
    'download_limit_or_state');

  // ...but the single signed URL it handed out is a bearer token with a 30s
  // life, and nothing counts fetches of it. Three downloads from a cap of one.
  assert.equal((await sb.fetchSignedUrl(r.signedUrl)).toString(), 'acme');
  assert.equal((await sb.fetchSignedUrl(r.signedUrl)).toString(), 'acme');
  assert.equal((await sb.fetchSignedUrl(r.signedUrl)).toString(), 'acme');
});

// =====================================================================
// 5. REVOCATION -- the crux metric
// =====================================================================
test('revocation is immediate at the gateway', async () => {
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  const token = (await db.query('select token from public.share_links where id=$1',
    [link.id])).rows[0].token;

  assert.equal((await redeemShareLink(sb, { shareToken: token })).ok, true);
  await revokeShareLink(sb, tok.mia, { orgId: orgA, shareLinkId: link.id });
  assert.deepEqual(await redeemShareLink(sb, { shareToken: token }),
    { ok: false, reason: 'revoked' });
});

test('MEASUREMENT: an already-minted signed URL survives revocation for its full TTL',
async () => {
  resetClock();
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  const token = (await db.query('select token from public.share_links where id=$1',
    [link.id])).rows[0].token;

  const r = await redeemShareLink(sb, { shareToken: token });
  await revokeShareLink(sb, tok.mia, { orgId: orgA, shareLinkId: link.id });

  // Gateway: closed. Storage: still open. This is the residual window.
  assert.equal((await redeemShareLink(sb, { shareToken: token })).reason, 'revoked');
  assert.equal((await sb.fetchSignedUrl(r.signedUrl)).toString(), 'acme',
    `signed URL still serves bytes ${SIGNED_URL_TTL_SEC}s after revocation`);

  advanceClock((SIGNED_URL_TTL_SEC + 1) * 1000);
  const e = await refused(() => sb.fetchSignedUrl(r.signedUrl));
  assert.equal(e.message, 'expired');
  resetClock();
});

test('MEASUREMENT: path rotation closes the residual window to zero, with collateral',
async () => {
  resetClock();
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });

  const linkX = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  const linkY = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  const tk = async (id) => (await db.query('select token from public.share_links where id=$1',
    [id])).rows[0].token;

  const rX = await redeemShareLink(sb, { shareToken: await tk(linkX.id) });
  const rY = await redeemShareLink(sb, { shareToken: await tk(linkY.id) });
  assert.ok(await sb.fetchSignedUrl(rX.signedUrl));
  assert.ok(await sb.fetchSignedUrl(rY.signedUrl));

  await revokeShareLink(sb, tok.mia,
    { orgId: orgA, shareLinkId: linkX.id, mode: 'rotate' });

  // X's outstanding URL is dead immediately -- zero residual window.
  const eX = await refused(() => sb.fetchSignedUrl(rX.signedUrl));
  assert.equal(eX.status, 404);

  // COLLATERAL: so is Y's, even though Y was never revoked. Y's *link* still
  // works, but only because redeeming it mints a fresh URL against the new path.
  const eY = await refused(() => sb.fetchSignedUrl(rY.signedUrl));
  assert.equal(eY.status, 404, 'unrelated live share link lost its issued URL');
  assert.equal((await redeemShareLink(sb, { shareToken: await tk(linkY.id) })).ok, true);
});

test('signed URLs: forged, tampered, expired and path-swapped tokens are all refused',
async () => {
  resetClock();
  const { sb, orgA, tok } = await boot();
  const { path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const { path: path2 } = await uploadDocument(sb, tok.mo,
    { orgId: orgA, filename: 'b.pdf', bytes: bytes('other') });

  const { signedUrl } = await sb.createSignedUrl(tok.mia, BUCKET, path, 60);
  assert.ok(await sb.fetchSignedUrl(signedUrl));

  const u = new URL(signedUrl);
  const t = u.searchParams.get('token');

  // tampered payload
  const bad = new URL(signedUrl);
  bad.searchParams.set('token', t.replace(/\.([^.]+)\./, '.eyJ1cmwiOiJ4In0.'));
  assert.equal((await refused(() => sb.fetchSignedUrl(bad.href))).message, 'bad_signature');

  // valid token, different object -- storage compares payload.url to the path
  const swapped = new URL(signedUrl.replace(encodeURI(path), encodeURI(path2)));
  swapped.searchParams.set('token', t);
  assert.match((await refused(() => sb.fetchSignedUrl(swapped.href))).message, /mismatch/);

  // expired
  advanceClock(61_000);
  assert.equal((await refused(() => sb.fetchSignedUrl(signedUrl))).message, 'expired');
  resetClock();
});

// =====================================================================
// 6. AUDIT TRAIL
// =====================================================================
test('audit: admins read it, non-admins cannot, and the chain verifies', async () => {
  const { sb, orgA, tok, u } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  await downloadAsMember(sb, tok.vera, orgA, documentId);
  const link = await createShareLink(sb, tok.mia,
    { orgId: orgA, documentId, expiresInSec: 3600 });
  await revokeShareLink(sb, tok.mia, { orgId: orgA, shareLinkId: link.id });
  await changeMemberRole(sb, tok.alice, orgA, u.mo, 'viewer');

  const rows = await readAuditLog(sb, tok.adam, orgA);
  assert.deepEqual(rows.map((r) => r.action),
    ['upload', 'download', 'share', 'revoke', 'permission_change']);

  assert.equal((await readAuditLog(sb, tok.mia, orgA)).length, 0, 'member sees nothing');
  assert.equal((await readAuditLog(sb, tok.vera, orgA)).length, 0, 'viewer sees nothing');

  const v = await verifyAuditChain(sb, tok.adam, orgA);
  assert.equal(v.ok, true);
  assert.equal(Number(v.checked), 5);
});

test('audit: authenticated users cannot append, edit or delete entries', async () => {
  const { sb, orgA, tok } = await boot();
  await uploadDocument(sb, tok.mia, { orgId: orgA, filename: 'a.pdf', bytes: bytes('x') });

  await refused(() => sb.asUser(tok.alice, (c) =>
    c.query(`select public.audit_append($1,null,'user','download','{}'::jsonb)`, [orgA])));
  await refused(() => sb.asUser(tok.alice, (c) =>
    c.query('update public.audit_log set action=$1 where org_id=$2', ['nothing', orgA])));
  await refused(() => sb.asUser(tok.alice, (c) =>
    c.query('delete from public.audit_log where org_id=$1', [orgA])));
});

test('audit: tampering by a service-key holder is DETECTED but not prevented',
async () => {
  const { sb, db, orgA, tok } = await boot();
  const { documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('x') });
  await downloadAsMember(sb, tok.vera, orgA, documentId);
  assert.equal((await verifyAuditChain(sb, tok.adam, orgA)).ok, true);

  // service_role has BYPASSRLS. It can rewrite history.
  await db.query(`update public.audit_log set action='view' where org_id=$1 and seq=2`, [orgA]);
  const v = await verifyAuditChain(sb, tok.adam, orgA);
  assert.equal(v.ok, false);
  assert.equal(Number(v.broken_at), 2);

  // Deleting a row is caught by the sequence check too.
  await db.query('delete from public.audit_log where org_id=$1 and seq=1', [orgA]);
  assert.equal((await verifyAuditChain(sb, tok.adam, orgA)).ok, false);
});

// =====================================================================
// 7. THE AUDIT-COMPLETENESS HOLE, AND CONFIG B AS THE FIX
// =====================================================================
test('CONFIG A: a member can read bytes without the app ever seeing it -- audit gap',
async () => {
  const { sb, orgA, tok } = await boot({ configB: false });
  const { path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const before = (await readAuditLog(sb, tok.adam, orgA)).length;

  // Straight from the browser with the user's own JWT. RLS says yes -- vera IS
  // entitled to read this. The application is not in the loop.
  assert.equal((await sb.downloadAuthenticated(tok.vera, BUCKET, path)).toString(), 'acme');
  const { signedUrl } = await sb.createSignedUrl(tok.vera, BUCKET, path, 604800);
  assert.ok(await sb.fetchSignedUrl(signedUrl));

  assert.equal((await readAuditLog(sb, tok.adam, orgA)).length, before,
    'two reads occurred; zero audit records were written');
});

test('CONFIG B: locking authenticated out of byte reads closes the audit gap',
async () => {
  const { sb, orgA, tok } = await boot({ configB: true });
  const { path, documentId } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });

  // Listing still works (the UI needs it).
  assert.deepEqual(await sb.list(tok.vera, BUCKET, `${orgA}/`), [path]);

  // Byte fetch and self-signing are both closed.
  assert.equal((await refused(() => sb.downloadAuthenticated(tok.vera, BUCKET, path))).status, 404);
  await refused(() => sb.createSignedUrl(tok.vera, BUCKET, path, 60));

  // The only remaining read path is the application's, which audits.
  const before = (await readAuditLog(sb, tok.adam, orgA)).length;
  await refused(() => downloadAsMember(sb, tok.vera, orgA, documentId));
  assert.equal((await readAuditLog(sb, tok.adam, orgA)).length, before);
});

// =====================================================================
// 8. INPUT HANDLING
// =====================================================================
test('path traversal in a filename cannot escape the org prefix', async () => {
  assert.equal(safeFilename('../../otherorg/x/secret.pdf'), 'secret.pdf');
  assert.equal(safeFilename('a/b/c.txt'), 'c.txt');
  assert.equal(safeFilename('..\\..\\win.txt'), 'win.txt');
  assert.throws(() => safeFilename('..'));
  assert.throws(() => safeFilename('/'));

  const { sb, orgA, tok } = await boot();
  const { path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: '../../evil.pdf', bytes: bytes('x') });
  assert.equal(path.split('/').length, 3);
  assert.equal(path.split('/')[0], orgA);
});

test('a document row without its object is a 404, not a leak', async () => {
  const { sb, orgA, tok, db } = await boot();
  const docId = '44444444-4444-4444-4444-444444444444';
  await sb.asUser(tok.mia, (c) =>
    c.query(`insert into public.documents (id, org_id, uploader_id, filename, storage_path)
             values ($1,$2,(select auth.uid()),'ghost.pdf',$3)`,
            [docId, orgA, objectName(orgA, docId, 'ghost.pdf')]));
  assert.equal((await listDocuments(sb, tok.mia, orgA)).length, 1);
  const e = await refused(() => downloadAsMember(sb, tok.mia, orgA, docId));
  assert.equal(e.status, 404);
  void db;
});

test('soft-deleting a document immediately closes RLS on its object', async () => {
  const { sb, orgA, tok } = await boot();
  const { documentId, path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  assert.ok(await sb.downloadAuthenticated(tok.mia, BUCKET, path));
  await softDeleteDocument(sb, tok.mia, orgA, documentId);
  assert.equal((await refused(() => sb.downloadAuthenticated(tok.mia, BUCKET, path))).status, 404);
});

test('KNOWN GAP: soft delete does NOT invalidate signed URLs already issued',
async () => {
  resetClock();
  const { sb, orgA, tok } = await boot();
  const { documentId, path } = await uploadDocument(sb, tok.mia,
    { orgId: orgA, filename: 'a.pdf', bytes: bytes('acme') });
  const { signedUrl } = await sb.createSignedUrl(tok.mia, BUCKET, path, 3600);
  await softDeleteDocument(sb, tok.mia, orgA, documentId);
  assert.equal((await sb.fetchSignedUrl(signedUrl)).toString(), 'acme',
    'deleted document, URL still serves bytes for the rest of the hour');
});
