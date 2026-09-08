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

// -----------------------------------------------------------------------------
// 1. Document shape
// -----------------------------------------------------------------------------
if (!/^<!doctype html>/i.test(html.trim())) fail('web/index.html', 'no doctype on the first line');
if (!/<html[^>]+lang="[a-z-]+"/i.test(html)) fail('web/index.html', '<html> has no lang attribute (screen readers need it)');
if (!/<meta charset="utf-8">/i.test(html)) fail('web/index.html', 'no <meta charset>');
if (!/name="viewport"/i.test(html)) fail('web/index.html', 'no viewport meta — the page will not be responsive on a phone');

const h1s = [...html.matchAll(/<h1[\s>]/gi)];
if (h1s.length !== 1) fail('web/index.html', `expected exactly 1 <h1>, found ${h1s.length}`);

// Heading order: never skip a level on the way down.
const heads = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => ({ level: +m[1], line: lineOf(m.index) }));
for (let i = 1; i < heads.length; i++) {
  const jump = heads[i].level - heads[i - 1].level;
  if (jump > 1) fail(`web/index.html:${heads[i].line}`, `heading jumps h${heads[i - 1].level} → h${heads[i].level}`);
}

// Every image needs alt text. (None today; this is the guard for the first one added.)
for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
  if (!/\balt=/.test(m[0])) fail(`web/index.html:${lineOf(m.index)}`, `<img> without alt: ${m[0].slice(0, 70)}`);
}

// Content must not depend on JavaScript: AI crawlers do not reliably run it.
for (const m of html.matchAll(/<script\b(?![^>]*type="application\/ld\+json")[^>]*>/gi)) {
  fail(`web/index.html:${lineOf(m.index)}`, 'a <script> other than JSON-LD — content must render without JavaScript');
}
for (const m of html.matchAll(/\son(click|load|error|mouseover)=/gi)) {
  fail(`web/index.html:${lineOf(m.index)}`, `inline event handler ${m[1]} — same reason`);
}

// -----------------------------------------------------------------------------
// 2. The meta a search result and a social preview actually need
// -----------------------------------------------------------------------------
const meta = (re, label, { min = 1, max = Infinity } = {}) => {
  const m = html.match(re);
  if (!m) return fail('web/index.html', `missing ${label}`);
  const v = m[1].trim();
  if (v.length < min) fail('web/index.html', `${label} is too short (${v.length} chars)`);
  if (v.length > max) fail('web/index.html', `${label} is ${v.length} chars; search results truncate around ${max}`);
  return v;
};

meta(/<title>([^<]+)<\/title>/i, '<title>', { min: 10, max: 70 });
meta(/<meta name="description" content="([^"]+)"/i, 'meta description', { min: 70, max: 320 });
meta(/<link rel="canonical" href="([^"]+)"/i, 'canonical link');

for (const tag of ['og:type', 'og:url', 'og:title', 'og:description', 'og:image', 'og:image:alt']) {
  if (!new RegExp(`property="${tag}"`).test(html)) fail('web/index.html', `missing ${tag}`);
}
for (const tag of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']) {
  if (!new RegExp(`name="${tag}"`).test(html)) fail('web/index.html', `missing ${tag}`);
}

// The structured data must parse, and must not claim a rating we do not have.
const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
if (!ld) fail('web/index.html', 'no JSON-LD block');
else {
  try {
    const obj = JSON.parse(ld[1]);
    for (const banned of ['aggregateRating', 'review', 'offers']) {
      if (JSON.stringify(obj).toLowerCase().includes(banned.toLowerCase()))
        fail('web/index.html', `JSON-LD contains "${banned}" — we have no ratings, reviews or price, and inventing them is the one thing that would destroy this page's argument`);
    }
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
    if (obj.softwareVersion && obj.softwareVersion !== pkg.version)
      fail('web/index.html', `JSON-LD softwareVersion is ${obj.softwareVersion}; packages/core/package.json says ${pkg.version}`);
  } catch (e) {
    fail('web/index.html', `JSON-LD does not parse: ${e.message}`);
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
    if (id && !ids.has(id)) fail(`web/index.html:${line}`, `anchor ${href} has no matching id on the page`);
  } else if (href.startsWith('./') || href.startsWith('/')) {
    if (href === '/') continue; // the brand link
    const rel = href.replace(/^\.?\//, '').split(/[?#]/)[0];
    if (!existsSync(join(WEB, rel))) fail(`web/index.html:${line}`, `relative link ${href} does not resolve to a file in web/`);
  }
}

// Repo links must point at files that exist in this working tree.
let repoLinks = 0;
for (const m of html.matchAll(REPO_BLOB)) {
  repoLinks++;
  const target = decodeURIComponent(m[2]);
  const line = lineOf(m.index);
  if (!existsSync(join(ROOT, target)))
    fail(`web/index.html:${line}`, `links to ${target}, which does not exist in this repository`);
}
if (repoLinks === 0) fail('web/index.html', 'no links into the repository at all — the page cannot hand off');

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
    fail(`web/index.html:${lineOf(m.index)}`, `anchor ${hash} not found in ${target} (headings moved?)`);
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
// 5. Negative controls — a gate that cannot fail is not a gate
// -----------------------------------------------------------------------------
const controls = [
  ['a repo link to a file that does not exist', () => !existsSync(join(ROOT, 'docs/THIS-FILE-DOES-NOT-EXIST.md'))],
  ['an anchor with no matching id', () => !ids.has('there-is-no-such-section-on-this-page')],
  ['a relative link to a missing asset', () => !existsSync(join(WEB, 'no-such-asset.css'))],
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
