/**
 * The one error type the library throws.
 *
 * It lives in its own module so that the delivery layer (which must classify
 * errors in order to write a correct HTTP response) does not have to import the
 * whole `Filelayer` class, which imports the delivery layer.
 */

import type { DenyReason } from './authz.ts';

/**
 * EVERY CODE THIS LIBRARY THROWS, WITH THE STATUS IT MEANS.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Until `0.19.0`, `code` was typed `string`. Three things followed from that,
 * all of them bad for the reader this project claims to design for:
 *
 *   1. A `switch` over `e.code` got no help from the compiler. Writing
 *      `'not-found'` for `'not_found'` was a silent miss, in a branch that
 *      only runs when something has already gone wrong.
 *   2. There was no list. The published tables named eight codes; the library
 *      threw twenty-nine. A caller met `upload_not_received` or `bad_cursor`
 *      with nothing to tell them whether those were stable names.
 *   3. Nothing stopped a new code appearing in one place with one status and
 *      somewhere else with another.
 *
 * Typing the constructor against this object fixes all three at the compiler,
 * which is better than a gate: a code that is not here does not build.
 *
 * ---------------------------------------------------------------------------
 * `status` IS A FUNCTION OF `code`, AND THAT IS A PROMISE
 * ---------------------------------------------------------------------------
 *
 * One code always means one status. `forbidden` is always 403. That is checked
 * by the type of the constructor and again by `npm run check:errors`, because
 * a caller that branches on `code` must never have to also branch on `status`
 * to know what happened.
 *
 * `fix` is addressed to whoever has to act, which is not always the caller: a
 * `500` here is usually OUR CALLER'S CONFIGURATION rather than a failure, and
 * an agent reading a bare status cannot tell those apart.
 */
export const ERROR_CODES = {
  // --- the request was wrong -------------------------------------------------
  ambiguous_subject: {
    status: 400,
    meaning: 'A share named more than one kind of subject at once.',
    fix: 'Pass exactly one of `withUser` or `withOrg`. `minRole` is only meaningful with `withOrg`.',
  },
  bad_cursor: {
    status: 400,
    meaning: 'A listing cursor was not one this library issued.',
    fix: 'Pass back the `cursor` from the previous page unchanged, or omit it to start again.',
  },
  bad_request: {
    status: 400,
    meaning: 'A request body did not parse.',
    fix: 'Send valid JSON, or a form body, and a matching `content-type`.',
  },
  credential_in_query: {
    status: 400,
    meaning: 'A share-link request carried a credential in the query string.',
    fix: 'Put the password in a POST body. Query strings reach access logs, proxy logs and browser history.',
  },
  credential_in_query_string: {
    status: 400,
    meaning: 'An authorized-read request carried a credential in the query string.',
    fix: 'Same as `credential_in_query`, on the `/f` route. The two codes differ only by which route refused.',
  },
  invalid_argument: {
    status: 400,
    meaning: 'An argument was outside what the operation accepts.',
    fix: '`reason` names the argument. It is safe to log and is not shown to an untrusted caller.',
  },
  link_is_read_only: {
    status: 400,
    meaning: 'A share link was asked to carry a capability beyond `read`.',
    fix: 'Share with a named user or an org for anything other than reading. A link is a bearer token.',
  },
  link_principal_cannot_list: {
    status: 400,
    meaning: 'A caller holding only a share link tried to list files.',
    fix: 'A link grants one file. Listing needs an identity.',
  },
  password_requires_link_subject: {
    status: 400,
    meaning: 'A password was set on a share that is not a link.',
    fix: 'Only a link has somewhere to prompt. Drop the password, or make it a link.',
  },

  // --- identity and permission ------------------------------------------------
  password_required: {
    status: 401,
    meaning: 'This share link has a password and none, or a wrong one, was supplied.',
    fix: 'Re-issue as a POST with `password` in the body. The response carries `WWW-Authenticate: FilelayerShare`.',
  },
  forbidden: {
    status: 403,
    meaning:
      'The caller has standing on the resource and may not do this particular thing. Narrower than it looks: it is used where a 404 would be less useful and leaks nothing, such as delegating more authority than you hold.',
    fix: '`reason` names the refusal for your logs.',
  },
  not_found: {
    status: 404,
    meaning:
      'The resource does not exist, or the caller may not know that it does. These are deliberately the same answer: a permissions system that distinguishes them is a membership oracle.',
    fix: 'Nothing, from the caller. Check `reason` in your own logs to tell the two apart.',
  },

  // --- state ------------------------------------------------------------------
  org_exists: {
    status: 409,
    meaning: 'An org with that external id already exists under a different owner.',
    fix: 'Pick another id, or look the existing one up with `fl.ids.orgId()`.',
  },
  retention_hold: {
    status: 409,
    meaning: 'A delete was refused because the file is under a retention hold.',
    fix: 'Wait for the hold to lapse. It cannot be lifted through this API, which is the point of a hold.',
  },
  upload_not_received: {
    status: 409,
    meaning: 'A direct upload was completed but the object is not in the store.',
    fix: 'The client never finished the PUT, or sent it elsewhere. Reserve again.',
  },
  upload_size_mismatch: {
    status: 409,
    meaning: 'The object that arrived is not the size the upload was authorized for.',
    fix: 'Reserve again with the real size. The store should have refused this; if it did not, check that `content-length` is in the signed headers.',
  },
  gone: {
    status: 410,
    meaning: 'The grant that would have allowed this has expired.',
    fix: 'Ask the owner for a new link or a new grant.',
  },
  upload_reservation_expired: {
    status: 410,
    meaning: 'The upload window closed before the bytes arrived.',
    fix: 'Reserve again. A reservation is deliberately short.',
  },
  payload_too_large: {
    status: 413,
    meaning: 'A request body exceeded the limit for that route.',
    fix: 'Send less. For file bytes, use a direct upload rather than a body.',
  },
  range_not_satisfiable: {
    status: 416,
    meaning:
      'A `Range` header parsed cleanly and cannot be satisfied by this object. An INVALID range is not this: it is ignored, and the whole object is served under a 200.',
    fix: 'The response carries `Content-Range: bytes */<size>`, which is the size you needed in order to ask a better question.',
  },

  // --- your configuration, answered as 5xx because the caller cannot fix it ----
  direct_upload_not_acknowledged: {
    status: 500,
    meaning: 'Direct upload was configured without the verbatim acknowledgement string.',
    fix: 'Pass `DIRECT_UPLOAD_ACKNOWLEDGEMENT`. Handing the data path to the object store is a property you give up, not a setting you tune.',
  },
  direct_upload_bad_max: {
    status: 500,
    meaning: '`maxUploadBytes` was absent or not a positive integer.',
    fix: 'Choose a ceiling. There is deliberately no default, because an exact pin to whatever the client asked for is not a bound.',
  },
  direct_upload_bad_ttl: {
    status: 500,
    meaning: '`ttlSeconds` for a direct upload was below 60.',
    fix: 'Use at least 60. A shorter window fails real uploads on real networks.',
  },
  redirect_not_acknowledged: {
    status: 500,
    meaning: 'Redirect delivery was configured without the verbatim acknowledgement string.',
    fix: 'Pass `REDIRECT_ACKNOWLEDGEMENT`. A redirect stays valid for its whole TTL after a grant is revoked.',
  },
  redirect_bad_ttl: {
    status: 500,
    meaning: '`ttlSeconds` for redirect delivery was below 1.',
    fix: 'Use at least 1. Values above the maximum are clamped rather than refused.',
  },
  storage_cannot_list: {
    status: 500,
    meaning: 'Orphan collection was asked of a storage adapter that cannot list objects.',
    fix: 'Use an adapter that implements `list()`, or do not schedule `collectStorageOrphans()`.',
  },
  internal: {
    status: 500,
    meaning: 'Something failed that is not one of the above. This is the only code here that means a defect rather than a decision.',
    fix: 'Report it: https://github.com/filelayer/filelayer/issues',
  },

  // --- not implemented ---------------------------------------------------------
  direct_upload_not_enabled: {
    status: 501,
    meaning: 'Direct upload was requested on an instance that has not configured it.',
    fix: 'Configure `directUpload`, or use `upload()`, which sends bytes through your server and works on every adapter.',
  },
  direct_upload_unsupported: {
    status: 501,
    meaning: 'The configured storage adapter cannot sign an upload.',
    fix: '`reason` names the provider. `FsStorage` can mint a local upload token instead; `MemoryStorage` cannot sign at all.',
  },
} as const;

/**
 * Every code the library can produce. Exported so a `switch` over `e.code` is
 * exhaustive and a typo is a compile error rather than a branch that silently
 * never runs.
 */
export type ErrorCode = keyof typeof ERROR_CODES;

/** The status a given code always carries. */
export type ErrorStatus<C extends ErrorCode> = (typeof ERROR_CODES)[C]['status'];

/** True for a code this library defines. Useful at a boundary where it arrived as a string. */
export function isErrorCode(code: string): code is ErrorCode {
  return Object.hasOwn(ERROR_CODES, code);
}

export class FilelayerError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  /** Internal deny reason. Logged, never serialized to an untrusted caller. */
  readonly reason: DenyReason | string | undefined;
  /**
   * Response headers this error REQUIRES. Not decoration, and not a general
   * extension point.
   *
   * A 416 without `Content-Range: bytes * /<total>` is half an answer. RFC 9110
   * makes that field the thing that tells the client what the satisfiable
   * extent actually is, and a client that asked for bytes past the end of an
   * object has no other way to learn its size -- it asked precisely because it
   * did not know. Before this channel existed the error layer could carry the
   * status and not the header, so the one status code that is defined in terms
   * of a header could only ever be emitted wrong.
   *
   * Unset for every other error, and `errorHeaders()` still supplies the
   * security headers. These are merged ON TOP of those, so an error cannot
   * drop `nosniff` by accident.
   */
  readonly headers: Record<string, string> | undefined;

  /**
   * THE STATUS IS NOT AN ARGUMENT, AND THAT IS THE POINT.
   *
   * It used to be the first one: `new FilelayerError(404, 'not_found')`. The
   * status is a function of the code, so passing both meant 75 opportunities
   * for the two to disagree, and the only thing standing between us and a
   * `forbidden` that answered 404 in one branch was that nobody had made that
   * mistake yet. (Checked when this changed: at 73 call sites, nobody had.)
   *
   * Deriving it removes the class rather than guarding it. The cost is a
   * breaking change to a constructor in a 0.x alpha, which is the cheapest
   * moment this will ever be available.
   */
  constructor(code: ErrorCode, reason?: DenyReason | string, headers?: Record<string, string>) {
    super(code);
    this.name = 'FilelayerError';
    this.status = ERROR_CODES[code].status;
    this.code = code;
    this.reason = reason;
    this.headers = headers;
  }
}
