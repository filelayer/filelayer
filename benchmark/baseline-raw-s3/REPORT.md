# Baseline 1 — Raw S3/R2 presigned URLs + Postgres

**Scenario:** Vault (fixed, unmodified).
**Status:** Implemented and **executed**. 9/9 tests pass (`npm test`).
**Date:** 2026-09-05.

> **My loyalty in this report is to the baseline, not to Filelayer.** Where
> this architecture is good I have said so and shown why. The one requirement
> it cannot meet is stated precisely, with the AWS documentation that says so.

---

## Verdict in one paragraph

For the parts of this scenario that presigned URLs are *for* — getting bytes
in and out of storage without them touching your app server, for a caller you
have already authenticated — presigned URLs are excellent and the community
advice is correct. They are simple, fast, cheap, well-documented and hard to
get subtly wrong on the happy path. The advice breaks down at exactly one
place: **an already-issued presigned URL cannot be revoked.** Because the Vault
scenario requires immediate revocation of already-issued share links, the share
path cannot use presigned URLs at all and must proxy bytes through the
application. That is not a flaw in S3; it is a straightforward consequence of
what a bearer token is. But it means "just use presigned URLs" is an answer to
a *different question* than the one this scenario asks, and a team that adopts
it wholesale ships a revocation feature that does not work.

---

## How to run

```bash
cd benchmark/baseline-raw-s3
npm install
npm test     # 9/9 pass
npm run loc  # reproduces the LOC table below
```

Tests run against a real `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
client talking to `test/local-s3.mjs`, a minimal object store that performs
**genuine SigV4 verification of presigned query-string URLs** including expiry
enforcement, and supports access-key deactivation so the AWS-documented
revocation mitigation can be exercised. The application code is unmodified AWS
SDK usage and would run against S3 or R2 by changing `endpoint` only.

---

## The twelve metrics

### 1. Implementation time

| Phase | Elapsed |
|---|---|
| Research (AWS presigned-URL guidance, revocation, `s3:signatureAge`) | 4 min |
| Schema, authz, audit chain, storage, routes | 5 min |
| Test harness (SigV4-verifying S3) + 9-test suite | included above |
| Debug to green | 1 iteration, 1 min (a wrong assertion in my own test) |
| Infra config + this report | 12 min |
| **Total actual working time** | **~22 min** |

That number is an AI agent's wall clock and is not directly comparable to human
effort. **Calibrated senior-engineer estimate: 3–5 working days.** Basis: ~700
lines of application code is roughly a day of typing and thinking; the
hash-chained audit trail with correct serialisation is half a day on its own;
the two-phase upload plus orphan reaper is half a day; the bucket/IAM/CORS/
lifecycle configuration plus the code review that catches the `org_id` filter
you forgot is another day; and discovering the revocation problem *before*
shipping rather than after costs a day of design argument.

### 2. Application LOC

Counting method — see `../count-loc.mjs`, auditable and reproducible:

- **GROSS** = every line in the counted files, blanks and comments included.
- **NET** = lines that are neither blank nor comment-only (trimmed line
  starting `//`, `/*`, `*`, `*/`). A line with code plus a trailing comment
  counts as code.
- Files are bucketed by path. Only `src/**` counts as application code. The
  test harness and the tests are counted separately and are **never** folded in.
- No attempt is made to discount "boilerplate", because what counts as
  boilerplate is precisely what is in dispute. Instead the buckets are shown so
  anyone can re-slice them.

| Bucket | Files | Gross | Net |
|---|---|---|---|
| **Application (`src/`)** | 7 | **926** | **700** |
| Infra config (`infra/*.json`) | 3 | 122 | 122 |
| Test harness (excluded) | 1 | 174 | 134 |
| Tests (excluded) | 1 | 419 | 312 |

Per-file application breakdown (gross / net):

| File | | What it is |
|---|---|---|
| `src/app.mjs` | 473 / 372 | All routes + the orphan reaper |
| `src/audit.mjs` | 110 / 81 | Hash-chained audit trail |
| `src/db.mjs` | 79 / 72 | SQL DDL (6 tables, 5 indexes) |
| `src/storage.mjs` | 105 / 69 | S3 client + presign helpers |
| `src/authz.mjs` | 75 / 49 | Role model |
| `src/shares.mjs` | 49 / 30 | Token/password handling |
| `src/server.mjs` | 35 / 27 | Entrypoint |

**The number that matters most:** only **69 net lines** (`storage.mjs`) are
S3-specific. The other **631** are domain logic the object store provides
nothing for. Roughly **232 net lines (33%)** — authz, audit, shares, schema —
are substantively identical to Baseline 2. That is the real shape of the
problem: object storage is not where the work is.

### 3. Security-sensitive decisions

Definition used: a point where a wrong choice creates a data leak **and the
system will not tell you**. Compiler errors, test failures and 500s do not
count — those are safe. Enumerated, not just counted.

**In application code (17):**

1. **Presigned download TTL = 60s.** Any value works. A larger value silently
   widens the window in which a leaked URL serves confidential bytes. Nothing
   complains at 604800 (the 7-day maximum).
2. **Presigned upload TTL = 300s.**
3. **Share links must not be presigned URLs.** The single highest-severity
   decision in the whole baseline. The presigned redirect is faster, cheaper
   and works perfectly in every test you would naturally write — and silently
   fails the revocation requirement. Demonstrated by the test *"MEASURED GAP:
   redirect delivery reopens a revocation window"*.
4. **Every document query must filter on `org_id`.** `loadDoc()` does. If any
   future query does `WHERE id = $1` alone, that is a cross-tenant read with no
   error, no log and no test failure unless someone thought to write one.
5. **The object key contains the org id but does not enforce it.** A reader of
   the code can easily believe the prefix is a boundary. It is not; the signing
   principal can sign any key in the bucket.
6. **404 vs 403 for non-members.** Returning 403 turns the endpoint into an
   existence oracle for other orgs' document ids.
7. **Share tokens stored as SHA-256, never plaintext.** A read-only database
   leak otherwise yields working links to every shared document.
8. **Share token entropy (32 bytes).** 8 bytes would be guessable; nothing says so.
9. **Password hashed with scrypt, not the SHA-256 used for tokens.** Both
   functions sit in the same 30-line file. Reusing `hashToken` for the password
   would look consistent and be badly wrong.
10. **`timingSafeEqual` for password comparison.**
11. **Download-cap consumption is one atomic UPDATE.** Read-then-write passes
    every single-threaded test and lets concurrent requests exceed a cap of 1.
12. **`Content-Disposition: attachment` + `nosniff` on the proxied share
    download.** Without it, an uploaded `.html` or `.svg` executes in the origin
    of your own application domain. Stored XSS with full session access.
13. **`Cache-Control: private, no-store` on share downloads.** Otherwise a
    revoked link is replayable from the recipient's disk cache.
14. **Can viewers create share links?** The spec says "any member can create a
    share link for a document they can read" while also listing `viewer` as a
    role and saying "viewers read only". I read this as *at least the `member`
    role* and made viewers unable to mint external grants. Reasonable engineers
    will split on this, and whichever way you go nothing tells you it was wrong.
15. **Admins may not create or demote owners; the last owner cannot be
    demoted.** Neither rule is implied by anything; both are pure judgement.
16. **Audit appends must be serialised per org** (row lock on `orgs`). Omitting
    the lock forks the chain — and the fork is only visible if someone runs the
    verifier.
17. **Deleting a document must cascade-revoke its outstanding shares.** Easy to
    forget; the share table has no foreign-key behaviour that does it for you.

**In infrastructure (6 more)** — see `infra/bucket-setup.md` for the full table:

18. **S3 Block Public Access, all four toggles.** One wrong toggle defeats every
    line of code above. Silent.
19. **Bucket versioning off, or a retention story for versions.** With
    versioning on, `DeleteObject` writes a delete marker and the bytes remain.
    "Delete my document" becomes a lie. Silent.
20. **`iam-policy-app.json` scope.** AWS Prescriptive Guidance is explicit: a
    presigned URL cannot exceed the signer's own permissions, so this policy
    *is* the blast radius of every URL you ever issue. Silent.
21. **CORS `AllowedOrigins` must be an exact list.** A wildcard lets any site
    drive uploads with a stolen URL. Silent.
22. **A separate, more privileged role for the reaper** so a request-handler bug
    cannot delete customer data. Silent.
23. **CloudTrail data events / S3 access logging to a different account.** Off by
    default and billable. Without it you have no record of whether an issued
    presigned URL was ever used. Silent.

**Total: 23 individually enumerated silent-failure decision points.**

### 4. Infrastructure / configuration decisions

16 items, fully enumerated in `infra/bucket-setup.md` with a silent-if-wrong
column. Summary: bucket + region; Block Public Access; SSE-KMS + CMK + bucket
key; versioning; bucket policy (4 statements: TLS-only, `s3:signatureAge` cap,
SSE enforcement, principal restriction); CORS; IAM policy for the signer; a
second IAM policy for the reaper; access-logging / CloudTrail data-event
destination; `AbortIncompleteMultipartUpload` lifecycle rule; role session
duration >= presigned TTL; NTP; Postgres instance + backups + PITR + pooling; a
scheduler for the reaper; egress alarms.

### 5. Number of components to operate

**Six.** (1) Node application, (2) Postgres, (3) S3/R2 bucket, (4) IAM/KMS,
(5) a scheduler for the orphan reaper, (6) the log destination for S3 access
logs / CloudTrail data events. Plus a CDN if you want the share proxy to
survive traffic.

### 6. Edge cases the developer must handle explicitly

1. Client obtains an upload URL and never uploads -> dangling `pending` row.
2. Client uploads and never confirms -> **billable orphan object, invisible to
   the app.** Proven by the `lifecycle: abandoned presigned uploads are reaped`
   test.
3. Client confirms without having uploaded -> guarded by a real `HeadObject`.
4. Client uploads twice to the same URL — presigned URLs are documented as
   reusable until expiry ("You can use the presigned URL multiple times").
5. Presigned URL used after expiry mid-download: S3 checks expiry at request
   time only, so a download in flight completes but a resumed range request fails.
6. Concurrent downloads racing a `maxDownloads` cap.
7. Download stream fails after the counter was consumed -> the user burned a
   download unit and got nothing. This baseline counts on dispatch; refunding
   correctly needs a reservation/commit protocol.
8. Share on a deleted document.
9. Share whose document is deleted *between* validation and streaming.
10. Password-protected share with no password supplied vs a wrong password.
11. Expiry exactly at the boundary.
12. Last owner demotion / removal.
13. Concurrent audit appends forking the chain.
14. Document name containing `"` breaking the `Content-Disposition` header.
15. Clock skew between signer and S3.
16. Signing role session expiring before the presigned TTL.
17. `DeleteObject` failing after the database transaction committed.

### 7. Failure modes — open or closed

| Failure | Behaviour | Direction |
|---|---|---|
| Postgres unreachable | no authorization possible, 500 | **CLOSED** |
| S3 unreachable | downloads 500 | **CLOSED** |
| `s3:signatureAge` bucket policy present | stale signatures rejected at the S3 edge | **CLOSED** (best guardrail here) |
| Signing role session expires early | intermittent 403 | CLOSED (confusing) |
| Clock skew | `SignatureDoesNotMatch` | CLOSED (confusing) |
| Share proxy OOM / timeout on a large file | download fails | CLOSED |
| **Presigned URL leaks (logs, referrer, screen-share, history)** | **serves bytes to anyone for the full TTL** | **OPEN** |
| **Share delivery switched to `redirect`** | **30s post-revocation window** | **OPEN** |
| **An `org_id` filter omitted in a future query** | **cross-tenant read, no signal** | **OPEN** |
| **Block Public Access misconfigured** | **entire bucket world-readable** | **OPEN** |
| **Signing credential leaked** | **full bucket, all tenants** | **OPEN** |
| Audit chain forked by a missing lock | verifier fails; nothing else notices | silent |
| Reaper not scheduled | unbounded cost + retention violation | silent |

Note the asymmetry: everything that fails closed is an *outage*, and everything
that fails open is a *leak*. This architecture is reliable-and-leaky rather than
fragile-and-safe.

### 8. Lifecycle complexity

**High, and entirely yours.** S3 lifecycle rules operate on age and prefix; they
know nothing about `status = 'pending'` or `revoked_at`. So:

- Abandoned presigned uploads need `sweepOrphans()` on a schedule. Implemented
  and tested.
- Reconciling the bucket against the database (objects with no row at all) needs
  a full `ListObjectsV2` sweep. **Not implemented here**, and note that
  `iam-policy-app.json` deliberately denies `s3:ListBucket` to the request-path
  role, so it needs the second role.
- `AbortIncompleteMultipartUpload` must be configured or you pay forever for
  parts nobody will assemble.
- Expired and revoked shares accumulate as rows; kept deliberately for the audit
  trail, so they need their own retention policy eventually.
- Deletion is two systems with no shared transaction: the row is soft-deleted in
  Postgres and the object is deleted in S3 on a best-effort basis afterwards.

### 9. Revocation complexity — **the crux**

**For share links (the requirement): solved, at a structural cost.** Because the
share URL points at our own endpoint and never at S3, revocation is one
`UPDATE shares SET revoked_at = now()` and takes effect on the very next
request. Proven by *"REQUIREMENT: revocation is immediate for already-issued
share links (proxy delivery)"*. The cost is that every shared byte flows through
the application: double egress on S3, compute time, a streaming code path, and a
scaling limit a presigned URL would not have had. (On R2 the S3->app leg is
free, which makes R2 the better substrate for this design.)

**For presigned URLs themselves: not possible. This is the finding.**

AWS is unambiguous. From the S3 User Guide: *"presigned URLs are bearer tokens
that grant access to those who possess them."* From AWS Prescriptive Guidance,
answering "Can I deny access from a presigned URL if I suspect it's been shared
in an unauthorized way?" — yes, but only by **invalidating the credential the
URL was signed with**: remove the IAM principal's permissions, revoke STS
sessions issued before a point in time, or deactivate the access key.

Every one of those is account-wide. The test *"MEASURED GAP: an already-issued
presigned URL cannot be revoked"* measures it exactly:

```
1. Issue a presigned GET to an authorised member          -> 200
2. Demote the member to viewer                            -> URL still 200
3. Delete the document at the application layer           -> URL still valid
4. Deactivate the signing access key (AWS's own remedy)   -> URL now 403   OK
5. Issue a brand-new URL for an unrelated, valid document -> 403           BAD
```

Step 5 is the point. The only revocation lever AWS provides has a blast radius
of *every outstanding URL for every customer*, plus the application's own S3
access. It is a kill switch, not a revocation mechanism.

**What a competent engineer actually does, and what I did:** accept that
presigned URLs are unrevocable, and use them only where unrevocability is
acceptable — for a caller already authorised seconds earlier, with a 60-second
TTL, backed by an `s3:signatureAge` bucket policy so the TTL cannot silently
grow. Residual exposure: **up to 60 seconds per issued in-app download URL,
permanently, by design.** That is a real risk acceptance, not a solved problem,
and it belongs somewhere a compliance auditor can find it.

### 10. Sharing complexity — expiry + password + download cap

**Moderate; all three are pure application logic and none of it is hard.** About
90 net lines across `shares.mjs` and two routes. Expiry: a timestamp column plus
a comparison, with the subtlety that it must be re-checked inside the atomic
consume statement rather than only at the landing page. Password: scrypt,
constant-time compare, and a decision about whether to log failed attempts (I
do). Download cap: the one genuinely sharp edge, because the obvious
read-then-write implementation is wrong under concurrency; the correct form is a
single guarded `UPDATE ... RETURNING`.

The storage layer contributes nothing to any of this. S3 has no concept of an
expiring, password-protected, download-capped, revocable grant, and no
combination of bucket policy and presigned-URL parameters gets you one.

### 11. Developer preference — honest subjective judgement

I like this stack, with one large reservation.

What is genuinely pleasant: the AWS SDK is excellent and the presigning API is
three lines. Direct-to-S3 upload is the right architecture and it Just Works.
Postgres gives me transactions, `FOR UPDATE`, and a single atomic
`UPDATE ... RETURNING` that makes the download cap correct in one statement — I
would not want to build this on anything without those. The whole thing is
inspectable: when something breaks I can read the SQL and the signed URL and
know exactly what happened. `s3:signatureAge` is a genuinely good control and I
was pleased to find it. There is no vendor magic to reverse-engineer.

What I dislike: the number of things that are only correct because I remembered
them. Twenty-three enumerated decisions where being wrong is invisible, six of
them in infrastructure that lives in a different repository from the code that
depends on it. And the revocation gap is the kind of thing that is obvious in
hindsight and completely non-obvious to a team that has read the same Stack
Overflow answers everyone else has. I would bet money that a majority of teams
who "just use presigned URLs" for a share-link feature have shipped a revoke
button that does not revoke.

### 12. Willingness to maintain for two years

**Yes, with conditions.** I would own this. It is boring in the good way, there
is no vendor risk, the failure modes are ones I understand, and R2 makes the
proxy path affordable. My conditions: (a) an automated test asserting cross-org
isolation on *every* document-touching endpoint, because that is the failure
mode that ends the company; (b) the `s3:signatureAge` bucket policy in Terraform
next to the code, not clicked into a console; (c) a written, signed-off risk
acceptance for the 60-second presigned window; (d) the orphan reaper alarmed on
"hasn't run successfully in 24h"; (e) a periodic job that runs `verifyChain` for
every org and pages someone if it fails, because a tamper-evident log nobody
verifies is just a log.

Without those five I would be nervous by month six and uneasy by month eighteen
— not because anything would have broken, but because I would no longer be sure
it hadn't.

---

## Where this approach is genuinely good

This section is deliberately generous, because the honest answer is that a lot
of it is very good.

1. **Direct-to-storage upload is the correct architecture and presigned URLs
   nail it.** The bytes never touch the application. No body-size limits, no
   streaming code, no memory pressure, no bandwidth bill on the app tier. For a
   5 GB file this is not merely better, it is the only sane option. The
   community advice is right about this and I would not do it any other way.
2. **Direct-to-storage download for already-authorised users is also correct.**
   Where the user was authenticated one second ago and a 60-second bearer token
   is an acceptable risk, presigning beats proxying on every axis: latency,
   cost, app-tier load, code simplicity. It is three lines.
3. **`s3:signatureAge` is a genuinely excellent control** and is
   under-publicised. It enforces a maximum signature age *at the storage layer*,
   so an application bug cannot produce a long-lived URL. One of very few
   controls in this whole exercise that fails closed. (R2 does not implement it.)
4. **The security model is honest and fully documented.** AWS does not pretend
   presigned URLs are revocable. The Prescriptive Guidance FAQ answers the
   awkward questions directly, including "can someone other than the intended
   user use this" (yes) and "can I revoke it" (only by killing the credential).
   I would much rather have a platform that tells me the truth than one that
   papers over it.
5. **Postgres is the right tool for everything the object store doesn't do.**
   `SELECT ... FOR UPDATE`, a single atomic guarded `UPDATE ... RETURNING` for
   the download cap, real transactions for the audit chain, `ON CONFLICT` for
   idempotent membership writes. All the genuinely tricky correctness here is
   one SQL statement precisely because Postgres is good.
6. **No vendor lock-in and no vendor risk.** The same application code runs on
   AWS S3, Cloudflare R2, MinIO, Backblaze B2 and Ceph by changing `endpoint`.
   Real, durable optionality, worth a great deal over two years.
7. **R2 specifically fixes the one economic problem.** The proxy path exists
   because revocation requires it, and its cost is double egress. On R2 egress
   is free, so the correct design is also the cheap one. Building this for real,
   R2 + Postgres would be my default recommendation.
8. **Operationally legible.** Every failure I hit had an error message that led
   me to the answer. Nothing was magic. For a system that will be debugged at
   3am by someone who did not write it, that matters more than elegance.

---

## What I could NOT implement, and why

Stated plainly. These gaps are the finding.

1. **Immediate revocation of an already-issued presigned URL. Impossible.** Not
   hard — impossible. AWS documents the only remedy as invalidating the signing
   credential, which is account-wide. Measured in the test suite: it works, and
   it simultaneously kills every other outstanding URL and the application's own
   storage access. There is no per-URL, per-object or per-tenant revocation
   primitive in S3 or R2. **Consequence:** the share-link feature cannot use
   presigned URLs at all, and the in-app download path carries a permanent,
   by-design 60-second exposure window after any permission change or document
   deletion.

2. **An upload size cap on the presigned PUT. Not implemented.** `getSignedUrl`
   with `PutObjectCommand` signs the method, key and content-type but places no
   limit on body size — a client with a valid upload URL can upload up to 5 TB
   and you will be billed for it. The correct remedy is `createPresignedPost`
   from `@aws-sdk/s3-presigned-post` with a `content-length-range` policy
   condition, which is a different API with a multipart/form-data upload shape;
   or signing an exact `content-length` header, which requires the client to
   know the size in advance and forbids streaming. I chose to document this
   rather than half-build it. It is a real gap in this baseline **and a real gap
   in the standard advice** — "just use presigned URLs" does not get you an
   upload size limit.

3. **Bucket-to-database reconciliation.** `sweepOrphans()` reaps abandoned
   `pending` rows (tested), but does not detect objects that exist with no row
   at all. That needs a full `ListObjectsV2` sweep under a second IAM role.
   Sized but not written.

4. **Verified S3 access logging.** The audit trail records that a presigned URL
   was *issued*. Whether it was *used*, how many times, and from where lives only
   in S3 server access logs or CloudTrail data events — a different system,
   delayed by minutes to hours, and off by default. The audit trail this
   scenario asks for is therefore structurally incomplete on the presigned path,
   and complete only on the proxied share path.

5. **Genuine concurrency testing.** PGlite serialises queries on a single
   connection, so the download-cap race test proves the *logic* is expressed as
   one atomic statement, not that it survives real parallel connections. The
   statement is correct Postgres; I could not prove it here.

6. **Tamper-proof (as opposed to tamper-evident) audit.** Anyone with UPDATE
   rights on `audit_log` can recompute the chain forward, and truncating the tail
   is undetectable without an external high-water mark. Making it tamper-*proof*
   needs an anchor outside the database's trust domain. Noted in
   `src/audit.mjs`, not built.

---

## Documentation followed

- AWS S3 User Guide, [Download and upload objects with presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html) — expiry limits (12h console / 7d SDK), credential-bound expiry, `s3:signatureAge`, network-path restriction, the "bearer tokens" characterisation.
- AWS Prescriptive Guidance, [Establishing guardrails and monitoring for presigned URLs](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/introduction.html) — least privilege, data perimeters.
- AWS Prescriptive Guidance, [FAQ](https://docs.aws.amazon.com/prescriptive-guidance/latest/presigned-url-best-practices/faq.html) — reuse, third-party use, and the three (only) revocation levers.
