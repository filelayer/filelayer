# Roadmap to 1.0

**We did not write this list.** On 5 September 2026 an evaluating agent was
given a neutral catalogue of six ways to handle user files in a SaaS, with
Filelayer's entry written to be the least flattering accurate version of it. It
ranked Filelayer **last of six**, and then produced, unprompted, the specific
things that would change its answer.

That list has been the roadmap ever since, because a list of objections from
somebody with no stake in us is worth more than a feature plan written by us.
Eight of the nine are now done. The ninth is the one we cannot build.

| | What it asked for | State |
|---|---|---|
| 1 | A real open-source licence | **Done.** Apache-2.0. `LICENSE` and `NOTICE` ship in the tarball, and CI fails if either is missing from it |
| 2 | Published to npm | **Done.** `@filelayer/core`, twenty-one releases |
| 3 | The test suite in the published tree, with public CI | **Done.** 749 tests ship in the tarball and run from an install; twelve public CI jobs |
| 4 | The storage adapter proven against live R2 and S3 | **Done.** Both, on every commit. Twelve tests each, a thirteenth nightly |
| 5 | A transaction-aware `Queryable`, with the audit write in the same transaction as the mutation | **Done.** The log cannot disagree with the decision it records |
| 6 | Streaming delivery, or a documented short-TTL redirect mode | **Done.** Both, plus `Range`, `HEAD` and `416` |
| 7 | Organization and group grant subjects | **Done.** `actor`, `org`, `role`, `link`, `anonymous`. Membership resolves at request time, so no fan-out to recompute on a join or a leave |
| 8 | A committed schema-migration story | **Done** in `0.15.0`. `filelayer_schema_version` and `schemaStatus(db)` answer where a database is; `migrations/` holds one runnable file per change, and CI applies each one to the previous release's schema and fails the build unless it produces the next |
| 9 | **Two or three production users who are not us** | **Zero.** This is the one item we cannot manufacture, and it is the reason the answer to "should I depend on this?" is still "probably not yet" |

---

## Which is why we are asking

**If it runs for you, tell us.** Filelayer is built to be adopted without
talking to anybody. The [quickstart](docs/QUICKSTART.md), the
[guides](docs/guides/), the runnable [examples](examples/) and
[`llms.txt`](llms.txt) are meant to take you, or your coding agent, from install
to a working integration alone, and `auditIntegration()` checks the result
against your own routes.

What would help, in order:

- **Where it breaks.** [Open an issue](https://github.com/filelayer/filelayer/issues)
  with what you were building and what went wrong. Every defect an outside
  reader has reported so far was fixed the same day and written up in the
  [changelog](packages/core/CHANGELOG.md) with what it cost.
- **Whether it is the wrong tool for you.** The table in the
  [README](README.md#against-the-two-things-you-would-otherwise-do) has two rows
  we lose outright. "We evaluated it and here is why we said no" is a useful
  issue.
- **Whether it is running in production.** That is item 9, and the only one we
  cannot find out on our own.

No cost, no contract, no exclusivity. There is no hosted service to sell you
and no pricing page.

---

## What is NOT on this roadmap, and will not be

Each of these is a decision rather than a backlog item, so that a reader can
rule us out quickly instead of waiting for a version that is not coming:

- **A CDN on the private delivery path.** P4 — a URL never outliving its
  permission — is why bytes proxy through your application. The two facts are
  the same fact. The opt-in redirect mode is as close as this gets.
- **A migration runner.** Your application already owns one. `migrations/` is
  machine-readable so your runner can enumerate it; `schemaStatus()` tells you
  where you are and applies nothing.
- **A hosted service.** You run it against your own Postgres and your own
  bucket. That is also what makes the alpha risk bounded: the state is yours.
- **Thumbnails, transforms, format negotiation.** Bytes in, the same bytes out.
- **Custom roles.** Four fixed roles, on purpose. An unbounded role system is an
  authorization model nobody can audit.
- **Our own object storage.** Storage is replaceable and we intend to keep it
  that way.

## What is queued behind item 9

Honest ordering: these are real and none of them is more important than one
person running this in production.

- ~~A clean skip when the shipped suite is run without the `pg` driver~~ —
  **done in `0.15.2`.** The driver was imported at the top of a shared helper,
  so the suite crashed instead of skipping and the skip logic never ran.
- ~~A cap, or at least an alarm, on grants per subject~~ — **done in `0.17.0`,
  and not as a cap.** The read already stopped at the first grant that supplied
  the capability; it stopped in application code, after the database had
  evaluated every row. Moving that into SQL removed the cliff instead of
  fencing it: 30 ms at 200 000 concentrated grants, against 5 911 ms at 100 000
  before.
- ~~Audit-log retention, which does not exist~~ — **done in `0.16.0`.**
  `trimAuditChain()` removes old events and leaves a checkpoint recording where
  the chain had reached, so a trimmed chain still verifies. Nothing trims unless
  you ask: a deployment that never calls it still grows without bound.
- ~~Subject-scoped erasure from the audit trail~~ — **done.**
  `eraseActorFromAuditChain()` removes one actor's events and writes a
  checkpoint per contiguous run, so every hole is attested and nobody else's
  history is touched. The verifier needed no change: it already matched gaps
  against checkpoints by hash, so N holes with N checkpoints verified exactly
  as one did, and nobody had noticed. What did change is the seal guard — an
  honest erasure of the most recent events moves the head backwards, which
  used to report `truncated_past_seal`. Found on 21 October while drafting a
  guide that would have claimed we already did this, caught by a review handed
  the draft without the author's reasoning.
- **Resumable or multipart direct upload — parked, deliberately.** Two to three
  days of work, and it fixes nothing that is broken: it adds capability. The
  storage adapter already speaks multipart and `createUpload()` already
  pre-authorizes, so the cost is mostly in joining them and in aborting
  abandoned uploads, whose parts S3 bills until something does. Revisited when a
  prospect's users upload large files.
- **An independent security review.** Costs money, deferred to January 2027.
  Nothing in this repository has been audited by anyone outside it, and
  `TRUST.md` says so in the one place a reader will look for it.
- **The agent-facing surfaces.** In `0.18.0` the one that was blocking closed:
  the delivery routes now have a `Request`/`Response` form, so Next.js, Hono,
  Workers, Deno and Bun can mount them. The others listed here have shipped
  since, and stay listed so the history is readable:
  - ~~An MCP server~~: **shipped.** `filelayer-mcp`, a stdio server you run
    yourself, and `@filelayer/core/mcp` to build one in code. One process acts
    for one user, fixed at start. See `docs/MCP.md`.
  - ~~Agent Skills~~: **shipped.** `skills/filelayer-integration/`, in the
    package. See `docs/AGENT-SKILL.md`.
  - ~~A CLI~~: **shipped.** `filelayer doctor`, `filelayer schema status` and
    `filelayer usage-report`, read-only. See `docs/CLI.md`.
  - ~~A machine-readable error catalogue~~ — **done in `0.19.0`, completed in
    `0.19.1`.** `code` is a union of the 29 codes the library can produce, the
    status is derived from the code rather than passed alongside it, and
    `errors.json` and `ERRORS.md` are generated from the one place the set is
    decided. It was 29 codes, not the eight the published tables named. The
    follow-up in `0.19.1` was needed because in `0.19.0` the catalogue shipped
    without being exported from the package entry, which the test did not catch
    because the test imported the module.
  - **A way for an adopter to verify THEIR integration**, rather than ours.
    Everything runnable today — the shipped suite, the starter's `verify.mjs`,
    the guide proofs — checks this library or this library's examples. Nothing
    takes somebody's own routes and reports whether the properties hold: that a
    stranger gets a 404, that revocation lands on the next request, that an
    unknown user id denies instead of degrading to anonymous.
