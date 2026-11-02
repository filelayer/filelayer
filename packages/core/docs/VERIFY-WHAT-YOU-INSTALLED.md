# Run the test suite against the copy you installed

Every behavioural claim this project makes is backed by a test, and the tests
ship inside the npm tarball so you do not have to take our word for either. This
page is the exact procedure, and it is executed by CI on every commit against a
freshly packed tarball, so it cannot quietly stop working.

It needs no account, no credentials and no database. On a clean install on a
2 vCPU machine it took about 12 minutes (742 s as a normal user, 730 s as
root); that is a measurement on one machine, not a promise, and yours will
differ.

## Why it is not simply `node --test node_modules/@filelayer/core/test/`

Because that does not work, and it is worth saying why rather than leaving you to
find out:

```
ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
```

The suite is TypeScript, run directly by Node's built-in test runner with no
build step. Node refuses to strip types from any `.ts` file located under
`node_modules`, with or without `--experimental-strip-types` and with or without
`--experimental-transform-types`. That is a deliberate Node restriction, not a
flag we forgot.

So the files have to be read from somewhere else. Copying them out is the whole
trick, and it preserves the only property that matters here: **you are running
the bytes you were sent**, not a checkout of our repository that may differ from
the version you installed.

## The procedure

Run this from any project that already has `@filelayer/core` installed.

<!-- EXECUTED BY: tools/check-suite-runs-from-install.mjs
     The block below is run verbatim by CI, from inside a project with a
     freshly packed tarball installed, and the run must report the counts in
     the table further down. If you edit the block, CI runs what you edited. -->

```bash
PKG=$(node -p "require.resolve('@filelayer/core/package.json')" | xargs dirname)
VERIFY=$(mktemp -d "${TMPDIR:-/tmp}/filelayer-verify.XXXXXX")

cd "$VERIFY"
(cd "$PKG" && tar --exclude=./node_modules --exclude=./dist -cf - .) | tar -xf -

printf '{"name":"filelayer-verify","private":true,"type":"module"}\n' > package.json
npm install --no-save "@electric-sql/pglite@^0.3.11"

node --test 'test/*.test.ts'
```

Four details in there are load-bearing:

- **The whole package directory is copied, not a hand-picked subset.** The suite
  reads `schema.sql`, the files under `migrations/`, and the applications under
  `examples/`. Copying `test/` and `src/` alone produces fifteen failures that
  are entirely an artefact of the copy, which is a bad way to learn that our
  tests pass.
- **`package.json` is replaced.** Ours lists development dependencies, and
  installing those would pull in the very packages whose absence you may be
  trying to test.
- **Nothing is deleted.** The directory comes from `mktemp -d`, so every run
  starts in an empty one, and `node_modules` and `dist` are left out of the
  copy. An agent's sandbox refused the earlier version's `rm -rf`, and the
  agent had to rewrite the block by hand, which is the one thing this procedure
  must not require.
- **PGlite is the only thing installed.** It runs PostgreSQL in-process, so the
  suite needs no server. It is pinned to `0.3.x`; npm's `latest` is `0.5.x` and
  installing that fails to resolve.

## What you should see

| | as a normal user | as root |
|---|---|---|
| tests | 746 | 746 |
| pass | 711 | 710 |
| fail | **0** | **0** |
| skipped | 35 | 36 |
| suites | 163 | 163 |

The lines will look different depending on your Node version and whether you are
piping the output: Node 22 writes `# tests 746`, Node 24 writes `ℹ tests 746`,
and a terminal gets ticks and timings as well. The numbers are the same. Only
the reporter changed, and CI reads both, because reading one of them is how this
gate first reported a passing run as a failure.

The thirty-five skips are four groups. As root there is a thirty-sixth:
mode bits do not bind root, so `test/fs-storage.test.ts` cannot stage an
unreadable directory, and its check that an unreadable store is not reported
as empty skips and says why. It is skipped rather than passed, because a pass
would claim a refusal nobody observed.

**One** is `test/mcp-server.test.ts`, which launches the MCP server as a client would and needs a real PostgreSQL, because that server builds a `pg.Pool` and PGlite is not a server. CI runs it against a real one in a job that FAILS if it skips there.

**Nine** are `test/mcp.test.ts`, which needs the two optional peer
dependencies of `@filelayer/core/mcp`. They are optional precisely so that an
ordinary install does not pull them in, so in this run they are absent and the
file skips itself test by test rather than failing to load. To run them here:

```bash
npm install --no-save @modelcontextprotocol/sdk zod
node --test 'test/mcp.test.ts'
```

The remaining **twenty-five** are two suites that need two real database
connections: `test/contention.test.ts` stages races between them, and
`test/audit-retention.test.ts` needs real `SET LOCAL` behaviour across a
transaction boundary and real advisory locks. PGlite has a single backend and
can give neither, so both need the `pg` driver and a server. They are not optional for us: CI runs them on every commit against a
real PostgreSQL and fails the job if they skip there. To run them here too:

```bash
npm install --no-save pg embedded-postgres
FILELAYER_TEST_CONTENTION=1 node --test 'test/contention.test.ts' 'test/audit-retention.test.ts'
```

Until 5 October 2026 that suite did not skip, it crashed, with
`ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`. The driver was imported at the
top of a shared helper, so the module failed to load before the skip logic it
contained could run. Anyone who followed our invitation to run the tests saw a
failure, and nobody had followed it.

## From a clone of the repository

The table above is for the procedure on this page: the published tarball, with
PGlite as the only thing installed. `npm test` in a clone of the repository
runs the same tests in a different environment, because a clone installs our
development dependencies, so fewer of them skip. Measured on Linux as a normal
user, 2 November 2026, two of the four skip groups above stop skipping and the
other two do not:

- **The two MCP groups run, ten tests in all.** The nine in `test/mcp.test.ts` find
  `@modelcontextprotocol/sdk` and `zod`, and the launch test in
  `test/mcp-server.test.ts` finds `pg` and `embedded-postgres` and starts an
  embedded PostgreSQL by itself. That leaves twenty-five skipped.
- **The other two groups, the twenty-five contention and audit-retention
  tests, still skip, exactly as from the tarball.** They are opt-in: they skip
  unless `FILELAYER_TEST_CONTENTION=1` or `FILELAYER_TEST_DATABASE_URL` is
  set. With the first they start an embedded PostgreSQL; with the second they
  use the server it names, which is what CI does on every commit. With either,
  nothing skips and every test passes.

As root the embedded server refuses to start, so use a normal user or
`FILELAYER_TEST_DATABASE_URL`.

## If the numbers do not match

That is a real finding and we want it. Please
[open an issue](https://github.com/filelayer/filelayer/issues) with the output,
your Node version and your platform. A test that passes for us and fails for you
is more useful to this project than one that passes everywhere.

The suite is also readable without running anything: `test/` is in the tarball
and every file opens with a comment explaining what property it pins and why
that property is worth pinning.
