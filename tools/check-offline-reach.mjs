#!/usr/bin/env node
/**
 * EVERY FILE THE DOCUMENTATION TELLS A READER TO OPEN MUST BE IN THE TARBALL.
 *
 * WHY THIS EXISTS. On 3 October 2026 an agent was asked to integrate the
 * published package from npm, reading only what a stranger can read. `llms.txt`
 * sends a newcomer to three documents under "Start here" and says, two lines
 * earlier, that if you are reading this out of an install you have no need of a
 * browser because the same files are on disk.
 *
 * QUICKSTART was the one of the three not in the tarball. It is also the only
 * one that takes a reader from install to first stored byte. An agent with no
 * network had nowhere to go, and the one with network paid for a round trip to
 * GitHub to read a file it already had an install of.
 *
 * Nothing was false. `llms.txt` enumerated the files that were on disk and
 * QUICKSTART was simply not among them, so every surface was individually
 * accurate while the set of them pointed somewhere that did not exist. That is
 * the failure mode a per-file check cannot see, and it is why this one asks a
 * question about the SET: of the files we name as reachable, which are actually
 * shipped?
 *
 * WHAT IT CHECKS, three things, none of them a style opinion:
 *
 *   1. Every path named in ANCHORS below resolves inside `packages/core`, is
 *      NOT EMPTY, and is covered by `files` in its package.json, so `npm pack`
 *      carries it.
 *   2. Every path `llms.txt` claims is "on disk under node_modules" is shipped,
 *      AND the sentence still names at least the documents a newcomer is sent
 *      to. This is the sentence that burned us, read back as an assertion.
 *   3. `npm pack --dry-run` AGREES, and the tarball entries have bytes in them.
 *      The `files` list is a declaration; this is the only step that asks npm
 *      what it would actually publish, which is the difference between
 *      believing and knowing.
 *
 * TWO WAYS THIS CHECK USED TO BE DEFEATABLE, both found by an adversarial sweep
 * on 3 October 2026 and both fixed below. They are worth stating because the
 * failure mode of a gate is silence.
 *
 *   - IT ONLY ASKED `existsSync`. A zero-byte README.md passed every step,
 *     including `npm pack`, so "the reader can open it" was true and useless.
 *     There are size floors now, and they are per-anchor rather than global,
 *     because a 40-byte `NOTICE` is fine and a 40-byte QUICKSTART is not.
 *   - CHECK 2 COULD BE MADE TO VERIFY NOTHING. The regex captures the sentence
 *     and then reads the backticked names out of it, skipping the literal
 *     `this file`. A rewording that kept the anchor phrase but put the file
 *     list in plain text left exactly one backticked name -- `this file` -- so
 *     the loop ran zero times and the gate reported clean. It was reproduced on
 *     the real defect it was written for. The floor and the required-names set
 *     below are what close it: the sentence has to still NAME the documents, in
 *     code spans, or this check fails and says which one is missing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = 'packages/core';

/**
 * Paths a reader is told to open, by a document they are reading offline.
 *
 * Add to this list when a document starts pointing somewhere new. The cost of
 * forgetting is the defect above: a reader sent to a file that is not there.
 */
const ANCHORS = [
  { path: 'README.md', min: 4000, why: 'the first thing a stranger reads' },
  { path: 'docs/QUICKSTART.md', min: 8000, why: 'install to first stored byte; the one that was missing' },
  { path: 'docs/guides/expiring-and-revocable-file-links.md', min: 6000, why: 'the first guide, named by llms.txt' },
  { path: 'docs/guides/private-file-uploads.md', min: 6000, why: 'the second guide, named by llms.txt' },
  { path: 'docs/guides/multi-tenant-file-access.md', min: 6000, why: 'the third guide, named by llms.txt' },
  { path: 'SEMANTICS.md', min: 8000, why: 'the reference for every edge case' },
  { path: 'MIGRATIONS.md', min: 2000, why: 'what a schema change costs, linked from QUICKSTART' },
  { path: 'CHANGELOG.md', min: 2000, why: 'what changed and which versions are unsafe' },
  { path: 'llms.txt', min: 4000, why: 'the orientation file this check is largely about' },
  { path: 'openapi.json', min: 2000, why: 'the HTTP surface, for a reader with no browser' },
  { path: 'schema.sql', min: 10_000, why: 'the properties are commented at the constraints that enforce them' },
  { path: 'src/storage.ts', min: 4000, why: 'QUICKSTART points here for the StorageAdapter interface' },
  // 150, not the 500 the rest of the source files get: this is a barrel of
  // seven `export * from` lines and that IS the whole file. A floor that fails
  // on an honest file teaches people to raise floors.
  { path: 'src/index.ts', min: 150, why: 'llms.txt points here for the export list' },
  { path: 'examples/tier1-avatar/app.ts', min: 500, why: 'a runnable example the docs cite' },
  { path: 'examples/tier2-user-files/app.ts', min: 500, why: 'a runnable example the docs cite' },
  { path: 'examples/tier3-org-roles/app.ts', min: 500, why: 'a runnable example the docs cite' },
  { path: 'examples/vault/server.ts', min: 2000, why: 'the full HTTP example the docs cite' },
  { path: 'examples/starter/server.ts', min: 4000, why: 'the deployable example, the one a newcomer copies' },
  { path: 'examples/starter/README.md', min: 1000, why: 'how to run the deployable example' },
];

/**
 * Names the on-disk sentence in llms.txt MUST still contain, in a code span.
 *
 * This is the floor that stops check 2 from being reworded into a no-op. Every
 * one of these is a document a newcomer is actually sent to, so a sentence that
 * stops naming one of them is either wrong or has stopped making the promise
 * this file verifies -- and either way a human should look at it.
 */
const REQUIRED_IN_SENTENCE = [
  'README.md',
  'docs/QUICKSTART.md',
  'SEMANTICS.md',
  'openapi.json',
  'schema.sql',
];
const MIN_NAMED = 8;

const pkgJson = JSON.parse(readFileSync(join(ROOT, PKG, 'package.json'), 'utf8'));
const fileEntries = pkgJson.files ?? [];

/** npm ships a directory entry whole, so a prefix match is the right question. */
const declared = (rel) =>
  fileEntries.some((e) => rel === e || rel.startsWith(`${e.replace(/\/+$/, '')}/`));

const problems = [];
const fail = (where, msg) => problems.push({ where, msg });

// --- 1. the anchors exist and are declared ----------------------------------
for (const { path, min, why } of ANCHORS) {
  if (!existsSync(join(ROOT, PKG, path))) {
    fail(`${PKG}/${path}`, `does not exist, and the documentation sends a reader to it (${why}).`);
    continue;
  }
  const size = statSync(join(ROOT, PKG, path)).size;
  if (size < min) {
    fail(
      `${PKG}/${path}`,
      `is ${size} bytes, under its floor of ${min}. A file a reader can open and ` +
        `learn nothing from is the same defect as one that is not there (${why}).`,
    );
  }
  if (!declared(path)) {
    fail(
      `${PKG}/package.json`,
      `"files" does not cover "${path}", so an install will not have it (${why}).`,
    );
  }
}

// --- 2. the sentence in llms.txt, read back as an assertion -----------------
const llms = readFileSync(join(ROOT, PKG, 'llms.txt'), 'utf8');
// Up to the end of the SENTENCE, which is a period followed by a space and a
// capital. A naive `[^.]*` stops at the first dot, and the very first file it
// names is `README.md`, so the capture came back empty and the check passed by
// promising nothing. Caught by its own first run.
const onDisk = /the same files are on disk under `node_modules\/@filelayer\/core\/`(.*?)\.\s+[A-Z]/s.exec(
  llms,
);
if (!onDisk) {
  fail(
    `${PKG}/llms.txt`,
    'the "same files are on disk" sentence is gone or reworded. It is the claim this check ' +
      'verifies, so either restore the wording or update the pattern here in the same commit.',
  );
} else {
  const named = [...onDisk[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const real = named.filter((n) => n !== 'this file');
  if (real.length < MIN_NAMED) {
    fail(
      `${PKG}/llms.txt`,
      `the on-disk sentence names ${real.length} file(s) in code spans, and the floor is ` +
        `${MIN_NAMED}. A sentence that keeps the phrase but moves the list into plain prose ` +
        'leaves this check nothing to verify, which is how it reported clean on the very ' +
        'defect it was written for.',
    );
  }
  for (const want of REQUIRED_IN_SENTENCE) {
    if (!real.includes(want) && !real.includes(`${want}/`)) {
      fail(
        `${PKG}/llms.txt`,
        `the on-disk sentence no longer names \`${want}\` in a code span. It is a document a ` +
          'newcomer is sent to, so either put it back or decide deliberately that the promise ' +
          'has changed and update REQUIRED_IN_SENTENCE in this file.',
      );
    }
  }
  for (const n of named) {
    if (n === 'this file') continue;
    const rel = n.replace(/\/$/, '');
    if (!existsSync(join(ROOT, PKG, rel))) {
      fail(`${PKG}/llms.txt`, `claims \`${n}\` is on disk after an install, and it is not here.`);
    } else if (!declared(rel)) {
      fail(`${PKG}/llms.txt`, `claims \`${n}\` is on disk, but "files" does not publish it.`);
    }
  }
}

// --- 3. what npm would ACTUALLY publish -------------------------------------
// The step that turns a declaration into a fact. `files` can be right and a
// stray .npmignore still drop something.
let packed;
try {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: join(ROOT, PKG),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const entries = JSON.parse(out)[0].files;
  packed = new Map(entries.map((f) => [f.path, f.size]));
} catch (e) {
  fail(`${PKG}`, `npm pack --dry-run failed, so this check could not verify anything: ${e.message}`);
}

if (packed) {
  for (const { path, min, why } of ANCHORS) {
    if (!packed.has(path)) {
      fail(
        `${PKG}/${path}`,
        `is NOT in the tarball npm would publish, whatever "files" says (${why}).`,
      );
      continue;
    }
    // npm reports the size of what it would ship, which is the only number
    // that describes what the reader actually receives.
    const shipped = packed.get(path);
    if (typeof shipped === 'number' && shipped < min) {
      fail(
        `${PKG}/${path}`,
        `ships as ${shipped} bytes, under its floor of ${min} (${why}).`,
      );
    }
  }
}

if (problems.length) {
  console.error('check-offline-reach: FAILED\n');
  for (const { where, msg } of problems) console.error(`  ${where}\n    ${msg}\n`);
  console.error(
    `  ${problems.length} problem(s). A reader with an install and no network must be able to\n` +
      '  open everything we tell them to open.\n',
  );
  process.exit(1);
}

console.log(
  `check-offline-reach: clean. ${ANCHORS.length} documented anchor(s) exist with bytes in them, ` +
    `are declared in "files", and ship in the tarball npm would publish. The on-disk sentence ` +
    `in llms.txt names ${REQUIRED_IN_SENTENCE.length} required document(s) and at least ` +
    `${MIN_NAMED} files in all.`,
);
