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
 *
 * Network: plain GETs to the site, nothing else.
 */

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
}

if (problems.length) {
  console.error(`check-live-pages: FAILED against ${BASE}\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-live-pages: clean. ${ghost} answered 404; ${checked} sitemap URL(s) answered 200, each with its own <title>.`);
