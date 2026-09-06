// =====================================================================
// src/app/vault.js  --  APPLICATION CODE (counted)
// =====================================================================
// Vault application logic on Supabase. Everything a user does goes through
// their own JWT so RLS is in the path; only audit appends use the service key,
// because audit_append is (deliberately) not executable by `authenticated`.
// =====================================================================

import { randomUUID } from 'node:crypto';

export const BUCKET = 'vault';

// Object names are used inside RLS policies via storage.foldername(). A
// filename containing '/' or '..' would change the path's segment structure
// and defeat the `(storage.foldername(name))[1] = org_id` check. Sanitising
// here is load-bearing, not cosmetic.
export function safeFilename(raw) {
  const base = String(raw).split('/').pop().split('\\').pop();
  // strip control characters, then any leading dots (defeats '..')
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!clean) throw new Error('invalid filename');
  return clean.slice(0, 200);
}

export const objectName = (orgId, docId, filename) => `${orgId}/${docId}/${filename}`;

async function audit(sb, orgId, actorId, actorKind, action, subject) {
  await sb.asService((c) =>
    c.query('select public.audit_append($1,$2,$3,$4,$5::jsonb)',
            [orgId, actorId, actorKind, action, JSON.stringify(subject)]));
}

// ---------------------------------------------------------------------
// Upload. Two writes that must both land: the documents row (which the
// storage RLS policy reads) and the storage object. They are in separate
// transactions against separate services, so they cannot be atomic.
// ---------------------------------------------------------------------
export async function uploadDocument(sb, token, { orgId, filename, bytes, mimeType }) {
  const docId = randomUUID();
  const name = safeFilename(filename);
  const path = objectName(orgId, docId, name);

  const ins = await sb.asUser(token, (c) =>
    c.query(
      `insert into public.documents (id, org_id, uploader_id, filename, storage_path,
                                     size_bytes, mime_type)
       values ($1,$2,(select auth.uid()),$3,$4,$5,$6) returning id, uploader_id`,
      [docId, orgId, name, path, bytes.length, mimeType ?? 'application/octet-stream']));

  try {
    await sb.upload(token, BUCKET, path, bytes, { mimeType });
  } catch (e) {
    // Compensating delete. If this process dies here the documents row is an
    // orphan pointing at nothing: a 404 on download, not a leak.
    await sb.asUser(token, (c) => c.query('delete from public.documents where id=$1', [docId]));
    throw e;
  }

  await audit(sb, orgId, ins.rows[0].uploader_id, 'user', 'upload',
              { document_id: docId, path });
  return { documentId: docId, path };
}

export async function listDocuments(sb, token, orgId) {
  const r = await sb.asUser(token, (c) =>
    c.query(`select id, filename, uploader_id, size_bytes, created_at
             from public.documents
             where org_id=$1 and deleted_at is null
             order by created_at`, [orgId]));
  return r.rows;
}

/** In-app view/download by a signed-in member. RLS gates the bytes. */
export async function downloadAsMember(sb, token, orgId, documentId) {
  const r = await sb.asUser(token, (c) =>
    c.query('select storage_path from public.documents where id=$1', [documentId]));
  if (!r.rows.length) { const e = new Error('not found'); e.status = 404; throw e; }
  const bytes = await sb.downloadAuthenticated(token, BUCKET, r.rows[0].storage_path);
  const who = await sb.asUser(token, (c) => c.query('select (select auth.uid()) as uid'));
  await audit(sb, orgId, who.rows[0].uid, 'user', 'download',
              { document_id: documentId, via: 'authenticated' });
  return bytes;
}

export async function softDeleteDocument(sb, token, orgId, documentId) {
  const r = await sb.asUser(token, (c) =>
    c.query('update public.documents set deleted_at=now() where id=$1 returning id',
            [documentId]));
  if (!r.rows.length) { const e = new Error('forbidden'); e.status = 403; throw e; }
  const who = await sb.asUser(token, (c) => c.query('select (select auth.uid()) as uid'));
  await audit(sb, orgId, who.rows[0].uid, 'user', 'delete', { document_id: documentId });
  return true;
}

export async function changeMemberRole(sb, token, orgId, targetUserId, newRole) {
  const r = await sb.asUser(token, (c) =>
    c.query(`update public.org_members set role=$3
             where org_id=$1 and user_id=$2 returning role`,
            [orgId, targetUserId, newRole]));
  if (!r.rows.length) { const e = new Error('forbidden'); e.status = 403; throw e; }
  const who = await sb.asUser(token, (c) => c.query('select (select auth.uid()) as uid'));
  await audit(sb, orgId, who.rows[0].uid, 'user', 'permission_change',
              { target_user: targetUserId, new_role: newRole });
  return r.rows[0].role;
}

export async function removeMember(sb, token, orgId, targetUserId) {
  const r = await sb.asUser(token, (c) =>
    c.query('delete from public.org_members where org_id=$1 and user_id=$2 returning user_id',
            [orgId, targetUserId]));
  if (!r.rows.length) { const e = new Error('forbidden'); e.status = 403; throw e; }
  const who = await sb.asUser(token, (c) => c.query('select (select auth.uid()) as uid'));
  await audit(sb, orgId, who.rows[0].uid, 'user', 'permission_change',
              { target_user: targetUserId, new_role: null });
  return true;
}

export async function readAuditLog(sb, token, orgId) {
  const r = await sb.asUser(token, (c) =>
    c.query(`select seq, actor_id, actor_kind, action, subject, occurred_at, hash
             from public.audit_log where org_id=$1 order by seq`, [orgId]));
  return r.rows;
}

export async function verifyAuditChain(sb, token, orgId) {
  const r = await sb.asUser(token, (c) => c.query('select * from public.audit_verify($1)', [orgId]));
  return r.rows[0];
}
