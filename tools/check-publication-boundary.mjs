#!/usr/bin/env node
/**
 * Repository hygiene: this repository is the product, and nothing else.
 *
 * It is developed inside a larger working folder that also holds material
 * belonging to the business rather than to the software. That is an ordinary
 * arrangement and it has one failure mode: `git add -A` run one directory too
 * high, or a file copied somewhere convenient and forgotten. A public push
 * cannot be recalled, so the boundary is checked by a machine rather than
 * remembered by a person.
 *
 *   node tools/check-publication-boundary.mjs
 *   node tools/check-publication-boundary.mjs --explain
 *
 * Four checks:
 *
 *   A. Paths.    No tracked path -- in HEAD or anywhere in history -- looks
 *                like a document about running a company rather than about
 *                running this software. Cheap, and matched per path SEGMENT so
 *                a copy one directory down does not escape it.
 *
 *   B. Content.  The durable one. Every tracked file is read and checked for
 *                writing that belongs to a business's own systems and not to a
 *                library's source. A file's name is not its nature: renaming
 *                defeats A completely, so A is a shortcut and B is the rule.
 *
 *   C. Ignores.  The public .gitignore is deny-by-default at the top level --
 *                it says what this repository IS, not what it is not -- and no
 *                rule doubles as a description of something absent. A rule that
 *                says what is missing is itself a disclosure. An allow-list
 *                also travels with a clone, which a locally-maintained exclude
 *                file does not, and it covers files nobody wrote a rule for.
 *
 *   D. Shipped.  Every file the npm package ships is covered by the
 *                internal-language checker, computed from the files actually on
 *                disk rather than from the directory names in `files`. Adding a
 *                file to the published surface should force a decision about
 *                scanning it.
 *
 * The vocabulary for A and B is tools/boundary-markers.json. Failures quote the
 * file, the line and the matching text, which is what a contributor needs; the
 * fix is always to rewrite the sentence so it states the engineering fact.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKERS_FILE = 'tools/boundary-markers.json';
const problems = [];
const fail = (where, msg) => problems.push({ where, msg });

const git = (args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .filter(Boolean);

const markers = JSON.parse(readFileSync(join(ROOT, MARKERS_FILE), 'utf8'));
const PATH_MARKERS = new Set(markers.paths);
const CONTENT_MARKERS = new Set(markers.content);
const compile = (list) => (list ?? []).map((p) => ({ ...p, re: new RegExp(p.pattern, p.flags || '') }));
const PROSE = compile(markers.prose); // applied to file content
const PATH_PROSE = compile(markers.pathProse); // applied to path strings
const ALLOW = markers.allow ?? [];

// The markers file is data, and data can be edited to say nothing. Neither of
// the two guards below makes that impossible -- nothing can, short of moving
// the file out of the repository -- but both turn it into a visible act rather
// than a quiet one:
//
//   * a floor on the list sizes, so emptying them fails here instead of passing
//     silently and leaving a green tick as the only evidence;
//   * every exemption must name a file, quote the text it excuses and say why,
//     so `allow` cannot become one entry that switches the check off.
const FLOOR = { paths: 15, content: 50, prose: 4 };
for (const [key, min] of Object.entries(FLOOR)) {
  const n = (markers[key] ?? []).length;
  if (n < min) {
    fail(
      MARKERS_FILE,
      `"${key}" has ${n} entries and this check requires at least ${min}. A shorter list is ` +
        `either a mistake or a way of turning the check off. If the vocabulary genuinely ` +
        `shrank, lower the floor in the same commit and say why in the message.`,
    );
  }
}
for (const [i, a] of ALLOW.entries()) {
  if (!a || !a.path || !a.contains || !a.why) {
    fail(
      MARKERS_FILE,
      `allow[${i}] must name a "path", quote the "contains" text it excuses, and give a ` +
        `"why". An exemption missing any of the three excuses everything, which is not an ` +
        `exemption.`,
    );
  }
}

// The markers file is the only file exempt from B: it is the list, and it is
// short, machine-shaped and reviewed as policy. Every other tracked file --
// including this one -- is scanned.
const EXEMPT = new Set([MARKERS_FILE]);

// -----------------------------------------------------------------------------
// Normalisation, shared by A and B so one set of digests serves both.
// Lower-case; runs of digits become '#'; anything else that is not a letter
// becomes a single space.
// -----------------------------------------------------------------------------
const norm = (s) =>
  s.toLowerCase().replace(/[0-9]+/g, '#').replace(/[^a-z#]+/g, ' ').trim().replace(/\s+/g, ' ');

const digestCache = new Map();
const digest = (s) => {
  let d = digestCache.get(s);
  if (d === undefined) {
    d = createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
    digestCache.set(s, d);
  }
  return d;
};

// -----------------------------------------------------------------------------
// A. Paths -- HEAD and history.
// -----------------------------------------------------------------------------
const pathHit = (path) => {
  for (const seg of path.split('/')) {
    const words = norm(seg.replace(/\.[a-z0-9]+$/i, '')).split(' ').filter(Boolean);
    // Prefix match: a suffix nobody predicted must not defeat the rule.
    for (let take = 1; take <= words.length; take++) {
      if (PATH_MARKERS.has(digest(words.slice(0, take).join(' ')))) return seg;
    }
  }
  for (const p of PATH_PROSE) {
    p.re.lastIndex = 0;
    const m = p.re.exec(path);
    if (m) return m[0];
  }
  return null;
};

const PATH_ADVICE =
  'names a document about the business rather than about the software. It does not ' +
  'belong in a public repository: move it out of the tree, or rename and rewrite it so ' +
  'it is about the software.';

const trackedFiles = git(['ls-files']);

for (const path of trackedFiles) {
  const hit = pathHit(path);
  if (hit) fail(path, `tracked, but "${hit}" ${PATH_ADVICE}`);
}

const everTracked = new Set(
  git(['log', '--all', '--name-only', '--pretty=format:']).map((s) => s.trim()),
);
for (const path of everTracked) {
  const hit = pathHit(path);
  if (hit) {
    fail(
      path,
      `appears in git HISTORY, and "${hit}" ${PATH_ADVICE} A push publishes every commit, ` +
        'so rewrite history before pushing; `git rm` at HEAD is not enough.',
    );
  }
}

// -----------------------------------------------------------------------------
// B. Content -- every tracked file, whatever it is called, plus every blob any
//    commit ever held. A push sends the whole history, so a file that was added
//    and then removed is still published; checking only the working tree makes
//    "delete it and commit again" a way past this.
// -----------------------------------------------------------------------------
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|mp4|wasm)$/i;
const allowed = (file, line) =>
  ALLOW.some(
    (a) =>
      (a.path === undefined || a.path === file) &&
      (a.contains === undefined || line.includes(a.contains)),
  );

// An encoded blob is the one shape that walks past a vocabulary check, because
// there is no vocabulary left to see. A single long run is caught by a pattern
// in the markers file; wrapping it at 76 columns is not a different idea, so a
// stack of base64-shaped lines counts as the same thing.
const B64_LINE = /^[A-Za-z0-9+/=]{60,}$/;
const B64_RUN = 4;

function scanText(where, file, text) {
  if (text.includes('\0')) return; // binary without a telling extension
  const lines = text.split('\n');
  let run = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (B64_LINE.test(line.trim())) {
      if (++run === B64_RUN) {
        fail(
          `${where}:${i + 2 - B64_RUN}`,
          `${B64_RUN} consecutive lines of encoded text. Text nobody can read is text nobody ` +
            `has reviewed, and an encoding is the one shape every check on this page is blind ` +
            `to. If it is data, give it a format with a schema.`,
        );
        return;
      }
    } else {
      run = 0;
    }

    if (!line.trim()) continue;
    if (allowed(file, line)) continue;
    const at = `${where}:${i + 1}`;
    const trimmed = line.trim();
    const excerpt = trimmed.length > 100 ? trimmed.slice(0, 97) + '...' : trimmed;

    let flagged = false;
    for (const p of PROSE) {
      p.re.lastIndex = 0;
      const m = p.re.exec(line);
      if (m) {
        fail(at, `"${m[0]}" is ${p.hint}\n    ${excerpt}`);
        flagged = true;
        break;
      }
    }
    if (flagged) continue;

    // Every 1-, 2- and 3-word window of the normalised line.
    const words = norm(line).split(' ').filter(Boolean);
    let hit = null;
    for (let w = 0; w < words.length && !hit; w++) {
      for (let n = 1; n <= 3 && w + n <= words.length; n++) {
        if (CONTENT_MARKERS.has(digest(words.slice(w, w + n).join(' ')))) {
          hit = words.slice(w, w + n).join(' ');
          break;
        }
      }
    }
    if (hit) {
      fail(
        at,
        `"${hit}" is vocabulary from the working folder, not from this software, and a ` +
          `reader of this file cannot resolve it. Rewrite the sentence so it states the ` +
          `engineering fact.\n    ${excerpt}`,
      );
    }
  }
}

// B1. The working tree as tracked.
const seenBlobs = new Set();
for (const file of trackedFiles) {
  if (EXEMPT.has(file) || BINARY_EXT.test(file)) continue;
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue; // staged deletion
  let text;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    continue;
  }
  scanText(file, file, text);
}

// B2. Every blob reachable from any ref. Deduplicated by object id, so a file
// that never changed is read once however many commits mention it.
for (const line of git(['rev-list', '--objects', '--all'])) {
  const sp = line.indexOf(' ');
  if (sp < 0) continue; // a commit or a tag, not a path-bearing object
  const oid = line.slice(0, sp);
  const path = line.slice(sp + 1);
  if (!path || seenBlobs.has(oid)) continue;
  seenBlobs.add(oid);
  if (EXEMPT.has(path) || BINARY_EXT.test(path)) continue;
  let type;
  try {
    type = execFileSync('git', ['cat-file', '-t', oid], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    continue;
  }
  if (type !== 'blob') continue;
  let text;
  try {
    text = execFileSync('git', ['cat-file', 'blob', oid], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    continue;
  }
  scanText(`${path} (history ${oid.slice(0, 8)})`, path, text);
}

// -----------------------------------------------------------------------------
// C. The public .gitignore.
// -----------------------------------------------------------------------------
const gitignorePath = join(ROOT, '.gitignore');
const rules = (existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '')
  .split('\n')
  .map((l) => l.split('#')[0].trim())
  .filter(Boolean);

// C1. Deny-by-default at the top level. A locally-maintained exclude file does
// not survive a clone, so the rule that matters has to be committed -- and the
// only committed form that discloses nothing is a positive list of what this
// repository owns.
if (!rules.includes('/*')) {
  fail(
    '.gitignore',
    'the top level is not deny-by-default. Add a `/*` rule and re-include each path this ' +
      'repository owns with `!`. An allow-list travels with a clone and covers files nobody ' +
      'wrote a rule for; a deny-list only ever covers the ones somebody predicted.',
  );
}

// C2. No rule may double as a description of something that is not here.
// Globs are reduced to the literal prefix the rule actually names rather than
// mangled character by character, so a rule of the form `NAME-*.md` is tested
// as the `NAME-` it matches and not as a literal that happens to miss.
for (const rule of rules) {
  const bare = rule.replace(/^!/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!bare) continue;
  const candidates = new Set([bare, bare.split(/[*?[]/)[0]]);
  for (const c of candidates) {
    if (c && pathHit(c)) {
      fail(
        '.gitignore',
        `the rule "${rule}" names something that is not here. This file is public, so a rule ` +
          `describing what is missing discloses it. Keep the top-level list positive: say what ` +
          `this repository contains.`,
      );
      break;
    }
  }
}

// -----------------------------------------------------------------------------
// D. Everything the npm package ships must be language-scanned.
// -----------------------------------------------------------------------------
const corePkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
const langCfg = JSON.parse(readFileSync(join(ROOT, '.internal-language.json'), 'utf8'));

// The same small glob dialect the language checker uses: `**/` any depth, `*`
// one segment, literal otherwise. Re-implemented deliberately -- this check
// must not be able to agree with a broken checker.
const globToRegExp = (glob) => {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '.') out += '\\.';
    else if ('+?^${}()|[]\\'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp(out + '$');
};
const includeRes = langCfg.include.map(globToRegExp);
const scanned = (repoRelPath) => includeRes.some((re) => re.test(repoRelPath));

// Files that ship but carry no prose of ours a reader could be misled by.
//
// LICENSE is the deliberate case. It is the verbatim Apache License 2.0 and it
// must stay byte-identical to the canonical text, so it is not ours to edit and
// a vocabulary check over it would at best do nothing and at worst invite an
// edit that breaks the identity we advertise. It is verified by comparison
// against apache.org instead, which is the right check for a file whose
// requirement is "unchanged" rather than "clean".
const NO_PROSE = new Set([
  'dist', // compiled output; its sources are scanned
  'tsconfig.json',
  'tsconfig.build.json',
  'LICENSE',
]);

// Expand `files` to actual files on disk. A directory declared covered by a
// glob is not the same as every file inside it being covered: one unexpected
// extension is enough to ship something unscanned.
const expand = (entry) => {
  const abs = join(ROOT, 'packages/core', entry);
  if (!existsSync(abs)) return [];
  if (!statSync(abs).isDirectory()) return [entry];
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      const childRel = `${rel}/${name}`;
      if (statSync(child).isDirectory()) walk(child, childRel);
      else out.push(childRel);
    }
  };
  walk(abs, entry);
  return out;
};

for (const entry of corePkg.files ?? []) {
  if (NO_PROSE.has(entry)) continue;
  for (const shipped of expand(entry)) {
    if (NO_PROSE.has(shipped)) continue;
    // A file may be scanned at its canonical repository path -- prepack copies
    // README and NOTICE in from the root -- or at its path inside the package.
    if (scanned(shipped) || scanned(`packages/core/${shipped}`)) continue;
    fail(
      '.internal-language.json',
      `packages/core ships "${shipped}", and no include glob covers it. Anything that ships is ` +
        `read by strangers: add a glob to include, or add the file to NO_PROSE in this tool if ` +
        `it genuinely carries no prose.`,
    );
  }
}

// -----------------------------------------------------------------------------
if (process.argv.includes('--explain')) {
  console.log(
    [
      'check-publication-boundary',
      '',
      '  A  no tracked path, now or in history, names a document about the business',
      '  B  no tracked file CONTAINS that kind of writing, whatever it is called',
      '  C  .gitignore is a top-level allow-list, and no rule describes something absent',
      '  D  every file the npm package ships is covered by the internal-language checker',
      '',
      `A and B share one vocabulary, in ${MARKERS_FILE}. Failures quote the offending line:`,
      'the fix is always to rewrite it so it describes the software.',
      '',
      'B is the check that generalises. A is a fast path over names, and a name can be',
      'changed; the writing inside the file cannot be changed without changing what it says.',
    ].join('\n'),
  );
}

if (problems.length) {
  console.error('check-publication-boundary: FAILED\n');
  for (const p of problems) console.error(`  ${p.where}\n    ${p.msg}\n`);
  console.error(
    `${problems.length} problem(s). This repository is the product; everything else stays ` +
      `where it belongs.`,
  );
  process.exit(1);
}

console.log(
  `check-publication-boundary: clean. ${trackedFiles.length} tracked file(s) checked by path ` +
    `and by content; .gitignore is a top-level allow-list; every shipped file is language-scanned.`,
);
