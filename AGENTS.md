# Working in this repository

Read this before changing anything here. It is short on purpose.

**If you are not changing this repository — if you are integrating Filelayer
into an application — this is the wrong file.** Read
[`llms.txt`](llms.txt) instead: it is written for exactly that, it is ordered by
what you need to get right, and it ships inside the npm tarball so you can read
it from `node_modules/@filelayer/core/llms.txt` with no network.

---

## The one command

```bash
npm run bootstrap     # once: npm ci inside packages/core
npm run verify        # everything. ~6 minutes.
```

`npm run verify` is the whole contract: the test suite plus every gate in this
repository — `node tools/verify-stepwise.mjs --list` prints them. CI runs
the same thing, so a green `verify` locally is a green CI, and there is no
second list of things to remember.

If you are iterating, or if your environment will not let one command run for
six minutes, do not hand-pick gates:

```
node tools/verify-stepwise.mjs          # every step of `verify`, one at a time
node tools/verify-stepwise.mjs --list   # which have passed, which have not
```

It discovers the steps by parsing `verify`, so there is no list to keep in
agreement, it remembers results against the working tree's hash so you can
resume across several short runs, and a step that exceeds its time budget is
reported **UNRUN** rather than counted as a pass.

Both of those matter because both have gone wrong. Running a hand-typed list of
the quick `check:*` gates leaves out the ones not named `check:` anything:
eighteen passed, `typecheck` was not among them, and CI failed on `typecheck`
across three Node versions. And `check:suite-install` takes five minutes, so it
has twice been the only unrun gate on a commit that CI then rejected — once for
a real defect. **A gate you could not run is not a gate that passed**, and
saying which ones you could not run is part of saying you are done.

---

## Five things that will fail the build if you do not know them

1. **`web/guides/*.html` is generated. Never hand-edit it.** It is rendered from
   `docs/guides/*.md` by `tools/build-guides.mjs`, and `npm run check:guides`
   re-renders in memory and fails on a one-byte difference. Edit the markdown,
   then run `node tools/build-guides.mjs`.

2. **Some files exist twice and must be byte-identical.** The npm package ships
   its own copies of the README, the guides, `llms.txt` and others under
   `packages/core/`. `npm run check:copies` compares them. Change one, copy it
   to the other, in the same commit.

3. **Code blocks in the documentation are executed.** Every ` ```ts ` block in
   `README.md`, `docs/QUICKSTART.md` and `docs/guides/*.md` is run by
   `npm run check:docs` against the real library. A sample that stops working
   fails the build rather than quietly becoming untrue. To exempt one, put
   `<!-- doccheck: skip reason="..." -->` above it; the reason appears in the
   summary, so the cost of skipping stays visible.

4. **A number stated in a public file is checked against the thing it counts.**
   Test totals, suite counts, the version, how many checks the starter runs:
   `npm run check:versions` reads the measured value and compares. Do not update
   a published figure by hand to make a gate pass — re-measure, or the figure
   was wrong.

5. **The repository root is deny-by-default.** `.gitignore` starts with `/*` and
   names every public file. Adding a file at the root means adding one `!` line
   there, in the same commit. That friction is deliberate: this repository is
   the product, and anything not named is treated as working material that does
   not ship.

---

## What this project is unusually strict about

Five rules account for most review comments here, and they are worth
internalising rather than rediscovering.

**A document that is wrong is worse than no document.** The reader trusted it
enough to paste it. If you change behaviour, the pages that describe it change
in the same commit, and a stale sentence is a defect with the same standing as
a failing test.

**Registration is not coverage.** A checker pointed at a hand-written list of
files does not check the file somebody added yesterday, and it reports success
while doing so. Prefer discovering what exists over enumerating it; where a list
really is better, make the list prove it is complete. The checker that enforces
the register in this very file was itself the example: its list of scanned files
was hand-written, so `skills/` and this page were both public and both unscanned,
and it printed `clean` the whole time.

**Verify against the published artifact, not the checkout.** A tarball packed
locally proves the working tree is coherent and proves nothing about what a
stranger receives. `npm install @filelayer/core` served a release four versions
behind for two days while every gate was green, because all of them packed this
checkout and none had ever run the command the README prints. The same mistake
at the feature level: the README, llms.txt and a changelog entry all said
"eight tools by default" over a list of seven, and the number could only be read
honestly by installing the published package and asking the server.

**A gate asks one of two questions, and only one of them has an answer before a
publish.** "Is the published state coherent?" is always answerable. "Does this
checkout match what is published?" has no answer while the release is being
prepared, and a gate that conflates them makes every release commit unable to
pass — which is how a suite stops being believed. This went wrong three times in
one day: `check:published` first compared the served README against the working
tree, turning every README edit red until a publish; `check:since` tried to
install the version being prepared; and `check:published` again, comparing the
installed version against this checkout's. Verifying against the registry is
right. Making unreleased work look like a defect is not. When a check cannot be
answered yet, say UNVERIFIED in the output and never print a summary claiming
you checked something you skipped.

**Say what it does not do.** [`LIMITATIONS.md`](LIMITATIONS.md) is a real
document and it is not marketing copy with the edges filed off. If you ship a
capability with a hole in it, the hole goes in that file in the same commit. If
you remove an entry, it is because the limitation is gone, not because the list
got long.

---

## Where things are

| | |
|---|---|
| the library | `packages/core/src/` |
| the schema | `packages/core/schema.sql`, migrations in `packages/core/migrations/` |
| the suite | `packages/core/test/` — TypeScript, run directly by `node --test` |
| the gates | `tools/check-*.mjs` — each one's header says what defect it exists for |
| the guides | `docs/guides/*.md` with a `*.proof.mjs` beside most of them |
| the site | `web/` — served exactly as committed; nothing builds it |
| runnable examples | `examples/`, driven by `npm run example:*` from the root |

Every gate in `tools/` opens with a comment explaining the specific thing that
went wrong and made it necessary. If you are about to argue with a gate, read
its header first — the answer is usually there, and it is usually a defect this
project already shipped once.

---

## Things that need a human

Do not do these on your own initiative: ask.

- `npm publish`, `npm deprecate`, or moving a dist-tag
- anything that changes the published version number
- rewriting git history, or force-pushing
- creating or rotating a credential of any kind
- posting anywhere public under the project's name

---

## If a gate fails and you believe it is wrong

That happens, and it is worth saying out loud rather than working around. Fix
the gate, in its own commit, with its header updated to say why the old rule was
wrong. What is not acceptable is loosening a gate so that the change you were
already making passes: that converts a failing check into a silent one, and the
next person has no way to tell the difference.
