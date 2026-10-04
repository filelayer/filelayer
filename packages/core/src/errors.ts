/**
 * The one error type the library throws.
 *
 * It lives in its own module so that the delivery layer (which must classify
 * errors in order to write a correct HTTP response) does not have to import the
 * whole `Filelayer` class, which imports the delivery layer.
 */

import type { DenyReason } from './authz.ts';

export class FilelayerError extends Error {
  readonly status: number;
  readonly code: string;
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

  constructor(
    status: number,
    code: string,
    reason?: DenyReason | string,
    headers?: Record<string, string>,
  ) {
    super(code);
    this.name = 'FilelayerError';
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.headers = headers;
  }
}
