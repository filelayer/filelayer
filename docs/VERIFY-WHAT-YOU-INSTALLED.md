# Run the test suite against the copy you installed

Every behavioural claim this project makes is backed by a test, and the tests
ship inside the npm tarball so you do not have to take our word for either. This
page is the exact procedure, and it is executed by CI on every commit against a
freshly packed tarball, so it cannot quietly stop working.

It takes about two minutes and needs no account, no credentials and no database.

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
VERIFY="${TMPDIR:-/tmp}/filelayer-verify"

rm -rf "$VERIFY" && mkdir -p "$VERIFY" && cd "$VERIFY"
cp -R "$PKG"/. .
rm -rf node_modules dist

printf '{"name":"filelayer-verify","private":true,"type":"module"}\n' > package.json
npm install --no-save "@electric-sql/pglite@^0.3.11"

node --test 'test/*.test.ts'
```

Three details in there are load-bearing:

- **The whole package directory is copied, not a hand-picked subset.** The suite
  reads `schema.sql`, the files under `migrations/`, and the applications under
  `examples/`. Copying `test/` and `src/` alone produces fifteen failures that
  are entirely an artefact of the copy, which is a bad way to learn that our
  tests pass.
- **`package.json` is replaced.** Ours lists development dependencies, and
  installing those would pull in the very packages whose absence you may be
  trying to test.
- **PGlite is the only thing installed.** It runs PostgreSQL in-process, so the
  suite needs no server. It is pinned to `0.3.x`; npm's `latest` is `0.5.x` and
  installing that fails to resolve.

## What you should see

| | |
|---|---|
| tests | 547 |
| pass | 539 |
| fail | **0** |
| skipped | 8 |
| suites | 130 |

The eight skips are the concurrency suite in `test/contention.test.ts`. Those
tests stage races between two real database connections, which PGlite cannot
provide because it has a single backend, so they need the `pg` driver and a
server. They are not optional for us: CI runs them on every commit against a
real PostgreSQL and fails the job if they skip there. To run them here too:

```bash
npm install --no-save pg embedded-postgres
FILELAYER_TEST_CONTENTION=1 node --test 'test/contention.test.ts'
```

Until 5 October 2026 that suite did not skip, it crashed, with
`ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`. The driver was imported at the
top of a shared helper, so the module failed to load before the skip logic it
contained could run. Anyone who followed our invitation to run the tests saw a
failure, and nobody had followed it.

## If the numbers do not match

That is a real finding and we want it. Please
[open an issue](https://github.com/filelayer/filelayer/issues) with the output,
your Node version and your platform. A test that passes for us and fails for you
is more useful to this project than one that passes everywhere.

The suite is also readable without running anything: `test/` is in the tarball
and every file opens with a comment explaining what property it pins and why
that property is worth pinning.
