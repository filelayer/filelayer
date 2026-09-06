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

  constructor(status: number, code: string, reason?: DenyReason | string) {
    super(code);
    this.name = 'FilelayerError';
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}
