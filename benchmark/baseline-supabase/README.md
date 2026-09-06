# Vault on Supabase — RUNNABLE baseline

Implementation of the fixed "Vault" benchmark scenario using Supabase Storage
and Postgres Row Level Security, following Supabase's own documented best
practice (sources cited in `REPORT.md`).

**This baseline actually executes.** PGlite is real PostgreSQL compiled to
WebAssembly, so the RLS policies in `sql/` are compiled and enforced by Postgres
itself — including under cross-tenant attack.

## Run it

```sh
npm install
npm test      # 28 tests, all passing
npm run loc   # reproducible LOC breakdown
```

## Layout

| Path | Counted as | What it is |
|---|---|---|
| `sql/10_app_schema.sql` | application | orgs, members, documents, share_links, audit_log |
| `sql/20_rls_policies.sql` | application | authorization kernel + 19 RLS policies |
| `sql/25_config_b_lockdown.sql` | application | Config B: force all byte reads through the gateway |
| `sql/30_audit.sql` | application | tamper-evident hash chain + verifier |
| `src/app/vault.js` | application | upload / download / delete / membership |
| `src/app/share.js` | application | share links + the redemption gateway |
| `sql/00_platform_emulation.sql` | **excluded** | the `auth` + `storage` schema Supabase provides |
| `src/platform/supabase.js` | **excluded** | Storage API + signed URLs Supabase provides |
| `sql/90_rbac_jwt_variant.sql` | **excluded** | measurement artefact for the JWT-claim RBAC comparison |
| `test/` , `tools/` | **excluded** | suite, harness, LOC script |

## How the tests exercise RLS for real

Each request opens a transaction, runs `SET LOCAL ROLE authenticated`, and sets
the `request.jwt.claims` GUC from a verified JWT — exactly what PostgREST and
the Supabase Storage API do. `auth.uid()` and `auth.jwt()` read that GUC.
`service_role` is created with `BYPASSRLS`, matching a real project.

Attack coverage includes: cross-org reads of `documents`, `org_members`,
`orgs`, `audit_log` and `storage.objects`; cross-org uploads; cross-org object
moves; `anon` access; viewer privilege escalation; admin-to-owner escalation;
forged and tampered signed URLs; signed-URL path swapping; share-token
brute-force surface; download-cap races; and audit-chain tampering.

## The three headline findings

1. **Supabase signed URLs cannot be revoked.** They are stateless JWTs signed
   with a per-project storage key; the docs tell you to contact support. Test
   17 measures the residual exposure window; test 18 shows the only real
   mitigation (object path rotation) and its collateral cost.
2. **RLS fails closed and that is a genuine, large advantage.** Every mistake
   made while building this surfaced as an error, never as a leak.
3. **You cannot have both complete audit and RLS-as-enforcement.** Config A and
   Config B are both implemented and both tested; each satisfies one of the two.

See `REPORT.md` for all twelve metrics, the counting methodology, and the
"Where this approach is genuinely good" section.
