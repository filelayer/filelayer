# PUBLISH-RUNBOOK.md

The exact commands to make this repository public and to publish
`@filelayer/core@0.3.0` to npm.

**Audience:** one human, at a terminal, already logged in to GitHub in a
browser. You will need to run `npm login` at the terminal in step 3.

**Assumed working directory** for every command below is the repository root
(the directory containing `package.json` and `packages/`). Where a command must
run somewhere else, the runbook says so.

Everything in this file is a command you run. Nothing here is automated, and
nothing here runs itself.

---

## 0. Before you start — the five-minute preflight

Run this first. If any of it is not green, stop; publishing is not a step you
can take back cleanly.

```bash
# You are on main, with nothing uncommitted.
git status
git branch --show-current          # -> main

# The whole gate: typecheck, 313 tests, build, language, links, OpenAPI,
# doc samples, adversarial suite. Must exit 0.
npm run verify
echo "verify exit: $?"

# The release gate: pack, install into an empty directory, drive the full
# lifecycle as a stranger. Must exit 0.
npm run verify:release
echo "verify:release exit: $?"
```

Check who the history says wrote this. Nothing has been pushed, so this is the
last moment at which the author of the initial commit is cheap to change:

```bash
git log --format='%an <%ae>%n%s' -1
git config user.name
git config user.email

# If either is wrong, fix the identity and rewrite the commit before pushing:
#   git config --local user.name  "Your Name"
#   git config --local user.email "you@example.com"
#   git commit --amend --reset-author --no-edit
```

Confirm the version you are about to publish, and that nobody else already
owns the name:

```bash
node -p "require('./packages/core/package.json').version"     # -> 0.3.0
node -p "require('./packages/core/package.json').name"        # -> @filelayer/core

npm view @filelayer/core version 2>&1 | head -3
# Expected: an E404. Anything else means the name is taken -- stop.
```

Check the artifact one more time, by hand:

```bash
cd packages/core
npm pack --dry-run           # `prepack` runs first: since 0.4.3 it only runs
                             # `tsc`. It copies nothing.
cd ../..
```

In that listing you must see exactly `LICENSE`, `NOTICE`, `README.md`,
`llms.txt`, `openapi.json`, `CHANGELOG.md`, `MIGRATIONS.md`, `SEMANTICS.md`,
`schema.sql`, the two `tsconfig` files, `dist/`, `src/` and `test/`. Anything
else — any repository directory that is not in the `files` array of
`packages/core/package.json` — is a defect, not a bonus.

The first five of those are tracked inside `packages/core` and are byte-for-byte
copies of the files at the repository root. `npm run verify` compares them; you
do not have to. If one of them is missing from the listing, the copy is missing
from git, and `node tools/check-package-copies.mjs` says which.

One last independent check on the artifact rather than on the source tree. The
tarball is 69 files; the non-`dist/` half is short enough to read in full:

```bash
cd packages/core && npm pack --pack-destination /tmp && cd ../..
tar -tzf /tmp/filelayer-core-0.3.0.tgz | grep -v '^package/dist/' | sort
rm -f /tmp/filelayer-core-0.3.0.tgz
```

Read that list. Every entry must be one you can justify to a stranger who
downloaded it.

```bash
# And the same question asked of git rather than of npm: is anything tracked
# that the ignore rules say should not be? Prints nothing if clean.
git ls-files -c -i --exclude-standard

# The real gate, which reads content rather than filenames, across the working
# tree AND every blob in the history.
npm run check:boundary
```

---

## 1. Create the GitHub org and the repository

In the browser (you are already logged in):

1. Go to <https://github.com/organizations/plan> and create a **Free**
   organization named exactly **`filelayer`**.
   - Organization account name: `filelayer`
   - Contact email: the address you want on the org
   - "My personal account" when asked who it belongs to
2. Go to <https://github.com/organizations/filelayer/repositories/new> and
   create the repository:
   - Owner: `filelayer`
   - Repository name: `filelayer`
   - Visibility: **Public**
   - **Do not** initialise with a README, a `.gitignore` or a licence. The
     first push must be this history, not a merge with GitHub's.
3. In the new repository, **Settings → General → Features**, enable **Issues**.
   `README.md`, `SECURITY.md` and `CONTRIBUTING.md` all send people to
   <https://github.com/filelayer/filelayer/issues>; if Issues is off, those
   links 404.
4. **Settings → Code security → Private vulnerability reporting**: enable it.
   `SECURITY.md` promises a private channel.

The repository URL is now `https://github.com/filelayer/filelayer`, which is
what `package.json`, both `package.json` files' `repository` fields, every link
in the README and the CI badge already point at. Nothing needs editing.

---

## 2. Add the remote and push `main`

```bash
git remote add origin https://github.com/filelayer/filelayer.git
git remote -v

# Sanity: this is the exact set of files that becomes public. Read it, as an
# outsider would, before it stops being reversible.
git ls-files | sort | less

# Nothing is tracked that the ignore rules exclude. Prints nothing if clean.
git ls-files -c -i --exclude-standard

# Content-level gate. This is the one that must be green before the push: after
# it, history is public and a mistake in it cannot be taken back.
npm run check:boundary

# What is present in the working tree but deliberately NOT going out. Skim it
# and confirm you agree with every line.
git status --ignored --short | grep '^!!'

git push -u origin main
```

Then, in the browser:

- Confirm the README renders at <https://github.com/filelayer/filelayer>.
- **Actions** tab: the CI workflow should start on the push. Wait for it. It
  runs the suite on Node 22.18, 24.x and 26.x, the adversarial suite, the docs
  and language checks, the clean-install-from-tarball job, the release gate and
  the live storage job.
- If CI is red, fix it and push again **before** publishing to npm. A green
  badge in a README next to a red build is the one thing this project cannot
  afford.
- The **live S3/R2 job will report itself SKIPPED** on that first run, in the
  job summary, because the credentials do not exist yet. That is honest, not
  broken — but it means the storage adapter every download goes through has not
  been exercised against a real bucket. Create the bucket and the five
  repository secrets before you publish: `docs/LIVE-S3-TESTS.md` is the whole
  procedure and takes about five minutes. Re-run the workflow and confirm the
  summary flips to RUNNING.

---

## 3. Claim the npm scope and publish

### 3.1 Log in

```bash
npm login
# username / password / email / one-time password as prompted
npm whoami                      # -> your npm username
```

If your npm account has 2FA set to "Authorization and writes" (it should), the
publish in 3.3 will prompt for a one-time password.

### 3.2 Create the `@filelayer` scope

An npm **organization** named `filelayer` gives you the `@filelayer` scope.
Create it in the browser at <https://www.npmjs.com/org/create>:

- Organization name: `filelayer`
- Plan: **Free** (free organizations may only publish *public* packages, which
  is what we want)

Verify from the terminal:

```bash
npm org ls filelayer            # lists you as an owner
```

If the scope is taken, stop — the package name in `packages/core/package.json`
and every link in the documentation assume `@filelayer/core`.

### 3.3 Publish

```bash
cd packages/core

# Dry run first. This runs `prepack` (`tsc -p tsconfig.build.json`, nothing
# else) and prints the exact tarball.
npm publish --dry-run --access public --tag latest

# The real thing.
npm publish --access public --tag latest
npm dist-tag add @filelayer/core@0.4.3 alpha

cd ../..
```

Notes on that invocation, because each flag is load-bearing:

- **`--access public`** — scoped packages default to *restricted*, which on a
  free organization is a hard error. `packages/core/package.json` also sets
  `publishConfig.access = "public"`; the flag is belt and braces and makes the
  intent visible in your shell history.
- **`--tag latest`** — this changed in 0.4.3, and the reasoning is worth
  reading before changing it back. Releases 0.3.0 to 0.4.2 used `--tag alpha`,
  on the belief that it left `latest` unset so nobody installed the alpha by
  accident. It did not do that: the registry sets `latest` itself when it
  creates a packument, so 0.3.0 became `latest` at the first publish and
  `npm install @filelayer/core` has resolved to the alpha ever since.

  What `--tag alpha` did do was suppress the README. npm copies a version's
  `readme` into the top of the packument — the only description of the package
  a non-browser client can read, because npmjs.com answers 403 to everything
  else — and it does that only for the version published *as* `latest`. Three
  releases sent a complete README that the registry never hoisted, leaving
  `"readme": ""` where every tool and every agent looks. Running
  `npm dist-tag add ... latest` afterwards does not trigger the hoist either;
  the version has to arrive as `latest`.

  The `alpha` tag is added straight afterwards so
  `npm install @filelayer/core@alpha` keeps working. Alpha status is stated by
  the README banner, the `0.x` version and `TRUST.md`, which is where it was
  doing the work.
- **`prepack` runs automatically** as part of `npm publish`. You do not build
  first, and you should not: building separately and then publishing risks
  shipping a `dist/` that does not match the source in the same tarball.
- **Then look at the packument, not just the tarball.** They are different
  artifacts, and the difference is exactly where four releases went wrong:

  ```bash
  curl -s https://registry.npmjs.org/@filelayer/core | node -e \
    "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('readme chars:',(JSON.parse(s).readme||'').length))"
  ```

  Anything under a few thousand characters means the hoist did not happen.
  `publish.sh` asserts this for you.

---

## 4. Verify after publishing

### 4.1 The registry has what you think it has

```bash
npm view @filelayer/core
npm view @filelayer/core dist-tags       # -> { latest: '0.4.3', alpha: '0.4.3' }
npm view @filelayer/core license         # -> Apache-2.0
npm view @filelayer/core files
```

`dist-tags` must show **both** `latest` and `alpha` pointing at the version you
just published. `latest` missing means the publish did not go to `latest`, and
the packument's `readme` will still be empty — see §3.3. `alpha` missing means
the `npm dist-tag add` after the publish did not run; add it by hand.

### 4.2 Fresh install from an empty directory, and the end-to-end flow

This is the same thing `npm run verify:release` does locally, but against the
**registry** rather than a local tarball — so it also proves the publish
itself.

```bash
mkdir -p /tmp/filelayer-smoke && cd /tmp/filelayer-smoke
npm init -y >/dev/null
npm pkg set type=module >/dev/null

npm install @filelayer/core@alpha

# The round trip below and the smoke script after it both go through
# Filelayer.quickstart(), which runs on PGlite. PGlite is an OPTIONAL PEER
# dependency, so the install above deliberately did not bring it: ask for it,
# with the version constraint. Without the constraint npm can resolve outside
# the declared peer range and refuse the tree with ERESOLVE.
npm install --save-dev "@electric-sql/pglite@^0.3.11"

# The package imports by bare specifier, its types and schema.sql resolve, and
# one full round trip through the real authorization engine succeeds.
node <REPO>/tools/verify-install.mjs /tmp/filelayer-smoke
```

Replace `<REPO>` with the absolute path of your clone. Expected: every step
prints `ok` and the process exits 0.

Then drive the advertised lifecycle by hand, as a stranger would:

```bash
cat > /tmp/filelayer-smoke/smoke.mjs <<'EOF'
import { Filelayer } from '@filelayer/core';

const fl = await Filelayer.quickstart({ baseUrl: 'http://localhost:3000' });
const bytes = new TextEncoder().encode('hello from the registry');

// public file -> URL
const { url } = await fl.files.put(bytes, { public: true, name: 'hello.txt' });
console.log('published:', url);

// private, user-owned
const { id } = await fl.files.put(bytes, { owner: 'alice', name: 'private.txt' });
console.log('owner can read:', (await fl.files.get(id, { as: 'alice' })) !== null);

// a stranger cannot
try {
  await fl.files.get(id, { as: 'bob' });
  console.error('FAIL: bob read alice\'s file');
  process.exit(1);
} catch (e) {
  console.log('bob denied:', e.status ?? e.code ?? String(e));
}

// share, then revoke, and the revocation must bite
const share = await fl.shares.create(id, { as: 'alice', expiresIn: 3600, maxDownloads: 3 });
console.log('shared:', Boolean(share.grantId));
await fl.shares.revoke(share.grantId, { as: 'alice' });
console.log('revoked');

console.log('OK');
EOF

cd /tmp/filelayer-smoke && node smoke.mjs
```

Expected final line: `OK`. Then clean up:

```bash
cd ~ && rm -rf /tmp/filelayer-smoke
```

### 4.3 The pages a stranger actually lands on

Open each and look at it, rather than assuming:

| URL | What to check |
|---|---|
| <https://www.npmjs.com/package/@filelayer/core> | The README renders. The alpha warning is the first thing visible. The tables are tables. The "Apache-2.0" and "v0.3.0" chips are right. The version selector shows `0.3.0` under the `alpha` tag and **no** `latest`. |
| <https://github.com/filelayer/filelayer> | The README renders. The four badges at the top all resolve — see below. |
| <https://github.com/filelayer/filelayer/blob/main/ARCHITECTURE-PROGRESSIVE.md> | Renders; §4 tables and §5 list are intact. |
| <https://github.com/filelayer/filelayer/blob/main/architecture/TIER5-DESIGN-NOTE.md> | Renders. |
| <https://github.com/filelayer/filelayer/issues> | Issues is enabled and the page loads. |

**Badges.** The README carries four. After step 2 and step 3 all four should be
live; check each by eye rather than trusting the cache:

- **CI** — green once the workflow has completed on `main`. It reads
  `actions/workflows/ci.yml/badge.svg`, so it goes live with the first run.
- **npm version** — `img.shields.io/npm/v/@filelayer/core.svg`. Shields caches
  aggressively; if it still says "unknown" after a few minutes, force a refresh
  with `curl -sI 'https://img.shields.io/npm/v/@filelayer/core.svg'` and reload.
  It will resolve to `0.3.0` even though the version is behind the `alpha` tag.
- **node** — `img.shields.io/node/v/@filelayer/core.svg`, reads `engines.node`
  from the registry. Should show `>=22.18`.
- **license** — static, already live.

Finally, confirm the two published documents the README links to are readable
by someone who has never seen this repository, and that no link in them points
at a file that is not in `git ls-files`:

```bash
npm run check:links
```

---

## 5. Rollback

### If the push to GitHub is wrong

Nothing is irreversible while the repository is new and nobody has cloned it.
Delete the repository (Settings → General → Danger Zone → Delete this
repository), fix locally, and repeat step 1 and step 2.

### If the npm publish is wrong

**`npm unpublish` works only within 72 hours of publishing**, and only if the
package has no dependents. After 72 hours npm will refuse, and the only
remaining options are `npm deprecate` and publishing a fixed higher version.

```bash
# Remove the single version (within 72h).
npm unpublish @filelayer/core@0.3.0

# Remove the package entirely, including the name (within 72h).
npm unpublish @filelayer/core --force
```

Read this before you type it:

- **The version number is burned.** npm will not let you publish `0.3.0` again
  for 24 hours after unpublishing it, and never with different content. If you
  unpublish, the next publish is `0.3.1`, and `CHANGELOG.md` has to say why.
- **Unpublishing the whole package releases the name.** Someone else can take
  `@filelayer/core`. Prefer unpublishing the single version.
- **Anyone who installed in the meantime gets a broken lockfile**, not a
  warning.

For the common mistakes there are cheaper fixes than unpublishing:

```bash
# Published to `latest` and now want the alpha off the default install path.
# Read §3.3 first: removing `latest` does not restore the "nobody installs this
# by accident" property the tag was originally chosen for -- 0.3.0 already made
# this package's `latest` the alpha -- and it does cost the packument README on
# every release after it.
npm dist-tag add @filelayer/core@0.4.3 alpha
npm dist-tag rm  @filelayer/core latest
npm view @filelayer/core dist-tags        # confirm

# Published something you want to warn people off, but 72h has passed:
npm deprecate @filelayer/core@0.3.0 "Use @filelayer/core@0.3.1; 0.3.0 shipped a broken dist/."
```

`npm deprecate` is reversible (`npm deprecate <pkg>@<version> ""` clears it).
`npm unpublish` is not.

---

## 6. Immediately after a successful publish

```bash
# Tag the released commit and push the tag.
git tag -a v0.3.0 -m "@filelayer/core 0.3.0 — first public release (alpha)"
git push origin v0.3.0

# Confirm the tree is still clean: `prepack` copies README/LICENSE/NOTICE into
# packages/core, and .gitignore excludes those copies. `git status` proves the
# copies did not get committed.
git status
```

Then, on GitHub, create a release from the `v0.3.0` tag and paste the `0.3.0`
section of `packages/core/CHANGELOG.md` into it. Mark it as a **pre-release** —
the dist-tag says alpha and the release should agree.
