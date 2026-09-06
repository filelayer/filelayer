#!/usr/bin/env node
/**
 * Sum `decisions.json` under the two-number convention and print the table.
 *
 * The point of this script is that the recount is DATA, not prose. Every
 * decision, every site count and every piece of evidence for a multiplier is in
 * `decisions.json`. Delete a row you disagree with, re-run, and you have your
 * own number.
 *
 *   node benchmark/count-decisions.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = JSON.parse(fs.readFileSync(path.join(HERE, 'decisions.json'), 'utf8'));

const IMPLS = ['filelayer', 'supabase', 'raw-s3', 'vercel-blob', 'convex'];

const rows = IMPLS.map((name) => {
  const impl = DATA[name];
  const types = impl.decisions.length;
  const sites = impl.decisions.reduce((n, d) => n + d.sites, 0);
  const repeated = impl.decisions.filter((d) => d.sites > 1).length;
  return { name, types, sites, repeated, arguable: (impl.arguable ?? []).length };
});

const fl = rows.find((r) => r.name === 'filelayer');
const others = rows.filter((r) => r.name !== 'filelayer');
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

console.log('\nSECURITY-SENSITIVE DECISIONS, one convention, all five implementations');
console.log('(types = distinct kinds; sites = places you must get it right)\n');
console.log('| Implementation | types | sites | of which repeated |');
console.log('|---|---:|---:|---:|');
for (const r of rows) {
  console.log(`| ${r.name.padEnd(12)} | ${String(r.types).padStart(5)} | ${String(r.sites).padStart(5)} | ${String(r.repeated).padStart(17)} |`);
}

console.log('\nREDUCTION vs Filelayer\n');
console.log('| Against | types | sites |');
console.log('|---|---:|---:|');
for (const r of others) {
  console.log(`| ${r.name.padEnd(12)} | ${(r.types / fl.types).toFixed(1)}x | ${(r.sites / fl.sites).toFixed(1)}x |`);
}
const mt = median(others.map((r) => r.types));
const ms = median(others.map((r) => r.sites));
console.log(`| **median**   | **${(mt / fl.types).toFixed(1)}x** | **${(ms / fl.sites).toFixed(1)}x** |`);

if (fl.arguable) {
  const worst = fl.types + fl.arguable;
  console.log(
    `\nSensitivity: ${fl.arguable} Filelayer decision(s) are listed as arguable (see decisions.json).`,
  );
  console.log(
    `Counting all of them gives Filelayer ${worst} types, median reduction ` +
      `${(mt / worst).toFixed(1)}x on types and ${(ms / worst).toFixed(1)}x on sites.`,
  );
}

console.log(
  '\nThe two never-executed baselines (convex, vercel-blob) are recounted from their own',
);
console.log(
  'lists only. The shared adversarial suite added decisions to BOTH executed baselines that',
);
console.log(
  'their authors had missed; no such discovery is possible for these two, so their numbers',
);
console.log('are probably undercounts. That asymmetry works against Filelayer and is left in.');
