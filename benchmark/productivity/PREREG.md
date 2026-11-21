# Productivity benchmark: preregistration

**Status: DRAFT, not yet frozen.** This file is frozen by a public commit
that also adds `FINGERPRINT.txt`, before the first run. Until then it may
change. After that, every change is a dated entry under "Deviations", and the
runs made before it say so.

## The question

Starting from the same requirements, does an AI coding agent that uses
Filelayer reach a correct and secure implementation more often, at lower cost
and in less time, than one that builds the same thing itself on S3 and
PostgreSQL? The point is to find out whether Filelayer wins, by how much, and
where it loses. A result against Filelayer is published like any other.

**Scope of any conclusion.** One task: the document workspace of
`../BRIEF.md`. Filelayer's package ships an example of nearly this service
(`examples/vault`, see "Known biases"), so a result here says how an agent
does on this task with this package, and nothing about tasks the package has
no example for.

## What is fixed

Everything a run depends on is in this folder and in
`../adversarial/attacks.mjs`. `FINGERPRINT.txt` holds a SHA-256 of every one
of those files and one over all of them; `harness/run.mjs` refuses to start a
real run when any file differs, and records the fingerprint in every
`run.json`. The one exception is `hidden/late/*.mjs`, the attacks written
after the freeze (see "What is measured").

| What | Where | Value |
|---|---|---|
| The service to build | `contract/openapi.yaml`, `contract/REQUIREMENTS.md` | derived from `../BRIEF.md` |
| The prompt | `prompts/common.md` plus one arm line and one task | identical across arms except the arm line |
| Arm A line | `prompts/arm-a.md` | use `@filelayer/core` 0.36.0; its documentation is in the package |
| Arm B line | `prompts/arm-b.md` | build it on PostgreSQL and S3, no authorization or share-link library |
| Agent | Claude Code | 2.1.330 (`harness/config.json`) |
| Models | `harness/config.json` | `claude-opus-5-5`, `claude-sonnet-5-5`, default effort |
| Limits per task | `harness/config.json` | task 1: 60 min, 250 turns, $15; tasks 2 and 3: 25 min, 100 turns, $6 |
| Tools | `harness/config.json` | Claude Code's defaults without WebSearch |
| Network | `harness/allowlist.txt` | the API, npm, and a fixed list of third-party documentation sites. Not filelayer.dev (a live site outside the fingerprint, whose comparison page describes which attacks catch which defects); Filelayer's documentation is the copy in the pinned package. Not GitHub, which holds the hidden checks |
| Services | `harness/config.json` | `postgres:17-alpine`, `motoserver/moto:5.1.4` |
| Visible to the agent | `smoke/smoke.mjs` | the happy path only |
| Hidden from the agent | `hidden/` | 29 functional checks, 8 for task 2, 1 for task 3, the 21 shared attacks with positive controls |
| Prices | `harness/config.json` | read 2026-11-17; checked again before each phase |
| Order of the runs | `harness/plan.mjs` | seeds 20261201 (pilot) and 20261208 (full) |

The hidden checks are public in this repository from the preregistration
commit on, so anyone can see they were fixed before the runs. The agent cannot
read them: its container holds only the contract, the smoke test and its own
project, and its network does not reach GitHub.

## The tasks

Each run is three tasks, each a new Claude Code session in the same fresh
container, each with a database and a bucket of its own. Each task starts
from a known state, so no task inherits the success or failure of another:

1. **Build.** `/work/app` is empty. Implement the contract.
2. **Change of requirements.** `/work/app` holds the reference implementation
   of the run's arm (`reference/a-filelayer` or `reference/b-own`). Add
   `prompts/task2-change.md`: a revocation records a reason. An
   approximation of maintenance, not a measure of long-term maintenance.
3. **Seeded bug.** `/work/app` holds the run's arm's reference with one known
   bug: a viewer can create a share link. The bug report is
   `prompts/task3-bug.md`. An approximation of debugging, with the bug known
   in advance. The bug is of the same kind in both arms, a missing role check
   on share creation, but the seed is not the same size: one line in arm B,
   two changes in arm A (the route's check and a grant's floor). The fix that
   works is the same line in both. A fix that only narrows the grant in arm A
   leaves the documents uploaded while the bug was live exposed, and the
   scoring catches it: the snapshot is scored on a database where the seeded
   reference uploaded documents first (`reference/SEEDED-BUG.md`).

## The environment

Each session is started the same way in both arms:

    claude -p --model <model> --output-format stream-json --verbose
           --dangerously-skip-permissions --no-session-persistence
           --max-budget-usd <task budget> --disallowedTools WebSearch

with the prompt on standard input, as the unprivileged user `agent`, in
`/work/app`. Permissions are skipped because nobody is there to grant them;
the container and its network are the boundary. Telemetry, error reporting
and the autoupdater are off. The wall clock and the turn limit are enforced
by the harness, which stops the session when either is reached; a turn is one
API response, counted once per message id. Claude Code checks the budget after
each turn, so a session can exceed its budget by up to one turn.

Every run gets a new internal Docker network with no route out, a new
PostgreSQL and a new S3 emulator on it, and an egress proxy as its only way
out, to the hosts of `harness/allowlist.txt`. Every connection attempt,
allowed or refused, is logged with its time. The agent runs as an
unprivileged user with 2 CPUs and 4 GB of memory.

Scoring happens afterwards, from the snapshot of `/work/app` taken at the end
of each task, in a different container that the agent never touched: new
PostgreSQL and S3, `npm install`, then `npm start` and the hidden checks over
HTTP. The snapshot sees only the contract's environment variables. For task
3, the run's seeded reference is started first on the same database and
bucket and uploads the documents T3-01 checks.

## What is measured

Every figure carries one of three labels. **Observed**: read from the record
of a run. **Estimated**: computed from observed figures with the method stated
next to it. **Assumed**: not measured. No estimated figure is presented as
observed.

| Measure | Definition | Label |
|---|---|---|
| Tokens | input + cache write + cache read + output, from Claude Code's final `usage`; for a session with no final message (stopped by the harness, or one that died), the sum of the usage of every assistant message in the stream, once per message id. `tokensSource` says which | observed |
| Output tokens | output alone | observed |
| Cost | each kind of token times the price in `config.json` | estimated |
| Wall time | from the prompt to the end of the session, including sessions the harness stopped | observed |
| Turns, tool calls | from the session's stream; a turn is a distinct message id | observed |
| Test runs | Bash calls that run the smoke test, a test runner, `npm start`, or a request to the local service | observed |
| Corrections | edits to a file already written, after the first test run | observed |
| Lines | the shared counter's rules (`../loc-count.mjs`): net lines of the project, and lines the task changed | observed |
| Dependencies | `package.json` of the snapshot | observed |
| Functional | every hidden functional check of the task passes (for tasks 2 and 3, the task's checks and the whole task-1 battery) | observed |
| Security | the number of the 21 shared attacks defended. A1-A4 count as defended only if their positive control passes first (the legitimate twin of the attack works), so refusing everything defends nothing. A project that is missing, does not install or does not start defends 0 | observed |
| Late attacks | attacks written after the freeze by someone who has not seen Filelayer (`hidden/late/`), defended out of those that apply. Reported apart; never part of the 21, H2 or "both" | observed |
| Reads of `examples/vault` | tool calls, of any kind (Read, Grep, Glob, a shell command), that touch the package's `examples/vault`; other examples counted apart | observed |
| Documentation read | characters of the results of WebFetch, and of Read, Grep, Glob and shell reads of files under `node_modules`, divided by 4 | estimated |

A task is **complete** in a block only if the session finished within its
limits (`stoppedBy: finished`) and the block's checks pass. A session stopped
by its clock, its turns or its budget is a valid run that did not complete,
and its tokens, cost and time count in every figure.

**Three blocks, never merged into one figure:** functional, security, and
both at once. Each is reported per model and per arm as `k/n` with a 95 %
Wilson interval. Arm A's are also reported split by whether the run read
`examples/vault`.

What Filelayer brings along is reported next to arm A's own lines: the lines
of the published `dist` and of `schema.sql`, its runtime dependencies, and the
tables, indexes and functions it creates (`harness/library-size.mjs`). The
conclusion will not be "less code": it will be less code written and kept by
the team, against a dependency of that size kept by others.

## Hypotheses and how each is decided

Per model, never averaged across models. Medians with their interquartile
range; for differences, a 95 % percentile bootstrap interval (10,000
resamples, fixed seed). With 10 runs per cell the percentile bootstrap of a
median is coarse, which is one more reason the thresholds below are wide. The
rules are those of `harness/report.mjs` and its statistics are tested against
reference values in `harness/stats.test.mjs`.

| | Measure | Confirmed | Refuted | Otherwise |
|---|---|---|---|---|
| H1, reliability | share of task-1 runs complete in the functional block | A's share is higher and a two-sided Fisher exact test gives p < 0.05 | A's share is equal or lower | inconclusive |
| H2, security | attacks defended per task-1 run, of the 21 | A's mean is higher and a two-sided Mann-Whitney test gives p < 0.05 (exact by permutation at these sizes) | A's mean is equal or lower | inconclusive |
| H3, total cost | tokens of task 1, median | at least 30 % fewer, and the interval of the difference excludes zero | the whole interval of the relative difference lies above -10 % | inconclusive |
| H4, cost of a correct implementation | task-1 spend of the arm divided by its runs complete in both blocks | at least 30 % lower, and the bootstrap interval of the relative difference lies below zero | the whole interval lies above -10 % | inconclusive |
| H5, time | wall time of task 1, median | as H3 | as H3 | inconclusive |
| H6, maintenance approximation | tokens and wall time of tasks 2 and 3 together, medians | both confirmed as in H3 | either refuted as in H3 | inconclusive |

Reported beside H1, H2 and H4, and deciding nothing: the one-sided Fisher p
of H1; for H2, a two-sided Fisher exact test on the share of runs that defend
all 21, and the medians; for H4, the median cost of the correct runs and the
share of bootstrap resamples with no correct run in an arm (which have no
ratio and are left out).

If an arm has no run complete in both blocks, the cost of a correct
implementation is not computed or replaced by another figure; it is reported
as "0 of N valid runs, total spend X, cost per correct implementation not
computable, more than X".

**Multiplicity.** Six hypotheses per model, two models: twelve decisions, none
corrected for multiplicity. At p < 0.05, about one false confirmation in
twenty decisions is expected by chance where there is no real difference. Each
is read as its own result, not as a family.

With 10 runs per arm and model, only large differences can be told apart from
chance: around 30 % or more in tokens or time, or something like 9 of 10
against 4 of 10 in completed tasks. Smaller differences will come out
inconclusive, and the report will say so.

## Runs

- **Pilot**: 2 runs per arm and model, 8 in all. It measures the cost per run
  and checks the harness against the real agent. It does not count in the
  results and is published as a pilot. The limits are frozen here, before the
  pilot: changing any of them after it is a deviation, logged below with its
  reason, and it needs a new freeze commit before the full phase.
- **Full**: 10 runs per arm and model, 40 in all, in the order `plan.mjs`
  gives: random from the seed, with the arms alternating.

**Invalid runs.** A run is invalid only when the infrastructure failed, never
because of what the agent did, and the rules read only the infrastructure's
own records, never the outcome. `harness/analyze.mjs` applies them to every
task:

| The record shows | Read from |
|---|---|
| The session ended because the API failed: an error result whose text is an API failure (5xx, 429, overloaded, a connection error), or no result and such a failure on stderr. A budget stop is not one | the session's stream and stderr |
| An allowed host could not be reached during the session | the egress log, by time, inside the session's window |
| The scorer failed: its PostgreSQL or S3 failed before or after the scoring, its checks threw, or `npm install` failed on the network twice. Each is scored once more before it counts | `score.json` |
| The harness failed, or was stopped during the run | `run.json` |

A snapshot that is missing, does not install for a reason other than the
network, or does not start, is the agent's failure and scores zero; it is not
invalid. Any invalid task makes its whole run invalid. An invalid run is
published with its reason, counts in no figure, and is replaced once by a run
of the same arm and model appended at the end of the order (`plan.mjs
--extend`); a replacement that is itself invalid is not replaced again. A
harness stopped during a run leaves that run invalid rather than resuming it,
and its spend stays counted.

Two things are checked in the pilot's records before the full phase, and
anything found is a deviation: which hosts Claude Code itself calls (its
WebFetch tool in particular), from the egress log; and whether a session the
harness stops leaves a usable stream.

## Money

The approved ceiling is $500, and it is a ceiling, not a target. The pilot's
cap is $100; the full phase's is $400. Before each run the harness adds up what
the phase has spent, counting for each task the larger of Claude Code's own
figure and the estimate from the stream, so a session that was stopped or died
is counted too. It starts the run only if what remains covers the full budgets
of its three tasks ($27), so no session is ever given a budget cut short by
the cap, which would stop it for a reason unrelated to the agent; the phase
stops instead. After the pilot, if its measured cost per run times 40 exceeds
what remains of the ceiling, the full phase does not start without a new
approval.

Expected cost of the pilot, estimated, not measured:

| | Per run (three tasks) | 4 runs |
|---|---|---|
| Opus 5.5, central | about $5.00 | about $20 |
| Sonnet 5.5, central | about $2.50 | about $10 |
| Pilot, central | | **about $30** |
| Pilot, high (2.5 times) | | **about $75** |
| Pilot, at the limits | $27 a run | stopped by the $100 cap after 3 runs |

The central case assumes, per run, 3 million tokens read from the cache, 0.4
million written to it or uncached, and 0.12 million of output, at the prices of
`harness/config.json`. The pilot exists to replace these assumptions with
measurements.

## Publication

Every run is published, the failed and the invalid ones too: `run.json`, the
session stream of each task, the snapshot of each task, its score, its
metrics, and the egress log. The report (`harness/report.mjs`) is generated
from those files alone, so anyone can recompute it, and anyone can repeat the
benchmark with their own API key (`README.md`).

## Known biases

| Bias | Pushes towards | What is done about it |
|---|---|---|
| `@filelayer/core` ships `examples/vault`, 259 lines of nearly this service (orgs, roles, shares with expiry, password and cap, revocation, audit). Arm B has nothing comparable | Filelayer | declared; conclusions limited to this task; reads of `examples/vault` counted in every run, and arm A's results reported split by whether it was read |
| The library was tuned against the same 21 attacks used here: the public comparison page says it was fixed each time they found a defect in it | Filelayer | declared; a few attacks written after the freeze by someone who has not seen the library, reported apart |
| We wrote the requirements, the contract, the checks and the attacks | Filelayer | a cold review of the design and the contract before the runs, without access to Filelayer's code; everything public; tests and alternatives welcome |
| The contract may resemble Filelayer's API | Filelayer | contract derived from BRIEF.md; the cold review found no route that fits only Filelayer |
| The contract differs from Filelayer's model in places: a member revokes only their own links; a refused member gets 403 where Filelayer answers 404, and the last owner 409 where Filelayer answers 403; no members list in Filelayer; the audit actions have other names | against Filelayer | reported as found; arm A's reference shows the extra code it costs |
| Task 2's reason for a revocation cannot be stored by Filelayer; arm A needs a table of its own | against Filelayer | declared |
| Filelayer's documentation is written for agents | Filelayer | part of what is measured; documentation read is reported separately |
| The models know S3 from training and Filelayer not | against Filelayer | the real situation; reported without correction |
| Arm A is told to use Filelayer; a real user would have to choose it | Filelayer | this measures implementation, not selection; selection is measured by the discovery gates |
| The library's own code is not counted as lines | Filelayer | its size is reported next to arm A's lines |
| Checks the agent does not see | neutral | the same smoke test for both arms |
| Model randomness | neutral | 10 runs per cell, random interleaved order, intervals |
| The seeded bug is one line in arm B and two changes in arm A, and arm A has two places to see it | either | the fix that works is the same line in both; a partial fix in arm A fails on documents uploaded while the bug was live |
| The S3 emulator is not S3 | either | the same emulator for both arms; moto accepts what the AWS SDKs send by default |
| Publishing only what is favourable | Filelayer | this preregistration, and publication of every run |

## Deviations

None yet.
