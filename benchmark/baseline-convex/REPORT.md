# Baseline 2 — Convex (+ the Cloudflare R2 component)

**Scenario:** Vault (fixed; see benchmark brief).

> ## ⚠️ STATUS: WRITTEN TO SPEC. NOT EXECUTED.
>
> This baseline was **not run**. It requires a live Convex deployment and a
> Cloudflare R2 bucket, neither of which is available in this environment. No
> test in this directory has ever passed, because there are none. Every claim
> below is derived from Convex's published documentation (cited inline) and
> from reading the `@convex-dev/r2` component's source README — not from
> observed behaviour.
>
> Treat every number here as **lower-confidence than the Supabase baseline**,
> which is executable and has 28 passing tests. Where the two reports disagree
> in rigour, that is why.
>
> `npm run loc` does run, and reproduces the line counts.

---

## Documented best practice followed

| Decision | Source |
|---|---|
| Upload via `storage.generateUploadUrl()`, 3 client round-trips; the mutation controls who may upload | [Uploading and Storing Files](https://docs.convex.dev/file-storage/upload-files) |
| `storage.getUrl()` produces a bearer URL; "anyone with the URL can access the file"; "the only way to revoke a file URL is by deleting the file" | [File Storage overview](https://docs.convex.dev/file-storage/overview) |
| For per-request authorization, serve from an HTTP action; responses capped at 20MB | [Serving Files](https://docs.convex.dev/file-storage/serve-files#serving-files-from-http-actions), [HTTP Actions limits](https://docs.convex.dev/functions/http-actions#limits) |
| **"If you need file URLs that automatically expire after some time, consider the Cloudflare R2 component."** (stated twice) | [overview](https://docs.convex.dev/file-storage/overview), [serve-files](https://docs.convex.dev/file-storage/serve-files) |
| R2 component: install via `app.use(r2)`, five env vars, bucket CORS policy, scoped API token; `r2.getUrl(key, {expiresIn})`; custom keys need your own mutation | [Cloudflare R2 component](https://www.convex.dev/components/cloudflare-r2), [README](https://github.com/get-convex/r2#readme) |
| Auth in functions via `ctx.auth.getUserIdentity()`; in HTTP actions via `Authorization: Bearer` | [Auth in Functions](https://docs.convex.dev/auth/functions-auth) |
| `internalQuery` / `internalMutation` are not client-callable | [Internal Functions](https://docs.convex.dev/functions/internal-functions) |
| Indexes declared in schema; must step through fields in index order | [Indexes](https://docs.convex.dev/database/reading-data/indexes) |
| **"Fine-grained permissions: No"** — on every plan including Professional | [Pricing, Advanced Features](https://www.convex.dev/pricing) |
| Deletion via `storage.delete(storageId)` | [Deleting Files](https://docs.convex.dev/file-storage/delete-files) |

**Which route did the docs steer us to?** Unambiguously to R2. The scenario
requires share links with an expiry, and the File Storage overview page tells
you in so many words to use the R2 component when you need expiring URLs.
`convex/variantA_convexFileStorage.ts` implements the pure-Convex alternative
and enumerates exactly which of the seven scenario requirements it cannot meet.

**One documented deviation, made in Convex's favour.** The docs' HTTP-action
example returns `new Response(blob)`, which caps a download at 20MB. A B2B
document workspace cannot ship that, so after authenticating, `http.ts` issues a
302 to a 30-second R2 presigned URL. This synthesises the two things the docs
recommend separately; no single page describes it. It is the strongest
implementation available on this stack, which is why it is the one built.

---

## Architecture as built

```
Browser --JWT--> Convex query/mutation  (auth checked by hand, per function)
        --JWT--> convex.site/download  (HTTP action: authN, authZ, audit)
                       +--302--> Cloudflare R2 presigned URL (30s, SigV4)
        -------> convex.site/s/<token> (HTTP action: revoked/expiry/pw/cap)
                       +--302--> Cloudflare R2 presigned URL (30s, SigV4)
```

R2 object key: `${orgId}/${documentId}/${filename}`. Nothing parses the key for
authorization — authorization is always by document id — which is slightly
safer than the Supabase baseline's path-segment checks, and correspondingly
means the key must never reach a client.

---

## The twelve metrics

### 1. Implementation time

| | |
|---|---|
| Agent wall-clock, research → complete written spec | **≈ 35 minutes** (≈10 min doc research, ≈25 min writing) |
| Estimated competent-developer equivalent, first time on this stack | **2.5–4 days** |
| Estimated competent-developer equivalent, has shipped Convex before | **1.5–2 days** |

Two honest caveats that pull in opposite directions.

*Understated:* the agent time excludes everything you cannot skip in reality —
creating a Cloudflare account, provisioning an R2 bucket, getting the bucket
CORS policy right (a notorious time sink), minting a scoped API token, and
plumbing five environment variables into a Convex deployment. Add half a day
for a first-timer. It also excludes debugging, because nothing was run. The
Supabase baseline spent ≈15 minutes of its 55 on a bug that only appeared at
runtime; there is no reason to think this codebase has fewer.

*Overstated:* writing Convex is fast. It is one language, one mental model, and
the type system carries a lot. The per-function authorization checks are
mechanical once `model/auth.ts` exists. There is no equivalent of learning
RLS's evaluation order.

### 2. Application LOC

**Counting method** — identical rules to the Supabase baseline so the numbers
are comparable. Reproduce with `npm run loc`.

- **APPLICATION** = code a developer building Vault on Convex must write and own.
- **COMPARISON / TOOLING** = `variantA_convexFileStorage.ts` and `tools/loc.js`,
  which exist only for this benchmark. **Excluded.**
- **GROSS** = every line, blanks and comments included. **NET** = minus blanks
  and comment-only lines.

There is no "PLATFORM (not counted)" group here, unlike the Supabase baseline.
Convex ships its platform as a hosted service plus a hosted component, so
nothing had to be reimplemented locally to make the code readable. The flip
side is that nothing could be executed either.

| File | Gross | Net |
|---|---:|---:|
| `convex/schema.ts` | 101 | 74 |
| `convex/convex.config.ts` | 10 | 5 |
| `convex/auth.config.ts` | 11 | 8 |
| `convex/model/auth.ts` — the whole authorization model | 130 | 81 |
| `convex/model/audit.ts` | 140 | 92 |
| `convex/r2.ts` | 127 | 57 |
| `convex/documents.ts` | 119 | 85 |
| `convex/members.ts` | 130 | 98 |
| `convex/shares.ts` | 256 | 193 |
| `convex/audit.ts` | 66 | 38 |
| `convex/http.ts` | 177 | 110 |
| **APPLICATION TOTAL** | **1267** | **841** |

**Comparison caveat, stated so nobody over-reads it.** Supabase came in at
564 net; Convex at 841, i.e. ~49% more. Some of that gap is real (per-function
checks repeated 17 times; a hand-rolled SHA-256 wrapper and PBKDF2 that
Postgres provides as builtins) and some is presentational: SQL DDL is denser
than TypeScript with validators and type annotations. A fair reading is
"meaningfully more code, not 1.5× more work."

### 3. Security-sensitive decisions

Same definition as the Supabase report: *a wrong choice creates a data leak
**and** the system will not tell you.*

The shape of this list is completely different from Supabase's, and that
difference is the finding. Supabase's cluster is 8 policies in one file that a
reviewer reads once. Convex's is **one decision per exported function**, spread
across six files, repeated forever as the codebase grows.

**Per-endpoint authorization — 17 instances of the same decision (17)**

There are 15 exported `query`/`mutation` functions plus 2 HTTP routes. Every one
is a public endpoint reachable by anyone who knows the deployment URL.

1–15. Each exported function must call `requireUser` (and usually `requireRole`
or `loadReadableDocument`) as its first act. **A public `query` with no
`ctx.auth.getUserIdentity()` check is world-readable to unauthenticated
callers.** It compiles, it type-checks, it passes a functional test written by
a logged-in developer, and it leaks. This is the single most important entry in
either report.

16. `/download` — `getUserIdentity()` returns `null` rather than throwing when
    unauthenticated. Forgetting the null branch makes the endpoint anonymous.
17. `/s/<token>` — deliberately unauthenticated, so every guard in it is
    load-bearing and there is no backstop whatsoever.

**Unscoped `ctx.db.get` — IDOR by default (4)**

18. `ctx.db.get(documentId)` returns **any** document by id, from any org. There
    is no tenant scoping in the database. Every one of the ~8 call sites must
    re-derive the org and check membership; `loadReadableDocument` exists to
    centralise this, and using `ctx.db.get` directly instead is a one-line
    cross-tenant read.
19. `shares.revoke` — same problem for `shareLinks`. Without the explicit
    `roleInOrg` check, any user revokes any link in any org.
20. `r2.finishUpload` — must verify `doc.uploaderId === user._id`; otherwise a
    user in org B finalises and audits into org A's document.
21. Not returning `r2Key` to clients. `documents.get` strips it. Leaking a key
    plus any function that presigns by key is a full cross-tenant read.

**Share-link handling (5)**

22. `shares.create` must take `orgId` **from the document**, never from an
    argument. Trusting a caller-supplied `orgId` lets a member of org A mint a
    link labelled A over a document in B.
23. `shares.listForDocument` must not return raw tokens for links the caller did
    not create, or "list shares" becomes "steal shares".
24. Password comparison must be constant-time (`constantTimeEqual`); `===` on
    hex strings is a timing oracle.
25. A failed password attempt must not consume a download.
26. Share-token entropy — the `/s/` endpoint is unauthenticated and the token is
    the only secret.

**Audit (3)**

27. `appendAudit` must be reachable only from server code. It is a plain
    function plus `internalMutation` wrappers; making any of them a public
    `mutation` lets clients forge audit entries.
28. Audit read must check `admin`, not `member`.
29. Auditing **before** the redirect, not after, so a crash over-reports rather
    than under-reports.

**Configuration / infrastructure (4)**

30. The R2 bucket must not be publicly readable and must not have an `r2.dev`
    public URL enabled. The component README warns against `r2.dev` on
    performance grounds; the security consequence of a public bucket is not
    called out anywhere and is total.
31. Bucket CORS must not be `"*"`. The README offers `*` as a convenience with
    a "use with caution" note.
32. The R2 API token must be scoped to the one bucket with Object Read & Write,
    not account-wide.
33. `PRESIGNED_TTL_SEC` — this number *is* the revocation SLA.

**Total: 33 silent-failure decisions**, but the honest summary is not the
count. It is that **17 of them are the same decision made 17 times, and there
will be an 18th next sprint.** Supabase's 27 are mostly one-time authoring
decisions in a file that is reviewed as a unit; Convex's grow linearly with the
number of endpoints, forever.

**Credited to Convex as safe by default:**

- `internalQuery` / `internalMutation` are genuinely unreachable from clients.
  A clean, enforced public/private boundary with no way to get it wrong by
  accident.
- Argument validators (`v.id("documents")`, `v.union(v.literal(...))`) reject
  malformed and wrong-typed input at the boundary automatically.
- `Id<"orgs">` and `Id<"documents">` are distinct TypeScript types. Passing one
  where the other is expected is a **compile error**. This eliminates a real
  class of confused-deputy bug that RLS does nothing about, and it deserves
  credit.
- Roles are read from the database on every call, so demotion and removal take
  effect immediately. No JWT-claim staleness window — strictly better than the
  pattern Supabase's own RBAC guide recommends.

### 4. Infrastructure / configuration decisions

16, across **two vendors**:

*Convex (7):* deployment + environment; identity provider wiring
(`auth.config.ts`); `app.use(r2)` in `convex.config.ts`; `CLIENT_ORIGIN` for
CORS; `PUBLIC_APP_ORIGIN` for share URLs; index definitions in `schema.ts`
(and awareness that `npx convex deploy` **deletes** indexes absent from the
schema); backup/retention policy.

*Cloudflare (7):* account; R2 bucket; **bucket CORS policy**; scoped API token
with Object Read & Write; the five `R2_*` env vars; optional custom domain for
CDN caching (without it you are on the rate-limited, uncached `r2.dev`, which
the README says not to use in production); bucket lifecycle/retention.

*Cross-cutting (2):* `PRESIGNED_TTL_SEC`; rate limiting on the unauthenticated
`/s/` endpoint — Convex ships no rate limiter, so this is another component to
add and operate.

### 5. Number of components the developer must operate

**Five things, two vendors, two consoles, two bills.**

Convex database · Convex functions/HTTP actions · the `@convex-dev/r2`
component · Cloudflare R2 · an identity provider (Clerk/Auth0/WorkOS).

This is the clearest quantitative loss against Supabase, which needed four
services from **one** vendor. The second vendor brings its own console, its own
credential rotation, its own status page, its own CORS model, its own outage
surface, and a key-exchange between the two that has to be re-done for every
environment (dev, preview, prod). Convex preview deployments make this worse,
not better: each one needs R2 credentials.

It is fair to note the counterweight: if you take Variant A (pure Convex File
Storage), you are back to **two** components and one vendor — but you lose
expiring URLs, passwords, download caps and revocation entirely. The
five-component count is the price of the scenario, not of Convex in general.

### 6. Edge cases requiring explicit handling

16 identified.

1. `startUpload` creates the row; client never PUTs → orphan `documents` row
   with an `r2Key` pointing at nothing
2. Client PUTs but never calls `finishUpload` → object exists, unaudited, and
   the component's metadata table is unsynced
3. Self-reported `sizeBytes` / `mimeType` are never verified against the object
4. Soft delete does **not** delete the R2 object (deleting it would be the only
   way to kill outstanding presigned URLs, but it is irreversible)
5. Presigned URL outstanding when a share link is revoked → residual window
6. Presigned URL outstanding when a member is removed from the org
7. `listForOrg` post-filters `deletedAt`, so it reads and bills for every
   soft-deleted row in the org forever; a dedicated index or hard delete is
   needed eventually
8. `verifyChain` reads the entire audit log in one query — hits Convex's
   per-query document-read limits on a busy org; needs checkpointing
9. Two concurrent redemptions of a link with one download left (handled for
   free by Convex's serializable mutations)
10. Failed password attempt must not consume a download
11. Brute force against `/s/` with an invalid token produces **no audit record
    at all**, because there is no org to attribute it to
12. Filename with `/`, `\`, `..` or control characters
13. Last-owner removal — handled, but requires an O(members) scan per removal
14. HTTP range requests / download managers: multiple GETs per "download"
15. R2 or Cloudflare unavailable while Convex is healthy — a partial outage the
    single-vendor baseline cannot have
16. Clock skew between Convex and R2 with a 30-second signature lifetime

### 7. Failure modes — open or closed

| # | Failure | Direction | Note |
|---|---|---|---|
| 1 | **Exported function missing its auth check** | **OPEN** | World-readable. The defining failure mode of this baseline. |
| 2 | **`ctx.db.get` used without an org check** | **OPEN** | Cross-tenant IDOR. The database offers no scoping. |
| 3 | **`getUserIdentity()` null branch omitted** | **OPEN** | Endpoint silently becomes anonymous. |
| 4 | **Presigned URL leaked/forwarded** | **OPEN until expiry** | SigV4; R2 never calls back to Convex. |
| 5 | **Convex File Storage URL leaked** (Variant A) | **OPEN forever** | Only revocation is deleting the file. |
| 6 | **R2 bucket made public / `r2.dev` enabled** | **OPEN** | Total, silent. |
| 7 | **Bucket CORS set to `*`** | **OPEN-ish** | Widens the browser attack surface; README suggests it. |
| 8 | Wrong `Id<"...">` type passed | **CLOSED** | Compile error. Genuinely good. |
| 9 | Malformed argument | **CLOSED** | Validator rejects at the boundary. |
| 10 | Function marked `internal` | **CLOSED** | Not client-reachable. Clean boundary. |
| 11 | Concurrent download-cap redemption | **CLOSED** | Serializable mutations. Correct by construction. |
| 12 | Audit append fails | **CLOSED** | Same transaction as the change it records; both roll back. |
| 13 | Convex unreachable | **CLOSED** | No reads. |
| 14 | R2 unreachable, Convex healthy | **CLOSED** | Redirect target 5xx. |
| 15 | `convex deploy` drops an index absent from schema | CLOSED (availability) | Queries fail loudly. |

Score: **8 closed, 7 open.** The critical asymmetry versus Supabase is not the
ratio, it is *which side the accidents land on.* On Supabase, forgetting
something fails closed and choosing wrongly fails open. **On Convex, forgetting
something fails open.** Items 1–3 are omissions, not decisions, and all three
leak silently. That is the wrong way round, and it is inherent to a model where
authorization is application code rather than a database property.

Convex's own pricing page is candid about this: **Fine-grained permissions —
No**, on every plan.

### 8. Lifecycle complexity

- **Upload is four client round-trips**: `startUpload` (mutation) → PUT to R2 →
  `syncMetadata` (component mutation) → `finishUpload` (mutation). Any of the
  last three can be skipped by a client that closes the tab, and the resulting
  states differ.
- **Three places hold state about one file**: your `documents` row, the R2
  component's metadata table, and the object in the bucket. Nothing reconciles
  them; drift is silent and needs a sweeper you write yourself.
- **Deletion is a dilemma, not a procedure.** Soft-delete closes the app-level
  path but leaves presigned URLs live. Hard-deleting the object kills the URLs
  but is irreversible and breaks legal-hold / undelete. There is no third
  option, because the only revocation primitive is destruction.
- **The audit chain is transactional and needs no locking** — a genuine
  simplification (see below) — but `verifyChain` does not scale without
  checkpointing.
- **Schema migrations**: indexes are declared in `schema.ts` and backfilled on
  deploy, with a `staged: true` escape hatch for large tables. This is *nicer*
  than SQL migration tooling. But `npx convex deploy` **deletes** indexes no
  longer in the schema, which is a sharp edge.
- **Two-vendor credential rotation** on every environment.

### 9. Revocation complexity — **the crux metric**

**Route 1 — pure Convex File Storage (the docs' primary path).**
Revocation is **impossible** except by destroying the file. This is not an
inference; it is stated twice in Convex's own documentation:

> "The only way to revoke a file URL is by deleting the file. ... If you still
> need to serve the file, upload it again and share the new URL only with
> authorized users."
> — [File Storage overview](https://docs.convex.dev/file-storage/overview)

The URL has **no expiry at all**. It is a permanent bearer credential. Against
the Vault requirement — *"revocation takes effect immediately even for links
already issued"* — this route fails outright, and it also fails on expiry,
password, download cap and audit-of-views. That is why it is Variant A and not
the implementation.

**Route 2 — R2 component (built here).**
`r2.getUrl(key, { expiresIn })` returns an **AWS SigV4 presigned URL**. R2
validates the signature and the clock. It performs no callback into Convex, so
it cannot consult a revocation flag. Structurally identical to a Supabase
signed URL.

Because the sharee only ever receives a `convex.site/s/<token>` URL, revocation
is **immediate for every future redemption** — `shares.revoke` flips
`revokedAt` and the HTTP action refuses. The residual window is
`PRESIGNED_TTL_SEC = 30` seconds for a URL already handed out.

**Where Convex is materially worse than Supabase on exactly this point.**

The Supabase baseline can drive that residual window to **zero** by renaming the
object (`storage.from(b).move(from, to)`): the path is inside the signed
payload, so the rename invalidates every outstanding token instantly, as a
server-side metadata operation.

The `@convex-dev/r2` component exposes `store`, `getUrl`, `deleteObject`,
`getMetadata`, `listMetadata`, `pageMetadata`, `generateUploadUrl` and
`syncMetadata`. **It exposes no move or copy.** So closing the window to zero
on Convex means one of:

| Option | Cost |
|---|---|
| `r2.deleteObject(key)` | Destroys the file for everyone. Undo is a re-upload. |
| Fetch bytes in an action, `r2.store()` under a new key, delete old | Pulls the entire file through a Convex action — bounded by action memory and runtime, so it simply does not work for large documents. |
| Drop to `@aws-sdk/client-s3` `CopyObjectCommand` in a `"use node"` action | Works, is O(1) server-side — but leaves the documented component path and means managing R2 credentials yourself in a second place. |
| Accept the 30s window | What this implementation does. |

**Summary of the crux metric:**

| | Supabase | Convex + R2 | Convex File Storage |
|---|---|---|---|
| Revocation of an already-issued storage URL | Not supported by the platform | Not supported by the platform | Not supported; **and no expiry either** |
| Immediate revocation via a gateway you build | Yes | Yes | Yes, but then you must serve bytes yourself (20MB cap) |
| Residual window | signed-URL TTL (30s as built) | presigned TTL (30s as built) | n/a — URL never expires |
| Can the window be closed to zero? | **Yes** — `move()`, server-side, with collateral | **Not on the documented path**; needs raw S3 SDK or file destruction | Only by deleting the file |

### 10. Sharing complexity — expiry + password + download cap

Nothing is provided by the platform; all three were built.

| Feature | Platform | Built | Exact? |
|---|---|---|---|
| Expiry | `r2.getUrl(key,{expiresIn})` gives *URL* expiry only | `expiresAt` on the link, checked in the HTTP action | Yes |
| Password | Nothing | PBKDF2-SHA256 via Web Crypto, 120k rounds, per-link salt, constant-time compare | Yes |
| Download cap | Nothing | `claimDownload` internal mutation | **No — see below** |

**The download cap is race-free by construction, and this is the nicest thing in
either baseline.** `claimDownload` reads the link, checks revocation, expiry and
the cap, increments, and appends the audit entry — all inside one Convex
mutation, which is a serializable transaction with automatic OCC retry. There is
no lock to take and no atomic-`UPDATE...WHERE` idiom to remember. The Supabase
version had to be hand-written as a single compound statement, and getting it
wrong is a TOCTOU race that is invisible in testing. **Convex makes this class
of bug unwriteable, and that is a real, elegant advantage.**

The cap is still not *exact*, for the same reason as Supabase: it counts URL
issuances, not byte deliveries. One redemption yields a 30-second presigned URL
that can be fetched any number of times. Closing that requires the `?inline=1`
path, which reintroduces the 20MB cap and doubles the network hops (the action
has to presign and then `fetch` its own URL, because the component exposes no
`getBlob`).

Password hashing deserves a note: PBKDF2 runs in the Convex default runtime via
Web Crypto. The alternative — `node:crypto` in a `"use node"` action — costs a
separate function invocation with its own cold start on **every** password
check, which is why the Web Crypto path was chosen.

### 11. Developer preference — honest subjective judgment

**I enjoyed writing this more than the Supabase baseline, and I trust it less.**

Both halves of that are sincere.

Enjoyed more:

- One language, one mental model. No context-switch between a policy DSL and
  application code, no `search_path` footguns, no wondering which policy raised
  an error.
- The type system does real work. `Id<"orgs">` vs `Id<"documents">` catching
  confused-deputy bugs at compile time is worth a lot, and RLS has no answer to
  it.
- Transactional mutations made the two genuinely hard concurrency problems —
  audit chaining and the download cap — disappear. I wrote no locks.
- `internalMutation` is a clean, honest privacy boundary.
- Convex's documentation is unusually candid. Putting "anyone with the URL can
  access the file" in bold on the *overview* page, and marking "Fine-grained
  permissions: No" on the pricing page, is the behaviour of a company that
  would rather you not get burned. That deserves saying.

Trust less:

- `requireUser` appears 15 times. It is one `git revert` away from appearing 14
  times, and the 15th endpoint would then be open to the internet with no
  failing test. I cannot write a query against the deployment that lists "every
  public function and whether it checks auth." Supabase's `pg_policies` gives me
  exactly that.
- `ctx.db.get(id)` returning any row from any tenant is the wrong default for
  multi-tenant software, and it is the default on the hottest API in the system.
- I wrote authorization for `documents` in `model/auth.ts`, again in
  `documents.resolveForReader` (because HTTP actions can't call model helpers
  directly), and again in `shares.claimDownload`. Three copies of one rule.
  Postgres had one.
- Splitting storage across two vendors to get a feature — expiring URLs — that
  the primary vendor's pricing page says it does not offer is not a comfortable
  place to be.

### 12. Willingness to maintain in production for 2 years

**Yes for a small team with strong review discipline. No for a team that will
grow past ~8 engineers or that has a hard audit requirement.**

Reasoning:

- The failure mode that worries me compounds with headcount and time. On day
  one, 15 functions each with a correct auth check is fine. On day 500 there are
  60, several written by people who joined after the pattern was established,
  and the only thing enforcing it is code review. I would want a custom ESLint
  rule or a wrapper (`authedQuery`) making the check structural — that is
  additional infrastructure not written here, and it is the first thing I would
  build.
- The two-vendor coupling is a permanent tax: credential rotation, preview
  environments, two status pages, and a class of partial outage that a
  single-vendor stack cannot have.
- Against that, the parts I would normally worry about — concurrency, schema
  migration, type drift between client and server — are the parts Convex handles
  best. Two years of schema evolution on Convex looks genuinely less painful
  than two years of SQL migrations plus policy revisions.
- If the requirement is "prove to an auditor that no unauthorized read is
  possible", I do not know how to do that on this stack short of a manual review
  of every exported function, repeated at every release. On Supabase I would
  diff `pg_policies` in CI.

---

## Where this approach is genuinely good

Stated without hedging.

**1. Serializable transactions make two hard problems vanish.**
The download-cap increment and the audit-chain append are both correct by
construction. No advisory locks, no compound atomic UPDATE, no TOCTOU. The
Supabase baseline needed `pg_advisory_xact_lock` for the chain and a carefully
hand-written `UPDATE … WHERE download_count < max_downloads RETURNING` for the
cap; both are the kind of thing that is subtly wrong in production for a year.
**Convex makes them unwriteable-wrong. This is elegant and a dedicated file
layer would not automatically beat it.**

**2. The type system prevents a real class of authorization bug.**
`Id<"orgs">` and `Id<"documents">` are distinct types. Passing the wrong id into
the wrong lookup is a compile error, not a cross-tenant read. RLS has no
equivalent — in Postgres a `uuid` is a `uuid`.

**3. Roles are always fresh.**
Because authorization reads `orgMembers` on every call, demotion and removal
take effect on the next request with no staleness window. This is strictly
better than the JWT-custom-claim RBAC that Supabase's own docs recommend as the
default, which leaves a removed member fully authorised for up to an hour.

**4. `internal*` is a clean, enforced privacy boundary.**
There is no way to accidentally expose an `internalMutation` to a client. It is
simpler and harder to get wrong than juggling GRANTs, REVOKEs and RLS policies.

**5. Argument validators are automatic input validation at the trust boundary.**
`v.id("documents")` rejects malformed input before the handler runs, for free,
on every endpoint.

**6. Schema and index management is better than SQL migrations.**
Indexes live in the schema, are backfilled on deploy, and have a `staged` mode
for large tables. No migration files, no drift between environments.

**7. The documentation is honest about its own limitations.**
"Anyone with the URL can access the file", in bold, on the overview page.
"Fine-grained permissions: No" on the pricing page. That candour is rarer than
it should be and it made this baseline faster and more accurate to write.

**8. One language end to end.**
No policy DSL, no `search_path`, no wondering which of three enforcement
mechanisms applies. For a small team shipping fast, this is a genuine velocity
advantage over RLS and it would be dishonest to score it at zero.

---

## What could NOT be implemented, and why

1. **Revocation of an already-issued storage URL.** Neither route supports it.
   Convex File Storage: revocation *is* deletion, and the URL never expires.
   R2 presigned: SigV4, no callback into Convex. Mitigated by the HTTP-action
   gateway; residual window 30s.

2. **Closing the residual window to zero on the documented path.** The R2
   component exposes no move/copy, so the Supabase trick (rename the object) is
   unavailable. The options are destroy the file, pull it through an action and
   re-store it (infeasible for large files), or leave the component and use the
   raw S3 SDK.

3. **Any database-enforced access control.** There is none to implement.
   Convex's pricing page marks "Fine-grained permissions: No" on every plan.
   All 33 access rules in this baseline are imperative checks that a future
   function can simply omit.

4. **An exact download cap.** Counts URL issuances, not byte deliveries. Same
   limitation as the Supabase baseline, same root cause.

5. **Tamper-*proof* audit.** The chain is tamper-**evident**. It is not
   resistant: Convex has no `REVOKE UPDATE`, so any server function can
   `ctx.db.patch` an audit row and recompute downstream hashes. Supabase could
   at least withhold the UPDATE grant from the `authenticated` role. Anchoring
   the head hash externally would close it; `audit.head` is the hook, the
   anchoring is not implemented.

6. **Audit of share-token brute force.** An invalid token has no org, so there
   is nothing to attribute the attempt to and no audit record is written. Needs
   a rate limiter, which Convex does not provide.

7. **A verifiable "every public function checks auth" assertion.** No
   equivalent of `select * from pg_policies` exists. This could not be built and
   its absence is the main reason for the qualified answer in §12.

8. **Anything at all was executed.** No test in this directory has run. See the
   status banner at the top.
