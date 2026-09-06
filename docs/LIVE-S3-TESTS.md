# Live S3 / R2 integration tests

`packages/core/test/s3-live.test.ts` drives the S3 storage adapter against a
**real** object store. This page is the only place the bucket, the token and the
secret names are specified. The test file reads them; `.github/workflows/ci.yml`
passes them; neither restates them.

**Why bother.** `packages/core/test/storage.test.ts` proves the *wire format*
against a local server that verifies every signature, and it is fast, hermetic
and worth having. It cannot prove anything about the counterparty: TLS, real IAM
evaluation, R2's divergences from S3, AWS's checksum requirements, throttling and
retry behaviour, read-after-write visibility, or the exact error codes a real
store returns. Those are what break a storage adapter in production, and this is
the code path every single download goes through. Until the suite has run
against a real bucket, the adapter is *wire-correct*, not *proven*.

**Cost.** One bucket, a few hundred kilobytes written and deleted per run, and
about ~11 MB more on the nightly run when the multipart test is enabled. On
Cloudflare R2 that is inside the free tier for any plausible commit rate.

---

## Setup on Cloudflare R2 (about five minutes)

**1. Create a dedicated bucket.**

In the Cloudflare dashboard: **R2 → Create bucket**.

| Setting | Value |
| --- | --- |
| Name | `filelayer-ci` (any name; a bucket used for nothing else) |
| Location | any |
| Public access | **off** — do not attach a custom domain, do not enable `r2.dev` |

The suite writes under a key prefix and deletes what it wrote, but a failed run
can leave objects behind, so use a bucket you are willing to empty. A lifecycle
rule deleting objects older than one day under `filelayer-ci/` is a sensible
belt-and-braces setting and is not required.

**2. Create an API token scoped to that bucket.**

**R2 → API → Manage API Tokens → Create API Token**:

| Setting | Value |
| --- | --- |
| Permissions | **Object Read & Write** |
| Specify bucket(s) | *Apply to specific buckets only* → the bucket from step 1 |
| TTL | your choice; a token that expires silently turns this job red, so if you set one, put the date in a calendar |

Cloudflare then shows, once:

- **Access Key ID**
- **Secret Access Key**
- the S3-compatible **endpoint**, `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`

R2's *Object Read & Write* covers everything the suite needs, including
`ListBucket` and multipart abort. There is no narrower R2 permission worth
using — an *Admin Read & Write* token is broader than required, so do not use
one.

**3. Add the secrets** (next section), and push. That is all: nothing in the
repository needs editing to turn the suite on.

## Setup on AWS S3

Equivalent, with one bucket dedicated to this and Block Public Access left fully
on. The endpoint is `https://s3.<region>.amazonaws.com`, the region is the real
region (not `auto`), and the token is an IAM user (or role) whose *only* policy
is the minimum below.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FilelayerCiObjects",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload"
      ],
      "Resource": "arn:aws:s3:::filelayer-ci/*"
    },
    {
      "Sid": "FilelayerCiBucket",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:ListBucketMultipartUploads"
      ],
      "Resource": "arn:aws:s3:::filelayer-ci"
    }
  ]
}
```

Per action, and why the suite needs it:

| Action | Needed by |
| --- | --- |
| `s3:PutObject` | every write, and every multipart part |
| `s3:GetObject` | reads, ranged reads, and fetching presigned URLs |
| `s3:DeleteObject` | the cleanup that stops the bucket growing forever |
| `s3:ListBucket` | the prefix-listing test, which is what orphan collection uses |
| `s3:AbortMultipartUpload` | abandoning a failed multipart upload |
| `s3:ListBucketMultipartUploads` | only if you enable the multipart test |

On AWS, also set the repository **variable** `FILELAYER_TEST_S3_PATH_STYLE` to
`false` to exercise virtual-hosted addressing, which is what AWS prefers. R2
requires path-style, which is the default.

---

## The exact names to configure

**Repository secrets** — *Settings → Secrets and variables → Actions → Secrets*.
All five are required. Set fewer than five and the job skips, names the ones
that are missing, and stays green.

| Secret | Example | Notes |
| --- | --- | --- |
| `FILELAYER_TEST_S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | AWS: `https://s3.<region>.amazonaws.com` |
| `FILELAYER_TEST_S3_BUCKET` | `filelayer-ci` | dedicated; contents are disposable |
| `FILELAYER_TEST_S3_REGION` | `auto` | R2 is always `auto`; AWS takes the real region |
| `FILELAYER_TEST_S3_ACCESS_KEY_ID` | | from step 2 |
| `FILELAYER_TEST_S3_SECRET_ACCESS_KEY` | | from step 2 |

Optional secret:

| Secret | Purpose |
| --- | --- |
| `FILELAYER_TEST_S3_SESSION_TOKEN` | STS / temporary credentials only |

**Repository variables** — same page, *Variables* tab. These are not secret and
are easier to read in a log if they are not.

| Variable | Default | Purpose |
| --- | --- | --- |
| `FILELAYER_TEST_S3_PATH_STYLE` | path-style | set to `false` for virtual-hosted addressing (AWS) |
| `FILELAYER_TEST_S3_PREFIX` | `filelayer-ci/` | key prefix; everything written lives under it |

The multipart test (~11 MB per run) is controlled by
`FILELAYER_TEST_S3_MULTIPART` and is set by the workflow, not by you: off on
push and pull request, on for the nightly schedule and for a manual
**Run workflow**.

---

## What happens in CI

The `s3-live` job in `.github/workflows/ci.yml` always runs, and decides for
itself:

- **Credentials present** → it runs `test/s3-live.test.ts` on its own, then
  asserts the suite really ran. If the secrets are set and the suite skips
  itself anyway, the job **fails** — that state is indistinguishable from
  success at a glance, which is exactly why it is checked.
- **Credentials absent** → the work is skipped, a workflow notice is raised and
  the job summary says, in the run itself, that the storage adapter was not
  exercised and which secrets are missing. The job stays green.

Secrets are not exposed to pull requests from forks, so a contributor's build
skips this suite. That is correct: a fork must not go red for not having
credentials it cannot have.

`if:` conditions cannot read the `secrets` context, which is why presence is
computed in the first step and published as a step output.

## Running it locally

Export the same five variables and run the suite. No flag, no separate command,
no opt-in by name — a suite you have to remember to run is a suite nobody runs.

```bash
export FILELAYER_TEST_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com"
export FILELAYER_TEST_S3_BUCKET="filelayer-ci"
export FILELAYER_TEST_S3_REGION="auto"
export FILELAYER_TEST_S3_ACCESS_KEY_ID="..."
export FILELAYER_TEST_S3_SECRET_ACCESS_KEY="..."

npm test                       # whole suite, live storage included
```

Without them, that same command prints one line to stderr and moves on:

```
[s3-live] SKIPPED -- live S3 credentials not present (missing: ...)
```

## If it goes red

| Symptom | Usually means |
| --- | --- |
| `SignatureDoesNotMatch` on everything | the secret access key was truncated when it was pasted |
| `InvalidAccessKeyId` | the token was revoked, or expired via its TTL |
| `AccessDenied` on the listing test only | the token is object-scoped but has no `ListBucket` on the bucket itself |
| `NoSuchBucket` | the endpoint is right and the bucket name is not, or the bucket is in another account |
| `LEAKED TEST OBJECT <key>` in the log | cleanup failed; the objects are under the prefix and are safe to delete by hand |
| the expiry test fails with `200` | clock skew on the runner, or a proxy caching presigned responses |
