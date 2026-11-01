#!/usr/bin/env node
/**
 * THE LOCAL USAGE REPORT IS CLOSED, AND IT CANNOT REACH THE NETWORK.
 *
 *     node tools/check-usage-report.mjs
 *     node tools/check-usage-report.mjs --self-test
 *
 * Needs `npm run build` first: the runtime half imports the built package, the
 * same code an adopter's `filelayer usage-report` runs.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * The report is the one place this library produces data meant to leave the
 * adopter's machine, by their hand. Two promises make that acceptable, and both
 * are the kind that rot silently: the report contains only the fields
 * `usage-report.schema.json` publishes, and producing it touches nothing but the
 * adopter's own database. A field added in a hurry, or an import that quietly
 * pulls in an HTTP client, would break the first promise anyone reads about the
 * feature, with every test still green.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT CHECKS
 * -----------------------------------------------------------------------------
 *
 *   1. THE SCHEMA IS CLOSED AT EVERY LEVEL. Every object has
 *      `additionalProperties: false` and requires every property it declares;
 *      every string is an enum, a const or a pattern; every number has a
 *      minimum and a maximum; every array has `items` and `maxItems`.
 *   2. NO NETWORK IN THE IMPORT GRAPH. `src/usage-report.ts` and every module
 *      it imports at runtime (type-only imports excluded) import no socket
 *      module and contain no `fetch(`.
 *   3. THE BUILT REPORT IS VALID, AND BUILT WITH THE NETWORK TRAPPED. On a
 *      fresh embedded database with real activity, with `fetch`, `http(s)`,
 *      `net`, `tls` and `dns` replaced by functions that throw.
 *   4. THE VALIDATOR REFUSES WHAT MUST NOT BE THERE: a planted `org_id`, an
 *      unknown `ops` key, a storage kind outside the list, an `errors` of 0.
 *
 * --self-test plants `import 'node:https'` and a `fetch(` into a copy of the
 * module and requires check 2 to name both, and plants an open object into a
 * copy of the schema and requires check 1 to refuse it.
 */

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const SCHEMA_PATH = join(CORE, 'usage-report.schema.json');
const ENTRY = join(CORE, 'src', 'usage-report.ts');

const NET_MODULES = ['http', 'https', 'net', 'tls', 'dgram', 'dns', 'http2', 'undici'];
const NET_SPEC = new RegExp(`^(?:node:)?(?:${NET_MODULES.join('|')})(?:/.*)?$`);

// --- 1. schema closure ---------------------------------------------------------
export function schemaProblems(node, path = '$') {
  const out = [];
  if (node === null || typeof node !== 'object') return [`${path}: not a schema object`];
  if ('const' in node || Array.isArray(node.enum)) return out;
  const types = Array.isArray(node.type) ? node.type : [node.type];
  if (types.includes('object')) {
    if (node.additionalProperties !== false) out.push(`${path}: object without additionalProperties: false`);
    const props = Object.keys(node.properties ?? {});
    const req = new Set(node.required ?? []);
    for (const p of props) if (!req.has(p)) out.push(`${path}.${p}: declared but not required`);
    for (const [k, v] of Object.entries(node.properties ?? {})) out.push(...schemaProblems(v, `${path}.${k}`));
  }
  if (types.includes('string') && typeof node.pattern !== 'string') {
    out.push(`${path}: free-text string (needs enum, const or pattern)`);
  }
  if (types.includes('integer') || types.includes('number')) {
    if (typeof node.minimum !== 'number' || typeof node.maximum !== 'number') out.push(`${path}: unbounded number`);
  }
  if (types.includes('array')) {
    if (node.items === undefined) out.push(`${path}: array without items`);
    else out.push(...schemaProblems(node.items, `${path}[]`));
    if (typeof node.maxItems !== 'number') out.push(`${path}: array without maxItems`);
  }
  if (node.type === undefined) out.push(`${path}: no type, const or enum`);
  return out;
}

// --- 2. import graph -------------------------------------------------------------
export function networkProblems(entry) {
  const out = [];
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const specs = [];
    for (const m of code.matchAll(/^\s*import\s+(type\s+)?[^'"]*?from\s*['"]([^'"]+)['"]/gm)) {
      if (!m[1]) specs.push(m[2]);
    }
    for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]);
    for (const m of code.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    for (const m of code.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
    const rel = file.slice(CORE.length + 1);
    for (const s of specs) {
      if (NET_SPEC.test(s)) out.push(`${rel}: imports ${s}`);
      else if (s.startsWith('.')) {
        const target = resolve(dirname(file), s);
        if (existsSync(target)) visit(target);
        else out.push(`${rel}: imports ${s}, which does not resolve, so the graph is not checked past it`);
      }
    }
    if (/(^|[^\w.$])fetch\s*\(/.test(code)) out.push(`${rel}: calls fetch(`);
  };
  visit(entry);
  return { problems: out, files: seen.size };
}

if (process.argv.includes('--self-test')) {
  let bad = 0;
  const dir = mkdtempSync(join(tmpdir(), 'usage-report-selftest-'));
  // A planted copy of the module, next to copies of what it imports.
  const planted = join(dir, 'usage-report.ts');
  const original = readFileSync(ENTRY, 'utf8');
  writeFileSync(planted, `import { request } from 'node:https';\n${original}\nvoid fetch('https://example.invalid');\nvoid request;\n`);
  writeFileSync(join(dir, 'db.ts'), readFileSync(join(CORE, 'src', 'db.ts'), 'utf8'));
  const found = networkProblems(planted).problems.join('\n');
  const netOk = /imports node:https/.test(found) && /calls fetch\(/.test(found);
  if (!netOk) bad++;
  console.log(`  ${netOk ? 'ok  ' : 'FAIL'} planted import of node:https and a fetch( are both named`);

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const open = structuredClone(schema);
  delete open.properties.ops.additionalProperties;
  open.properties.lib_version = { type: 'string' };
  const sp = schemaProblems(open).join('\n');
  const schemaOk = /ops: object without additionalProperties/.test(sp) && /lib_version: free-text string/.test(sp);
  if (!schemaOk) bad++;
  console.log(`  ${schemaOk ? 'ok  ' : 'FAIL'} an opened object and a free-text string in the schema are refused`);

  const clean = schemaProblems(schema).length === 0;
  if (!clean) bad++;
  console.log(`  ${clean ? 'ok  ' : 'FAIL'} the real schema passes`);
  console.log(`check-usage-report --self-test: ${3 - bad}/3 controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

const problems = [];

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
problems.push(...schemaProblems(schema).map((p) => `schema ${p}`));

const net = networkProblems(ENTRY);
problems.push(...net.problems.map((p) => `network ${p}`));

// --- 3 and 4, against the built package ---------------------------------------
const dist = join(CORE, 'dist', 'index.js');
let built = 'not run';
if (!existsSync(dist)) {
  problems.push('runtime: packages/core/dist/index.js is missing; run `npm run build` first. Nothing was built or validated.');
} else {
  const http = await import('node:http');
  const https = await import('node:https');
  const netMod = await import('node:net');
  const tls = await import('node:tls');
  const dns = await import('node:dns');
  const attempts = [];
  const trap = (name) => () => {
    attempts.push(name);
    throw new Error(`network access attempted: ${name}`);
  };
  const saved = {
    fetch: globalThis.fetch,
    httpRequest: http.default.request, httpGet: http.default.get,
    httpsRequest: https.default.request, httpsGet: https.default.get,
    netConnect: netMod.default.connect, netCreate: netMod.default.createConnection,
    tlsConnect: tls.default.connect, dnsLookup: dns.default.lookup,
  };
  globalThis.fetch = trap('fetch');
  http.default.request = trap('http.request'); http.default.get = trap('http.get');
  https.default.request = trap('https.request'); https.default.get = trap('https.get');
  netMod.default.connect = trap('net.connect'); netMod.default.createConnection = trap('net.createConnection');
  tls.default.connect = trap('tls.connect'); dns.default.lookup = trap('dns.lookup');
  try {
    const core = await import(pathToFileURL(dist).href);
    const { db } = await core.createTestDb();
    const fl = new core.Filelayer(db, new core.MemoryStorage(), { baseUrl: 'http://localhost:3000' });
    const { id } = await fl.files.put(new TextEncoder().encode('hello'), { owner: 'alice' });
    await fl.files.get(id, { as: 'alice' });
    await fl.files.get(id, { as: 'mallory' }).catch(() => {});
    const now = new Date();
    const report = await core.buildUsageReport(db, { now, week: core.isoWeekOf(now) });
    const again = await core.buildUsageReport(db, { now, week: core.isoWeekOf(now) });
    const v = core.validateUsageReport(report);
    if (v.length) problems.push(`runtime: built report is invalid: ${v.join('; ')}`);
    if (report.install_id !== again.install_id) problems.push('runtime: install_id changed between two reports of one database');
    if (report.ops.upload !== 1 || report.ops.read_allowed !== 1 || report.ops.read_denied < 1) {
      problems.push(`runtime: counts do not match the activity (upload 1, read_allowed 1, read_denied >= 1): ${JSON.stringify(report.ops)}`);
    }
    for (const [label, mutate] of [
      ['a planted org_id', (r) => { r.org_id = 'x'; }],
      ['an unknown ops key', (r) => { r.ops.list = 1; }],
      ['a storage kind outside the list', (r) => { r.storage_kind = ['dropbox']; }],
      ['errors reported as 0', (r) => { r.errors = 0; }],
    ]) {
      const r = structuredClone(report);
      mutate(r);
      if (core.validateUsageReport(r).length === 0) problems.push(`runtime: the validator accepted ${label}`);
    }
    built = `install ${report.install_id.slice(0, 8)}, week ${report.week}`;
    await db.close?.();
  } catch (e) {
    problems.push(`runtime: ${e.message}`);
  } finally {
    globalThis.fetch = saved.fetch;
    http.default.request = saved.httpRequest; http.default.get = saved.httpGet;
    https.default.request = saved.httpsRequest; https.default.get = saved.httpsGet;
    netMod.default.connect = saved.netConnect; netMod.default.createConnection = saved.netCreate;
    tls.default.connect = saved.tlsConnect; dns.default.lookup = saved.dnsLookup;
  }
  if (attempts.length) problems.push(`runtime: network entry points were called: ${[...new Set(attempts)].join(', ')}`);
}

if (problems.length) {
  console.error('check-usage-report: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-usage-report: clean. Schema closed; ${net.files} module(s) in the import graph, no network; ` +
    `report built with the network trapped and valid (${built}); four planted violations refused.`,
);
