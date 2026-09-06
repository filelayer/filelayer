#!/usr/bin/env node
/**
 * Extract every TypeScript sample from the shipped documentation and RUN it.
 *
 *   node tools/check-doc-samples.mjs           # run them, exit 1 on failure
 *   node tools/check-doc-samples.mjs --emit    # write the generated programs to
 *                                              # .doccheck/ and stop
 *
 * WHY. "Every code block on this page is executed by the test suite" is a claim
 * a document can make and quietly stop honouring the moment a signature
 * changes. A reader -- especially an agent writing an integration -- cannot
 * tell a sample that works from one that used to. This closes the gap
 * mechanically: the samples in the documents are the samples that run.
 *
 * HOW. Each `ts` block becomes one self-contained async scope in a generated
 * program, so two blocks may both declare `const id` without colliding. Imports
 * are hoisted and merged per module specifier. Fixtures shared across blocks
 * come from `doccheck-setup` blocks, which are emitted at module top level.
 *
 * The specifier `@filelayer/core` is rewritten to this repository's
 * `packages/core/src/index.ts`, so a sample is checked against the working tree
 * rather than against whatever happens to be installed. That the PUBLISHED
 * specifier resolves is a different claim, and it is checked by installing the
 * packed tarball, not here.
 *
 * CONVENTIONS, all visible in the markdown source:
 *
 *   <!-- doccheck-setup
 *   const bytes = new TextEncoder().encode('hi');
 *   -->
 *       Hidden fixture code, injected at that point. Invisible when rendered.
 *       For the `bytes`/`req`/`res` a prose sample takes for granted -- never to
 *       paper over a sample that does not work.
 *
 *   <!-- doccheck: skip reason="..." -->
 *       The NEXT block is not executed. A reason is mandatory and is printed in
 *       the summary, so the cost of skipping stays visible.
 *
 *   await someCall();   // throws 404
 *       A single-line awaited statement whose trailing comment is `// throws
 *       NNN` is asserted to reject with that HTTP status. The convention was
 *       already in the documents; this makes it load-bearing.
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const OUT = join(ROOT, '.doccheck');
const CORE_SRC = join(ROOT, 'packages/core/src/index.ts');

const DOCS = ['README.md', 'docs/QUICKSTART.md'];

// -----------------------------------------------------------------------------
// Parse
// -----------------------------------------------------------------------------
function parse(md) {
  const lines = md.split('\n');
  const parts = [];
  let pendingSkip = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('<!-- doccheck-setup')) {
      const start = i + 1;
      let j = start;
      while (j < lines.length && !lines[j].includes('-->')) j++;
      parts.push({ kind: 'setup', code: lines.slice(start, j).join('\n'), line: i + 1 });
      i = j + 1;
      continue;
    }

    const skip = /<!--\s*doccheck:\s*skip\s+reason="([^"]*)"\s*-->/.exec(line);
    if (skip) {
      pendingSkip = skip[1];
      i++;
      continue;
    }

    if (/^```(ts|typescript)\s*$/.test(line.trim())) {
      const start = i + 1;
      let j = start;
      while (j < lines.length && lines[j].trim() !== '```') j++;
      parts.push({
        kind: 'sample',
        code: lines.slice(start, j).join('\n'),
        line: i + 1,
        skip: pendingSkip,
      });
      pendingSkip = null;
      i = j + 1;
      continue;
    }

    if (line.trim().startsWith('```')) {
      // Any other fence: swallow its body so it cannot confuse the scanner.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '```') j++;
      i = j + 1;
      continue;
    }

    i++;
  }
  return parts;
}

// -----------------------------------------------------------------------------
// Transform
// -----------------------------------------------------------------------------

/** `await x(); // throws 404` -> an assertion. */
function rewriteThrows(code) {
  return code
    .split('\n')
    .map((l) => {
      const m = /^(\s*)(await\s+.+?);\s*\/\/\s*throws\s+(\d{3})\b.*$/.exec(l);
      return m ? `${m[1]}await __throws(async () => { ${m[2]}; }, ${m[3]});` : l;
    })
    .join('\n');
}

/**
 * Split a block into its import statements and everything else.
 * Handles the single-line and the braced multi-line form, which is all the
 * documents use. Anything else is left in place and will fail loudly.
 */
function hoistImports(code, imports) {
  const lines = code.split('\n');
  const rest = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!/^\s*import\s/.test(l)) {
      rest.push(l);
      continue;
    }
    let stmt = l;
    while (!/;\s*$/.test(stmt.trim()) && i + 1 < lines.length) stmt += '\n' + lines[++i];
    const m = /^\s*import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/.exec(stmt);
    if (m) {
      const source = m[2] === '@filelayer/core' ? CORE_SRC : m[2];
      const set = imports.get(source) ?? new Set();
      for (const spec of m[1].split(',')) {
        const s = spec.trim();
        if (s) set.add(s);
      }
      imports.set(source, set);
    } else {
      rest.push(stmt); // not a named import; let it stand and fail visibly
    }
  }
  return rest.join('\n');
}

// -----------------------------------------------------------------------------
// Build + run
// -----------------------------------------------------------------------------
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let failed = 0;
const summary = [];

for (const doc of DOCS) {
  const parts = parse(readFileSync(join(ROOT, doc), 'utf8'));
  const samples = parts.filter((p) => p.kind === 'sample');
  const skipped = samples.filter((p) => p.skip);

  if (samples.length === 0) {
    summary.push(`${doc}: no TypeScript samples`);
    continue;
  }

  const imports = new Map([[CORE_SRC, new Set(['FilelayerError'])]]);
  const body = [];

  for (const p of parts) {
    if (p.kind === 'setup') {
      body.push(`\n// --- setup (${doc}:${p.line}) ---`);
      body.push(hoistImports(p.code, imports));
      continue;
    }
    if (p.skip) continue;
    const code = hoistImports(rewriteThrows(p.code), imports);
    body.push(`\n// --- sample (${doc}:${p.line}) ---`);
    body.push(`await (async () => {\n${code}\n})();`);
  }

  const importLines = [...imports]
    .map(([source, names]) => `import { ${[...names].join(', ')} } from '${source}';`)
    .join('\n');

  const program = `// GENERATED by tools/check-doc-samples.mjs from ${doc}. Do not edit.
${importLines}

async function __throws(fn: () => Promise<unknown>, status: number): Promise<void> {
  try {
    await fn();
  } catch (e: any) {
    if (e instanceof FilelayerError && e.status === status) return;
    throw new Error(\`expected FilelayerError \${status}, got \${e?.status ?? ''} \${e?.code ?? e}\`);
  }
  throw new Error(\`expected FilelayerError \${status}, but nothing was thrown\`);
}
${body.join('\n')}

console.log('OK ${doc}');
`;

  const file = join(OUT, doc.replace(/[/.]/g, '_') + '.ts');
  writeFileSync(file, program);

  if (process.argv.includes('--emit')) {
    summary.push(`${doc}: emitted ${file}`);
    continue;
  }

  const r = spawnSync(process.execPath, ['--experimental-strip-types', file], {
    encoding: 'utf8',
    cwd: ROOT,
  });

  const ran = samples.length - skipped.length;
  if (r.status === 0) {
    summary.push(
      `PASS  ${doc}  (${ran}/${samples.length} sample block(s) executed` +
        (skipped.length ? `, ${skipped.length} skipped` : '') +
        ')',
    );
  } else {
    failed++;
    summary.push(`FAIL  ${doc}  (${ran}/${samples.length} sample block(s) executed)`);
    console.error(`\n----- ${doc} -----`);
    if (r.stdout) console.error(r.stdout);
    if (r.stderr) console.error(r.stderr);
    console.error(`generated program: ${file}`);
  }

  for (const s of skipped) summary.push(`      skipped ${doc}:${s.line} — ${s.skip}`);
}

console.log('\ncheck-doc-samples:');
for (const s of summary) console.log('  ' + s);
console.log('');

process.exit(failed === 0 ? 0 : 1);
