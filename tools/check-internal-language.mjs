#!/usr/bin/env node
/**
 * Fail the build if the published surface stops describing the software.
 *
 *   node tools/check-internal-language.mjs            # check, exit 1 on a hit
 *   node tools/check-internal-language.mjs --list     # list the files scanned
 *
 * The policy lives in `.internal-language.json` at the repository root and is
 * meant to be edited. This file is the mechanism and should rarely change.
 *
 * Why it exists: shipped source and shipped documentation are read by people
 * (and agents) deciding whether to depend on this library. A word that only
 * resolves for someone who was in the room is noise to them, and the regression
 * is silent -- a comment written in the wrong register looks fine to the person
 * writing it -- so it needs a check rather than a convention.
 *
 * Scope note: this checker reads the published surface. Whether a file belongs
 * in the repository at all is tools/check-publication-boundary.mjs.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CONFIG_PATH = join(ROOT, '.internal-language.json');

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

// -----------------------------------------------------------------------------
// A deliberately small glob: `**` (any depth), `*` (one segment), literal else.
// Enough for the include list and small enough to be obviously correct.
// -----------------------------------------------------------------------------
function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more path segments.
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '.') out += '\\.';
    else if ('+?^${}()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$');
}

const includeRes = config.include.map(globToRegExp);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '__pycache__']);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs, acc);
    else acc.push(abs);
  }
  return acc;
}

const files = walk(ROOT)
  .map((abs) => relative(ROOT, abs).split(sep).join('/'))
  .filter((rel) => includeRes.some((re) => re.test(rel)))
  .sort();

if (process.argv.includes('--list')) {
  for (const f of files) console.log(f);
  console.log(`\n${files.length} file(s) in the shipped surface.`);
  process.exit(0);
}

if (files.length === 0) {
  console.error(
    'check-internal-language: the include globs matched no files. That is almost\n' +
      'certainly a broken config rather than a clean repository. Refusing to pass.',
  );
  process.exit(2);
}

// -----------------------------------------------------------------------------
// Scan.
// -----------------------------------------------------------------------------
const terms = config.terms.map((t) => ({
  ...t,
  re: new RegExp(t.pattern, 'g'),
  allowRe: t.allowIfLineMatches ? new RegExp(t.allowIfLineMatches) : null,
}));

const exceptions = config.exceptions ?? [];
function isExcepted(file, termId, line) {
  return exceptions.some(
    (e) =>
      e.file === file &&
      (e.term === undefined || e.term === termId) &&
      (e.lineContains === undefined || line.includes(e.lineContains)),
  );
}

const hits = [];
for (const rel of files) {
  const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const term of terms) {
      term.re.lastIndex = 0;
      const m = term.re.exec(line);
      if (!m) continue;
      if (term.allowRe?.test(line)) continue;
      if (isExcepted(rel, term.id, line)) continue;
      hits.push({ file: rel, line: i + 1, term, matched: m[0], text: line.trim() });
    }
  });
}

if (hits.length === 0) {
  console.log(
    `check-internal-language: clean. ${files.length} shipped file(s), ` +
      `${terms.length} forbidden term(s).`,
  );
  process.exit(0);
}

console.error('\ncheck-internal-language: FAILED\n');
console.error(
  'A published file says something other than what the software does. Rewrite the\n' +
    'text so it states the technical fact, or -- if this really is a false positive --\n' +
    'add a justified entry to `exceptions` in .internal-language.json.\n',
);

const byTerm = new Map();
for (const h of hits) {
  if (!byTerm.has(h.term.id)) byTerm.set(h.term.id, []);
  byTerm.get(h.term.id).push(h);
}
for (const [id, list] of byTerm) {
  const term = list[0].term;
  console.error(`  ${id}  (/${term.pattern}/)`);
  console.error(`  ${'-'.repeat(id.length + term.pattern.length + 6)}`);
  console.error(`  ${term.reason}\n`);
  for (const h of list) {
    const text = h.text.length > 96 ? h.text.slice(0, 93) + '...' : h.text;
    console.error(`    ${h.file}:${h.line}  [${h.matched}]`);
    console.error(`      ${text}`);
  }
  console.error('');
}
console.error(`${hits.length} violation(s) across ${new Set(hits.map((h) => h.file)).size} file(s).\n`);
process.exit(1);
