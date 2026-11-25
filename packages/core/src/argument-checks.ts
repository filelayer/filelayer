/**
 * The checks the library applies to a caller's own arguments, shared by
 * `Filelayer` and the facade (simple.ts), and the listing cursor encoding.
 *
 * In a module of its own, not re-exported by index.ts, because both callers
 * need them and neither may expose them.
 *
 * WHY THE FACADE NEEDS THEM TOO, since 0.37.0. A stranger must not be able to
 * tell an org that exists from one that does not (D081), and the facade
 * answers a missing org early: `files.list()` with an empty page, every
 * `orgs.*` method with `404 not_found`. If an argument were checked only on
 * the path that runs for a real org, a bad one would be an error there and the
 * early answer on a missing org, which is the same oracle by another door. So
 * the facade checks every argument it can before it looks the org up.
 */
import { FilelayerError } from './errors.ts';
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT, isUuid } from './store.ts';
import type { Capability, FileVisibility, OrgRole } from './authz.ts';

export const ORG_ROLES = ['viewer', 'member', 'admin', 'owner'] as const satisfies readonly OrgRole[];
export const VISIBILITIES = ['private', 'org'] as const satisfies readonly FileVisibility[];
export const CAPABILITIES = ['read', 'write', 'delete', 'share'] as const satisfies readonly Capability[];

/**
 * An enumerated argument outside its set is `invalid_argument` naming the
 * field and the values, since 0.36.0. Before, `role: 'editor'` or
 * `visibility: 'public'` reached the schema's CHECK constraint and came back
 * as a raw SQLSTATE, or (where the engine compared before inserting) as a
 * denial that read like a permission problem.
 */
export function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new FilelayerError('invalid_argument',
    `${field} must be one of ${allowed.join(', ')}, got ` +
      `${typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : typeof value}.`,
  );
}

/**
 * The capability a listing filters on, `read` when absent. Unchecked until
 * 0.37.0: a value outside the four reached SQL as `$4::grant_capability` and
 * came back as a raw Postgres error (22P02) carrying the query text and
 * internal ids, while a missing org answered an empty page.
 */
export function listCapability(capability: unknown): Capability {
  return capability === undefined ? 'read' : oneOf('capability', capability, CAPABILITIES);
}

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
