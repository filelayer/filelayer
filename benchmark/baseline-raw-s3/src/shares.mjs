import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/**
 * Share-link secret handling.
 *
 * The raw share token is returned to the creator exactly once and never
 * stored. The database holds only SHA-256(token), so a database dump does not
 * yield working share links. SHA-256 without a work factor is correct here
 * *because* the token is 256 bits of CSPRNG output — there is nothing to
 * brute force. The same is emphatically not true of the share password, which
 * is human-chosen and therefore uses scrypt.
 */

export function mintShareToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 32)).toString('hex');
  return { hash, salt };
}

export async function verifyPassword(password, hash, salt) {
  const candidate = await scrypt(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  // Length check first: timingSafeEqual throws on length mismatch.
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/** Reasons a share is dead. Ordered so the caller can log the precise cause. */
export function shareState(share, now = new Date()) {
  if (share.revoked_at) return 'revoked';
  if (new Date(share.expires_at) <= now) return 'expired';
  if (share.max_downloads !== null && share.download_count >= share.max_downloads) {
    return 'exhausted';
  }
  if (share.doc_status !== 'ready') return 'document_unavailable';
  return 'active';
}
