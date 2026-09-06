/**
 * PROGRESSIVE DISCLOSURE -- the tiered surface.
 *
 * This file exists to answer one question:
 *
 *   "A developer who only needs a public avatar should be able to use an
 *    extremely simple version. A developer who needs a multi-tenant document
 *    system should be able to turn on the advanced capabilities."
 *
 * WHAT THIS FILE IS
 * -----------------
 * A thin, additive facade over `Filelayer`. It provisions the concepts the
 * developer did not ask for (a workspace, a service identity, a membership) so
 * that the trivial case costs one line, and it names the concepts the developer
 * DID ask for (an owner, an org, a role) so that the advanced case is reachable
 * by adding an option rather than by rewriting.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It contains **no authorization logic**. Every call below goes through the same
 * `authz.ts` engine as the full API, with the same audit guarantee. Grep it: the
 * only `if` statements are about which identifier to resolve, never about
 * whether access is permitted.
 *
 * THE FOUR SECURITY PROPERTIES, AND HOW EACH SURVIVES THE ERGONOMICS
 * -----------------------------------------------------------------
 * P1 (deny by default, no public boolean).
 *     `{ public: true }` does NOT set a flag. It creates an `anonymous` grant
 *     row -- the same row `share({subject:{type:'anonymous'}})` creates -- which
 *     is explicit, listable, revocable and audited. `unpublish()` revokes it.
 *     There is still no `file.public` column and there never will be.
 *
 * P2 (no ambient authority).
 *     Auto-provisioning creates IDENTITIES, never PERMISSIONS beyond the file
 *     the caller is creating. A user auto-registered by `put({owner})` gets the
 *     `member` role, and `member` + the default `private` visibility means they
 *     can read exactly their own files and nothing else. Reads never
 *     auto-provision: an unknown `as:` is a 404, not a silent downgrade to
 *     anonymous. That last rule is the one that would have been easy to get
 *     wrong and is tested explicitly.
 *
 * P3 (tenant isolation is structural).
 *     Untouched. Every file still has a real `org_id`. The "no org" experience
 *     is a DEFAULT org, not a NULL one -- see ARCHITECTURE-PROGRESSIVE.md for
 *     the measurement showing that a nullable `org_id` silently disables the
 *     composite foreign key that P3 rests on.
 *
 * P4 (a URL never outlives its permission).
 *     The public URL is `/f/:id` served by our own delivery path, which
 *     re-authorizes on every request. Revoke the anonymous grant and the URL is
 *     dead on the next request. This is the property a public S3 bucket and
 *     Supabase's `getPublicUrl` cannot offer at any price. It is ALSO the
 *     property that CDN caching would weaken -- see `delivery.ts`, which
 *     defaults to `no-store` for that reason.
 */

import {
  FilelayerError,
  type Filelayer,
  type FileRecord,
  type ShareSubject,
} from './filelayer.ts';
import { DEFAULT_PROJECT_ID } from './store.ts';
import type { Capability, FileVisibility, OrgRole, Principal } from './authz.ts';

/**
 * The org every file lands in when the developer never mentioned an org.
 *
 * A reserved `external_id`, not a magic NULL. Tier 3 is reached by naming a
 * different org, not by turning a boundary on.
 */
export const DEFAULT_WORKSPACE = '__filelayer_workspace__';

/**
 * The identity that owns files uploaded with no `owner:`.
 *
 * It is the `owner` of the default workspace (so tier 1 works with no user
 * model at all) and a plain `member` of any org the developer names (so it does
 * NOT acquire admin read over a real tenant's documents as a side effect of
 * being used for an unowned upload).
 */
export const SYSTEM_ACTOR = '__filelayer_system__';

export interface PutOptions {
  /** Defaults to `file`. Cosmetic; used for Content-Disposition. */
  name?: string;
  /** Sniffed from magic bytes when omitted; `application/octet-stream` if unknown. */
  contentType?: string;

  // --- tier 1 ---------------------------------------------------------------
  /**
   * Create an anonymous read grant alongside the file, and return a URL.
   *
   * This is one line of sugar over `share({subject:{type:'anonymous'}})`. It is
   * not a flag on the file. `unpublish()` takes it away, immediately, for URLs
   * already in the wild.
   */
  public?: boolean;

  // --- tier 2 ---------------------------------------------------------------
  /**
   * Your own user id. Auto-registered on first use and made a `member` of the
   * target workspace. With the default `private` visibility this means: they
   * can read their own files, and nobody else's.
   */
  owner?: string;

  // --- tier 3 ---------------------------------------------------------------
  /** Your own tenant id. Auto-created on first use. Defaults to the workspace. */
  org?: string;
  /** `private` (default) = owner + org admins. `org` = every member may read. */
  visibility?: FileVisibility;

  // --- tier 4 ---------------------------------------------------------------
  expiresIn?: number;
  retainFor?: number;
  metadata?: Record<string, unknown>;
}

export interface PutResult {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** Present only for `public: true` files, and only when `baseUrl` is set. */
  url?: string;
}

export interface AsOption {
  /**
   * Act as this user. Omit for an anonymous caller, which can read only files
   * carrying an anonymous grant.
   *
   * An `as:` naming a user we have never seen is a DENIAL, not an anonymous
   * read. Falling back would be the exact "ambient authority" failure P2 exists
   * to prevent.
   */
  as?: string;
}

export interface GetResult {
  id: string;
  name: string;
  contentType: string;
  body: Uint8Array;
  /** The response headers these bytes must be served with. See delivery.ts. */
  headers: Record<string, string>;
}

// -----------------------------------------------------------------------------
// Content sniffing
// -----------------------------------------------------------------------------
//
// Deliberately a short, conservative list of formats with unambiguous magic
// bytes. Everything else is `application/octet-stream`, which -- combined with
// the `X-Content-Type-Options: nosniff` and sandbox CSP headers in delivery.ts
// -- means an unrecognised upload is downloaded rather than executed. SVG is
// absent on purpose: it has no reliable magic number and it is a script
// execution context. Pass `contentType` explicitly if you need one.

const MAGIC: Array<[number[], string]> = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x25, 0x50, 0x44, 0x46], 'application/pdf'],
];

export function sniffContentType(body: Uint8Array): string {
  for (const [sig, type] of MAGIC) {
    if (sig.every((b, i) => body[i] === b)) return type;
  }
  // RIFF....WEBP
  if (
    body[0] === 0x52 && body[1] === 0x49 && body[2] === 0x46 && body[3] === 0x46 &&
    body[8] === 0x57 && body[9] === 0x45 && body[10] === 0x42 && body[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

// -----------------------------------------------------------------------------
// Identity resolution
// -----------------------------------------------------------------------------

/** The subset of `Filelayer` this facade drives. Declared to keep the import graph one-way. */
type Core = Filelayer;

class Identities {
  private readonly fl: Core;

  constructor(fl: Core) {
    this.fl = fl;
  }

  /** The project this facade resolves identities in. See P8 in schema.sql. */
  private get project(): string {
    return this.fl.projectId ?? DEFAULT_PROJECT_ID;
  }

  /**
   * Get-or-create an org by the customer's own id.
   *
   * `ON CONFLICT (project_id, external_id)` rather than a read-then-write, so
   * two cold requests racing to publish the first avatar cannot produce a
   * duplicate-key error in the developer's face.
   *
   * P8 (THE CUSTOMER'S ID SPACE IS THE CUSTOMER'S), AND THIS IS THE SHARPEST
   * EDGE OF IT. When `external_id` was globally
   * unique, this exact statement was a cross-tenant compromise: customer B
   * calling `put({ org: 'acme' })` did not get an error, it got customer A's
   * org id -- and `membership()` below then added B's user to A's tenant. The
   * conflict target is now the (project, external_id) pair, so "acme" in one
   * customer's application and "acme" in another are different rows that can
   * never resolve to each other.
   */
  async org(externalId: string, opts: { name?: string; ownerActorId?: string } = {}): Promise<string> {
    const { rows } = await this.fl.store.db.query<{ id: string }>(
      `INSERT INTO org (project_id, external_id, name) VALUES ($3, $1, $2)
         ON CONFLICT (project_id, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id`,
      [externalId, opts.name ?? externalId, this.project],
    );
    const id = rows[0]!.id;
    if (opts.ownerActorId) await this.membership(id, opts.ownerActorId, 'owner', true);
    return id;
  }

  /**
   * Get-or-create an identity by the customer's own id, within this project.
   *
   * FAILS CLOSED ON A DELETED IDENTITY. Auto-provisioning must never resurrect
   * someone who has been deleted: `ON CONFLICT DO UPDATE` would otherwise hand
   * back a soft-deleted actor's id, and the caller would go on to create a file
   * owned by a person the system has been told no longer exists. Access would
   * still be denied downstream (P7 kills their role and their grants), so the
   * failure is fail-closed either way -- but silently owning rows to a deleted
   * identity is a data-integrity mess, not a security decision we should be
   * making by accident.
   */
  async actor(externalId: string): Promise<string> {
    const { rows } = await this.fl.store.db.query<{ id: string; deleted_at: string | null }>(
      `INSERT INTO actor (project_id, external_id) VALUES ($2, $1)
         ON CONFLICT (project_id, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id, deleted_at`,
      [externalId, this.project],
    );
    const row = rows[0]!;
    if (row.deleted_at !== null) {
      throw new FilelayerError(404, 'not_found', 'deleted_actor');
    }
    return row.id;
  }

  /** Read-only lookup. Returns null for an unknown id -- callers must fail closed. */
  async findActor(externalId: string): Promise<string | null> {
    const { rows } = await this.fl.store.db.query<{ id: string }>(
      `SELECT id FROM actor
        WHERE external_id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [externalId, this.project],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Ensure a membership exists, WITHOUT ever downgrading an existing one.
   *
   * `DO NOTHING` and not `DO UPDATE`: auto-provisioning must never be able to
   * demote an admin a developer deliberately promoted, nor promote a member.
   * Deliberate role changes go through `orgs.setRole`, which is authorized.
   */
  async membership(orgId: string, actorId: string, role: OrgRole, bootstrap = false): Promise<void> {
    const { rows } = await this.fl.store.db.query<{ inserted: boolean }>(
      `INSERT INTO membership (org_id, actor_id, role) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, actor_id) DO NOTHING
       RETURNING true AS inserted`,
      [orgId, actorId, role],
    );
    // P5: an identity acquiring standing in an org is a privilege change and is
    // audited like any other, even though it was implicit.
    if (rows.length > 0) {
      await this.fl.store.audit({
        orgId,
        action: bootstrap ? 'member.bootstrap' : 'member.add',
        decision: 'allow',
        actorId,
        fileId: null,
        context: { targetActorId: actorId, toRole: role, via: 'auto_provision' },
      });
    }
  }
}

// -----------------------------------------------------------------------------
// files.*
// -----------------------------------------------------------------------------

export class FilesApi {
  private readonly fl: Core;
  private readonly ids: Identities;

  constructor(fl: Core) {
    this.fl = fl;
    this.ids = new Identities(fl);
  }

  /**
   * TIER 1: `put(bytes, { public: true })`      -> a URL, no other concepts.
   * TIER 2: `put(bytes, { owner: userId })`     -> adds an owner.
   * TIER 3: `put(bytes, { org, owner })`        -> adds a tenant.
   * TIER 4: `+ expiresIn / retainFor / metadata`
   */
  async put(body: Uint8Array, opts: PutOptions = {}): Promise<PutResult> {
    const contentType = opts.contentType ?? sniffContentType(body);
    const name = opts.name ?? 'file';

    // Resolve the tenant. Naming an org is what promotes you from tier 2 to
    // tier 3; not naming one puts you in the default workspace, which is a real
    // org with a real id, not a hole in the model.
    const isDefaultWorkspace = opts.org === undefined;
    const system = await this.ids.actor(SYSTEM_ACTOR);
    const orgId = isDefaultWorkspace
      ? await this.ids.org(DEFAULT_WORKSPACE, { name: 'workspace', ownerActorId: system })
      : await this.ids.org(opts.org!);

    // Resolve the owner. `owner:` auto-registers, because the developer is
    // asserting the identity exists in their system; we are not inventing it.
    let ownerId: string;
    if (opts.owner !== undefined) {
      ownerId = await this.ids.actor(opts.owner);
      await this.ids.membership(orgId, ownerId, 'member');
    } else {
      ownerId = system;
      // In a NAMED org the service identity is only a `member`, so an unowned
      // upload into a customer tenant does not hand us admin read over that
      // tenant's documents. In the default workspace it is the owner, because
      // somebody has to be.
      if (!isDefaultWorkspace) await this.ids.membership(orgId, system, 'member');
    }

    // The uploader is a Principal, not a bare id: ownership is derived from the
    // authorized identity, never supplied beside it. See the note on the
    // signature of `upload()` in filelayer.ts.
    const file = await this.fl.upload({ actorId: ownerId }, orgId, {
      name,
      contentType,
      body,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
      ...(opts.retainFor !== undefined ? { retainFor: opts.retainFor } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });

    let url: string | undefined;
    if (opts.public) {
      // P1 intact: this is a grant row, not a flag. The uploader mints it, so
      // it goes through `authorizeShare` and is audited as `grant.create`.
      await this.fl.share({ actorId: ownerId }, file.id, { subject: { type: 'anonymous' } });
      url = this.publicUrl(file.id);
    }

    return {
      id: file.id,
      name: file.name,
      contentType: file.contentType,
      size: file.sizeBytes ?? body.byteLength,
      ...(url ? { url } : {}),
    };
  }

  /**
   * Read a file as a user (`{ as }`), or anonymously (no options).
   *
   * `headers` is carried through from the delivery layer so that the simple
   * tier is exactly as safe as the full one. A tier-2 app that writes
   * `res.writeHead(200, { 'content-type': f.contentType })` re-opens the
   * stored-XSS path; `res.writeHead(200, f.headers)` does not.
   */
  async get(fileId: string, opts: AsOption = {}): Promise<GetResult> {
    const principal = await this.principal(opts);
    const { file, body, headers } = await this.fl.read(principal, fileId);
    return { id: file.id, name: file.name, contentType: file.contentType, body, headers };
  }

  async delete(fileId: string, opts: AsOption = {}): Promise<void> {
    await this.fl.delete(await this.principal(opts), fileId);
  }

  /** Make an existing file publicly readable. Same grant row as `put({public:true})`. */
  async publish(fileId: string, opts: AsOption = {}): Promise<{ url: string; grantId: string }> {
    const principal = await this.principal(opts, { orSystem: true });
    const g = await this.fl.share(principal, fileId, { subject: { type: 'anonymous' } });
    return { url: this.publicUrl(fileId), grantId: g.grantId };
  }

  /**
   * Withdraw public access. Revokes every live anonymous grant on the file.
   *
   * This is the operation a public bucket cannot perform: after it returns, a
   * URL that has been printed, indexed and shared stops working on the very
   * next request, because delivery re-authorizes every time.
   */
  async unpublish(fileId: string, opts: AsOption = {}): Promise<{ revoked: number }> {
    const principal = await this.principal(opts, { orSystem: true });
    const grants = await this.fl.listGrants(principal, fileId);
    let revoked = 0;
    for (const g of grants) {
      if (g.subjectType !== 'anonymous' || !g.live) continue;
      await this.fl.revoke(principal, g.id);
      revoked++;
    }
    return { revoked };
  }

  /**
   * The delivery URL for a public file. Meaningless without an anonymous grant.
   *
   * IT ALWAYS BUILDS ON `/f`, so whatever serves it has to be mounted there.
   * `deliveryHandler(fl)` is -- its `filePrefix` defaults to `/f`. But
   * `fileDownloadRoute(fl, { principal })` mounted on its own defaults to a
   * `prefix` of `/files`, and a URL from here would 404 against it. Either
   * mount `deliveryHandler`, or pass `prefix: '/f'` to `fileDownloadRoute`.
   */
  publicUrl(fileId: string): string {
    return `${this.fl.baseUrl ?? ''}/f/${fileId}`;
  }

  /**
   * Metadata only, no bytes, authorized identically to `get`.
   *
   * This used to call `read()` (fetching the whole object) and then
   * `getFileRecord()` (unauthorized, and now private). It calls the authorized
   * `stat()` instead, which means a metadata lookup no longer moves the bytes
   * and -- since the cap counts bytes leaving (P6) -- no longer spends a
   * download from a capped grant.
   */
  async stat(fileId: string, opts: AsOption = {}): Promise<FileRecord> {
    return this.fl.stat(await this.principal(opts), fileId);
  }

  /**
   * External user id -> Principal.
   *
   * FAILS CLOSED. An `as:` we cannot resolve is 404, never a silent demotion to
   * an anonymous principal -- which would turn a typo in a user id into a read
   * of every public file, and, worse, would make the audit log attribute it to
   * nobody.
   */
  private async principal(opts: AsOption, cfg: { orSystem?: boolean } = {}): Promise<Principal> {
    if (opts.as === undefined) {
      if (!cfg.orSystem) return { actorId: null };
      // publish/unpublish with no `as` is a server-side administrative action in
      // the default workspace, performed by the service identity that owns it.
      return { actorId: await this.ids.actor(SYSTEM_ACTOR) };
    }
    const actorId = await this.ids.findActor(opts.as);
    if (!actorId) throw new FilelayerError(404, 'not_found', 'unknown_actor');
    return { actorId };
  }
}

// -----------------------------------------------------------------------------
// orgs.*  -- tier 3
// -----------------------------------------------------------------------------

export class OrgsApi {
  private readonly fl: Core;
  private readonly ids: Identities;

  constructor(fl: Core) {
    this.fl = fl;
    this.ids = new Identities(fl);
  }

  /**
   * Create a tenant with its first owner. Idempotent.
   *
   * The owner is created WITH the org for the same reason `createOrg` does it:
   * there is never a memberless org for someone to walk into.
   */
  async create(externalId: string, opts: { name?: string; owner: string }): Promise<{ id: string }> {
    const ownerActorId = await this.ids.actor(opts.owner);
    const id = await this.ids.org(externalId, {
      ...(opts.name ? { name: opts.name } : {}),
      ownerActorId,
    });
    return { id };
  }

  /**
   * Add or change a member's role.
   *
   * `as` is REQUIRED and is not defaulted. Membership is the privilege that
   * confers every other privilege; there is no convenience worth an unauthorized
   * path to it. This is the one place where the tiered API is deliberately no
   * shorter than the full API.
   */
  async setRole(
    org: string,
    user: string,
    role: OrgRole,
    opts: { as: string },
  ): Promise<void> {
    const { orgId, actorId, principal } = await this.trio(org, user, opts.as);
    await this.fl.addMember(principal, orgId, actorId, role);
  }

  async removeMember(org: string, user: string, opts: { as: string }): Promise<void> {
    const { orgId, actorId, principal } = await this.trio(org, user, opts.as);
    await this.fl.removeMember(principal, orgId, actorId);
  }

  /** Audit trail for a tenant. Requires `read_audit`, i.e. admin or owner. */
  async audit(
    org: string,
    opts: { as: string; decision?: 'allow' | 'deny'; limit?: number },
  ) {
    const orgId = await this.requireOrg(org);
    const principal = await this.requirePrincipal(opts.as);
    return this.fl.auditLog(principal, orgId, {
      ...(opts.decision ? { decision: opts.decision } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
  }

  async verifyAudit(org: string, opts: { as: string }) {
    const orgId = await this.requireOrg(org);
    return this.fl.verifyAuditChain(await this.requirePrincipal(opts.as), orgId);
  }

  private async trio(org: string, user: string, as: string) {
    const orgId = await this.requireOrg(org);
    const actorId = await this.ids.actor(user); // the TARGET may be new
    const principal = await this.requirePrincipal(as); // the CALLER may not
    return { orgId, actorId, principal };
  }

  private async requireOrg(externalId: string): Promise<string> {
    const { rows } = await this.fl.store.db.query<{ id: string }>(
      `SELECT o.id FROM org o
         JOIN project p ON p.id = o.project_id
        WHERE o.external_id = $1
          AND o.project_id = $2
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL`,
      [externalId, this.fl.projectId ?? DEFAULT_PROJECT_ID],
    );
    if (!rows[0]) throw new FilelayerError(404, 'not_found', 'unknown_org');
    return rows[0].id;
  }

  private async requirePrincipal(as: string): Promise<Principal> {
    const actorId = await this.ids.findActor(as);
    if (!actorId) throw new FilelayerError(404, 'not_found', 'unknown_actor');
    return { actorId };
  }
}

// -----------------------------------------------------------------------------
// shares.*  -- tier 4, expressed in external ids
// -----------------------------------------------------------------------------

export interface ShareOptions extends AsOption {
  as: string;
  expiresIn?: number;
  maxDownloads?: number;
  password?: string;
  /** Share with a named user instead of minting a link. */
  withUser?: string;
  /**
   * Share with EVERY MEMBER of an organization -- your own tenant id for it,
   * the same string you pass as `org:` to `files.put`. May name a DIFFERENT org
   * from the file's own ("the company that posted this job may read this CV");
   * it must be an org in the same project.
   *
   * Resolution is a join against membership, evaluated per request: add or
   * remove a member and their access changes on the very next call, with no
   * grant row touched. Nothing is fanned out.
   */
  withOrg?: string;
  /**
   * With `withOrg`, narrows the grant to members at this role or above --
   * `shares.create(id, { as, withOrg: 'acme', minRole: 'admin' })` is "admins
   * of acme only". Omit it and every member matches, at any role.
   *
   * The four roles are the existing `viewer | member | admin | owner`. There
   * are no custom roles: this is a floor over that enum, nothing more.
   */
  minRole?: OrgRole;
  capabilities?: Capability[];
}

export class SharesApi {
  private readonly fl: Core;
  private readonly ids: Identities;

  constructor(fl: Core) {
    this.fl = fl;
    this.ids = new Identities(fl);
  }

  async create(fileId: string, opts: ShareOptions) {
    const actorId = await this.ids.findActor(opts.as);
    if (!actorId) throw new FilelayerError(404, 'not_found', 'unknown_actor');
    if (opts.withUser && opts.withOrg) {
      throw new FilelayerError(400, 'ambiguous_subject', 'withUser_and_withOrg');
    }
    if (opts.minRole && !opts.withOrg) {
      throw new FilelayerError(400, 'ambiguous_subject', 'minRole_without_withOrg');
    }
    const subject: ShareSubject = opts.withUser
      ? { type: 'actor', actorId: await this.ids.actor(opts.withUser) }
      : opts.withOrg
        ? // The subject org must ALREADY exist. `withOrg` is not a
          // get-or-create: auto-provisioning a tenant here would mean a typo in
          // an org name silently mints a grant to an empty organization that
          // anybody could later be added to, which is a permission granted to a
          // population nobody has audited. Unknown org is 404, like `as:`.
          opts.minRole
          ? { type: 'role', orgId: await this.requireOrgId(opts.withOrg), minRole: opts.minRole }
          : { type: 'org', orgId: await this.requireOrgId(opts.withOrg) }
        : { type: 'link' };
    return this.fl.share({ actorId }, fileId, {
      subject,
      ...(opts.capabilities ? { capabilities: opts.capabilities } : {}),
      ...(opts.expiresIn !== undefined ? { expiresIn: opts.expiresIn } : {}),
      ...(opts.maxDownloads !== undefined ? { maxDownloads: opts.maxDownloads } : {}),
      ...(opts.password !== undefined ? { password: opts.password } : {}),
    });
  }

  async revoke(grantId: string, opts: { as: string }) {
    const actorId = await this.ids.findActor(opts.as);
    if (!actorId) throw new FilelayerError(404, 'not_found', 'unknown_actor');
    return this.fl.revoke({ actorId }, grantId);
  }

  async list(fileId: string, opts: { as: string }) {
    const actorId = await this.ids.findActor(opts.as);
    if (!actorId) throw new FilelayerError(404, 'not_found', 'unknown_actor');
    return this.fl.listGrants({ actorId }, fileId);
  }

  /** Redeem a share link. No identity required -- the secret is the credential. */
  async redeem(secret: string, opts: { password?: string; ip?: string } = {}) {
    return this.fl.redeem(secret, opts);
  }

  /**
   * External org id -> internal id, within this project. Read-only and
   * fail-closed, exactly like `Identities.findActor`.
   */
  private async requireOrgId(externalId: string): Promise<string> {
    const { rows } = await this.fl.store.db.query<{ id: string }>(
      `SELECT o.id FROM org o
         JOIN project p ON p.id = o.project_id
        WHERE o.external_id = $1
          AND o.project_id = $2
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL`,
      [externalId, this.fl.projectId ?? DEFAULT_PROJECT_ID],
    );
    if (!rows[0]) throw new FilelayerError(404, 'not_found', 'unknown_org');
    return rows[0].id;
  }
}
