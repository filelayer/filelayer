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
  type FileListPage,
  type FileRecord,
  type ShareResult,
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
  async org(
    externalId: string,
    opts: { name?: string; ownerActorId?: string } = {},
  ): Promise<{ id: string; created: boolean }> {
    // `xmax = 0` is true only on the INSERT arm of an upsert, which is the one
    // bit this function was missing. Without it there is no way to tell "I made
    // this tenant" from "this tenant already belonged to someone", and the
    // caller below bootstrapped an OWNER either way.
    const { rows } = await this.fl.store.db.query<{ id: string; created: boolean }>(
      `INSERT INTO org (project_id, external_id, name) VALUES ($3, $1, $2)
         ON CONFLICT (project_id, external_id) DO UPDATE SET external_id = EXCLUDED.external_id
       RETURNING id, (xmax = 0) AS created`,
      [externalId, opts.name ?? externalId, this.project],
    );
    const { id, created } = rows[0]!;
    // ONLY ON CREATION. Bootstrapping an owner into an org that already existed
    // is how `orgs.create('acme', { owner: 'mallory' })` handed an outsider the
    // keys to someone else's tenant -- private files, the audit log, and the
    // power to evict the real owner -- with no principal and no authorization.
    // Found 2026-10-02 by adversarial review. P2 of this file already said it:
    // auto-provisioning creates IDENTITIES, never PERMISSIONS.
    if (opts.ownerActorId && created) {
      await this.membership(id, opts.ownerActorId, 'owner', true);
    }
    return { id, created };
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
      throw new FilelayerError('not_found', 'deleted_actor');
    }
    return row.id;
  }

  /** Read-only lookup. Returns null for an unknown id -- callers must fail closed. */
  /**
   * An org's internal id, or null. LOOKUP ONLY: it never creates one, which is
   * what separates it from `org()` above.
   */
  async findOrg(externalId: string): Promise<string | null> {
    const { rows } = await this.fl.store.db.query<{ id: string }>(
      `SELECT o.id FROM org o
         JOIN project p ON p.id = o.project_id
        WHERE o.external_id = $1
          AND o.project_id = $2
          AND o.deleted_at IS NULL
          AND p.deleted_at IS NULL`,
      [externalId, this.project],
    );
    return rows[0]?.id ?? null;
  }

  /**
   * The same, but a miss DENIES AND IS RECORDED.
   *
   * Two classes carried an identical copy of this query and of the audit write
   * beside it, under two different method names -- `requireOrg` and
   * `requireOrgId` -- which is how a duplication survives a search for one.
   * One copy is one place to get the project scoping wrong.
   */
  async requireOrg(externalId: string): Promise<string> {
    const id = await this.findOrg(externalId);
    if (id) return id;
    // See `resolveActorOrDeny`: an org-name sweep was equally invisible, and
    // the org cannot be charged for the event because the org is what could
    // not be resolved.
    await this.fl.store.audit({
      orgId: null,
      action: 'org.access',
      decision: 'deny',
      reason: 'unknown_org',
      actorId: null,
      fileId: null,
      context: { org: String(externalId).slice(0, 128) },
    });
    throw new FilelayerError('not_found', 'unknown_org');
  }

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
    const resolved = isDefaultWorkspace
      ? await this.ids.org(DEFAULT_WORKSPACE, { name: 'workspace', ownerActorId: system })
      : await this.ids.org(opts.org!);
    const orgId = resolved.id;

    // Resolve the owner. `owner:` auto-registers, because the developer is
    // asserting the identity exists in their system; we are not inventing it.
    let ownerId: string;
    if (opts.owner !== undefined) {
      ownerId = await this.ids.actor(opts.owner);
      // JOINING IS NOT THE SAME AS BEING REGISTERED.
      //
      // In the DEFAULT workspace, auto-join is the design: a tier-1/tier-2
      // application has one implicit tenant and every user belongs to it.
      //
      // In a NAMED org it was a hole. `put({ org: 'acme', owner: 'mallory' })`
      // -- one byte into somebody else's tenant -- added mallory as a `member`
      // of acme with no authorization, which is read access to every
      // `visibility: 'org'` file in it and a listing of the tenant's documents.
      // `addMember`, the verbose equivalent, denies that exact call. Found
      // 2026-10-02 by adversarial review.
      //
      // Creating the tenant with this call still joins you to it, because then
      // there is nobody whose tenant it was.
      const mayJoin =
        isDefaultWorkspace ||
        resolved.created ||
        (await this.fl.store.getMembership(orgId, ownerId)) !== null;
      if (!mayJoin) {
        throw new FilelayerError('forbidden', 'no_membership');
      }
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
    // DELEGATES NOW, and used to carry its own loop. The loop was correct and
    // it was the only place in the library that knew "stop this access" means
    // revoking every grant that grants it, rather than one row. That knowledge
    // belonged in the engine; keeping it here is why the named-user case went
    // without it for eight releases. See `Filelayer.revokeFor`.
    const { revoked } = await this.fl.revokeFor(principal, fileId, { type: 'anonymous' });
    return { revoked: revoked.length };
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
   * "Which files may this caller see?", keyed on YOUR identifiers.
   *
   * -------------------------------------------------------------------------
   * WHY THIS METHOD EXISTS
   * -------------------------------------------------------------------------
   *
   * It did not, and its absence was the most expensive hole in this facade.
   * The core `fl.listFiles(principal, orgId, …)` takes an INTERNAL actor uuid
   * and an INTERNAL org uuid, while every other call a developer makes takes
   * their own string ids. So a listing screen -- the single most ordinary
   * screen in a file product -- was the one feature that forced you out of
   * this facade and into managing Filelayer's internal identifiers yourself.
   *
   * Three separate agents given an integration task hit it and worked around
   * it the same way: keep a `Map` from your user id to an internal one, and
   * harvest the values out of `FileRecord.ownerId` and
   * `GrantSummary.subjectId`, because those are the only two places the
   * public API lets them escape. One of them observed the consequence
   * precisely: a listing is then **impossible for any identity the library
   * auto-provisioned**, because there is no call that recovers its id.
   *
   * That is what this method removes. `fl.ids` (see `IdsApi`) exists for the
   * cases that genuinely need the internal value, so the escape hatch is a
   * documented method rather than a trick with two other calls.
   *
   * `org` defaults to the workspace, so tier 1 and tier 2 never name one.
   */
  async list(
    opts: AsOption & {
      /** Your own tenant id. Defaults to the workspace. Must already exist. */
      org?: string;
      /** Which capability the caller must hold. Default `read`. */
      capability?: Capability;
      limit?: number;
      cursor?: string | null;
    } = {},
  ): Promise<FileListPage> {
    const principal = await this.principal(opts);
    // `requireOrg`, not `org()`: a listing must not CREATE a tenant as a side
    // effect of somebody mistyping one. The miss denies, and is recorded.
    const orgId = await this.ids.requireOrg(opts.org ?? DEFAULT_WORKSPACE);
    return this.fl.listFiles(principal, orgId, {
      ...(opts.capability ? { capability: opts.capability } : {}),
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    });
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
    const actorId = await resolveActorOrDeny(this.fl, this.ids, opts.as, 'file.access');
    return { actorId };
  }
}

/**
 * Resolve an external `as:` to an internal actor id, or DENY AND RECORD IT.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 *
 * Six places in this file did `findActor()` and threw `404 unknown_actor` when
 * it came back null. The status was right and the refusal was right. What was
 * missing is that the throw happened BEFORE the engine ran, so **no audit event
 * was written** -- while the same refusal on the core API writes one.
 *
 * Measured on the published `0.11.0`:
 *
 *     facade, unknown external id  -> 404 unknown_actor   deny events 0 -> 0
 *     core, well-formed actor uuid -> 404 no_membership   deny events 0 -> 1
 *
 * `schema.sql` is explicit that this is a defect, in a comment on the very
 * column that makes the fix possible. It explains that `audit_event.actor_id`
 * carries NO foreign key precisely so that "a caller presenting a WELL-FORMED
 * BUT UNREGISTERED actor id" is still recorded, and calls the alternative "a
 * serious defect in two directions at once". The engine was changed to honour
 * that. The facade -- the API everybody actually uses -- reopened the same hole
 * one level up, for EXTERNAL ids, which is the id space an attacker sweeps
 * because it is the one they can guess.
 *
 * So an actor-id sweep against a known file id left nothing an administrator
 * could read, on the surface where it was easiest to mount.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EVENT LOOKS THE WAY IT DOES
 * ---------------------------------------------------------------------------
 *
 *  - **The system chain** (`orgId: null`). No tenant can be confirmed: we have
 *    a file id at most, and resolving it to an org before authorizing anybody
 *    would be a tenant oracle. `authorizeOrg` already routes an unconfirmable
 *    org here for the same reason.
 *  - **`reason: 'unknown_actor'` is kept.** Returning a random uuid and letting
 *    the engine audit it would also have recorded the attempt, and would have
 *    recorded it as `no_membership` -- losing the one fact that matters, which
 *    is that the id does not exist.
 *  - **The presented id goes in `context.as`**, because "which ids were tried"
 *    is the whole value of the record. It is the caller's own id space, the
 *    same treatment `rawFileId` already gets on the NUL-probe path.
 *  - **Outside a transaction.** It is a lone deny event with no mutation to be
 *    atomic with; `audit_append()` holds its own advisory lock. `upload()`
 *    documents this exact case.
 *  - **The response is unchanged**: still an opaque `404 not_found`.
 */
async function resolveActorOrDeny(
  fl: Core,
  ids: Identities,
  as: string,
  action: string,
  fileId: string | null = null,
): Promise<string> {
  const actorId = await ids.findActor(as);
  if (actorId) return actorId;
  await fl.store.audit({
    orgId: null,
    action,
    decision: 'deny',
    reason: 'unknown_actor',
    actorId: null,
    fileId,
    context: { as: String(as).slice(0, 128) },
  });
  throw new FilelayerError('not_found', 'unknown_actor');
}

/**
 * ids.* -- YOUR identifiers to Filelayer's, and back.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS PUBLIC NOW
 * ---------------------------------------------------------------------------
 *
 * Everything in `fl.files`, `fl.orgs` and `fl.shares` speaks your id space.
 * The core API speaks internal uuids. Until `0.13.0` there was no bridge, and
 * `docs/QUICKSTART.md` said so in one line about one method -- while the gap
 * actually bit on two others, including mounting the library's own HTTP route
 * for authenticated reads, which simply could not be done without one.
 *
 * Measured rather than assumed: four integration tasks were given to agents
 * holding only the published tarball, and three of them hit this and invented
 * the same workaround -- a `Map`, filled by harvesting ids out of
 * `FileRecord.ownerId` and `GrantSummary.subjectId`, the only two places the
 * public API let an internal id escape. One noted the consequence exactly: an
 * identity the library auto-provisioned has an id that **cannot be recovered
 * at all**.
 *
 * ---------------------------------------------------------------------------
 * IT IS NOT A SECURITY BOUNDARY, AND NEVER WAS
 * ---------------------------------------------------------------------------
 *
 * Withholding it protected nothing. These are in-process calls in your own
 * application, resolving ids YOU chose, in a database you own. The internal
 * uuid is not a credential: P2 says it is not an input to any decision, which
 * is the same reason a file id is safe to put in a URL. What stops a caller
 * reading somebody else's file is `authorize()`, not the obscurity of a
 * primary key.
 *
 * What it DID protect against is a developer wiring their own SQL around the
 * engine. That risk is unchanged and is answered where it belongs: in the
 * warning that queries you write yourself run no authorization and write no
 * audit event.
 *
 * PREFER NOT TO NEED IT. `fl.files.list()` and the `{ as }` form of
 * `deliveryHandler`'s principal both landed in `0.13.0` precisely so the
 * common cases do not.
 */
export class IdsApi {
  private readonly ids: Identities;

  constructor(fl: Core) {
    this.ids = new Identities(fl);
  }

  /**
   * Your user id -> internal actor id, or **null** if this project has never
   * seen it. Lookup only: it creates nothing.
   */
  async actorId(externalId: string): Promise<string | null> {
    return this.ids.findActor(externalId);
  }

  /** Your tenant id -> internal org id, or null. Lookup only. */
  async orgId(externalId: string): Promise<string | null> {
    return this.ids.findOrg(externalId);
  }

  /**
   * Your user id -> internal actor id, CREATING the identity if this project
   * has not seen it.
   *
   * Separate from `actorId()` and named for what it does, because "resolve"
   * and "provision" are different operations and a method that silently did
   * both would be the wrong default for a read path. It creates an identity
   * and no permission: a bare actor row grants nothing anywhere.
   *
   * Idempotent -- it is an upsert. `Filelayer.createActor()` on the core API is
   * a bare insert and throws on a second call, which is why that method is the
   * wrong one to build an id cache on.
   */
  async ensureActor(externalId: string): Promise<string> {
    return this.ids.actor(externalId);
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
   * Create a tenant with its first owner.
   *
   * The owner is created WITH the org for the same reason `createOrg` does it:
   * there is never a memberless org for someone to walk into.
   *
   * IDEMPOTENT FOR A RETRY, AND ONLY FOR A RETRY. Calling this again with the
   * same owner returns the same tenant, so a client that retries a timed-out
   * request is safe. Calling it with a DIFFERENT owner is refused.
   *
   * Until 0.6.0 it was idempotent in the dangerous direction: the second call
   * returned the existing tenant and bootstrapped the named identity as an
   * OWNER of it. Since the method is documented as idempotent, the natural way
   * to use it is on every signup -- so any caller who controlled the tenant slug
   * became owner of an existing tenant, read its private files, read its audit
   * log, and could evict the real owner. `Filelayer.createOrg` refused the same
   * call with a unique violation; the facade was more permissive than the engine
   * it wraps, which is the one thing a facade must never be.
   *
   * It worked on the implicit single-tenant workspace too, so a tier-2
   * application that had never heard the word "org" was equally exposed.
   */
  async create(externalId: string, opts: { name?: string; owner: string }): Promise<{ id: string }> {
    const ownerActorId = await this.ids.actor(opts.owner);
    const { id, created } = await this.ids.org(externalId, {
      ...(opts.name ? { name: opts.name } : {}),
      ownerActorId,
    });

    if (!created) {
      // The retry case: the caller is already the owner, so this is the same
      // request arriving twice and the answer is the same id. Anything else is
      // somebody asking for standing in a tenant that is not theirs.
      const role = await this.fl.store.getMembership(id, ownerActorId);
      if (role !== 'owner') {
        throw new FilelayerError('org_exists', 'not_owner');
      }
    }
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
      // `opts.limit ? ...` is a TRUTHINESS test, so `limit: 0` was discarded and
      // the caller got the default page instead of nothing. The verbose
      // `fl.auditLog` handles 0 correctly, which made the two documented
      // surfaces disagree about the same argument on the same data.
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
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
    return this.ids.requireOrg(externalId);
  }

  private async requirePrincipal(as: string): Promise<Principal> {
    const actorId = await resolveActorOrDeny(this.fl, this.ids, as, 'org.access');
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

  /**
   * A share with neither `withUser` nor `withOrg` is a LINK, and a link always
   * carries a secret -- so this overload says so, and `redeem(share.secret)`
   * typechecks without a non-null assertion.
   *
   * WHY THIS IS A TYPE FIX AND NOT A DOCUMENTATION FIX. `ShareResult.secret` is
   * optional because an `actor`, `org` or `role` grant has nothing to hand out:
   * the subject is already identified. But the link case is the one the
   * quickstart and the homepage lead with, and there `secret` is always present.
   * Leaving it optional for that call meant the shortest correct version of our
   * own headline example needed a `!`, which reads as the library's types being
   * wrong about the library. Found by audit, 2026-09-29, as a website sample
   * that does not compile under `--strict`.
   */
  async create(
    fileId: string,
    opts: ShareOptions & { withUser?: undefined; withOrg?: undefined },
  ): Promise<ShareResult & { secret: string }>;
  async create(fileId: string, opts: ShareOptions): Promise<ShareResult>;
  async create(fileId: string, opts: ShareOptions): Promise<ShareResult> {
    const actorId = await resolveActorOrDeny(this.fl, this.ids, opts.as, 'grant.create', fileId);
    if (opts.withUser && opts.withOrg) {
      throw new FilelayerError('ambiguous_subject', 'withUser_and_withOrg');
    }
    if (opts.minRole && !opts.withOrg) {
      throw new FilelayerError('ambiguous_subject', 'minRole_without_withOrg');
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

  /**
   * Revoke ONE grant, by the id `create()` returned.
   *
   * Correct, and usually not what you want. A grant id is not a person's
   * access: `create()` is not idempotent, so two calls for the same file and
   * the same recipient leave two live grants, and revoking the id you were
   * handed last leaves the other one working while telling you it succeeded.
   *
   * Use `unshare()` to remove a named user's access. Use this when you are
   * revoking a specific share link whose secret you handed out.
   */
  async revoke(grantId: string, opts: { as: string }) {
    const actorId = await resolveActorOrDeny(this.fl, this.ids, opts.as, 'grant.revoke');
    return this.fl.revoke({ actorId }, grantId);
  }

  /**
   * STOP SHARING THIS FILE WITH THIS USER. Every live grant naming them, in one
   * transaction, however many `create()` calls produced them.
   *
   * This is the operation a share endpoint needs and the one that was missing.
   * See `Filelayer.revokeFor` for what its absence cost and how it was found.
   *
   * Idempotent: unsharing from somebody who already cannot read it returns
   * `{ revoked: 0 }` rather than failing, so a retried unshare is safe.
   *
   * An unknown `user` is `{ revoked: 0 }` too, and deliberately not a 404 --
   * "make sure this person cannot read it" is satisfied by their not existing,
   * and answering 404 would turn this into an identity oracle.
   */
  async unshare(
    fileId: string,
    opts: { as: string; user: string },
  ): Promise<{ revoked: number }> {
    const actorId = await resolveActorOrDeny(this.fl, this.ids, opts.as, 'grant.revoke', fileId);
    const target = await this.ids.findActor(opts.user);
    if (!target) return { revoked: 0 };
    const { revoked } = await this.fl.revokeFor({ actorId }, fileId, {
      type: 'actor',
      actorId: target,
    });
    return { revoked: revoked.length };
  }

  async list(fileId: string, opts: { as: string }) {
    const actorId = await resolveActorOrDeny(this.fl, this.ids, opts.as, 'grant.list', fileId);
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
    return this.ids.requireOrg(externalId);
  }
}
