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

## What is fixed

Everything a run depends on is in this folder and in
`../adversarial/attacks.mjs`. `FINGERPRINT.txt` holds a SHA-256 of every one
of those files and one over all of them; `harness/run.mjs` refuses to start a
real run when any file differs, and records the fingerprint in every
`run.json`.

| What | Where | Value |
|---|---|---|
| The service to build | `contract/openapi.yaml`, `contract/REQUIREMENTS.md` | derived from `../BRIEF.md` |
| The prompt | `prompts/common.md` plus one arm line and one task | identical across arms except the arm line |
| Arm A line | `prompts/arm-a.md` | use `@filelayer/core` 0.36.0 |
| Arm B line | `prompts/arm-b.md` | build it on PostgreSQL and S3, no authorization or share-link library |
| Agent | Claude Code | 2.1.330 (`harness/config.json`) |
| Models | `harness/config.json` | `claude-opus-5-5`, `claude-sonnet-5-5`, default effort |
| Limits per task | `harness/config.json` | task 1: 60 min, 250 turns, $15; tasks 2 and 3: 25 min, 100 turns, $6 |
| Tools | `harness/config.json` | Claude Code's defaults without WebSearch |
| Network | `harness/allowlist.txt` | the API, npm, and a fixed list of documentation sites; GitHub is not on it |
| Services | `harness/config.json` | `postgres:17-alpine`, `motoserver/moto:5.1.4` |
| Visible to the agent | `smoke/smoke.mjs` | the happy path only |
| Hidden from the agent | `hidden/` | 29 functional checks, 8 for task 2, 1 for task 3, the 21 shared attacks |
| Prices | `harness/config.json` | read 2026-11-17; checked again before each phase |
| Order of the runs | `harness/plan.mjs` | seeds 20261201 (pilot) and 20261208 (full) |

The hidden checks are public in this repository from the preregistration
commit on, so anyone can see they were fixed before the runs. The agent cannot
read them: its container holds only the contract, the smoke test and its own
project, and its network does not reach GitHub.

## The tasks

Each run is three tasks, each a new Claude Code session in the same fresh
container:

1. **Build.** `/work/app` is empty. Implement the contract.
2. **Change of requirements.** Starting from what task 1 left, add
   `prompts/task2-change.md`: a revocation records a reason. An approximation
   of maintenance, not a measure of long-term maintenance.
3. **Seeded bug.** `/work/app` is replaced by the reference implementation of
   the run's arm with one known bug: a viewer can create a share link. The
   bug report is `prompts/task3-bug.md`. An approximation of debugging, with
   the bug known in advance. The bug is of the same kind in both arms, a
   missing role check on share creation, and its smallest fix is the same line
   in both (`reference/SEEDED-BUG.md`).

## The environment

Each session is started the same way in both arms:

    claude -p --model <model> --output-format stream-json --verbose
           --dangerously-skip-permissions --no-session-persistence
           --max-budget-usd <task budget> --disallowedTools WebSearch

with the prompt on standard input, as the unprivileged user `agent`, in
`/work/app`. Permissions are skipped because nobody is there to grant them;
the container and its network are the boundary. Telemetry, error reporting
and the autoupdater are off. The wall clock and the turn limit are enforced
by the harness, which stops the session when either is reached.

Every run gets a new internal Docker network with no route out, a new
PostgreSQL and a new S3 emulator on it, and an egress proxy as its only way
out, to the hosts of `harness/allowlist.txt`. Every connection attempt,
allowed or refused, is logged. The agent runs as an unprivileged user with
2 CPUs and 4 GB of memory.

Scoring happens afterwards, from the snapshot of `/work/app` taken at the end
of each task, in a different container that the agent never touched: new
PostgreSQL and S3, `npm install` (failure scores the task as failed), then
`npm start` and the hidden checks over HTTP. The snapshot sees only the
contract's environment variables.

## What is measured

Every figure carries one of three labels. **Observed**: read from the record
of a run. **Estimated**: computed from observed figures with the method stated
next to it. **Assumed**: not measured. No estimated figure is presented as
observed.

| Measure | Definition | Label |
|---|---|---|
| Tokens | input + cache write + cache read + output, from Claude Code's final `usage` | observed |
| Output tokens | output alone | observed |
| Cost | each kind of token times the price in `config.json` | estimated |
| Wall time | from the prompt to the end of the session | observed |
| Turns, tool calls | from the session's stream | observed |
| Test runs | Bash calls that run the smoke test, a test runner, `npm start`, or a request to the local service | observed |
| Corrections | edits to a file already written, after the first test run | observed |
| Lines | the shared counter's rules (`../loc-count.mjs`): net lines of the project, and lines the task changed | observed |
| Dependencies | `package.json` of the snapshot | observed |
| Functional | every hidden functional check of the task passes (for tasks 2 and 3, the task's checks and the whole task-1 battery) | observed |
| Security | all 21 shared attacks defended | observed |
| Documentation read | characters of WebFetch results and of files read under `node_modules`, divided by 4 | estimated |

A task is **complete** in a block only if the session finished within its
limits (`stoppedBy: finished`) and the block's checks pass. A session stopped
by its clock, its turns or its budget is a valid run that did not complete.

**Three blocks, never merged into one figure:** functional, security, and
both at once. Each is reported per model and per arm as `k/n` with a 95 %
Wilson interval.

What Filelayer brings along is reported next to arm A's own lines: the lines
of the published `dist` and of `schema.sql`, its runtime dependencies, and the
tables, indexes and functions it creates. The conclusion will not be "less
code": it will be less code written and kept by the team, against a
dependency of that size kept by others.

## Hypotheses and how each is decided

Per model, never averaged across models. Medians with their interquartile
range; for differences of medians, a 95 % bootstrap interval (10,000
resamples, fixed seed). The rules are those of `harness/report.mjs`.

| | Measure | Confirmed | Refuted | Otherwise |
|---|---|---|---|---|
| H1, reliability | runs of task 1 complete in the functional block | A has more, and a one-sided Fisher exact test gives p < 0.05 | A has as many or fewer | inconclusive |
| H2, security | attacks defended per run, task 1, median | A's median is higher | A's median is equal or lower | |
| H3, total cost | tokens of task 1, median | at least 30 % fewer, and the interval of the difference excludes zero | less than 10 % fewer, or more | inconclusive |
| H4, cost of a correct implementation | task 1 spend of the arm divided by its runs complete in both blocks; the median cost of those runs is reported too | at least 30 % lower | less than 10 % lower, or higher | inconclusive |
| H5, time | wall time of task 1, median | as H3 | as H3 | inconclusive |
| H6, maintenance approximation | tokens and wall time of tasks 2 and 3 together, medians | both confirmed as in H3 | either refuted | inconclusive |

If an arm has no run complete in both blocks, the cost of a correct
implementation is not computed or replaced by another figure; it is reported
as "0 of N valid runs, total spend X, cost per correct implementation not
computable, more than X".

With 10 runs per arm and model, only large differences can be told apart from
chance: around 30 % or more in tokens or time, or something like 9 of 10
against 4 of 10 in completed tasks. Smaller differences will come out
inconclusive, and the report will say so.

## Runs

- **Pilot**: 2 runs per arm and model, 8 in all. It calibrates the limits and
  the cost. It does not count in the results and is published as a pilot.
- **Full**: 10 runs per arm and model, 40 in all, in the order `plan.mjs`
  gives: random from the seed, with the arms alternating.
- A run is **invalid** only when the harness or the infrastructure failed
  (`run.json` has an `error`), never because of what the agent did. An invalid
  run is published with its cause and replaced once, by a run of the same arm
  and model appended at the end of the order.

## Money

The approved ceiling is $500, and it is a ceiling, not a target. The pilot's
cap is $100; the full phase's is $400. Before each run the harness adds up what
the phase has spent, and starts the run only if what remains covers the full
budgets of its three tasks ($27). So no session is ever given a budget cut
short by the cap, which would stop it for a reason unrelated to the agent;
the phase stops instead. After the pilot, if its measured cost per run times 40
exceeds what remains of the ceiling, the full phase does not start without a
new approval.

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
| We wrote the requirements, the contract, the checks and the attacks | Filelayer | a cold review of the design and the contract before the runs, without access to Filelayer's code; everything public; tests and alternatives welcome |
| The contract may resemble Filelayer's API | Filelayer | contract derived from BRIEF.md; the cold review looks for routes that fit only Filelayer |
| The contract also differs from Filelayer's model in places (a member may revoke only their own links; a refused member gets 403 where Filelayer answers 404; no members list in Filelayer) | against Filelayer | reported as found; arm A's reference shows the extra code it costs |
| Filelayer's documentation is written for agents | Filelayer | part of what is measured; documentation read is reported separately |
| The models know S3 from training and Filelayer not | against Filelayer | the real situation; reported without correction |
| Arm A is told to use Filelayer; a real user would have to choose it | Filelayer | this measures implementation, not selection; selection is measured by the discovery gates |
| The library's own code is not counted as lines | Filelayer | its size is reported next to arm A's lines |
| Checks the agent does not see | neutral | the same smoke test for both arms |
| Model randomness | neutral | 10 runs per cell, random interleaved order, intervals |
| A seeded bug harder in one arm | either | the same kind of bug, the same one-line fix, reviewed cold |
| The S3 emulator is not S3 | either | the same emulator for both arms; moto accepts what the AWS SDKs send by default |
| Publishing only what is favourable | Filelayer | this preregistration, and publication of every run |

## Deviations

None yet.
