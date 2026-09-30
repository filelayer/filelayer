#!/usr/bin/env node
/**
 * Typecheck every TypeScript sample on the homepage against the real library.
 *
 *   node tools/check-web-samples.mjs             # check, exit 1 on a hit
 *   node tools/check-web-samples.mjs --list      # the blocks it found, classified
 *   node tools/check-web-samples.mjs --self-test # the negative controls only
 *
 * -----------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT
 * -----------------------------------------------------------------------------
 *
 * Found by audit, 2026-09-29. The tier-4 sample on the homepage did not compile:
 *
 *     const share = await fl.shares.create(id, { as: 'ceo', expiresIn: 3600 });
 *     await fl.shares.redeem(share.secret, { password: 'hunter2' });
 *                            ^^^^^^^^^^^^ string | undefined
 *
 * `check-doc-samples.mjs` compiles AND executes every sample in `README.md` and
 * `docs/QUICKSTART.md`, and has since before the site existed. The homepage was
 * simply never added to its list, so the most-read code we publish was the only
 * code we published that nobody checked.
 *
 * The page even says *"Verbatim from the README, where every sample is compiled
 * and executed in CI"* -- and that sentence is true of the block it sits under,
 * which is exactly what made this easy to miss for every other block.
 *
 * -----------------------------------------------------------------------------
 * WHY TYPECHECK AND NOT EXECUTE
 * -----------------------------------------------------------------------------
 *
 * Homepage samples are deliberately elided. They say things like
 * `// later — the URL is printed, indexed, pasted into a ticket` between two
 * calls, and they use `id` and `bytes` without introducing them, because a
 * landing page that declares its fixtures is a landing page nobody reads.
 *
 * Executing them would therefore require rewriting them, and a sample rewritten
 * to be executable is no longer the sample on the page. Compiling them against
 * the real types catches the whole class of defect that matters here -- a method
 * that does not exist, an option that is not accepted, a value whose type is
 * wrong -- without touching the copy. Whether the page's PROSE is true is a
 * different question and belongs to review.
 *
 * The fixtures the page leaves implicit are supplied by PREAMBLE below, typed
 * from the library itself rather than stubbed, so a rename in `simple.ts` breaks
 * this check instead of sliding past it.
 */

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'web/index.html');
const TSC = join(ROOT, 'packages/core/node_modules/.bin/tsc');
const ENTRY = join(ROOT, 'packages/core/src/index.ts');

/**
 * The lowest number of TypeScript blocks this may find before it is presumed
 * broken rather than passing. A markup change that stops the extractor matching
 * would otherwise turn this gate into a no-op that reports success -- the same
 * silent hole `check-version-claims.mjs` guards against with its
 * "pattern matched nothing" rule.
 */
const MIN_BLOCKS = 5;

const PREAMBLE = `
import { Filelayer } from ${JSON.stringify(ENTRY)};
declare const fl: Awaited<ReturnType<typeof Filelayer.quickstart>>;
declare const bytes: Uint8Array;
declare const deck: Uint8Array;
declare const id: string;
`;

// -----------------------------------------------------------------------------
// Extract
// -----------------------------------------------------------------------------
/**
 * A <pre><code> block is TypeScript if it contains a line that could only be
 * TypeScript. The page also carries shell blocks (`npm install ...`) and one
 * block of audit-log OUTPUT, and misclassifying either as code would fail this
 * check for the wrong reason. The rule is stated here rather than inferred from
 * a CSS class so that it survives a restyle.
 */
const looksLikeTs = (code) =>
  /^\s*(?:import|export)\s/m.test(code) ||
  /\b(?:const|let)\s+[{[]?\s*\w/.test(code) ||
  /\bawait\s+\w/.test(code) ||
  /\bfor\s*\(/.test(code);

function extract(html) {
  const out = [];
  const re = /<pre><code>([\s\S]*?)<\/code><\/pre>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = m[1]
      .replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&middot;/g, '·')
      .replace(/&amp;/g, '&');
    out.push({
      line: html.slice(0, m.index).split('\n').length,
      code,
      ts: looksLikeTs(code),
    });
  }
  return out;
}

// -----------------------------------------------------------------------------
// Compile
// -----------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'filelayer-websamples-'));

/**
 * Wrapped in a function so top-level `await` is legal and two blocks may both
 * declare `const id` without colliding -- the same trick check-doc-samples.mjs
 * uses. Derived, not hardcoded, so the line numbers reported below stay right
 * when PREAMBLE changes.
 */
const HEADER = `${PREAMBLE}\nasync function _sample() {\n`;
const HEADER_LINES = HEADER.split('\n').length - 1;

/** Returns tsc's diagnostics for one block, or '' when it compiles. */
function compile(code, name) {
  const file = join(dir, `${name}.ts`);
  writeFileSync(file, `${HEADER}${code}\n}\nvoid _sample;\n`);
  const r = spawnSync(
    TSC,
    [
      '--noEmit', '--strict', '--target', 'es2022',
      '--module', 'nodenext', '--moduleResolution', 'nodenext',
      '--allowImportingTsExtensions', '--skipLibCheck',
      file,
    ],
    {
      encoding: 'utf8',
      // CWD IS packages/core, AND THAT IS THE LOAD-BEARING PART. `Buffer`,
      // `node:crypto` and every other ambient Node type comes from
      // `@types/node`, which tsc resolves relative to the current directory when
      // it is invoked on a bare file with no tsconfig. Run it from the repository
      // root instead and every sample "fails" with two dozen
      // `Cannot find name 'Buffer'` errors from inside the LIBRARY -- which is
      // exactly how the first version of this checker reported a defect in all
      // six blocks at once, none of them real.
      cwd: join(ROOT, 'packages/core'),
    },
  );
  return (r.stdout ?? '').trim();
}

// -----------------------------------------------------------------------------
if (!existsSync(PAGE)) {
  console.error('check-web-samples: web/index.html is missing.');
  process.exit(1);
}
if (!existsSync(TSC)) {
  console.error(
    'check-web-samples: no tsc at packages/core/node_modules/.bin/tsc — run `npm run bootstrap`.',
  );
  process.exit(1);
}

const html = readFileSync(PAGE, 'utf8');
const blocks = extract(html);
const samples = blocks.filter((b) => b.ts);

if (process.argv.includes('--list')) {
  for (const b of blocks) {
    console.log(`  web/index.html:${b.line}  ${b.ts ? 'TYPESCRIPT' : 'not code  '}  ${JSON.stringify(b.code.trim().split('\n')[0].slice(0, 64))}`);
  }
}

const problems = [];

if (samples.length < MIN_BLOCKS) {
  problems.push(
    `found only ${samples.length} TypeScript block(s) on the page, expected at least ${MIN_BLOCKS}. ` +
      `Either the page genuinely lost its samples, or the extractor stopped matching the markup ` +
      `and this check is now passing without checking anything. Run --list.`,
  );
}

for (const [i, b] of samples.entries()) {
  const diag = compile(b.code, `s${i}`);
  if (diag) {
    // tsc reports against the temp file; point at the page instead.
    const cleaned = diag
      .split('\n')
      .map((l) => l.replace(/^.*?\.ts\((\d+),(\d+)\):/, (_, ln, col) =>
        `web/index.html: sample at line ${b.line}, sample-line ${Number(ln) - HEADER_LINES}, col ${col}:`))
      .join('\n      ');
    problems.push(`the sample at web/index.html:${b.line} does not compile\n      ${cleaned}`);
  }
}

// -----------------------------------------------------------------------------
// Negative controls — a gate that cannot fail is not a gate
// -----------------------------------------------------------------------------
const controls = [
  ['a call to a method that does not exist', () => compile('await fl.files.thisDoesNotExist(id);', 'c1') !== ''],
  ['an option the API does not accept', () => compile("await fl.files.put(bytes, { notAnOption: 1 });", 'c2') !== ''],
  // The exact defect that shipped: this is what the page said before the fix.
  ['the sample that shipped broken', () =>
    compile(
      `const share = await fl.shares.create(id, { as: 'ceo', withUser: 'x', expiresIn: 3600 });\n` +
      `await fl.shares.redeem(share.secret, { password: 'hunter2' });`,
      'c3',
    ) !== ''],
  ['a correct sample still compiles', () => compile("await fl.files.get(id, { as: 'alice' });", 'c4') === ''],
];
const failed = controls.filter(([, f]) => !f()).map(([n]) => n);

if (process.argv.includes('--self-test')) {
  if (failed.length) {
    console.error(`check-web-samples: CONTROLS DID NOT BEHAVE: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log(`check-web-samples: ${controls.length} negative control(s) passed.`);
  process.exit(0);
}

if (problems.length) {
  console.error('\ncheck-web-samples: FAILED\n');
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}
if (failed.length) {
  console.error(`check-web-samples: the negative controls did not behave (${failed.join(', ')}). The gate is not working.`);
  process.exit(1);
}

console.log(
  `check-web-samples: clean. ${samples.length} TypeScript sample(s) of ${blocks.length} code ` +
    `block(s) on web/index.html compile against the library under --strict; ` +
    `${controls.length} negative controls correct.`,
);
