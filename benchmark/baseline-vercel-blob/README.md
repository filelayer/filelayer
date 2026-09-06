# Baseline 2 — Vercel Blob (private store)

> ## ⚠️ WRITTEN TO SPEC — NOT EXECUTED
>
> This code has **never been run**. It cannot be: `@vercel/blob` private
> storage, `handleUploadPresigned`, `issueSignedToken` and OIDC credential
> resolution all require a live Vercel project, a real private Blob store and
> Vercel's control plane. There is no local emulator.
>
> It is written faithfully against the documented API as of **2026-09-05**,
> following Vercel's own recommended patterns, with every non-obvious call
> cited to the doc page it came from. Where the published docs are ambiguous
> or incomplete, the ambiguity is called out inline with a `DOC GAP:` comment
> rather than guessed at silently.
>
> Baseline 1 (`../baseline-raw-s3`) *is* executed and has a passing test suite.
> Any comparison between the two must account for this asymmetry: Baseline 2's
> defect count is unknown because nothing has ever compiled or run it.

## What is here

```
lib/db.ts        Postgres schema + access (orgs, users, roles, documents, shares, audit)
lib/authz.ts     Role model. Identical in substance to Baseline 1 — neither platform provides any of it.
lib/audit.ts     Tamper-evident per-org hash chain. Identical in substance to Baseline 1.
lib/shares.ts    Share token minting, password hashing, share state machine.
lib/blob.ts      The only genuinely Vercel-specific file. ~70 lines.
app/api/...      Route handlers.
infra/           Store creation, env vars, cron, and the decisions that cannot be undone.
```

## Sources followed

- https://vercel.com/docs/vercel-blob (private vs public, caching, overwriting, operations, pricing)
- https://vercel.com/docs/vercel-blob/private-storage (delivery via `get()`, caching guidance, download charges)
- https://vercel.com/docs/vercel-blob/using-blob-sdk (`put`, `get`, `head`, `del`, `list`, auth resolution order)
- https://vercel.com/docs/vercel-blob/vercel-signed-urls (`issueSignedToken`, `presignUrl`, `handleUploadPresigned`)
- https://vercel.com/docs/vercel-blob/security (private store guarantees, WAF, encryption)
- https://vercel.com/docs/vercel-blob/usage-and-pricing (private vs public delivery cost)

See `REPORT.md` for the twelve measurements.
