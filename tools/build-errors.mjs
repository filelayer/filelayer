#!/usr/bin/env node
/**
 * THE ERROR CATALOGUE, AS SOMETHING A MACHINE CAN READ.
 *
 *   node tools/build-errors.mjs            # write errors.json and ERRORS.md
 *   node tools/build-errors.mjs --check    # fail if either is out of date
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GENERATES, AND WHY NOT BY HAND
 * ---------------------------------------------------------------------------
 *
 * `packages/core/src/errors.ts` holds `ERROR_CODES`, which the constructor is
 * typed against. A code that is not in it does not compile. That makes it the
 * one place where the set of codes is decided, so everything else about them
 * has to be DERIVED from it rather than written beside it:
 *
 *   * `packages/core/errors.json` -- the machine-readable form, shipped in the
 *     tarball and resolvable as `@filelayer/core/errors.json`. An agent
 *     mapping our codes onto its own responses should not have to parse a
 *     markdown table, and until `0.19.0` that was the only option.
 *
 *   * `packages/core/ERRORS.md` -- the same thing for a person, shipped beside
 *     it. Generated so that it cannot drift from the code the way the
 *     QUICKSTART table did: that table named eight of twenty-nine codes and
 *     nobody noticed, because nothing compared it to anything.
 *
 * ---------------------------------------------------------------------------
 * THE CHECK THAT MATTERS MOST RUNS IN BOTH DIRECTIONS
 * ---------------------------------------------------------------------------
 *
 * Generating a document from the catalogue proves the document matches the
 * catalogue. It does not prove the catalogue matches the CODE. So this also
 * scans `src/` for every `new FilelayerError('<code>'` and requires:
 *
 *   * every code thrown is in the catalogue -- the compiler already enforces
 *     this, and it is checked again here because a gate that depends on
 *     somebody having run `tsc` is not a gate;
 *   * every code in the catalogue is thrown somewhere, or is listed in
 *     `NOT_THROWN_DIRECTLY` with the reason. A catalogue entry nothing can
 *     produce is a promise about an error that does not exist.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const SRC = join(CORE, 'src');

const check = process.argv.includes('--check');
const problems = [];

/**
 * Codes that no `new FilelayerError('<code>')` produces, with the reason. Each
 * one is reachable, just not from a literal: `toPublicError()` maps a deny
 * reason to a code and the construction site passes the result through.
 */
const NOT_THROWN_DIRECTLY = {
  password_required: 'produced by toPublicError() from the bad_password deny reason',
  gone: 'produced by toPublicError() from the file_expired deny reason',
  retention_hold: 'produced by toPublicError() from the retention_hold deny reason',
};

// -----------------------------------------------------------------------------
// 1. Read the catalogue out of the source of truth.
// -----------------------------------------------------------------------------
const errorsTs = readFileSync(join(SRC, 'errors.ts'), 'utf8');

const catalogue = {};
const entry = /^ {2}([a-z_]+): \{\n {4}status: (\d+),\n {4}meaning:\s*\n?\s*((?:'|")(?:[^]*?)(?:'|")),\n {4}fix:\s*\n?\s*((?:'|")(?:[^]*?)(?:'|")),\n {2}\},$/gm;
let m;
while ((m = entry.exec(errorsTs)) !== null) {
  catalogue[m[1]] = {
    status: Number(m[2]),
    meaning: unquote(m[3]),
    fix: unquote(m[4]),
  };
}

/** A TypeScript string literal, as its value. Handles the escapes we use. */
function unquote(literal) {
  const body = literal.slice(1, -1);
  return body.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

if (Object.keys(catalogue).length === 0) {
  fail('src/errors.ts', 'parsed zero codes out of ERROR_CODES. The shape of that object changed; fix this tool in the same commit.');
  report();
}

// The parser must see every entry, or it silently publishes a short catalogue.
const declared = (errorsTs.match(/^ {2}[a-z_]+: \{$/gm) ?? []).length;
if (declared !== Object.keys(catalogue).length) {
  fail(
    'src/errors.ts',
    `ERROR_CODES declares ${declared} entries and this tool parsed ${Object.keys(catalogue).length}. ` +
      'An entry whose shape this parser does not match would be missing from everything it generates.',
  );
}

// -----------------------------------------------------------------------------
// 2. Both directions against the code.
// -----------------------------------------------------------------------------
const thrown = new Set();
for (const f of readdirSync(SRC)) {
  if (!f.endsWith('.ts') || f === 'errors.ts') continue;
  const s = readFileSync(join(SRC, f), 'utf8');
  for (const t of s.matchAll(/new FilelayerError\(\s*'([a-z_]+)'/g)) thrown.add(t[1]);
}

for (const code of thrown) {
  if (!catalogue[code]) {
    fail(code, `is thrown in src/ and is not in ERROR_CODES. The compiler should have caught this; if it did not, this tool and tsc disagree about the source.`);
  }
}
for (const code of Object.keys(catalogue)) {
  if (!thrown.has(code) && !NOT_THROWN_DIRECTLY[code]) {
    fail(
      code,
      'is in ERROR_CODES and nothing throws it. Either it is produced indirectly, in which case add it to ' +
        'NOT_THROWN_DIRECTLY with the reason, or it is a promise about an error that cannot happen.',
    );
  }
}
for (const [code, why] of Object.entries(NOT_THROWN_DIRECTLY)) {
  if (!catalogue[code]) fail(code, `is in NOT_THROWN_DIRECTLY ("${why}") and not in ERROR_CODES.`);
  else if (thrown.has(code)) {
    fail(code, `is in NOT_THROWN_DIRECTLY ("${why}") but src/ throws it directly. Remove the exemption.`);
  }
}

// -----------------------------------------------------------------------------
// 2b. THE CATALOGUE HAS TO BE REACHABLE AS `@filelayer/core`.
//
// `0.19.0` shipped it and did not export it. `index.ts` never re-exported
// `errors.ts`, so `ERROR_CODES` and `isErrorCode` were absent from the package
// surface while llms.txt and QUICKSTART both told a reader to use them.
// `FilelayerError` arrived anyway through another module's re-export, which is
// what made it look fine.
//
// Checked against `index.ts` rather than by importing, because this tool runs
// before the build and must not depend on `dist/` being current.
// -----------------------------------------------------------------------------
{
  const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
  if (!/^export \* from '\.\/errors\.ts';$/m.test(index)) {
    fail(
      'src/index.ts',
      "does not re-export './errors.ts', so ERROR_CODES, ErrorCode and isErrorCode are not " +
        'importable from `@filelayer/core`. The catalogue that the documentation tells a reader ' +
        'to use has to be on the package surface.',
    );
  }
}

// -----------------------------------------------------------------------------
// 3. Render.
// -----------------------------------------------------------------------------
const byStatus = Object.entries(catalogue).sort(
  (a, b) => a[1].status - b[1].status || a[0].localeCompare(b[0]),
);

const json = `${JSON.stringify(
  {
    $comment:
      'Generated from packages/core/src/errors.ts by tools/build-errors.mjs. Do not edit. ' +
      'Every code this library can produce, with the HTTP status it always carries. ' +
      'The status is a function of the code: one code never means two statuses.',
    version: JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).version,
    codes: Object.fromEntries(byStatus),
  },
  null,
  2,
)}\n`;

const md = `# Errors

Every code \`@filelayer/core\` can produce. **Generated** from
[\`src/errors.ts\`](src/errors.ts) by \`tools/build-errors.mjs\`; editing this
file by hand does nothing except fail the build.

The machine-readable form is [\`errors.json\`](errors.json), which ships in the
tarball and resolves as \`@filelayer/core/errors.json\`.

## Two things that are true of every row

**The status is a function of the code.** One code never means two statuses, so
a caller that branches on \`code\` never has to also branch on \`status\`. This is
enforced by the constructor, which does not accept a status at all.

**\`reason\` is not in this table and is never serialized.** A \`FilelayerError\`
carries an internal \`reason\` for your logs. It is deliberately absent from the
response body: \`not_found\` and "you are not a member of that org" are the same
answer to a caller who should not learn the difference.

${['4', '5'].flatMap((prefix) => {
  const rows = byStatus.filter(([, v]) => String(v.status).startsWith(prefix));
  if (rows.length === 0) return [];
  const heading =
    prefix === '4'
      ? '## The caller can act on these'
      : '## These are about your configuration, not the caller';
  const note =
    prefix === '4'
      ? ''
      : '\nA 5xx here almost never means a failure. It means the application was ' +
        'configured in a way that cannot serve this request, and the caller has no ' +
        'way to fix it. `internal` is the one exception.\n';
  return [
    `${heading}\n${note}`,
    ...rows.map(
      ([code, v]) => `### \`${code}\` — ${v.status}\n\n${v.meaning}\n\n**Fix.** ${v.fix}\n`,
    ),
  ];
}).join('\n')}
---

${Object.keys(catalogue).length} codes. Generated for \`${JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).version}\`.
`;

// -----------------------------------------------------------------------------
// 4. Write, or compare.
// -----------------------------------------------------------------------------
const targets = [
  [join(CORE, 'errors.json'), json],
  [join(CORE, 'ERRORS.md'), md],
];

for (const [path, content] of targets) {
  const rel = path.slice(ROOT.length + 1);
  if (check) {
    let current = null;
    try {
      current = readFileSync(path, 'utf8');
    } catch {
      fail(rel, 'does not exist. Run `npm run build:errors` and commit the result.');
      continue;
    }
    if (current !== content) {
      fail(rel, 'does not match what src/errors.ts renders to. Run `npm run build:errors` and commit the result.');
    }
  } else {
    writeFileSync(path, content);
  }
}

report();

function fail(where, msg) {
  problems.push(`  - ${where}: ${msg}`);
}

function report() {
  if (problems.length > 0) {
    console.error(`\nbuild-errors: FAILED\n\n${problems.join('\n\n')}\n`);
    process.exit(1);
  }
  console.log(
    check
      ? `build-errors: clean. ${Object.keys(catalogue).length} code(s); errors.json and ERRORS.md match src/errors.ts; every code thrown is catalogued and every code catalogued is reachable.`
      : `build-errors: wrote errors.json and ERRORS.md from ${Object.keys(catalogue).length} code(s).`,
  );
}
