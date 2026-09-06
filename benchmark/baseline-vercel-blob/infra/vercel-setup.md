# Platform setup checklist (Baseline 2)

Items marked **SILENT** produce no error if you get them wrong.
Items marked **PERMANENT** cannot be changed after creation.

| # | Decision | Why it matters | |
|---|----------|----------------|---|
| 1 | Create Blob store with `--access private` | `vercel blob create-store vault --access private`. "You cannot change it after the creation of a blob store." Choosing `public` here means every document in the product is fetchable by URL forever, and the only fix is to create a second store and copy every blob. | **PERMANENT** |
| 2 | Store region (one of 20) | Data residency and regionalised pricing. "You cannot change the region once the store is created." | **PERMANENT** |
| 3 | One store for all tenants, or one per tenant? | One store = one credential whose blast radius is every customer's documents. Per-tenant stores bound the blast radius but cap you at 500 stores (Pro) / 1,000 (Enterprise) — i.e. 500 customers. There is no third option. | **SILENT** |
| 4 | Connect the store to the project, environments selected | Adds `BLOB_STORE_ID`, `VERCEL_OIDC_TOKEN`, `BLOB_WEBHOOK_PUBLIC_KEY`. | no |
| 5 | Prefer OIDC over `BLOB_READ_WRITE_TOKEN` | OIDC tokens are short-lived and rotate automatically. Note the resolution order: **an explicit `token` option always wins over OIDC.** One stray `{ token: process.env.BLOB_READ_WRITE_TOKEN }` silently downgrades you to a long-lived static credential. | **SILENT** |
| 6 | `BLOB_READ_WRITE_TOKEN` still required for `handleUpload` | Documented: "OIDC tokens are not sufficient for `handleUpload`". We use `handleUploadPresigned` instead, which does work with OIDC. | no |
| 7 | `CRON_SECRET` set, and checked in the cron route | Without the check, `/api/cron/sweep` is an unauthenticated data-deletion endpoint. | **SILENT** |
| 8 | `vercel.json` cron schedule for the sweep | Nothing else reaps orphans; Blob has no lifecycle rules. | **SILENT** (cost + retention) |
| 9 | Auth in the route handler, never in middleware | Vercel's own docs: "avoid relying on middleware for auth... a middleware bug or misconfiguration could expose cached private content to the wrong users." | **SILENT** |
| 10 | Explicit `Cache-Control` on every private response | Default is `public, max-age=0, must-revalidate`. Use `private, no-store` for share downloads so a revoked link is not replayable from disk cache. | **SILENT** |
| 11 | Never `s-maxage` a private blob response | Same doc warning. A CDN-cached private document is served without your auth check. | **SILENT** |
| 12 | `addRandomSuffix: false` on the upload path | The pathname is the join key to Postgres. A random suffix orphans the document at the moment of upload. | no (loud, but confusing) |
| 13 | `issueSignedToken({ pathname })` — never omit `pathname` | Omitting it "defaults to a whole-store wildcard". This is the single highest-severity footgun in the platform. | **SILENT** |
| 14 | Function `maxDuration` / memory sized for streaming | Docs: "We do not recommend serving files larger than 100 MB through private Blob stores unless traffic is low." | no |
| 15 | Provision a Marketplace Postgres (Neon) + serverless driver or PgBouncer | Serverless concurrency will exhaust a classic connection pool. | no (loud at traffic) |
| 16 | Optional: enable Vercel WAF on the store | Rate limiting / IP blocking. Note: the **Challenge** action breaks SDK traffic (429), and the OWASP core ruleset is unsupported for Blob stores. | no |
| 17 | Spend Management alert | Private delivery is structurally ~2× public transfer cost; a hot share link is a bill. | no |

## Env vars

```
BLOB_STORE_ID=            # set automatically when you connect the store
VERCEL_OIDC_TOKEN=        # set + rotated automatically; never read it yourself
BLOB_WEBHOOK_PUBLIC_KEY=  # set automatically; used by handleUploadPresigned
BLOB_READ_WRITE_TOKEN=    # only for code running outside Vercel
DATABASE_URL=             # Marketplace Postgres
PUBLIC_BASE_URL=https://app.vault.example
CRON_SECRET=              # you must generate and check this yourself
```

## Cost model for this scenario

Documents in a B2B workspace are small (10 KB – 5 MB) and read often. Every
read of a private blob is:

- Function → store: Blob Data Transfer ($0.05/GB) + Fast Origin Transfer on cache miss
- Function → browser: Fast Data Transfer + Fast Origin Transfer

versus a public blob's single Blob Data Transfer leg. Vercel states BDT is
"3x more cost-efficient than FDT on average", so the private path costs
materially more than 2× the public path once FDT is counted. **For this
scenario there is no choice** — the documents are confidential, so public
storage is not on the table. The ~2× is the price of correctness, not a
mistake, and it should be reported as such.
