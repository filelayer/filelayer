#!/usr/bin/env node
/**
 * THE LIBRARY TALKS ONLY TO THE DATABASE AND THE BUCKET YOU CONFIGURE.
 *
 *     node tools/check-no-phone-home.mjs
 *     node tools/check-no-phone-home.mjs --self-test
 *
 * WHY. legal/PRIVACY.md and claude-plugin/README.md say that the library, the
 * skill, the plugin and filelayer-mcp send nothing to us, and that the only
 * network requests go to the Postgres and the S3 or R2 endpoint you configure.
 * That was true on 19 November 2026 by reading the code. This makes it a gate.
 *
 * WHAT IT CHECKS, over packages/core/src/*.ts (comments stripped):
 *   1. No network module is imported, statically or dynamically, except as
 *      `import type`: node:http(s), node:net, node:tls, node:dgram,
 *      node:http2, undici, ws, axios, node-fetch, and the bare equivalents.
 *      `pg` is allowed only in cli.ts and mcp-server.ts, which build a pool
 *      from your DATABASE_URL; everywhere else the pool is the one you pass in.
 *   2. No WebSocket, XMLHttpRequest or sendBeacon.
 *   3. `fetch(` appears only in storage.ts (the S3 client) and cli.ts (the
 *      doctor's anonymous-read probe of your bucket), and each call's URL is
 *      traced back through its definitions to the configured endpoint.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'packages/core/src');

const NET = /^(?:node:)?(?:http|https|net|tls|dgram|http2)$|^(?:undici|ws|axios|node-fetch|got|superagent)$/;
const PG_ALLOWED = new Set(['cli.ts', 'mcp-server.ts']);
const FETCH_ALLOWED = new Set(['storage.ts', 'cli.ts']);

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

// Follow an identifier back through `const|let NAME = ...` and `NAME = ...`
// until a definition mentions the configured endpoint.
function fromEndpoint(code, expr, depth = 0) {
  if (/endpoint/.test(expr)) return true;
  if (depth > 5) return false;
  const ids = [...new Set(expr.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])].filter((x) => !/^(new|URL|await|this|cfg|encodeURIComponent|String|replace|origin)$/.test(x));
  for (const id of ids) {
    const re = new RegExp(`(?:\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\b[^=]*|(?:^|[^.\\w$])${id.replace(/\$/g, '\\$')}\\s*)=(?!=)([^;]*)`, 'g');
    for (const m of code.matchAll(re)) {
      if (fromEndpoint(code, m[1], depth + 1)) return true;
    }
  }
  return false;
}

export function check(files) {
  const problems = [];
  for (const [name, raw] of files) {
    const code = stripComments(raw);
    const imports = [
      ...[...code.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
      ...[...code.matchAll(/(?<!typeof\s)\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
      ...[...code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of imports) {
      if (NET.test(spec)) problems.push(`${name}: imports ${spec}, a network module`);
      if (spec === 'pg' && !PG_ALLOWED.has(name)) problems.push(`${name}: imports pg; only cli.ts and mcp-server.ts build a pool, from your DATABASE_URL`);
    }
    for (const bad of ['WebSocket', 'XMLHttpRequest', 'sendBeacon']) {
      if (new RegExp(`\\b${bad}\\b`).test(code)) problems.push(`${name}: uses ${bad}`);
    }
    for (const m of code.matchAll(/(?<![.\w$])fetch\(\s*([^,)]+)/g)) {
      if (!FETCH_ALLOWED.has(name)) {
        problems.push(`${name}: calls fetch(${m[1].trim()}); only storage.ts and cli.ts may make requests, to your bucket`);
      } else if (!fromEndpoint(code, m[1])) {
        problems.push(`${name}: calls fetch(${m[1].trim()}) with a URL that does not come from the configured S3 endpoint`);
      }
    }
  }
  return problems;
}

const files = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => [f, readFileSync(join(SRC, f), 'utf8')]);

if (process.argv.includes('--self-test')) {
  const base = new Map(files);
  const cases = [
    ['a fetch added in another file', 'audit-read.ts', (s) => s + "\nawait fetch('https://telemetry.example.com/e');\n"],
    ['a fetch in storage.ts to a fixed URL', 'storage.ts', (s) => s + "\nexport const ping = () => fetch('https://telemetry.example.com/e');\n"],
    ['an import of node:https', 'simple.ts', (s) => "import https from 'node:https';\n" + s],
    ['a dynamic import of undici', 'db.ts', (s) => s + "\nconst u = await import('undici');\n"],
    ['pg imported in the engine', 'filelayer.ts', (s) => "import pg from 'pg';\n" + s],
  ];
  let bad = 0;
  for (const [what, file, mutate] of cases) {
    const m = new Map(base);
    m.set(file, mutate(m.get(file)));
    if (check([...m]).length === 0) { bad++; console.error(`  self-test FAILED: ${what} passed`); }
  }
  if (check(files).length !== 0) { bad++; console.error('  self-test FAILED: the real source is refused'); }
  if (bad) process.exit(1);
  console.log(`check-no-phone-home --self-test: ${cases.length} injected request(s) refused, the real source accepted.`);
  process.exit(0);
}

const problems = check(files);
if (problems.length) {
  console.error(`check-no-phone-home: FAILED, ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nlegal/PRIVACY.md says the library talks only to the database and the bucket you configure. Change the code, or change that page first.');
  process.exit(1);
}
console.log(`check-no-phone-home: clean. ${files.length} source file(s); requests go only to the configured S3 endpoint, and pg only from DATABASE_URL in cli.ts and mcp-server.ts.`);
