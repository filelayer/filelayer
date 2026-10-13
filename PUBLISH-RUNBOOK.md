# PUBLISH-RUNBOOK.md

The exact commands to make this repository public and to publish
`@filelayer/core` to npm.

> **This runbook was written for the first public release, `0.3.0`.** The
> repository is public and the version being published is **`0.31.0`**. Steps 0,
> 3, 4 and 6 have been updated to that version so the commands are
> copy-pasteable; steps 1 and 2 are the one-time org and repository setup and
> are kept as the record of what was done. Everything else — the gate, the
> checks, the rollback — is current.
>
> One rule learned the hard way: **do not paste a `#` comment onto a command
> line.** An interactive zsh does not treat `#` as a comment, so the comment
> becomes an argument and `npm publish` fails with `EUSAGE`. Every command below
> stands alone.

**Audience:** one human, at a terminal, already logged in to GitHub in a
browser. You will need to run `npm login` at the terminal in step 3.

**Assumed working directory** for every command below is the repository root
(the directory containing `package.json` and `packages/`). Where a command must
run somewhere else, the runbook says so.

Everything in this file is a command you run. Nothing here is automated, and
nothing here runs itself.

---

## The whole release, in four steps and the order they depend on

This list did not exist until 12 October 2026, and both releases that day went
wrong in the gap it fills. The sections below each describe one step with its
own reasoning, and nothing said that there are four, that they have an order,
or that the fourth VALIDATES the second.

1. **Preflight** — §0. `npm whoami`, then `npm run verify` and
   `npm run verify:release`. Both must exit 0. On 0.28.0 the chain stopped on a
   red gate and the publish went ahead anyway, because `&&` breaking looks like
   the command finishing.

   **You no longer have to remember this.** Each chain ends by stamping the
   content of the tree it verified, and `npm publish` runs
   `tools/refuse-unverified-publish.mjs` as `prepublishOnly` — so a publish
   without both stamps, or with a stamp for different content, is refused before
   anything is uploaded. A chain that breaks leaves no stamp, which makes the
   mechanism that hid the failure the one that now prevents it.
2. **Publish to npm** — §3.3. `npm publish`, then the `dist-tag add`.
3. **Tag the commit** — §6.
4. **Publish the MCP registry entry** — §7. **This step reads npm.** The
   registry refuses the entry with a 400 if the version is not yet visible
   there, which is a correct refusal and not an error to work around: it is the
   registry declining to point clients at a tarball that does not exist. Wait a
   minute and retry the step.

> **A READ OF npm IS NOT PROOF OF ABSENCE.** Step 4 failing with *"version
> 0.29.0 was not found"* twice in a row looked like step 2 never happening. It
> was checked by fetching the packument, which reported 0.29.0 absent and the
> dist-tags one release behind — and step 2 HAD succeeded. The write path then
> refused the re-publish with *"You cannot publish over the previously published
> versions"*, which is the authoritative answer. npm's read replicas lag and
> have lied in both directions here: §4 already records a publish that reported
> 404 on its own tarball minutes after succeeding.
>
> So when the question is "did it publish?", do not answer it by reading one
> endpoint. **Run `npm run is-published`** (optionally with a version). It asks
> down two independent paths — the packument and a HEAD on the tarball URL —
> agrees or says it cannot, and exits 2 on disagreement rather than picking the
> convenient one.
>
> | Exit | Means | Do |
> |---|---|---|
> | 0 | Published; both paths agree it is there | Continue |
> | 1 | Not published, **and no upload was attempted from this tree** | Publish |
> | 2 | No clean answer: paths disagree, one is unreachable, or an attempted upload is still invisible well past replica lag | Read the message; it says which |
> | 3 | Absent, but an upload was attempted minutes ago | Wait and ask again |
>
> **Exit 1 is the one to read carefully, and 3 exists because of it.** On
> 13 October 2026, four minutes after `npm publish` printed
> `+ @filelayer/core@0.31.0`, this tool said *"is NOT published. Both the
> packument and the tarball agree."* Both replicas were equally behind. Two
> reads of a system that propagates in order are not two witnesses while
> neither has arrived — agreement that something is absent is evidence only
> AFTER you have seen the two paths disagree. It is the 12 October defect with
> the count changed: one read taken as proof, then two.
>
> `prepublishOnly` now records the upload attempt, so an absence is reported
> against it. That record is local and uncommitted, so exit 1 says so: a
> publish from another machine leaves nothing here, and the absence is then
> worth no more than the two reads behind it.
>
> And if it cannot get agreement, the only answer that cannot be stale is the
> write path: `npm publish` again, where a 403 *cannot publish over the
> previously published versions* means yes.

---

## 0. Before you start — the five-minute preflight

Run this first. If any of it is not green, stop; publishing is not a step you
can take back cleanly.

**The npm session first, before anything slow.** It expired four times on
7 October 2026, and it fails in a way that does not look like what it is: an
expired token makes `npm publish` answer **404 Not Found** on a package that
exists, because npm will not tell an unauthenticated caller whether a scoped
package is there. Six minutes of `verify` before discovering that is six
minutes wasted, and the 404 sends you looking at permissions and package names
instead of at the token.

```bash
npm whoami
```

Anything other than your username: run `npm login`, finish it in the browser,
and run `npm whoami` again before continuing. Do not paste the next command
while `npm login` is waiting for ENTER; it gets eaten as the keypress and the
command never runs.

```bash
# You are on main, with nothing uncommitted.
git status
git branch --show-current          # -> main

# The whole gate: typecheck, 672 tests, build, language, links, OpenAPI,
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
node -p "require('./packages/core/package.json').version"     # -> the version you are publishing
node -p "require('./packages/core/package.json').name"        # -> @filelayer/core

npm view @filelayer/core version 2>&1 | head -3
# Expected: the version currently on the registry (0.15.0 before this release).
# On the very first publish this was an E404; it will not be one again.
# Anything else unexpected -- stop.
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
tarball is 115 files as of `0.15.1`; the non-`dist/` half is short enough to
read in full:

```bash
cd packages/core && npm pack --pack-destination /tmp && cd ../..
tar -tzf /tmp/filelayer-core-0.15.1.tgz | grep -v '^package/dist/' | sort
rm -f /tmp/filelayer-core-0.15.1.tgz
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

**EXPECT TO DO THIS EVERY TIME, and do it before anything else.** The browser
login npm uses now issues a short-lived token. On 6 October 2026 it expired
twice in one working day, both times surfacing as the first command of the
sequence failing:

```
npm error code E401
npm error 401 Unauthorized - GET https://registry.npmjs.org/-/whoami
```

That is not a problem with the package, the scope or the network, and it reads
like one. It means log in again.

```bash
npm login
npm whoami
```

If your npm account has 2FA set to "Authorization and writes" (it should), the
publish in 3.3 will prompt for a one-time password, and so will
`npm dist-tag add`.

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

# READ FROM package.json, NOT TYPED. This line said `@0.15.1` from the 0.15.1
# release until 12 October 2026 -- eleven versions -- and it is the one command
# here that an operator pastes to move a tag on the version they just shipped.
# The version sweep cannot catch it: this file is deliberately excluded from
# that sweep (see tools/check-version-claims.mjs, which explains why) because
# the rollback section's illustrations legitimately name old releases. The
# exclusion was right about the illustrations and silent about the live
# commands. Deriving the version makes the exclusion's reasoning true instead
# of nearly true.
npm dist-tag add "@filelayer/core@$(node -p 'require("./package.json").version')" alpha

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

**WAIT A MINUTE FIRST, AND DO NOT READ ANYTHING INTO AN EMPTY ANSWER.** npm
says it at publish time — *"Your package is being processed and may take a few
minutes to become available"* — and it means it. For the first minute or so,
`npm view` answers from a replica that still has the previous version and
`npm install <pkg>@<new version>` fails with `notarget`.

This has already produced one wrong conclusion: on 6 October 2026 a check run
seconds after a successful publish reported the old version, and the release was
declared unpublished when it was not. The authoritative evidence that a publish
happened is the publish command's own output. If you want to double-check
anyway, the useful signal is that re-running `npm publish` refuses with
*"You cannot publish over the previously published versions"*.

**AND THE METADATA ARRIVES BEFORE THE TARBALL, which is worse because it is
silent.** On the `0.20.0` publish, `npm view` reported the new version and both
dist-tags while the tarball those metadata point at still answered:

```
npm error 404 Not Found - GET https://registry.npmjs.org/@filelayer/core/-/core-0.20.0.tgz
```

For about five minutes the registry advertised a `latest` that nobody could
install. Timed: the tarball became available **114 seconds after `npm view`
already gave the right answer**.

So `npm view` is not the check. It will tell you everything is fine while
`npm install` fails for every reader. **The check is to install it**, which is
§4.2 below, and that is the reason §4.2 is not optional.

```bash
npm view @filelayer/core
npm view @filelayer/core dist-tags       # -> latest and alpha, BOTH at the version you just published
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
| <https://www.npmjs.com/package/@filelayer/core> | The README renders. The alpha warning is the first thing visible. The tables are tables. The "Apache-2.0" and version chips match the version you just published. The version selector shows it under both `latest` and `alpha` — since 0.4.2 `latest` points at the alpha; see §"the dist-tag" below. |
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

**"Successful" means a `npm publish` with no `--dry-run` in it.** A dry run
ends with the same `+ @filelayer/core@<version>` line as a real one; the only
difference is the word `(dry-run)` four lines above it, in a wall of `npm
notice` output nobody reads to the end.

On 7 October 2026 the tag and the GitHub release for `0.20.0` were created
after a dry run, so for a few minutes both existed and npm had no such version.
Nothing downstream broke, because nobody was looking, which is the only reason
it was cheap.

So: the dry run and the real publish are **separate steps, run and read one at
a time**, and nothing below this line happens until the publish output says
`Publishing to https://registry.npmjs.org/ ... with tag alpha and public
access` WITHOUT `(dry-run)` after it.

```bash
# Tag the released commit and push the tag. The version is read, not typed,
# for the same reason as the dist-tag in §3.3: this said v0.15.1 for eleven
# releases. Write the message yourself -- that part cannot be derived, and a
# tag message is the one line somebody reads years later.
V=$(node -p 'require("./packages/core/package.json").version')
git tag -a "v$V" -m "@filelayer/core $V — <one line on what this release is>"
git push origin "v$V"

# Confirm the tree is still clean: `prepack` copies README/LICENSE/NOTICE into
# packages/core, and .gitignore excludes those copies. `git status` proves the
# copies did not get committed.
git status
```

Then, on GitHub, create a release from the `v0.15.1` tag and paste the `0.15.1`
section of `packages/core/CHANGELOG.md` into it. Mark it as a **pre-release** —
the dist-tag says alpha and the release should agree.

---

## 7. The MCP registry entry

Separate from npm, and done after it: the registry hosts metadata only, so the
package has to exist first. The entry is `server.json` at the repository root
and `check:registry` keeps it true about the package.

**The namespace is `dev.filelayer/core`**, which is the reverse-DNS form of
`filelayer.dev` and therefore commits us to domain-based authentication. The
alternative was `io.github.filelayer/*` with a GitHub login, which is easier and
ties the published name to a GitHub organisation; a domain we own does not move.

### Before anything: the marker has to be published

The registry proves we own `@filelayer/core` by reading `mcpName` out of the
published package and comparing it to `name` in `server.json`. Both are checked
locally by `check:registry`, but the registry reads the **published** one, so a
release has to go out before an entry can be published at all. `0.26.0` is the
first one carrying it.

### Install the publisher

```bash
brew install mcp-publisher
mcp-publisher --help
```

### Generate a key and the TXT record

**Use the ECDSA P-384 path on macOS.** The Ed25519 path needs OpenSSL 3.0 and
macOS ships LibreSSL, whose `genpkey` fails with `Algorithm Ed25519 not found`.
Working around that means installing `openssl@3` and calling it by absolute
path; P-384 works with what is already there and the registry accepts both.

```bash
cd ~/Documents/Claude/Projects/Filelayer

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:secp384r1 -out key.pem

PUBLIC_KEY="$(openssl ec -in key.pem -text -noout -conv_form compressed | grep -A4 "pub:" | tail -n +2 | tr -d ' :\n' | xxd -r -p | base64)"
echo "filelayer.dev. IN TXT \"v=MCPv1; k=ecdsap384; p=${PUBLIC_KEY}\""
```

`key.pem` is a private key. It is not committed, and not because anybody
remembered: the `.gitignore` here is an allow-list at the top level, so a new
file is ignored until it is explicitly allowed. Do not allow this one.

### Add the record ON THE APEX

The TXT record goes on `filelayer.dev` itself, **not** under a selector like
`_mcp-auth.filelayer.dev`. MCP DNS auth follows SPF-style placement, not
DKIM-style. A record under a selector is not found and authentication fails with
a generic signature error that says nothing about placement — which is the
single most likely way this goes wrong.

If a key is ever rotated, remove the old TXT record. A stale one is tried first
and fails verification.

Wait for propagation, then check it:

```bash
dig +short TXT filelayer.dev | grep MCPv1
```

### Log in and publish

> **`mcp-publisher login github` does not authorize this name.** It is the
> obvious command, it succeeds, it prints `✓ Successfully logged in`, and then
> `publish` answers:
>
> ```
> 403 Forbidden: You do not have permission to publish this server.
> You have permission to publish: io.github.jorgeurios/*
> Attempting to publish: dev.filelayer/core
> ```
>
> The GitHub device flow grants the `io.github.<user>/*` namespace and nothing
> else. `dev.filelayer/core` is a DNS-namespaced name, so it is authorized by
> the TXT record above and only by it. This happened on 13 October 2026 while
> publishing `0.31.0`, from this runbook, by someone who had read it — the DNS
> command was three lines below and the GitHub one was in muscle memory. The
> 403 is the registry working: it refused a name the credential did not cover.
> Nothing was half-published, because the login and the publish are separate
> calls.

```bash
# THE KEY LIVES OUTSIDE THE REPOSITORY, and this line said `key.pem` -- a path
# inside it -- until 12 October 2026. That is not a cosmetic difference. On
# 11 October a `key.pem` at the repository root was picked up by the internal
# mirror's sync and pushed to a private GitHub repository; the key was rotated
# and the sync grew two guards, and this runbook went on telling the next
# operator to put a private key back at the path that caused it.
#
# Keys go in ~/.filelayer-keys/, which is not a working copy and is not synced.
PRIVATE_KEY="$(openssl ec -in ~/.filelayer-keys/mcp-registry-key.pem -noout -text | grep -A4 "priv:" | tail -n +2 | tr -d ' :\n')"
mcp-publisher login dns --algorithm ecdsap384 --domain filelayer.dev --private-key "${PRIVATE_KEY}"
```

```bash
mcp-publisher publish
```

### Verify it, against the registry

```bash
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=dev.filelayer/core" | head -c 400
```

And then the thing the entry actually promises: that the command in it starts a
server. `check:published` already runs the README's argv against the installed
package, and the registry entry is held equal to it by `check:registry`, so
those two together cover it — but a client reading the registry for the first
time is a different reader, and trying it from a real client once is cheap.

### A standing cost to know about

The registry is in **preview**: breaking changes and data resets are possible
before general availability, so the entry may need republishing for reasons
that have nothing to do with us. And every release has to republish it anyway,
because the entry names a version. That is a recurring step, not a one-off.
