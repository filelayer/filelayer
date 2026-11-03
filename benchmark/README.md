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
| Security-sensitive decisions | `count-decisions.mjs` | Points where the developer can choose an option that leaks or loses data and nothing reports it: no error, no failing test, no warning. Counted as kinds and as places, from `decisions.json`. |
| Lines per tier | `count-tiers.mjs` | The four Filelayer examples, from a public avatar to the full workspace. |
| Attacks | `adversarial/run.mjs` | 27 attacks, written once in `adversarial/attacks.mjs`, run over HTTP against every implementation that can be executed. |
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
