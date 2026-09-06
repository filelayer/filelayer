/**
 * Share-link secrets. Substantively identical to
 * `../baseline-raw-s3/src/shares.mjs`.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  p: string, s: string, k: number
) => Promise<Buffer>;

export function mintShareToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 32)).toString('hex');
  return { hash, salt };
}

export async function verifyPassword(password: string, hash: string, salt: string) {
  const candidate = await scrypt(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

export type ShareRow = {
  revoked_at: string | null;
  expires_at: string;
  max_downloads: number | null;
  download_count: number;
  doc_status: string;
};

export function shareState(share: ShareRow, now = new Date()) {
  if (share.revoked_at) return 'revoked';
  if (new Date(share.expires_at) <= now) return 'expired';
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    return 'exhausted';
  }
  if (share.doc_status !== 'ready') return 'document_unavailable';
  return 'active';
}
