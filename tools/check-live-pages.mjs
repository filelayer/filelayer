/**
 * THE DEPLOYED SITE: AN UNKNOWN PATH IS A 404, AND EVERY LISTED PAGE IS ITSELF.
 *
 *     node tools/check-live-pages.mjs
 *     node tools/check-live-pages.mjs --base https://filelayer.dev
 *
 * Not part of `npm run verify`, on purpose: verify runs before a push, and this
 * asks what the site serves after the deploy. Run it after every push that
 * touches web/, and read a failure as "the deploy is not what the commit says".
 *
 * WHY THIS EXISTS. On 3 November 2026 https://filelayer.dev/no-such-page-xyz
 * returned 200 with the homepage. Cloudflare Pages does that for any site with
 * no top-level 404.html. A search engine reads it as a soft 404; a broken link
 * never shows up as one; and a post-deploy check of "the new page answers 200"
 * passes whether the page was deployed or not, because every path answers 200.
 * So this checks two things, and the second only means something because of
 * the first:
 *
 *   1. A path that cannot exist answers 404, and not with the homepage.
 *   2. Every URL in the deployed sitemap answers 200 with its OWN <title>, which
 *      the homepage's title cannot be for any page but the root.
 *   3. Every served page carries exactly the <script> elements of its file in
 *      web/, plus at most ONE thing the host may add: the Cloudflare Web
 *      Analytics beacon, an empty <script> loaded from
 *      static.cloudflareinsights.com/beacon.min.js. Cloudflare injects it at the
 *      edge since 4 November 2026, so the served HTML no longer matches the tree
 *      byte for byte. Anything else the edge adds (email obfuscation, a
 *      challenge script, a second beacon) fails, and so does a script of ours
 *      the deploy is missing. The privacy policy says the beacon is the only
 *      script that is not part of the page; this is what keeps that sentence true.
 *
 *     node tools/check-live-pages.mjs --self-test   the comparator, against fixtures
 *
 * Network: plain GETs to the site, nothing else.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// One element, exactly: an EMPTY script whose src is the beacon, with only the
// attributes Cloudflare writes. Not a prefix match on the host.
const BEACON_SRC = /^https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js(?:\/v[0-9A-Za-z.]+)?$/;
const BEACON_ATTRS = new Set(['defer', 'src', 'integrity', 'data-cf-beacon', 'crossorigin']);

const scriptsOf = (html) => [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/gi)].map((m) => m[0]);

function isBeacon(el) {
  const m = /^<script\b([^>]*)>([\s\S]*)<\/script>$/i.exec(el);
  if (!m || m[2].trim() !== '') return false;
  const attrs = [...m[1].matchAll(/([a-zA-Z-]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g)];
  const src = attrs.find((a) => a[1].toLowerCase() === 'src')?.[2]?.replace(/^["']|["']$/g, '');
  return Boolean(src && BEACON_SRC.test(src)) && attrs.every((a) => BEACON_ATTRS.has(a[1].toLowerCase()));
}

/** What the served page has beyond the tree, and what it lacks. */
export function compareScripts(local, served) {
  const left = scriptsOf(local);
  const extra = [];
  for (const el of scriptsOf(served)) {
    const i = left.indexOf(el);
    if (i > -1) left.splice(i, 1);
    else extra.push(el);
  }
  const beacons = extra.filter(isBeacon);
  const foreign = extra.filter((el) => !isBeacon(el));
  if (beacons.length > 1) foreign.push(...beacons.slice(1));
  return { missing: left, foreign };
}

if (process.argv.includes('--self-test')) {
  const page = '<html><head><script type="application/ld+json">{"a":1}</script></head><body>x</body></html>';
  const beacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js/vcd15cbe7772f49c399c6a5babf22c1241717689176015" integrity="sha512-abc" data-cf-beacon='{"rayId":"1","token":"t"}' crossorigin="anonymous"></script>`;
  const inject = (el) => page.replace('</body>', `${el}</body>`);
  const cases = [
    ['the page as built', page, true],
    ['the page plus the beacon', inject(beacon), true],
    ['two beacons', inject(beacon + beacon), false],
    ['email obfuscation', inject('<script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script>'), false],
    ['a look-alike host', inject(beacon.replace('static.cloudflareinsights.com', 'static.cloudflareinsights.com.evil.test')), false],
    ['the beacon with a body', inject(beacon.replace('></script>', '>alert(1)</script>')), false],
    ['the beacon with an onload', inject(beacon.replace('<script defer', '<script defer onload="x()"')), false],
    ['an inline script', inject('<script>track()</script>'), false],
    ['our own script missing', page.replace(/<script[\s\S]*?<\/script>/, ''), false],
  ];
  let bad = 0;
  for (const [name, served, ok] of cases) {
    const r = compareScripts(page, served);
    const clean = r.missing.length === 0 && r.foreign.length === 0;
    if (clean !== ok) { bad++; console.error(`  self-test FAILED: ${name} was ${clean ? 'accepted' : 'refused'}`); }
  }
  if (bad) process.exit(1);
  console.log(`check-live-pages --self-test: ${cases.length} cases, the beacon alone is accepted and every other script is refused.`);
  process.exit(0);
}

const argBase = process.argv.indexOf('--base');
const BASE = (argBase > -1 ? process.argv[argBase + 1] : 'https://filelayer.dev').replace(/\/$/, '');
const problems = [];

const titleOf = (html) => (/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim();

async function get(url) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': 'filelayer-check-live-pages' } });
  const body = res.status >= 300 && res.status < 400 ? '' : await res.text();
  return { status: res.status, location: res.headers.get('location'), body };
}

const home = await get(`${BASE}/`);
if (home.status !== 200) problems.push(`${BASE}/ answered ${home.status}, expected 200`);
const homeTitle = titleOf(home.body);

// 1. An unknown path. Random, so no cache and no future page can satisfy it.
const ghost = `${BASE}/no-such-page-${Math.random().toString(36).slice(2, 10)}`;
const g = await get(ghost);
if (g.status !== 404) {
  const same = g.status === 200 && titleOf(g.body) === homeTitle ? ', with the homepage (a soft 404)' : '';
  problems.push(`${ghost} answered ${g.status}${same}; an unknown path must answer 404`);
}

// 2. Every page the deployed sitemap lists.
const sm = await get(`${BASE}/sitemap.xml`);
const urls = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
if (sm.status !== 200 || urls.length === 0) problems.push(`${BASE}/sitemap.xml answered ${sm.status} with ${urls.length} URLs`);
let checked = 0;
for (const url of urls) {
  const r = await get(url);
  checked++;
  if (r.status !== 200) {
    problems.push(`${url} answered ${r.status}${r.location ? ` (to ${r.location})` : ''}, expected 200`);
    continue;
  }
  const t = titleOf(r.body);
  if (url !== `${BASE}/` && t === homeTitle) problems.push(`${url} answered 200 with the homepage's title: it is not deployed`);
  if (!t) problems.push(`${url} has no <title>`);

  // 3. Scripts: the tree's, plus at most the analytics beacon.
  const path = new URL(url).pathname.replace(/^\//, '');
  const file = join(ROOT, 'web', path === '' ? 'index.html' : path.endsWith('/') ? `${path}index.html` : `${path}.html`);
  if (!existsSync(file)) {
    problems.push(`${url} is in the deployed sitemap but ${file.slice(ROOT.length + 1)} is not in this tree`);
    continue;
  }
  const { missing, foreign } = compareScripts(readFileSync(file, 'utf8'), r.body);
  for (const el of foreign) problems.push(`${url} serves a script that is not in the tree and is not the analytics beacon: ${el.slice(0, 160)}`);
  for (const el of missing) problems.push(`${url} is missing a script the tree has: ${el.slice(0, 160)}`);
}

if (problems.length) {
  console.error(`check-live-pages: FAILED against ${BASE}\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-live-pages: clean. ${ghost} answered 404; ${checked} sitemap URL(s) answered 200, each with its own <title> and with the tree's scripts plus at most the analytics beacon.`);
