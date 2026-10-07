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
| 3 | The test suite in the published tree, with public CI | **Done.** 547 tests ship in the tarball and run from an install; twelve public CI jobs |
| 4 | The storage adapter proven against live R2 and S3 | **Done.** Both, on every commit. Twelve tests each, a thirteenth nightly |
| 5 | A transaction-aware `Queryable`, with the audit write in the same transaction as the mutation | **Done.** The log cannot disagree with the decision it records |
| 6 | Streaming delivery, or a documented short-TTL redirect mode | **Done.** Both, plus `Range`, `HEAD` and `416` |
| 7 | Organization and group grant subjects | **Done.** `actor`, `org`, `role`, `link`, `anonymous`. Membership resolves at request time, so no fan-out to recompute on a join or a leave |
| 8 | A committed schema-migration story | **Done** in `0.15.0`. `filelayer_schema_version` and `schemaStatus(db)` answer where a database is; `migrations/` holds one runnable file per change, and CI applies each one to the previous release's schema and fails the build unless it produces the next |
| 9 | **Two or three production users who are not us** | **Zero.** This is the one item we cannot manufacture, and it is the reason the answer to "should I depend on this?" is still "probably not yet" |

---

## Which is why we are asking

**Three to five design partners.** If you are building something with private
user files — documents, contracts, attachments, anything with a share link you
might later want back — we will help you integrate Filelayer and stay on hand
while you do, in exchange for telling us where it breaks.

What that means concretely:

- We read your requirements and tell you honestly whether this is the wrong
  tool. The table in the [README](README.md#against-the-two-things-you-would-otherwise-do)
  has two rows we lose outright; if you are in one of them we will say so.
- We help with the integration, and we fix what you hit. Every defect an outside
  reader has reported so far was fixed the same day and written up in the
  [changelog](packages/core/CHANGELOG.md) with what it cost.
- You are not committing to ship it. "We evaluated it and here is why we said
  no" is a useful outcome for us and costs you an afternoon.
- No cost, no contract, no exclusivity. There is no hosted service to sell you
  and no pricing page.

[Open an issue](https://github.com/filelayer/filelayer/issues) and say what you
are building.

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
- **Resumable or multipart direct upload — parked, deliberately.** Two to three
  days of work, and it fixes nothing that is broken: it adds capability. The
  storage adapter already speaks multipart and `createUpload()` already
  pre-authorizes, so the cost is mostly in joining them and in aborting
  abandoned uploads, whose parts S3 bills until something does. Revisited when a
  prospect's users upload large files.
- **An independent security review.** Costs money, deferred to January 2027.
  Nothing in this repository has been audited by anyone outside it, and
  `TRUST.md` says so in the one place a reader will look for it.
- **The agent-facing surfaces that still do not exist.** `0.18.0` closed the one
  that was blocking: the delivery routes now have a `Request`/`Response` form,
  so Next.js, Hono, Workers, Deno and Bun can mount them. These remain, listed
  rather than implied:
  - **An MCP server**, so an agent can operate a deployment through a tool
    interface rather than by writing code against the API.
  - **Agent Skills**, which is the cheaper half and the one that serves
    "implement in somebody else's codebase".
  - **A CLI.** There is no `bin`. `schemaStatus()` exists as a function, so
    checking what a database has applied means writing a script first.
  - ~~A machine-readable error catalogue~~ — **done in `0.19.0`, completed in
    `0.19.1`.** `code` is a union of the 29 codes the library can produce, the
    status is derived from the code rather than passed alongside it, and
    `errors.json` and `ERRORS.md` are generated from the one place the set is
    decided. It was 29 codes, not the eight the published tables named. The
    `0.19.1` was because `0.19.0` shipped the catalogue without exporting it
    from the package entry, which the test did not catch because the test
    imported the module.
  - **A way for an adopter to verify THEIR integration**, rather than ours.
    Everything runnable today — the shipped suite, the starter's `verify.mjs`,
    the guide proofs — checks this library or this library's examples. Nothing
    takes somebody's own routes and reports whether the properties hold: that a
    stranger gets a 404, that revocation lands on the next request, that an
    unknown user id denies instead of degrading to anonymous.
