#!/usr/bin/env node
/**
 * NO PUBLIC SURFACE LINKS A GITHUB `tree/` URL OF THIS REPOSITORY.
 *
 *     node tools/check-tree-links.mjs
 *     node tools/check-tree-links.mjs --self-test
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * `distribution/FETCHABILITY.md` (31 October 2026) fetched every link on our
 * surfaces the way an agent does. GitHub `blob/` pages came back readable;
 * all six `tree/` links came back `robots_disallowed`, because GitHub's
 * robots.txt refuses directory listings to crawlers and agents. They sat on
 * the three most-read surfaces: the README (on GitHub and on npm), the
 * filelayer.dev home page, and llms.txt. A link an agent is not allowed to
 * open is a dead end that looks like a reference.
 *
 * Every directory we linked has a readable file to link instead (its
 * README.md under `blob/`), so the rule is simple: no `tree/` links at all.
 *
 * DISCOVERED, NOT LISTED. Every tracked text file is scanned except `tools/`,
 * where this gate's own pattern lives. A list of "the public surfaces" is the
 * enumeration that misses the surface somebody adds next week; the package
 * copies under packages/core/ are found the same way as the originals.
 *
 * Seen failing before it was trusted: on f5768fa it named 13 links in 7 files.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// This repository only. A `tree/` link to somebody else's repository is their
// robots.txt problem and not a claim of ours.
export const TREE = /https?:\/\/(?:www\.)?github\.com\/filelayer\/filelayer\/tree\//;

export function findTreeLinks(name, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (TREE.test(line)) hits.push({ file: name, line: i + 1, text: line.trim().slice(0, 140) });
  });
  return hits;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    { name: 'tree link in markdown', text: '[x](https://github.com/filelayer/filelayer/tree/main/examples/mcp)', fails: true },
    { name: 'tree link in html', text: '<a href="https://github.com/filelayer/filelayer/tree/main/examples">', fails: true },
    { name: 'blob link', text: '[x](https://github.com/filelayer/filelayer/blob/main/examples/mcp/README.md)', fails: false },
    { name: 'another repository', text: '[x](https://github.com/someone/else/tree/main)', fails: false },
  ];
  let bad = 0;
  for (const c of cases) {
    const failed = findTreeLinks('t', c.text).length > 0;
    const ok = failed === c.fails;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name} (expected ${c.fails ? 'refusal' : 'pass'})`);
  }
  console.log(`check-tree-links --self-test: ${cases.length - bad}/${cases.length} controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean)
  .filter((f) => /\.(md|txt|html|json|ya?ml|xml)$/.test(f))
  .filter((f) => !f.startsWith('tools/'));

if (tracked.length === 0) {
  console.error('check-tree-links: FAILED\n\n  - no tracked files found, so nothing was checked');
  process.exit(1);
}

const hits = [];
for (const f of tracked) {
  let text;
  try {
    text = readFileSync(join(ROOT, f), 'utf8');
  } catch {
    continue;
  }
  hits.push(...findTreeLinks(f, text));
}

if (hits.length > 0) {
  const files = new Set(hits.map((h) => h.file)).size;
  console.error(`check-tree-links: FAILED, ${hits.length} link(s) in ${files} file(s)\n`);
  for (const h of hits) console.error(`  - ${h.file}:${h.line}\n      ${h.text}`);
  console.error(
    '\n  GitHub refuses tree/ pages to crawlers and agents (robots.txt). Link the\n' +
      "  directory's README.md under blob/ instead, as distribution/FETCHABILITY.md lists.",
  );
  process.exit(1);
}
console.log(`check-tree-links: clean. ${tracked.length} tracked text file(s), no github.com/filelayer/filelayer/tree/ link.`);
