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
const BOOT = 10_000;

// --- statistics: in stats.mjs, with its own tests ------------------------------

import { bootDiff, fisherGreater, fisherTwoSided, iqr, mannWhitney, median, quantile, rng, wilson } from './stats.mjs';
import * as V from './verdicts.mjs';

/** A "less is better" comparison of A against B, read by the preregistered thresholds. */
function lessIsBetter(name, a, b, seed) {
  const ma = median(a);
  const mb = median(b);
  const rel = ma !== null && mb ? (ma - mb) / mb : null;
  const ci = bootDiff(a, b, seed);
  const verdict = V.lessIsBetter(rel, ci?.diff95, ci?.relative95);
  return { measure: name, medianA: ma, medianB: mb, relative: rel, ...ci, nA: a.length, nB: b.length, verdict };
}

// --- the data ----------------------------------------------------------------

const all = readdirSync(runsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, 'metrics.json')))
  .map((d) => JSON.parse(readFileSync(join(runsDir, d.name, 'metrics.json'), 'utf8')))
  .filter((m) => includeDry || !m.dryRun);

const models = [...new Set(all.map((m) => m.model))].sort();
const task = (m, n) => m.tasks.find((t) => t.task === n);
// An invalid run (analyze.mjs: the infrastructure failed) counts in no figure;
// it is listed with its reason, and its replacement counts instead.
const valid = (m, n) => {
  const t = task(m, n);
  return t && !t.skipped && t.stoppedBy !== 'phase_cap' && !m.error && !m.invalid;
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
      lateAttacksDefended: stat((t) => t.observed.late?.defended),
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

const report = {
  phase: all[0]?.phase ?? null, generatedAt: new Date().toISOString(), runs: all.length,
  invalid: all.filter((m) => m.invalid || m.error).map((m) => ({ id: m.id, reason: m.invalid?.reason ?? m.error, task: m.invalid?.task ?? null })),
  multiplicity: 'Six hypotheses per model, two models: twelve decisions, none corrected for multiplicity. At p < 0.05, about one false confirmation in twenty decisions is expected by chance where there is no real difference. Read each as its own result, not as a family.',
  models: {},
};

for (const model of models) {
  const of = (arm) => all.filter((m) => m.model === model && m.arm === arm);
  const A = of('a');
  const B = of('b');
  const r = { tasks: {}, hypotheses: {} };
  for (const n of [1, 2, 3]) r.tasks[n] = { a: cell(A, n), b: cell(B, n) };

  const t1 = (runs) => runs.filter((m) => valid(m, 1)).map((m) => task(m, 1));
  const [a1, b1] = [t1(A), t1(B)];

  // H1, reliability: a larger share of task-1 runs passes the whole functional
  // battery, and a two-sided Fisher exact test gives p < 0.05. Refuted when A's
  // share is equal or lower. The one-sided p is reported beside it.
  {
    const kA = a1.filter((t) => t.observed.blocks.functional).length;
    const kB = b1.filter((t) => t.observed.blocks.functional).length;
    const ok = a1.length && b1.length;
    const p = ok ? fisherTwoSided(kA, a1.length, kB, b1.length) : null;
    r.hypotheses.H1 = {
      block: 'functional', a: `${kA}/${a1.length}`, b: `${kB}/${b1.length}`, fisherTwoSidedP: p,
      fisherOneSidedP: ok ? fisherGreater(kA, a1.length, kB, b1.length) : null,
      verdict: V.h1({ kA, nA: a1.length, kB, nB: b1.length, p }),
    };
  }
  // H2, security: more attacks defended per task-1 run. Decided by a two-sided
  // Mann-Whitney test on the number defended (a run that did not start, did not
  // install or left no project defends 0): confirmed when A's mean is higher
  // and p < 0.05, refuted when A's mean is equal or lower. Reported beside it:
  // a two-sided Fisher exact test on the share of runs that defend all 21.
  {
    const da = num(a1.map((t) => t.observed.security?.defended ?? 0));
    const db = num(b1.map((t) => t.observed.security?.defended ?? 0));
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
    const mw = da.length && db.length ? mannWhitney(da, db) : null;
    const allA = a1.filter((t) => t.observed.blocks.security).length;
    const allB = b1.filter((t) => t.observed.blocks.security).length;
    r.hypotheses.H2 = {
      block: 'security', meanA: mean(da), meanB: mean(db), medianA: median(da), medianB: median(db),
      mannWhitney: mw, allDefended: { a: `${allA}/${a1.length}`, b: `${allB}/${b1.length}`,
        fisherTwoSidedP: a1.length && b1.length ? fisherTwoSided(allA, a1.length, allB, b1.length) : null },
      verdict: V.h2({ meanA: mean(da), meanB: mean(db), p: mw?.p }),
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
    let ci = null;
    if (pa.perCorrectUsd !== null && pb.perCorrectUsd !== null) {
      const rel = (pa.perCorrectUsd - pb.perCorrectUsd) / pb.perCorrectUsd;
      pa.relativeToB = rel;
      // Bootstrap of the ratio: resample each arm's runs, recompute spend per
      // correct implementation. A resample with no correct run in either arm
      // has no ratio; it is dropped and the share dropped is reported.
      const rr = rng(4);
      const pick = (xs) => Array.from(xs, () => xs[Math.floor(rr() * xs.length)]);
      const perOf = (ts) => {
        const g = ts.filter((t) => t.observed.blocks.both).length;
        return g ? spend(ts) / g : null;
      };
      const rels = [];
      let dropped = 0;
      for (let i = 0; i < BOOT; i++) {
        const x = perOf(pick(a1));
        const y = perOf(pick(b1));
        if (x === null || y === null) dropped++;
        else rels.push((x - y) / y);
      }
      ci = { relative95: rels.length ? [quantile(rels, 0.025), quantile(rels, 0.975)] : null, droppedResamples: dropped / BOOT };
      // The same rule as H3: confirmed at 30 % lower with the interval below
      // zero, refuted when the whole interval is above -10 %.
      verdict = V.h4(rel, ci.relative95);
    } else {
      // An arm with no correct implementation has no cost per correct
      // implementation: not computed, not replaced by another figure.
      verdict = `not computable (${[pa.perCorrectUsd === null ? `A: ${pa.note}` : null, pb.perCorrectUsd === null ? `B: ${pb.note}` : null].filter(Boolean).join('; ')})`;
    }
    r.hypotheses.H4 = { block: 'both', label: 'estimated', a: pa, b: pb, bootstrap: ci, verdict };
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
    r.hypotheses.H6 = { tokens: tok, time, verdict: V.h6(tok.verdict, time.verdict) };
  }
  // Cold review, finding 1: arm A's completion, split by whether the run read
  // the package's examples/vault, the example closest to this task.
  r.vaultSplit = {};
  for (const n of [1, 2, 3]) {
    const ts = A.filter((m) => valid(m, n)).map((m) => task(m, n));
    const part = (read) => {
      const xs = ts.filter((t) => (t.observed.examples?.vault ?? 0) > 0 === read);
      const k = (b) => xs.filter((t) => t.observed.blocks[b]).length;
      return { runs: xs.length, functional: `${k('functional')}/${xs.length}`, security: `${k('security')}/${xs.length}`, both: `${k('both')}/${xs.length}` };
    };
    r.vaultSplit[n] = { read: part(true), notRead: part(false) };
  }
  report.models[model] = r;
}

writeFileSync(join(runsDir, 'REPORT.json'), JSON.stringify(report, null, 2));

// --- the readable version ------------------------------------------------------

const f = (x, d = 0) => (x === null || x === undefined ? 'n/a' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (p) => `${p.k}/${p.n}${p.wilson95 ? ` (95% ${f(p.wilson95[0] * 100)}-${f(p.wilson95[1] * 100)} %)` : ''}`;
const st = (s, d = 0) => (s.median === null ? 'n/a' : `${f(s.median, d)} [${f(s.iqr[0], d)}-${f(s.iqr[1], d)}]`);
const md = [`# Productivity benchmark: ${report.phase} phase`, '',
  `${report.runs} runs. Medians with the interquartile range in brackets. Every figure is observed unless the row says estimated. Per model; models are never averaged.`, '',
  `**Invalid runs** (the infrastructure failed; counted in no figure, replaced once): ${report.invalid.length ? report.invalid.map((x) => `${x.id} (${x.reason}${x.task ? `, task ${x.task}` : ''})`).join('; ') : 'none'}.`, '',
  `**Multiplicity.** ${report.multiplicity}`, ''];
for (const [model, r] of Object.entries(report.models)) {
  md.push(`## ${model}`, '');
  for (const n of [1, 2, 3]) {
    const { a, b } = r.tasks[n];
    md.push(`### Task ${n}`, '', '| | A, Filelayer | B, own implementation |', '|---|---|---|',
      `| Valid runs | ${a.runs} | ${b.runs} |`,
      `| Functional: passes every hidden check | ${pct(a.observed.functional)} | ${pct(b.observed.functional)} |`,
      `| Security: defends all 21 attacks | ${pct(a.observed.security)} | ${pct(b.observed.security)} |`,
      `| Both | ${pct(a.observed.both)} | ${pct(b.observed.both)} |`,
      `| Attacks defended (of the 21) | ${st(a.observed.attacksDefended)} | ${st(b.observed.attacksDefended)} |`,
      `| Late attacks defended (written after the freeze, apart) | ${st(a.observed.lateAttacksDefended)} | ${st(b.observed.lateAttacksDefended)} |`,
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
  md.push('### Arm A, by whether the run read `examples/vault`', '', '| Task | Read: runs, functional, security, both | Not read: runs, functional, security, both |', '|---|---|---|');
  for (const n of [1, 2, 3]) {
    const v = r.vaultSplit[n];
    md.push(`| ${n} | ${v.read.runs}, ${v.read.functional}, ${v.read.security}, ${v.read.both} | ${v.notRead.runs}, ${v.notRead.functional}, ${v.notRead.security}, ${v.notRead.both} |`);
  }
  md.push('');
  md.push('### Hypotheses', '', '| | Verdict | Detail |', '|---|---|---|');
  for (const [h, v] of Object.entries(r.hypotheses)) {
    const { verdict, ...rest } = v;
    md.push(`| ${h} | ${verdict} | \`${JSON.stringify(rest).slice(0, 400)}\` |`);
  }
  md.push('');
}
writeFileSync(join(runsDir, 'REPORT.md'), md.join('\n'));
console.log(`report: ${report.runs} runs, ${models.length} model(s): ${Object.entries(report.models).map(([m, r]) => `${m} ${Object.entries(r.hypotheses).map(([h, v]) => `${h} ${v.verdict}`).join(', ')}`).join('; ')}`);
