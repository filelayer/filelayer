#!/usr/bin/env node
/**
 * Change the site's domain everywhere, in one step.
 *
 *   node tools/set-site-domain.mjs example.com     # rewrite
 *   node tools/set-site-domain.mjs --show          # what is set today
 *
 * -----------------------------------------------------------------------------
 * WHY
 * -----------------------------------------------------------------------------
 * The domain appears in four places that must never disagree: the canonical
 * link and the Open Graph / Twitter URLs in `web/index.html`, the `Sitemap:`
 * directive in `web/robots.txt`, and the `<loc>` in `web/sitemap.xml`. A
 * canonical pointing at one host while the sitemap points at another is the
 * kind of defect that is invisible in a browser and expensive in an index.
 *
 * `filelayer.dev` is CONFIRMED: it is an active zone on the project's own
 * Cloudflare account, verified 2026-09-07. It does not resolve yet, which is
 * expected — the zone exists, no records are published. Do not read NXDOMAIN
 * as "wrong domain".
 *
 * This script exists so that changing it later is one command rather than four
 * careful edits, and so nobody has to grep for the old host and hope they found
 * every occurrence.
 *
 * `check-web.mjs` asserts the four agree, so a partial edit fails the build.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['web/index.html', 'web/robots.txt', 'web/sitemap.xml'];
const HOST = /https:\/\/([a-z0-9.-]+\.[a-z]{2,})\//g;

const current = () => {
  const hosts = new Set();
  for (const f of FILES) {
    for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(HOST)) {
      // Only our own host: skip every third-party URL on the page.
      if (!/github|npmjs|apache|schema\.org|sitemaps\.org|w3\.org/.test(m[1])) hosts.add(m[1]);
    }
  }
  return [...hosts];
};

const arg = process.argv[2];

if (!arg || arg === '--show') {
  const hosts = current();
  if (hosts.length === 1) console.log(`site domain: ${hosts[0]}`);
  else console.log(`site domain: INCONSISTENT — ${hosts.join(', ')}`);
  console.log(`\nto change it:  node tools/set-site-domain.mjs <new-domain>`);
  process.exit(hosts.length === 1 ? 0 : 1);
}

const next = arg.replace(/^https?:\/\//, '').replace(/\/$/, '');
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(next)) {
  console.error(`set-site-domain: "${arg}" does not look like a domain.`);
  process.exit(1);
}

const hosts = current();
if (hosts.length !== 1) {
  console.error(`set-site-domain: the current domain is inconsistent (${hosts.join(', ')}). Fix by hand first.`);
  process.exit(1);
}
const [from] = hosts;

let changed = 0;
for (const f of FILES) {
  const p = join(ROOT, f);
  const before = readFileSync(p, 'utf8');
  const after = before.split(`https://${from}/`).join(`https://${next}/`);
  if (after !== before) {
    writeFileSync(p, after);
    const n = before.split(`https://${from}/`).length - 1;
    changed += n;
    console.log(`  ${f}  ${n} occurrence(s)`);
  }
}

console.log(`\nset-site-domain: ${from} → ${next}, ${changed} occurrence(s) rewritten.`);
console.log('Run `npm run check:web` and re-generate the OG card if the tagline changed.');
