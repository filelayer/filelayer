# Productivity benchmark

Does an AI coding agent build a secure document workspace faster, cheaper and
more reliably with Filelayer than on S3 and PostgreSQL by itself? The
question, the hypotheses and how each is decided are in
[PREREG.md](PREREG.md). This file says what is here and how to run it.

## What is here

| Folder | What it holds |
|---|---|
| `contract/` | The service every run builds: `openapi.yaml` and `REQUIREMENTS.md` |
| `prompts/` | The prompt: the common part, one line per arm, one file per task |
| `smoke/` | The smoke test the agent can see and run |
| `reference/` | One implementation per arm (`a-filelayer`, `b-own`), the same after task 2 (`*-t2`), and the seeded bug of task 3 (`*-t3-bug`, see `SEEDED-BUG.md`) |
| `hidden/` | The checks the agent never sees: 29 functional, 8 for task 2, 1 for task 3, the 21 shared attacks from `../adversarial/` with positive controls, the mutants that show each check can fail, and `late/` for the attacks written after the freeze |
| `harness/` | Running the runs, scoring them, and the report |
| `runs/` | The record of every run, once there are runs |

## Requirements

Docker, Node.js 22, and for a real run an Anthropic API key with a spending
limit of its own, in `ANTHROPIC_API_KEY`. The key goes to the agent's
container by name only; it is never written to an argument, a log or a file.

    npm ci

## Check the checks

The references must pass everything, and every mutant must be caught by the
checks it names. These run on the machine itself, with embedded PostgreSQL and
moto (`pip install "moto[server]"`).

    node hidden/check.mjs reference/b-own
    node hidden/check.mjs reference/a-filelayer
    node hidden/check.mjs reference/b-own-t2 --task 2
    node hidden/check.mjs reference/a-filelayer-t2 --task 2
    node hidden/check.mjs reference/b-own --task 3 --seed reference/b-own-t3-bug
    node hidden/check.mjs reference/a-filelayer --task 3 --seed reference/a-filelayer-t3-bug
    node hidden/mutants.mjs
    node hidden/mutants.mjs --task 2
    node --test harness/stats.test.mjs harness/rules.test.mjs harness/history.test.mjs

## Rehearse

A rehearsal runs everything except the model: `harness/fake-claude.mjs`
stands in for Claude Code, copies a reference, installs it through the proxy,
starts it and runs the smoke test. It costs nothing and needs no key.

    node harness/plan.mjs pilot > /tmp/rehearsal/plan.json
    node harness/run.mjs --plan /tmp/rehearsal/plan.json --dry-run
    node harness/score.mjs --runs /tmp/rehearsal --jobs 4 --unfrozen
    node harness/analyze.mjs --runs /tmp/rehearsal --unfrozen
    node harness/report.mjs --runs /tmp/rehearsal --include-dry

On a machine whose own way out is a proxy, add `--proxy host --upstream
<proxy url>` and, if the proxy re-signs TLS, `--extra-ca <bundle>` to `run.mjs`
and `score.mjs`.

## Run

    node harness/plan.mjs pilot > runs/pilot/plan.json
    node harness/run.mjs --plan runs/pilot/plan.json
    node harness/score.mjs --runs runs/pilot --jobs 4
    node harness/analyze.mjs --runs runs/pilot
    node harness/report.mjs --runs runs/pilot

An invalid run (the infrastructure failed; `analyze.mjs` says which and why)
is replaced once: `node harness/plan.mjs --extend runs/pilot/plan.json`, then
`run.mjs` on the same plan again.

`run.mjs` and `score.mjs` refuse to start when any file differs from
`FINGERPRINT.txt`, so a run is made and scored with exactly what PREREG.md
fixed, and `analyze.mjs` refuses a score that does not carry that
fingerprint. `run.mjs` stops a phase at its spending cap
(`harness/config.json`). Started again after it died, it removes what the
earlier harness left, records the run it was in the middle of as invalid
(with its spend), and carries on with the next run.
