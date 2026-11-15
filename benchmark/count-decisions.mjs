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
console.log(`| median, all four (two never executed or compiled) | ${(mt / fl.types).toFixed(1)}x | ${(ms / fl.sites).toFixed(1)}x |`);
// The headline median is over the alternatives that run (loc.manifest.json
// marks the other two `executed: false`): a number built on code nobody has
// compiled is not one to lead with.
const NOT_EXECUTED = new Set(['vercel-blob', 'convex']);
const ran = others.filter((r) => !NOT_EXECUTED.has(r.name));
const et = median(ran.map((r) => r.types));
const es = median(ran.map((r) => r.sites));
// One word for the calculation, the one the pages use: over two values the
// median is their average.
const averageWord = (n) => (n === 2 ? 'average' : 'median');
console.log(`| ${averageWord(ran.length)}, the ${ran.length} executed | ${(et / fl.types).toFixed(1)}x | ${(es / fl.sites).toFixed(1)}x |`);
// SENSITIVITY: WITHOUT THE AUDIT CHAIN. Whether the brief asked for a
// tamper-evident chain is not known (BRIEF.md), and every alternative built
// one. These are the medians with the decisions that exist only because of the
// chain left out (`auditChain: true` in decisions.json).
{
  const noChain = (name) => {
    const ds = DATA[name].decisions.filter((d) => !d.auditChain);
    return { types: ds.length, sites: ds.reduce((n, d) => n + d.sites, 0) };
  };
  const f = noChain('filelayer');
  const alt = ran.map((r) => noChain(r.name));
  const t = median(alt.map((a) => a.types));
  const si = median(alt.map((a) => a.sites));
  console.log(
    `\nWithout the audit chain (sensitivity): Filelayer ${f.types} types / ${f.sites} sites; ` +
      `${averageWord(alt.length)} of the ${alt.length} executed, ${(t / f.types).toFixed(1)}x on types and ${(si / f.sites).toFixed(1)}x on sites.`,
  );
}
// SENSITIVITY: SUPABASE #9 AS ONE SITE. One decision (each policy written FOR
// the right command) is 19 of Supabase's sites, one per CREATE POLICY. Whether
// that is nineteen places to get it right or one habit is the most contestable
// slicing in the table (cold review of 2026-11-15), so here it is counted once.
{
  const sup = DATA['supabase'].decisions;
  const nine = sup.find((d) => d.id === 9);
  if (nine) {
    const sites = (r) => (r.name === 'supabase' ? r.sites - nine.sites + 1 : r.sites);
    const s1 = median(ran.map(sites));
    console.log(
      `\nSupabase #9 counted as one site (sensitivity): Supabase ${sup.length} types / ` +
        `${sup.reduce((n, d) => n + d.sites, 0) - nine.sites + 1} sites; ` +
        `${averageWord(ran.length)} of the ${ran.length} executed, ${(s1 / fl.sites).toFixed(1)}x on sites (types unchanged).`,
    );
  }
}

console.log(
  '\nOne rule for all five (decisions.json $convention.oneRule): a decision enforced in one helper\n' +
    'is one site, and a decision the platform\'s linter flags, or whose safe setting is the platform\n' +
    'default, is dropped. The headline is the average of the executed alternatives.',
);

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
