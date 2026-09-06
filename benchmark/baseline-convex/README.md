# Vault on Convex — WRITTEN TO SPEC, NOT EXECUTED

Implementation of the fixed "Vault" benchmark scenario on Convex, following
Convex's own documented best practice (sources cited in `REPORT.md`).

> **This baseline was not run.** It requires a live Convex deployment and a
> Cloudflare R2 bucket. There are no tests here and none have passed. Every
> behavioural claim comes from Convex's published documentation and the
> `@convex-dev/r2` README, not from observation. Confidence is correspondingly
> lower than the Supabase baseline, which is executable with 28 passing tests.

`npm run loc` does run and reproduces the line counts.

## Which Convex path this follows, and why

Convex's File Storage docs say, in bold on the overview page:

> "anyone with the URL can access the file without another app-level
> authorization check. The only way to revoke a file URL is by deleting the
> file."

and then, twice:

> "If you need file URLs that automatically expire after some time, consider
> the Cloudflare R2 component."

The Vault scenario requires share links with an expiry, so the docs steer
directly to R2. That is the primary implementation.
`convex/variantA_convexFileStorage.ts` implements the pure Convex File Storage
alternative and enumerates exactly which scenario requirements it cannot meet.

## Layout

| Path | Counted as | What it is |
|---|---|---|
| `convex/schema.ts` | application | tables + indexes. No access rules are expressible here. |
| `convex/model/auth.ts` | application | the entire authorization model, as ordinary functions |
| `convex/model/audit.ts` | application | tamper-evident hash chain + verifier |
| `convex/r2.ts` | application | R2 client, key scheme, upload flow, presigning |
| `convex/documents.ts` | application | document queries/mutations |
| `convex/members.ts` | application | membership + role changes |
| `convex/shares.ts` | application | share links: expiry, password, cap, revocation |
| `convex/audit.ts` | application | audit read surface (admins only) |
| `convex/http.ts` | application | the two endpoints that serve bytes |
| `convex/convex.config.ts`, `convex/auth.config.ts` | application | component + identity wiring |
| `convex/variantA_convexFileStorage.ts` | **excluded** | comparison artefact |
| `tools/loc.js` | **excluded** | LOC script |

## To actually run this

1. `npm install`
2. `npx convex dev`
3. Create a Cloudflare account and an R2 bucket; add a CORS policy; mint a
   scoped API token (Object Read & Write, single bucket)
4. `npx convex env set` the five `R2_*` values plus `CLIENT_ORIGIN`,
   `PUBLIC_APP_ORIGIN` and `CLERK_JWT_ISSUER_DOMAIN` (see `.env.example`)
5. Wire an identity provider

## The three headline findings

1. **Convex has no database-level access control**, and says so: the pricing
   page marks *Fine-grained permissions: No* on every plan. All 33 access rules
   are imperative checks in application code. **Omitting one fails OPEN** — a
   public `query` without an auth check is world-readable.
2. **Revocation of an issued URL is not possible on either route.** Convex File
   Storage URLs never expire and are revoked only by deleting the file. R2
   presigned URLs are SigV4 and never call back into Convex. Unlike Supabase,
   the residual window cannot be closed to zero on the documented path, because
   the R2 component exposes no move/copy.
3. **Convex's transaction model is genuinely elegant** where it counts: the
   download-cap increment and the audit-chain append are race-free by
   construction, with no locks. The SQL baseline needed an advisory lock and a
   hand-written atomic statement for the same guarantees.

See `REPORT.md` for all twelve metrics, the counting methodology, and the
"Where this approach is genuinely good" section.
