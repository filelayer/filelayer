#!/usr/bin/env node
//
// LOC per tier, using EXACTLY the counting rules in count-loc.mjs:
//
//   GROSS = every line.  NET = lines that are neither blank nor comment-only.
//   "Comment-only" = the trimmed line starts with a line comment, a block
//   comment opener, or a continuation asterisk. Identical predicate, copied
//   verbatim, so the two counters cannot drift.
//
// The only difference from count-loc.mjs is that this takes explicit FILES
// rather than walking a baseline directory, because a tier is a file, not a
// project.
//
// It also reports CORE lines: net minus imports minus the `if (import.meta.url
// === ...)` boot block. That is what a developer pastes into an app they
// already have. It is reported SEPARATELY, never instead of net, because
// "excluding boilerplate" is precisely the move that makes a benchmark
// dishonest -- the reader gets both numbers and can pick.
//
// Usage: node benchmark/count-tiers.mjs   (from the repo root)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Paths are resolved against the repo root, not the cwd, so this gives the same
// answer from `npm run loc:tiers` inside packages/core and from the root.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (p) => path.join(ROOT, p);

const isCommentOnly = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t === '*' + '/';
};

function count(abs) {
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const gross = lines.length;
  const real = lines.filter((l) => l.trim() !== '' && !isCommentOnly(l));
  const net = real.length;
  const imports = real.filter((l) => /^\s*import\b/.test(l)).length;
  let boot = 0;
  let inBoot = false;
  for (const l of lines) {
    if (/if \(import\.meta\.url/.test(l)) inBoot = true;
    if (inBoot && l.trim() !== '' && !isCommentOnly(l)) boot++;
  }
  return { gross, net, imports, boot, core: net - imports - boot };
}

const TIERS = [
  ['tier 1  public avatar        ', 'examples/tier1-avatar/app.ts'],
  ['tier 2  user-owned private   ', 'examples/tier2-user-files/app.ts'],
  ['tier 3  orgs + roles         ', 'examples/tier3-org-roles/app.ts'],
  ['tier 4  full vault, over HTTP', 'examples/vault/server.ts'],
];

console.log('tier                            gross    net  imports   boot   core');
console.log('-'.repeat(68));
for (const [label, file] of TIERS) {
  const c = count(at(file));
  console.log(
    `${label} ${String(c.gross).padStart(6)} ${String(c.net).padStart(6)} ` +
      `${String(c.imports).padStart(8)} ${String(c.boot).padStart(6)} ${String(c.core).padStart(6)}`,
  );
}
console.log();
console.log('core = net - imports - the `if (import.meta.url ...)` demo boot block.');
