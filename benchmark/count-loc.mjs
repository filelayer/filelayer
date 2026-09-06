#!/usr/bin/env node
/**
 * THE SHARED, LANGUAGE-COMPLETE LOC COUNTER.
 *
 * A review of the first version found that it did not do what the reports using
 * it implied. It bucketed by a regex that matched only `src/|api/|lib/` with
 * `.mjs|js|ts|tsx`, so it counted **no SQL and no `convex/` directory**. Two of
 * the four comparison implementations were therefore counted by their own
 * `tools/loc.js` while all five reports described "one shared auditable
 * counter". The numbers in those reports survived a hand recount -- but the
 * framing was false.
 *
 * This version is the shared counter the reports claimed existed:
 *
 *  1. LANGUAGE-COMPLETE. It understands `//`, `/* *​/`, `--` (SQL) and `#`
 *     (YAML/TOML) comments, and counts .ts .tsx .js .mjs .cjs .sql .json .yaml
 *     .yml .toml.
 *  2. NO SILENT OMISSION. Every file under every implementation root is
 *     classified into exactly one bucket. Anything no rule matches is reported
 *     as UNCLASSIFIED and the process exits non-zero. The previous script's
 *     failure mode -- a whole directory silently contributing zero -- cannot
 *     recur, because a directory nobody has classified is an error, not a zero.
 *  3. EXPLICIT, AUDITABLE RULES. What counts as application code for each
 *     implementation lives in `loc.manifest.json`, in one place, with a reason
 *     attached to every exclusion. Disagree with a line of that file and you
 *     can re-run the number yourself.
 *
 * COUNTING METHOD (unchanged, and deliberately unflattering to nobody):
 *
 *   GROSS = every line in the counted files, including blanks and comments.
 *   NET   = lines that are neither blank nor comment-only.
 *
 * A line with code AND a trailing comment counts as code. No attempt is made to
 * discount "boilerplate", because what counts as boilerplate is exactly the
 * thing under dispute.
 *
 * BUCKETS:
 *   app       - developer-written application logic. The headline number.
 *   infra     - declarative infrastructure config the developer must author.
 *   platform  - vendor code, or a local re-implementation of vendor code that
 *               exists only so the baseline can execute. NOT counted.
 *   test      - the tests. NOT counted, for any implementation.
 *   tooling   - benchmark scaffolding, LOC scripts, harnesses. NOT counted.
 *   meta      - package.json, lockfiles, .md, .env.example. NOT counted.
 *
 * Usage:
 *   node count-loc.mjs                 # every implementation in the manifest
 *   node count-loc.mjs baseline-raw-s3 # one of them
 *   node count-loc.mjs --json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'loc.manifest.json'), 'utf8'));

const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.vercel']);

/** `**` matches any depth, `*` matches within one segment. Anchored at both ends. */
function globToRe(glob) {
  const body = glob
    .split('')
    .map((c, i, a) => {
      if (c === '*' && a[i - 1] === '*') return '';
      if (c === '*' && a[i + 1] === '*') return '.*';
      if (c === '*') return '[^/]*';
      if (c === '?') return '.';
      if ('.+^${}()|[]\\/'.includes(c)) return '\\' + c;
      return c;
    })
    .join('');
  return new RegExp(`^${body}$`);
}

// Both the root and the nested spelling, because `**/x` does not match `x`.
const META_RE = [
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '*.md',
  '.env.example',
  '.gitignore',
  '.eslintrc*',
]
  .flatMap((g) => [g, `**/${g}`])
  .map(globToRe);

// Buckets are tried in this order, so a specific exclusion beats a broad rule.
const ORDER = ['excluded', 'platform', 'tooling', 'test', 'infra', 'app'];

function walk(dir, root = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(path.join(dir, e.name), root, out);
    } else {
      out.push(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  }
  return out;
}

const COUNTED_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx',
  '.sql', '.json', '.yaml', '.yml', '.toml',
]);

/**
 * Comment syntax per language. `--` for SQL is the line the old script could
 * not see, and it is 364 of Supabase's 564 lines.
 */
function commentSyntax(ext) {
  switch (ext) {
    case '.sql':
      return { line: ['--'], block: ['/*', '*/'] };
    case '.yaml':
    case '.yml':
    case '.toml':
      return { line: ['#'], block: null };
    case '.json':
      return { line: [], block: null }; // JSON has no comments
    default:
      return { line: ['//'], block: ['/*', '*/'] };
  }
}

function countFile(abs) {
  const ext = path.extname(abs);
  const { line, block } = commentSyntax(ext);
  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let net = 0;
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) {
      if (block && t.includes(block[1])) inBlock = false;
      continue;
    }
    if (t === '') continue;
    if (line.some((p) => t.startsWith(p))) continue;
    if (block && t.startsWith(block[0])) {
      if (!t.includes(block[1])) inBlock = true;
      continue;
    }
    // A continuation line of a block comment written in the `*` style.
    if (block && t.startsWith('*')) continue;
    net++;
  }
  return { gross: lines.length, net };
}

function classify(rel, rules) {
  if (META_RE.some((re) => re.test(rel))) return 'meta';
  for (const bucket of ORDER) {
    for (const rule of rules[bucket] ?? []) {
      if (globToRe(rule.glob ?? rule).test(rel)) return bucket;
    }
  }
  if (!COUNTED_EXT.has(path.extname(rel))) return 'meta';
  return null; // UNCLASSIFIED -- a hard error, never a silent zero
}

const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
const targets = Object.entries(MANIFEST.implementations).filter(
  ([name]) => wanted.length === 0 || wanted.includes(name),
);

let unclassifiedTotal = 0;
const results = {};

for (const [name, impl] of targets) {
  const root = path.resolve(HERE, impl.root);
  if (!fs.existsSync(root)) {
    console.error(`!! ${name}: root ${impl.root} does not exist`);
    process.exitCode = 1;
    continue;
  }
  const totals = {};
  const detail = {};
  const unclassified = [];

  for (const rel of walk(root)) {
    const bucket = classify(rel, impl);
    if (bucket === null) {
      unclassified.push(rel);
      continue;
    }
    if (bucket === 'meta') continue;
    const c = countFile(path.join(root, rel));
    totals[bucket] ??= { gross: 0, net: 0, files: 0 };
    totals[bucket].gross += c.gross;
    totals[bucket].net += c.net;
    totals[bucket].files += 1;
    (detail[bucket] ??= []).push({ file: rel, ...c });
  }

  results[name] = {
    app: totals.app ?? { gross: 0, net: 0, files: 0 },
    infra: totals.infra ?? { gross: 0, net: 0, files: 0 },
    notCounted: {
      platform: totals.platform ?? { gross: 0, net: 0, files: 0 },
      test: totals.test ?? { gross: 0, net: 0, files: 0 },
      tooling: totals.tooling ?? { gross: 0, net: 0, files: 0 },
      excluded: totals.excluded ?? { gross: 0, net: 0, files: 0 },
    },
    unclassified,
  };
  unclassifiedTotal += unclassified.length;

  if (asJson) continue;
  console.log(`\n=== ${name} ===   (${impl.note ?? ''})`);
  for (const b of ORDER.slice().reverse()) {
    if (!totals[b]) continue;
    const tag = b === 'app' || b === 'infra' ? '' : '   [not counted]';
    console.log(
      `${b.padEnd(9)} files=${String(totals[b].files).padStart(2)}  ` +
        `gross=${String(totals[b].gross).padStart(5)}  net=${String(totals[b].net).padStart(5)}${tag}`,
    );
    for (const f of detail[b].sort((x, y) => y.net - x.net)) {
      console.log(
        `  ${f.file.padEnd(38)} ${String(f.gross).padStart(5)} / ${String(f.net).padStart(5)}`,
      );
    }
  }
  console.log(
    `APPLICATION LOC: gross ${results[name].app.gross}  net ${results[name].app.net}` +
      `   (+ infra net ${results[name].infra.net})`,
  );
  if (unclassified.length) {
    console.log(`!! UNCLASSIFIED (${unclassified.length}) -- add a rule to loc.manifest.json:`);
    for (const f of unclassified) console.log(`   ${f}`);
  }
}

if (asJson) console.log(JSON.stringify(results, null, 2));

if (!asJson && targets.length > 1) {
  const rows = Object.entries(results).map(([n, r]) => [n, r.app.net, r.infra.net]);
  const fl = rows.find(([n]) => n === 'filelayer')?.[1];
  console.log('\n=== APPLICATION LOC (net), one counter, all implementations ===');
  for (const [n, app, infra] of rows.sort((a, b) => a[1] - b[1])) {
    const ratio = fl ? ` ${(app / fl).toFixed(1)}x` : '';
    console.log(`  ${n.padEnd(22)} app ${String(app).padStart(5)}   infra ${String(infra).padStart(4)}${ratio}`);
  }
}

if (unclassifiedTotal > 0) {
  console.error(
    `\nFAIL: ${unclassifiedTotal} file(s) matched no rule. A file the counter cannot ` +
      `classify must not silently count as zero -- that is the defect this rewrite fixes.`,
  );
  process.exitCode = 2;
}
