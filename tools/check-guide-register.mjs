#!/usr/bin/env node
/**
 * A GUIDE THAT NOTHING POINTS AT IS A GUIDE NOBODY READS.
 *
 *     node tools/check-guide-register.mjs
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT
 * -----------------------------------------------------------------------------
 *
 * `docs/guides/serving-private-files.md` was written, reviewed, rendered to
 * `web/guides/`, listed in the sitemap, shipped in the tarball -- and named in
 * NEITHER `llms.txt` NOR `docs/guides/README.md`. It stayed that way across
 * several releases. Nothing failed, because nothing was asking.
 *
 * Worse, `tools/check-offline-reach.mjs` carried four entries, one per guide,
 * each with the explanation "the fourth guide, named by llms.txt". By the time
 * a fifth guide existed, that sentence was false for it and the list had no way
 * to say so. The register was not merely incomplete; it ASSERTED a property of
 * a file it had never looked at.
 *
 * This is the project's own rule -- registration is not coverage -- caught by
 * nothing, in the three places most likely to need it: the file an agent reads
 * to orient itself, the index a human lands on, and the manifest that decides
 * what ships.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT CHECKS
 * -----------------------------------------------------------------------------
 *
 * For every `docs/guides/*.md` that is not the index, DISCOVERED from the
 * filesystem and not from any list:
 *
 *   1. `llms.txt` links it. That is the file an agent with an install reads.
 *   2. `docs/guides/README.md` links it. That is where a human lands.
 *   3. `tools/package-copies.mjs` ships it, and ships its `.proof.mjs` if one
 *      exists -- because a measurement that cannot be re-run from an install is
 *      an assertion with a confident voice.
 *   4. A proof beside a guide is RUNNABLE from the index: `docs/guides/README.md`
 *      names it in the "Running the proofs" block. A proof nobody is told to run
 *      is a test nobody runs.
 *
 * And in the other direction: every guide link in `llms.txt` and in the index
 * resolves to a file that exists. A register pointing at a deleted guide is the
 * same defect with the sign flipped, and it is how a 404 reaches a reader who
 * trusted us enough to follow the link.
 *
 * It does NOT check the sitemap or `web/guides/`: `check:guides` already
 * re-renders both from this directory and fails on a one-byte difference, so
 * those cannot drift. This gate exists for the three places that are prose.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_DIR = join(ROOT, 'docs', 'guides');

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const guides = readdirSync(GUIDE_DIR)
  .filter((f) => f.endsWith('.md') && f !== 'README.md')
  .sort();

if (guides.length === 0) {
  console.error('check-guide-register: no guides found. That is either a mistake or a move.');
  process.exit(1);
}

const llms = read('llms.txt');
const index = read('docs/guides/README.md');
const copies = read('tools/package-copies.mjs');

const problems = [];
const note = (what) => problems.push(what);

for (const file of guides) {
  const slug = file.replace(/\.md$/, '');
  const proof = `${slug}.proof.mjs`;
  const hasProof = existsSync(join(GUIDE_DIR, proof));

  // 1. llms.txt links it. Absolute GitHub URLs, because llms.txt is read from
  //    places where a relative path means nothing.
  if (!llms.includes(`docs/guides/${file}`)) {
    note(`llms.txt does not link docs/guides/${file}`);
  }

  // 2. The index links it, relatively -- it sits in the same directory.
  if (!new RegExp(`\\(${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.md\\)`).test(index)) {
    note(`docs/guides/README.md does not link ${file}`);
  }

  // 3. The tarball carries it.
  if (!copies.includes(`docs/guides/${file}`)) {
    note(`tools/package-copies.mjs does not ship docs/guides/${file}`);
  }
  if (hasProof && !copies.includes(`docs/guides/${proof}`)) {
    note(`tools/package-copies.mjs does not ship docs/guides/${proof}`);
  }

  // 4. And the reader is told how to run the proof.
  if (hasProof && !index.includes(`node docs/guides/${proof}`)) {
    note(`docs/guides/README.md does not tell anyone to run ${proof}`);
  }
}

// The other direction: nothing points at a guide that is gone.
const linked = new Set();
for (const text of [llms, index]) {
  for (const m of text.matchAll(/(?:docs\/guides\/)?([a-z0-9-]+\.md)/g)) {
    if (m[1] !== 'README.md') linked.add(m[1]);
  }
}
for (const name of [...linked].sort()) {
  if (!guides.includes(name)) {
    note(`llms.txt or the index links docs/guides/${name}, which does not exist`);
  }
}

const label = `${guides.length} guide(s)`;
if (problems.length > 0) {
  console.error(`check-guide-register: ${label}, ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nA guide nothing links is a guide nobody reads, and a link to a guide that is\n' +
      'gone is a 404 for a reader who trusted us enough to follow it.',
  );
  process.exit(1);
}

console.log(`check-guide-register: ${label}, each one linked by llms.txt and the index,`);
console.log('  shipped in the tarball, and with its proof named where a reader will run it.');
for (const f of guides) console.log(`  ok  docs/guides/${f}`);
