#!/usr/bin/env node
/**
 * GATE 13 — REGISTER DENSITY ON THE PUBLIC SURFACES
 *
 * WHY THIS EXISTS. On 3 October 2026 we measured the homepage and found one em
 * dash every 67 words of prose, and ten "X rather than Y" / "X, not Y" mirror
 * constructions in 1,613 words. Human technical prose runs roughly one em dash
 * every 400 to 800 words. We were six to ten times over.
 *
 * That matters here more than it would elsewhere. The entire positioning of this
 * project is that it was written by the people who built it, and a developer who
 * reads a page and thinks "a model wrote this" discards the page AND the claim.
 * The cost is not a worse conversion rate. It is a reader who stops believing the
 * numbers, which are the only thing we have.
 *
 * WHAT THIS DOES NOT DO. It does not ban the constructions. Some of them are the
 * clearest way to say the thing, and three of them on the homepage are
 * load-bearing:
 *
 *     "Public is a grant rather than a bucket setting"
 *     "A typo in a user id denies rather than quietly becoming an anonymous read"
 *     "It is authorization middleware, not row-level security"
 *
 * Each of those draws a line that the sentence exists to draw. Deleting them to
 * satisfy a linter would make the documentation worse and the gate pointless. So
 * this measures DENSITY, not presence, and the thresholds are set where the
 * rhythm starts to be audible rather than where the figure first appears.
 *
 * WHAT IT MEASURES. Prose only. Code blocks, inline code, HTML tags, link URLs
 * and table rows are stripped first, because a dash in `| Version | 0.7.0 — alpha |`
 * is a column separator and a dash in a `- [Doc](url) — gloss` list is a
 * convention, and neither is anybody's writing voice.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Thresholds are WORDS PER OCCURRENCE, so higher is better and a failure reads
 * as "one every N words, and the floor is M".
 *
 * The homepage is held tightest: it is the shortest, the most read, and the one
 * a sceptic meets first. SEMANTICS.md is a reference document read by people who
 * have already decided, so it gets more room, and it is on the list mainly to
 * stop it drifting further.
 */
const SURFACES = [
  { file: 'web/index.html', minWordsPerDash: 120, minWordsPerMirror: 180 },
  { file: 'README.md', minWordsPerDash: 110, minWordsPerMirror: 160 },
  { file: 'packages/core/README.md', minWordsPerDash: 110, minWordsPerMirror: 160 },
  { file: 'TRUST.md', minWordsPerDash: 100, minWordsPerMirror: 150 },
  { file: 'llms.txt', minWordsPerDash: 100, minWordsPerMirror: 120 },
  { file: 'packages/core/SEMANTICS.md', minWordsPerDash: 80, minWordsPerMirror: 140 },
];

/** The mirror constructions, i.e. negating one thing to assert its opposite. */
const MIRRORS = [
  /\brather than\b/gi,
  /,\s+not\s+(?:a|an|the|by|from|because|at|to|in)\b/gi,
  /\bnot\s+\w+(?:\s+\w+){0,4}\s+but\s+\b/gi,
  /\bis what makes\b/gi,
  /\bwhich is (?:why|the point|the whole point)\b/gi,
  /\band that is (?:not\s+)?(?:laxity|deliberate|the point)\b/gi,
];

/** Everything that is structure rather than voice. */
function prose(raw, file) {
  let t = raw;
  if (file.endsWith('.html')) {
    t = t.replace(/<!--[\s\S]*?-->/g, ' ');
    t = t.replace(/<(script|style|pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    t = t.replace(/<[^>]+>/g, ' ');
    t = t.replace(/&mdash;/g, '—');
  } else {
    t = t.replace(/```[\s\S]*?```/g, ' ');
    t = t.replace(/`[^`\n]*`/g, ' ');
  }
  // Table rows: the dash is a column, not a clause.
  t = t
    .split('\n')
    .filter((l) => !l.trim().startsWith('|'))
    // `- [Title](url) — one line gloss` is a README convention, not prose rhythm.
    .map((l) => (/^\s*[-*]\s*\[/.test(l) ? l.replace(/—/g, ' ') : l))
    .join('\n');
  // Markdown headings carry titles, not sentences.
  t = t.replace(/^#{1,6}\s.*$/gm, ' ');
  t = t.replace(/\]\([^)]*\)/g, ' ');
  t = t.replace(/https?:\/\/\S+/g, ' ');
  return t;
}

let failures = 0;
const rows = [];

for (const s of SURFACES) {
  let raw;
  try {
    raw = readFileSync(join(ROOT, s.file), 'utf8');
  } catch {
    console.error(`check-register: cannot read ${s.file}`);
    failures++;
    continue;
  }
  const t = prose(raw, s.file);
  const words = t.split(/\s+/).filter(Boolean).length;
  const dashes = (t.match(/—/g) ?? []).length;
  const mirrors = MIRRORS.reduce((n, re) => n + (t.match(re) ?? []).length, 0);

  const perDash = dashes === 0 ? Infinity : Math.floor(words / dashes);
  const perMirror = mirrors === 0 ? Infinity : Math.floor(words / mirrors);

  const bad = [];
  if (perDash < s.minWordsPerDash) {
    bad.push(`one em dash every ${perDash} words (floor ${s.minWordsPerDash}, ${dashes} in ${words})`);
  }
  if (perMirror < s.minWordsPerMirror) {
    bad.push(
      `one mirror construction every ${perMirror} words (floor ${s.minWordsPerMirror}, ${mirrors} in ${words})`,
    );
  }
  rows.push({ file: s.file, words, dashes, mirrors, perDash, perMirror, bad });
  if (bad.length) failures++;
}

const fmt = (n) => (n === Infinity ? '—' : String(n));
const w = Math.max(...rows.map((r) => r.file.length));
console.log(
  `${'surface'.padEnd(w)}  ${'words'.padStart(6)} ${'dashes'.padStart(7)} ${'per'.padStart(5)} ${'mirrors'.padStart(8)} ${'per'.padStart(5)}`,
);
for (const r of rows) {
  console.log(
    `${r.file.padEnd(w)}  ${String(r.words).padStart(6)} ${String(r.dashes).padStart(7)} ${fmt(r.perDash).padStart(5)} ${String(r.mirrors).padStart(8)} ${fmt(r.perMirror).padStart(5)}`,
  );
}

if (failures) {
  console.error('\ncheck-register: FAILED\n');
  for (const r of rows.filter((x) => x.bad.length)) {
    console.error(`  ${r.file}`);
    for (const b of r.bad) console.error(`    - ${b}`);
  }
  console.error(
    '\n  Thin them out; do not delete them all. A construction that draws a real\n' +
      '  distinction should stay. One that is only there for rhythm should go, and\n' +
      '  the test is whether the sentence still says the same thing without it.\n',
  );
  process.exit(1);
}

console.log('\ncheck-register: clean.');
