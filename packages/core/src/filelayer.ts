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
  collectStream,
  type ObjectStream,
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
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO org (project_id, external_id, name)
       VALUES (coalesce($3::uuid, '${DEFAULT_PROJECT_ID}'::uuid), $1, $2) RETURNING id`,
      [externalId, name ?? null, this.projectId],
    );
    const id = rows[0]!.id;

    if (opts.ownerActorId) {
      await this.db.query(
        `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,'owner')`,
        [id, opts.ownerActorId],
      );
      await this.store.audit({
        orgId: id,
        action: 'member.bootstrap',
        decision: 'allow',
        actorId: opts.ownerActorId,
        fileId: null,
        context: { targetActorId: opts.ownerActorId, toRole: 'owner', via: 'org.create' },
      });
    }
    return { id };
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
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE project SET deleted_at = ${deleted ? 'now()' : 'NULL'}
        WHERE id = $1 RETURNING id`,
      [projectId],
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
    const decision = await authorizeMembershipChange(this.store, principal, orgId, actorId, role);
    this.#raise(decision);
    await this.db.query(
      `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (org_id, actor_id) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, actorId, role],
    );
  }

  async removeMember(principal: Principal, orgId: string, actorId: string): Promise<void> {
    const decision = await authorizeMembershipChange(this.store, principal, orgId, actorId, null);
    this.#raise(decision);
    await this.db.query(`DELETE FROM membership WHERE org_id = $1 AND actor_id = $2`, [
      orgId,
      actorId,
    ]);
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
    const expiresAt = input.expiresIn ? new Date(now + input.expiresIn * 1000) : null;
    const retainUntil = input.retainFor ? new Date(now + input.retainFor * 1000) : null;
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
    opts: { disposition?: Disposition; mode?: 'proxy' | 'auto'; range?: { start: number; end?: number } } = {},
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

    return this.#fetchDelivery(reserved, opts);
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
   * that single row becomes a write hotspot under load. It is a scalability
   * problem, not a correctness one, and the fix (skip the write when no
   * ancestor has a cap, and meter deliveries elsewhere) trades away the
   * per-grant download count. Not taken here because that count is a shipped
   * feature; flagged so the trade is made deliberately when volume forces it.
   */
  async #reserve(
    tx: Tx,
    store: PostgresStore,
    fileId: string,
    decision: Extract<Decision, { allow: true }>,
    principal: Principal,
    opts: { disposition?: Disposition; mode?: 'proxy' | 'auto' },
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

    const headers = deliveryHeaders(file, opts);
    const mode = this.#redirectEligible(decision, opts.mode ?? 'auto');

    if (mode === 'proxy') {
      return { kind: 'proxy', file, headers, remainingDownloads, grantId };
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
  ): 'proxy' | 'redirect' {
    if (requested !== 'auto') return 'proxy';
    if (this.redirect === null) return 'proxy';
    if (!canPresign(this.storage)) return 'proxy';
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
    opts: { range?: { start: number; end?: number } },
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

    const obj: ObjectStream | null = await this.storage.stream(r.file.storageKey, {
      ...(opts.range ? { range: opts.range } : {}),
    });
    if (!obj) throw new FilelayerError(404, 'not_found');

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
    if (obj.range) {
      headers['content-range'] = `bytes ${obj.range.start}-${obj.range.end}/${obj.range.total}`;
      headers['accept-ranges'] = 'bytes';
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
    const grace = Math.max(60, opts.olderThanSeconds ?? 3600) * 1000;
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
        const { rows } = await this.db.query(
          `SELECT 1 FROM file WHERE storage_provider = $1 AND storage_key = $2`,
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
      for (const key of orphans) {
        await this.storage.delete(key);
        deleted++;
      }
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
          via: 'control_plane',
        },
      });
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
    const decision = await authorizeShare(store, principal, fileId, capabilities, {
      subjectType: input.subject.type,
    });
    if (!decision.allow) {
      const pub = toPublicError(decision.reason);
      throw new FilelayerError(pub.status, pub.code, decision.reason);
    }

    const file = await getFileRecord(tx, this.projectId, fileId);
    if (!file) throw new FilelayerError(404, 'not_found');

    const expiresAt = input.expiresIn ? new Date(Date.now() + input.expiresIn * 1000) : null;

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
      range?: { start: number; end?: number };
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

    return this.#fetchDelivery(reserved, opts);
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
