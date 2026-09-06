# Bucket / account setup checklist (Baseline 1)

Every item below is a decision or an action a human must take and keep correct
over time. None of them are defaults. Items marked **SILENT** produce no error
if you get them wrong — the system works, and leaks.

| # | Setting | Why | Silent if wrong? |
|---|---------|-----|------------------|
| 1 | Create bucket `vault-prod` in a chosen region | data residency, latency, egress price | no |
| 2 | **Block Public Access: all four toggles ON** | a bucket-level public-read ACL defeats every line of application code | **SILENT** |
| 3 | Default encryption: SSE-KMS with a CMK | at-rest requirement | no (policy denies) |
| 4 | Bucket key enabled | KMS request cost | no |
| 5 | Versioning: **off** (or a retention story for versions) | with versioning on, `DeleteObject` only writes a delete marker, so "delete the document" does not delete the bytes | **SILENT** |
| 6 | `bucket-policy.json` applied | TLS-only, `s3:signatureAge` cap, single-principal | partly — the signatureAge cap failing open is silent |
| 7 | `bucket-cors.json` applied with exact origins | browser presigned PUT | no (browser errors loudly) |
| 8 | `iam-policy-app.json` on the app role | blast radius of every presigned URL | **SILENT** |
| 9 | Separate, more privileged role for the orphan reaper | a request-handler bug must not be able to delete objects | **SILENT** |
| 10 | S3 server access logging **or** CloudTrail data events on the bucket, to a *different* account | the only record of whether a presigned URL was actually used; data events are off by default and cost money | **SILENT** |
| 11 | Lifecycle rule: `AbortIncompleteMultipartUpload` after 7 days | otherwise you pay forever for parts nobody will ever assemble | **SILENT** |
| 12 | Role session duration ≥ presigned TTL | a URL dies when the signing session dies, producing intermittent 403s that look like a bug | no (loud, but confusing) |
| 13 | NTP / clock sync on every signer | clock drift produces `SignatureDoesNotMatch` | no |
| 14 | Postgres instance: provisioning, backups, PITR, failover, connection pooling | the whole authorization and audit story lives here | no |
| 15 | A scheduler (cron/EventBridge/worker) to run `sweepOrphans` | nothing reaps abandoned uploads | **SILENT** (cost + data retention) |
| 16 | Egress budget/alarm on the share-proxy path | proxying is the only way to get immediate revocation, and it doubles transfer | no |

## On R2 instead of S3

Cloudflare R2 is S3-API-compatible and the application code is unchanged
(`endpoint` + `forcePathStyle`). The differences that matter here:

- **Zero egress fees.** This materially changes the calculus of the share-link
  proxy: on S3 the proxy costs you egress twice (S3 → app, app → user); on R2
  the S3 → app leg is free. If you are going to proxy, R2 is the better
  substrate.
- R2 **does not implement `s3:signatureAge`**, so checklist item 6's one
  fail-closed guardrail is unavailable. Presigned TTL correctness becomes
  purely an application-code property.
- R2 bucket policies are considerably less expressive than S3's; the
  `aws:PrincipalArn` and KMS statements have no direct equivalent.
