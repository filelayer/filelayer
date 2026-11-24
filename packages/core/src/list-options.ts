/**
 * The checks a listing applies to its own arguments, and the cursor encoding.
 *
 * In a module of its own, not re-exported by index.ts, because two callers
 * need them and neither may expose them: `Filelayer.listFiles()`, and
 * `files.list()` in simple.ts when the org named does not exist. That second
 * path answers an empty page without running the listing (since 0.37.0, so a
 * stranger cannot tell a missing org from one they cannot read), and it must
 * still refuse exactly the arguments the listing refuses. Otherwise a bad
 * cursor would be an error on a real org and an empty page on a missing one,
 * which is the same oracle by another door.
 */
import { FilelayerError } from './errors.ts';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, isUuid } from './store.ts';

/**
 * `Math.max(1, ...)` silently clamped `limit: 0` UP to one row, neither the
 * zero the caller asked for nor the default they would have got by omitting
 * it. Refused instead of guessing which one they meant.
 */
export function listLimit(limit: number | undefined): number {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new FilelayerError('invalid_argument', 'limit_must_be_a_positive_integer');
  }
  return Math.max(1, Math.min(limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT));
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new FilelayerError('bad_cursor');
  }
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw new FilelayerError('bad_cursor');
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !isUuid(id)) {
    throw new FilelayerError('bad_cursor');
  }
  return { createdAt, id };
}
