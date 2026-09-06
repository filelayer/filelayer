# Contributing to Filelayer

Thanks for looking. This is short on purpose.

## Before you start

- **Security bugs do not go here.** See [SECURITY.md](SECURITY.md) and report
  privately.
- **Open an issue before a large change.** Filelayer is pre-1.0 and the
  authorization model is still moving; a big PR against a design we are about to
  change wastes your evening, not ours.
- Small fixes — a dead link, a wrong type, a failing edge case with a test —
  need no discussion. Just send them.

## Setting up

Requires **Node ≥ 22.18**. There is no Docker, no daemon, and no database to
install: the tests run against PGlite, PostgreSQL compiled to WebAssembly and
running in-process.

```bash
git clone https://github.com/filelayer/filelayer && cd filelayer
npm run bootstrap        # npm ci in packages/core
npm test                 # the security property suite
```

PGlite is a **devDependency and an optional peer dependency** of
`@filelayer/core`, never a dependency: a library you point at your own Postgres
must not put an embedded WebAssembly Postgres into every production
`node_modules`. `npm run bootstrap` installs it for you here, because the suite
needs it. If you add a runtime dependency, the release gate below will fail —
that is deliberate.

### The live storage suite

`packages/core/test/s3-live.test.ts` runs the S3 adapter against a real bucket
and skips itself, loudly, when credentials are absent — so it does nothing on a
clone and nothing on a fork's CI. If you are a maintainer and want it running,
[`docs/LIVE-S3-TESTS.md`](docs/LIVE-S3-TESTS.md) is the whole setup: one bucket,
one scoped token, five repository secrets, about five minutes.

## Before you open a pull request

```bash
npm run verify
```

That is typecheck, tests, build, the publication-boundary check, the
internal-language check, the link check, the OpenAPI check, the
documentation-sample check and the adversarial suite. CI runs the same thing,
plus the packaging gate below, so running it locally is purely so you find out
faster.

If you touched anything about packaging, licensing or the public API surface,
also run the release gate — it packs the tarball, installs it into an empty
directory and drives the whole lifecycle as a stranger would:

```bash
npm run verify:release
```

## What a good pull request looks like

1. **A test that fails before your change.** For anything touching
   `src/authz.ts`, `src/store.ts` or `schema.sql`, this is not negotiable. The
   suite is the product.
2. **A named security property, if one applies.** P1–P5 are listed in the
   [README](README.md) and P6–P8 in
   [`packages/core/SEMANTICS.md`](packages/core/SEMANTICS.md). If your change
   affects one, say which and how.
3. **A changelog entry** in `packages/core/CHANGELOG.md` for anything a user
   would notice. If it changes the schema, it also needs a migration in
   `packages/core/MIGRATIONS.md`.
4. **Comments that explain why, not what.** This codebase documents the
   reasoning behind a decision — especially the ones that look wrong until you
   know the reason. Match that. A comment saying "increment the counter" will be
   asked to justify itself.

## House rules that a linter enforces

- **Shipped code and shipped docs describe behaviour.** Not a process, not an
  identifier only the author can resolve. `npm run check:language` fails the
  build on it; the policy is `.internal-language.json` and is meant to be
  edited when the policy changes — never the checker.
- **This repository is the product.** It is developed inside a larger working
  folder, so `npm run check:boundary` reads every tracked file — and every blob
  in the history, because a push sends all of them — and fails on writing that
  belongs somewhere else. It also keeps `.gitignore` deny-by-default at the top
  level, which is why adding a top-level file means adding one `!` line there.
  Run `node tools/check-publication-boundary.mjs --explain` for what each of
  its four checks does. When it fires it quotes the line; the fix is to rewrite
  the sentence so it says the technical thing.
- **No relative links out of `README.md` or `packages/core/**` that leave the
  npm tarball.** npm renders the README against the registry, not GitHub, so
  such a link is a 404 for anyone who found us through npm. Use an absolute
  `https://` URL. `npm run check:links` enforces this.
- **Every fenced code sample must run.** `npm run check:docs` executes them.

## Licensing of contributions

Filelayer is licensed under [Apache-2.0](LICENSE). By opening a pull request you
agree that your contribution is licensed under the same terms — this is
Apache-2.0 section 5, and it is the whole of the arrangement. There is no CLA
and no copyright assignment.

If you add a file, do not add a per-file licence header; this project does not
use them. `LICENSE`, `NOTICE` and the `license` field in `package.json` carry
the grant.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
