# ARCHITECTURE-PROGRESSIVE.md

**Does the Filelayer primitive scale DOWN as well as up?**

Current as of `@filelayer/core` **0.3.0**. Everything below is measured against
code in this repository, from the repository root. Reproduce with:

```bash
npm run bootstrap                  # npm ci in packages/core
npm test                           # 313 tests, 0 failures
npm run dev:fracture               # the four §2 experiments
npm run loc:tiers                  # LOC per tier (§4.2)
node benchmark/count-loc.mjs       # LOC for the full-vault implementations
node benchmark/count-decisions.mjs # security-sensitive decisions (§4.3)
npm run example:tier1              # / :tier2 / :tier3 / :vault — all four run
```

**Test status.** `npm test` is **313 / 313 passing** across 68 suites:

| Suite | Tests |
|---|---|
| `test/tiers.test.ts` — the tiered API, and §3 below | 27 |
| `test/group-subjects.test.ts` — `org` and `role` grant subjects | 49 |
| everything else — authorization, delivery, listing, persistence, storage, semantics, the vault example | 237 |
| **total** | **313** |

Reproduce a single suite with
`node --test --experimental-strip-types packages/core/test/tiers.test.ts`.

*A note on method:* the tiered API in `packages/core/src/simple.ts` is a facade
over the same delivery layer the rest of the library uses. It does not carry a
second copy of `delivery.ts`, and every property below is re-asserted against
the tiered surface rather than assumed from the verbose one — a property that
holds only when you use the long-form API is not a property this library has.

---

## 0. THE ANSWER, FIRST

**The architecture does not fracture.** The simple case is reachable with
**zero schema changes** and **zero changes to the authorization engine**. The
tiered API in `packages/core/src/simple.ts` is a facade over the existing
`Filelayer` class; it contains no authorization logic and adds no table,
column, constraint or code path to `authz.ts`.

That is the good news and it is genuinely good: the original design decisions
have not painted the library into a documents-and-compliance corner from which
the simple cases are unreachable.

**The bad news, up front and quantified: we lose tier 1 on lines of code.**
A public avatar costs **16 net lines** on Filelayer against **10** on Supabase —
we are **1.6× worse**. We are better than raw S3 (14 app lines + 36 lines of
bucket policy + turning off Block Public Access), but Supabase is the honest
comparison for this workload and Supabase wins it. Details in §4.

One finding stands on its own: the obvious way to make the org optional —
`file.org_id NULL` — **silently deletes P3 and referential integrity at the
same time**. It is measured in §2, and it is a permanently closed door rather
than a trade-off anyone gets to reopen.

---

## 1. THE TIER MODEL

Each tier adds exactly one concept. No tier pays for a concept it does not use.

| Tier | New concept | The whole API |
|---|---|---|
| **1** Public file | — | `fl.files.put(bytes, { public: true })` → `{ url }` |
| **2** User-owned private file | owner | `+ { owner: userId }`, `fl.files.get(id, { as: userId })` |
| **3** Multi-tenant + roles | org, role | `+ { org: tenantId }`, `fl.orgs.create/setRole` |
| **4** Full Vault | grant | `fl.shares.create/revoke/redeem`, `fl.orgs.audit` |
| **5** Scale | — | partly built; see §6 |

The concepts are cumulative and the *calls* are stable. Promoting an app from
tier 2 to tier 3 is adding `org:` to a `put`, not migrating a data model. This
is asserted mechanically, not claimed: `test/tiers.test.ts`,
*"a tier-1 file can be promoted to tier 4 without moving it"* takes one file id
through all four tiers without moving a byte.

### What the tiers are NOT

They are not four products, four schemas or four code paths. There is one
`file` table, one `authz.ts`, one audit chain. `fl.files.put()` calls
`fl.upload()` calls `authorizeOrg('create_file')`. A tier-1 avatar and a tier-4
board deck are the same row shape and are authorized by the same function.

---

## 2. THE FRACTURE ASSESSMENT

Four experiments. `npm run dev:fracture` reproduces all of them against the
current tree.

### 2.1 What did the simple case cost before the tiered API existed?

```
API calls before the first public byte : 4
Concepts the developer must understand : 5  (actor, org, membership, upload, grant)
Anonymous read works                   : true
```

Four calls — `createActor`, `createOrg`, `upload`, `share` — and at the end of
them you still have no URL, because there was no delivery route for a public
file. Four calls and five concepts to publish one image is not a defensible
price for a library whose pitch is that it removes decisions.

Note carefully what this experiment also shows: it **worked**. The model could
already express a public file. The problem was ergonomics, not capability. That
distinction is the whole fracture assessment.

### 2.2 Can a file exist without an org? — **NO, and it must not**

This is the load-bearing finding.

P3 ("tenant isolation is structural, not conditional") rests on one composite
foreign key:

```sql
FOREIGN KEY (file_id, org_id) REFERENCES file (id, org_id)
```

SQL's default `MATCH SIMPLE` semantics say: **if any column of a composite
foreign key is NULL, the constraint is not checked at all.** So making `org_id`
nullable does not "relax" P3 for files that opt out — it turns the check off
entirely for those rows. Measured, on the real Postgres semantics PGlite gives
us:

| INSERT attempted | `org_id NOT NULL` (today) | `org_id NULL` (proposed) |
|---|---|---|
| grant on a file in org A, `org_id` = org B | rejected | rejected |
| grant on a file in org A, `org_id` = NULL | **unrepresentable** | **ACCEPTED** |
| grant on a file that **does not exist**, `org_id` = NULL | **unrepresentable** | **ACCEPTED** |

The third row is the one to look at. A nullable `org_id` does not merely weaken
tenant isolation; it lets a grant reference a file that has never existed, with
no error, from any writer. That is not a trade-off, it is a defect, and it
would be invisible until an incident.

**Decision: `file.org_id` stays `NOT NULL`. Permanently.** The three options
were:

| Option | Verdict |
|---|---|
| Nullable `org_id` | **Rejected.** Silently disables P3 *and* referential integrity (measured above). |
| A separate "personal scope" table | **Rejected.** A second scope means a second authorization path, and the second path is always the one that leaks. It also forks the schema into "simple rows" and "real rows", which is the fracture this assessment exists to avoid. |
| **A default org, auto-provisioned** | **Adopted.** Zero schema change. The "no org" experience is a real org with a real UUID and a reserved `external_id` (`__filelayer_workspace__`), created on first use. |

The default org also keeps metering coherent. `schema.sql` meters per org and
per file-owning user per day (`usage_daily`, `file_owning_user_daily`); for a
single-tenant application the default workspace **is** the tenant, so the unit
that is counted needs no special case for "files that belong to no org".

Asserted in `test/tiers.test.ts`: *"every tiered file still carries a non-null
org_id"* writes files at tiers 1, 2 and 3 and then counts
`SELECT count(*) FROM file WHERE org_id IS NULL` — must be 0.

### 2.3 Is `visibility: 'public'` expressible? — **YES, with P1 fully intact**

P1 says there is no public boolean; public delivery is an explicitly created,
individually revocable, individually auditable `anonymous` grant row. The
question was whether that makes the simple case awkward.

It does not. `{ public: true }` is **one line of sugar that creates exactly that
row**. There is still no `file.public` column and there never will be — asserted
by a test that reads `information_schema.columns` and fails if one appears.

The trade is strongly in our favour and is the one place where tier 1 beats the
alternatives outright:

```
anonymous read while grant is live  : true
anonymous read after grant revoked  : false     [P4: revocation beats the URL]
```

`fl.files.unpublish(id)` makes a URL that has been printed, indexed, cached in
a Slack unfurl and pasted into a support ticket stop working **on the next
request**, without deleting the file, rotating a key or purging a CDN. Neither
`s3:GetObject` on a public bucket nor Supabase's `getPublicUrl()` can do this —
`getPublicUrl` is offline string concatenation, so there is no request for a
decision to be made on. Deleting the object is their only withdrawal mechanism.

**P1 is preserved with a one-line ergonomic on top.** No property was traded to
get it.

### 2.4 Does actor registration make the trivial case unusable? — **It did; it doesn't now**

`org.external_id` and `actor.external_id` each carry a uniqueness constraint, so
get-or-create is `INSERT ... ON CONFLICT`: a query change, not a schema change.
(The constraint is on `(project_id, external_id)` rather than `external_id`
alone — see §7 — but the `ON CONFLICT` argument is the same either way.)

Two rules were added to keep this from becoming an ambient-authority hole, and
both are tested:

1. **Writes provision, reads never do.** `put({ owner: 'alice' })` registers
   alice. `get(id, { as: 'alice' })` does not. An `as:` naming an unknown user
   is a **404**, never a silent demotion to an anonymous principal. That
   fallback is the single most tempting shortcut in a "simple mode" and it would
   turn a typo in a user id into a read of every public file plus an audit trail
   attributed to nobody.
2. **Auto-provisioning grants an identity, never a permission.** An
   auto-registered user gets `member`, and `member` + the default `private`
   visibility means *their own files and nothing else*. `ON CONFLICT DO NOTHING`
   — not `DO UPDATE` — so an implicit upload can never demote an admin a
   developer deliberately promoted.

---

## 3. THE SECURITY PROPERTIES, RE-ASSERTED AT EACH TIER

The whole risk of a simple mode is that it buys its simplicity by turning a
property off. Every property is therefore re-tested **against the tiered
surface**, because a property that holds only when you use the verbose API is
not a property this library has.

| Property | Tier where first exposed | Test |
|---|---|---|
| P1 no public boolean | 1 | `information_schema` scan: no `public`/`is_public` column; exactly one `anonymous` grant with `{read}` |
| P1 deny by default | 1 | a non-public file returns **404** from the public route (not 403 — the route is not an existence oracle) |
| P4 URL ≤ permission | 1 | `unpublish()` → same URL, same process, 404 on the next request; bytes still readable by an authorized caller |
| P2 no ambient authority | 2 | an anonymous caller holding the file id gets nothing; an unknown `as:` is denied, not demoted |
| P1 at the file boundary | 2 | bob cannot read alice's file, and gets 404 not 403 |
| P3 structural isolation | 3 | a file in `acme` is unreachable by a member of `globex`; no file has a NULL `org_id` |
| no privilege escalation | 3 | a viewer cannot promote themselves *through the tiered API either*; `as:` is required on `orgs.setRole` and is not defaulted |
| service identity is not a back door | 3 | an unowned `put` into a **named** org makes the service identity a `member`, not an admin, so it cannot read that tenant's private documents |
| P5 audit completeness | 4 | denials recorded; hash chain verifies; audit unreadable by a non-admin |
| P4 transitive | 4 | revoke → redeem fails immediately |

**27 tests, all passing.** Nothing was weakened to make tier 1 pretty, and no
tier-1 ergonomic required breaking a property.

Since this assessment was first written, group grant subjects landed:
`subject_type` now also takes `org` and `role`, and the tiered API exposes them
as `fl.shares.create(id, { as, withOrg, minRole })`. They do not add a tier.
Two properties matter and both are asserted in
`packages/core/test/group-subjects.test.ts` (49 tests):

- **Resolution is a join, never a materialization.** Adding or removing an org
  member changes access on the very next request, with no grant row rewritten —
  so a group grant cannot drift away from the membership it names.
- **Subject breadth may not be amplified by delegation.** An issuer whose own
  authority came from a grant may mint only `actor` or `link` subjects; only
  role-derived authority may mint a group subject. Enforced in `authorizeShare()`
  and again by a `BEFORE INSERT`/`UPDATE` trigger, so it binds raw SQL too.

The one property trade in the whole design is not a tier-1 ergonomic but a
delivery choice, and it is opt-in rather than default: **redirect delivery**
hands out a short-lived presigned URL instead of proxying bytes, which buys a
CDN and costs a bounded revocation window. It is off by default, is restricted
to anonymous grants unless deliberately widened, clamps its TTL to 300 seconds,
and will not typecheck without a verbatim acknowledgement string. §6 is the
analysis; `packages/core/SEMANTICS.md` is the specification.

### The one thing deliberately NOT simplified

`fl.orgs.setRole(org, user, role, { as })` — `as` is required and has no
default. Membership is the privilege that confers every other privilege, and
there is no convenience worth an unauthorized path to it. The tiered API is
deliberately no shorter than the full API here.

---

## 4. LINES OF CODE — INCLUDING WHERE WE LOSE

### 4.1 The headline: a public avatar

Counted by the rule `benchmark/count-loc.mjs` applies to every implementation in
this repository: **net = lines that are neither blank nor comment-only.** The
four tier-1 files are short enough to check by eye, and the same predicate as a
one-liner is:

```bash
grep -cvE '^\s*(//|/\*|\*|$)' benchmark/tier1-avatar/src/*.js \
                              benchmark/tier1-avatar/infra/*.json
```

| Implementation | app LOC | infra LOC | config steps | can revoke a live URL? |
|---|---|---|---|---|
| **Filelayer — upload only** | **6** | 0 | 3 | yes |
| **Filelayer — upload + serving** | **16** | 0 | 3 | yes |
| Supabase public bucket | **10** | 0 (dashboard) | 2 | **no** |
| Raw S3 public bucket | **14** | **36** | 4+ | **no** |

Sources: `benchmark/tier1-avatar/src/*.js`. The S3 and Supabase files are not
executed (they need live credentials / a live project) and are counted only;
they are written as an experienced developer would write them, with no error
handling on any side, so the comparison is like for like.

**Read the table honestly, in the order that matters:**

- **On the upload half we win: 6 lines vs Supabase's 10 vs S3's 14.**
- **On the complete path we lose to Supabase: 16 vs 10 — 1.6×, or +6 lines.**
  The whole difference is the 10-line serving route. S3 and Supabase hand you a
  CDN-backed origin for free; we do not have one, so we pay for it in the
  developer's file.
- Against raw S3 we win on the complete path (16 vs 14 app + 36 infra = 50), but
  raw S3 is not what a developer reaches for to store an avatar in 2026. Beating
  it is not an achievement.

**Supabase is the correct comparison for tier 1 and Supabase wins it.** This is
measured rather than hidden: Filelayer is 60% more code for a public avatar, and
Supabase's version also arrives with a CDN, image transformations, range
requests and a browser-side upload widget that Filelayer does not have.

What the 6 extra lines buy is exactly one property: `unpublish()`. For a
developer whose whole problem is avatars, that is **probably not worth it** —
a presigned URL from an object store is the boring, correct answer for public
media, and nothing here changes that. Tier 1 exists so the architecture does not
*exclude* the simple case, not because Filelayer is the best tool for it.

### 4.2 LOC per tier

`npm run loc:tiers`:

```
tier                            gross    net  imports   boot   core
--------------------------------------------------------------------
tier 1  public avatar             55     24        2      5     17
tier 2  user-owned private        58     30        2      7     21
tier 3  orgs + roles              44     24        1      9     14
tier 4  full vault, over HTTP    208    133        2      6    125
```

`core` = net minus imports minus the demo boot block.

Two honesty notes. **First, the curve is not monotonic and that is a
measurement artefact, not a property**: tier 3 is smaller than tier 2 because
tier 2 ships an HTTP app and tier 3 does not — they demonstrate different
things. The comparable number is `core` for the *same* app shape, which is the
tier-1 table in §4.1. **Second, tier 4's 125 lines are almost entirely a
hand-rolled HTTP router**; the Filelayer-shaped content of that file is 12 API
calls and 0 authorization rules. Both verified mechanically, and both still
hold — re-run them against `examples/vault/server.ts`:

```bash
grep -oE 'files\.[a-zA-Z]+\(' examples/vault/server.ts | wc -l   # 13
grep -cE 'if \(.*(actorId|principal|role|owner).*\)' examples/vault/server.ts  # 0
```

One of the 13 is an `Array.prototype.map`, so the API-call count is **12**.

### 4.3 The number that actually matters

A **security-sensitive decision** is a point where (a) at least two
implementations are available to the developer, (b) at least one of them results
in unauthorized access, data loss or disclosure, and (c) the wrong choice
produces no error, no failing test, no warning and no observable difference
during normal operation. The test is *silence*, not severity. That definition,
the enumerated decision list for all five implementations, and a reason for
every judgement call, are in `benchmark/decisions.json`; the count is
`node benchmark/count-decisions.mjs`.

For the **full vault** — the only workload where all five implementations exist
and are therefore comparable under one convention:

| Implementation | distinct kinds | places to get right |
|---|---:|---:|
| **Filelayer** | **8** | **8** |
| Convex + R2 | 20 | 43 |
| Vercel Blob | 22 | 61 |
| raw S3 + Postgres | 26 | 46 |
| Supabase + RLS | 29 | 79 |

Median reduction: **3.0×** on kinds, **6.7×** on places. Two of Filelayer's
decisions are marked arguable in `decisions.json`; count them all and the
medians fall to 2.4× and 5.3×. Two of the four comparison implementations have
never been executed, so their counts are probably undercounts — an asymmetry
that flatters nobody here and is left in place rather than corrected away.

At tiers 1–3 there is no comparable implementation to count, so these are
enumerated by hand under the same convention:

| Tier | Decisions on Filelayer | Decisions on the equivalent S3/Supabase build |
|---|---|---|
| 1 public avatar | **1** (is the object store private?) | ≥3 (Block Public Access off; bucket policy scope; is *this* the bucket for public content?) |
| 2 user files | **1** | ≥5 (+ the ownership predicate; + whether the signed-URL TTL outlives the session) |
| 3 orgs + roles | **1** | ≥9 (+ the tenant predicate in every policy, + role table) |

The tier-1 count is 1 on both axes of the product's claim: Filelayer never asks
the developer to decide who may read a file, at any tier.

---

## 5. WHERE FILELAYER IS *NOT* WORTH USING TODAY

Written by the people who built it. This section is meant to be quoted against
Filelayer, and it is kept current on purpose: every item below was re-checked
against `0.3.0`.

1. **Public, high-volume, cacheable media — avatars, marketing images, product
   photos, anything a CDN should serve.** The default byte path proxies every
   read through an authorization check that, for a public file, always says yes,
   so you pay origin egress and origin CPU for content that has no access
   control to enforce. Redirect delivery (§6) removes the proxy for exactly this
   case and is the right answer if you enable it, but it is opt-in, and it does
   not give you transformations or a media pipeline. Tier 1 exists so the
   architecture does not exclude these workloads, **not** because Filelayer is
   the right answer for them. Use a CDN-backed bucket. Come back when you need to
   un-publish something.

2. **Very large files.** `upload()` now accepts a `ReadableStream`, so the core
   path no longer holds the whole object in memory. Two gaps remain: the tiered
   facade `fl.files.put()` still takes a `Uint8Array`, so anything put through
   the ergonomic entry point is fully resident; and there is still **no multipart
   or resumable upload**, so a failed 2 GB upload restarts from zero. Use
   `fl.upload()` with a stream above a few tens of megabytes, and do not use
   either for uploads that must survive a dropped connection. See §6.

3. **Video and audio seeking in a browser.** The storage and delivery APIs
   accept a byte range and the S3/R2 adapter honours it, but the **shipped HTTP
   route helpers** (`fileDownloadRoute()`, `shareDownloadRoute()`) do not parse
   the `Range` request header and never return `206 Partial Content`. A browser
   cannot seek in a file served by them. The pieces exist; the route that would
   assemble them does not. See §6.

4. **Direct browser upload.** Every byte goes through your server. Supabase,
   Vercel Blob and presigned S3 all let the browser talk to storage directly;
   Filelayer has no such path, and adding one means issuing a credential that
   outlives the request, which is in tension with P4.

5. **Image transformation, thumbnails, format negotiation.** None. Cloudinary,
   imgix and Supabase all have it.

6. **Multi-process deployments, with a caveat you should read.** The audit hash
   chain used to be built with `SELECT`-then-`INSERT` from application code,
   which forks under concurrent writers. It is now a single `audit_append()`
   call that takes `pg_advisory_xact_lock` on the chain, reads the predecessor
   and inserts, in one statement, in the same transaction as the mutation it
   describes. The caveat: the test suite runs on PGlite, which has exactly one
   backend, so the suite proves the lock is *taken* — it cannot prove the
   multi-process behaviour. That argument rests on documented PostgreSQL
   advisory-lock semantics and has not been executed against a real multi-process
   deployment, because nobody has run one.

7. **"Not even the admin can read it."** Under `visibility: 'private'` org
   admins and owners retain access, deliberately, because retention and legal
   hold are their responsibility. If you need to exclude the operator you need
   envelope encryption, which is not an authorization feature and Filelayer does
   not have it.

8. **`maxDownloads` as a per-request meter.** A download is now charged whenever
   bytes leave through a grant, on any path and by any principal — not only on
   share-link redemption. Two exclusions are deliberate and must not surprise
   you: authority derived from an **org role** is not charged (a role is not a
   metered credential, so an admin reading a file forever does not exhaust a
   cap), and metadata reads are not charged because no bytes leave. If ranged
   responses are ever added to the shipped routes, one viewing of a video will be
   many requests through one grant, and the field will have to mean *sessions*
   rather than *requests* — see §6 and the note in
   `architecture/TIER5-DESIGN-NOTE.md` §1.3.

9. **Anything that needs the S3/R2 adapter to be proven.** It has never been run
   against live AWS or Cloudflare credentials. It is exercised against a local
   implementation that verifies SigV4 signatures, which is not the same thing.

**The honest summary:** Filelayer is worth its overhead when files are private,
multi-tenant, and their permissions change over time. It is not worth it when
files are public, large, streamed, or transformed — which is most of the
internet by bytes, and a small fraction of it by incident reports.

---

## 6. TIER 5 — WHAT WOULD BREAK, AND WHAT WOULD NOT

The question this section answers is whether the tier 1–4 design *precludes*
tier 5, not whether tier 5 is finished. It is not: streaming reads and an
opt-in redirect byte path have since landed, `206` responses from the shipped
routes, multipart upload and processing hooks have not. The full note, item by
item, is
[`architecture/TIER5-DESIGN-NOTE.md`](architecture/TIER5-DESIGN-NOTE.md). The
conclusion:

**The authorization model does not break. The data plane does.** Every tier-5
capability is a byte-path problem, and the byte path is the one part of the
system that is deliberately ignorant of authorization (P2). Nothing in
`authz.ts`, `schema.sql` or the grant model has to change for any of the five
capabilities listed.

The one genuine architectural conflict is worth stating plainly:

> **A CDN cache is a copy of an authorization decision, and a copy of a decision
> outlives the decision.** With a 300-second edge TTL, `unpublish()` stops
> working for up to 300 seconds. P4 degrades from "immediate" to "eventually".

Can the current design accommodate both? **Yes, and cleanly**, because the grant
model already says exactly which files are safe to cache:

- a file whose only live grant is `anonymous` is, by definition, readable by
  everyone — so an edge cache reveals nothing the origin would not;
- a file reachable via an `actor`, `org`, `role` or `link` grant must never be
  cached, because the cache would answer the request instead of the origin, and
  then P4 (revocation), P5 (audit) and P6 (the download counter) all die.

That partition is **derivable from the schema**, not bolted on: it is
`subject_type = 'anonymous'` and nothing else, and it stayed one predicate when
the subject enum grew from three values to five. So a mixed data plane —
cacheable public path, always-proxied private path — is expressible without a
schema change. What it costs is bounded, and the bound is a number someone has
to choose:

| Edge TTL | Public egress cost | `unpublish()` latency |
|---|---|---|
| 0 (the default) | full proxy cost | immediate |
| 60 s | ~1/60 of origin reads | up to 60 s |
| 300 s | ~1/300 | up to 300 s |

**What shipped, and what did not.** `deliveryHeaders()` still emits
`private, no-store, no-cache, must-revalidate, max-age=0` on the proxied path,
unconditionally — Filelayer does not ship a cacheable public route and there is
no TTL knob. What 0.3.0 added instead is **redirect delivery**: an opt-in mode
that authorizes the request as usual, audits it as usual, and then answers `302`
to a short-lived presigned URL so the bytes never traverse this process. The
trade is the same one the table above prices, made explicit rather than
implicit:

- revocation stays immediate at *decision* time — after a revoke, no new
  redirect is issued — but a URL handed out one second earlier remains valid at
  the object store for the remainder of its TTL, and no one can recall it;
- the TTL defaults to 60 s and is **clamped** to 300 s whatever you pass;
- only `anonymous` grants are redirected unless you widen the scope
  deliberately, so the default residual window is a window onto something you
  already published;
- the configuration will not typecheck without a verbatim acknowledgement
  string, and every redirected delivery writes an audit event recording the
  mode, the TTL and the resulting window — so "which deliveries left our
  control?" is answerable from the log rather than from a config file.

That is a deliberately awkward API for a deliberately consequential choice. The
default remains the property, not the economics.

---

## 7. DEFECTS THIS ASSESSMENT FOUND

Three findings came out of writing the tier model rather than out of using it.
All three are in [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md),
which is the public index of everything that has moved.

**The content-type neutralisation in `deliveryHeaders()` was dead code. FIXED.**
Found by `test/tiers.test.ts`, *"active content is served inert"*. The function
downgrades an active type (`image/svg+xml`) from `inline` to `attachment`, then
passed the *already-corrected* disposition to `safeContentType()`, whose
neutralisation branch only fires on `inline`. The branch could therefore never
execute. Impact is low — `Content-Disposition: attachment` plus `nosniff`
already defeats current browsers, so this was defence-in-depth that silently
did not apply — but it is exactly the class of bug that a test asserting the
*outcome* catches and a test asserting the *implementation* does not. One-line
fix: evaluate against the requested disposition.

**The metering table had no writers. FIXED.** `schema.sql` declares
`file_owning_user_daily` — distinct actors who owned or accessed a file on a
given day — as the unit the library meters on, and `grep` found **zero**
writers for it. A metering table that is never written is worse than no table,
because it looks like evidence. `PostgresStore.recordFileOwner()` now writes it
from `upload()`, idempotently per (org, day, actor), in the same transaction.
Asserted in `test/tiers.test.ts`.

**Identifier uniqueness was global, not scoped. FIXED, with a residual.**
`actor.external_id` and `org.external_id` were globally `UNIQUE`, which meant
that in any deployment where two applications share a database, application B
calling `put({ org: 'acme' })` silently received application A's org — a
cross-tenant compromise reachable from the most ergonomic entry point in the
library. Fixed in `0.3.0` by introducing a **project** scope above the tenant,
so a cross-project row is unrepresentable rather than merely unlikely; the
migration is `MIGRATIONS.md` entry 1. **The residual, stated because it is still
true:** identifiers are unique per *project*, not per org. Two orgs inside one
project cannot both have a user called `alice` meaning different people, which
is wrong for a reseller whose tenants bring their own identity providers. The
fix is `(org_id, external_id)` uniqueness — another breaking schema change — so
it is reported rather than taken.

---

## 8. VERDICT

| Question | Answer |
|---|---|
| Does the architecture fracture? | **No.** Zero schema change, zero authz change, purely additive facade. |
| Can a file exist without an org? | No, and it must not — nullable `org_id` silently voids P3 *and* referential integrity. A default org solves the ergonomics with no structural cost. |
| Is `public` expressible under P1? | Yes, as a one-line ergonomic over the existing anonymous grant. P1 fully preserved. |
| Does actor registration break the trivial case? | It did. Fixed by upsert-on-write, never-provision-on-read. |
| Did any tier-1 ergonomic require weakening a security property? | **No.** |
| Does Filelayer win tier 1? | **No.** 16 LOC against Supabase's 10. It wins the upload half, loses the serving half, and loses overall by 60%. |
| Is tier 5 precluded? | No. Every tier-5 capability is a data-plane problem; the authorization model is untouched. The CDN/P4 trade-off is real and bounded, and `0.3.0` takes it only as an opt-in mode with a clamped TTL — never as a default. |
