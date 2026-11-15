# The revision rounds, 13 and 14 November 2026

A review of this benchmark on 2026-11-03 found that it compared a library
iterated for months against alternatives frozen after one build: every defect
the shared attack suite found in Filelayer became a library fix, and every
defect it found in an alternative became a decision counted against it. The
rounds give each alternative the same treatment.

## The figures

One table, read by `tools/check-page-figures.mjs`, which also recounts the
changed lines of application code from the two diffs (the `app` globs in
`../loc.manifest.json`) and fails if this table, the diffs or the pages
disagree:

| Alternative | Rounds | Changed lines of application code |
|---|---:|---:|
| Raw S3 | 1 | 39 |
| Supabase | 2 | 24 |

## The rule

Rounds against the attack suite, at most **40 changed lines** of application
code per alternative across all of its rounds (added plus removed, comments
included), done the way someone who knows the platform would do it. Raw S3 had
one round, on 13 November; Supabase had two, on 13 and 14 November, inside the
same cap. See the table above and the sections below. The diff is published here, so anyone can read every
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

On the attacks every executed implementation can express: one audit-gap before,
**none after**; raw S3 defends all 21. The baseline's own 9 tests still pass.

## Supabase: `supabase.diff`, two rounds, 24 changed lines of application code

8 of the 24 are the first round (13 November, `src/app/vault.js`), 16 the
second (14 November, `src/app/share.js`).

The diff also holds 11 lines of the platform emulation (the service-key
download the gateway now calls, which Supabase Storage provides) and the
baseline's tests; neither is application code, and the cap counts application
code only.

| Change | Before | After |
|---|---|---|
| The member download records the refusal when RLS hides the row (another tenant's document, or one that does not exist) | E1 audit-gap | E1 PASS |
| The share gateway streams the bytes with the service key, as an Edge Function would, with `Content-Disposition: attachment`, `nosniff` and `Cache-Control: private, no-store`, instead of redirecting to a 30-second signed URL. The redirect stays available as `delivery: 'redirect'`, and the baseline's own measurements of it still run | B2 and E2 partial | B2 and E2 PASS |

Streaming also means the application now writes the response headers, so three
attacks that were "cannot express" for Supabase now apply to it: cache replay
of a revoked download (B3), uploaded HTML served renderable (F1) and a hostile
filename in the headers (F2). The comparison therefore grows from 18 to 21
attacks every executed implementation can express. On those 21, Supabase
defends **21**. The baseline's tests pass, 29 of 29, including a new one that
fails against the redirect gateway.

This is the second change to Supabase, made on 14 November after a second cold
review asked for the proxy instead of the "as built" label the first round
gave the two partials.

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
