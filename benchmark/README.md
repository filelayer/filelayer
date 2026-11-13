# Filelayer next to four hand-built file layers

One application, built five ways, measured by the same scripts. The
application is a B2B document workspace: organizations, roles, upload,
per-role access, share links that carry an expiry, a password and a download
cap, revocation, and an audit trail. It is built:

| Directory | Built with |
|---|---|
| `examples/vault/` (shipped inside `@filelayer/core`) | `@filelayer/core` on PostgreSQL |
| `benchmark/baseline-supabase/` | Supabase Storage and Postgres row-level security |
| `benchmark/baseline-raw-s3/` | S3 or R2 presigned URLs and Postgres |
| `benchmark/baseline-convex/` | Convex and its R2 component |
| `benchmark/baseline-vercel-blob/` | Vercel Blob (a private store) and Postgres |

## Run it

From a fresh clone, with Node 22.18 or later:

```bash
git clone https://github.com/filelayer/filelayer.git
cd filelayer
node benchmark/run.mjs
```

That one command installs what it needs with `npm ci`, runs every measurement
below and writes `benchmark/RESULTS.md` and `benchmark/adversarial/RESULTS.md`.
It needs no account, no credential and no environment variable. The network is
used for npm and for nothing else: the Supabase implementation runs on PGlite
with the platform schema emulated, and the S3 one against a local store that
verifies SigV4 signatures.

`node benchmark/run.mjs --print` measures and prints without writing.
`--no-install` reuses the `node_modules` already in place.

## What is measured

| Measure | Script | What it counts |
|---|---|---|
| Application lines | `count-loc.mjs` | Non-blank, non-comment lines the developer writes, per implementation, with every inclusion and exclusion written down in `loc.manifest.json`. A file that matches no rule fails the run. |
| Vendor lines | `count-vendor.mjs` | Lines of vendor code that run in your process or your database, where they can be measured: the Filelayer library and its schema, the AWS SDK. Not added to the application lines. |
| Security-sensitive decisions | `count-decisions.mjs` | Points where the developer can choose an option that leaks or loses data and nothing reports it: no error, no failing test, no warning. Counted as kinds and as places, from `decisions.json`. |
| Lines per tier | `count-tiers.mjs` | The four Filelayer examples, from a public avatar to the full workspace. |
| Attacks | `adversarial/run.mjs` | 26 attacks, written once in `adversarial/attacks.mjs`, against every implementation that can be executed: over HTTP for Filelayer and raw S3, and as direct calls into the application's functions for Supabase, whose platform is emulated on PGlite. The headline table holds only the attacks every executed implementation can express. |
| Time to first file | `ttff/measure.mjs` | Install from npm to the first stored file, using the program printed in the `QUICKSTART.md` that ships in the package. |

## Which Filelayer is measured

The version pinned in `benchmark/package.json`, installed from npm. The attack
suite runs its compiled code and the `examples/vault/server.ts` inside its
tarball, and the line counters read the examples from that tarball, so every
Filelayer number describes what a stranger installs. To measure another
version:

```bash
npm --prefix benchmark/ install @filelayer/core@<version>
node benchmark/run.mjs --no-install
```

`npm run adversarial` at the repository root runs the same attacks against the
working tree instead, on every commit.

## The production-wired Filelayer

`production-wired/` is the published example with its demo boot (in-memory
database and storage) replaced by what a deployment needs: a pg pool, the schema
applied once under a lock, `S3Storage`, and the IAM and bucket policy. It is
counted beside the example with the same rules, and
`node benchmark/production-wired/smoke.mjs` runs it end to end against
PostgreSQL and the SigV4-checking store, after checking that everything above
its boot block is the published example unchanged.

## The revision round and the brief

`revisions/` holds the one revision round each executed alternative had, with
its diff and a 40-line cap. `BRIEF.md` says what survives of the brief the
alternatives were built from, and publishes the prompts that exist.

## What does not run

The Convex and Vercel Blob implementations have no executable form: one needs a
live Convex deployment and the other a private Vercel Blob store, and an
emulation of either would test the emulation. They are reported as not run,
never as passing. Their code is still counted for lines and decisions, from
their own lists, and those counts are probably low because the attack suite
cannot find what their authors missed.

## Disagreeing with a number

Every number comes from data in this directory. Remove a row from
`decisions.json`, or change a rule in `loc.manifest.json`, and run the script
again to get your own figure. Each implementation's directory has a `REPORT.md`
that describes how it was built and what it does not cover.
