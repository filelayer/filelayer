/**
 * FILELAYER -- the surface an application developer actually touches.
 *
 * Design rule for this file: every method that touches a file or an org calls
 * into the authorization engine and does nothing before it. There is no
 * "internal" variant that skips the check, because the moment such a variant
 * exists someone will call it from a route handler at 6pm on a Friday.
 *
 * SECOND design rule, added after the security review: this file contains no
 * security LOGIC, only security PLUMBING. Every rule that used to live here as
 * a "patch at the wrong layer" has moved into `authz.ts` or `schema.sql`:
 *
 *   - capability attenuation on share       -> authorizeShare() + a BEFORE
 *                                              INSERT trigger on file_grant
 *   - the 410/409 existence-oracle downgrade
 *     and its `hasStanding()` helper        -> evaluation order in authorize()
 *   - the membership / viewer checks in
 *     upload()                              -> authorizeOrg('create_file')
 *   - the admin check in auditLog()         -> authorizeOrg('read_audit')
 *   - the unaudited early return in redeem()
 *     for unknown secrets                   -> the engine's system chain
 *
 * Errors are thrown as `FilelayerError`, already collapsed through
 * `toPublicError`, so the developer cannot accidentally return our internal
 * deny reason to an attacker. That collapsing is a security-sensitive decision
 * we make once, here, instead of asking the developer to make it per-route.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  auditUnresolvedSecret,
  authorize,
  authorizeList,
  authorizeMembershipChange,
  authorizeOrg,
  authorizeRevoke,
  authorizeShare,
  schemaRefusal,
  toPublicError,
  type Capability,
  type Decision,
  type FileRef,
  type FileVisibility,
  type GrantSubjectType,
  type OrgRole,
  type Principal,
} from './authz.ts';
import {
  CommitThenThrow,
  withTransaction,
  type Queryable,
  type Tx,
} from './db.ts';
import {
  PostgresStore,
  DEFAULT_PROJECT_ID,
  isUuid,
  toCapabilities,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  type AuditFilter,
  type AuditChainResult,
  type ResolvedAuditRow,
} from './store.ts';
import {
  canList,
  canPresign,
  canPresignPut,
  collectStream,
  type ObjectStream,
  type PresignedUpload,
  type PutBody,
  type StorageAdapter,
} from './storage.ts';
import { FilesApi, OrgsApi, SharesApi } from './simple.ts';
import {
  contentDisposition,
  deliveryHeaders,
  isActiveContentType,
  redirectHeaders,
  resolveRedirectConfig,
  safeContentType,
  type Disposition,
  type ProxyDelivery,
  type RangeSpec,
  type RedirectDelivery,
  type RedirectDeliveryConfig,
  type ResolvedRedirectConfig,
  type StreamedDelivery,
} from './delivery.ts';
import { FilelayerError } from './errors.ts';

// Declared in `errors.ts` so that `delivery.ts` can classify errors without
// importing this module (which imports `delivery.ts`). Re-exported here because
// this is where every existing caller imports it from.
export { FilelayerError };

export interface UploadInput {
  name: string;
  contentType: string;
  /**
   * Advisory. The AUTHORITATIVE size is what the adapter reports it actually
   * wrote, and that is what lands in `size_bytes`. A caller-supplied size that
   * disagrees with the object is how a `content-length` ends up truncating a
   * download.
   */
  size?: number;
  /**
   * Bytes, or a stream of bytes.
   *
   * A `Uint8Array` is the convenient form for the small-file case that
   * dominates (avatars, PDFs, attachments) and is kept for exactly that reason.
   * A `ReadableStream` is the form that does not put the whole object on the
   * heap: with the S3 adapter it becomes a multipart upload whose peak memory
   * is one part, whatever the object's size.
   */
  body: PutBody;
  /**
   * Who, inside the owning org, can see this file before anybody shares it.
   *
   *   'private' (DEFAULT) -- owner + org admins/owners only. Everyone else
   *                          needs an explicit grant.
   *   'org'               -- every member of the org may read it.
   *
   * The default is the restrictive one. See schema.sql, `file_visibility`.
   */
  visibility?: FileVisibility;
  /** Seconds until the file itself expires (lifecycle, not a grant). */
  expiresIn?: number;
  /** Seconds of retention floor: deletion is blocked until it passes. */
  retainFor?: number;
  metadata?: Record<string, unknown>;
}

/**
 * WHO a grant is for. A grant's subject is a PRINCIPAL SET (RFC-001):
 *
 *   actor      exactly one person
 *   role       every member of an org at role >= `minRole`
 *   org        every member of an org, at any role
 *   link       whoever holds the secret (bearer, not identity)
 *   anonymous  everyone
 *
 * `org` and `role` may name an org OTHER than the file's own -- that is the
 * point ("the company that posted this job may read this CV") -- but it must be
 * an org in the same PROJECT. Cross-project is unrepresentable, by composite
 * foreign key, and refused here with a 404 before it gets that far.
 *
 * I6: an issuer whose own authority came from a GRANT may only mint `actor` or
 * `link`. See `authorizeShare`.
 */
export type ShareSubject =
  | { type: 'link' }
  | { type: 'anonymous' }
  | { type: 'actor'; actorId: string }
  /** Every member of `orgId`, at any role. */
  | { type: 'org'; orgId: string }
  /** Every member of `orgId` at `minRole` or above. */
  | { type: 'role'; orgId: string; minRole: OrgRole };

export interface ShareInput {
  subject: ShareSubject;
  capabilities?: Capability[];
  expiresIn?: number;
  maxDownloads?: number;
  password?: string;
}

export interface ShareResult {
  grantId: string;
  /** Returned exactly once. Only its SHA-256 is persisted. */
  secret?: string;
  url?: string;
  /**
   * The EFFECTIVE lifetime and cap, after attenuation against the parent grant.
   * A delegated share can never exceed the authority it came from, so these may
   * be tighter than what was asked for. They are returned rather than silently
   * applied so that the clamp is visible to the caller.
   */
  expiresAt: Date | null;
  maxDownloads: number | null;
  /** Non-null when this grant was delegated from another grant (P4). */
  parentGrantId: string | null;
}

export interface FileRecord extends FileRef {
  name: string;
  contentType: string;
  sizeBytes: number | null;
  /**
   * WHICH store the bytes are in. This column used to be written as the literal
   * `'memory'` on every insert regardless of the configured adapter, which
   * meant a production deployment recorded every object as living in an
   * in-process Map. It participates in `file_storage_key_idx`
   * (UNIQUE (storage_provider, storage_key)), so it is half of an object's
   * identity, not a label.
   */
  storageProvider: string;
  storageKey: string;
  createdAt: Date;
}

/**
 * A COMMITTED delivery decision, waiting for bytes.
 *
 * The split between this and the bytes is the whole shape of the fix: the
 * decision, the download charge and the audit event commit as one unit, and
 * only then does anything touch the object store -- which can take minutes and
 * must not hold a database connection while it does.
 */
type Reservation =
  | {
      kind: 'proxy';
      file: FileRecord;
      headers: Record<string, string>;
      remainingDownloads: number | null;
      grantId: string | null;
      /**
       * The range this delivery will actually serve, decided at RESERVATION
       * time rather than read from the caller's options at fetch time.
       *
       * It exists because the two are allowed to differ: a request whose range
       * was dropped because a download cap binds must be served whole, and the
       * decision to drop it is made here, next to the cap. Carrying the
       * effective range on the reservation is what stops `#fetchDelivery` from
       * re-reading `opts.range` and quietly honouring a range the reservation
       * already declined.
       */
      range: RangeSpec | null;
    }
  | {
      kind: 'redirect';
      file: FileRecord;
      headers: Record<string, string>;
      remainingDownloads: number | null;
      grantId: string | null;
      url: string;
      expiresAt: Date;
      ttlSeconds: number;
      cacheable: boolean;
    };

export interface GrantSummary {
  id: string;
  fileId: string;
  parentGrantId: string | null;
  subjectType: GrantSubjectType;
  subjectId: string | null;
  /** The org whose members are the subject, for 'org' and 'role' grants. */
  subjectOrgId: string | null;
  /** The role floor, for 'role' grants. Null on 'org' reads as 'viewer'. */
  subjectMinRole: OrgRole | null;
  capabilities: Capability[];
  hasPassword: boolean;
  expiresAt: Date | null;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: Date | null;
  /** Recursive liveness: false if this grant OR any ancestor is dead. */
  live: boolean;
  createdBy: string | null;
  createdAt: Date;
}

export interface FilelayerOptions {
  baseUrl?: string;
  /**
   * The customer application this instance speaks for (P8).
   *
   * In a hosted deployment the API layer resolves a project from the request's API
   * key and constructs one of these bound to it. A bound instance cannot see,
   * list, audit or address anything in another project. Omit it and everything
   * lands in the default project, which is the correct behaviour for a
   * single-project deployment. Pass `null` for the control plane.
   */
  projectId?: string | null;

  /**
   * OPT-IN REDIRECT DELIVERY. Absent means every delivery is proxied, which is
   * the only mode with an unqualified "revocation is immediate" guarantee.
   *
   * Read the DELIVERY MODES block at the top of `delivery.ts` before setting
   * this. It will not typecheck without the acknowledgement string, and the
   * acknowledgement string says what you are accepting.
   */
  redirectDelivery?: RedirectDeliveryConfig;

  /**
   * OPT-IN PRE-AUTHORIZED DIRECT UPLOAD. Absent means `createUpload()` refuses,
   * and every byte entering the system goes through `upload()` and therefore
   * through your process.
   *
   * It is opt-in for the same reason `redirectDelivery` is, and the reason is
   * not squeamishness: turning it on GIVES UP A PROPERTY. With direct upload
   * the decision still happens here -- that is what "pre-authorized" means, and
   * it is why this is not a hole -- but the BYTES do not. Filelayer no longer
   * sees them, so it cannot measure them, cannot reject them on content, and
   * learns an upload happened only when something tells it. See
   * `DIRECT_UPLOAD_ACKNOWLEDGEMENT`, which says that out loud.
   */
  directUpload?: DirectUploadConfig;
}

/**
 * The string you have to type to turn direct upload on.
 *
 * It exists because the thing being accepted is not obvious from the feature's
 * name. "Direct upload" sounds like a performance setting. What it actually
 * changes is that a file row can exist before its bytes do, and that the size
 * and the arrival of those bytes are enforced by the object store rather than
 * by this library.
 */
export const DIRECT_UPLOAD_ACKNOWLEDGEMENT =
  'I accept that upload bytes bypass my application and are enforced by the object store';

/** Our ceiling on how long an upload credential may live. */
export const MAX_UPLOAD_TTL_SECONDS = 3600;
export const DEFAULT_UPLOAD_TTL_SECONDS = 900;

export interface DirectUploadConfig {
  /** Must be exactly `DIRECT_UPLOAD_ACKNOWLEDGEMENT`. Checked at runtime too. */
  acknowledgeBytesBypassApplication: typeof DIRECT_UPLOAD_ACKNOWLEDGEMENT;
  /** Clamped to [60, MAX_UPLOAD_TTL_SECONDS]. */
  ttlSeconds?: number;
  /**
   * The largest `size` `createUpload()` will sign. REQUIRED, and there is no
   * default.
   *
   * A presigned PUT whose `content-length` is signed is pinned to an exact
   * size -- but the caller chooses that size, and the caller is your
   * application acting on a number from a browser. Without a ceiling here,
   * "pinned exactly" means "pinned to whatever the client asked for", and the
   * bill is the same as if nothing had been pinned at all. This is the only
   * place that bound can live, because it is the only place that knows your
   * intent rather than the request's.
   */
  maxUploadBytes: number;
}

export interface ResolvedDirectUploadConfig {
  ttlSeconds: number;
  maxUploadBytes: number;
}

export function resolveDirectUploadConfig(cfg: DirectUploadConfig): ResolvedDirectUploadConfig {
  if (cfg.acknowledgeBytesBypassApplication !== DIRECT_UPLOAD_ACKNOWLEDGEMENT) {
    throw new FilelayerError(
      500,
      'direct_upload_not_acknowledged',
      'direct upload requires the verbatim DIRECT_UPLOAD_ACKNOWLEDGEMENT string',
    );
  }
  if (!Number.isSafeInteger(cfg.maxUploadBytes) || cfg.maxUploadBytes < 1) {
    throw new FilelayerError(
      500,
      'direct_upload_bad_max',
      'maxUploadBytes must be a positive integer; there is deliberately no default',
    );
  }
  const requested = cfg.ttlSeconds ?? DEFAULT_UPLOAD_TTL_SECONDS;
  if (!Number.isFinite(requested) || requested < 60) {
    throw new FilelayerError(
      500,
      'direct_upload_bad_ttl',
      'ttlSeconds must be >= 60: a shorter window fails real uploads on real networks',
    );
  }
  return {
    // Clamped rather than rejected, exactly as the redirect TTL is: a config
    // asking for a week gets an hour and keeps working.
    ttlSeconds: Math.min(Math.floor(requested), MAX_UPLOAD_TTL_SECONDS),
    maxUploadBytes: cfg.maxUploadBytes,
  };
}

export class Filelayer {
  readonly store: PostgresStore;

  private readonly db: Queryable;
  private readonly storage: StorageAdapter;
  private readonly opts: FilelayerOptions;

  private _files?: FilesApi;
  private _orgs?: OrgsApi;
  private _shares?: SharesApi;

  /** Null unless redirect delivery was configured AND acknowledged. */
  private readonly redirect: ResolvedRedirectConfig | null;

  /** Null unless direct upload was configured AND acknowledged. */
  private readonly directUpload: ResolvedDirectUploadConfig | null;

  constructor(db: Queryable, storage: StorageAdapter, opts: FilelayerOptions = {}) {
    this.db = db;
    this.storage = storage;
    this.opts = opts;
    // A provider name is half of an object's primary identity (see the UNIQUE
    // index). An adapter that does not supply one is a configuration error, not
    // a default to guess at -- guessing is how it became 'memory' in the first
    // place.
    if (typeof storage.provider !== 'string' || storage.provider.length === 0) {
      throw new Error('storage adapter must declare a non-empty `provider`');
    }
    this.store = new PostgresStore(db, {
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    });
    this.redirect = opts.redirectDelivery ? resolveRedirectConfig(opts.redirectDelivery) : null;
    this.directUpload = opts.directUpload ? resolveDirectUploadConfig(opts.directUpload) : null;
  }

  /**
   * Run a unit of work in one transaction, on one connection.
   *
   * `fn` receives a store bound to the transaction, so the audit events the
   * engine writes and the mutation they describe commit together -- and so
   * `audit_append()`'s advisory lock, which is a `pg_advisory_XACT_lock`, is
   * held across the whole unit rather than across one autocommit statement.
   *
   * THE ONE SUBTLETY, AND IT IS THE IMPORTANT ONE.
   *
   * A DENIAL writes an audit event and then throws. If a throw always rolled
   * back we would lose exactly the events P5 exists to keep, silently, while
   * the caller still saw their 403 -- an audit log that omits refusals is worse
   * than no audit log, because it looks complete.
   *
   * So `FilelayerError` -- and ONLY `FilelayerError` -- is treated as a DECIDED
   * outcome: commit, then throw. Every `FilelayerError` this library raises is
   * a decision or a lookup miss, never a half-applied mutation; the one place
   * that could have been (the schema attenuation backstop in `share()`) uses a
   * SAVEPOINT so the failed INSERT is undone before the deny event is written.
   * Anything else -- a driver error, an unanticipated constraint, a bug --
   * rolls the whole unit back.
   */
  /**
   * See `lockOrgForMembershipChange` at the foot of this file.
   */
  #transaction<T>(fn: (tx: Tx, store: PostgresStore) => Promise<T>): Promise<T> {
    return withTransaction(this.db, async (tx) => {
      try {
        return await fn(tx, this.store.withDb(tx));
      } catch (err) {
        if (err instanceof FilelayerError) throw new CommitThenThrow(err);
        throw err;
      }
    });
  }

  /**
   * A throwaway, in-process instance: PGlite + in-memory bytes.
   *
   * For a five-minute first run and for tests. **Everything is lost when the
   * process exits** -- there is no file on disk and no bucket. Production is
   * `new Filelayer(pgPool, new S3Storage({...}), { baseUrl })`; see
   * docs/QUICKSTART.md, which does not hide the three configuration steps.
   */
  static async quickstart(opts: { baseUrl?: string } = {}): Promise<Filelayer> {
    const { createTestDb } = await import('./db.ts');
    const { MemoryStorage } = await import('./storage.ts');
    const { db } = await createTestDb();
    return new Filelayer(db, new MemoryStorage(), {
      baseUrl: opts.baseUrl ?? 'http://localhost:3000',
    });
  }

  /** Where public URLs are rooted. Read-only; set once at construction. */
  get baseUrl(): string | undefined {
    return this.opts.baseUrl;
  }

  /** The project this instance is bound to. Null means unscoped. */
  get projectId(): string | null {
    return this.store.projectId;
  }

  // ---------------------------------------------------------------------------
  // The tiered surface (see src/simple.ts). Purely additive: every method below
  // this line is unchanged, and the facade calls into it rather than around it.
  // ---------------------------------------------------------------------------

  get files(): FilesApi {
    return (this._files ??= new FilesApi(this));
  }

  get orgs(): OrgsApi {
    return (this._orgs ??= new OrgsApi(this));
  }

  get shares(): SharesApi {
    return (this._shares ??= new SharesApi(this));
  }

  // ---------------------------------------------------------------------------
  // Tenancy
  // ---------------------------------------------------------------------------

  /**
   * Create an organization, optionally with its first owner.
   *
   * Creating a tenant is a control-plane operation: there is no principal
   * inside the system yet who could be authorized to do it, and pretending
   * otherwise would be theatre. Passing `ownerActorId` closes the bootstrap
   * gap that would otherwise exist -- an org is never memberless, so there is
   * never a "the org has no members yet, let anyone in" path for an attacker to
   * find. Every subsequent membership change is authorized (see `addMember`).
   */
  async createOrg(
    externalId: string,
    name?: string,
    opts: { ownerActorId?: string } = {},
  ): Promise<{ id: string }> {
    // THE THREE STATEMENTS BELOW USED TO BE THREE TRANSACTIONS.
    //
    // The org INSERT committed on its own. If the membership INSERT then failed
    // -- and a well-formed but unregistered `ownerActorId` is enough, because
    // the membership foreign key rejects it -- the result was an org row that
    // had committed with NO owner. That state is not merely untidy, it is
    // TERMINAL: nobody holds `manage_members`, so no principal can create the
    // first membership; `createOrg` again hits the unique constraint on
    // (project_id, external_id); and the 0.6.0 `created` gate in `simple.ts`
    // correctly refuses to bootstrap an owner into an org that already exists.
    // The external id was burned and the tenant was permanently unadministrable
    // short of raw SQL.
    //
    // The audit statement had the same problem from the other end: it could
    // fail after the owner had been granted, leaving an owner nobody could see
    // in the chain -- the one thing `#transaction` exists to prevent everywhere
    // else in this file.
    return this.#transaction(async (tx, store) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO org (project_id, external_id, name)
         VALUES (coalesce($3::uuid, '${DEFAULT_PROJECT_ID}'::uuid), $1, $2) RETURNING id`,
        [externalId, name ?? null, this.projectId],
      );
      const id = rows[0]!.id;

      if (opts.ownerActorId) {
        await tx.query(
          `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,'owner')`,
          [id, opts.ownerActorId],
        );
        await store.audit({
          orgId: id,
          action: 'member.bootstrap',
          decision: 'allow',
          actorId: opts.ownerActorId,
          fileId: null,
          context: { targetActorId: opts.ownerActorId, toRole: 'owner', via: 'org.create' },
        });
      }
      return { id };
    });
  }

  async createActor(externalId: string): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO actor (project_id, external_id)
       VALUES (coalesce($2::uuid, '${DEFAULT_PROJECT_ID}'::uuid), $1) RETURNING id`,
      [externalId, this.projectId],
    );
    return { id: rows[0]!.id };
  }

  /**
   * Register a customer application. Control plane; see the note on the
   * lifecycle methods below for why these three take no principal.
   */
  async createProject(key: string, name?: string): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO project (key, name) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key
       RETURNING id`,
      [key, name ?? null],
    );
    return { id: rows[0]!.id };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: soft delete and restore (P7)
  // ---------------------------------------------------------------------------
  //
  // WHY THESE ARE CONTROL-PLANE OPERATIONS AND TAKE NO `Principal`.
  //
  // It is tempting to require `owner` in the org to delete it. That design has
  // a trap in it: deleting an org kills membership-derived access (that is the
  // whole point), so the moment it succeeds NOBODY holds a role in that org and
  // therefore nobody can ever restore it. An authorization rule that makes its
  // own inverse unreachable is not a rule, it is a one-way door.
  //
  // So org and actor lifecycle sits where org and actor CREATION already sits:
  // the control plane, authenticated by the customer's project credential at
  // the API boundary rather than by an end-user principal inside the model.
  // That boundary sits above the engine and is the same one that
  // authenticates every other request. This is stated as an explicit
  // operational requirement in SEMANTICS.md rather than left implicit.
  //
  // Every one of them is audited to the affected tenant's chain, so a
  // control-plane action is as visible in the compliance record as a user one.

  /**
   * Soft-delete a tenant. Every grant on every file in it is dead on the next
   * request; every membership stops conferring anything. Nothing is erased and
   * no row a retention hold protects is touched, so this cannot be used to
   * defeat retention -- see SEMANTICS.md.
   */
  async softDeleteOrg(orgId: string): Promise<void> {
    await this.#setOrgDeleted(orgId, true);
  }

  /** Exactly reverses `softDeleteOrg`. Liveness is derived, so nothing is lost. */
  async restoreOrg(orgId: string): Promise<void> {
    await this.#setOrgDeleted(orgId, false);
  }

  async #setOrgDeleted(orgId: string, deleted: boolean): Promise<void> {
    if (!isUuid(orgId)) throw new FilelayerError(404, 'not_found');
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE org SET deleted_at = ${deleted ? 'now()' : 'NULL'}
        WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)
        RETURNING id`,
      [orgId, this.projectId],
    );
    if (!rows[0]) throw new FilelayerError(404, 'not_found');
    await this.store.audit({
      orgId,
      action: deleted ? 'org.delete' : 'org.restore',
      decision: 'allow',
      actorId: null,
      fileId: null,
      context: { via: 'control_plane' },
    });
  }

  /**
   * Soft-delete an identity.
   *
   * Three things die at once, and all three are derived rather than written:
   * their role-derived access, every grant issued TO them, and every grant they
   * ISSUED. The third is the judgement call; the reasoning is in schema.sql at
   * `grant_scope_is_live` and in SEMANTICS.md. It is loud on purpose: deleting
   * a prolific sharer revokes a lot of links, and that is the correct reading of
   * P4, not a side effect.
   */
  async softDeleteActor(actorId: string): Promise<void> {
    await this.#setActorDeleted(actorId, true);
  }

  async restoreActor(actorId: string): Promise<void> {
    await this.#setActorDeleted(actorId, false);
  }

  async #setActorDeleted(actorId: string, deleted: boolean): Promise<void> {
    if (!isUuid(actorId)) throw new FilelayerError(404, 'not_found');
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE actor SET deleted_at = ${deleted ? 'now()' : 'NULL'}
        WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)
        RETURNING id`,
      [actorId, this.projectId],
    );
    if (!rows[0]) throw new FilelayerError(404, 'not_found');
    // Attributed to every org the identity is a member of: "who lost access
    // here, and when" must be answerable from each affected tenant's own chain.
    const { rows: orgs } = await this.db.query<{ org_id: string }>(
      `SELECT org_id FROM membership WHERE actor_id = $1`,
      [actorId],
    );
    for (const o of orgs) {
      await this.store.audit({
        orgId: o.org_id,
        action: deleted ? 'actor.delete' : 'actor.restore',
        decision: 'allow',
        actorId,
        fileId: null,
        context: { via: 'control_plane', targetActorId: actorId },
      });
    }
    // A FAN-OUT OVER AN EMPTY SET WROTE NOTHING AT ALL.
    //
    // The loop above is the whole audit for this operation, so an actor who
    // belongs to no org -- registered, never added anywhere, or removed from
    // their last org -- could be deleted and restored with zero events on any
    // chain, tenant or system. The docstring 90 lines up says "every one of them
    // is audited to the affected tenant's chain", and with no tenants affected
    // that sentence quietly evaluated to nothing.
    //
    // The system chain is exactly the right home for it: it is where this file
    // already sends events that have no tenant to charge (see `#setProjectDeleted`),
    // and it is chained and verifiable like any other.
    if (orgs.length === 0) {
      await this.store.audit({
        orgId: null,
        action: deleted ? 'actor.delete' : 'actor.restore',
        decision: 'allow',
        actorId,
        fileId: null,
        context: { chain: 'system', via: 'control_plane', targetActorId: actorId, orgs: 0 },
      });
    }
  }

  /**
   * Soft-delete a customer application: every org, every file and every grant
   * inside it stops working immediately. This is the "we terminated that
   * customer" operation and it is the widest blast radius in the system.
   */
  async softDeleteProject(projectId: string): Promise<void> {
    await this.#setProjectDeleted(projectId, true);
  }

  async restoreProject(projectId: string): Promise<void> {
    await this.#setProjectDeleted(projectId, false);
  }

  async #setProjectDeleted(projectId: string, deleted: boolean): Promise<void> {
    if (!isUuid(projectId)) throw new FilelayerError(404, 'not_found');
    // THE PROJECT FILTER ITS TWO NEIGHBOURS ALREADY CARRIED.
    //
    // `#setOrgDeleted` and `#setActorDeleted`, twelve lines above, both end with
    // `AND ($2::uuid IS NULL OR project_id = $2::uuid)`. This one did not, so a
    // project-bound instance could soft-delete -- and, worse, RESTORE -- another
    // customer's entire project. Deleting took every tenant in it dark;
    // restoring silently re-armed every share link an operator believed revoked
    // when they terminated that customer.
    //
    // This method's own docstring calls project deletion "the widest blast
    // radius in the system", which is exactly why it was the one that had to be
    // bounded. Found 2026-10-02 by adversarial review.
    //
    // An unbound instance (`projectId` null) is the control plane and may still
    // act on any project; that is what unbound means.
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE project SET deleted_at = ${deleted ? 'now()' : 'NULL'}
        WHERE id = $1 AND ($2::uuid IS NULL OR id = $2::uuid) RETURNING id`,
      [projectId, this.store.projectId],
    );
    if (!rows[0]) throw new FilelayerError(404, 'not_found');
    // The system chain: a project is above every tenant, so there is no single
    // tenant to charge the event to, and writing it to all of them would let a
    // control-plane action inflate an arbitrary number of customer chains.
    await this.store.audit({
      orgId: null,
      action: deleted ? 'project.delete' : 'project.restore',
      decision: 'allow',
      actorId: null,
      fileId: null,
      context: { chain: 'system', projectId, via: 'control_plane' },
    });
  }

  /**
   * Add a member, or change an existing member's role.
   *
   * This used to take no principal at all. Anyone who could reach it could
   * make anyone an owner of any org, and nothing was written to the audit log.
   * Membership is the privilege that confers every other privilege, so it is
   * now authorized by the same engine as everything else and audited on every
   * outcome.
   */
  async addMember(
    principal: Principal,
    orgId: string,
    actorId: string,
    role: OrgRole,
  ): Promise<void> {
    // IN A TRANSACTION, for the same reason `revoke()` is.
    //
    // This used to authorize (which WRITES the audit event) and then INSERT, as
    // two independent statements. When the INSERT failed -- a well-formed but
    // unregistered actor id is enough, the foreign key rejects it -- the call
    // threw and the audit log kept an `allow` for a membership change that never
    // happened. A log that records privilege grants which did not occur is worse
    // than a log with a gap: the gap is visible.
    //
    // Found by audit, 2026-09-29. `test/persistence.test.ts` already asserted
    // this property under the name *"the mutation and the audit event that
    // records it commit together"* -- for uploads and revocations. Membership,
    // which is the privilege that confers every other privilege, was the one
    // mutation not covered by it.
    //
    // LOCK ORDERING holds: `authorizeMembershipChange` takes the chain lock via
    // its audit write, before the INSERT takes any row lock. See `revoke()`.
    await this.#transaction(async (tx, store) => {
      await lockOrgForMembershipChange(tx, orgId);
      const decision = await authorizeMembershipChange(store, principal, orgId, actorId, role);
      this.#raise(decision);
      await tx.query(
        `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, actor_id) DO UPDATE SET role = EXCLUDED.role`,
        [orgId, actorId, role],
      );
    });
  }

  async removeMember(principal: Principal, orgId: string, actorId: string): Promise<void> {
    // See `addMember`: the decision and the change are one transaction.
    await this.#transaction(async (tx, store) => {
      await lockOrgForMembershipChange(tx, orgId);
      const decision = await authorizeMembershipChange(store, principal, orgId, actorId, null);
      this.#raise(decision);
      await tx.query(`DELETE FROM membership WHERE org_id = $1 AND actor_id = $2`, [
        orgId,
        actorId,
      ]);
    });
  }

  // ---------------------------------------------------------------------------
  // Files
  // ---------------------------------------------------------------------------

  /**
   * Creation is the one file operation with no file to authorize against, so
   * the question is org-scoped: does this actor hold `create_file` in this org?
   * That is now asked of the engine rather than answered here.
   *
   * SIGNATURE CHANGE. This used to take a bare
   * `actorId: string` while every other method took a `Principal`. That
   * inconsistency was itself the defect: at the one call site in the example the
   * developer passed `b.uploaderId` -- a value out of the REQUEST BODY -- rather
   * than the authenticated actor, because the parameter's type did not tell them
   * which one it wanted. Files are private-by-default AND owner-readable, so
   * forging `owner_id` hands the wrong person permanent read access to the
   * document, silently. A `Principal` is not confusable with a request field.
   */
  async upload(principal: Principal, orgId: string, input: UploadInput): Promise<FileRecord> {
    const actorId = principal.actorId;
    // DELIBERATELY OUTSIDE THE TRANSACTION, and the reason is the storage write
    // that has to happen between this and the INSERT.
    //
    // With `emitAllow: false` this call writes AT MOST ONE STATEMENT: an audit
    // event on the deny path, which `audit_append()` already makes atomic on its
    // own. There is no mutation for it to be atomic *with*. Wrapping it would
    // mean either holding a database connection open across the whole object
    // upload -- minutes, for a large file, on a pooled connection -- or opening a
    // second transaction anyway. The allow event is emitted below, inside the
    // transaction, carrying the file id.
    const decision = await authorizeOrg(this.store, principal, orgId, 'create_file', {
      action: 'file.create',
      emitAllow: false, // the allow event is emitted below, with the file id on it
    });
    this.#raise(decision);
    // `authorizeOrg` denies an anonymous principal before we get here, so the
    // uploader is known. The engine is the thing that established that, which
    // is the point: ownership is derived from the authorized identity and can
    // no longer be supplied alongside it.
    const uploaderId = actorId!;

    const id = randomUUID();
    const storageKey = `${orgId}/${id}`;
    const now = Date.now();
    const expiresAt = secondsFromNow(input.expiresIn, now, 'expiresIn');
    const retainUntil = secondsFromNow(input.retainFor, now, 'retainFor');

    // VALIDATED HERE, WHICH IS BEFORE THE BYTES GO OUT.
    //
    // `secondsFromNow` validates each field on its own; nothing compared them.
    // `retainFor` greater than `expiresIn` violates `file_retention_before_expiry`
    // in schema.sql, and the constraint fired on the INSERT -- which happens
    // AFTER `storage.put()`. So the caller got a raw SQLSTATE 23514 instead of a
    // 400 (an HTTP layer that maps `FilelayerError` and rethrows the rest turns
    // that into a 500), and every rejected attempt left an orphaned object
    // behind. A member could loop on it and run up an unbounded storage bill
    // with no row, no audit event and no rate limit to show for it.
    //
    // Moving the check above `storage.put()` fixes both halves at once: the
    // status code and the orphan. The combination is nonsense on its face --
    // "keep this past the moment it stops being readable" -- so refusing it is
    // not a policy choice.
    if (expiresAt && retainUntil && retainUntil > expiresAt) {
      throw new FilelayerError(400, 'invalid_argument', 'retain_for_exceeds_expires_in');
    }
    const visibility: FileVisibility = input.visibility ?? 'private';

    // ORDERING: BYTES FIRST, METADATA SECOND. See the long note in db.ts.
    //
    // The storage write cannot join the transaction, so one of the two possible
    // orderings has to lose. Committing metadata first and crashing would leave
    // a 'ready' file whose object does not exist -- permanent, customer-visible
    // data loss on a row the customer can see in a listing. Writing bytes first
    // and crashing leaves an object no row points at: unreachable (the key is a
    // fresh UUID, never reissued, and every read path starts from a `file` row)
    // and therefore purely a storage cost. That is the cheaper failure and it is
    // the one we take. `collectStorageOrphans()` cleans up; running it is a
    // required operational job, not an optional one.
    //
    // It also means the adapter, not the caller, reports how many bytes exist.
    const put = await this.storage.put(storageKey, input.body, input.contentType, {
      ...(input.size !== undefined ? { contentLength: input.size } : {}),
    });

    return this.#transaction(async (tx, store) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO file
           (id, org_id, owner_id, name, content_type, size_bytes, storage_provider,
            storage_key, state, visibility, expires_at, retain_until, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$10,$11,$12::jsonb)
         RETURNING id, org_id, owner_id, name, content_type, size_bytes,
                   storage_provider, storage_key, state, visibility, expires_at,
                   retain_until, created_at`,
        [
          id,
          orgId,
          uploaderId,
          input.name,
          input.contentType,
          // What was actually written, not what the caller claimed.
          put.bytes,
          // THE FIX. This was the literal 'memory'.
          this.storage.provider,
          storageKey,
          visibility,
          expiresAt?.toISOString() ?? null,
          retainUntil?.toISOString() ?? null,
          JSON.stringify(input.metadata ?? {}),
        ],
      );

      // Same transaction as the INSERT it describes. Before this, a failure
      // between the two produced a file with no audit record -- in a product
      // whose headline is a tamper-evident audit trail, an intact chain that
      // simply does not mention the upload.
      await store.audit({
        orgId,
        action: 'file.create',
        decision: 'allow',
        actorId: uploaderId,
        fileId: id,
        context: { visibility, storageProvider: this.storage.provider },
      });
      await store.recordUsage(orgId, 'write', put.bytes);
      // Metering counts distinct FILE-OWNING USERS as well as bytes, because
      // authorization load tracks people rather than volume. The write path is
      // the only place a new owner can appear, so it is the only place this can
      // be recorded.
      await store.recordFileOwner(orgId, uploaderId);
      return toFileRecord(rows[0]!);
    });
  }

  /**
   * RESERVE a file, and hand back a credential the browser can upload to
   * directly.
   *
   * This is the other half of `upload()` and it runs the ordering BACKWARDS, on
   * purpose. `upload()` writes bytes and then commits a row, because a crash
   * between them should leave an unreferenced object (recoverable, costs money)
   * rather than a row pointing at nothing (not recoverable, user-visible). It
   * cannot do that here: the bytes arrive later, from someone else, so the row
   * has to exist first.
   *
   * WHAT MAKES THAT SAFE IS `pending`, and it was already in the schema before
   * this method existed. `lifecycleDenial()` refuses `read` on a pending file
   * with `file_not_ready`, so a row whose bytes never arrived is not a broken
   * file anybody can see -- it is invisible. The failure mode `upload()` works
   * so hard to avoid is the one state this feature cannot produce. A
   * reservation that is never redeemed is a row nothing can read and
   * `collectUploadReservations()` reclaims.
   *
   * WHAT IS AUTHORIZED, AND WHEN. The decision happens HERE, before any
   * credential exists -- that is what "pre-authorized" means. `create_file` in
   * this org, asked of the engine, exactly as `upload()` asks it. The returned
   * URL is not authority over Filelayer; it is authority over ONE object key
   * that no row yet references, for one size, for one content type, for a
   * bounded time. Nothing about the file's visibility, ownership or grants can
   * be influenced by whoever holds it.
   *
   * WHAT THE CALLER CANNOT GET WRONG, because it is not a parameter:
   *
   *  - the object key. Derived here as `${orgId}/${randomUUID()}`, same as
   *    `upload()`. A client that could choose it could aim an upload at another
   *    tenant's key, so it is not an input.
   *  - the owner. Taken from the authorized principal, never from the request.
   *    This is the defect `upload()`'s signature change fixed, and repeating
   *    that signature here is why it cannot come back.
   *  - the stored content type. Signed into the credential, so an uploader
   *    cannot store `text/html` under a key your app will later serve.
   *
   * WHAT THE CALLER MUST GET RIGHT: `size`, which is signed. It is required and
   * exact. The browser knows it (`file.size`), and `maxUploadBytes` from the
   * instance config bounds it -- because "pinned to exactly what the client
   * asked for" is not a bound.
   */
  async createUpload(
    principal: Principal,
    orgId: string,
    input: {
      name: string;
      contentType: string;
      /** REQUIRED and EXACT. Signed into the credential; the store enforces it. */
      size: number;
      visibility?: FileVisibility;
      expiresIn?: number;
      retainFor?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<{ file: FileRecord; upload: PresignedUpload & { expiresAt: Date } }> {
    const cfg = this.directUpload;
    if (cfg === null) {
      throw new FilelayerError(
        501,
        'direct_upload_not_enabled',
        'set `directUpload` with DIRECT_UPLOAD_ACKNOWLEDGEMENT to enable this',
      );
    }
    const storage = this.storage;
    if (!canPresignPut(storage)) {
      // Structurally unavailable rather than faked. The adapter says it cannot
      // mint an upload credential by not having the method, and the honest
      // answer is to say so with the provider named -- a 501 with no detail
      // sends the reader to the wrong layer.
      throw new FilelayerError(
        501,
        'direct_upload_unsupported',
        `storage_provider:${storage.provider}`,
      );
    }

    // VALIDATED BEFORE THE DECISION IS ASKED FOR, because a 400 must not cost
    // an audit event that claims someone tried to create a file.
    if (!Number.isSafeInteger(input.size) || input.size < 0) {
      throw new FilelayerError(400, 'invalid_argument', 'size_must_be_a_non_negative_integer');
    }
    if (input.size > cfg.maxUploadBytes) {
      throw new FilelayerError(
        413,
        'payload_too_large',
        `size:${input.size}>max:${cfg.maxUploadBytes}`,
      );
    }

    const decision = await authorizeOrg(this.store, principal, orgId, 'create_file', {
      action: 'file.create',
      emitAllow: false, // emitted below, with the file id on it
    });
    this.#raise(decision);
    const uploaderId = principal.actorId!;

    const id = randomUUID();
    const storageKey = `${orgId}/${id}`;
    const now = Date.now();
    const expiresAt = secondsFromNow(input.expiresIn, now, 'expiresIn');
    const retainUntil = secondsFromNow(input.retainFor, now, 'retainFor');
    // The same cross-field check `upload()` makes, and for the same reason: the
    // constraint fires on the INSERT, which here is before any credential is
    // minted, so a caller would otherwise get a raw SQLSTATE instead of a 400.
    if (expiresAt && retainUntil && retainUntil > expiresAt) {
      throw new FilelayerError(400, 'invalid_argument', 'retain_for_exceeds_expires_in');
    }
    const uploadExpiresAt = new Date(now + cfg.ttlSeconds * 1000);
    const visibility: FileVisibility = input.visibility ?? 'private';

    // THE ROW IS COMMITTED BEFORE THE CREDENTIAL IS MINTED.
    //
    // The other order is tempting and wrong. Minting first and crashing before
    // the INSERT leaves a signed, live upload URL for a key no row references:
    // somebody can put bytes in your bucket that nothing will ever reclaim,
    // because `collectStorageOrphans()` works from rows and there is no row.
    // Committing first means the worst case is a reservation nobody redeems,
    // which has a deadline and a collector.
    const file = await this.#transaction(async (tx, store) => {
      const { rows } = await tx.query<Record<string, unknown>>(
        `INSERT INTO file
           (id, org_id, owner_id, name, content_type, size_bytes, storage_provider,
            storage_key, state, visibility, expires_at, retain_until, metadata,
            upload_expires_at, upload_expected_bytes)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'pending',$8,$9,$10,$11::jsonb,$12,$13)
         RETURNING id, org_id, owner_id, name, content_type, size_bytes,
                   storage_provider, storage_key, state, visibility, expires_at,
                   retain_until, created_at`,
        [
          id,
          orgId,
          uploaderId,
          input.name,
          input.contentType,
          this.storage.provider,
          storageKey,
          visibility,
          expiresAt?.toISOString() ?? null,
          retainUntil?.toISOString() ?? null,
          JSON.stringify(input.metadata ?? {}),
          uploadExpiresAt.toISOString(),
          input.size,
        ],
      );
      // `size_bytes` is deliberately NULL on a reservation. The claimed size
      // lives in `upload_expected_bytes`, where it is labelled as a claim.
      // Putting it in `size_bytes` would have saved a column and made that
      // column mean "measured" on one path and "asserted by a browser" on
      // another -- the precise shape of defect `maxDownloads` already was.
      await store.audit({
        orgId,
        action: 'file.create',
        decision: 'allow',
        actorId: uploaderId,
        fileId: id,
        context: {
          visibility,
          storageProvider: this.storage.provider,
          method: 'direct',
          expectedBytes: input.size,
          uploadExpiresAt: uploadExpiresAt.toISOString(),
        },
      });
      await store.recordFileOwner(orgId, uploaderId);
      return toFileRecord(rows[0]!);
    });

    // Minted outside the transaction: it is local HMAC for the S3 adapter, but
    // an adapter for which it is not must not hold a pooled connection open,
    // and a mint that fails must not roll back a reservation the caller can
    // simply ask for again.
    const upload = await storage.presignPut(storageKey, {
      expiresInSeconds: cfg.ttlSeconds,
      contentLength: input.size,
      contentType: input.contentType,
    });

    return { file, upload: { ...upload, expiresAt: uploadExpiresAt } };
  }

  /**
   * Turn a redeemed reservation into a readable file: `pending` -> `ready`.
   *
   * THE CLIENT'S WORD IS NOT EVIDENCE. This method does not take a size, an
   * etag or a "success" flag, and it would be wrong to: the only thing that
   * knows whether bytes arrived is the object store, so it is asked. The size
   * written to `size_bytes` is the one the store reports, exactly as it is on
   * the `upload()` path where the adapter -- not the caller -- reports what it
   * wrote.
   *
   * IDEMPOTENT, because the network makes it so whether we like it or not. A
   * client that uploads, calls this, and loses the response will call it again.
   * The second call returns the same record rather than a 409, since "it is
   * ready" is the true answer to "please make it ready".
   *
   * `authorize(..., 'write')` is the gate, and `pending` does not block
   * `write` -- `lifecycleDenial()` scopes the pending gate to `read` alone.
   * That scoping predates this method and is what makes it expressible.
   */
  async completeUpload(principal: Principal, fileId: string): Promise<FileRecord> {
    const existing = await this.#transaction(async (tx, store) => {
      const decision = await authorize(store, principal, fileId, 'write');
      this.#raise(decision);
      const f = await getFileRecord(tx, this.projectId, fileId);
      if (!f) throw new FilelayerError(404, 'not_found');
      return f;
    });

    // Already done. See the note on idempotency above.
    if (existing.state === 'ready') return existing;
    if (existing.state !== 'pending') throw new FilelayerError(404, 'not_found', 'file_deleted');

    // ASKED OF THE STORE, OUTSIDE THE TRANSACTION. A HEAD against a remote
    // store is network I/O; holding a connection open across it is how a pool
    // dies, and the same reasoning keeps `#fetchDelivery` outside too.
    const head = await this.storage.head(existing.storageKey);
    if (!head) {
      // The reservation is intact and the deadline still applies, so this is
      // retryable rather than terminal: the client may still upload and call
      // again. 409 rather than 404 precisely because the file DOES exist -- it
      // is the bytes that do not, and collapsing the two would send the caller
      // looking for a lost id.
      throw new FilelayerError(409, 'upload_not_received', `storage_key:${existing.storageKey}`);
    }

    return this.#transaction(async (tx, store) => {
      // THE REDUNDANT CHECK THAT IS NOT REDUNDANT.
      //
      // On AWS and R2 this cannot fire: `content-length` is in the signed
      // headers, so a body of the wrong size never got a 200 in the first
      // place. It is here for the case where that assumption is false -- an
      // S3-compatible store that verifies the signature but not the headers it
      // covers. Without this, such a store would silently convert "the size is
      // enforced by the object store" into "the size is whatever arrived", and
      // the acknowledgement string tells the operator we rely on that
      // enforcement. An assertion whose only job is to catch a broken
      // dependency earns its keep the first time the dependency breaks.
      const { rows: claim } = await tx.query<{
        upload_expected_bytes: string | null;
        expired: boolean;
      }>(
        `SELECT upload_expected_bytes,
                (upload_expires_at IS NOT NULL AND upload_expires_at <= now()) AS expired
           FROM file WHERE id = $1`,
        [fileId],
      );
      // THE DEADLINE BINDS, and it is what makes
      // `collectUploadReservations()` safe to run at all. If a completion could
      // succeed after the deadline, the collector could delete the bytes of a
      // file that had just become `ready` -- a readable row with nothing behind
      // it, which is the one failure this library is arranged to never produce.
      // Refusing here is what turns "the collector races the client" into "the
      // collector cannot lose".
      //
      // Evaluated by POSTGRES, against the same clock that wrote
      // `upload_expires_at`. It is NOT the same clock the collector computes
      // its cutoff with -- that one is the job's -- and the collector's grace
      // period, floored at 60 seconds, is precisely what covers the difference.
      // Two clocks are fine as long as the gap between them is smaller than the
      // window, which is why the floor is not configurable to zero.
      if (claim[0]?.expired === true) {
        throw new FilelayerError(
          410,
          'upload_reservation_expired',
          'the upload window closed; reserve again',
        );
      }
      const expected = claim[0]?.upload_expected_bytes;
      if (expected != null && Number(expected) !== head.size) {
        await store.audit({
          orgId: existing.orgId,
          action: 'file.upload_complete',
          decision: 'deny',
          reason: 'upload_size_mismatch',
          actorId: principal.actorId,
          fileId,
          context: { expectedBytes: Number(expected), actualBytes: head.size },
        });
        throw new FilelayerError(
          409,
          'upload_size_mismatch',
          `expected:${expected} actual:${head.size}`,
        );
      }

      // `state = 'pending'` in the WHERE is the concurrency guard. Two
      // completions racing: one updates a row, the other matches nothing and
      // falls through to re-reading a row that is already ready. Under READ
      // COMMITTED the second statement re-evaluates the predicate after the
      // first commits, so it sees 'ready' and matches zero rows -- which is the
      // answer we want, not an error.
      const { rows } = await tx.query<Record<string, unknown>>(
        `UPDATE file
            SET state = 'ready', size_bytes = $2, updated_at = now()
          WHERE id = $1 AND state = 'pending'
         RETURNING id, org_id, owner_id, name, content_type, size_bytes,
                   storage_provider, storage_key, state, visibility, expires_at,
                   retain_until, created_at`,
        [fileId, head.size],
      );
      if (rows.length === 0) {
        const again = await getFileRecord(tx, this.projectId, fileId);
        if (!again) throw new FilelayerError(404, 'not_found');
        return again;
      }

      await store.audit({
        orgId: existing.orgId,
        action: 'file.upload_complete',
        decision: 'allow',
        actorId: principal.actorId,
        fileId,
        context: { bytes: head.size, storageProvider: this.storage.provider },
      });
      // Metered HERE and not at reservation, because this is the first moment
      // anything knows how many bytes exist. A reservation that is never
      // redeemed is never billed, which is correct: nothing was stored.
      await store.recordUsage(existing.orgId, 'write', head.size);
      return toFileRecord(rows[0]!);
    });
  }

  /**
   * Read a file's bytes, WITH the headers required to serve them safely.
   *
   * The `headers` field closes a header-handling defect. Before it, this method returned a
   * `Uint8Array` and the application decided what `Content-Type`,
   * `Content-Disposition`, `X-Content-Type-Options` and `Cache-Control` to put
   * on the response -- three security-sensitive decisions the library was
   * handing back to the developer while claiming to have removed them, and
   * which the example got wrong. They are computed here now, from the file
   * record, with no option to disable them. See `delivery.ts`.
   *
   * This path now CHARGES the download cap. See `deliver()` below for the
   * semantics and the reasoning.
   */
  async read(
    principal: Principal,
    fileId: string,
    opts: { disposition?: Disposition } = {},
  ): Promise<{
    file: FileRecord;
    body: Uint8Array;
    headers: Record<string, string>;
    grantId?: string;
    /** Null when no cap binds this delivery (a role-derived read, or no cap). */
    remainingDownloads: number | null;
  }> {
    // The buffered convenience form. It is `readStream()` plus a collect, so
    // there is exactly one authorization path, one reservation and one audit
    // event whichever form a caller uses. It FORCES proxy mode: a buffered read
    // of a redirect is a contradiction, and silently fetching the presigned URL
    // ourselves would spend the redirect's egress budget AND the proxy's.
    const d = await this.readStream(principal, fileId, { ...opts, mode: 'proxy' });
    if (d.mode !== 'proxy') throw new FilelayerError(500, 'internal', 'unexpected_redirect');
    const body = await collectStream(d.body);
    return {
      file: d.file,
      body,
      headers: d.headers,
      ...(d.grantId ? { grantId: d.grantId } : {}),
      remainingDownloads: d.remainingDownloads,
    };
  }

  /**
   * The streaming read. Same decision, same charge, same audit -- no buffer.
   *
   * Returns either a `ProxyDelivery` (bytes, as a stream) or, when redirect
   * delivery is configured AND this delivery is eligible, a `RedirectDelivery`
   * (a 302 to a short-lived presigned URL). The mode is on the returned object
   * and in the audit log; nothing about it is implicit.
   */
  async readStream(
    principal: Principal,
    fileId: string,
    /**
     * `mode` defaults to 'auto', which means "apply this instance's redirect
     * policy". On an instance that has not configured `redirectDelivery` -- the
     * default -- that policy is "never redirect", so 'auto' and 'proxy' are the
     * same thing and nothing becomes cacheable that was not before. Pass
     * 'proxy' to force proxying on an instance that HAS opted in.
     */
    opts: { disposition?: Disposition; mode?: 'proxy' | 'auto'; range?: RangeSpec } = {},
  ): Promise<StreamedDelivery & { file: FileRecord; grantId?: string; remainingDownloads: number | null }> {
    // THE DECISION AND THE CHARGE, IN ONE TRANSACTION.
    //
    // `authorize()` writes the access event and `consumeDownload()` spends the
    // cap. Those two were separate autocommit statements, so a crash between
    // them left an allow event for a delivery that was never charged, or -- on
    // the redeem path -- a charge with no event. They now commit together.
    const reserved = await this.#transaction(async (tx, store) => {
      const decision = await authorize(store, principal, fileId, 'read');
      this.#raise(decision);
      return this.#reserve(tx, store, fileId, decision, principal, opts);
    });

    return this.#fetchDelivery(reserved);
  }

  /**
   * Metadata without bytes, authorized exactly like `read`.
   *
   * This exists because `getFileRecord()` used to be public and took no
   * principal -- see the note on it below. Callers that wanted a file's
   * metadata had an unauthorized way to get it; now they have an authorized one.
   *
   * It does NOT charge the download cap, and that asymmetry is the whole point
   * of the delivery-cap rule: the cap counts BYTES LEAVING, and `stat` delivers
   * none.
   */
  async stat(principal: Principal, fileId: string): Promise<FileRecord> {
    return this.#transaction(async (tx, store) => {
      const decision = await authorize(store, principal, fileId, 'read');
      this.#raise(decision);
      const file = await getFileRecord(tx, this.projectId, fileId);
      if (!file) throw new FilelayerError(404, 'not_found');
      return file;
    });
  }

  /**
   * THE ONE PLACE BYTES LEAVE THE SYSTEM -- and therefore the one place the
   * download cap is charged (P6).
   *
   * THE DEFECT. `max_downloads` was charged only by `redeem()`, the share-link
   * path. An ACTOR grant carrying `maxDownloads: 3` permitted unlimited direct
   * `read()` calls, because nothing on that path touched the counter. So the
   * field meant "link redemptions" on one path and "nothing at all" on another,
   * while being named, documented and billed as a download cap. In practice the
   * direct path is the COMMON one -- the SDK calls `read()` --
   * so the dimension was a lie on the path most customers use.
   *
   * THE DECISION, of the three that were on the table:
   *
   *   (a) rename it `maxRedemptions`. Rejected: it would still be settable on
   *       an actor grant, where it would then mean nothing, so the ambiguity
   *       moves rather than closes.
   *   (b) refuse `maxDownloads` on non-link grants. Rejected: "you may read
   *       this three times" is a thing customers legitimately want to say about
   *       a named person, and refusing it removes a capability to avoid
   *       defining one.
   *   (c) CHARGE ON EVERY DELIVERY. Chosen. A cap of 3 means the bytes leave at
   *       most 3 times, through any path, by any principal, at any delegation
   *       depth. It is the reading a customer already has, it is the only one
   *       that is true on every path, and it makes the cap enforceable rather
   *       than advisory.
   *
   * THE RULE, precisely: a delivery is charged when, and only when, the
   * authorization decision was reached VIA A GRANT. Authority from an org role
   * is not a metered credential and is not charged -- an admin doing their job
   * must not silently burn a contractor's link budget. `authorize()` alone does
   * not charge (it is a decision, not a delivery) and neither does `stat()`.
   *
   * ORDERING: reserve BEFORE fetching bytes, exactly as `redeem()` does. The
   * reservation is the write (P6), so two concurrent deliveries against a cap
   * of 1 yield one delivery; doing it the other way round would let both read
   * the object and only then discover one of them was over budget. A storage
   * failure after a successful reservation therefore still spends a download.
   * That is the fail-closed direction and it is deliberate.
   *
   * KNOWN COST, recorded rather than hidden. `consume_download` runs even
   * when no grant in the chain carries a cap, because `download_count` is also
   * the answer to "how many times has this link been downloaded", which
   * `listGrants` reports and a compliance screen asks for. That makes every
   * grant-authorized delivery a row UPDATE holding a row lock -- and for a
   * TIER-1 PUBLIC ASSET, where one anonymous grant row serves every request,
   * that single row is PREDICTED to become a write hotspot under load.
   *
   * PREDICTED, AND NOT YET REPRODUCED. This paragraph used to assert the
   * hotspot as a property. It was argued rather than measured, and the first
   * measurement did not find it: `benchmark/load/RESULTS.md` H3 drives every
   * request through one anonymous grant row and sees it scale the same way the
   * actor-grant path does, up to concurrency 64. Lock contention on a single
   * row needs far more concurrent writers than that to show a knee, so the
   * honest state is "unconfirmed at 64", not "false".
   *
   * It is a scalability concern, not a correctness one, and the fix (skip the
   * write when no ancestor has a cap, and meter deliveries elsewhere) trades
   * away the per-grant download count. Not taken here because that count is a
   * shipped feature; flagged so the trade is made deliberately when a
   * measurement, rather than an argument, forces it.
   */
  async #reserve(
    tx: Tx,
    store: PostgresStore,
    fileId: string,
    decision: Extract<Decision, { allow: true }>,
    principal: Principal,
    opts: {
      disposition?: Disposition;
      mode?: 'proxy' | 'auto';
      /**
       * Carried so `#redirectEligible` can refuse to redirect a ranged read,
       * and so the cap rule below can decide whether the range survives at all.
       */
      range?: RangeSpec;
    },
  ): Promise<Reservation> {
    const grantId = decision.grantId ?? null;
    let remainingDownloads: number | null = null;

    if (grantId !== null) {
      const consumed = await store.consumeDownload(grantId);
      if (!consumed.granted) {
        // Reachable only when the cap is hit between the decision and the
        // reservation. The engine records the ordinary case; this records the
        // race, so the two cannot silently become one.
        const file = await getFileRecord(tx, this.projectId, fileId);
        await store.audit({
          orgId: file?.orgId ?? null,
          action: 'file.read',
          decision: 'deny',
          reason: 'grant_exhausted',
          actorId: principal.actorId,
          fileId,
          grantId,
          ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
          context: { race: true, ...(file ? {} : { chain: 'system' }) },
        });
        throw new FilelayerError(404, 'not_found', 'grant_exhausted');
      }
      remainingDownloads = consumed.remaining;
    }

    const file = await getFileRecord(tx, this.projectId, fileId);
    if (!file) throw new FilelayerError(404, 'not_found');

    // A DOWNLOAD CAP AND BYTE RANGES ARE INCOMPATIBLE SEMANTICS, so one of them
    // has to give, and it is not the cap.
    //
    // The cap means what `deliver()` above says it means: "the bytes leave at
    // most N times, through any path". A ranged delivery makes that
    // unquantifiable. A video player seeking through a 2 GB file issues dozens
    // of ranged requests, so charging each one turns `maxDownloads: 3` into
    // "three seeks" -- a cap that is enforced and does not mean what it says,
    // which is the exact failure this codebase refused for `maxDownloads` in
    // the first place. Not charging them is worse: ranges then bypass the cap
    // entirely, and a recipient reassembles the whole object for free.
    //
    // So when a cap binds, the RANGE gives. RFC 9110 permits a server to ignore
    // `Range` and answer 200 with the whole representation, and that is the one
    // option here with no downside for the client: the player gets a complete,
    // working file instead of an error, the cap keeps its exact meaning, and
    // there is no new failure mode to document. `#fetchDelivery` withholds
    // `Accept-Ranges` on this response, so a well-behaved client learns not to
    // ask again rather than retrying into the same silent drop.
    //
    // `remainingDownloads` is non-null if and only if some grant in the chain
    // carries `max_downloads` (see `consume_download` in schema.sql, which
    // takes the `min` over the chain), so it is already the answer to "does a
    // cap bind" -- no extra query.
    const capBinds = remainingDownloads !== null;
    const effectiveRange = capBinds ? null : (opts.range ?? null);

    const headers = deliveryHeaders(file, opts);
    const mode = this.#redirectEligible(decision, opts.mode ?? 'auto', {
      ...(effectiveRange ? { range: effectiveRange } : {}),
    });

    if (mode === 'proxy') {
      return { kind: 'proxy', file, headers, remainingDownloads, grantId, range: effectiveRange };
    }

    // The presigned URL is minted INSIDE the transaction, before the audit
    // event that records it. `presignGet` for the S3 adapter is local HMAC with
    // no I/O; an adapter for which that is not true must still keep it cheap,
    // because it sits inside an open transaction. Minting first means we never
    // audit a redirect we then failed to produce.
    const redirect = this.redirect!;
    const url = await (this.storage as Required<Pick<StorageAdapter, 'presignGet'>>).presignGet(
      file.storageKey,
      {
        expiresInSeconds: redirect.ttlSeconds,
        // Pin the SAME neutralised type and disposition the proxied path would
        // have sent, so a redirect cannot be a way to lose them.
        responseContentType: headers['content-type']!,
        responseContentDisposition: headers['content-disposition']!,
      },
    );
    const expiresAt = new Date(Date.now() + redirect.ttlSeconds * 1000);

    // THE EVENT THAT MAKES THE MODE AUDITABLE. Written only for redirects, in
    // the same transaction as the reservation. A compliance auditor asking "which
    // deliveries left our control?" filters `action = 'file.deliver'`; every
    // other delivery was proxied.
    await store.audit({
      orgId: file.orgId,
      action: 'file.deliver',
      decision: 'allow',
      actorId: principal.actorId,
      fileId,
      grantId,
      ...(principal.ip !== undefined ? { ip: principal.ip } : {}),
      ...(principal.userAgent !== undefined ? { userAgent: principal.userAgent } : {}),
      context: {
        mode: 'redirect',
        via: decision.via,
        ttlSeconds: redirect.ttlSeconds,
        // The number a compliance document quotes. Spelled out rather than
        // derived, so it survives a change to how the TTL is computed.
        revocationWindowSeconds: redirect.ttlSeconds,
        expiresAt: expiresAt.toISOString(),
        cacheable: decision.via === 'grant:anonymous',
      },
    });

    return {
      kind: 'redirect',
      file,
      headers,
      remainingDownloads,
      grantId,
      url,
      expiresAt,
      ttlSeconds: redirect.ttlSeconds,
      cacheable: decision.via === 'grant:anonymous',
    };
  }

  /**
   * Is this delivery allowed to be a redirect?
   *
   * Four conditions, all required, and the default answer is no:
   *   1. the caller asked for 'auto' (routes default to 'proxy');
   *   2. redirect delivery is configured -- which required the acknowledgement;
   *   3. the adapter can actually mint a presigned URL;
   *   4. the authority came from an ANONYMOUS grant, unless the scope was
   *      explicitly widened to 'all-grants'.
   *
   * Condition 4 is the one that matters. `via` is the engine's own account of
   * where the authority came from, so "public" here means "the customer
   * published this file", not "the request looked public".
   */
  #redirectEligible(
    decision: Extract<Decision, { allow: true }>,
    requested: 'proxy' | 'auto',
    opts: { range?: RangeSpec } = {},
  ): 'proxy' | 'redirect' {
    if (requested !== 'auto') return 'proxy';
    if (this.redirect === null) return 'proxy';
    if (!canPresign(this.storage)) return 'proxy';
    // A RANGE CANNOT SURVIVE A REDIRECT, so a request that asked for one is
    // proxied instead of being answered with a URL for the whole object.
    //
    // The redirect arm of `#fetchDelivery` never read `opts.range` -- it could
    // not, since the range was not even carried that far -- so a caller asking
    // for six bytes received a 302 to all of them, with no `Content-Range`, no
    // `Accept-Ranges`, and nothing in the response to tell them their range had
    // been discarded. Silently widening what a caller asked for is the one
    // outcome they cannot detect, which is what makes this worth a branch
    // rather than a note in the docs.
    if (opts.range) return 'proxy';
    // 'all-grants' MEANS ALL GRANTS, which is why this is not the same check as
    // the one below.
    //
    // The scope option is documented as widening redirects from anonymous
    // grants to "link and actor grants too". But the only test was on
    // `'anonymous-grants-only'`, so under `'all-grants'` nothing looked at
    // `via` at all and an OWNER read of a private file -- a delivery that came
    // from no grant whatsoever -- was redirected. `grantId === null` is exactly
    // how the rest of this class already distinguishes the two: it is why
    // `#reserve` does not charge an owner read against a download cap.
    if ((decision.grantId ?? null) === null) return 'proxy';
    if (this.redirect.scope === 'anonymous-grants-only' && decision.via !== 'grant:anonymous') {
      return 'proxy';
    }
    return 'redirect';
  }

  /**
   * Turn a committed reservation into bytes (or a 302).
   *
   * Deliberately OUTSIDE the transaction. Fetching an object can take minutes;
   * holding a database connection open for that is how a pool dies. It also
   * preserves the documented P6 property that a storage failure after a
   * successful reservation still spends a download -- the reservation is
   * already committed, so nothing can give it back.
   */
  async #fetchDelivery(
    r: Reservation,
  ): Promise<StreamedDelivery & { file: FileRecord; grantId?: string; remainingDownloads: number | null }> {
    if (r.kind === 'redirect') {
      const d: RedirectDelivery & {
        file: FileRecord;
        grantId?: string;
        remainingDownloads: number | null;
      } = {
        mode: 'redirect',
        file: r.file,
        status: 302,
        url: r.url,
        expiresAt: r.expiresAt,
        revocationWindowSeconds: r.ttlSeconds,
        headers: redirectHeaders(r.url, { ttlSeconds: r.ttlSeconds, cacheable: r.cacheable }),
        remainingDownloads: r.remainingDownloads,
        ...(r.grantId ? { grantId: r.grantId } : {}),
      };
      return d;
    }

    // THE EFFECTIVE RANGE, from the reservation rather than from `opts`. See
    // the note on `Reservation.range`: the reservation may have dropped a range
    // the caller asked for, and re-reading `opts` here would undo that.
    let range: { start: number; end?: number } | undefined;
    if (r.range) {
      if ('suffix' in r.range) {
        // "The last N bytes" is not a byte range until something knows how long
        // the object is, and RESOLVING IT AGAINST `size_bytes` WOULD BE WRONG:
        // this file distrusts that column on the two lines below, for the same
        // reason it would matter more here. A column that disagrees with the
        // object by one byte truncates a `content-length`; here it would serve
        // the WRONG BYTES, offset by the difference, under a 206 that says they
        // are the last N. The object store is the only authority on its size.
        //
        // The cost is one HEAD, and only on the suffix form. `bytes=-N` is what
        // a PDF reader sends to find the cross-reference table at the end of a
        // document -- once per document, before it switches to explicit ranges
        // it can compute itself -- so this is not a per-chunk tax.
        const h = await this.storage.head(r.file.storageKey);
        if (!h) throw new FilelayerError(404, 'not_found');
        if (h.size === 0) {
          // No byte in an empty object can satisfy "the last N", and there is
          // no satisfiable extent to name. `bytes * /0` is what RFC 9110 asks
          // for in exactly this case.
          throw new FilelayerError(416, 'range_not_satisfiable', 'suffix_on_empty_object', {
            'content-range': 'bytes */0',
          });
        }
        // A suffix longer than the object is satisfiable and means "all of it",
        // which is what the clamp at 0 produces.
        range = { start: Math.max(0, h.size - r.range.suffix), end: h.size - 1 };
      } else {
        range = r.range;
      }
    }

    const obj: ObjectStream | null = await this.storage.stream(r.file.storageKey, {
      ...(range ? { range } : {}),
    });
    if (!obj) {
      // A NULL MEANS TWO DIFFERENT THINGS AND THEY NEED DIFFERENT STATUS CODES.
      //
      // Every adapter returns null both for "no such object" and for a range
      // that starts past the end (FsStorage and MemoryStorage return null when
      // `start > end`; S3Storage maps a 416 from the store to null). The
      // delivery layer turned all of it into 404, which is wrong twice: RFC
      // 9110 reserves 416 for a well-formed range this object cannot satisfy,
      // and telling a caller who IS authorized to read the file that it does
      // not exist inverts the whole point of the uniform 404 -- that one is for
      // hiding existence from people without standing, not from the owner.
      //
      // Disambiguated with a HEAD, on the error path only, so the ordinary
      // delivery costs nothing extra. `head` is mandatory on `StorageAdapter`,
      // so this needs no capability check and no change to the adapter
      // interface third parties implement.
      if (range) {
        const h = await this.storage.head(r.file.storageKey);
        if (h) {
          throw new FilelayerError(416, 'range_not_satisfiable', `range_start:${range.start}`, {
            // The satisfiable extent. A client that asked past the end asked
            // precisely because it did not know the size; this is the only
            // field that tells it.
            'content-range': `bytes */${h.size}`,
          });
        }
      }
      throw new FilelayerError(404, 'not_found');
    }

    // Metering is deliberately outside the transaction and best-effort: it is
    // not a decision, and a metering failure must not fail a delivery the
    // system already authorized, charged and audited.
    const bytes = obj.size ?? r.file.sizeBytes ?? 0;
    await this.store.recordUsage(r.file.orgId, 'read', bytes).catch(() => {});

    const headers = { ...r.headers };
    // Trust the store's length over the column: a `size_bytes` that disagrees
    // with the object truncates or hangs the response.
    if (obj.size !== null) headers['content-length'] = String(obj.size);
    else delete headers['content-length'];
    // ADVERTISED ON EVERY PROXIED RESPONSE, not just on the ranged ones.
    //
    // `Accept-Ranges` was previously set only when a range had already been
    // served, which is the one moment the client no longer needs to be told. A
    // client discovers range support from the UNRANGED 200 -- that is the
    // response a video player, a PDF reader or a resuming downloader looks at
    // before deciding whether it can seek -- so advertising it only on 206 is
    // the same as not advertising it.
    //
    // `none` when a download cap binds, because `#reserve` drops ranges on
    // those deliveries. Saying so is what keeps the drop from being silent: a
    // client that is told `none` serves the whole file and does not retry,
    // which is the outcome that rule was chosen for.
    headers['accept-ranges'] = r.remainingDownloads === null ? 'bytes' : 'none';
    if (obj.range) {
      headers['content-range'] = `bytes ${obj.range.start}-${obj.range.end}/${obj.range.total}`;
    }

    const d: ProxyDelivery & {
      file: FileRecord;
      grantId?: string;
      remainingDownloads: number | null;
    } = {
      mode: 'proxy',
      file: r.file,
      headers,
      body: obj.body,
      bytes: obj.size,
      remainingDownloads: r.remainingDownloads,
      ...(r.grantId ? { grantId: r.grantId } : {}),
    };
    return d;
  }

  // ---------------------------------------------------------------------------
  // Listing -- the authorized query surface
  // ---------------------------------------------------------------------------

  /**
   * Which files in this org may this principal `capability`?
   *
   * This is the primitive that was missing, and its absence was
   * the reason the "0 authorization lines" claim survived: the example simply
   * did not have a listing screen, and building one meant hand-rolling the org
   * filter, the visibility rule, the owner check, the role check and the union
   * over `file_grant` in application SQL.
   *
   * WHY IT CANNOT BE GOT WRONG.
   *
   *  - There is no filter parameter. The signature takes a principal, an org,
   *    a capability, a page size and an opaque cursor. There is nothing here to
   *    forget to pass and nothing that widens the result set.
   *  - The predicate is generated from the same role table and the same
   *    lifecycle gate `authorize()` uses (see `listPredicate` in authz.ts), so
   *    the two cannot drift by editing one of them.
   *  - `test/listing.test.ts` asserts set equality against `authorize()` over a
   *    randomized corpus, on every capability, on every run.
   *
   * WHAT IT COSTS. One SQL query and one audit event, independent of page size.
   * A per-file `authorize()` loop would be 4 round trips x N.
   *
   * The empty page is a valid answer: a caller with no standing sees nothing,
   * and so does a caller naming an org that does not exist. Neither is an error,
   * because distinguishing them would rebuild the existence oracle.
   */
  async listFiles(
    principal: Principal,
    orgId: string,
    opts: ListFilesOptions = {},
  ): Promise<FileListPage> {
    // A link secret is a bearer credential for exactly one file. Refused rather
    // than ignored: a silently-dropped credential is how a caller ends up
    // believing they listed something they did not.
    if (principal.linkSecret !== undefined) {
      throw new FilelayerError(400, 'link_principal_cannot_list', 'link_principal_cannot_list');
    }
    const capability = opts.capability ?? 'read';
    // `Math.max(1, ...)` silently clamped `limit: 0` UP to one row -- neither
    // the zero the caller asked for nor the default they would have got by
    // omitting it. Refuse instead of guessing which one they meant.
    if (opts.limit !== undefined && (!Number.isSafeInteger(opts.limit) || opts.limit < 1)) {
      throw new FilelayerError(400, 'invalid_argument', 'limit_must_be_a_positive_integer');
    }
    const limit = Math.max(1, Math.min(opts.limit ?? LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT));

    const { files, hasMore } = await authorizeList(this.store, principal, orgId, {
      capability,
      limit,
      cursor: decodeCursor(opts.cursor),
    });

    const last = files[files.length - 1];
    return {
      // `ListedFile` and `FileRecord` are the same shape; the store returns the
      // columns `getFileRecord` returns, so nothing is re-fetched per row.
      files: files as FileRecord[],
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * ORDERING, and it is the mirror image of `upload()`.
   *
   * The metadata delete COMMITS FIRST -- the decision, the audit event the
   * engine wrote for it, and the state change, all in one transaction -- and
   * only then are the bytes removed. A crash in between leaves an object no row
   * points at, which is an orphan and therefore a garbage-collection problem.
   * The other ordering would leave a live, listable, authorizable `file` row
   * whose object is gone, which is data loss.
   *
   * The bytes are removed OUTSIDE the transaction for the same reason they are
   * written outside it: object storage cannot roll back, so including it would
   * mean a rolled-back transaction had already destroyed the object.
   */
  async delete(principal: Principal, fileId: string): Promise<void> {
    const file = await this.#transaction(async (tx, store) => {
      const decision = await authorize(store, principal, fileId, 'delete');
      this.#raise(decision);

      const f = await getFileRecord(tx, this.projectId, fileId);
      if (!f) throw new FilelayerError(404, 'not_found');
      await tx.query(
        `UPDATE file SET state = 'deleted', deleted_at = now(), updated_at = now()
          WHERE id = $1`,
        [fileId],
      );
      return f;
    });
    await this.storage.delete(file.storageKey);
  }

  /**
   * COLLECT ORPHANED OBJECTS. A REQUIRED OPERATIONAL JOB.
   *
   * An orphan is an object in the store with no `file` row pointing at
   * (provider, key). Two things produce them, both of them by design:
   *
   *   - a crash between `storage.put()` and the metadata commit in `upload()`;
   *   - a crash between the metadata commit and `storage.delete()` in
   *     `delete()`.
   *
   * Neither is a correctness problem -- an orphan is unreachable, because every
   * read path in the system starts from a `file` row, and keys are fresh UUIDs
   * that are never reissued -- but both cost money, and an uncollected orphan
   * from a delete is a compliance problem: the customer was told the bytes were
   * gone.
   *
   * WHAT MAKES THIS SAFE. Two things, and they are both load-bearing:
   *
   *  1. `olderThanSeconds` (default 1 hour, minimum 60s). An object written
   *     seconds ago may belong to an upload whose transaction has not committed
   *     yet. Deleting it would turn a successful upload into permanent data
   *     loss -- the exact failure this whole ordering exists to avoid. The grace
   *     period must exceed the longest plausible upload-plus-commit.
   *  2. The `file` lookup is by (storage_provider, storage_key), the pair the
   *     UNIQUE index is on, and it is NOT project-scoped and NOT filtered on
   *     `deleted_at`. A soft-deleted file whose bytes were never removed still
   *     has a row; this job must not race the delete path into removing bytes a
   *     retention hold is protecting. It only removes what NOTHING references.
   *
   * Control plane: it takes no principal for the same reason the other
   * lifecycle operations do not (see above). `dryRun` is the default.
   */
  /**
   * Reclaim upload reservations whose deadline passed without the bytes
   * arriving. A job you schedule, exactly like `collectStorageOrphans()`.
   *
   * Without it, `createUpload()` ships a slow leak: a `pending` row per
   * abandoned upload, invisible to every read path and therefore to anybody
   * who might notice.
   *
   * THE ORDERING, AND THE RACE THAT DECIDES IT.
   *
   * The dangerous interleaving is: the deadline passes, this job selects the
   * reservation, the client completes it at the last moment, and the job then
   * deletes the object. The result is a `ready` file with no bytes --
   * permanent, customer-visible data loss, and the exact failure every other
   * ordering decision in this library is arranged to avoid.
   *
   * So the ROW DELETION IS THE CLAIM, and it is atomic. One statement deletes
   * the row only if it is still `pending` and still past the cutoff, and
   * returns the key. The object is deleted only for a row this job actually
   * removed, so a reservation that completed first keeps its bytes and simply
   * is not collected. A crash between the two leaves an unreferenced object,
   * which `collectStorageOrphans()` reclaims -- the recoverable direction.
   *
   * The grace period is the second half. `completeUpload()` refuses a
   * reservation past its deadline, so a completion that succeeded happened
   * before it; waiting a further `graceSeconds` puts real separation between
   * the two rather than relying on two clocks agreeing. Floored at 60 seconds
   * for the same reason the orphan collector's is.
   *
   * SOFT DELETION WOULD BE WRONG HERE, and it is worth saying why: a row with
   * `deleted_at` set still references its key, so `collectStorageOrphans()`
   * skips it forever. Any bytes that did arrive late would be stranded and
   * billed indefinitely. This is the one place in the schema where a hard
   * delete is the correct answer -- the row describes a file that never
   * existed, and `audit_event.file_id` carries no foreign key precisely so
   * that the record of it survives the row.
   */
  async collectUploadReservations(
    opts: { graceSeconds?: number; limit?: number; dryRun?: boolean } = {},
  ): Promise<{ scanned: number; collected: number; dryRun: boolean }> {
    const dryRun = opts.dryRun ?? true;
    const grace = Math.max(60, Math.floor(opts.graceSeconds ?? 3600));
    const limit = Math.max(1, Math.min(Math.floor(opts.limit ?? 100), 1000));
    const cutoff = new Date(Date.now() - grace * 1000);

    const { rows: candidates } = await this.db.query<{ id: string; org_id: string; storage_key: string }>(
      `SELECT id, org_id, storage_key
         FROM file
        WHERE state = 'pending'
          -- Redundant against the comparison below, which already excludes
          -- NULL by three-valued logic, and kept for the reader rather than for
          -- the planner: it is what says "a reservation" instead of "any
          -- pending row". Recorded as redundant because a mutation removing it
          -- survives the suite, and a guard no test can kill is a guard whose
          -- real job is documentation.
          AND upload_expires_at IS NOT NULL
          AND upload_expires_at < $1::timestamptz
          AND ($3::uuid IS NULL OR project_id = $3::uuid)
        ORDER BY upload_expires_at ASC
        LIMIT $2`,
      [cutoff.toISOString(), limit, this.projectId],
    );

    if (dryRun) return { scanned: candidates.length, collected: 0, dryRun: true };

    let collected = 0;
    for (const c of candidates) {
      // THE ATOMIC CLAIM. The predicates are repeated here rather than trusted
      // from the SELECT: between the two statements a client may have
      // completed, and this is the only place that can notice.
      const claimed = await this.#transaction(async (tx, store) => {
        const { rows } = await tx.query<{ storage_key: string }>(
          `DELETE FROM file
             WHERE id = $1
               AND state = 'pending'
               AND upload_expires_at IS NOT NULL
               AND upload_expires_at < $2::timestamptz
           RETURNING storage_key`,
          [c.id, cutoff.toISOString()],
        );
        if (rows.length === 0) return null;
        await store.audit({
          orgId: c.org_id,
          action: 'file.upload_abandoned',
          decision: 'allow',
          actorId: null,
          fileId: c.id,
          context: { storageKey: c.storage_key, collector: true },
        });
        return rows[0]!.storage_key;
      });
      if (claimed === null) continue;

      // Only now, and only for a row we removed. A failure here is an orphan,
      // not a loss: the row is already gone, so nothing points at these bytes.
      await this.storage.delete(claimed).catch(() => {});
      collected++;
    }
    return { scanned: candidates.length, collected, dryRun: false };
  }

  async collectStorageOrphans(
    opts: {
      prefix?: string;
      olderThanSeconds?: number;
      limit?: number;
      dryRun?: boolean;
    } = {},
  ): Promise<{ scanned: number; orphans: string[]; deleted: number; truncated: boolean }> {
    if (!canList(this.storage)) {
      throw new FilelayerError(
        500,
        'storage_cannot_list',
        'orphan collection needs a storage adapter that implements list()',
      );
    }
    // THE FLOOR IS NOT THE GUARD. `Math.max(60, x)` clamps every finite number,
    // including 0 and -Infinity -- that part worked. But `Math.max(60, NaN)` is
    // `NaN`, `cutoff` becomes `NaN`, and `e.lastModified.getTime() > NaN` is
    // false for every object, so the skip below never fires and the grace period
    // disappears entirely. The collector then deletes objects written
    // milliseconds ago -- which is byte-for-byte the state of an upload in
    // flight, since `upload()` writes no reservation row before `storage.put()`.
    // The result is a committed, listable, authorizable file whose object does
    // not exist: the precise data loss the byte-first ordering exists to prevent.
    //
    // `Number(process.env.GC_GRACE)` on a misspelled variable is `NaN`, and
    // TypeScript does not survive the process boundary, so this is reachable by
    // a correct caller with a typo in a deployment config.
    const requestedGrace = opts.olderThanSeconds ?? 3600;
    if (!Number.isFinite(requestedGrace)) {
      throw new FilelayerError(400, 'invalid_argument', 'older_than_seconds_not_finite');
    }
    const grace = Math.max(60, requestedGrace) * 1000;
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
    const cutoff = Date.now() - grace;
    const dryRun = opts.dryRun ?? true;

    let cursor: string | null = null;
    let scanned = 0;
    const orphans: string[] = [];
    let truncated = false;

    do {
      const page: { entries: Array<{ key: string; lastModified: Date | null }>; cursor: string | null } =
        await this.storage.list(opts.prefix ?? '', {
          limit: Math.min(1000, limit),
          cursor,
        });
      cursor = page.cursor;
      for (const e of page.entries) {
        scanned++;
        // No timestamp means we cannot prove it is old. Fail closed: skip it.
        if (e.lastModified === null || e.lastModified.getTime() > cutoff) continue;
        // A SOFT-DELETED ROW NO LONGER SHIELDS ITS OWN BYTES.
        //
        // The lookup used to match any row at all. That made the tombstone left
        // by `delete()` permanently protective: when `delete()` committed the
        // soft delete and then its `storage.delete()` threw -- a transient S3
        // error is enough -- the bytes survived, the row survived, and because
        // the row survived no GC run could ever reach them. There is no retry,
        // no queue and no reconciler, and `delete()` is a 404 the second time.
        // The customer had been told the bytes were gone and nothing would ever
        // make that true.
        //
        // Collecting them is not a race against the delete path, it is the same
        // operation finishing: a file row has no undelete, so `state =
        // 'deleted'` is terminal and those bytes are garbage by definition.
        //
        // The retention clause is belt and braces. `lifecycleDenial` already
        // refuses to delete a file under an active hold, so no soft-deleted row
        // can have `retain_until` in the future -- but stating it here makes the
        // invariant local instead of inferred from another file, and the next
        // person to add a deletion path does not have to rediscover it.
        const { rows } = await this.db.query(
          `SELECT 1 FROM file
            WHERE storage_provider = $1 AND storage_key = $2
              AND (deleted_at IS NULL OR (retain_until IS NOT NULL AND retain_until > now()))`,
          [this.storage.provider, e.key],
        );
        if (rows.length > 0) continue;
        orphans.push(e.key);
        if (orphans.length >= limit) {
          truncated = true;
          break;
        }
      }
    } while (cursor !== null && !truncated);

    let deleted = 0;
    if (!dryRun) {
      // THE AUDIT WRITE IS IN A `finally`, AND IT CARRIES THE KEYS.
      //
      // Two defects, one shape. The event used to be written after the loop, so
      // a `storage.delete()` that threw on the third of three orphans destroyed
      // the first two and recorded NOTHING -- bytes gone, log silent. And on the
      // happy path it recorded only counts, so even a successful run could not
      // answer "which objects did you destroy?". For a library whose claim is a
      // trail you can hand to a compliance auditor, an unreconstructable destructive job
      // is the wrong default.
      //
      // The keys are bounded by `limit` (<= 10,000) and are storage keys, not
      // user content.
      const destroyed: string[] = [];
      try {
        for (const key of orphans) {
          await this.storage.delete(key);
          destroyed.push(key);
          deleted++;
        }
      } finally {
        await this.store.audit({
          orgId: null,
          action: 'storage.gc',
          decision: 'allow',
          actorId: null,
          fileId: null,
          context: {
            chain: 'system',
            provider: this.storage.provider,
            scanned,
            deleted,
            keys: destroyed,
            complete: destroyed.length === orphans.length,
            via: 'control_plane',
          },
        });
      }
    }
    return { scanned, orphans, deleted, truncated };
  }

  // ---------------------------------------------------------------------------
  // Grants
  // ---------------------------------------------------------------------------

  async share(principal: Principal, fileId: string, input: ShareInput): Promise<ShareResult> {
    const capabilities = input.capabilities ?? (['read'] as Capability[]);

    // ONE TRANSACTION: the decision, the grant row, and the audit event that
    // records both. Previously these were three autocommit statements, so a
    // failure in the middle could leave a live grant that the audit log has no
    // record of anyone creating -- a grant with no provenance, which for a
    // capability system is the worst possible row to be missing.
    return this.#transaction(async (tx, store) => {
    // One call, two questions: may you share, and is what you are handing out a
    // subset of what you hold? Both are answered by the engine. The
    // engine also tells us which grant your authority came from, which becomes
    // this grant's parent and is what makes revocation transitive.
    // The subject type is part of the authorization question, not a detail of
    // the row: I6 says a grant-derived issuer may not widen the population.
    // Passing it here is what lets the ENGINE refuse -- with a reason and an
    // audit event -- rather than leaving the trigger to raise at INSERT time.
    // A password is only meaningful on a link, because the link path is the only
    // one that has anything to prompt. Accepting it anywhere else stored a hash
    // that NO read path ever consulted: `share({ subject: { type: 'anonymous' },
    // password })` published the file to the world while looking, at the call
    // site, exactly like publishing it behind a password. Silent, and the worst
    // direction to be silent in. Refusing is the whole fix -- there is no
    // sensible thing to do with a password on a subject that is never asked for
    // one. `grant_password_only_on_link` in schema.sql refuses the row as well,
    // so this cannot be reintroduced by a second writer.
    if (input.password !== undefined && input.subject.type !== 'link') {
      throw new FilelayerError(400, 'password_requires_link_subject');
    }

    // A LINK CARRIES `read` AND NOTHING ELSE, and this is where you find that
    // out. `grant_link_read_only` in schema.sql has refused the row since
    // 0.5.1, which is the right place for the rule to live -- but the only
    // path to it was the INSERT, so `shares.create(id, { as, capabilities:
    // ['read', 'delete'] })` surfaced as a raw SQLSTATE 23514 with the
    // constraint name in it. Two costs, both measured in the starter: there is
    // no status on it, so an HTTP layer that maps `FilelayerError.status`
    // returned 500 for what is a 400; and a pg error carries `detail` with the
    // failing row, which for `file_grant` includes `secret_hash`, so a server
    // that logged the error logged a credential. The check belongs in front of
    // the database as well as in it.
    if (input.subject.type === 'link') {
      const extra = capabilities.filter((c) => c !== 'read');
      if (extra.length > 0) {
        throw new FilelayerError(
          400,
          'link_is_read_only',
          `link_capabilities:${extra.join(',')}`,
        );
      }
    }

    const decision = await authorizeShare(store, principal, fileId, capabilities, {
      subjectType: input.subject.type,
    });
    if (!decision.allow) {
      const pub = toPublicError(decision.reason);
      throw new FilelayerError(pub.status, pub.code, decision.reason);
    }

    const file = await getFileRecord(tx, this.projectId, fileId);
    if (!file) throw new FilelayerError(404, 'not_found');

    const expiresAt = secondsFromNow(input.expiresIn, Date.now(), 'expiresIn');

    // `?? null` does not catch 0, and `max_downloads integer CHECK (> 0)` in
    // schema.sql does -- on the INSERT, as a raw SQLSTATE 23514. Since 23514 is
    // not one of the named `grant_*` triggers in `SCHEMA_REFUSAL`, the error was
    // rethrown unmapped AND the deny-audit branch never fired, so a caller
    // hammering this left no grant row and no trace of having tried.
    //
    // Three more values reached the driver raw for the same reason: -1 (23514),
    // 1.5 (22P02, invalid integer syntax) and 2^31 (22003, out of range). All
    // four are caller-supplied, all four are a 400.
    //
    // 0 deserves naming on its own. It reads as "nobody may download this",
    // which is a coherent thing to want -- and it is spelled by not creating the
    // grant. Letting it mean "unlimited", which is what `?? null` would have
    // done had the constraint not caught it, is the `expiresIn: 0` mistake again:
    // the most restrictive value anyone can ask for producing the least
    // restrictive outcome.
    if (input.maxDownloads !== undefined && input.maxDownloads !== null) {
      const n = input.maxDownloads;
      if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) {
        throw new FilelayerError(
          400,
          'invalid_argument',
          'max_downloads_must_be_a_positive_integer',
        );
      }
    }

    let secret: string | undefined;
    let secretHash: string | null = null;
    let subjectId: string | null = null;
    let subjectOrgId: string | null = null;
    let subjectMinRole: OrgRole | null = null;

    if (input.subject.type === 'link') {
      // 256 bits from the CSPRNG. Base64url so it survives a URL path segment.
      secret = randomBytes(32).toString('base64url');
      secretHash = await this.store.hashSecret(secret);
    } else if (input.subject.type === 'actor') {
      subjectId = input.subject.actorId;
    } else if (input.subject.type === 'org' || input.subject.type === 'role') {
      // I1/P8. The composite FK already makes a cross-PROJECT subject org
      // unrepresentable; this resolves it first so the caller gets the same
      // uniform 404 they get for any other id they may not name, instead of a
      // foreign-key violation that would confirm the id exists somewhere. An
      // org in another project, an org that does not exist, and a malformed id
      // are one answer -- the same symmetry the file paths keep.
      subjectOrgId = await this.#resolveSubjectOrg(tx, input.subject.orgId);
      if (input.subject.type === 'role') subjectMinRole = input.subject.minRole;
    }

    const passwordHash = input.password ? await this.store.hashPassword(input.password) : null;

    // org_id is taken from the FILE, never from the caller. The composite FK
    // (file_id, org_id) -> file(id, org_id) makes a mismatch unrepresentable,
    // but taking it from the caller at all would be an invitation.
    //
    // The RETURNING clause reads back expires_at and max_downloads because the
    // attenuation trigger may have tightened them against the parent grant. We
    // report what was actually stored, not what was asked for.
    //
    // THE SAVEPOINT IS NOT OPTIONAL. A statement that RAISES inside a Postgres
    // transaction aborts the whole transaction: every subsequent statement
    // fails with "current transaction is aborted". The attenuation trigger
    // raising is precisely the case where we must keep going, because the
    // refusal has to be AUDITED. Without the savepoint the audit write below
    // would itself fail and the refusal would vanish -- the transaction work
    // would have silently deleted a security event.
    let rows: Array<{ id: string; expires_at: string | null; max_downloads: number | null }>;
    try {
      ({ rows } = await tx.savepoint(() => tx.query<{
        id: string;
        expires_at: string | null;
        max_downloads: number | null;
      }>(
        `INSERT INTO file_grant
           (file_id, org_id, parent_grant_id, subject_type, subject_id, subject_org_id,
            subject_min_role, capabilities,
            secret_hash, password_hash, expires_at, max_downloads, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::grant_capability[],$9,$10,$11,$12,$13)
         RETURNING id, expires_at, max_downloads`,
        [
          fileId,
          file.orgId,
          decision.parentGrantId,
          input.subject.type,
          subjectId,
          subjectOrgId,
          subjectMinRole,
          pgArrayLiteral(capabilities),
          secretHash,
          passwordHash,
          expiresAt?.toISOString() ?? null,
          input.maxDownloads ?? null,
          principal.actorId,
        ],
      )));
    } catch (err) {
      // The schema is the backstop for attenuation; if it fires, it has caught
      // something the engine let through.
      const refusal = schemaRefusal(err);
      if (!refusal) throw err;
      await store.audit({
        orgId: file.orgId,
        action: 'grant.create',
        decision: 'deny',
        reason: refusal,
        actorId: principal.actorId,
        fileId,
        grantId: decision.parentGrantId,
        context: { capabilities, subjectType: input.subject.type },
      });
      throw new FilelayerError(403, 'forbidden', refusal);
    }


    const grantId = rows[0]!.id;
    const effectiveExpiry = rows[0]!.expires_at ? new Date(rows[0]!.expires_at) : null;
    const effectiveCap = rows[0]!.max_downloads ?? null;

    await store.audit({
      orgId: file.orgId,
      action: 'grant.create',
      decision: 'allow',
      actorId: principal.actorId,
      fileId,
      grantId,
      context: {
        subjectType: input.subject.type,
        ...(subjectOrgId ? { subjectOrgId } : {}),
        ...(subjectMinRole ? { subjectMinRole } : {}),
        capabilities,
        parentGrantId: decision.parentGrantId,
        expiresAt: effectiveExpiry?.toISOString() ?? null,
        maxDownloads: effectiveCap,
      },
    });

    return {
      grantId,
      ...(secret ? { secret } : {}),
      ...(secret && this.opts.baseUrl ? { url: `${this.opts.baseUrl}/d/${secret}` } : {}),
      expiresAt: effectiveExpiry,
      maxDownloads: effectiveCap,
      parentGrantId: decision.parentGrantId,
    };
    });
  }

  /**
   * Resolve the org named by an `org` / `role` grant subject (RFC-001, I1).
   *
   * Three things have to be true and only one of them is about convenience:
   *
   *  - the org must EXIST and not be soft-deleted (a grant naming a dead tenant
   *    would be born non-live anyway -- see `grant_scope_is_live` -- so minting
   *    one is a caller error worth reporting);
   *  - it must be in THIS instance's project. That is the P8 boundary, and it
   *    is the thing that makes a cross-project group grant unrepresentable. The
   *    composite foreign key enforces it regardless; this exists so the answer
   *    is a clean 404 rather than a constraint violation whose message would
   *    itself confirm the id resolves to a row somewhere in the database.
   *  - it need NOT be the file's own org. Cross-ORG group grants inside one
   *    project are the whole point of the feature.
   */
  async #resolveSubjectOrg(tx: Tx, orgId: string): Promise<string> {
    if (!isUuid(orgId)) throw new FilelayerError(404, 'not_found', 'unknown_subject_org');
    const { rows } = await tx.query<{ id: string }>(
      `SELECT o.id FROM org o
         JOIN project p ON p.id = o.project_id
        WHERE o.id = $1
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL
          AND ($2::uuid IS NULL OR o.project_id = $2::uuid)`,
      [orgId, this.projectId],
    );
    if (!rows[0]) throw new FilelayerError(404, 'not_found', 'unknown_subject_org');
    return rows[0].id;
  }

  /**
   * Revoke a grant.
   *
   * Nothing cascades, and nothing needs to: liveness is evaluated over the
   * ancestor chain, so every grant ever delegated from this one dies in the
   * same instant, at any depth, with no second write to get wrong (P4).
   */
  async revoke(principal: Principal, grantId: string): Promise<void> {
    if (!isUuid(grantId)) throw new FilelayerError(404, 'not_found');
    // Revocation is the operation the product is sold on, so the state change
    // and the event proving it happened must not be separable. Both are in this
    // transaction.
    //
    // LOCK ORDERING, and it is not decorative. Because `audit_append()` takes a
    // `pg_advisory_XACT_lock` on the org's chain, a transaction now holds that
    // lock from its FIRST audit write until commit -- which it did not before,
    // when every statement was its own transaction. Two transactions that take
    // the chain lock and a `file_grant` row lock in OPPOSITE orders deadlock.
    // The rule, followed by every method here, is:
    //
    //     THE AUDIT CHAIN LOCK IS ALWAYS TAKEN BEFORE ANY ROW LOCK.
    //
    // `authorizeRevoke` emits its allow event (chain lock) before the UPDATE
    // below (row lock), and the delivery path likewise audits in `authorize()`
    // before `consume_download()` touches the grant row. This SELECT therefore
    // deliberately does NOT take `FOR UPDATE`: that would grab the row lock
    // first and invert the order against every other path. Nothing is lost --
    // the UPDATE is `WHERE revoked_at IS NULL`, so a concurrent revoke is
    // idempotent rather than a lost update.
    await this.#transaction(async (tx, store) => {
      const { rows } = await tx.query<{ file_id: string; org_id: string }>(
        `SELECT file_id, org_id FROM file_grant WHERE id = $1`,
        [grantId],
      );
      const g = rows[0];
      // Unknown grant and "not yours" are the same answer, for the same reason
      // file ids are: otherwise this endpoint is a grant-id oracle.
      if (!g) throw new FilelayerError(404, 'not_found');

      const decision = await authorizeRevoke(store, principal, {
        id: grantId,
        fileId: g.file_id,
        orgId: g.org_id,
      });
      this.#raise(decision);

      await tx.query(
        `UPDATE file_grant SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [grantId],
      );
      await store.audit({
        orgId: g.org_id,
        action: 'grant.revoke',
        decision: 'allow',
        actorId: principal.actorId,
        fileId: g.file_id,
        grantId,
      });
    });
  }

  async listGrants(principal: Principal, fileId: string): Promise<GrantSummary[]> {
    const decision = await authorize(this.store, principal, fileId, 'share');
    this.#raise(decision);

    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, file_id, parent_grant_id, subject_type, subject_id,
              subject_org_id, subject_min_role, capabilities,
              (password_hash IS NOT NULL) AS has_password,
              expires_at, max_downloads, download_count, revoked_at,
              grant_is_live(id) AS live,
              created_by, created_at
         FROM file_grant WHERE file_id = $1 ORDER BY created_at ASC`,
      [fileId],
    );
    // Note what is NOT selected: secret_hash and password_hash. A "list what
    // we've shared" screen is exactly where a hash would leak into a log.
    return rows.map((r) => ({
      id: r['id'] as string,
      fileId: r['file_id'] as string,
      parentGrantId: (r['parent_grant_id'] as string | null) ?? null,
      subjectType: r['subject_type'] as GrantSubjectType,
      subjectId: (r['subject_id'] as string | null) ?? null,
      subjectOrgId: (r['subject_org_id'] as string | null) ?? null,
      subjectMinRole: (r['subject_min_role'] as OrgRole | null) ?? null,
      capabilities: toCapabilities(r['capabilities'] as Capability[] | string),
      hasPassword: Boolean(r['has_password']),
      expiresAt: r['expires_at'] ? new Date(r['expires_at'] as string) : null,
      maxDownloads: (r['max_downloads'] as number | null) ?? null,
      downloadCount: Number(r['download_count']),
      revokedAt: r['revoked_at'] ? new Date(r['revoked_at'] as string) : null,
      live: Boolean(r['live']),
      createdBy: (r['created_by'] as string | null) ?? null,
      createdAt: new Date(r['created_at'] as string),
    }));
  }

  /**
   * The share-link download path.
   *
   * Order matters: authorize FIRST (which re-validates the grant and its whole
   * ancestor chain against `live_grant` -- P4, revocation beats a live URL),
   * then consume the counter atomically (P6). Consuming before authorizing
   * would let a revoked link burn a download; authorizing without consuming
   * would make the cap a suggestion.
   */
  async redeem(
    linkSecret: string,
    opts: {
      password?: string;
      ip?: string;
      userAgent?: string;
      disposition?: Disposition;
    } = {},
  ): Promise<{
    file: FileRecord;
    body: Uint8Array;
    headers: Record<string, string>;
    remainingDownloads: number | null;
  }> {
    // Buffered convenience form of `redeemStream()`, exactly as `read()` is of
    // `readStream()`. Forces proxy mode for the same reason.
    const d = await this.redeemStream(linkSecret, { ...opts, mode: 'proxy' });
    if (d.mode !== 'proxy') throw new FilelayerError(500, 'internal', 'unexpected_redirect');
    return {
      file: d.file,
      body: await collectStream(d.body),
      headers: d.headers,
      remainingDownloads: d.remainingDownloads,
    };
  }

  /** The streaming share-link path. See `redeem()` for the ordering rationale. */
  async redeemStream(
    linkSecret: string,
    opts: {
      password?: string;
      ip?: string;
      userAgent?: string;
      disposition?: Disposition;
      mode?: 'proxy' | 'auto';
      range?: RangeSpec;
    } = {},
  ): Promise<StreamedDelivery & { file: FileRecord; remainingDownloads: number | null }> {
    const principal: Principal = {
      actorId: null,
      linkSecret,
      ...(opts.password !== undefined ? { password: opts.password } : {}),
      ...(opts.ip !== undefined ? { ip: opts.ip } : {}),
      ...(opts.userAgent !== undefined ? { userAgent: opts.userAgent } : {}),
    };

    const hash = await this.store.hashSecret(linkSecret);

    const reserved = await this.#transaction(async (tx, store) => {
      // Resolve the secret to a FILE, not to an authorization. This
      // deliberately reads through the non-live lookup: a revoked, expired or
      // exhausted link must still reach the engine so that the denial is
      // attributed to the right tenant and recorded with the right reason.
      // Nothing here grants anything -- `authorize` below re-resolves through
      // `live_grant`.
      const grant = await store.findGrantBySecret(hash);
      if (!grant) {
        // No file and no tenant: the system chain exists precisely so that a
        // brute-force sweep against the credential itself is not invisible.
        // In the transaction, so the sweep cannot be made invisible by a
        // failure on the way out either.
        await auditUnresolvedSecret(store, principal, hash);
        throw new FilelayerError(404, 'not_found', 'bad_link_secret');
      }

      const decision = await authorize(store, principal, grant.fileId, 'read');
      this.#raise(decision);

      // Same reservation path as `readStream()`: one place charges the cap, one
      // place decides the mode, one place computes the headers. `no-store` on
      // the proxied response is not cosmetic here -- immediate revocation is the
      // product's headline property, and a cacheable share response makes a
      // revoked link replayable from the recipient's disk cache or from any
      // intermediary.
      return this.#reserve(tx, store, grant.fileId, decision, principal, opts);
    });

    return this.#fetchDelivery(reserved);
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  /**
   * "Who touched this?", answered in the words the caller used.
   *
   * Requires `read_audit` in the org, which is admin+. Asked of the engine.
   *
   * Each row is a `ResolvedAuditRow`: the stored `actorId`, `fileId` and
   * `orgId` are present and unchanged, and alongside them are `.actor`,
   * `.file` and `.org`, carrying the external ids the caller supplied, plus a
   * `.summary` line that prints as an answer:
   *
   * ```text
   * 2026-09-06T10:12:41.002Z marco file.read deny:grant_revoked contract.pdf @acme
   * ```
   *
   * Resolution is a join on the same statement, so this remains one query.
   * `.actor.label` is `'anonymous'` for a link redemption, `.org.label` is
   * `'system'` on the system chain, and an id that resolves to nothing in this
   * project (a probe) keeps the uuid as its label with `resolution:
   * 'unresolved'` -- there is no null to interpret and nothing is invented.
   */
  async auditLog(
    principal: Principal,
    orgId: string,
    filter: AuditFilter = {},
  ): Promise<ResolvedAuditRow[]> {
    const decision = await authorizeOrg(this.store, principal, orgId, 'read_audit', {
      action: 'audit.read',
      emitAllow: false, // reading the log should not spam the log
    });
    this.#raise(decision);
    return this.store.listAuditResolved(orgId, filter);
  }

  /**
   * Verify the tamper-evidence chain for an org.
   *
   * Authorized, because `checked` is a count of everything that has ever
   * happened in the org and an unauthenticated caller should not be able to
   * measure another tenant's activity.
   */
  async verifyAuditChain(principal: Principal, orgId: string): Promise<AuditChainResult> {
    const decision = await authorizeOrg(this.store, principal, orgId, 'read_audit', {
      action: 'audit.verify',
      emitAllow: false,
    });
    this.#raise(decision);
    return this.store.verifyAuditChain(orgId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Turn a denial into an HTTP-shaped error.
   *
   * That is all it does now. It used to additionally re-run the whole
   * authorization question in order to downgrade 410/409 to 404 for callers
   * with no standing, because `authorize()` evaluated lifecycle gates before
   * establishing standing and therefore leaked existence. The engine
   * evaluates standing first now, so there is nothing left to compensate for --
   * and, not incidentally, one fewer place for a second entry point to forget.
   */
  #raise(decision: Decision): asserts decision is Extract<Decision, { allow: true }> {
    if (decision.allow) return;
    const pub = toPublicError(decision.reason);
    throw new FilelayerError(pub.status, pub.code, decision.reason);
  }
}

/**
 * A file's full record from its id, with NO principal.
 *
 * IT IS A MODULE-LEVEL FUNCTION, NOT A PRIVATE METHOD, AND THAT IS THE POINT.
 *
 * This was once a PUBLIC method taking a file id and no principal, returning
 * name, content type, size, storage key, owner and org for any file in the
 * database. It sat under an `// Internals` comment, which binds nobody:
 * `fl.getFileRecord(anyUuid)` was a complete cross-tenant metadata read with no
 * decision, no denial and no audit event. A resource id without a principal is
 * not a question the system is allowed to answer.
 *
 * Making it `private` fixed the TYPE and not the RUNTIME. TypeScript's `private`
 * is erased at compile time: `(fl as any).getFileRecord(id)` still worked, and
 * so did `fl['getFileRecord'](id)` from plain JavaScript -- which is what an SDK
 * consumer actually holds. A test in test/persistence.test.ts caught exactly
 * that. Module scope is the only privacy JavaScript actually enforces, so the
 * function lives out here, where nothing outside this file can name it.
 *
 * Every caller inside the class reaches it only AFTER `authorize()` has
 * returned allow for the same file; the authorized replacement for external
 * callers is `stat()`. It is project-scoped, so even an internal caller cannot
 * read across a project boundary.
 */
async function getFileRecord(
  db: Queryable,
  projectId: string | null,
  fileId: string,
): Promise<FileRecord | null> {
  if (!isUuid(fileId)) return null;
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT id, org_id, owner_id, name, content_type, size_bytes,
            storage_provider, storage_key,
            state, visibility, expires_at, retain_until, created_at, deleted_at
       FROM file WHERE id = $1 AND ($2::uuid IS NULL OR project_id = $2::uuid)`,
    [fileId, projectId],
  );
  return rows[0] ? toFileRecord(rows[0]) : null;
}

/**
 * Listing options.
 *
 * Note what is absent: any way to express a WHERE clause, a raw filter, an
 * "include everything" flag, or a way to name another org. Everything here
 * NARROWS the authorized set; nothing widens it. That is what "fail-closed by
 * construction" has to mean for a query API -- not that the default is safe,
 * but that the unsafe result is not expressible.
 */
export interface ListFilesOptions {
  /** Which capability the caller must hold. Default `read`. */
  capability?: Capability;
  /** Page size. Clamped to [1, 200]. */
  limit?: number;
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string | null;
}

export interface FileListPage {
  files: FileRecord[];
  /** Null when this is the last page. */
  nextCursor: string | null;
}

/**
 * Keyset pagination over (created_at, id).
 *
 * Keyset, not OFFSET: with OFFSET a row inserted or deleted between pages
 * shifts the window and a file silently skips a page, which on a compliance
 * listing screen is a file the reviewer never saw.
 *
 * The cursor is opaque but not authenticated, and it does not need to be: it
 * carries only a position, it is applied AFTER the authorization predicate, and
 * it is confined to the org named in the call. A forged cursor can move you
 * within your own authorized set and nowhere else. It is validated on the way
 * in so that a malformed one is a 400 rather than a silently-ignored filter.
 */
/**
 * Seconds-from-now, where asking for a bound and getting none is an ERROR.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. Both call sites were
 * `input.expiresIn ? new Date(now + input.expiresIn * 1000) : null`, so the two
 * falsy numbers meant "never expires":
 *
 *     expiresIn: 0    -> expires_at = null -> the link redeems forever
 *     expiresIn: NaN  -> expires_at = null -> the link redeems forever
 *     expiresIn: -1   -> already expired   -> refused
 *
 * `NaN` is what `Number(req.body.ttl)` gives you when the field is missing, and
 * `0` is what a caller writes when they mean "immediately". The handling was
 * also non-monotonic: the most restrictive value anyone could ask for produced
 * the least restrictive outcome, while a nonsensical one failed closed.
 *
 * This is the same shape as the password that was accepted and never enforced
 * in 0.5.0 -- an option taken, not honoured, and silent about it -- on the
 * option that bounds how long a share link lives. Found 2026-10-02 by
 * adversarial review.
 *
 * `undefined` still means "no bound", because that is the absence of a request
 * rather than a request for nothing.
 */
/**
 * Serialize every membership decision for one org, BEFORE the decision reads
 * anything.
 *
 * `authorizeMembershipChange` is a check-then-act: it counts the owners and
 * then writes. Both halves were already inside one transaction, so the defect
 * was never atomicity -- it was LOCK ORDER. The only lock the unit took was the
 * audit chain lock, acquired inside `audit_append`, which is reached from the
 * *settle* step, i.e. after the count. Two backends demoting two different
 * owners of a three-owner org therefore both read the pre-state, both passed
 * the `last_owner` guard on a count that was already stale, and both committed.
 * Under READ COMMITTED -- the default -- that leaves an org with no owner.
 *
 * Taking the same per-org key the chain already uses, as the first statement of
 * the unit, makes the whole decide-and-write sequence mutually exclusive per
 * org. It also PRESERVES the documented global ordering (SEMANTICS.md: the
 * audit chain lock is taken before any row lock), which is the reason this is
 * an advisory lock on the existing key rather than `SELECT ... FOR UPDATE` on
 * `membership` -- a row lock here would invert that order and reintroduce the
 * deadlock the ordering rule exists to prevent.
 *
 * `pg_advisory_xact_lock` is re-entrant for the same key in the same
 * transaction, so the later `audit_append` on this chain is a no-op acquisition
 * rather than a self-deadlock.
 *
 * NOT PROVEN UNDER CONTENTION. The test engine is PGlite, which has a single
 * backend and cannot interleave two transactions, so this is argued from
 * Postgres semantics and verified only in statement order. That limitation is
 * already disclosed in TRUST.md and this does not change it.
 */
async function lockOrgForMembershipChange(tx: Tx, orgId: string): Promise<void> {
  if (!isUuid(orgId)) return;
  await tx.query(`SELECT pg_advisory_xact_lock(audit_chain_lock_key($1::uuid))`, [orgId]);
}

function secondsFromNow(seconds: number | undefined, now: number, field: string): Date | null {
  if (seconds === undefined) return null;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new FilelayerError(400, 'invalid_argument', `${field}_not_finite`);
  }
  if (seconds <= 0) {
    throw new FilelayerError(400, 'invalid_argument', `${field}_not_positive`);
  }
  return new Date(now + seconds * 1000);
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new FilelayerError(400, 'bad_cursor');
  }
  const sep = decoded.lastIndexOf('|');
  if (sep < 0) throw new FilelayerError(400, 'bad_cursor');
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !isUuid(id)) {
    throw new FilelayerError(400, 'bad_cursor');
  }
  return { createdAt, id };
}

/**
 * Postgres array literal. The driver will not serialize a JS array into an
 * enum[] parameter, and a silent misencoding here would either error loudly
 * (fine) or store a single bogus capability (not fine), so the encoding is
 * explicit. Enum labels are a closed set of [a-z]+ and cannot contain a
 * separator, so no quoting is required -- but we assert that rather than
 * assume it.
 */
export function pgArrayLiteral(values: readonly string[]): string {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`unexpected capability literal: ${v}`);
  }
  return `{${values.join(',')}}`;
}

function toFileRecord(r: Record<string, unknown>): FileRecord {
  return {
    id: r['id'] as string,
    orgId: r['org_id'] as string,
    ownerId: (r['owner_id'] as string | null) ?? null,
    name: r['name'] as string,
    contentType: r['content_type'] as string,
    sizeBytes: r['size_bytes'] == null ? null : Number(r['size_bytes']),
    storageProvider: r['storage_provider'] as string,
    storageKey: r['storage_key'] as string,
    state: r['deleted_at'] ? 'deleted' : (r['state'] as 'pending' | 'ready' | 'deleted'),
    visibility: r['visibility'] as FileVisibility,
    expiresAt: r['expires_at'] ? new Date(r['expires_at'] as string) : null,
    retainUntil: r['retain_until'] ? new Date(r['retain_until'] as string) : null,
    createdAt: new Date(r['created_at'] as string),
  };
}
