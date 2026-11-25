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

// -----------------------------------------------------------------------------
// THE INPUT GUARD, since 0.37.1 (LIMITATIONS 19 until then).
// -----------------------------------------------------------------------------
//
// A few malformed arguments got past every check and failed further down: a
// NUL byte in a name or an id (Postgres 22021), a value Postgres cannot read as
// its column type (22P02, 22P05, 22007, 22008 and the rest of class 22), an
// object where a string id goes (PGlite's "Invalid input for string type"), an
// `expiresIn` too large to be a date (`RangeError: Invalid time value`), or a
// non-string secret reaching a hash (`TypeError` `ERR_INVALID_ARG_TYPE`).
// What came back was not a FilelayerError, and the Postgres ones carried the
// SQL text and its parameters, the project's internal id among them, in
// enumerable `query` and `params` fields.
//
// One function turns all of them into `invalid_argument` with a fixed reason
// that names the kind of value, never the statement or its parameters, and
// `guardInputErrors()` puts it around every public async method of the core
// class and the facade, once, so a method added later is covered without
// anyone remembering to.

const SQLSTATE_REASON: Record<string, string> = {
  '22021': 'a string contains a NUL byte or is not valid UTF-8.',
  '22P05': 'a value contains a character the database cannot store (such as a NUL byte).',
  '22P02': 'a value is not in the form its field takes (an id, a number, a date).',
  '22007': 'a date or time is not in a form the database reads.',
  '22008': 'a date or time is out of range.',
  '22003': 'a number is out of range.',
  '22001': 'a string is longer than its field allows.',
};

/** The input error, or `err` itself when it is not one. Never adds the cause. */
export function inputError(err: unknown): unknown {
  if (err instanceof FilelayerError || err === null || typeof err !== 'object') return err;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) {
    return new FilelayerError('invalid_argument', SQLSTATE_REASON[code] ?? `a value was refused by the database (SQLSTATE ${code}).`);
  }
  const message = err instanceof Error ? err.message : '';
  if (err instanceof Error && /^Invalid input for (string|uuid|.*) type/i.test(message)) {
    return new FilelayerError('invalid_argument', 'a value is not of the type its field takes (an object where a string goes).');
  }
  if (err instanceof RangeError && message === 'Invalid time value') {
    return new FilelayerError('invalid_argument', 'a time or a duration is out of range.');
  }
  if (err instanceof TypeError && code === 'ERR_INVALID_ARG_TYPE') {
    return new FilelayerError('invalid_argument', 'a value is not of the type its field takes (a string was expected).');
  }
  return err;
}

/**
 * Wraps every own async method of `proto` (string- and symbol-keyed) so an
 * input error leaves as `invalid_argument`. Sync methods and getters are left
 * alone, so nothing that returned a value starts returning a promise.
 */
export function guardInputErrors(proto: object): void {
  for (const key of Reflect.ownKeys(proto)) {
    if (key === 'constructor') continue;
    const d = Object.getOwnPropertyDescriptor(proto, key);
    const fn = d?.value;
    if (typeof fn !== 'function' || fn.constructor?.name !== 'AsyncFunction') continue;
    const guarded = async function (this: unknown, ...args: unknown[]) {
      try {
        return await fn.apply(this, args);
      } catch (err) {
        throw inputError(err);
      }
    };
    // The same name and arity as the method it wraps: callers and tests read both.
    Object.defineProperty(guarded, 'name', { value: fn.name });
    Object.defineProperty(guarded, 'length', { value: fn.length });
    Object.defineProperty(proto, key, { ...d, value: guarded });
  }
}
