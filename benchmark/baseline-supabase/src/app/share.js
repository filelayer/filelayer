// =====================================================================
// src/app/share.js  --  APPLICATION CODE (counted)
// =====================================================================
// Share links: expiry + optional password + max download count + immediate
// revocation.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// A Supabase signed URL is a stateless JWT signed with a per-project storage
// key. Redeeming one does not touch Postgres, so it cannot consult a
// revocation flag, cannot check a password, and cannot decrement a counter.
// The docs are explicit: "Signed URLs remain valid until their expiry time
// regardless of any Auth key changes. If you need to revoke signed URLs,
// contact Supabase support."
//   -- https://supabase.com/docs/guides/storage/serving/downloads
//
// So all three share-link features have to be enforced somewhere that IS
// stateful. That place is this gateway (an Edge Function in a real project).
// The sharee receives a gateway URL, never a storage URL. The gateway checks
// state, then mints a signed URL with a very short TTL and redirects.
//
// CONSEQUENCE, stated precisely: revocation is immediate at the gateway, but a
// signed URL already minted and in flight stays valid for the remainder of its
// TTL. That residual window is SIGNED_URL_TTL_SEC. It can be shrunk. It cannot
// be driven to zero without proxying every byte through the function, which
// costs egress and caps you at the function's response limits.
// =====================================================================

import { randomBytes, pbkdf2Sync, timingSafeEqual, randomUUID } from 'node:crypto';
import { BUCKET } from './vault.js';

// The revocation residual window. 30s is already aggressive; the practical
// floor is bounded by clock skew between your gateway and the storage service.
export const SIGNED_URL_TTL_SEC = 30;

const PBKDF2_ROUNDS = 120_000;

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: pbkdf2Sync(password, salt, PBKDF2_ROUNDS, 32, 'sha256').toString('hex') };
}
function passwordMatches(password, salt, expectedHex) {
  const got = pbkdf2Sync(password, salt, PBKDF2_ROUNDS, 32, 'sha256');
  const exp = Buffer.from(expectedHex, 'hex');
  return got.length === exp.length && timingSafeEqual(got, exp);
}

async function audit(sb, orgId, actorId, actorKind, action, subject) {
  await sb.asService((c) =>
    c.query('select public.audit_append($1,$2,$3,$4,$5::jsonb)',
            [orgId, actorId, actorKind, action, JSON.stringify(subject)]));
}

// ---------------------------------------------------------------------
// Create. Runs as the user, so `share_insert` RLS enforces "a document they
// can read" -- a viewer in the org can share, a stranger cannot.
// ---------------------------------------------------------------------
export async function createShareLink(sb, token, {
  orgId, documentId, expiresInSec, password = null, maxDownloads = null,
}) {
  const shareToken = randomUUID().replace(/-/g, '') + randomBytes(16).toString('hex');
  const pw = password ? hashPassword(password) : { salt: null, hash: null };
  const expiresAt = new Date(sb.now() + expiresInSec * 1000).toISOString();

  const r = await sb.asUser(token, (c) =>
    c.query(
      `insert into public.share_links
         (org_id, document_id, created_by, token, expires_at,
          password_hash, password_salt, max_downloads)
       values ($1,$2,(select auth.uid()),$3,$4,$5,$6,$7)
       returning id, created_by`,
      [orgId, documentId, shareToken, expiresAt, pw.hash, pw.salt, maxDownloads]));

  await audit(sb, orgId, r.rows[0].created_by, 'user', 'share',
              { share_link_id: r.rows[0].id, document_id: documentId,
                expires_at: expiresAt, has_password: !!password,
                max_downloads: maxDownloads });

  return { id: r.rows[0].id, url: `https://vault.example.com/s/${shareToken}` };
}

// ---------------------------------------------------------------------
// Revoke. Two flavours.
//
//  'gateway'  (default) -- flip revoked_at. Every FUTURE redemption fails
//             instantly. Signed URLs already minted survive up to
//             SIGNED_URL_TTL_SEC.
//
//  'rotate'   -- additionally move the object to a new path. A Supabase signed
//             URL embeds `bucket/path` in its payload and the storage service
//             compares it to the requested path, so renaming invalidates every
//             outstanding signed URL for that object instantly, closing the
//             residual window to zero. The cost is collateral: it invalidates
//             signed URLs for ALL other live share links of the same document,
//             so they must be re-issued, and on a large object the backend
//             copy is neither free nor instantaneous.
// ---------------------------------------------------------------------
export async function revokeShareLink(sb, token, { orgId, shareLinkId, mode = 'gateway' }) {
  const r = await sb.asUser(token, (c) =>
    c.query(`update public.share_links set revoked_at = now()
             where id=$1 and revoked_at is null returning document_id`, [shareLinkId]));
  if (!r.rows.length) { const e = new Error('forbidden or already revoked'); e.status = 403; throw e; }
  const documentId = r.rows[0].document_id;

  let rotatedTo = null;
  if (mode === 'rotate') {
    const d = await sb.asService((c) =>
      c.query('select storage_path, org_id, id from public.documents where id=$1', [documentId]));
    const cur = d.rows[0].storage_path;
    const parts = cur.split('/');
    rotatedTo = `${parts[0]}/${parts[1]}/${randomBytes(6).toString('hex')}.${parts.slice(2).join('/')}`;
    await sb.moveAsService(BUCKET, cur, rotatedTo);
    await sb.asService((c) =>
      c.query('update public.documents set storage_path=$2 where id=$1', [documentId, rotatedTo]));
  }

  const who = await sb.asUser(token, (c) => c.query('select (select auth.uid()) as uid'));
  await audit(sb, orgId, who.rows[0].uid, 'user', 'revoke',
              { share_link_id: shareLinkId, document_id: documentId, mode,
                rotated_to: rotatedTo });
  return { revoked: true, mode, rotatedTo };
}

// ---------------------------------------------------------------------
// The gateway. In production this is a Supabase Edge Function holding the
// service key. It is the ONLY thing standing between an anonymous caller and
// the bytes, so every check below is load-bearing and none of them are
// enforced by the platform.
// ---------------------------------------------------------------------
export async function redeemShareLink(sb, { shareToken, password = null }) {
  const now = new Date(sb.now());

  // Single atomic statement. The download-count guard MUST be part of the same
  // UPDATE ... WHERE as the increment; reading the count and then updating it
  // is a TOCTOU race that two concurrent redemptions win together.
  const r = await sb.asService((c) =>
    c.query(
      `select id, org_id, document_id, expires_at, revoked_at,
              password_hash, password_salt, max_downloads, download_count
       from public.share_links where token=$1`, [shareToken]));

  if (!r.rows.length) return deny(sb, null, null, 'not_found');
  const link = r.rows[0];

  if (link.revoked_at) return deny(sb, link.org_id, link.id, 'revoked');
  if (new Date(link.expires_at) <= now) return deny(sb, link.org_id, link.id, 'expired');

  if (link.password_hash) {
    if (password === null || !passwordMatches(password, link.password_salt, link.password_hash))
      return deny(sb, link.org_id, link.id, 'bad_password');
  } else if (password !== null) {
    // no-op: extra password on an unprotected link is not an error
  }

  const claim = await sb.asService((c) =>
    c.query(
      `update public.share_links
          set download_count = download_count + 1
        where id = $1
          and revoked_at is null
          and expires_at > now()
          and (max_downloads is null or download_count < max_downloads)
        returning download_count, max_downloads`, [link.id]));
  if (!claim.rows.length) return deny(sb, link.org_id, link.id, 'download_limit_or_state');

  const d = await sb.asService((c) =>
    c.query(`select storage_path from public.documents
             where id=$1 and deleted_at is null`, [link.document_id]));
  if (!d.rows.length) return deny(sb, link.org_id, link.id, 'document_deleted');

  // Audit BEFORE handing out the URL. If the process dies after this line the
  // log over-reports (a download that may not have completed) rather than
  // under-reporting. Over-reporting is the safe direction for an audit trail.
  await audit(sb, link.org_id, null, 'share_link', 'download',
              { share_link_id: link.id, document_id: link.document_id,
                download_count: claim.rows[0].download_count,
                max_downloads: claim.rows[0].max_downloads });

  const { signedUrl } = await sb.createSignedUrlAsService(
    BUCKET, d.rows[0].storage_path, SIGNED_URL_TTL_SEC);

  return { ok: true, signedUrl, residualRevocationWindowSec: SIGNED_URL_TTL_SEC,
           downloadCount: claim.rows[0].download_count };
}

async function deny(sb, orgId, shareLinkId, reason) {
  if (orgId)
    await audit(sb, orgId, null, 'share_link', 'view',
                { share_link_id: shareLinkId, outcome: 'denied', reason });
  return { ok: false, reason };
}
