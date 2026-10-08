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

import { execFileSync } from 'node:child_process';
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
// Coverage. The include list above is an enumeration, so a new public document
// is unscanned by default and nothing says so -- which is how `skills/` and
// `AGENTS.md` shipped unscanned. Every git-tracked .md must therefore match
// either `include` or `notScanned`, and a document that matches neither fails
// the build until somebody decides which it is and writes the reason down.
// -----------------------------------------------------------------------------
const notScanned = config.notScanned ?? [];
const notScannedRes = notScanned.map((e) => ({ ...e, re: globToRegExp(e.glob) }));

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
} catch {
  console.error(
    'check-internal-language: could not list tracked files with git. The coverage\n' +
      'assertion needs it, and passing without it would report a completeness it\n' +
      'did not check.',
  );
  process.exit(2);
}

const uncovered = tracked.filter(
  (rel) =>
    !includeRes.some((re) => re.test(rel)) && !notScannedRes.some((e) => e.re.test(rel)),
);

if (uncovered.length > 0) {
  console.error(
    `check-internal-language: ${uncovered.length} tracked document(s) are neither\n` +
      'scanned nor declared out of scope:\n',
  );
  for (const rel of uncovered) console.error(`  ${rel}`);
  console.error(
    '\nAdd each one to `include` in .internal-language.json if an adopter reads it,\n' +
      'or to `notScanned` with a reason if it is written for us. There is no default.',
  );
  process.exit(1);
}

const deadGlobs = notScannedRes.filter((e) => !tracked.some((rel) => e.re.test(rel)));
if (deadGlobs.length > 0) {
  console.error(
    'check-internal-language: these `notScanned` entries match nothing, so they are\n' +
      'an exemption for a file that no longer exists:\n',
  );
  for (const e of deadGlobs) console.error(`  ${e.glob}`);
  process.exit(1);
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
