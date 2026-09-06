# Baseline 1 — Supabase Storage + Postgres RLS

**Scenario:** Vault (fixed; see benchmark brief).
**Status: RUNNABLE AND EXECUTED.** 28/28 tests pass against real PostgreSQL 18
(PGlite 0.5.8) with real RLS policies, evaluated under `SET LOCAL ROLE
authenticated` with `request.jwt.claims` set — the same mechanism PostgREST and
the Supabase Storage API use in production.

```
npm install && npm test     # 28 passing
npm run loc                 # reproducible line counts
```

**Read this section first if you read nothing else:** [Where this approach is
genuinely good](#where-this-approach-is-genuinely-good). Supabase is the
strongest competitor in this comparison and several things it does here are
better than a dedicated file layer would be.

---

## Documented best practice followed

Every design choice below traces to a Supabase doc page, current as of
2026-09-05.

| Decision | Source |
|---|---|
| RLS policies on `storage.objects`; deny-by-default; policies keyed on `bucket_id`, `owner_id`, path segments | [Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control) |
| `storage.foldername()`, `storage.filename()`, `storage.extension()`, `storage.allow_only_operation()`, `storage.allow_any_operation()` | [Storage Helper Functions](https://supabase.com/docs/guides/storage/schema/helper-functions) |
| `owner_id` derived from JWT `sub`; ownership alone grants nothing, enforce it in policy | [Ownership](https://supabase.com/docs/guides/storage/security/ownership) |
| Private buckets; `createSignedUrl(path, expiresIn)`; signed URLs use a separate per-project storage key and **cannot be revoked** | [Serving assets from Storage](https://supabase.com/docs/guides/storage/serving/downloads) |
| `storage` schema is read-only; add custom indexes for RLS performance | [The Storage Schema](https://supabase.com/docs/guides/storage/schema/design) |
| Org-role RBAC; Custom Access Token Auth Hook; `authorize()` helper in RLS | [Custom Claims & RBAC](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac) |
| Service key bypasses RLS entirely; never ship it to a client | [Storage Access Control § Bypassing access controls](https://supabase.com/docs/guides/storage/security/access-control) |
| `SECURITY DEFINER` helpers with `set search_path = ''`; wrap `auth.uid()` in `(select …)` | [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) |

One deliberate deviation, made in Supabase's favour: the RBAC guide's headline
pattern puts the role in a **JWT custom claim**. We use a **table lookup**
instead, because claims are stale until token refresh. This is the *more
secure* of the two documented options, so the baseline is stronger than the
docs' default, not weaker. Test 10 measures the difference.

---

## Architecture as built

```
Browser --JWT--> PostgREST ----> Postgres  (RLS on public.* and storage.objects)
        --JWT--> Storage API --> RLS on storage.objects --> S3
        -------> Share Gateway (Edge Function, service key)
                     | checks: revoked? expired? password? cap?
                     | appends audit record
                     +--> mints 30s signed URL --> Storage API (NO RLS, NO DB)
```

Object layout in the private bucket `vault`:
`{org_id}/{document_id}/{filename}` — so `(storage.foldername(name))[1]` is the
org and `[2]` is the document.

**Two configurations are implemented and both are tested**, because the
scenario cannot be fully satisfied by either alone:

- **Config A** (`20_rls_policies.sql`): canonical Supabase. Members read bytes
  directly with their own JWT; RLS is the enforcement point. **The audit trail
  is incomplete** — direct reads never reach your code (test 23 proves it).
- **Config B** (`+ 25_config_b_lockdown.sql`): `authenticated` may list object
  metadata but may not fetch bytes or mint signed URLs. All reads go through
  server code holding the service key. **Audit is complete, but RLS on
  `storage.objects` is now dead code for reads** (test 24 proves it).

This is the central structural tension of the Supabase approach and it is not a
bug: *either RLS is in the request path and your audit trail has holes, or your
gateway is in the request path and your RLS is decorative.* You cannot have
both with signed URLs and direct client access.

---

## The twelve metrics

### 1. Implementation time

Measured honestly, and split, because a benchmark that conflates agent speed
with developer effort is useless.

| | |
|---|---|
| Agent wall-clock, research → 28 green tests | **≈ 55 minutes** (≈15 min doc research, ≈25 min writing, ≈15 min debugging) |
| Estimated competent-developer equivalent, first time on this stack | **3–5 days** |
| Estimated competent-developer equivalent, has shipped Supabase RLS before | **1.5–2.5 days** |

The developer estimate is an estimate and is labelled as such. Its basis: 19
RLS policies × the write-test-attack-rewrite loop, plus one Edge Function with
a service key, plus the audit chain, plus the Config A/B decision — which is a
genuine architectural fork that a real team would spend half a day arguing
about before writing anything.

Where the agent time actually went is more informative than the total. **The
single largest debugging block was one RLS policy interaction** (see §7,
"documents_read"): `update … set deleted_at = now()` failed with *"new row
violates row-level security policy for table documents"* — an error raised by
the **SELECT** policy, which was not the policy being edited, on an **UPDATE**
statement, with no `RETURNING` clause. Under `FORCE ROW LEVEL SECURITY`,
Postgres applies SELECT policies to the post-update row. That is correct
Postgres behaviour and it failed *closed*, but locating it took longer than
writing all 19 policies.

### 2. Application LOC

**Counting method** (reproduce with `npm run loc`):

- **APPLICATION** = code a developer building Vault on Supabase must write and
  own.
- **PLATFORM** = code Supabase itself operates, recreated here only so the
  policies can execute (`sql/00_platform_emulation.sql`,
  `src/platform/supabase.js`). **Excluded.** In a real project these files do
  not exist.
- **TEST / TOOLING** = the suite, harness, LOC script, and
  `sql/90_rbac_jwt_variant.sql` (a measurement artefact, not part of Vault).
  **Excluded.**
- **GROSS** = every line in APPLICATION files, blanks and comments included.
- **NET** = GROSS minus blank lines and comment-only lines.

Comments here are unusually dense because each one records a security decision,
so NET is the fairer headline and GROSS is shown for transparency.

| File | Gross | Net |
|---|---:|---:|
| `sql/10_app_schema.sql` | 111 | 82 |
| `sql/20_rls_policies.sql` — kernel + 19 policies | 294 | 186 |
| `sql/25_config_b_lockdown.sql` | 35 | 8 |
| `sql/30_audit.sql` | 124 | 88 |
| `src/app/vault.js` | 131 | 95 |
| `src/app/share.js` | 190 | 105 |
| **APPLICATION TOTAL** | **885** | **564** |

Excluded for reference: platform 355/238, test+tooling 722/520.

Of the 564 net application lines, **194** are the authorization kernel and RLS
policies — i.e. **34% of everything written is access-control declaration.**

### 3. Security-sensitive decisions

Definition applied: *a point where a wrong choice creates a data leak **and**
the system will not tell you.* Compile errors, test failures and permission
denials do **not** count — they are loud. This list is deliberately conservative:
five candidates were considered and rejected because Postgres makes them safe by
default; they are listed at the end and credited to Supabase.

**Configuration (1)**

1. **Bucket must be created with `public: false`.** One boolean. A public bucket
   serves every object at a guessable URL and RLS becomes irrelevant. Nothing
   warns you; your app keeps working perfectly.

**`storage.objects` policies (8)**

2. `bucket_id = 'vault'` must appear in each of the 4 policies. Omit it and the
   policy silently governs every bucket in the project.
3. `vault_read` — deriving authorization from the path alone vs joining
   `public.documents`. Path-only gives you two sources of truth that drift the
   first time a document is re-parented.
4. `vault_read` — the `allow_any_operation` list. Omit the operation filter and
   any member can enumerate the bucket; include the wrong operation name and you
   either break signing (loud) or over-permit (silent).
5. `vault_insert` — path segment indices. `[1]` is the org, `[2]` is the
   document. Off by one and you have a cross-org write.
6. `vault_insert` — `owner_id = (select auth.uid())::text`. Omit and ownership
   can be spoofed at upload.
7. `vault_insert` — `can_write_org` (owner/admin/member) vs `is_org_member`.
   The latter silently lets **viewers upload**.
8. `vault_delete` — `can_manage_object` vs `can_read_object`. The latter
   silently lets viewers delete.
9. Every policy must be written for the right **command**. A policy authored
   `FOR SELECT` when you meant `FOR ALL` leaves UPDATE/DELETE unpoliced — which
   fails closed — but `FOR ALL` when you meant `FOR SELECT` opens writes.

**The `SECURITY DEFINER` kernel (4)**

10. All 8 helper functions are `SECURITY DEFINER`, so each one **bypasses RLS**
    on the tables it reads. They are the trusted core; a bug in any one is a
    silent cross-tenant leak with no other layer behind it.
11. `set search_path = ''` on every `SECURITY DEFINER` function. Omitting it is
    a documented privilege-escalation vector (search-path hijacking), and
    everything keeps working while you are vulnerable.
12. `EXECUTE` must be revoked from `anon`/`public` on the object-resolution
    helpers. `GRANT EXECUTE … TO PUBLIC` is easy to type and silent.
13. `documents.storage_path` must be `UNIQUE`. Without it two documents can
    claim one object name and `can_read_object` resolves to whichever row wins.

**`public.*` policies (5)**

14. `documents_insert` — `uploader_id = (select auth.uid())`. Omit and any
    member forges uploads attributed to a colleague.
15. `documents_update` **WITH CHECK** — without it a member re-parents their own
    document into another org.
16. `members_write_admin` / `members_update_admin` — the `role <> 'owner' or
    org_role_of(org_id) = 'owner'` guard. Omit it and any admin promotes
    themselves to owner.
17. `members_delete_admin` — same guard, or an admin evicts the owner.
18. **`share_insert` — the `document_id` must be checked to belong to
    `org_id`.** Without that `exists` clause, a member of org A inserts a
    share_links row carrying `org_id = A` and a `document_id` from org B; the
    gateway then resolves and serves org B's bytes. This is the nastiest one in
    the list: RLS on `documents` never sees it, because the gateway reads with
    the service key.

**Mechanism gaps that RLS cannot express (2)**

19. **Column-level `GRANT UPDATE (revoked_at)` on `share_links`.** RLS decides
    *which rows* you may update; it says nothing about *which columns*. Any
    policy permissive enough to let a user revoke their own link is, without
    this GRANT, permissive enough to let them reset `download_count` to 0 or
    push `expires_at` into 2099. This is a different mechanism in a different
    file and nothing connects the two.
20. `audit_log` — no INSERT policy **and** `REVOKE EXECUTE ON audit_append FROM
    authenticated`. Either alone is insufficient; forget the revoke and users
    forge their own audit records.

**Gateway / service-key handling (5)**

21. The gateway holds the service key, which has `BYPASSRLS`. Leaking it is
    total compromise of every tenant.
22. The gateway must resolve `storage_path` **server-side from the share
    token**. Accepting a client-supplied path is an IDOR with RLS already
    bypassed — every file in every org, one query parameter away.
23. Download-count increment must be a single atomic
    `UPDATE … WHERE download_count < max_downloads RETURNING`. Read-then-write
    is a TOCTOU race two concurrent redemptions win together.
24. Password comparison must be constant-time, and a **failed** attempt must not
    consume a download (test 13 asserts this).
25. Share-token entropy. A sequential or short token is enumerable and the
    gateway is unauthenticated by design.

**Data handling (2)**

26. Filename sanitisation. Object names feed `storage.foldername()`; a filename
    containing `/` changes the segment structure and defeats the
    `[1] = org_id` check.
27. Choosing table-lookup RBAC over the docs' JWT-claim RBAC. The claim variant
    leaves a removed member fully authorised for the remaining token lifetime
    (up to 1 hour by default) with no signal anywhere. Test 10 demonstrates it.

**Total: 27 silent-failure decisions**, clustered 8 in `storage.objects`
policies, 5 in `public.*` policies, 4 in the SECURITY DEFINER kernel, 5 in the
gateway, 5 elsewhere.

**Rejected candidates — credited to Supabase/Postgres as safe by default:**

- Omitting `WITH CHECK` on an UPDATE policy. Postgres reuses `USING` as
  `WITH CHECK`. Fails closed.
- Forgetting a policy entirely. RLS denies. Fails closed.
- Forgetting `ENABLE ROW LEVEL SECURITY`. Supabase's dashboard flags unprotected
  tables, and for `storage.objects` RLS is already enabled by the platform.
- The `documents_read` / post-update-visibility interaction. Fails closed, loudly.
- Getting a policy's boolean logic wrong in the restrictive direction. Loud —
  your app breaks in the first test.

### 4. Infrastructure / configuration decisions

15, all in one vendor's dashboard/CLI:

1. Create bucket `vault`, **`public: false`**
2. `file_size_limit` on the bucket
3. `allowed_mime_types` on the bucket
4. Deploy the share gateway as an Edge Function
5. Inject the service-role key into the Edge Function environment
6. Route a public hostname to the gateway (share URLs must not be `*.supabase.co`)
7. CORS configuration on the Edge Function
8. **Signed-URL TTL** (`SIGNED_URL_TTL_SEC`) — this number *is* your revocation SLA
9. Access-token TTL (governs RBAC staleness if you use JWT claims)
10. Register the Custom Access Token Auth Hook (only if using claims)
11. `create index on public.documents (storage_path)` — without it every single
    object request seq-scans `documents` inside a policy
12. Choose Config A or Config B (architectural, not a toggle)
13. Rate limiting on the unauthenticated share gateway (token + password
    brute-force)
14. PITR / backup policy for `audit_log`
15. CDN caching behaviour for signed URLs (a cached 200 outlives its own TTL at
    the edge)

### 5. Number of components the developer must operate

**Four services, one vendor.**

Postgres (+RLS) · Auth · Storage (+its S3 backend) · Edge Functions.

This is the single best thing about this baseline and it deserves emphasis:
one dashboard, one CLI (`supabase`), one local dev stack (`supabase start`),
one bill, one support contract, one status page, one set of credentials. There
is no cross-vendor IAM, no second console, no key-exchange between providers.
For a team that already runs Supabase for its database, the marginal
infrastructure cost of adding file permissions is **zero new vendors**.

### 6. Edge cases requiring explicit handling

17 identified; all handled or explicitly documented as unhandled.

1. Document row created but upload never completes → orphan row (compensating
   delete; test 26 asserts it is a 404, not a leak)
2. Upload succeeds but the process dies before the audit append → **unlogged
   upload**
3. Soft-deleted document with signed URLs still outstanding (test 28 — **not
   fixable**)
4. Object moved by revocation while another share link is mid-redemption
5. Path rotation invalidating unrelated live share links (test 18 — collateral,
   measured)
6. Filename containing `/`, `\`, `..`, or control characters (test 25)
7. Share link whose document was deleted after issuance
8. Failed password attempt must not consume a download (test 13)
9. Two concurrent redemptions of a link with 1 download remaining (test 14)
10. One redemption, then N fetches of the issued URL within its TTL (test 15 —
    **cap is not exactly enforceable**)
11. Member removed from org while holding a valid access token (test 9)
12. Admin attempting owner escalation (test 7)
13. Last-owner removal — **not handled**; needs a constraint trigger, RLS cannot
    count rows across the statement
14. Audit chain concurrency: two appends for one org race on `seq` (advisory
    lock per org)
15. Clock skew between the gateway and the storage service when the TTL is 30s
16. HTTP range requests / download managers issuing several GETs per "download"
17. CDN caching a signed-URL response past the revocation moment

### 7. Failure modes — open or closed

| # | Failure | Direction | Note |
|---|---|---|---|
| 1 | Policy missing entirely | **CLOSED** | RLS default-deny. Supabase's biggest structural win. |
| 2 | `WITH CHECK` omitted on UPDATE | **CLOSED** | Postgres reuses `USING`. |
| 3 | Typo in a policy predicate | **CLOSED** (usually) | Restrictive typos break the app loudly. |
| 4 | `documents_read` hides post-update row | **CLOSED** | Errors. Confusing, but safe. |
| 5 | SECURITY DEFINER fn raises | **CLOSED** | Statement aborts. |
| 6 | Postgres unreachable | **CLOSED** | No reads at all. |
| 7 | Share gateway down | **CLOSED** | Share links stop working. |
| 8 | Audit append fails after bytes served | **OPEN (audit)** | Download happened, no record. Mitigated by logging before serving. |
| 9 | **Bucket created public** | **OPEN** | Total. Silent. One boolean. |
| 10 | **Service key leaked** | **OPEN** | `BYPASSRLS`. Total, cross-tenant, and it also lets the holder rewrite the audit chain. |
| 11 | **Signed URL leaked/forwarded** | **OPEN until `exp`** | No revocation exists. The core finding. |
| 12 | **JWT-claim RBAC after demotion** | **OPEN until token refresh** | Up to 1h by default. Avoided in this build. |
| 13 | Missing index on `documents(storage_path)` | CLOSED (perf) | Correct but slow; degrades under load. |
| 14 | Client-supplied path accepted by the gateway | **OPEN** | Developer error, RLS already bypassed. |
| 15 | Missing column GRANT on `share_links` | **OPEN** | Cap and expiry become advisory. |

Score: **7 closed, 6 open, 2 mixed.** Crucially, *the closed ones are the
accidents* (forgot a policy, typo, service down) and *the open ones are the
decisions* (bucket visibility, key handling, signed-URL semantics). That is the
right way round. It is much better to have a platform where forgetting
something is safe and choosing wrongly is dangerous than the reverse.

### 8. Lifecycle complexity

- **Two writes per upload that cannot be atomic** — the `documents` row lives in
  Postgres, the object lives in S3 behind the Storage API. There is no
  transaction spanning them. Compensating delete on failure; orphans on crash.
- **Deletion is three-phase**: soft-delete the row (closes RLS immediately),
  delete the object (does *not* invalidate signed URLs), and there is no third
  phase that closes issued URLs. The docs warn explicitly that deleting
  `storage.objects` metadata directly leaves you billed for an unreachable
  object, so deletion must go through the API.
- **Path rotation as a revocation primitive mutates `documents.storage_path`**,
  which is the join key for four RLS policies. Any cached path anywhere is now
  wrong.
- **Audit chain is a per-org serialization point.** One advisory lock per
  append; throughput ceiling is one audit write per org per round-trip.
- **Schema migrations touch policies.** Adding a column to `documents` that
  affects visibility means revisiting every policy that reads it — and policies
  are not type-checked against each other.
- **`storage` schema is vendor-owned and must be treated as read-only**, so you
  cannot add a `revoked` column to `storage.objects` and reference it. All
  policy state has to live in your own tables and be joined in.

### 9. Revocation complexity — **the crux metric**

This deserves the most precision, so here is exactly what is and is not
possible, with test references.

**The primitive.** A Supabase signed URL is a stateless HS256 JWT with payload
`{url: "bucket/path", exp}`, signed with a **per-project storage key that is
deliberately separate from the Auth JWT key**. Redeeming one does not touch
Postgres. It therefore cannot consult a revocation flag, cannot check a
password, and cannot decrement a counter. Supabase says so plainly:

> "Signed URLs remain valid until their expiry time regardless of any Auth key
> changes. If you need to revoke signed URLs, contact Supabase support."
> — [Serving assets from Storage](https://supabase.com/docs/guides/storage/serving/downloads)

Rotating your Auth JWT secret, disabling legacy keys, moving HS256→ES256:
**none of it touches an issued signed URL.** The doc lists these explicitly as
things that do *not* affect signed URLs.

**Options actually available, honestly assessed:**

| Option | Immediate? | Cost | Verdict |
|---|---|---|---|
| Short TTL + re-issue | No — latency = TTL | Breaks "email a link to a client" | Partial |
| **Gateway in front (built here)** | **Yes at the gateway** | One more component; residual window = signed-URL TTL | **Best practical answer** |
| **Path rotation via `move()`** | **Yes, absolutely** | Invalidates *every* outstanding URL for that object; backend copy | **Real primitive, blunt** |
| Delete + re-upload | Yes | Nuclear; re-share everything | Last resort |
| Proxy every byte through an Edge Function | Yes | Egress cost, function limits, no CDN, RLS becomes decorative | Gives up the feature |
| Contact Supabase support | — | Human in the loop | Not a mechanism |

**What this baseline achieves, measured.**

The scenario says *"revocation takes effect immediately even for links already
issued."* We satisfy it — with one honest asterisk.

- Sharees never receive a storage URL. They receive a gateway URL. Revoking
  flips `revoked_at`; the very next redemption fails. **Immediate.** (test 16)
- The asterisk: a signed URL the gateway already minted and handed out remains
  valid for the rest of its TTL. With `SIGNED_URL_TTL_SEC = 30`, **the residual
  exposure window is 30 seconds.** Test 17 proves the URL still serves bytes
  after revocation, then advances the clock and proves it dies at `exp`.
- That window can be driven to **zero** with `mode: 'rotate'`, which moves the
  object so the path embedded in every outstanding token no longer matches.
  Test 18 proves the revoked link's URL dies instantly — **and** proves the
  collateral: an unrelated, still-live share link's already-issued URL dies too
  and must be re-minted.

So: **immediate revocation is achievable on Supabase, but only by building a
stateful gateway in front of the stateless primitive, and the last 30 seconds
of it costs you a blunt object-rename with collateral damage.** The platform
provides no revocation; the application provides all of it.

**And note what is *not* achievable at all:** test 28 shows that soft-deleting a
document does **not** invalidate signed URLs already issued for it. Under
Config A, any member can mint themselves a 7-day signed URL straight from the
browser (RLS permits it — they are entitled to read), and that URL survives
their removal from the org, the document's deletion, and every revocation you
perform. Config B closes this, at the price described above.

### 10. Sharing complexity — expiry + password + download cap

None of the three is provided by the platform. All three had to be built.

| Feature | Platform | Built | Exact? |
|---|---|---|---|
| Expiry | `createSignedUrl(path, expiresIn)` gives *URL* expiry | Separate `expires_at` on the link, checked at the gateway | Yes |
| Password | Nothing | PBKDF2-SHA256, 120k rounds, per-link salt, constant-time compare | Yes |
| Download cap | Nothing | Atomic `UPDATE … WHERE download_count < max_downloads RETURNING` | **No — see below** |

The two expiries are independent and must both be reasoned about: the link's
business expiry (`expires_at`, e.g. 7 days) and the signed URL's technical
expiry (30s). Confusing them is easy and only one of them is enforced by the
storage service.

**The download cap cannot be made exact.** Test 15 documents this: the gateway
counts *URL issuances*, not *byte deliveries*. One issuance yields a 30-second
bearer URL that can be fetched any number of times. A cap of 1 permitted 3
downloads in the test. Making it exact requires proxying every byte through the
function — Config B territory — and even then, HTTP range requests and download
managers issue multiple GETs per user-visible "download", so "download count"
remains a judgement call rather than a number the system can guarantee.

`share.js` is 105 net lines, of which roughly 60 exist purely because the
storage primitive is stateless.

### 11. Developer preference — honest subjective judgment

**I would be reasonably happy to build this, with reservations that are narrow
and specific.**

What is genuinely pleasant:

- Writing authorization as SQL predicates next to the data is *good*. The whole
  access-control surface is 194 net lines in two files that a reviewer can read
  top to bottom. I have reviewed far worse authorization stories with far more
  code.
- `select policyname, cmd, qual, with_check from pg_policies` is a complete,
  machine-readable inventory of every rule in the system. That is a real
  auditability property that imperative middleware does not have.
- Deny-by-default meant that every mistake I made during this build failed
  closed. I was never once in a state where a bug was silently leaking; I was
  repeatedly in a state where something was broken and obvious. That is the
  right failure mode and it made iteration fast.
- One vendor, one local stack. `supabase start` gives you the whole thing.

What I disliked, specifically:

- The RLS debugging experience is poor in one particular way: **the policy that
  raises the error is not always the policy that is wrong.** The `documents_read`
  incident cost more time than everything else combined, and `EXPLAIN` does not
  help because policies are inlined into the plan without attribution.
- Three different mechanisms enforce access on one table — RLS policies, column
  GRANTs, and `REVOKE EXECUTE` on functions — and nothing ties them together or
  tells you when you have used the wrong one. Discovering that the download cap
  needed a *column grant* rather than a policy was not obvious.
- Having to build a gateway to get password/cap/revocation, and then discovering
  that doing so makes my carefully written `storage.objects` read policy
  unreachable, was deflating. I wrote the best part of the system twice.

### 12. Willingness to maintain in production for 2 years

**Yes, with one condition.** I would sign up for this — with the condition that
the team commits up front to Config A or Config B and never drifts, because the
drift is invisible.

Reasoning for yes:

- The security surface is declarative and enumerable. In two years I can diff
  `pg_policies` against a golden file in CI and know nothing moved.
- Fail-closed defaults mean the 2-year risk is *availability* incidents, not
  *confidentiality* incidents. Someone tightening a policy breaks the app on
  Tuesday; someone forgetting a policy does not leak on Wednesday.
- No cross-vendor drift. One upgrade cadence.

Reasoning for the reservation:

- The four items in §7 that fail **open** are all things a new team member can
  do on their first week: create a bucket with the wrong visibility, paste the
  service key somewhere, hand a client a long-lived signed URL, add a column
  grant too broadly. None of them break a test.
- The audit trail's completeness is a matter of developer discipline, not
  enforcement. In Config A, "every download is recorded" is false the moment
  anyone calls `supabase.storage.from('vault').download()` from a component. In
  two years, someone will.
- The signed-URL revocation gap does not improve with time and is not on
  anyone's roadmap. It is a property of the design.

If the compliance requirement is "every access recorded, revocation is
instant," I would run **Config B** and accept that the RLS policies are then
belt-and-braces rather than the enforcement point. I would still write them.

---

## Where this approach is genuinely good

Stated without hedging, because these are real and a dedicated file layer does
not automatically beat them.

**1. It fails closed, and that is worth more than any feature.**
No policy means no access. A typo means an outage, not a breach. Every single
mistake made during this implementation — and there were several — surfaced as
a failing test or an error, never as a silent leak. A file service that enforces
permissions in application code has to *earn* that property; Postgres gives it
away.

**2. The entire authorization surface is declarative, centralised, and
queryable.**
19 policies in one reviewable file. `select * from pg_policies` is a complete
inventory that can be diffed in CI, shown to an auditor, or reasoned about
without reading a line of application logic. No imperative permission system
offers this. It is genuinely excellent and I want to say so loudly.

**3. Authorization lives next to the data it protects, so it cannot be
bypassed by a new code path.**
The policies apply to PostgREST, to the Storage API, to a psql session, to a
cron job, to an intern's ad-hoc script. There is no "we forgot to add the check
to the new endpoint" failure, because there is no endpoint-level check to
forget. This is a structurally stronger position than middleware.

**4. One vendor, and probably one you already have.**
The marginal cost of adding permissioned file storage to an app that already
uses Supabase Postgres is: create a bucket, write policies in the same file you
already write policies in. No new vendor, no new bill, no new IAM model, no
new local dev dependency. For a large fraction of teams this is decisive and
it would be dishonest to pretend otherwise.

**5. The org-role model is expressed elegantly.**
`public.org_role_of()` / `is_org_admin()` / `can_read_document()` compose
cleanly, and once the kernel exists, adding a role or a new resource type is a
few lines. Four-role RBAC across two resource types took ~90 net lines
including comments. That is *good*, not merely adequate.

**6. Cross-tenant isolation is strong and easy to verify.**
Tests 1–4 attack from an authenticated user in another org, from `anon`, via
direct SQL, via object move, via forged document rows, and via the signing API.
Every one returns zero rows or an error. Once the policies are right, the
isolation is enforced by the database rather than by remembering to add
`where org_id = ?` to 40 queries — and the tests to prove it are short.

**7. Column-level GRANTs are a real, underused tool.**
`grant update (revoked_at) on share_links to authenticated` solves
field-level immutability in one line, with database enforcement. Most
application frameworks have no equivalent.

**8. Postgres reuses `USING` as `WITH CHECK` when you omit it.**
A thoughtful default that turns one of the most plausible policy mistakes into
a non-event.

---

## What could NOT be implemented, and why

1. **Revocation of an already-issued Supabase signed URL.** Impossible at the
   application level. The token is stateless and validated against a
   project-level key that Supabase does not expose for rotation; the docs direct
   you to support. Mitigated (not solved) by the gateway + 30s TTL, and closable
   to zero only by renaming the object, which has collateral. *Test 17, 18.*

2. **An exact download cap.** The gateway can count URL issuances but not byte
   deliveries. A cap of 1 permitted 3 fetches in test 15. Exactness requires
   proxying bytes, and even then HTTP range requests make "one download"
   ill-defined.

3. **A complete audit trail without giving up RLS as the enforcement point.**
   Config A leaks reads around the application (test 23); Config B fixes it by
   making the RLS read policy unreachable (test 24). Both were implemented; the
   scenario cannot be fully satisfied by either.

4. **Tamper-*proof* audit.** The chain is tamper-**evident** — test 22 shows
   edits and deletions are both detected. It is not tamper-resistant against a
   `service_role` key holder, who has `BYPASSRLS` and can rewrite entries and
   recompute every downstream hash. Closing this needs the head hash anchored
   outside the project (a second account, a WORM bucket, a notary).
   `public.audit_head()` is provided as the hook; the anchoring itself is not
   implemented because it is not a Supabase feature.

5. **"Last owner cannot be removed."** RLS evaluates per row and cannot count
   remaining rows across a statement. Needs a deferred constraint trigger.
   Left unimplemented and flagged.

6. **Signed-URL revocation on document deletion.** Test 28: a deleted document's
   outstanding signed URLs keep serving bytes. Same root cause as (1).

---

## Fidelity of the harness — what is real and what is emulated

**Real:** PostgreSQL 18. RLS engine. `SET LOCAL ROLE`. `request.jwt.claims` GUC.
Role grants and column grants. `SECURITY DEFINER` semantics. `BYPASSRLS` on
`service_role`. Advisory locks. `sha256()`. Every policy in
`20_rls_policies.sql`, `25_config_b_lockdown.sql` and `30_audit.sql` is compiled
and executed by Postgres exactly as written — including the cross-tenant attacks.

**Emulated** (`sql/00_platform_emulation.sql`, `src/platform/supabase.js`, both
excluded from LOC): the `auth` helper functions, the `storage` schema and helper
functions, the Storage HTTP API, and signed-URL minting/verification. Each is
modelled from the doc pages cited above; the signed-URL verifier performs no DB
lookup and no RLS evaluation, which is the documented behaviour and the single
most consequential emulation decision.

**Not modelled:** network latency, CDN cache behaviour, Edge Function cold
starts and the 20MB/CPU limits, S3 durability semantics, and the real Storage
service's exact operation-name set (the two documented helpers are implemented
with the documented normalisation rules). None of these affect the security
conclusions; the CDN one would make the revocation window slightly *worse* in
production than the 30s measured here.
