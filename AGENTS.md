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

`npm run verify` is the whole contract: the test suite plus 21 gates. CI runs
the same thing, so a green `verify` locally is a green CI, and there is no
second list of things to remember.

If you are iterating and six minutes is too slow, the gates are individually
runnable — `npm run check:docs`, `check:web`, `check:versions` and so on — but
**run the full `verify` before you say you are done.** Several gates exist
precisely because somebody checked the part they were thinking about.

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

Three rules account for most review comments here, and they are worth
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
