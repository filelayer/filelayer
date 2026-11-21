#!/usr/bin/env node
/**
 * THE FINGERPRINT OF EVERYTHING THE PREREGISTRATION FIXES.
 *
 *   node fingerprint.mjs            print it
 *   node fingerprint.mjs --write    write ../FINGERPRINT.txt
 *   node fingerprint.mjs --check    exit 1 if the files differ from FINGERPRINT.txt
 *
 * One SHA-256 per file of the contract, the prompts, the smoke test, the
 * references, the hidden checks, the harness and the shared attacks, and one
 * over the whole list. run.mjs refuses a real run whose files differ from
 * FINGERPRINT.txt as committed with PREREG.md, and records the fingerprint
 * in every run.json.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '..');
const ROOTS = ['contract', 'prompts', 'smoke', 'reference', 'hidden', 'harness', 'package.json', 'package-lock.json'];
const SKIP = new Set(['node_modules', '.git']);

function files(p) {
  const abs = join(BENCH, p);
  if (!existsSync(abs)) return [];
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name))
      .flatMap((e) => files(join(p, e.name)));
  } catch {
    return [p];
  }
}

export function fingerprint() {
  const list = ROOTS.flatMap(files).sort();
  list.push('../adversarial/attacks.mjs');
  const lines = list.map((f) => `${createHash('sha256').update(readFileSync(join(BENCH, f))).digest('hex')}  ${f}`);
  const all = createHash('sha256').update(lines.join('\n')).digest('hex');
  return { all, text: `${lines.join('\n')}\n\n${all}  (all of the above)\n` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fp = fingerprint();
  const file = join(BENCH, 'FINGERPRINT.txt');
  if (process.argv.includes('--write')) {
    writeFileSync(file, fp.text);
    console.log(`FINGERPRINT.txt written: ${fp.all}`);
  } else if (process.argv.includes('--check')) {
    const committed = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (committed !== fp.text) {
      console.error('the files differ from FINGERPRINT.txt');
      process.exit(1);
    }
    console.log(`matches FINGERPRINT.txt: ${fp.all}`);
  } else {
    process.stdout.write(fp.text);
  }
}
