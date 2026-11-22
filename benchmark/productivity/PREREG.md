# Productivity benchmark: preregistration

**Status: frozen on 22 November 2026**, by the commit that adds
`FINGERPRINT.txt`, before the first run. From here on, every change is a
dated entry under "Deviations", and the runs made before it say so. The
figures marked as pending approval (the caps under "Money") are frozen as
proposed; if the approval changes them, that is the first deviation.

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
   two changes in arm A (the route's check and a grant's floor). Restoring the
   route's check fixes both arms, and it is one line in each; it is not the
   only fix, and no fix is required to look like it: the scoring judges a fix
   by what it does. A fix that only narrows the grant in arm A leaves the
   documents uploaded while the bug was live exposed, and the scoring catches
   it: the snapshot is scored on a database where the seeded reference
   uploaded documents first (`reference/SEEDED-BUG.md`).

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

Nothing an agent starts outlives its session. The container's first process
is an init that runs as root and reaps what dies; after every session, and
whenever the harness stops one, every process of the user `agent` is killed
(a server left running in the background included) and the harness checks
that none is left before the next task; one that survives even SIGKILL goes
with a restart of the container, whose files stay. A container that stops answering (an
agent that exhausted its memory or its process limit) is killed from the host
10 seconds after the stop; the stop is still the clock's or the turns', the
agent's own doing, and the container is started again with its files for the
next task. The snapshot is copied out with `docker cp`, which does not need the
container to answer.

The agent controls its project's git repository: hooks, `core.hooksPath`,
filters, fsmonitor, attributes and diff drivers. Nothing of it runs where the
harness runs. The harness never commits or diffs in the agent's repository on
the host; it copies the tree out when the task starts and when it ends and
records both in a repository of its own, outside the copied tree, with no
system or global configuration, hooks and fsmonitor off in the command itself,
attributes from the empty tree, and an environment of only `PATH` and an empty
`HOME` (`harness/history.mjs`). The lines a task changed are the difference
between those two records, so commits the agent makes itself change nothing.
That history lives beside the run's task directories
(`history/task<N>.git`), outside every directory a container mounts (the
egress proxies, harness code that parses the agent's traffic, mount only
their log file), so no snapshot can rewrite it; the ids of its two commits are kept in `run.json`
and the difference is taken between those ids; and git neither fetches nor
runs a transport for it (`protocol.allow=never`, which alone is enough;
`GIT_NO_LAZY_FETCH` adds to it on git 2.44 and later). The harness refuses to
start on a git older than 2.40, which would ignore the empty-tree
attributes, and `analyze.mjs` reports lines changed as n/a there. A repository nested inside the project is recorded
as a link to its commit, so the files inside it count no lines; the old
method did the same, and an agent that wants its lines counted keeps them in
the project.

The service's databases belong to a role of their own that is not a
superuser, in the agent's container and in the scorer alike, so both arms
build against what they are scored against.

A run is never resumed or run twice. `run.json` is written with `state:
started` before the first session and again before and after every session,
naming the session in flight; each session's stream has a file of its own,
never overwritten. If the harness dies, the next harness first removes every
container, network and proxy the earlier one left (and checks they are gone),
then closes each run that did not finish: the spend of the session in flight
is read from its stream, the phase cap is charged at least that task's whole
budget (the session may have run on after the harness died), and the run is
invalid (`harness_interrupted`). A harness stopped by a signal or by an
uncaught error takes its containers down with it. Only one harness may work on
a phase directory at a time (a lock file).

Every run gets a new internal Docker network with no route out, a new
PostgreSQL and a new S3 emulator on it, and an egress proxy as its only way
out, to the hosts of `harness/allowlist.txt`. Every connection attempt,
allowed or refused, is logged with its time. The agent runs as an
unprivileged user with 2 CPUs and 4 GB of memory.

Scoring happens afterwards, from the snapshot of `/work/app` taken at the end
of each task, in a different container that the agent never touched: new
PostgreSQL and S3, `npm install`, then `npm start` and the hidden checks over
HTTP. The snapshot sees only the contract's environment variables. For task
3, the run's seeded reference is installed in the scorer from its own
`package-lock.json` (fingerprinted), started first on the same database and
bucket, and uploads the documents T3-01 checks.

A snapshot has 30 seconds per HTTP request, 60 seconds to answer `/health`,
120 seconds per check (240 for T3-01) and 180 seconds per attack, its world
and its positive control included; past them the check fails, which is the
snapshot's failure, not the scorer's, and every request the abandoned check
still makes fails at once. Seeding task 3 from the seeded reference has 120
seconds. Every limit is in `hidden/bounds.mjs`. The whole scoring of one
snapshot has a last bound of 4 hours, and reaching it is the scorer's failure.
Those limits added up give at most 164 minutes (task 3: two installs, two
starts, the seeding, 29 checks, T3-01 and 26 attacks), and a test checks that
the last bound stays at least 30 minutes above that sum, so no snapshot can
reach it by being slow; the late attacks, scored in a run of their own under
the same bound, have room for 66. The probe
of the services after the checks runs once the snapshot is stopped, as the
superuser, whose reserved connections a snapshot that leaks connections cannot
take.

The scorer reaches one host, `registry.npmjs.org` (`harness/allowlist-score.txt`),
through a proxy whose log is kept with the score. A failed `npm install` is
the scorer's failure only when that registry could not be reached (a
connection error to it in the scorer's log, or a 5xx or 429 from it); it is
then scored once more. npm's own verdict on the project comes first: a missing
version, an unresolvable tree or a bad manifest (E404, ETARGET, ERESOLVE and
the like) is the agent's, whatever the network did meanwhile. An install that
runs out of its 10 minutes is the scorer's only if npm itself failed the way a
network fails (a network error code, or a 5xx or 429 from the registry), or
the scorer's egress log has at least two errors to the registry after its
last successful connection: a project whose install is just slow is the
agent's. Any other
failure to install is the agent's too, including a dependency that fetches
from another host while installing: the contract says `npm install` must work,
and the rule is the same for both arms.

The scorer refuses to score unless the benchmark files match
`FINGERPRINT.txt`, and writes the fingerprint into every `score.json`;
`analyze.mjs` refuses any score without it, or with another one, and any
valid task that has no score (an unscored task is not a zero). A score is
written once; only a scorer failure is scored again, and only once: every
attempt is appended to `score-attempts.jsonl`, and after two there are no
more, whatever `score.json` says or whether it exists. Each attempt logs
the sha256 of the score file it wrote, and `analyze.mjs` refuses a score
file that is missing, has no attempt behind it or does not match. The
snapshot cannot reach the attempts log or the task's directory: the scorer
writes only to a new, empty directory of its own for each attempt, and once
the scorer is gone the expected files are copied back from it, regular files
only (opened without following links, checked on the open file), a log over
20 MB cut to its last 20 MB, any other file over 20 MB dropped
(`harness/copy-back.mjs`). Inside an attempt, though, the snapshot's server
runs as the same user as the checks, so a snapshot written on purpose to
attack the scorer could stop the checks or replace that attempt's score
before it is copied. Such a snapshot is out of the benchmark's scope: the
agents are asked to build a service, not to attack the harness, the
snapshot and the check log are published with the results, and a score file
the checks did not write would show there. The rehearsal `hooks` mode
(`harness/fake-claude.mjs`) plants files and links in the scorer's directory
and `harness/check-hooks-rehearsal.mjs` asserts that none of it arrives. Someone who deletes both files by hand reopens
the scoring; the run's directory is published, so that would show.
Rehearsal scores written before the attempts log carried hashes are refused
by `analyze.mjs`; rehearsals are scored again after the freeze. `--unfrozen`, which
lets the tools work before the freeze, is refused for any run that is not a
rehearsal, and a report with an unfrozen score says so at the top.

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
| Lines | the shared counter's rules (`../loc-count.mjs`): net lines of the project; and lines the task changed, from the harness's own record of the tree before and after the task, without `package-lock.json` (`harness/history.mjs`) | observed |
| Dependencies | `package.json` of the snapshot | observed |
| Functional | every hidden functional check of the task passes (for tasks 2 and 3, the task's checks and the whole task-1 battery) | observed |
| Security | the number of the 21 shared attacks defended. A1-A4 count as defended only if their positive control passes first (the legitimate twin of the attack works), so refusing everything defends nothing. A project that is missing, does not install or does not start defends 0 | observed |
| Late attacks | attacks written after the freeze by someone who has not seen Filelayer (`hidden/late/`), each with its own positive control, defended out of those that apply. Scored separately, in a directory of their own, into `late-score.json`, which the primary scoring never reads or writes; the report gives them a row of their own; never part of the 21, H2 or "both" | observed |
| Reads of `examples/vault` | tool calls that ask for vault in the package's examples (a path, pattern or glob of Read, Grep or Glob taken together, or a shell command, with the directory an earlier `cd` left it in), or whose result lists a file under `examples/vault`; other examples counted apart (`harness/classify.mjs`, tested on the reads a cold review planted) | observed |
| Egress errors | every connection error to an allowed host during a session, by host and arm, whether or not it invalidates | observed |
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
| The API failed (5xx, 429, overloaded, a timeout, a connection error, 401 or 403, an exhausted key), and that is why the session ended. Only API errors after the session's last response count, and the last of them must be within 60 seconds of the end: a session that ended in an error or an exit of its own needs one; one that the clock stopped needs two, and 2 minutes without a single response before the stop. Read from Claude Code's own error lines (anchored at the start of a line: "API Error", "Request timed out" and the like) on stderr, timed by the harness as they arrive, or in an error result's text, which counts as an error at the end; never a bare number or word, never what the agent wrote. A session that finished, or that its budget or its turns stopped, is never invalid by the API, whatever it retried on the way; a result whose subtype is success counts as finishing only when it is not an error, because Claude Code reports a failed API call as success with `is_error` true | the session's stderr and result (`harness/classify.mjs`) |
| A host the run cannot do without, `api.anthropic.com` or `registry.npmjs.org`, failed persistently during the session: at least two failed attempts, and no successful connection in the session's window, or 5 minutes of continuous failing (no gap of more than 2 minutes without an attempt) with no success between. Errors to documentation hosts, and a single error that a retry got past, are recorded per task and arm and never invalidate | the egress log, by time, inside the session's window |
| The scorer failed: its PostgreSQL or S3 failed before or after the scoring, its checks threw, the npm registry could not be reached (see above), the seeded reference did not install, or the whole scoring reached its last bound. Each is scored once more, at most, before it counts | `score.json` and `score-attempts.jsonl` |
| The harness could not take the snapshot | `run.json` (`snapshotOk: false`) |
| The harness failed, before the first task or during any, or was stopped during the run | `run.json` |
| A task was skipped because the phase cap could not cover its budget | `run.json` |

An exhausted or refused API key (out of credit, or 401 or 403) stops the
phase: every run after it would fail the same way, and those would be zeros
the agent did not earn.

A snapshot that is missing, does not install for a reason other than the
network, or does not start, is the agent's failure and scores zero; it is not
invalid. Any invalid task makes its whole run invalid. An invalid run is
published with its reason, counts in no figure, and is replaced once by a run
of the same arm and model appended at the end of the order (`plan.mjs
--extend`); a replacement that is itself invalid is not replaced again.
Replacements run after the planned order, so they do not alternate with the
other arm the way the planned runs do; any drift in the API during the phase
falls on them unevenly. Declared, not corrected; the report lists which runs
are replacements.

Checked in the pilot's records before the full phase, against Claude Code
2.1.330 itself; anything found is a deviation, fixed and frozen again before
the full phase:

- which hosts Claude Code calls (its WebFetch tool in particular), from the
  egress log;
- whether the usage on each stream line is per response or cumulative, which
  decides whether the per-message-id sum of `harness/usage.mjs` is right;
- the actual `is_error`, `subtype` and stderr texts of an API error, a budget
  stop and a turn stop, against the patterns of `harness/classify.mjs`;
- whether a session the harness stops leaves a usable stream.

## Money

The approved ceiling is $500, and it is a ceiling, not a target. The pilot's
cap is $100; the full phase's is $400. Before each run the harness adds up what
the phase has spent, counting for each task the larger of Claude Code's own
figure and the estimate from the stream, so a session that was stopped or died
is counted too. Every task has its own fixed budget ($15, $6, $6), never what
is left of the run. A run starts only if what remains of the cap covers the
sum of the three ($27) plus $9 of slack ($3 a task) for the one-turn
overruns, so that in practice no task is ever skipped. If overruns ever did
exceed that slack, the task would be skipped and the run invalid and replaced,
rather than run with a smaller budget; that would drop a run that overran,
which is a struggling run, and the report would say so.

Because a run needs $36 left to start, the last run of a phase needs $36 left
whatever the runs cost, and the caps are sized for that (`harness/money.mjs`,
whose figures `harness/rules.test.mjs` checks against `harness/config.json`,
including that the two caps together never exceed the approved $500).
**Pending approval on 30 November, with the freeze:** the slack
stays at $9; the pilot's cap is $110, which starts all 8 runs at the high
estimate below (with $100, run 8 would not start); the full phase's cap is
$390, the $500 ceiling less the pilot's. At the high estimate the pilot has
$35 left after its 8 runs, so a replacement for an invalid pilot run does
not start (it needs $36; $111 would allow one).

The gate between the pilot and the full phase is manual, decided by whoever
approves the spending, not by `run.mjs`: the full
phase starts only if the pilot's measured mean cost per run, times 39, plus
$36, fits the full phase's $390, that is up to $9.07 a run. At the high
estimate ($9.38 a run) it does not fit, and the full phase needs a new
approval.

Expected cost of the pilot, estimated, not measured. The pilot is 8 runs: two
per cell, four cells (two arms, two models), so 4 runs of each model.

| | Per run (three tasks) | Runs | Total |
|---|---|---|---|
| Opus 5.5, central | about $5.00 | 4 | about $20 |
| Sonnet 5.5, central | about $2.50 | 4 | about $10 |
| Pilot, central | about $3.75 | 8 | **about $30**; all 8 start |
| Pilot, high (2.5 times) | about $9.38 | 8 | **about $75**; all 8 start with the $110 cap, none is replaced |
| Pilot, at the limits | $27 | 8 | 3 runs start |

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
| Arm A reads only the documentation inside the package; filelayer.dev is not reachable. A real agent could also read the live site (guides, comparison pages), and this benchmark does not measure what that adds or costs | either | declared as a limitation; the package's copy is what is frozen, by the tarball's integrity hash |
| The package's own documentation sends arm A to filelayer.dev 13 times (4 in `README.md`, 4 in `llms.txt`, 5 in `docs/` and `skills/`), and those links do not open; arm B's documentation sites are reachable | against Filelayer | declared; a failed attempt is in the egress log, so its cost in tokens and time is in the run's figures |
| The models know S3 from training and Filelayer not | against Filelayer | the real situation; reported without correction |
| Arm A is told to use Filelayer; a real user would have to choose it | Filelayer | this measures implementation, not selection; selection is measured by the discovery gates |
| The library's own code is not counted as lines | Filelayer | its size is reported next to arm A's lines |
| Checks the agent does not see | neutral | the same smoke test for both arms |
| Model randomness | neutral | 10 runs per cell, random interleaved order, intervals |
| The seeded bug is one line in arm B and two changes in arm A, and arm A has two places to see it | either | restoring the route's check fixes both, one line in each; any fix is judged by its effect, and a partial fix in arm A fails on documents uploaded while the bug was live |
| The S3 emulator is not S3 | either | the same emulator for both arms; moto accepts what the AWS SDKs send by default |
| Publishing only what is favourable | Filelayer | this preregistration, and publication of every run |

## Deviations

None yet.
