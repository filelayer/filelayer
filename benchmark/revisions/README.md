# The revision round, 2026-11-13

A review of this benchmark on 2026-11-03 found that it compared a library
iterated for months against alternatives frozen after one build: every defect
the shared attack suite found in Filelayer became a library fix, and every
defect it found in an alternative became a decision counted against it. This
round gives each alternative the same treatment once.

## The rule

One round per alternative, against the attack suite, at most **40 changed
lines** (added plus removed, comments included), done the way someone who knows
the platform would do it. The diff is published here, so anyone can read every
line or revert it. The results in `../RESULTS.md` and
`../adversarial/RESULTS.md` are for the revised code.

The revision was written by the team that builds Filelayer, which is the same
conflict of interest as the attack suite. The diffs are small enough to judge on
their own, and a better revision is welcome as an issue.

## Raw S3: `raw-s3.diff`, 39 changed lines

| Change | What the suite said before | After |
|---|---|---|
| The org row lock moves into `appendAudit`, so a write that appends to the audit chain cannot forget it | decision #16 at 10 sites | 1 site |
| A refused request inside an existing org (403 or 404) goes into that org's audit trail, from the error middleware | E1 audit-gap | E1 PASS |
| CR and LF are stripped from the filename in `Content-Disposition`, on both the proxy path and the presigned override | F2 partial | F2 PASS |

On the 18 attacks every executed implementation can express: 17/18 with one
audit-gap before, **18/18 after**. The baseline's own 9 tests still pass.

## Supabase: `supabase.diff`, 8 changed lines

| Change | Before | After |
|---|---|---|
| The member download records the refusal when RLS hides the row (another tenant's document, or one that does not exist) | E1 audit-gap | E1 PASS |

On the 18 shared attacks: 15/18 with 2 partial and 1 audit-gap before, **16/18
with 2 partial after**. The baseline's own 28 tests still pass.

**Labelled "as built": share delivery.** The two partials (B2, a revoked link
replayable for up to 30 seconds; E2, the audit records a signed-URL issuance,
not a byte delivery) come from one design choice: the share gateway redirects
to a 30-second signed URL instead of streaming the bytes. An Edge Function that
streams them would close both, and would cost egress through the function and
its response limits; the baseline's `REPORT.md` argues the trade-off. That proxy
was not built in this round, so the two results describe the implementation as
built, not Supabase as a platform.

## Convex and Vercel Blob: no code change

Neither has ever been executed or compiled, so a revision could not be tested
against the suite, and a change nobody can run is not a fair revision. Their
decision counts are instead taken as an expert would build them, which is the
direction that favours them:

- **Convex.** Authentication through one `customQuery`/`customMutation`
  wrapper and the row-level-security wrapper on `ctx.db` from
  `convex-helpers`, the documented pattern: decisions #1 and #4 count one site
  each, down from 17 and 8.
- **Vercel Blob.** Authentication through one helper called by every route
  handler (decision #3: 1 site, from 15) and the retry inside the audit helper
  (decision #21: 1 site, from 12).

Every change to a count is recorded in `../decisions.json`, on the decision
itself, under `oneRule`.
