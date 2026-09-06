# Baseline 2 — Vercel Blob (private store) + Postgres

**Scenario:** Vault (fixed, unmodified).
**Status:** ⚠️ **WRITTEN TO SPEC — NEVER EXECUTED.** See caveat below.
**Date:** 2026-09-05.

> **My loyalty in this report is to the baseline, not to Filelayer.** Vercel
> Blob does one thing in this scenario markedly better than raw S3, and I have
> said so as loudly as I can (§9). It also contains the single highest-severity
> silent footgun I found in either baseline (§3, decision 1).

---

## The caveat, up front

This code has never been run and cannot be run here. `@vercel/blob` private
storage, `handleUploadPresigned`, `issueSignedToken` and OIDC credential
resolution all require a live Vercel project, a real private Blob store and
Vercel's control plane. There is no local emulator, and `onUploadCompleted`
*explicitly does not fire on localhost* even with one.

It is written faithfully against the documented API as of 2026-09-05 following
Vercel's own recommended patterns, with citations inline. Where the published
docs are incomplete the gap is marked `DOC GAP:` in the code rather than
guessed at silently.

**Treat every comparison against Baseline 1 as asymmetric:**
Baseline 1's defect count is 0 across 9 passing tests; Baseline 2's defect count
is *unknown*, because nothing has ever compiled or run it. Any metric that
favours Baseline 2 should be discounted accordingly, and the "implementation
time" figure in particular is not comparable — it excludes all debugging.

---

## Verdict in one paragraph

Vercel Blob's private store gets the hardest requirement in this scenario right
**by construction**. A private blob has no publicly fetchable URL at all, so the
only documented way to deliver one is to stream it through your own Function —
which means your authorization check runs on every byte, which means revocation
of an already-issued share link is immediate for free. On raw S3 that same
outcome requires a senior engineer to notice the problem and deliberately
reject the architecture everyone recommends. Here, the pit of success is where
you land by default. Against that: Vercel Blob supplies *nothing else*. No
ownership model, no tenancy, no roles, no expiry, no lifecycle rules, no
metadata, no query surface. The application-code burden is not smaller than raw
S3 — measured, it is slightly larger. And the platform contains a footgun
(`issueSignedToken()` defaulting to a whole-store wildcard) that can hand a
caller read access to every tenant's documents in one line, silently.

---

## The twelve metrics

### 1. Implementation time

| Phase | Elapsed |
|---|---|
| Research (Blob docs: private storage, SDK, signed URLs, security, pricing) | 6 min |
| Porting the platform-independent half (authz, audit, shares, schema) | 2 min |
| Blob-specific code + 12 route handlers + infra | 8 min |
| This report | 9 min |
| **Total actual working time** | **~25 min** |

**This figure is not trustworthy and should not be compared to Baseline 1's.**
It contains zero debugging, because nothing was ever run. On Baseline 1,
"write it" and "make it pass" were the same 6 minutes only because I could
execute it; the corresponding effort here is entirely deferred.

**Calibrated senior-engineer estimate: 4–7 working days**, i.e. *longer* than
Baseline 1 despite the platform doing more, for three reasons: (a) the
client-upload flow has a webhook (`onUploadCompleted`) that does not fire in
local development, so the primary happy path is undevelopable locally and needs
a deploy-to-preview loop; (b) `get()`'s return shape is not fully documented
(see §"Doc gaps"), so the streaming route is written partly by inference; (c)
the store's access mode and region are permanent, so the first decision of the
project is one you cannot undo, which in practice costs a design meeting.

### 2. Application LOC

Same method as Baseline 1 (`../count-loc.mjs`): GROSS = all lines; NET = lines
that are neither blank nor comment-only; only `lib/**` and `app/api/**` count as
application code.

| Bucket | Files | Gross | Net |
|---|---|---|---|
| **Application (`lib/` + `app/api/`)** | 21 | **1241** | **884** |
| Infra config (`infra/vercel.json`) | 1 | 21 | 21 |
| Tests | 0 | 0 | 0 |

**884 net vs Baseline 1's 700 — but that comparison needs three honest
adjustments, and they do not all point the same way:**

- **File-per-route inflation.** Next.js App Router requires one file per route;
  21 files vs 7 means ~21 import blocks and ~21 export signatures. I estimate
  **60–90 net lines** of the difference is framework shape, not logic.
- **TypeScript.** Type annotations and the `HttpError` class add perhaps
  **30–40 net lines** over the JS baseline. This is a cost I would pay
  willingly; it is not waste.
- **Against Baseline 2:** it has **no test suite at all**. Baseline 1's 312
  lines of tests are excluded from both headline numbers, but Baseline 2 would
  need at least that many to reach the same confidence — and they would be
  harder to write, because there is no local Blob emulator.

Adjusted like-for-like, the two are within noise of each other: **roughly 700
lines either way.** The honest conclusion is *not* "Vercel is worse"; it is
**"the object store makes essentially no difference to how much code you
write."**

Platform-specific code:

| | Baseline 1 | Baseline 2 |
|---|---|---|
| Storage-specific | `src/storage.mjs`, **69 net** | `lib/blob.ts`, **44 net** |
| Substantively identical logic (authz + audit + shares + schema) | 232 net (33%) | 258 net (29%) |

`lib/blob.ts` being *smaller* than `storage.mjs` is real and to Vercel's credit:
no signing, no credential plumbing, no endpoint/path-style configuration, no
presigner. The SDK is nicer to use than the AWS SDK.

### 3. Security-sensitive decisions

Same definition: a wrong choice creates a leak **and nothing tells you**.

**Platform-specific to Vercel Blob (9):**

1. **`issueSignedToken()` must always be passed a `pathname`.** ⚠️ **The single
   highest-severity silent footgun in either baseline.** Per the docs, `pathname`
   "Defaults to a whole-store wildcard", and `operations` defaults to `['get']`
   with a one-hour validity. So `await issueSignedToken()` — a call that looks
   like sensible defaults and compiles cleanly — mints a credential that can read
   **every blob in the store, i.e. every document belonging to every
   organization**. In a single-store deployment that is a full cross-tenant
   breach in one line. Nothing in the type system, the linter or the runtime
   objects. Guarded in `app/api/orgs/[orgId]/upload/route.ts` with a comment as
   loud as I could make it.
2. **The browser chooses the upload pathname.** In the client-upload flow, the
   pathname arrives from the client and is passed to your `getSignedToken`. Sign
   it unchecked and a user in org B uploads directly into `orgs/<orgA>/`. I
   bound it to a pre-reserved database row rather than prefix-matching, because
   prefix validation invites normalisation bugs (`orgs/A/../B/`).
3. **Auth must be in the route handler, never in Next.js middleware.** Vercel's
   docs say this explicitly — "a middleware bug or misconfiguration could expose
   cached private content to the wrong users" — and middleware is exactly where
   a Next.js developer's instinct puts auth.
4. **Never `s-maxage` a private blob response.** A CDN-cached private document
   is served to subsequent requesters without your auth check running at all.
5. **`Cache-Control` must be set explicitly.** The default Vercel sends is
   `public, max-age=0, must-revalidate`. The literal token `public` on a response
   carrying a confidential document is not what you want in front of any
   intermediary. `private, no-store` is used on the share path so a revoked link
   is not replayable from disk cache.
6. **One store for all tenants vs one store per tenant.** One store means one
   credential whose blast radius is every customer's documents, and `list()`
   enumerates all of them. Per-tenant stores bound the radius but cap you at 500
   customers (Pro) / 1,000 (Enterprise). There is no third option and no
   per-prefix credential scoping.
7. **`access: 'private'` must be passed on every `get()` call.** It is a required
   per-call option rather than a property of the store. (Mitigating: passing
   `'public'` against a private store fails loudly, so this one is fail-closed —
   the risk is a *public* store where the mistake is silent.)
8. **`BLOB_READ_WRITE_TOKEN` must not shadow OIDC.** The documented resolution
   order puts an explicit `token` option **above** OIDC. One stray
   `{ token: process.env.BLOB_READ_WRITE_TOKEN }` silently downgrades a
   short-lived rotating credential to a long-lived static one.
9. **`CRON_SECRET` must be checked in the cron route.** Vercel sends it but does
   not enforce it. Unchecked, `/api/cron/sweep` is an unauthenticated
   customer-data-deletion endpoint.

**Platform-independent, and identical to Baseline 1 (11):** every-query `org_id`
filtering; the object pathname is not a boundary; 404-vs-403 for non-members;
share tokens hashed not stored; token entropy; scrypt for the password and *not*
the token hash function; `timingSafeEqual`; atomic download-cap consumption;
`Content-Disposition: attachment` + `nosniff`; the viewer-can-share spec
ambiguity; last-owner protection.

**Additionally, and worse here than on Baseline 1 (1):**

21. **Audit-chain serialisation under serverless concurrency.** On a long-lived
    Node server this is a row lock in a transaction. On Vercel Functions there is
    no long-lived process, concurrency is elastic and invisible, and the
    serverless Postgres drivers most Vercel projects use (`@neondatabase/
    serverless` over HTTP) do not expose interactive transactions at all. I
    handled it with a `UNIQUE (org_id, org_seq)` constraint plus a retry loop —
    correct, but the retry loop is load-bearing and trivially omitted, and
    omitting it means concurrent events are silently *never recorded*.

**Total: 21 individually enumerated silent-failure decision points** (vs 23 for
Baseline 1). Comparable in count; **not** comparable in severity — decision 1
here is worse than anything in Baseline 1's list.

### 4. Infrastructure / configuration decisions

17 items, enumerated in `infra/vercel-setup.md` with silent-if-wrong and
**permanent** columns. The two that have no analogue in Baseline 1:

- **Store access mode is fixed at creation and can never be changed.** Choose
  `public` for a document workspace and every file is fetchable by URL forever;
  the only remedy is to create a second store and copy every blob. Baseline 1's
  equivalent mistake (Block Public Access) is a toggle you can flip back.
- **Store region is fixed at creation.** Data residency becomes an irreversible
  day-one decision.

Genuinely *fewer* decisions than Baseline 1 in one respect: there is no IAM, no
KMS, no bucket policy, no CORS configuration, and no signing-credential session
management. OIDC handles credential rotation with zero developer involvement,
which is a real and meaningful reduction in operational surface.

### 5. Number of components to operate

**Four.** (1) Vercel project/Functions, (2) Vercel Blob store, (3) Marketplace
Postgres (a separate vendor with a separate bill), (4) Vercel Cron. Optionally
(5) Vercel WAF on the store.

Meaningfully fewer than Baseline 1's six, and the ones that remain are managed.
This is a real operational win.

### 6. Edge cases the developer must handle explicitly

All seventeen from Baseline 1 apply, minus clock skew and signing-session
expiry, plus these six that are specific to this platform:

1. **`onUploadCompleted` does not fire on localhost** (documented). The primary
   upload completion path is undevelopable locally, which is why
   `/complete/route.ts` exists as a fallback and why the fallback is what will
   actually be load-bearing.
2. **`onUploadCompleted` is a webhook**: it can be delayed, retried, or lost. Two
   writers now race to mark a document `ready`, so the UPDATE is guarded on
   `status = 'pending'` and the audit append is conditional on it having changed
   a row.
3. **Delete propagation takes up to 60 seconds through the CDN cache.** Our auth
   check runs in front of every read so this does not leak, but "the bytes are
   gone" is untrue for a minute — which matters if you told a customer otherwise.
4. **`useCache` must be chosen per call site.** Default `true` means a read
   straight after a write can return the previous version for up to 60s.
5. **`head()` throws `BlobNotFoundError` while `get()` returns `null`.** Two
   error conventions in one SDK; the wrong one is an unhandled rejection.
6. **`addRandomSuffix` must be `false` on the upload path**, because the pathname
   is the join key back to Postgres. A random suffix orphans the document at the
   moment of upload. (Note the docs *recommend* `addRandomSuffix: true` generally
   — good advice that is wrong for this design.)
7. **Operation rate limits are real** (Pro: 7,200 simple/min, 4,500 advanced/min)
   and the reconciliation sweep in `cron/sweep` consumes advanced operations per
   `list()` page, so on a large store the cleanup job is itself a capacity
   problem.

### 7. Failure modes — open or closed

| Failure | Behaviour | Direction |
|---|---|---|
| Postgres unreachable | no authorization possible, 500 | **CLOSED** |
| Blob store unreachable | 502 from the streaming route | **CLOSED** |
| **A private blob URL leaks** | **useless without a credential** | **CLOSED** ✅ *(strictly better than S3)* |
| OIDC token expires | SDK refreshes automatically | **CLOSED** |
| Function timeout on a large file | download fails | CLOSED |
| Operation rate limit exceeded | 429 | CLOSED |
| `onUploadCompleted` webhook lost | document stuck `pending`, invisible | CLOSED (annoying, not leaky) |
| **`issueSignedToken()` called without `pathname`** | **whole-store read credential** | **OPEN** ❌ |
| **Auth placed in middleware + any CDN caching** | **private content served to the wrong user** | **OPEN** ❌ |
| **`Cache-Control` left at the default** | **`public` on a confidential response** | **OPEN** ❌ |
| **Store created with `access: 'public'`** | **every document world-readable, permanently** | **OPEN** ❌ |
| **`BLOB_READ_WRITE_TOKEN` leaks** | **full store read + write + `list()`, all tenants** | **OPEN** ❌ |
| **`CRON_SECRET` unchecked** | **anonymous data deletion** | **OPEN** ❌ (destructive, not a leak) |
| **An `org_id` filter omitted in a future query** | **cross-tenant read** | **OPEN** ❌ |
| Audit retry loop omitted | events silently never recorded | silent |

The shape is the same as Baseline 1: infrastructure and platform failures fail
closed; developer mistakes fail open. The important difference is the **best**
row in the table — a leaked private blob URL is inert here and dangerous on S3 —
and the **worst** row, which is worse here than anything on S3.

### 8. Lifecycle complexity

**Higher than Baseline 1, and this is the clearest place Vercel Blob is behind.**

S3 has lifecycle rules: expire by age, transition storage class, abort
incomplete multipart uploads — declarative, server-side, free. **Vercel Blob has
no equivalent of any of this.** There is no expiry, no TTL, no storage class, no
automatic cleanup. Every byte you ever wrote is billed at $0.023/GB-month until
you personally call `del()` on it.

So the entire lifecycle is a cron job you write and must keep working
(`app/api/cron/sweep/route.ts`):

- Reserved-but-never-uploaded document slots.
- Blobs with no database row, requiring a full paginated `list()` of the store
  reconciled against Postgres — billable advanced operations, rate limited, and
  O(store size) forever.
- Expired/revoked share rows.

Mitigating, and genuinely nice: `del()` is idempotent and documented not to
throw on a missing blob, which makes cleanup code much cleaner to write than the
S3 equivalent.

### 9. Revocation complexity — **the crux, and where this platform wins**

**Say this loudly: Vercel Blob's private store handles the hardest requirement
in this scenario more elegantly than raw S3, and it does so by default.**

The mechanism is structural, not a feature. Per the docs, a private blob's URL
`https://<store-id>.private.blob.vercel-storage.com/<pathname>` "is not publicly
accessible"; all read access requires authentication; and the documented way to
deliver one to an end user is to "create a route that authenticates the request,
fetches the blob using `get()`, and streams the response."

The consequence is that **the idiomatic path and the correct path are the same
path.** Your authorization check runs on every byte-serving request because
there is no other way to serve a byte. Revocation is one `UPDATE shares SET
revoked_at = now()` and takes effect on the very next request, with no cache to
purge, no token to hunt down, and no window.

Contrast Baseline 1 honestly. There, the architecture the entire developer
community recommends — "pre-signed URLs are the way to go... there's really no
reason to find an alternative answer" — **silently fails this requirement**. A
senior engineer has to (a) know that presigned URLs are unrevocable, (b) notice
that the requirement demands revocability, and (c) deliberately reject the
recommended architecture for the share path. Every one of those three steps is a
place a competent team ships a broken revoke button. On Vercel, none of those
steps exist, because the tempting shortcut is simply not available: the private
blob URL doesn't work without a credential.

**That is a genuine, significant architectural advantage and it should be
weighted heavily.** It is the single best thing about this baseline.

**Three caveats, in fairness:**

1. **The trap is still reachable.** `issueSignedToken` + `presignUrl` exist and
   are documented for exactly this use case ("Share a private blob with a third
   party for a limited window"). Using them on the share path would look like a
   sensible cost optimisation and would silently reintroduce the S3 problem: a
   Vercel signed URL is a bearer token verified at the CDN with no callback into
   your application, `validUntil` is capped at 7 days, and there is **no
   per-URL revocation**. The nearest lever is rotating the store's read-write
   token, which breaks the whole application — the same account-wide kill switch
   as AWS. I deliberately did not use signed URLs on the share path and said so
   in the code.
2. **You pay for it.** Private delivery is structurally ~2× public transfer cost
   (Function→store Blob Data Transfer + Fast Origin Transfer, then
   Function→browser Fast Data Transfer + Fast Origin Transfer), and Vercel states
   BDT is "3x more cost-efficient than FDT on average", so the real multiple is
   worse than 2× once FDT is counted. For this scenario that is the price of
   correctness, not a mistake — the documents are confidential, so public storage
   was never on the table. It is worth noting that Baseline 1 on **R2** achieves
   the same correctness with a *free* storage→app leg, which is cheaper than
   Vercel for the proxy pattern.
3. **Vercel's own docs advise against it at scale**: "We do not recommend serving
   files larger than 100 MB through private Blob stores unless traffic is low."
   For a B2B document workspace that limit is comfortable. For video it is not.

### 10. Sharing complexity — expiry + password + download cap

**Identical to Baseline 1 — roughly 90 net lines, all of it hand-written.**
Vercel Blob contributes nothing. There is no expiring grant, no password
concept, no download counter, no revocable link primitive. `issueSignedToken`'s
`validUntil` is the only overlap and it is the wrong tool here for the reasons
in §9.

One genuine difference, and it favours Vercel: because delivery is already a
Function, adding the password check and the atomic cap consumption to the
download path is *natural* — there is no architectural decision to make about
where the check goes. On S3 you first have to decide to have a proxy at all.

### 11. Developer preference — honest subjective judgement

I enjoyed writing this more than Baseline 1, and I trust it less.

What is genuinely good: the SDK is a pleasure. `put`/`get`/`head`/`del`/`list`
with sensible option objects, no signing, no endpoints, no path-style flags, no
credential plumbing. OIDC with automatic rotation is a real improvement over
managing an access key and worrying whether the role session outlives the
presigned TTL — an entire class of Baseline 1 bug simply does not exist here.
`del()` being idempotent is a small kindness that shows someone was thinking
about the caller. Conditional reads and writes (`ifNoneMatch`, `ifMatch`) are
well-designed. And the private-store delivery model, as argued at length in §9,
guides you into the correct architecture instead of away from it.

What I don't trust: I could not run any of it. `get()`'s return shape is not
fully documented — the property table is missing from the published page — so
the streaming route is written partly from examples on a different page. The
primary upload path can't be exercised locally at all. And decision 1 in §3 is
the kind of API default that will eventually produce a public incident report
with somebody's company name on it; `pathname` defaulting to a whole-store
wildcard on a token type whose entire purpose is delegation is, in my honest
opinion, the wrong default.

I would also note the vendor question. Baseline 1's code moves between five
storage vendors by changing one string. This code moves nowhere. For a two-year
horizon on a product whose core asset is customer documents, that asymmetry is
not a small thing.

### 12. Willingness to maintain for two years

**Qualified yes — and I would want to be on Pro or Enterprise before I said it.**

I would happily own the *code*. It is smaller, cleaner and more idiomatic than
Baseline 1's, and the platform steers the one genuinely dangerous decision in
the right direction.

What would make me hesitate: (a) the permanent decisions — store access mode and
region cannot be changed, so a day-one mistake is a data migration; (b) the
500-store ceiling forecloses per-tenant isolation as a growth strategy, which is
exactly the thing an enterprise customer's security review will ask for in year
two; (c) operation rate limits are a hard ceiling I cannot raise myself, and my
reconciliation sweep competes with production traffic for them; (d) `del()` is
free but *storage is forever* — with no lifecycle rules, cost control is
permanently my cron job's problem; (e) I cannot test locally, which over two
years is a compounding tax on every change.

My conditions would be: a per-tenant-store migration plan written down *before*
launch while it is still cheap; a preview-environment integration test suite,
since local testing is off the table; a lint rule or wrapper that makes
`issueSignedToken` without `pathname` impossible to write; and a hard budget
alarm, because private delivery cost scales with reads and a single popular
share link is a bill.

---

## Where this approach is genuinely good

1. **⭐ Private storage makes immediate revocation the default, not an
   achievement.** The most important finding in this report. A private blob has
   no fetchable URL, so delivery *must* go through your Function, so your
   authorization check *must* run on every byte. Raw S3 requires a senior
   engineer to actively reject the community-recommended architecture to reach
   the same place. This is a genuinely elegant piece of platform design and
   Filelayer should be measured against it, not just against S3.
2. **OIDC credential handling is excellent.** Short-lived, auto-rotating,
   zero developer involvement, "no long-lived secret can leak from your codebase
   or environment". This deletes an entire category of Baseline 1 problem
   (access-key management, role session duration vs presigned TTL, key rotation
   as a fire drill).
3. **Far less infrastructure surface.** No IAM, no KMS, no bucket policy, no
   CORS, no Block Public Access, no signing credentials. Four components to
   operate instead of six. For a small team this is a real and daily benefit.
4. **The SDK is better than the AWS SDK for this job.** `lib/blob.ts` is 44 net
   lines against `storage.mjs`'s 69, and the difference is entirely plumbing that
   Vercel removed. `del()` idempotent-by-design, `ifMatch`/`ifNoneMatch`
   conditionals, and per-call `useCache` are all well-judged.
5. **The docs are unusually good about the dangerous parts.** They explicitly
   warn against middleware auth, explicitly warn about the default
   `Cache-Control`, explicitly bold the "you must authenticate inside this
   function" instruction, and are honest about the private-delivery cost model.
   That is better security-documentation hygiene than most storage products.
6. **Encryption at rest, security headers and platform DDoS protection are on by
   default**, with WAF available. Baseline 1 makes you configure the equivalent
   and will not tell you if you didn't.
7. **Client uploads incur no data-transfer charge**, and the presigned-upload
   flow keeps large files out of the Function entirely — same architectural win
   as S3 presigned PUT, with `allowedContentTypes` and `maximumSizeInBytes`
   enforced at the CDN. **Note this is strictly better than Baseline 1**, which
   has no upload size cap on a presigned PUT without switching to the
   presigned-POST API.

---

## What I could NOT implement, and why

1. **Anything at all, verifiably.** This is the headline gap. No execution, no
   tests, no observed behaviour. Every claim about this code's correctness is an
   inference from documentation.

2. **Immediate revocation of an already-issued Vercel *signed* URL. Impossible —
   but structurally irrelevant here.** Signed URLs are CDN-verified bearer tokens
   with no application callback, `validUntil` capped at 7 days, and no per-URL
   revocation; the only comparable lever is rotating the store token, which
   breaks everything. **The reason this does not cost us the requirement** is
   that private-store delivery doesn't need signed URLs at all — so unlike
   Baseline 1, avoiding the trap costs nothing and requires no cleverness. Worth
   restating: the gap exists on both platforms; only one of them makes falling
   into it the path of least resistance.

3. **Local development of the upload happy path.** `onUploadCompleted` "won't
   fire on localhost" (documented). The `/complete` fallback route exists
   specifically because of this, which means the code shipped to production
   contains a workaround for a development-environment limitation. That is a real
   design cost.

4. **A verified `get()` return shape.** The published SDK reference's `get()`
   property table is missing from the page. `statusCode`, `stream`,
   `blob.contentType` and `blob.etag` are inferred from the private-storage
   page's examples. `lib/blob.ts` is written against that inference.

5. **Per-tenant credential scoping.** There is no way to scope a credential to a
   pathname prefix. Cross-org isolation is 100% application logic with zero
   platform backstop — identical to raw S3, and worth stating plainly because the
   "private store" branding might suggest otherwise. A private store is private
   *from the internet*, not private *between your tenants*.

6. **Any storage-layer guardrail equivalent to `s3:signatureAge`.** Baseline 1
   can enforce a maximum signature age at the storage edge so an application bug
   cannot produce a long-lived URL. Vercel Blob has no equivalent; `validUntil`
   correctness is purely an application-code property. (Vercel WAF offers rate
   limiting and IP blocking, which is not the same control.)

---

## Documentation followed

- [Vercel Blob overview](https://vercel.com/docs/vercel-blob) — private vs public, access mode permanence, caching, overwriting, operations, storage calculation.
- [Private Storage](https://vercel.com/docs/vercel-blob/private-storage) — delivery via `get()` + streaming, the middleware-auth warning, `Cache-Control` guidance, consistent reads, download charges, the 100 MB recommendation.
- [Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk) — `put`/`get`/`head`/`del`/`list`, credential resolution order, `handleUpload`.
- [Vercel Signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls) — `issueSignedToken` (**including the whole-store wildcard default**), `presignUrl`, `handleUploadPresigned`.
- [Security](https://vercel.com/docs/vercel-blob/security) — private-store guarantees, AES-256 at rest, WAF caveats.
- [Usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing) — private vs public delivery cost, operation rate limits, store limits.
