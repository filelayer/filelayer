#!/usr/bin/env node
/**
 * Fail the build if the website in `web/` is broken, misleading, or points a
 * reader at something that is not there.
 *
 *   node tools/check-web.mjs               # check, exit 1 on a hit
 *   node tools/check-web.mjs --list        # every link found, and where it goes
 *   node tools/check-web.mjs --self-test   # the negative controls only
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * The site's whole argument is that it is accurate. A landing page that links to
 * `docs/QUICKSTART.md#6-going-to-production` after §6 was renumbered is not a
 * cosmetic defect here -- it is the same class of error as a stale version
 * stamp, on the surface with the widest audience.
 *
 * The load-bearing check is REPO LINKS: every `github.com/filelayer/filelayer/
 * blob/main/<path>` URL is resolved against the actual working tree, and a link
 * to a file that does not exist fails the build. That catches the failure mode
 * a browser test never would, because GitHub answers 404 with a 200-looking
 * page and nobody clicks every link.
 *
 * The rest is hygiene a reviewer would otherwise have to hold in their head:
 * one h1, no skipped heading levels, alt text on every image, the meta tags a
 * social preview needs, and no content that only exists once JavaScript runs.
 *
 * WHAT THIS DOES NOT CHECK. Whether the copy is true. That is what
 * check-version-claims.mjs, check-internal-language.mjs and human review are
 * for. A page can pass every assertion here and still overclaim.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PAGE = join(WEB, 'index.html');

const problems = [];
const fail = (where, msg) => problems.push(`${where}: ${msg}`);

if (!existsSync(PAGE)) {
  console.error('check-web: web/index.html is missing.');
  process.exit(1);
}
const html = readFileSync(PAGE, 'utf8');
const lineOf = (i) => html.slice(0, i).split('\n').length;
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// -----------------------------------------------------------------------------
// EVERY PAGE, NOT JUST THE ONE SOMEBODY REMEMBERED
// -----------------------------------------------------------------------------
//
// This gate read `web/index.html` and nothing else. That was right when the
// site was one file. It stopped being right on 5 October 2026, when five
// generated guide pages shipped carrying their own titles, descriptions,
// canonicals, Open Graph tags and JSON-LD — none of which any gate looked at.
// The commit that added them said so as a known gap, which is better than
// silence and is not a substitute for checking.
//
// Registration is not coverage, once more and at the level of a filename: a
// check hard-coded to one path reports clean on every path it does not open.
// Sections 1 to 3 apply to any HTML page and now run over all of them.
// Sections 4 and 5 are about the site as a whole and stay where they were.
function checkPage(page, html) {
  const lineOf = (i) => html.slice(0, i).split('\n').length;

  // -----------------------------------------------------------------------------
  // 1. Document shape
  // -----------------------------------------------------------------------------
  if (!/^<!doctype html>/i.test(html.trim())) fail(page, 'no doctype on the first line');
  if (!/<html[^>]+lang="[a-z-]+"/i.test(html)) fail(page, '<html> has no lang attribute (screen readers need it)');
  if (!/<meta charset="utf-8">/i.test(html)) fail(page, 'no <meta charset>');
  if (!/name="viewport"/i.test(html)) fail(page, 'no viewport meta — the page will not be responsive on a phone');

  const h1s = [...html.matchAll(/<h1[\s>]/gi)];
  if (h1s.length !== 1) fail(page, `expected exactly 1 <h1>, found ${h1s.length}`);

  // Heading order: never skip a level on the way down.
  const heads = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => ({ level: +m[1], line: lineOf(m.index) }));
  for (let i = 1; i < heads.length; i++) {
  const jump = heads[i].level - heads[i - 1].level;
  if (jump > 1) fail(`${page}:${heads[i].line}`, `heading jumps h${heads[i - 1].level} → h${heads[i].level}`);
  }

  // Every image needs alt text. (None today; this is the guard for the first one added.)
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
  if (!/\balt=/.test(m[0])) fail(`${page}:${lineOf(m.index)}`, `<img> without alt: ${m[0].slice(0, 70)}`);
  }

  // Content must not depend on JavaScript: AI crawlers do not reliably run it.
  for (const m of html.matchAll(/<script\b(?![^>]*type="application\/ld\+json")[^>]*>/gi)) {
  fail(`${page}:${lineOf(m.index)}`, 'a <script> other than JSON-LD — content must render without JavaScript');
  }
  for (const m of html.matchAll(/\son(click|load|error|mouseover)=/gi)) {
  fail(`${page}:${lineOf(m.index)}`, `inline event handler ${m[1]} — same reason`);
  }

  // -----------------------------------------------------------------------------
  // 2. The meta a search result and a social preview actually need
  // -----------------------------------------------------------------------------
  const meta = (re, label, { min = 1, max = Infinity } = {}) => {
  const m = html.match(re);
  if (!m) return fail(page, `missing ${label}`);
  const v = m[1].trim();
  if (v.length < min) fail(page, `${label} is too short (${v.length} chars)`);
  if (v.length > max) fail(page, `${label} is ${v.length} chars; search results truncate around ${max}`);
  return v;
  };

  meta(/<title>([^<]+)<\/title>/i, '<title>', { min: 10, max: 70 });
  meta(/<meta name="description" content="([^"]+)"/i, 'meta description', { min: 70, max: 320 });
  meta(/<link rel="canonical" href="([^"]+)"/i, 'canonical link');

  for (const tag of ['og:type', 'og:url', 'og:title', 'og:description', 'og:image', 'og:image:alt']) {
  if (!new RegExp(`property="${tag}"`).test(html)) fail(page, `missing ${tag}`);
  }
  for (const tag of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
  if (!new RegExp(`name="${tag}"`).test(html)) fail(page, `missing ${tag}`);
  }

  // The structured data must parse, and must not claim a rating we do not have.
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  if (!ld) fail(page, 'no JSON-LD block');
  else {
  try {
    const obj = JSON.parse(ld[1]);
    for (const banned of ['aggregateRating', 'review', 'offers']) {
      if (JSON.stringify(obj).toLowerCase().includes(banned.toLowerCase()))
        fail(page, `JSON-LD contains "${banned}" — we have no ratings, reviews or price, and inventing them is the one thing that would destroy this page's argument`);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
    if (obj.softwareVersion && obj.softwareVersion !== pkg.version)
      fail(page, `JSON-LD softwareVersion is ${obj.softwareVersion}; packages/core/package.json says ${pkg.version}`);
  } catch (e) {
    fail(page, `JSON-LD does not parse: ${e.message}`);
  }
  }

  // -----------------------------------------------------------------------------
  // 3. Links — the load-bearing part
  // -----------------------------------------------------------------------------
  // `[^"#\s<]` rather than `[^"#\s]`: these URLs also appear as plain text inside
  // <code> blocks, and without excluding `<` the match swallows the closing tag.
  const REPO_BLOB = /https:\/\/github\.com\/filelayer\/filelayer\/(blob|tree)\/main\/([^"#\s<]+)(#[^"\s<]*)?/g;
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const links = [];

  for (const m of html.matchAll(/href="([^"]+)"/g)) {
  const href = m[1];
  const line = lineOf(m.index);
  links.push({ href, line });

  if (href.startsWith('#')) {
    const id = href.slice(1);
    if (id && !ids.has(id)) fail(`${page}:${line}`, `anchor ${href} has no matching id on the page`);
  } else if (href.startsWith('./') || href.startsWith('/')) {
    if (href === '/') continue; // the brand link
    const rel = href.replace(/^\.?\//, '').split(/[?#]/)[0];
    // RESOLVE THE WAY THE HOST RESOLVES, not the way the filesystem does. The
    // guide pages are linked as clean URLs (`/guides/private-file-uploads`),
    // and the static host answers those from `<path>.html` and a trailing
    // slash from `<path>/index.html`. Checking only for the literal path would
    // fail every one of them, and "fix" it by putting `.html` in URLs that are
    // also the canonical URLs in the sitemap and the JSON-LD.
    //
    // The three candidates below were not assumed. On 5 October 2026
    // `https://filelayer.dev/index` was requested and the host served
    // `index.html` and canonicalised the URL to `/`, which is the behaviour
    // this encodes. If the site ever moves to a host that serves paths
    // literally, this check goes green while the links 404, so the candidate
    // list is the thing to re-verify on a move.
    const candidates = rel.endsWith('/') || rel === ''
      ? [join(rel, 'index.html')]
      : [rel, `${rel}.html`, join(rel, 'index.html')];
    if (!candidates.some((c) => existsSync(join(WEB, c))))
      fail(
        `${page}:${line}`,
        `relative link ${href} does not resolve in web/ (tried ${candidates.join(', ')})`,
      );
  }
  }

  // Repo links must point at files that exist in this working tree.
  let repoLinks = 0;
  for (const m of html.matchAll(REPO_BLOB)) {
  repoLinks++;
  const target = decodeURIComponent(m[2]);
  const line = lineOf(m.index);
  if (!existsSync(join(ROOT, target)))
    fail(`${page}:${line}`, `links to ${target}, which does not exist in this repository`);
  }
  if (repoLinks === 0) fail(page, 'no links into the repository at all — the page cannot hand off');

  // A GitHub anchor is derived from the heading text; a stale one lands at the top
  // of a long file and silently loses the reader. Check the ones we can.
  for (const m of html.matchAll(REPO_BLOB)) {
  const [, , target, hash] = m;
  if (!hash) continue;
  const path = join(ROOT, decodeURIComponent(target));
  if (!existsSync(path) || !/\.md$/.test(target)) continue;
  const slugs = new Set(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => /^#{1,6}\s/.test(l))
      .map((l) =>
        l.replace(/^#{1,6}\s+/, '').toLowerCase()
          .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-'),
      ),
  );
  const want = hash.slice(1).toLowerCase();
  if (!slugs.has(want))
    fail(`${page}:${lineOf(m.index)}`, `anchor ${hash} not found in ${target} (headings moved?)`);
  }
  return { ids, links, repoLinks };
}

// The landing page plus everything generated under web/guides/. Discovered
// rather than listed, so a sixth guide is covered the moment it is built.
const PAGES = [['web/index.html', PAGE]];
const GUIDES = join(WEB, 'guides');
if (existsSync(GUIDES)) {
  for (const f of readdirSync(GUIDES).filter((n) => n.endsWith('.html')).sort()) {
    PAGES.push([`web/guides/${f}`, join(GUIDES, f)]);
  }
}
// The landing page's own figures feed the sections below and the summary; the
// guide pages are checked and their totals added. One number for the whole
// site, because "48 links checked" that silently meant one page was the thing
// this refactor exists to stop.
let ids = new Set();
let links = [];
let repoLinks = 0;
for (const [label, file] of PAGES) {
  const r = checkPage(label, readFileSync(file, 'utf8'));
  if (label === 'web/index.html') ids = r.ids;
  links = links.concat(r.links);
  repoLinks += r.repoLinks;
}

// -----------------------------------------------------------------------------
// 4. Companion files
// -----------------------------------------------------------------------------
for (const f of ['styles.css', 'robots.txt', 'sitemap.xml', 'og.png']) {
  if (!existsSync(join(WEB, f))) fail(`web/${f}`, 'missing');
}

// The OG card must actually be 1200x630. A social preview at the wrong aspect
// ratio is cropped by every platform differently, and nobody notices until the
// first shared link looks wrong. Read the PNG IHDR rather than trusting a
// filename. (8-byte signature, then a 4-byte length, "IHDR", width, height.)
if (existsSync(join(WEB, 'og.png'))) {
  const png = readFileSync(join(WEB, 'og.png'));
  if (png.subarray(12, 16).toString() !== 'IHDR') fail('web/og.png', 'not a PNG');
  else {
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    if (w !== 1200 || h !== 630) fail('web/og.png', `is ${w}x${h}; Open Graph wants 1200x630`);
  }
}

// The domain must be identical in the canonical link, the OG/Twitter URLs, the
// sitemap and robots.txt. A canonical pointing one way and a sitemap another is
// invisible in a browser and expensive in an index. `tools/set-site-domain.mjs`
// changes all of them at once; this is what stops a partial edit shipping.
const OWN_HOST = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})\//g;
const thirdParty = /github|npmjs|apache|schema\.org|sitemaps\.org|w3\.org/;
const hosts = new Set();
for (const f of ['index.html', 'robots.txt', 'sitemap.xml']) {
  if (!existsSync(join(WEB, f))) continue;
  for (const m of readFileSync(join(WEB, f), 'utf8').matchAll(OWN_HOST)) {
    if (!thirdParty.test(m[1])) hosts.add(m[1]);
  }
}
if (hosts.size > 1)
  fail('web/', `the site's own domain disagrees across files: ${[...hosts].join(', ')} — run tools/set-site-domain.mjs`);
if (hosts.size === 0) fail('web/', 'no canonical domain found at all');
const robots = existsSync(join(WEB, 'robots.txt')) ? readFileSync(join(WEB, 'robots.txt'), 'utf8') : '';
if (/^\s*Disallow:\s*\/\s*$/m.test(robots))
  fail('web/robots.txt', 'Disallow: / — this blocks the entire distribution channel');
for (const bot of ['GPTBot', 'ClaudeBot', 'Bingbot']) {
  if (!robots.includes(bot)) fail('web/robots.txt', `${bot} is not named; being retrievable by models is the point`);
}

// -----------------------------------------------------------------------------
// 5. Countable claims about the repository
// -----------------------------------------------------------------------------
// THE DEFECT THIS EXISTS TO PREVENT. The page said "All five run from the
// repository with one command each". There are four examples and four
// `example:*` scripts. The fifth rung of the ladder -- lifecycle and audit --
// is illustrated in prose and demonstrated inside the vault example; it has no
// command of its own. Nobody noticed, because no gate counted and the sentence
// had been true of an earlier plan.
//
// check-version-claims.mjs already stops a version or test count from drifting.
// This is the same class of defect one field over: a number about the repository
// stated on a page whose entire argument is that its numbers are checkable. The
// cheapest permanent fix is to make the page unable to name a count that the
// repository does not have.
//
// The rule: every example the page says runs with a command must have that
// command, and any count the page attaches to the examples must be the real one.
const exampleScripts = Object.keys(rootPkg.scripts ?? {}).filter((k) => k.startsWith('example:'));
const exampleDirs = existsSync(join(ROOT, 'examples'))
  ? readdirSync(join(ROOT, 'examples'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];

if (exampleDirs.length !== exampleScripts.length)
  fail(
    'package.json',
    `examples/ holds ${exampleDirs.length} director(ies) (${exampleDirs.join(', ')}) but there are ` +
      `${exampleScripts.length} example:* script(s) (${exampleScripts.join(', ')}). An example nobody can ` +
      `run with one command is an example the site must not claim runs with one command.`,
  );

// "Tiers 1 to 3 each run ... with one command" -> example:tier1..3 must exist.
const tierRange = html.match(/Tiers?\s+(\d)\s+to\s+(\d)\s+each run/i);
if (tierRange) {
  for (let t = Number(tierRange[1]); t <= Number(tierRange[2]); t++) {
    if (!exampleScripts.includes(`example:tier${t}`))
      fail(
        'web/index.html',
        `claims tiers ${tierRange[1]}–${tierRange[2]} each run with one command, but there is no ` +
          `\`example:tier${t}\` script. Present: ${exampleScripts.join(', ')}`,
      );
  }
}

// Any spelled-out or numeric count attached to the examples must be the real one.
const WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT_CLAIM = /\b(?:all|every)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:of\s+them\s+)?run\b/gi;
for (const m of html.matchAll(COUNT_CLAIM)) {
  const claimed = WORD_NUMBERS[m[1].toLowerCase()] ?? Number(m[1]);
  if (claimed !== exampleScripts.length)
    fail(
      `web/index.html:${lineOf(m.index)}`,
      `says "${m[0]}" — that is ${claimed} runnable examples, and the repository has ` +
        `${exampleScripts.length} (${exampleScripts.join(', ')}).`,
    );
}

// -----------------------------------------------------------------------------
// 6. Negative controls — a gate that cannot fail is not a gate
// -----------------------------------------------------------------------------
const controls = [
  ['a repo link to a file that does not exist', () => !existsSync(join(ROOT, 'docs/THIS-FILE-DOES-NOT-EXIST.md'))],
  ['an anchor with no matching id', () => !ids.has('there-is-no-such-section-on-this-page')],
  ['a relative link to a missing asset', () => !existsSync(join(WEB, 'no-such-asset.css'))],
  // A COUNT THAT IS WRONG BY CONSTRUCTION.
  //
  // This control used the exact sentence that shipped, "All five run from the
  // repository with one command each", because five was a miscount at the time.
  // Adding a fifth example on 3 October 2026 made that sentence TRUE, the
  // control stopped failing, and the gate reported itself broken -- correctly,
  // and one commit before anyone would have noticed the count check had gone
  // quiet.
  //
  // A control pinned to a historical fact expires when the fact changes. One
  // built from the current count cannot: whatever the real number is, the
  // sentence names one more.
  [
    'a count that does not match the repository',
    () => {
      const wrong = exampleScripts.length + 1;
      const m = /\b(?:all|every)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:of\s+them\s+)?run\b/i.exec(
        `All ${wrong} run from the repository with one command each`,
      );
      return m !== null && (WORD_NUMBERS[m[1].toLowerCase()] ?? Number(m[1])) !== exampleScripts.length;
    },
  ],
];
const controlsPass = controls.every(([, f]) => f());

if (process.argv.includes('--self-test')) {
  console.log(controlsPass ? 'check-web: negative controls passed.' : 'check-web: CONTROLS DID NOT FAIL');
  process.exit(controlsPass ? 0 : 1);
}

if (process.argv.includes('--list')) {
  for (const l of links) console.log(`  web/index.html:${l.line}  ${l.href}`);
}

// -----------------------------------------------------------------------------
if (problems.length) {
  console.error('\ncheck-web: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\n  ${problems.length} problem(s).\n`);
  process.exit(1);
}
if (!controlsPass) {
  console.error('check-web: the negative controls did not fail. The gate is not working.');
  process.exit(1);
}

const files = readdirSync(WEB).length;
console.log(
  `check-web: clean. ${files} file(s) in web/; ${links.length} link(s) checked, ` +
    `${repoLinks} into the repository and all resolving; ${ids.size} anchor target(s); ` +
    `meta, JSON-LD, headings and robots.txt correct; negative controls correct.`,
);
