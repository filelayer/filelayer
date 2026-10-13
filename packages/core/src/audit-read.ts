/**
 * READING THE AUDIT TRAIL NEEDS A DATABASE AND NOTHING ELSE.
 *
 * =============================================================================
 * THE PROBLEM THIS SOLVES, WHICH WAS WRITTEN DOWN BEFORE IT WAS SOLVED
 * =============================================================================
 *
 * `cli.ts` has carried this paragraph since the CLI shipped:
 *
 *     No `filelayer audit`. Reading the trail needs a Filelayer instance, which
 *     needs a storage adapter it would never use [...] It is worth building and
 *     it is not worth guessing at.
 *
 * It was right about the obstacle and wrong about where the obstacle was. The
 * three reads -- `auditLog`, `verifyAuditChain`, `auditCheckpoints` -- reference
 * `this.storage` exactly zero times. `PostgresStore` takes a `Queryable` and
 * options, no storage. `authorizeOrg` takes the store, which is the whole
 * authorization path. **Nothing on the audit read path touches storage.**
 *
 * The requirement came from where the methods LIVE, not from what they DO. A
 * `Filelayer` is a file engine and a file engine needs somewhere to put bytes;
 * these three methods were sitting inside it and inheriting a precondition that
 * is none of their business.
 *
 * =============================================================================
 * THE THREE THINGS NOT DONE INSTEAD, AND WHY EACH IS WORSE
 * =============================================================================
 *
 *   1. **Pass a memory or null adapter.** It constructs a lie: the object would
 *      declare a `provider` -- which is part of an object's identity, half of
 *      `UNIQUE (storage_provider, storage_key)` -- for a store it never writes
 *      to. And an adapter that is present is an adapter somebody will use: the
 *      next person to want a quick file read from the same instance gets one,
 *      against a backend that holds nothing.
 *
 *   2. **Query `audit_event` directly, from the CLI or anywhere.** It skips
 *      `authorizeOrg`, so the read is not authorized; and since 0.27.0 a read
 *      of the trail is itself an audited act, so it would also not be recorded.
 *      That is not a shortcut, it is undoing a feature by going around it.
 *
 *   3. **Make `storage` optional on `Filelayer` and throw on use.** An object
 *      that claims to be a file engine and refuses half its methods is a
 *      partial truth, and this project does not ship those. The honest shape
 *      for "less than a Filelayer" is a different, smaller object.
 *
 * =============================================================================
 * SO: ONE IMPLEMENTATION, TWO DOORS
 * =============================================================================
 *
 * The functions below are the implementation. `Filelayer` delegates its three
 * methods to them and `auditReader` binds them to a bare store, so there is
 * exactly one authorization path and one place the `audit.read` event is
 * written. Two copies of an authorization decision is the defect this file
 * would otherwise introduce while fixing a smaller one.
 *
 * WHO ELSE WANTED THIS. Not only the CLI. An application with a read-only
 * compliance dashboard had to construct a storage adapter to show an audit
 * table, for the same reason and with the same lack of justification. This is
 * an API correction that the CLI then benefits from, which is the right order:
 * a narrow reader is right on its own merits.
 *
 * WHAT IT DOES NOT DECIDE. Whether `filelayer audit` should exist, and on whose
 * authority it would read. That is a question about what an operator tool may
 * claim, not about storage, and it is still open. This file removes the
 * obstacle and settles nothing about the answer.
 */

import { authorizeOrg, toPublicError, type Decision } from './authz.ts';
import type { Queryable } from './db.ts';
import { FilelayerError } from './errors.ts';
import {
  PostgresStore,
  type AuditChainResult,
  type AuditCheckpoint,
  type AuditFilter,
  type ResolvedAuditRow,
  type StoreOptions,
} from './store.ts';
import type { Principal } from './authz.ts';

/**
 * Turn a denial into the public error.
 *
 * Extracted from `Filelayer`'s private `#raise`, unchanged. A private method
 * cannot be shared, and two copies of "which denial becomes which status code"
 * is the kind of duplication that ends with one of them leaking a reason.
 */
export function raiseDecision(
  decision: Decision,
): asserts decision is Extract<Decision, { allow: true }> {
  if (decision.allow) return;
  const pub = toPublicError(decision.reason);
  throw new FilelayerError(pub.code, decision.reason);
}

/**
 * The trail for an org.
 *
 * READING IT IS ITSELF AN AUDITED ACT, since 0.27.0. One row per call, carrying
 * the filter the caller asked for. See `LIMITATIONS.md` history and the
 * 0.27.0 changelog entry: the short version is that a trail which answers "who
 * touched this file" and not "who read the trail" has a hole in the shape of
 * the person most likely to use it.
 *
 * The rows it returned are NOT recorded. The filter is five scalars and none is
 * sensitive; the rows are the tenant's whole history.
 */
export async function readAuditLog(
  store: PostgresStore,
  principal: Principal,
  orgId: string,
  filter: AuditFilter = {},
): Promise<ResolvedAuditRow[]> {
  const decision = await authorizeOrg(store, principal, orgId, 'read_audit', {
    action: 'audit.read',
    context: { filter },
  });
  raiseDecision(decision);
  return store.listAuditResolved(orgId, filter);
}

/**
 * Verify the tamper-evidence chain for an org.
 *
 * Authorized and recorded like the read above. `checked` is a count of
 * everything that has ever happened in the org, so an unauthenticated caller
 * must not be able to measure another tenant's activity -- and learning that a
 * chain is intact is information about that tenant just as learning it is not.
 */
export async function verifyAuditChain(
  store: PostgresStore,
  principal: Principal,
  orgId: string,
): Promise<AuditChainResult> {
  const decision = await authorizeOrg(store, principal, orgId, 'read_audit', {
    action: 'audit.verify',
  });
  raiseDecision(decision);
  return store.verifyAuditChain(orgId);
}

/**
 * Every checkpoint on a chain: the trims that removed history, and the seals
 * that recorded where it had reached.
 *
 * Authorized like the trail itself, and for the same reason: the number and
 * timing of a tenant's retention runs is information about that tenant.
 */
export async function readAuditCheckpoints(
  store: PostgresStore,
  principal: Principal,
  orgId: string,
): Promise<AuditCheckpoint[]> {
  const decision = await authorizeOrg(store, principal, orgId, 'read_audit', {
    action: 'audit.checkpoints',
  });
  raiseDecision(decision);
  return store.auditCheckpoints(orgId);
}

/** What `auditReader` returns. Three reads, no writes to files, no storage. */
export interface AuditReader {
  readonly store: PostgresStore;
  log(principal: Principal, orgId: string, filter?: AuditFilter): Promise<ResolvedAuditRow[]>;
  verify(principal: Principal, orgId: string): Promise<AuditChainResult>;
  checkpoints(principal: Principal, orgId: string): Promise<AuditCheckpoint[]>;
}

/**
 * An audit reader over your own database. Needs no storage adapter, because
 * reading the trail needs no storage.
 *
 * ```ts
 * import { Pool } from 'pg';
 * import { auditReader } from '@filelayer/core';
 *
 * const audit = auditReader(new Pool({ connectionString: process.env.DATABASE_URL }));
 * const rows = await audit.log({ actorId: adminId }, orgId, { limit: 50 });
 * ```
 *
 * IT STILL AUTHORIZES. `read_audit` means admin or owner of that org, exactly
 * as through a `Filelayer`, and a caller without it is denied and the denial is
 * recorded. Holding a connection is not standing: this object is narrower than
 * a `Filelayer`, not more trusting than one.
 *
 * AND IT STILL RECORDS. A successful read appends `audit.read`. An operator
 * tool built on this leaves the same trace an application does, which is the
 * property that made 0.27.0 worth shipping.
 */
export function auditReader(db: Queryable, opts: StoreOptions = {}): AuditReader {
  const store = new PostgresStore(db, opts);
  return {
    store,
    log: (principal, orgId, filter = {}) => readAuditLog(store, principal, orgId, filter),
    verify: (principal, orgId) => verifyAuditChain(store, principal, orgId),
    checkpoints: (principal, orgId) => readAuditCheckpoints(store, principal, orgId),
  };
}
