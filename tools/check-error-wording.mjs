#!/usr/bin/env node
/**
 * Fail the build if a shipped document presents a denial REASON as an error
 * CODE, or gives an error code the wrong HTTP status.
 *
 *   node tools/check-error-wording.mjs              # check, exit 1 on a hit
 *   node tools/check-error-wording.mjs --self-test  # known inputs, known verdicts
 *
 * A FilelayerError carries a status, a code and, for denials, a reason. The
 * code is what the caller gets (`not_found`, `forbidden`); the reason
 * (`insufficient_role`, `unknown_org`) is recorded in the audit log and, for
 * the few refusals that are not 404, carried on the error. Writing
 * "404 insufficient_role" tells an integrator to branch on a code that the API
 * never sends. llms.txt said exactly that until November 2026.
 *
 * The rule: wherever an HTTP status is followed directly by an identifier,
 * that identifier must be an error code from packages/core/src/errors.ts with
 * that status. A denial reason from packages/core/src/authz.ts in that place
 * fails. Anything else after a status ("404 page", "403 Forbidden") is prose
 * and is left alone. The lists are read from the source, so a new code or
 * reason is covered without editing this file.
 *
 * The files scanned are the shipped surface as tools/check-internal-language.mjs
 * enumerates it, so the two gates cannot disagree about what is published.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function errorCodes(src) {
  const block = src.slice(src.indexOf('export const ERROR_CODES = {'));
  const codes = new Map();
  for (const m of block.matchAll(/^ {2}([a-z][a-z0-9_]*): \{\s*\n\s*status: (\d{3}),/gm)) codes.set(m[1], Number(m[2]));
  if (codes.size < 10) throw new Error(`check-error-wording: read only ${codes.size} error codes from errors.ts; the parser no longer matches the file.`);
  return codes;
}

function denyReasons(src) {
  const i = src.indexOf('export type DenyReason =');
  if (i < 0) throw new Error('check-error-wording: DenyReason not found in authz.ts.');
  const block = src.slice(i, src.indexOf(';', i));
  const reasons = new Set([...block.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]));
  if (reasons.size < 10) throw new Error(`check-error-wording: read only ${reasons.size} deny reasons from authz.ts.`);
  // unknown_org and unknown_actor are recorded reasons that are not part of
  // the DenyReason union; they are written where the denial is recorded.
  for (const extra of ['unknown_org', 'unknown_actor']) reasons.add(extra);
  return reasons;
}

// Markup and emphasis between the status and the identifier do not change what
// the sentence says, so they are removed before matching: `404 <code>x</code>`,
// "404 `x`" and "**404 `x`**" are all "404 x".
function plain(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[`*]/g, '');
}

// The code to suggest for a status: the one a denial at that status uses.
const codeFor = (status) => ({ 404: 'not_found', 403: 'forbidden', 410: 'gone', 409: 'retention_hold', 401: 'password_required' })[status] ?? '<the code errors.ts gives that status>';

export function findProblems(file, text, codes, reasons) {
  const out = [];
  const lines = text.split('\n');
  lines.forEach((raw, n) => {
    const line = plain(raw);
    for (const m of line.matchAll(/\b([1-5]\d\d)\s+([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b/g)) {
      const status = Number(m[1]);
      const id = m[2];
      if (codes.has(id)) {
        if (codes.get(id) !== status) {
          out.push(`${file}:${n + 1}: "${m[0]}" gives ${id} the status ${status}; errors.ts says ${codes.get(id)}.`);
        }
      } else if (reasons.has(id)) {
        out.push(`${file}:${n + 1}: "${m[0]}" presents the denial reason ${id} as an error code. Write the code, then the reason: "${status} ${codeFor(status)}, with reason ${id}".`);
      }
    }
  });
  return out;
}

const codes = errorCodes(read('packages/core/src/errors.ts'));
const reasons = denyReasons(read('packages/core/src/authz.ts'));

if (process.argv.includes('--self-test')) {
  const cases = [
    ['404 `insufficient_role`', false],
    ['gets `404 insufficient_role`, the same answer', false],
    ['**403 `no_membership`**', false],
    ['404 <code>unknown_org</code>', false],
    ['403 `not_found`', false],
    ['409 forbidden', false],
    ['404 `not_found`, with reason `insufficient_role`', true],
    ['**403 `forbidden`, with reason `no_membership`**', true],
    ['409 `retention_hold`', true],
    ['a 404 page', true],
    ['403 Forbidden', true],
    ['returns 404 for anything', true],
  ];
  let bad = 0;
  for (const [text, ok] of cases) {
    const clean = findProblems('case', text, codes, reasons).length === 0;
    if (clean !== ok) { bad++; console.error(`  self-test FAILED: ${JSON.stringify(text)} was ${clean ? 'accepted' : 'refused'}`); }
  }
  if (bad) process.exit(1);
  console.log(`check-error-wording --self-test: ${cases.length} cases; a reason in a code's place and a code with the wrong status are refused, codes and prose pass.`);
  process.exit(0);
}

const list = spawnSync(process.execPath, [join(ROOT, 'tools/check-internal-language.mjs'), '--list'], { encoding: 'utf8' });
if (list.status !== 0) {
  console.error(list.stdout + list.stderr);
  console.error('check-error-wording: could not list the shipped surface.');
  process.exit(1);
}
// Documentation only: prose an integrator or an agent reads to decide what to
// branch on. Source comments and tests belong to the library's own review, and
// CHANGELOG.md is a record of what each release said, so neither is rewritten
// from here. Both are left to their owners, not silently passed: see the note
// printed below.
const isDoc = (f) => /\.(md|txt|html)$/.test(f) && !/(^|\/)CHANGELOG\.md$/.test(f);
const files = list.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.includes(' ') && isDoc(l));
if (files.length < 20) {
  console.error(`check-error-wording: the shipped surface listed only ${files.length} files; refusing to report clean.`);
  process.exit(1);
}
const problems = files.flatMap((f) => findProblems(f, read(f), codes, reasons));
if (problems.length) {
  console.error(`check-error-wording: FAILED\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-error-wording: clean. ${files.length} shipped document(s), source, tests and CHANGELOG.md excepted; every status followed by an identifier names an error code with that status (${codes.size} codes, ${reasons.size} reasons read from the source).`);
