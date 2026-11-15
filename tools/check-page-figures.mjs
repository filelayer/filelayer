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
 * ONE FIGURE IS A RANGE, NOT A PHRASE: the time to first file. Seconds depend
 * on the machine and the network, so an exact match made this check fail for
 * anyone who reproduced the benchmark correctly (a cold reproduction on
 * 2026-11-15 measured 4.2 s against the page's 5.3 s). The page's seconds must
 * be within TTFF_FACTOR of the run's, either way: a reproduction passes, and a
 * hand edit to a different order of magnitude does not.
 *
 * --self-test changes one figure at a time in a copy of each page and asserts
 * that the check fails for every one of them, so a pattern that matches
 * nothing cannot pass silently. For the time it also moves the page outside
 * the range in both directions, and moves the run inside it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const norm = (s) => s.replace(/\s+/g, ' ');

/**
 * THE REVISION ROUNDS, ONE FIGURE EACH. benchmark/revisions/README.md holds a
 * table of rounds and changed lines of application code per executed
 * alternative. The lines are recounted here from the diffs, over the `app`
 * globs of benchmark/loc.manifest.json, so the table cannot drift from the
 * diffs; the pages must then quote the table. Added 2026-11-15, when a cold
 * review found "one revision round" and "Supabase 8" on the pages while the
 * diffs held two Supabase rounds and 24 lines.
 */
const REVISED = [
  { label: 'Raw S3', impl: 'baseline-raw-s3', diff: 'benchmark/revisions/raw-s3.diff' },
  { label: 'Supabase', impl: 'baseline-supabase', diff: 'benchmark/revisions/supabase.diff' },
];

function globRegex(root, glob) {
  const base = join('benchmark', root).replace(/\\/g, '/');
  const body = glob
    .split('/')
    .map((part) => (part === '**' ? '.*' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')))
    .join('/');
  return new RegExp(`^${base}/${body.replace(/\/\.\*$/, '(/.*)?')}$`);
}

function revisionFigures(readme, readFile) {
  const manifest = JSON.parse(readFile('benchmark/loc.manifest.json'));
  const out = {};
  for (const r of REVISED) {
    const m = new RegExp(`^\\| ${r.label} \\| (\\d+) \\| (\\d+) \\|`, 'm').exec(readme);
    if (!m) throw new Error(`benchmark/revisions/README.md: no row for ${r.label} in the figures table`);
    const impl = manifest.implementations[r.impl];
    const root = impl.root.replace(/^\.\//, '');
    const app = impl.app.map((a) => globRegex(root, a.glob));
    let file = null;
    let lines = 0;
    for (const l of readFile(r.diff).split('\n')) {
      if (l.startsWith('diff --git ')) {
        file = l.split(' ')[3].replace(/^b\//, '');
        continue;
      }
      if (l.startsWith('+++') || l.startsWith('---')) continue;
      if ((l.startsWith('+') || l.startsWith('-')) && file && app.some((re) => re.test(file))) lines++;
    }
    out[r.label] = { rounds: Number(m[1]), lines: Number(m[2]), counted: lines };
  }
  return out;
}

const WORDS = ['no', 'one', 'two', 'three', 'four'];
const rounds = (n) => `${WORDS[n] ?? n} ${n === 1 ? 'round' : 'rounds'}`;

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
  // The word the run uses for the middle of the two executed alternatives,
  // median or average, is the word the page uses (M-03-63, M-03-64).
  const median = one(/(median|average) (?:over|of) the 2 executed alternatives: ([\d.]+) vs (\d+) = ([\d.]+)x/, 'the line median').slice(1);
  const prod = one(/against the production-wired Filelayer: ([\d.]+) vs (\d+) = ([\d.]+)x/, 'the production median');
  const vendor = (name) => one(new RegExp(`^\\| ${name} \\| ([\\d,]+) \\| ([\\d,]+) \\|`, 'm'), `the vendor lines of ${name}`);
  const dec = (name) => {
    const m = one(new RegExp(`^\\| ${name}\\s+\\|\\s+(\\d+) \\|\\s+(\\d+) \\|`, 'm'), `the decisions of ${name}`);
    return { types: m[1], sites: m[2] };
  };
  const decMedian = one(/^\| (?:median|average), the 2 executed \| ([\d.]+)x \| ([\d.]+)x \|/m, 'the decisions median');
  const noChainProd = one(/without the audit chain, app \+ infra, against the production-wired Filelayer \(sensitivity\): ([\d.]+) vs (\d+) = ([\d.]+)x/, 'the production-wired sensitivity without the audit chain');
  const sup9 = one(/Supabase #9 counted as one site \(sensitivity\): Supabase (\d+) types \/ (\d+) sites; .*?([\d.]+)x on sites/, 'the Supabase #9 sensitivity');
  const arguable = one(/Counting all of them gives Filelayer (\d+) types/, 'the arguable count');
  // The size of the shared attack set is read, not assumed: it was 18 until
  // 0.35.4 and 21 from it.
  const shared = one(/^### The (\d+) attacks every executed implementation can express/m, 'the shared attack count')[1];
  const atk = (name) => {
    const m = one(new RegExp(`^\\| ${name} \\| (\\d+)\\/${shared} \\| (\\d+) \\| (\\d+) \\| (\\d+) \\|`, 'm'), `the attacks of ${name}`);
    return { defended: m[1], partial: m[2], gap: m[3], breach: m[4] };
  };
  const noChain = one(/without the audit chain \(sensitivity\): ([\d.]+) vs (\d+) = ([\d.]+)x/, 'the line sensitivity without the audit chain');
  const noChainDec = one(/Without the audit chain \(sensitivity\):.*?([\d.]+)x on types and ([\d.]+)x on sites/, 'the decision sensitivity without the audit chain');
  const ttff = one(/TOTAL, install to stored byte\s+([\d.]+)s/, 'the time to first file')[1];
  return {
    version, ttff, shared,
    rev: revisionFigures(read('benchmark/revisions/README.md'), read),
    noChain: { x: noChain[3], types: noChainDec[1], sites: noChainDec[2] },
    fl: loc('filelayer'), prod: loc('filelayer-production'), sup: loc('baseline-supabase'), s3: loc('baseline-raw-s3'),
    cx: loc('baseline-convex'), vb: loc('baseline-vercel-blob'),
    word: median[0],
    median: { exec: median[1], fl: median[2], x: median[3] },
    noChainProd: { exec: noChainProd[1], fl: noChainProd[2], x: noChainProd[3] },
    sup9: { types: sup9[1], sites: sup9[2], x: sup9[3] },
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
    [`| Filelayer ${f.version} | ${f.afl.defended} of ${f.shared} | ${f.afl.partial} | ${f.afl.breach} |`, 'Filelayer on the shared attacks'],
    [`| Raw S3 | ${f.as3.defended} of ${f.shared} | ${f.as3.partial} | ${f.as3.breach} |`, 'raw S3 on the shared attacks'],
    [`| Supabase | ${f.asup.defended} of ${f.shared} | ${f.asup.partial} | ${f.asup.breach} |`, 'Supabase on the shared attacks'],
    [`| Filelayer, earlier version (control) | ${f.actl.defended} of ${f.shared} | ${f.actl.partial} | ${f.actl.breach} |`, 'the control on the shared attacks'],
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
    [`about ${f.prodMedian.x} times as many lines as Filelayer**: an ${f.word} of ${f.prodMedian.exec} against ${f.prodMedian.fl}`.replace('an median', 'a median'), 'the production-wired average'],
    [`${f.word} of the two is ${f.median.exec} application lines against ${f.median.fl}, about ${f.median.x} times as many`, 'the example average'],
    [`the ${f.word} is about ${f.decMedian.types} times as many`, 'the word the run uses for the decisions'],
    [`about ${f.noChainProd.x} times as many lines against Filelayer wired as in production`, 'the production-wired sensitivity without the audit chain'],
    [`Supabase has ${f.sup9.sites} places instead of ${f.dsup.sites}, and the ${f.word} for places is about ${f.sup9.x} times as many`, 'the Supabase #9 sensitivity'],
    [`| Filelayer | ${f.vfl[1]} | ${f.vfl[2]} |`, 'Filelayer vendor lines'],
    [`| Raw S3 | ${f.vs3[1]} (the AWS SDK) | ${f.vs3[2]} |`, 'raw S3 vendor lines'],
    [`about ${f.noChain.x} times as many lines against the example, and ${f.noChain.types} and ${f.noChain.sites} times as many kinds and places`, 'the sensitivity without the audit chain'],
  ];
  if (f.thirtySeconds) page.push(['30 seconds', "Supabase's 30-second window, which RESULTS.md names"]);
  {
    const s3 = f.rev['Raw S3'];
    const sup = f.rev['Supabase'];
    page.push([
      `Raw S3 changed ${s3.lines} lines in ${rounds(s3.rounds)}, Supabase ${sup.lines} in ${rounds(sup.rounds)}`,
      'the revision rounds and their lines, from benchmark/revisions/README.md',
    ]);
  }
  const readme = [
    [`${f.dsup.types} and ${f.ds3.types} against Filelayer's ${f.dfl.types}`, 'decision kinds'],
    [`About ${f.decMedian.types} times as many kinds`, 'the decisions average'],
    [`about ${f.decMedian.sites} times as many places`, 'the places average'],
    [`**${f.afl.defended} of ${f.shared}** for Filelayer`, 'Filelayer on the shared attacks'],
    [`Raw S3 also defends ${f.as3.defended} of ${f.shared}; Supabase defends ${f.asup.defended}`, 'raw S3 and Supabase on the shared attacks'],
    [`About ${f.prodMedian.x} times as many lines`, 'the production-wired ratio'],
    [`${f.prodTotals} lines of application and infrastructure code against Filelayer's ${f.prodMedian.fl}`, 'the production-wired lines of each alternative'],
    [`(raw S3 in ${rounds(f.rev['Raw S3'].rounds)}, Supabase in ${rounds(f.rev['Supabase'].rounds)})`, 'the revision rounds, from benchmark/revisions/README.md'],
    [`${f.median.fl} lines, it is about ${f.median.x} times as many`, 'the example ratio'],
  ];
  // The homepage states the argument with the same figures (14 November 2026).
  const home = [
    [`<span class="v">about ${f.prodMedian.x} times as many</span>`, 'the production-wired ratio'],
    [`<span class="v">about ${f.decMedian.types} times as many</span>`, 'the decisions ratio'],
    [`took ${f.prodTotals} lines against Filelayer's ${f.prodMedian.fl}`, 'the production-wired lines of each alternative'],
    [`${f.dsup.types} and ${f.ds3.types} kinds of security-sensitive decision against its ${f.dfl.types}`, 'decision kinds'],
    f.as3.defended === f.asup.defended
      ? [`raw S3 and Supabase defended all ${f.as3.defended} shared attacks`, 'raw S3 and Supabase on the shared attacks']
      : [`raw S3 and Supabase scored ${f.as3.defended} and ${f.asup.defended}`, 'raw S3 and Supabase on the shared attacks, which RESULTS.md now gives apart'],
  ];
  return { 'benchmark/PAGE.md': page, 'README.md': readme, 'web/index.html': home };
}

// Wording a run no longer supports. Supabase's 30-second window was a property
// of its redirecting share gateway; once RESULTS.md stops naming it, neither
// the page nor the README may.
function absent(f) {
  const always = [['Supabase, as built', 'the "as built" label, which the revised Supabase no longer carries']];
  if (f.thirtySeconds) return { 'benchmark/PAGE.md': always, 'README.md': always, 'web/index.html': always };
  const gone = [...always, ['30 seconds', "Supabase's 30-second window, which RESULTS.md no longer names"], ['30-second', "Supabase's 30-second window, which RESULTS.md no longer names"]];
  return { 'benchmark/PAGE.md': gone, 'README.md': gone, 'web/index.html': gone };
}

/** How far the page's seconds may be from the run's, as a factor either way. */
const TTFF_FACTOR = 2;
const TTFF_ON_PAGE = /it took ([\d.]+) seconds/;

function ttffProblem(texts, f) {
  const m = TTFF_ON_PAGE.exec(norm(texts['benchmark/PAGE.md']));
  if (!m) return 'benchmark/PAGE.md: the time to first file. Expected "it took <seconds> seconds".';
  const page = Number(m[1]);
  const run = Number(f.ttff);
  if (page >= run / TTFF_FACTOR && page <= run * TTFF_FACTOR) return null;
  return `benchmark/PAGE.md: the time to first file. The page says ${m[1]} s and this run measured ` +
    `${f.ttff} s; seconds vary by machine, but not by more than ${TTFF_FACTOR}x either way.`;
}

function check(texts, f) {
  const problems = [];
  for (const [label, r] of Object.entries(f.rev)) {
    if (r.lines !== r.counted) {
      problems.push(`benchmark/revisions/README.md: ${label} says ${r.lines} changed lines of application code; its diff has ${r.counted}.`);
    }
  }
  if (Object.values(f.rev).some((r) => r.rounds !== 1)) {
    for (const file of ['benchmark/PAGE.md', 'README.md', 'web/index.html']) {
      if (/\bone revision round\b|\bhad one revision round\b|After one revision round/i.test(norm(texts[file]))) {
        problems.push(`${file}: says "one revision round", and benchmark/revisions/README.md records ${Object.entries(f.rev).map(([l, r]) => `${l} ${r.rounds}`).join(', ')}.`);
      }
    }
  }
  const t = ttffProblem(texts, f);
  if (t) problems.push(t);
  for (const [file, list] of Object.entries(absent(f))) {
    const body = norm(texts[file]);
    for (const [phrase, what] of list) {
      if (body.includes(norm(phrase))) problems.push(`${file}: ${what}. Remove:\n      ${phrase}`);
    }
  }
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
{
  // The two production-wired totals the middle figure is taken over, so the
  // README and the homepage state them rather than a word for their middle.
  const s3 = Number(f.s3.app) + Number(f.s3.infra);
  const sup = Number(f.sup.app) + Number(f.sup.infra);
  if ((s3 + sup) / 2 !== Number(f.prodMedian.exec)) {
    console.error(`check-page-figures: RESULTS.md gives ${f.prodMedian.exec} for the two production-wired alternatives, but raw S3 (${s3}) and Supabase (${sup}) average ${(s3 + sup) / 2}.`);
    process.exit(1);
  }
  f.prodTotals = `${s3} and ${sup}`;
}
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
  // The time: outside the range either way must fail; a different machine
  // inside it must pass.
  const run = Number(f.ttff);
  const withPage = (secs) => ({
    ...texts,
    'benchmark/PAGE.md': norm(texts['benchmark/PAGE.md']).replace(TTFF_ON_PAGE, `it took ${secs} seconds`),
  });
  for (const secs of [(run * TTFF_FACTOR * 1.1).toFixed(1), (run / TTFF_FACTOR / 1.1).toFixed(1)]) {
    tried++;
    if (!ttffProblem(withPage(secs), f)) { bad++; console.error(`  self-test FAILED: a time of ${secs} s passed against ${run} s`); }
  }
  // A stranger's run 20% faster than this one, against a page that quotes this one.
  tried++;
  if (ttffProblem(withPage(run.toFixed(1)), { ...f, ttff: String((run * 0.8).toFixed(1)) })) {
    bad++;
    console.error('  self-test FAILED: a reproduction 20% faster than the published run was refused');
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
