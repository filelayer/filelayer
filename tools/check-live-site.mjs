#!/usr/bin/env node
/**
 * THE PAGE THE WORLD SEES, COMPARED WITH THE PAGE IN THIS REPOSITORY.
 *
 * WHY THIS EXISTS, and the correction that produced it. On 4 October 2026 a
 * cached `fetch` of `https://filelayer.dev/` came back as the 0.7.0 page, and
 * that reading was reported as "the deployed site is two releases behind". It
 * was not. A no-cache fetch, diffed against `git show HEAD:web/index.html`,
 * came back BYTE-IDENTICAL: the deploy tracks `main` faithfully and always had.
 * What was actually stale was the FILE -- `v0.7.0` in the eyebrow and the alpha
 * banner, `375 tests across 94 suites` in the prose -- while the trust table on
 * the same page said 0.9.0 and 405/100. The page disagreed with itself, in the
 * repository, and the deploy carried that disagreement out faithfully.
 *
 * So this gate is not a guard against a forgotten manual deploy. It is the
 * answer to a question nothing here could answer at all: IS THE PAGE THE WORLD
 * READS THE PAGE WE THINK WE WROTE? Thirteen gates were green throughout, and
 * every one was right -- they all read the working tree. `check-web.mjs` opens
 * `web/index.html` from disk; `check-version-claims.mjs` reads the same file.
 * Nothing had ever made an HTTP request to the site it describes, so a deploy
 * that silently stopped, served a cached copy, or published the wrong branch
 * would have looked exactly like success.
 *
 * It is also how you tell a cached answer from a stale one, which is the
 * mistake that started this: a human or an agent reading the page through a
 * cache cannot distinguish "the site is behind" from "my fetch is". This can.
 *
 * WHEN IT RUNS. The nightly schedule and manual dispatch. A push to `main`
 * legitimately precedes the deploy by a minute or two, and failing a build for
 * that would train everyone to ignore it.
 *
 * WHAT IT COMPARES. Only facts with a single source of truth in this
 * repository: the version from `packages/core/package.json`, and the test and
 * suite counts from `.measured/suite-counts.json`, which `tools/run-suite.mjs`
 * writes from a real run. It deliberately does NOT diff the whole page --
 * prose changes constantly and a diff would be noise. It checks the numbers,
 * because the numbers are the argument.
 *
 * Usage:
 *   node tools/check-live-site.mjs              # against https://filelayer.dev/
 *   node tools/check-live-site.mjs --url ...    # against a staging origin
 *   node tools/check-live-site.mjs --self-test  # the extractors, on fixtures
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://filelayer.dev/';

/**
 * Every extractor is a named claim: a pattern over the served HTML, and the
 * value this repository says it should carry.
 *
 * The patterns are the ones that broke. `v0.7.0` appeared in the eyebrow and in
 * the alpha banner while the trust table already said `0.9.0` -- the page
 * disagreed with itself, and the gate that watched the table saw nothing wrong.
 * So each surface is extracted separately and reported separately: "the version
 * is right somewhere on the page" is not the property we want.
 */
const extractors = [
  {
    name: 'eyebrow version',
    re: /Apache-2\.0\s*(?:&middot;|·)\s*v([\d.]+)\s*alpha/,
    want: (c) => c.version,
  },
  {
    name: 'alpha banner version',
    re: /Alpha\.?\s*Developer preview\.?<\/b>\s*v(\d+(?:\.\d+)*)/,
    want: (c) => c.version,
  },
  {
    name: 'trust table version',
    re: /Version<\/span><span class="v">([\d.]+)\s*(?:&mdash;|—)\s*alpha/,
    want: (c) => c.version,
  },
  {
    name: 'tarball test count',
    re: /([\d,]+)\s+tests across [\d,]+ suites travel with the package/,
    want: (c) => String(c.tests),
  },
  {
    name: 'tarball suite count',
    re: /[\d,]+\s+tests across ([\d,]+) suites travel with the package/,
    want: (c) => String(c.suites),
  },
  {
    name: 'trust table test count',
    re: /every commit<\/span><span class="v">([\d,]+) across [\d,]+ suites/,
    want: (c) => String(c.tests),
  },
  {
    name: 'trust table suite count',
    re: /every commit<\/span><span class="v">[\d,]+ across ([\d,]+) suites/,
    want: (c) => String(c.suites),
  },
];

function expected() {
  const version = JSON.parse(
    readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'),
  ).version;
  let counts;
  try {
    counts = JSON.parse(readFileSync(join(ROOT, '.measured/suite-counts.json'), 'utf8'));
  } catch {
    console.error(
      '\ncheck-live-site: the test counts have not been measured.\n' +
        '  Run `npm run test:counted` first; this gate compares the DEPLOYED page\n' +
        '  against a recorded run, not against a number typed by hand.\n',
    );
    process.exit(1);
  }
  return { version, tests: counts.tests, suites: counts.suites };
}

function check(html, want) {
  const problems = [];
  for (const e of extractors) {
    const m = e.re.exec(html);
    if (!m) {
      problems.push(
        `${e.name}: not found on the served page. Either the markup changed and ` +
          `this pattern needs updating in the same commit, or the page no longer ` +
          `states it.`,
      );
      continue;
    }
    const got = m[1].replace(/,/g, '');
    const should = e.want(want);
    if (got !== should) {
      problems.push(`${e.name}: the page says ${got}, this repository says ${should}.`);
    }
  }
  return problems;
}

// --- self-test: the extractors, against the markup that actually broke ------
if (process.argv.includes('--self-test')) {
  const stale = `
    <p class="eyebrow">Open-source Node library &middot; Apache-2.0 &middot; v0.7.0 alpha</p>
    <p><b>Alpha. Developer preview.</b> v0.7.0. The schema can still change.</p>
    <li><span>Version</span><span class="v">0.7.0 &mdash; alpha</span></li>
    <p>364 tests across 90 suites travel with the package, so every claim</p>
    <li><span>Tests</span><span class="v">364 across 90 suites</span></li>
  `.replace('<span class="v">364 across 90 suites', 'every commit</span><span class="v">364 across 90 suites');
  const current = readFileSync(join(ROOT, 'web/index.html'), 'utf8');
  const want = expected();

  const onStale = check(stale, want);
  const onCurrent = check(current, want);

  let bad = 0;
  // The stale fixture is the 4 October page. Every extractor must fire on it.
  if (onStale.length !== extractors.length) {
    console.log(`FAIL  stale fixture: ${onStale.length} of ${extractors.length} extractors fired`);
    for (const p of onStale) console.log(`        ${p}`);
    bad++;
  } else {
    console.log(`PASS  stale fixture: all ${extractors.length} extractors fired`);
  }
  // And none may fire on the file as it stands, or the patterns are wrong.
  if (onCurrent.length > 0) {
    console.log('FAIL  web/index.html as it stands:');
    for (const p of onCurrent) console.log(`        ${p}`);
    bad++;
  } else {
    console.log('PASS  web/index.html as it stands: clean');
  }
  process.exit(bad ? 1 : 0);
}

// --- the real thing ---------------------------------------------------------
const urlArg = process.argv.indexOf('--url');
const url = urlArg >= 0 ? process.argv[urlArg + 1] : DEFAULT_URL;
const want = expected();

let html;
try {
  const res = await fetch(url, { headers: { 'user-agent': 'filelayer-check-live-site' } });
  if (!res.ok) {
    console.error(`\ncheck-live-site: ${url} answered ${res.status}.\n`);
    process.exit(1);
  }
  html = await res.text();
} catch (e) {
  console.error(
    `\ncheck-live-site: could not reach ${url}: ${e.message}\n\n` +
      '  A site that is down is a different problem from a site that is stale,\n' +
      '  and this gate cannot tell you which numbers are on a page it cannot read.\n',
  );
  process.exit(1);
}

const problems = check(html, want);

if (problems.length) {
  console.error(`\ncheck-live-site: FAILED against ${url}\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\n  ${problems.length} problem(s). This repository says version ${want.version}, ` +
      `${want.tests} tests, ${want.suites} suites.\n` +
      '  Deploys are manual: serve `web/` as the document root and re-run this.\n' +
      '  A correct file and a stale page are two different things, and only this\n' +
      '  check can tell them apart.\n',
  );
  process.exit(1);
}

console.log(
  `check-live-site: clean. ${url} serves version ${want.version}, ` +
    `${want.tests} tests across ${want.suites} suites, on all ${extractors.length} ` +
    'surfaces that state them.',
);
