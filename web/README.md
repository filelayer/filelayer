# web/

The public site for Filelayer. **One page, no framework, no build step.**

```
web/
  index.html    the homepage — all copy lives here
  styles.css    one stylesheet, no preprocessor
  robots.txt    deliberately permissive, including to AI crawlers
  sitemap.xml
  og.png        the Open Graph card, 1200×630 — check-web.mjs enforces both
```

Open `web/index.html` in a browser. That is the whole development loop.

---

## Why it is built this way

**No JavaScript is required to read anything on the page.** AI crawlers do not
reliably execute it, and Bing indexation gates a large share of the citations
this project is trying to earn. `tools/check-web.mjs` fails the build if a
`<script>` other than JSON-LD appears, or if an inline event handler does.

**No framework and no build step**, because the package it advertises has zero
runtime dependencies and one maintainer. A site that needs `npm ci` before
anyone can fix a typo is a site that stops getting typos fixed.

**No webfont.** System stack. The page renders on the first paint.

---

## The one visual idea

A line that decides. The two accent colours — `--allow` and `--deny` — mean
exactly what they say and are used nowhere else. They mark permitted and refused
paths in the code samples and the audit output, which is the product's entire
behaviour rendered as colour.

If a future edit uses `--allow` for a button that has nothing to do with an
access decision, the idea is gone and this becomes another dev-tool landing
page. Use `--ink` for that.

---

## What is provisional and what is not

**The H1 and the lead paragraph are provisional.** They are being tested with
developers and may be replaced. There is a comment at the top of `index.html`
saying so, and nothing else on the page depends on them.

**Every factual claim is not.** Version numbers, test counts, what Filelayer
guarantees and what it does not, the private-bucket requirement, and the
middleware-not-RLS distinction are checked against the published package. If a
claim on the page is not true of the version in `packages/core/package.json`, that is a bug, not a
copy preference.

The claims most easily broken by a well-meaning edit, all of which have cost us
a correction already:

- Filelayer is **authorization middleware, not row-level security**.
- **Filelayer cannot make your bucket private.** That remains the reader's job.
- No CDN on the default byte path, no `Range` in the shipped routes, no
  transformations, no direct browser-to-storage upload.
- **Zero known production deployments.**

---

## Checks

```bash
npm run check:web            # part of `npm run verify`
node tools/check-web.mjs --list        # every link and where it goes
node tools/check-web.mjs --self-test   # the negative controls only
```

The load-bearing assertion is that **every `github.com/filelayer/filelayer/blob/main/…`
link resolves to a file that exists in this working tree**, and that every
`#anchor` on such a link matches a real heading in that file. GitHub answers a
dead path with a page that looks fine, so nobody notices by clicking. Headings
get renumbered — `docs/QUICKSTART.md` §6 became §7 during the 0.4.4 audit, and
the README pointed at the old one.

`check-web.mjs` also asserts: one `<h1>`, no skipped heading levels, `alt` on
every image, the meta a search result and a social preview need, JSON-LD that
parses and whose `softwareVersion` matches `packages/core/package.json`, and a
`robots.txt` that does not block the crawlers this project depends on. It
deliberately refuses JSON-LD containing `aggregateRating`, `review` or `offers`:
we have no ratings, no reviews and no price, and inventing them would destroy
the one argument this page makes.

**It does not check every claim.** `check-version-claims.mjs` measures the
version and the test counts in the trust table against a recorded run, §5 above
checks the counts attached to the examples, and `check-live-site.mjs` asks the
same questions of the DEPLOYED page. A number stated anywhere else in the prose
is unguarded — the page carried `v0.7.0` in two places and `375 across 94` in a
third while the table beneath them was correct. Adding a number to this page
means adding it to `CLAIMS` in `check-version-claims.mjs` in the same commit.
Whether the prose is TRUE is still what review is for.

---

## Deploying

Static hosting, any provider. Serve `web/` as the document root.

Two files should also be reachable at the site root for agents, and they are
**not** copied into `web/` on purpose — the repository root is the single source
of truth and a second copy is a second thing to forget to update. Have the
deploy step copy them:

```bash
cp llms.txt openapi.yaml openapi.json <publish-dir>/
```

Until that is wired, the page links to them on GitHub, which is accurate today.

**The domain `filelayer.dev` is live**, and the deploy tracks `main`: on
4 October 2026 the served page was byte-identical to `git show HEAD:web/index.html`.
The domain appears in `canonical`, the Open Graph tags, `robots.txt` and
`sitemap.xml`; `tools/check-web.mjs` fails if those four disagree.

`npm run check:live` fetches the served page and compares its version and test
counts with this tree. Nothing else here makes an HTTP request to the site it
describes, so without it a deploy that stopped, cached or published the wrong
branch would look exactly like success. It runs nightly, not on push: a push
legitimately precedes the deploy by a minute or two.

**`og.png` is in place** at 1200×630. `tools/check-web.mjs` fails the build if
it goes missing or changes dimensions, so this is not a thing to remember.
