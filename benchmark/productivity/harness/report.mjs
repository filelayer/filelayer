#!/usr/bin/env node
/**
 * THE REPORT OF A PHASE, from metrics.json alone.
 *
 *   node report.mjs --runs ../runs/full [--include-dry]
 *
 * Writes runs/<phase>/REPORT.json and REPORT.md. Per model, never averaged
 * across models. Per arm. Three blocks never merged into one figure:
 * functional, security, both. Every figure carries its label: observed or
 * estimated. The rules that turn figures into verdicts are the ones PREREG.md
 * fixes, and they are written out in the code below next to each of H1 to H6.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const runsDir = resolve(args[args.indexOf('--runs') + 1]);
const includeDry = args.includes('--include-dry');
const CONFIRM = 0.3; // at least 30 % better
const REFUTE = 0.1; // less than 10 % better, or worse
const BOOT = 10_000;

// --- statistics --------------------------------------------------------------

const sorted = (xs) => [...xs].sort((a, b) => a - b);
function quantile(xs, q) {
  const s = sorted(xs);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const median = (xs) => quantile(xs, 0.5);
const iqr = (xs) => (xs.length ? [quantile(xs, 0.25), quantile(xs, 0.75)] : null);

/** Wilson score interval for k successes in n, 95 %. */
function wilson(k, n) {
  if (!n) return null;
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** One-sided Fisher exact test: P(A has at least kA successes) under no difference. */
function fisherGreater(kA, nA, kB, nB) {
  const lf = (n) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const K = kA + kB;
  const N = nA + nB;
  const p = (x) => Math.exp(lf(K) + lf(N - K) + lf(nA) + lf(nB) - lf(x) - lf(K - x) - lf(nA - x) - lf(nB - K + x) - lf(N));
  let sum = 0;
  for (let x = kA; x <= Math.min(K, nA); x++) if (nB - K + x >= 0) sum += p(x);
  return Math.min(1, sum);
}

// mulberry32, seeded, so the intervals are the same on every machine.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap 95 % interval of median(A) - median(B), and of its ratio to median(B). */
function bootDiff(a, b, seed = 1) {
  if (a.length < 2 || b.length < 2) return null;
  const r = rng(seed);
  const pick = (xs) => Array.from(xs, () => xs[Math.floor(r() * xs.length)]);
  const diffs = [];
  const rel = [];
  for (let i = 0; i < BOOT; i++) {
    const ma = median(pick(a));
    const mb = median(pick(b));
    diffs.push(ma - mb);
    if (mb) rel.push((ma - mb) / mb);
  }
  return { diff95: [quantile(diffs, 0.025), quantile(diffs, 0.975)], relative95: [quantile(rel, 0.025), quantile(rel, 0.975)] };
}

/** A "less is better" comparison of A against B, read by the preregistered thresholds. */
function lessIsBetter(name, a, b, seed) {
  const ma = median(a);
  const mb = median(b);
  const rel = ma !== null && mb ? (ma - mb) / mb : null;
  const ci = bootDiff(a, b, seed);
  let verdict = 'not computable';
  if (rel !== null) {
    if (rel <= -CONFIRM && ci && ci.diff95[1] < 0) verdict = 'confirmed';
    else if (rel > -REFUTE) verdict = 'refuted';
    else verdict = 'inconclusive';
  }
  return { measure: name, medianA: ma, medianB: mb, relative: rel, ...ci, nA: a.length, nB: b.length, verdict };
}

// --- the data ----------------------------------------------------------------

const all = readdirSync(runsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, 'metrics.json')))
  .map((d) => JSON.parse(readFileSync(join(runsDir, d.name, 'metrics.json'), 'utf8')))
  .filter((m) => includeDry || !m.dryRun);

const models = [...new Set(all.map((m) => m.model))].sort();
const task = (m, n) => m.tasks.find((t) => t.task === n);
const valid = (m, n) => {
  const t = task(m, n);
  return t && !t.skipped && t.stoppedBy !== 'phase_cap' && !m.error;
};
const num = (xs) => xs.filter((x) => typeof x === 'number' && Number.isFinite(x));

function cell(runs, n) {
  const ts = runs.filter((m) => valid(m, n)).map((m) => task(m, n));
  const k = (block) => ts.filter((t) => t.observed.blocks[block]).length;
  const prop = (block) => ({ k: k(block), n: ts.length, wilson95: wilson(k(block), ts.length) });
  const series = (f) => num(ts.map(f));
  const stat = (f) => {
    const xs = series(f);
    return { median: median(xs), iqr: iqr(xs), n: xs.length };
  };
  return {
    runs: ts.length,
    invalid: runs.length - ts.length,
    observed: {
      functional: prop('functional'),
      security: prop('security'),
      both: prop('both'),
      attacksDefended: stat((t) => t.observed.security?.defended),
      tokens: stat((t) => t.observed.tokens?.inputPlusOutput),
      outputTokens: stat((t) => t.observed.tokens?.output),
      wallSeconds: stat((t) => (t.observed.wallMs ?? NaN) / 1000),
      turns: stat((t) => t.observed.turns),
      testRuns: stat((t) => t.observed.testRuns),
      corrections: stat((t) => t.observed.corrections),
      netLines: stat((t) => t.observed.loc?.net),
      linesChanged: stat((t) => (t.observed.diff ? t.observed.diff.added + t.observed.diff.removed : NaN)),
      stoppedBy: ts.reduce((a, t) => ({ ...a, [t.stoppedBy]: (a[t.stoppedBy] ?? 0) + 1 }), {}),
    },
    estimated: {
      costUsd: stat((t) => t.estimated.costUsd),
      docTokens: stat((t) => t.estimated.docTokens),
    },
  };
}

const report = { phase: all[0]?.phase ?? null, generatedAt: new Date().toISOString(), runs: all.length, models: {} };

for (const model of models) {
  const of = (arm) => all.filter((m) => m.model === model && m.arm === arm);
  const A = of('a');
  const B = of('b');
  const r = { tasks: {}, hypotheses: {} };
  for (const n of [1, 2, 3]) r.tasks[n] = { a: cell(A, n), b: cell(B, n) };

  const t1 = (runs) => runs.filter((m) => valid(m, 1)).map((m) => task(m, 1));
  const [a1, b1] = [t1(A), t1(B)];

  // H1, reliability: more runs pass the whole functional battery (task 1), and
  // the difference is not chance (one-sided Fisher exact test, p < 0.05).
  {
    const kA = a1.filter((t) => t.observed.blocks.functional).length;
    const kB = b1.filter((t) => t.observed.blocks.functional).length;
    const p = a1.length && b1.length ? fisherGreater(kA, a1.length, kB, b1.length) : null;
    r.hypotheses.H1 = {
      block: 'functional', a: `${kA}/${a1.length}`, b: `${kB}/${b1.length}`, fisherOneSidedP: p,
      verdict: p === null ? 'not computable' : kA <= kB ? 'refuted' : p < 0.05 ? 'confirmed' : 'inconclusive',
    };
  }
  // H2, security: more attacks defended per run (task 1), in median.
  {
    const da = num(a1.map((t) => t.observed.security?.defended));
    const db = num(b1.map((t) => t.observed.security?.defended));
    const ma = median(da);
    const mb = median(db);
    r.hypotheses.H2 = {
      block: 'security', medianA: ma, medianB: mb, ...bootDiff(da, db, 2),
      verdict: ma === null || mb === null ? 'not computable' : ma > mb ? 'confirmed' : 'refuted',
    };
  }
  // H3, total cost: median tokens of task 1 at least 30 % lower.
  r.hypotheses.H3 = lessIsBetter('tokens, task 1 (observed)',
    num(a1.map((t) => t.observed.tokens?.inputPlusOutput)), num(b1.map((t) => t.observed.tokens?.inputPlusOutput)), 3);
  // H4, cost of a correct implementation (block "both", task 1), two ways.
  {
    const spend = (ts) => ts.reduce((s, t) => s + (t.estimated.costUsd ?? 0), 0);
    const good = (ts) => ts.filter((t) => t.observed.blocks.both);
    const per = (ts) => {
      const g = good(ts).length;
      const total = spend(ts);
      return g
        ? { valid: `${g} of ${ts.length}`, totalUsd: total, perCorrectUsd: total / g, medianOfCorrectUsd: median(num(good(ts).map((t) => t.estimated.costUsd))) }
        : { valid: `0 of ${ts.length}`, totalUsd: total, perCorrectUsd: null, note: `not computable, more than $${total.toFixed(2)}` };
    };
    const pa = per(a1);
    const pb = per(b1);
    let verdict = 'not computable';
    if (pa.perCorrectUsd !== null && pb.perCorrectUsd !== null) {
      const rel = (pa.perCorrectUsd - pb.perCorrectUsd) / pb.perCorrectUsd;
      verdict = rel <= -CONFIRM ? 'confirmed' : rel > -REFUTE ? 'refuted' : 'inconclusive';
      pa.relativeToB = rel;
    } else {
      // An arm with no correct implementation has no cost per correct
      // implementation: not computed, not replaced by another figure.
      verdict = `not computable (${[pa.perCorrectUsd === null ? `A: ${pa.note}` : null, pb.perCorrectUsd === null ? `B: ${pb.note}` : null].filter(Boolean).join('; ')})`;
    }
    r.hypotheses.H4 = { block: 'both', label: 'estimated', a: pa, b: pb, verdict };
  }
  // H5, time: median wall time of task 1 at least 30 % lower.
  r.hypotheses.H5 = lessIsBetter('wall seconds, task 1 (observed)',
    num(a1.map((t) => t.observed.wallMs / 1000)), num(b1.map((t) => t.observed.wallMs / 1000)), 5);
  // H6, maintenance approximation: tasks 2 and 3 together cost fewer tokens AND
  // less time; confirmed only if both are confirmed, refuted if either is.
  {
    const sum23 = (runs, f) => num(runs.filter((m) => valid(m, 2) && valid(m, 3)).map((m) => f(task(m, 2)) + f(task(m, 3))));
    const tok = lessIsBetter('tokens, tasks 2+3', sum23(A, (t) => t.observed.tokens?.inputPlusOutput ?? NaN),
      sum23(B, (t) => t.observed.tokens?.inputPlusOutput ?? NaN), 61);
    const time = lessIsBetter('wall seconds, tasks 2+3', sum23(A, (t) => t.observed.wallMs / 1000),
      sum23(B, (t) => t.observed.wallMs / 1000), 62);
    const v = [tok.verdict, time.verdict];
    r.hypotheses.H6 = {
      tokens: tok, time,
      verdict: v.includes('not computable') ? 'not computable' : v.includes('refuted') ? 'refuted'
        : v.every((x) => x === 'confirmed') ? 'confirmed' : 'inconclusive',
    };
  }
  report.models[model] = r;
}

writeFileSync(join(runsDir, 'REPORT.json'), JSON.stringify(report, null, 2));

// --- the readable version ------------------------------------------------------

const f = (x, d = 0) => (x === null || x === undefined ? 'n/a' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (p) => `${p.k}/${p.n}${p.wilson95 ? ` (95% ${f(p.wilson95[0] * 100)}-${f(p.wilson95[1] * 100)} %)` : ''}`;
const st = (s, d = 0) => (s.median === null ? 'n/a' : `${f(s.median, d)} [${f(s.iqr[0], d)}-${f(s.iqr[1], d)}]`);
const md = [`# Productivity benchmark: ${report.phase} phase`, '',
  `${report.runs} runs. Medians with the interquartile range in brackets. Every figure is observed unless the row says estimated. Per model; models are never averaged.`, ''];
for (const [model, r] of Object.entries(report.models)) {
  md.push(`## ${model}`, '');
  for (const n of [1, 2, 3]) {
    const { a, b } = r.tasks[n];
    md.push(`### Task ${n}`, '', '| | A, Filelayer | B, own implementation |', '|---|---|---|',
      `| Valid runs | ${a.runs} | ${b.runs} |`,
      `| Functional: passes every hidden check | ${pct(a.observed.functional)} | ${pct(b.observed.functional)} |`,
      `| Security: defends all 21 attacks | ${pct(a.observed.security)} | ${pct(b.observed.security)} |`,
      `| Both | ${pct(a.observed.both)} | ${pct(b.observed.both)} |`,
      `| Attacks defended | ${st(a.observed.attacksDefended)} | ${st(b.observed.attacksDefended)} |`,
      `| Tokens, all kinds | ${st(a.observed.tokens)} | ${st(b.observed.tokens)} |`,
      `| Output tokens | ${st(a.observed.outputTokens)} | ${st(b.observed.outputTokens)} |`,
      `| Cost, USD (estimated) | ${st(a.estimated.costUsd, 2)} | ${st(b.estimated.costUsd, 2)} |`,
      `| Wall time, s | ${st(a.observed.wallSeconds)} | ${st(b.observed.wallSeconds)} |`,
      `| Turns | ${st(a.observed.turns)} | ${st(b.observed.turns)} |`,
      `| Test runs | ${st(a.observed.testRuns)} | ${st(b.observed.testRuns)} |`,
      `| Corrections | ${st(a.observed.corrections)} | ${st(b.observed.corrections)} |`,
      `| Net lines in the project | ${st(a.observed.netLines)} | ${st(b.observed.netLines)} |`,
      `| Lines changed by the task | ${st(a.observed.linesChanged)} | ${st(b.observed.linesChanged)} |`,
      `| Documentation read, tokens (estimated) | ${st(a.estimated.docTokens)} | ${st(b.estimated.docTokens)} |`,
      `| Stopped by | ${JSON.stringify(a.observed.stoppedBy)} | ${JSON.stringify(b.observed.stoppedBy)} |`, '');
  }
  md.push('### Hypotheses', '', '| | Verdict | Detail |', '|---|---|---|');
  for (const [h, v] of Object.entries(r.hypotheses)) {
    const { verdict, ...rest } = v;
    md.push(`| ${h} | ${verdict} | \`${JSON.stringify(rest).slice(0, 400)}\` |`);
  }
  md.push('');
}
writeFileSync(join(runsDir, 'REPORT.md'), md.join('\n'));
console.log(`report: ${report.runs} runs, ${models.length} model(s): ${Object.entries(report.models).map(([m, r]) => `${m} ${Object.entries(r.hypotheses).map(([h, v]) => `${h} ${v.verdict}`).join(', ')}`).join('; ')}`);
