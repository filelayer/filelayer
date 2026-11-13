#!/usr/bin/env node
/**
 * EVERY FIGURE ON THE COMPARISON PAGE IS THE ONE THE RUN WROTE.
 *
 *     node tools/check-page-figures.mjs
 *     node tools/check-page-figures.mjs --self-test
 *
 * `node benchmark/run.mjs` writes benchmark/RESULTS.md. benchmark/PAGE.md (the
 * page at filelayer.dev/one-feature-five-ways) and the README quote those
 * figures in prose, and prose is typed by hand. On 13 November 2026 a review
 * found the page saying 4.6 seconds while RESULTS said 5.3. So this reads the
 * figures out of RESULTS.md, builds the exact phrases the page and the README
 * use for them, and fails when one of those phrases is missing: a figure
 * changed by hand on the page fails, and so does a regenerated RESULTS.md that
 * the page has not been brought up to.
 *
 * Whitespace is normalised before comparing, so a reflowed paragraph passes.
 * Nothing else is: the phrase has to be there.
 *
 * --self-test changes one figure at a time in a copy of each page and asserts
 * that the check fails for every one of them, so a pattern that matches
 * nothing cannot pass silently.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ');

function figures(results) {
  const one = (re, what) => {
    const m = re.exec(results);
    if (!m) throw new Error(`benchmark/RESULTS.md: could not read ${what} (${re})`);
    return m;
  };
  const version = one(/Filelayer is `@filelayer\/core@([\d.]+)`/, 'the measured version')[1];
  const loc = (name) => {
    const m = one(new RegExp(`^\\s+${name}\\s+app\\s+(\\d+)\\s+infra\\s+(\\d+)`, 'm'), `the lines of ${name}`);
    return { app: m[1], infra: m[2] };
  };
  const median = one(/median over the 2 executed alternatives: ([\d.]+) vs (\d+) = ([\d.]+)x/, 'the line median');
  const prod = one(/against the production-wired Filelayer: ([\d.]+) vs (\d+) = ([\d.]+)x/, 'the production median');
  const vendor = (name) => one(new RegExp(`^\\| ${name} \\| ([\\d,]+) \\| ([\\d,]+) \\|`, 'm'), `the vendor lines of ${name}`);
  const dec = (name) => {
    const m = one(new RegExp(`^\\| ${name}\\s+\\|\\s+(\\d+) \\|\\s+(\\d+) \\|`, 'm'), `the decisions of ${name}`);
    return { types: m[1], sites: m[2] };
  };
  const decMedian = one(/^\| median, the 2 executed \| ([\d.]+)x \| ([\d.]+)x \|/m, 'the decisions median');
  const arguable = one(/Counting all of them gives Filelayer (\d+) types/, 'the arguable count');
  const atk = (name) => {
    const m = one(new RegExp(`^\\| ${name} \\| (\\d+)\\/18 \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|`, 'm'), `the attacks of ${name}`);
    return { defended: m[1], partial: m[2], gap: m[3], breach: m[4] };
  };
  const ttff = one(/TOTAL, install to stored byte\s+([\d.]+)s/, 'the time to first file')[1];
  return {
    version, ttff,
    fl: loc('filelayer'), prod: loc('filelayer-production'), sup: loc('baseline-supabase'), s3: loc('baseline-raw-s3'),
    cx: loc('baseline-convex'), vb: loc('baseline-vercel-blob'),
    median: { exec: median[1], fl: median[2], x: median[3] },
    prodMedian: { exec: prod[1], fl: prod[2], x: prod[3] },
    vfl: vendor('filelayer'), vs3: vendor('raw-s3'),
    dfl: dec('filelayer'), dsup: dec('supabase'), ds3: dec('raw-s3'), dvb: dec('vercel-blob'), dcx: dec('convex'),
    decMedian: { types: decMedian[1], sites: decMedian[2] }, arguable: arguable[1],
    afl: atk('filelayer'), asup: atk('supabase'), as3: atk('raw-s3'), actl: atk('filelayer-prerebuild \\(control\\)'),
    // The partial-detail line 02 adds under the 18-attack table (M-02-60). When
    // RESULTS.md names the 30-second window, the page must name it too.
    thirtySeconds: /30 seconds|30-second|30 s\b/.test(results),
  };
}

function expectations(f) {
  const page = [
    [`\`@filelayer/core\` ${f.version} from npm`, 'the measured version, in the table of implementations'],
    [`| Filelayer ${f.version} | ${f.afl.defended} of 18 | ${f.afl.partial} | ${f.afl.breach} |`, 'Filelayer on the 18 attacks'],
    [`| Raw S3 | ${f.as3.defended} of 18 | ${f.as3.partial} | ${f.as3.breach} |`, 'raw S3 on the 18 attacks'],
    [`| Supabase, as built | ${f.asup.defended} of 18 | ${f.asup.partial} | ${f.asup.breach} |`, 'Supabase on the 18 attacks'],
    [`| Filelayer, earlier version (control) | ${f.actl.defended} of 18 | ${f.actl.partial} | ${f.actl.breach} |`, 'the control on the 18 attacks'],
    [`| Filelayer | ${f.dfl.types} | ${f.dfl.sites} |`, 'Filelayer decisions'],
    [`| Supabase | ${f.dsup.types} | ${f.dsup.sites} |`, 'Supabase decisions'],
    [`| Raw S3 | ${f.ds3.types} | ${f.ds3.sites} |`, 'raw S3 decisions'],
    [`| Vercel Blob, not executed or compiled | ${f.dvb.types} | ${f.dvb.sites} |`, 'Vercel Blob decisions'],
    [`| Convex, not executed or compiled | ${f.dcx.types} | ${f.dcx.sites} |`, 'Convex decisions'],
    [`about ${f.decMedian.types} times as many kinds and ${f.decMedian.sites} times as many places`, 'the decisions average'],
    [`counting it gives Filelayer ${f.arguable} kinds`, 'the arguable count'],
    [`| Filelayer, the example | ${f.fl.app} | ${f.fl.infra} |`, 'the example lines'],
    [`| Filelayer, wired as in production | ${f.prod.app} | ${f.prod.infra} |`, 'the production-wired lines'],
    [`| Supabase | ${f.sup.app} | ${f.sup.infra} |`, 'Supabase lines'],
    [`| Raw S3 | ${f.s3.app} | ${f.s3.infra} |`, 'raw S3 lines'],
    [`| Convex, not executed or compiled | ${f.cx.app} | ${f.cx.infra} |`, 'Convex lines'],
    [`| Vercel Blob, not executed or compiled | ${f.vb.app} | ${f.vb.infra} |`, 'Vercel Blob lines'],
    [`about ${f.prodMedian.x} times as many lines as Filelayer**: an average of ${f.prodMedian.exec} against ${f.prodMedian.fl}`, 'the production-wired average'],
    [`average of the two is ${f.median.exec} application lines against ${f.median.fl}, about ${f.median.x} times as many`, 'the example average'],
    [`| Filelayer | ${f.vfl[1]} | ${f.vfl[2]} |`, 'Filelayer vendor lines'],
    [`| Raw S3 | ${f.vs3[1]} (the AWS SDK) | ${f.vs3[2]} |`, 'raw S3 vendor lines'],
    [`it took ${f.ttff} seconds`, 'the time to first file'],
  ];
  if (f.thirtySeconds) page.push(['30 seconds', "Supabase's 30-second window, which RESULTS.md names"]);
  const readme = [
    [`${f.dsup.types} and ${f.ds3.types} against Filelayer's ${f.dfl.types}`, 'decision kinds'],
    [`About ${f.decMedian.types} times as many kinds`, 'the decisions average'],
    [`about ${f.decMedian.sites} times as many places`, 'the places average'],
    [`**${f.afl.defended} of 18** for Filelayer`, 'Filelayer on the 18 attacks'],
    [`Raw S3 also defends ${f.as3.defended} of 18; Supabase defends ${f.asup.defended}`, 'raw S3 and Supabase on the 18 attacks'],
    [`About ${f.prodMedian.x} times as many lines`, 'the production-wired ratio'],
    [`an average of ${f.prodMedian.exec} lines of application and infrastructure code against Filelayer's ${f.prodMedian.fl}`, 'the production-wired average'],
    [`${f.median.fl} lines, it is about ${f.median.x} times as many`, 'the example ratio'],
  ];
  // The homepage states the argument with the same figures (14 November 2026).
  const home = [
    [`<span class="v">about ${f.prodMedian.x} times as many</span>`, 'the production-wired ratio'],
    [`<span class="v">about ${f.decMedian.types} times as many</span>`, 'the decisions ratio'],
    [`averaged ${f.prodMedian.exec} lines against Filelayer's ${f.prodMedian.fl}`, 'the production-wired average'],
    [`${f.dsup.types} and ${f.ds3.types} kinds of security-sensitive decision against its ${f.dfl.types}`, 'decision kinds'],
    [`raw S3 defended all ${f.as3.defended} shared attacks`, 'raw S3 on the 18 attacks'],
  ];
  return { 'benchmark/PAGE.md': page, 'README.md': readme, 'web/index.html': home };
}

function check(texts, f) {
  const problems = [];
  for (const [file, list] of Object.entries(expectations(f))) {
    const body = norm(texts[file]);
    for (const [phrase, what] of list) {
      if (!body.includes(norm(phrase))) problems.push(`${file}: ${what}. Expected, from benchmark/RESULTS.md:\n      ${phrase}`);
    }
  }
  return problems;
}

const results = read('benchmark/RESULTS.md');
const f = figures(results);
const texts = { 'benchmark/PAGE.md': read('benchmark/PAGE.md'), 'README.md': read('README.md'), 'web/index.html': read('web/index.html') };

if (process.argv.includes('--self-test')) {
  let bad = 0;
  let tried = 0;
  for (const [file, list] of Object.entries(expectations(f))) {
    for (const [phrase, what] of list) {
      // Change the first digit in the phrase, as a hand edit would.
      const m = /\d/.exec(phrase);
      if (!m) continue;
      const changed = phrase.slice(0, m.index) + ((Number(m[0]) + 1) % 10) + phrase.slice(m.index + 1);
      const body = norm(texts[file]);
      const at = body.indexOf(norm(phrase));
      if (at < 0) continue; // the live check reports it
      const mutated = { ...texts, [file]: body.slice(0, at) + norm(changed) + body.slice(at + norm(phrase).length) };
      tried++;
      if (check(mutated, f).length === 0) { bad++; console.error(`  self-test FAILED: ${file}, ${what}: a changed figure passed`); }
    }
  }
  if (bad || tried === 0) process.exit(1);
  console.log(`check-page-figures --self-test: ${tried} figure(s) changed one at a time, every one refused.`);
  process.exit(0);
}

const problems = check(texts, f);
if (problems.length) {
  console.error(`check-page-figures: FAILED, ${problems.length} figure(s) on the page, the README or the homepage disagree with benchmark/RESULTS.md\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nThe figures come from the run. Change the page, never RESULTS.md by hand.');
  process.exit(1);
}
const n = Object.values(expectations(f)).reduce((a, l) => a + l.length, 0);
console.log(`check-page-figures: clean. ${n} figure phrase(s) on PAGE.md, the README and the homepage match benchmark/RESULTS.md (measured on ${f.version}).`);
