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
// its column type (22P02, 22P05, 22007, 22008 and the rest of class 22), or an
// object where a string goes (PGlite's "Invalid input for string type"). What
// came back was not a FilelayerError, and it carried the SQL text and its
// parameters, the project's internal id among them, in enumerable `query` and
// `params` fields.
//
// Only DATABASE errors are mapped. A RangeError or TypeError is not: it can as
// well come from a custom StorageAdapter or a bug, and reporting that as the
// caller's bad argument would hide a server fault behind a 400. The two such
// errors input could cause (an `expiresIn` too large to be a date, a
// non-string secret or password) are now checked where they are used.
// The one server-side cause of class 22 found, a `projectId` that is not a
// uuid, is refused by the constructor.
//
// The original error stays available to the operator as `err.cause`: not
// enumerable and not in `toJSON()`, like `reason`, so it reaches a server log
// that asks for it (and Node's `util.inspect`), never a response body.
//
// `guardInputErrors()` puts `inputError` around every public method declared
// `async` on the core class and the facade, once. It covers a method added
// later only if that method is declared `async`: an async generator, a plain
// method that returns a promise, an arrow-function property or a subclass
// override is not wrapped.
//
// Inside a `#transaction` callback a FilelayerError means "a decided outcome,
// commit it". The guard runs outside the callback, on the public method's
// result, so a raw database error inside a transaction still rolls it back
// before it is converted. Nothing in a callback should call `inputError`.

const SQLSTATE_REASON: Record<string, string> = {
  '22021': 'a string contains a NUL byte or is not valid UTF-8.',
  '22P05': 'a value contains a character the database cannot store (such as a NUL byte).',
  '22P02': 'a value is not in the form its field takes (an id, a number, a date).',
  '22007': 'a date or time is not in a form the database reads.',
  '22008': 'a date or time is out of range.',
  '22003': 'a number is out of range.',
  '22001': 'a string is longer than its field allows.',
};

/** The input error, or `err` itself when it is not one. */
export function inputError(err: unknown): unknown {
  if (err instanceof FilelayerError || err === null || typeof err !== 'object') return err;
  const code = (err as { code?: unknown }).code;
  let mapped: FilelayerError | null = null;
  if (typeof code === 'string' && /^22[0-9A-Z]{3}$/.test(code)) {
    mapped = new FilelayerError('invalid_argument', SQLSTATE_REASON[code] ?? `a value was refused by the database (SQLSTATE ${code}).`);
  } else if (err instanceof Error && /^Invalid input for (string|text|uuid|json|jsonb) type\b/.test(err.message)) {
    mapped = new FilelayerError('invalid_argument', 'a value is not of the type its field takes (an object where a string goes).');
  }
  if (mapped === null) return err;
  Object.defineProperty(mapped, 'cause', { value: err, enumerable: false, writable: false, configurable: true });
  return mapped;
}

/**
 * An external id (a user, an owner, an org, an `as`): a non-empty string with
 * no NUL byte. The facade checks every one a call takes BEFORE it looks the org
 * up (0.37.1), so a malformed id is the same `invalid_argument` whether the org
 * exists or not; checked only on the path that runs for a real org, it was a
 * 400 there and a 404 on a missing one.
 */
export function checkExternalId(field: string, value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.includes('\u0000')) {
    throw new FilelayerError('invalid_argument', `${field} must be a non-empty string with no NUL byte.`);
  }
  return value;
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
