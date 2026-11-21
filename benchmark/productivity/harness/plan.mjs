#!/usr/bin/env node
/**
 * The order of the runs of one phase, fixed by a recorded seed.
 *
 * Every model gets runsPerCell runs per arm. The order is random, from the
 * seed in config.json, under one constraint: arms alternate, so a change in
 * the API's speed or behaviour during the phase falls on both arms alike.
 *
 *   node plan.mjs pilot|full > ../runs/<phase>/plan.json
 *   node plan.mjs --extend ../runs/<phase>/plan.json   (rewrites it in place)
 *
 * --extend appends one replacement for every run analyze.mjs found invalid,
 * of the same arm and model, at the end of the order. Each invalid run is
 * replaced once: a replacement that is itself invalid is not replaced again.
 * Run it after analyze.mjs, then run.mjs again on the same plan.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.argv[2] === '--extend') {
  const file = process.argv[3];
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const dir = dirname(file);
  const replaced = new Set(p.runs.filter((r) => r.replaces).map((r) => r.replaces));
  let k = p.runs.filter((r) => r.replaces).length;
  const added = [];
  for (const r of [...p.runs]) {
    if (r.replaces || replaced.has(r.id)) continue;
    // Invalid by analyze.mjs (metrics.json), or by the harness itself
    // (run.json: an interrupted run, a harness error, a phase-cap skip).
    const f = join(dir, r.id, 'metrics.json');
    const rf = join(dir, r.id, 'run.json');
    const m = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    const rr = existsSync(rf) ? JSON.parse(readFileSync(rf, 'utf8')) : null;
    const why = m?.invalid?.reason ?? rr?.invalid?.reason ?? (rr?.error ? 'harness_error' : null);
    if (!why) continue;
    k++;
    const rep = { id: `${p.phase}-r${String(k).padStart(2, '0')}-${r.arm}-${r.model.replace('claude-', '')}`, phase: p.phase, arm: r.arm, model: r.model, replaces: r.id };
    p.runs.push(rep);
    added.push(`${rep.id} replaces ${r.id} (${why})`);
  }
  writeFileSync(file, JSON.stringify(p, null, 2));
  console.log(added.length ? added.join('\n') : 'no invalid run to replace');
  process.exit(0);
}

const phase = process.argv[2];
const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
if (!cfg.runsPerCell[phase]) throw new Error('phase is pilot or full');

// mulberry32: small, seedable, and the same in every Node version.
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
const rand = rng(cfg.seed[phase]);
const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

const n = cfg.runsPerCell[phase];
// One queue per arm, each holding every model n times, shuffled.
const queues = Object.fromEntries(cfg.arms.map((arm) => [arm, shuffle(cfg.models.flatMap((m) => Array(n).fill(m)))]));
let first = rand() < 0.5 ? 0 : 1;
const runs = [];
for (let i = 0; runs.length < n * cfg.models.length * cfg.arms.length; i++) {
  const arm = cfg.arms[(i + first) % cfg.arms.length];
  const model = queues[arm].shift();
  if (model === undefined) continue;
  runs.push({ id: `${phase}-${String(runs.length + 1).padStart(2, '0')}-${arm}-${model.replace('claude-', '')}`, phase, arm, model });
}
console.log(JSON.stringify({ phase, seed: cfg.seed[phase], config: cfg, runs }, null, 2));
