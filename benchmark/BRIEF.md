# The brief and the prompts

A review of this benchmark (2026-11-03, finding 9) asked for the brief the
alternatives were built from and the prompts their agents were given. This page
publishes what exists, and says plainly what does not.

## The September brief and build prompts: not kept

The five implementations were built in September 2026, each alternative by a
separate AI agent. The brief they shared, called "Vault" in their reports, and
the prompt each agent was given **were not kept**: they are not in this
repository and not in the project's records. We cannot publish them, and we
will not rewrite them from memory and present the result as the original.

What survives is what the agents quoted from the brief in their own reports
and code, verbatim:

| Quoted from the brief | Where |
|---|---|
| "revocation takes effect immediately even for links already issued" | `baseline-convex/REPORT.md:360` and `:403`; `baseline-convex/convex/variantA_convexFileStorage.ts:70` |
| "any member can create a share link for a document they can read" | `baseline-raw-s3/REPORT.md:148` |
| "viewers read only" | `baseline-raw-s3/REPORT.md:150` |
| "Last owner cannot be removed." | `baseline-supabase/REPORT.md:607` |
| "every download is recorded" | `baseline-supabase/REPORT.md:512` |

and what they describe it as asking for: organizations with roles (owner,
admin, member, viewer), private uploads, share links with an expiry, a
password and a download cap, immediate revocation of a link already issued, an
audit of views, and cross-organization isolation. The Convex report counts
"seven scenario requirements" (`baseline-convex/REPORT.md:41`).

**What this cannot settle.** Every alternative built a hash-chained audit trail,
which is a Filelayer feature, and the review read that as a sign the brief
asked for one. The surviving quotes say the brief asked for an audit ("every
download is recorded", an audit of views); none of them shows whether it asked
for tamper evidence. We do not know, and say so rather than guess in either
direction. The decision counts include the alternatives' audit-chain decisions
(raw S3 #16, Vercel Blob #21, Supabase #19), so if the brief did ask for a
chain, part of those counts is the brief's doing; under the one rule of
2026-11-13 the two serialisation decisions are one site each.

From this benchmark on, every brief and prompt is committed beside the code it
produced, before the numbers are run.

## Prompts that do exist

### The cold review of 2026-11-03

Given to an agent that had not seen the work, with the repository as its only
input. Its findings are what the 2026-11-13 revision answers.

> The benchmark is at /home/claude/bench/benchmark (read PAGE.md, RESULTS.md,
> decisions.json, loc.manifest.json, count-*.mjs, adversarial/ (attacks.mjs,
> adapters, RESULTS.md) and every baseline-* directory with its REPORT.md). It
> builds one feature (a multi-tenant document workspace: private uploads,
> per-file permissions, expiring and revocable share links, access audit) five
> ways: Supabase Storage with RLS, raw S3 presigned URLs + Postgres, Convex with
> R2, Vercel Blob, and the startup's own library (Filelayer). The alternatives
> were written by AI agents told to follow each platform's documented best
> practice.
>
> Your job: find every place where a real expert in Supabase, AWS S3, Convex or
> Vercel Blob would say "that is not how you'd build it", i.e. where the
> alternative is a strawman, or where the comparison is unfair to it. Also check
> the measurements: are line counts and "security-sensitive decisions" counted
> the same way for every implementation? Could the startup's own implementation
> be getting favourable treatment (e.g. counting its library code as zero lines,
> attacks designed around its features, decisions only Filelayer happens to
> handle)? For each adversarial attack, is the failure of an alternative a real
> vulnerability or a test artefact? Are the two breaches reported for Supabase
> and raw S3 (denied cross-tenant access and probing for missing documents leave
> no audit record) real and fairly described?
>
> Write the findings in English, ranked by how badly each would hurt the
> startup in a Hacker News thread. For each: file and line, what an expert would
> say, whether it is a real unfairness or a defensible choice, and the concrete
> fix (code change, disclosure sentence, or both). End with the 5 comments you
> predict will be the top replies in the HN thread, and whether the benchmark as
> it stands survives them. Under 1,500 words. Be specific; no generic advice.

### The revision round of 2026-11-13

Not an agent prompt: the brief the revision was done to, written before the
code was changed. Its result is in [`revisions/`](revisions/README.md).

> One revision round per alternative against the shared attack suite, at most
> 40 changed lines each, done the way someone who knows the platform would do
> it, with the diff published. For Supabase, either proxy share delivery through
> an Edge Function or label the delivery "as built". For alternatives that
> cannot be executed, change no code; count their decisions as an expert would
> build them (convex-helpers customQuery and row-level security for Convex; the
> lock or retry inside the audit helper). Then recount the decisions of all five
> under one rule: a decision enforced in one helper is one site, and a decision
> the platform's own linter catches is dropped. Add the silent decisions in
> Filelayer's own example. Count a Filelayer variant wired as in production
> (S3Storage, a pg pool, migrations, the same IAM and bucket JSON) under the same
> rules, and add a column for vendor lines in your process or database.
