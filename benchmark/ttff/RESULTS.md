# Time to first file

**Measured 2026-10-17** against `@filelayer/core@0.33.0` **installed from the npm
registry**, not from this checkout. Re-run it:

```bash
node benchmark/ttff/measure.mjs
```

## The numbers

| | |
|---|---|
| `npm install @filelayer/core`, cold cache | 0.8s |
| `npm install --save-dev "@electric-sql/pglite@^0.3.11"` | 0.5s |
| first run, including starting an embedded PostgreSQL | 0.7s |
| **total, install to stored byte** | **2s** |
| lines of application code | 4 |
| **steps requiring a human** | **0** |
| accounts, API keys, dashboards or browser steps | **0** |

## What the clock does and does not transfer

The npm cache is created empty for the run, so these are first-time-reader
seconds rather than warm-laptop ones. They still depend on a network and a
machine, so they are a scale rather than a figure: the point is that it is under a minute and not
under an hour. **The count that transfers is zero** — no account, no credential,
no console, no database to provision. That is the same on any machine, and it
is the number an agent cannot work around: every step it cannot complete alone
is a step at which it writes its own code instead.

The embedded PostgreSQL is a development convenience and nothing else.
Production points at your own Postgres and your own bucket, which is more setup
than this and is setup you were doing anyway.

## Why the program is not the author's

Every line of the measured program is asserted to appear, character for
character, in the `docs/QUICKSTART.md` that shipped **inside the installed
tarball**. If the page stops showing its own first example, this measurement
fails rather than quietly measuring something a reader is never told to write.

## What this is not

It is not a cold agent, and it does not say an agent would choose this. It is a
script with a clock, written by someone who knows the product, and it answers
one question: does the published page's own first example work from a clean
install of the published package, and how long does that take.

Whether an agent picks us is a different measurement. It is not this one.
