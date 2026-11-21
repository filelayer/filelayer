#!/usr/bin/env node
/**
 * The order of the runs of one phase, fixed by a recorded seed.
 *
 * Every model gets runsPerCell runs per arm. The order is random, from the
 * seed in config.json, under one constraint: arms alternate, so a change in
 * the API's speed or behaviour during the phase falls on both arms alike.
 *
 *   node plan.mjs pilot|full > ../runs/<phase>/plan.json
 */
import { readFileSync } from 'node:fs';

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
