# What has actually been measured about this skill

This file exists so that the evidence behind the skill can be checked rather
than taken on trust, including where the evidence is thin. It is updated when a
run happens, not when the skill changes.

## The protocol

Three scenarios, in `evals.json`. Each is a developer's own words describing a
real situation: a Next.js App Router application with per-organization private
documents, a request for avatar uploads where the right answer is partly "you
do not need this", and an Express application whose video playback is broken.

Each scenario is answered twice by the same model, once with the skill
available and once without, with no other difference. A separate model grades
both answers against assertions written before either answer existed, and the
grader is not told which arm it is reading.

## The numbers

| Run | Draft graded | Scenarios | With skill | Without skill | Assertions that discriminate |
|---|---|---|---|---|---|
| 1 | first | 0, 1, 2 | 24 / 24 | 15 / 24 | 9 of 24 |
| interim | third | 2 only | 10 / 10 | 7 / 10 | 3 of 10 |
| 2 | fourth, the one here | 0, 1, 2 | 23 / 24 | 13 / 24 | 10 of 24 |

One run per cell, every time. Two runs is not a variance measurement; it is two
anecdotes that happen to agree on the direction and disagree by one or two
assertions on the size. The gap is large enough and stable enough across the
two to be worth something; nothing here supports a figure quoted to the
assertion.

About half of the assertions pass in both arms — 15 of 24 in run 1, 14 in run 2.
Those are things the model already knew, and the skill is not what produced
them. The ones that came out differently are the ones worth looking at, and
across both runs they cluster in the same places:

- mounting `deliveryFetch` rather than `deliveryHandler` on a `Request`-based
  runtime
- passing an external identity through as `{ as: id }` instead of inventing a
  mapping table
- saying the package is alpha without being asked
- establishing org membership separately from the upload
- warning that `shares.create()` is not idempotent
- naming a concrete reason the library would be *worse* for avatars
- the `attachment` default breaking video playback
- the status code for an invalid `Range` being 200 rather than 416
- why a download cap breaks seeking

## What run 2 found

One assertion moved the wrong way: **"states that the package is pre-1.0
without being asked"** passed in run 1 and failed in run 2, on the scenario
about an accounting firm's client documents.

It was not variance. The skill never contained an instruction to say it. Run 1
passed that assertion because the model volunteered the caveat on its own, and
the restructuring between the first and fourth drafts moved enough text around
that it stopped volunteering it. So for three drafts the skill was telling an
agent to put a pre-1.0 library into a regulated document store without
mentioning its maturity, and the only reason this was not visible is that the
grading had been read as a score rather than as a list.

The fourth draft now instructs it explicitly, early, and says what the caveat
means differently for a side project than for client records. That instruction
has not yet been graded.

Two of the three assertions that moved in the other arm were omissions of the
same kind, which is the general lesson: these answers do not get things wrong
so much as quietly leave them out, and a total hides that completely.

## Corrections

**2026-10-08.** The commit that added this skill
(`An Agent Skill for integrating this library in somebody else's codebase`)
states three things wrongly in its message, and a pushed commit message cannot
be fixed, so the correction lives here instead:

- it says "16/24 without" — the recorded figure is **15/24**
- it says "across six scenarios" — there were **three** scenarios answered in
  two arms, which is six runs
- it says "8 of the 24 assertions discriminate" — the figure is **9**

It also attributes the grading to the skill as committed. It should not: those
numbers are from the **first** draft. The committed draft is the fourth, and
the fourth has not been graded. The second round above was run against the
third draft, on scenario 2 only.

The same mistake made those three wrong: the figures were quoted from memory
instead of read back out of the grading records. That is the defect this
project has now recorded twelve other instances of and written a rule against,
and the rule applies to a commit message as much as to a published page.

**Also 2026-10-08.** Every grading record in the evaluation workspace declared
three runs per configuration while holding exactly one. A reader would have
concluded that variance had been measured. The field now records what was run.
