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
 *      unknown `ops` key, a storage kind outside the list, an `errors` of 0,
 *      an `ops.unshare` of 0, a null count with no note explaining it, and
 *      emptied notes under always-null fields. And `usage-report.null-notes.json`
 *      gives every nullable field at least one real note code (1b).
 *   5. THE PUBLISHED PAGE SAYS WHAT THE SCHEMA SAYS. docs/USAGE-REPORT.md's
 *      field table, `ops` table and notes table name exactly the schema's
 *      fields, `ops` keys and note codes, both ways; its example report has
 *      exactly the schema's keys; every `ops.x` / `scale_bucket.x` it or
 *      llms.txt mentions exists, and nothing reads as a note code that is not
 *      one. A page that documents a field the report does not have is the
 *      published claim the artifact does not satisfy (D020). The package copy
 *      is held to this page by check:copies.
 *   6. THE SCHEMA'S `$id` RESOLVES. It names https://filelayer.dev/<path>, so
 *      web/<path> must exist and hold the same bytes the package ships
 *      (build:guides writes it; check:guides holds it there). The same for
 *      usage-report.null-notes.json, which the schema's $comment names.
 *   7. A STANDARD VALIDATOR COMPILES THE SCHEMA WITH ITS DEFAULTS. Ajv, draft
 *      2020-12, no options: strict mode on, so an unknown keyword is an error.
 *      0.35.1 shipped a custom `x-nullRequiresNote` keyword and failed exactly
 *      this (clean room 0.35.1); an integrator validating with defaults was
 *      stuck. The report built in check 3 must also pass Ajv, so our validator
 *      and an independent one agree on a real report.
 *
 * --self-test plants `import 'node:https'` and a `fetch(` into a copy of the
 * module and requires check 2 to name both, plants an open object into a copy
 * of the schema and requires check 1 to refuse it, and plants a field row, an
 * `ops` row, a dotted field and a note code into a copy of the page and
 * requires check 5 to refuse each. It puts `x-nullRequiresNote` back into a
 * copy of the schema, which is 0.35.1's schema, and requires check 7 to refuse
 * it.
 */

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const SCHEMA_PATH = join(CORE, 'usage-report.schema.json');
const NULL_NOTES_PATH = join(CORE, 'usage-report.null-notes.json');
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

// --- 1b. every nullable field says which notes may explain it ------------------
// usage-report.null-notes.json is what makes "a null always says why"
// enforceable. A nullable field missing from it could be null with no reason,
// and a rule that names a note code the schema does not have could never be
// satisfied.
export function nullRuleProblems(schema, nullNotes) {
  const out = [];
  const rules = nullNotes?.nullRequiresNote;
  if (!rules || typeof rules !== 'object') return ['null-notes: no nullRequiresNote object, so a null need not say why'];
  if (nullNotes.schema !== schema.$id) out.push(`null-notes: names schema ${JSON.stringify(nullNotes.schema)}, the schema is ${schema.$id}`);
  const codes = schema.properties.notes.items.enum;
  const nullable = [];
  const walk = (props, prefix) => {
    for (const [k, v] of Object.entries(props)) {
      const types = Array.isArray(v.type) ? v.type : [v.type];
      if (types.includes('null')) nullable.push(prefix + k);
      if (types.includes('object') && v.properties) walk(v.properties, `${prefix}${k}.`);
    }
  };
  walk(schema.properties, '');
  for (const f of nullable) if (!(f in rules)) out.push(`null-notes: ${f} can be null and has no rule`);
  for (const [f, list] of Object.entries(rules)) {
    if (f.startsWith('$')) continue;
    if (!nullable.includes(f)) out.push(`null-notes: ${f} is not a nullable field`);
    if (!Array.isArray(list) || list.length === 0) out.push(`null-notes: ${f} names no note`);
    else for (const c of list) if (!codes.includes(c)) out.push(`null-notes: ${f} names ${c}, which is not a note code`);
  }
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

// --- 5. the published page and llms.txt say what the schema says ----------------
const PAGE = join(ROOT, 'docs', 'USAGE-REPORT.md');
const LLMS = join(ROOT, 'llms.txt');

/** Rows of the markdown table that follows `heading`: first cell, unwrapped from backticks. */
function tableFirstCells(md, heading) {
  const at = md.indexOf(heading);
  if (at < 0) return null;
  const lines = md.slice(at).split('\n').slice(1);
  const start = lines.findIndex((l) => l.startsWith('|'));
  if (start < 0) return null;
  const cells = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|')) break;
    cells.push(l.split('|')[1].trim());
  }
  return cells;
}

const codes = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

export function pageProblems(md, schema) {
  const out = [];
  const top = Object.keys(schema.properties);
  const ops = Object.keys(schema.properties.ops.properties);
  const scale = Object.keys(schema.properties.scale_bucket.properties);
  const notes = schema.properties.notes.items.enum;
  const expectFields = top.flatMap((k) => (k === 'scale_bucket' ? scale.map((s) => `scale_bucket.${s}`) : [k]));
  const compare = (what, documented, expected) => {
    if (documented === null) { out.push(`${what}: table not found`); return; }
    const d = new Set(documented);
    for (const e of expected) if (!d.has(e)) out.push(`${what}: the schema has \`${e}\`, the page does not`);
    for (const x of d) if (!expected.includes(x)) out.push(`${what}: the page has \`${x}\`, the schema does not`);
  };
  const fieldCells = tableFirstCells(md, '## What each field means');
  compare('field table', fieldCells && fieldCells.flatMap(codes), expectFields);
  const opsCells = tableFirstCells(md, 'The `ops` counts come from');
  compare('ops table', opsCells && opsCells.flatMap(codes), ops);
  const noteCells = tableFirstCells(md, '## `null` means');
  compare('notes table', noteCells && noteCells.flatMap(codes), notes);
  // The example report has exactly the schema's keys, at both levels.
  const ex = /## What a report looks like[\s\S]*?```json\n([\s\S]*?)```/.exec(md);
  if (!ex) out.push('example: no JSON example found');
  else {
    let obj = null;
    try { obj = JSON.parse(ex[1]); } catch (e) { out.push(`example: not JSON (${e.message})`); }
    if (obj) {
      compare('example keys', Object.keys(obj), top);
      compare('example ops keys', Object.keys(obj.ops ?? {}), ops);
    }
  }
  out.push(...dottedProblems(md, schema, 'page'));
  return out;
}

/** Every `ops.x` / `scale_bucket.x` reference names a real field, and every note code is real. */
export function dottedProblems(text, schema, where) {
  const out = [];
  const ops = Object.keys(schema.properties.ops.properties);
  const scale = Object.keys(schema.properties.scale_bucket.properties);
  for (const m of text.matchAll(/`(ops|scale_bucket)\.([a-z_]+)`/g)) {
    const ok = (m[1] === 'ops' ? ops : scale).includes(m[2]);
    if (!ok) out.push(`${where}: \`${m[1]}.${m[2]}\` is not a field of the schema`);
  }
  const notes = schema.properties.notes.items.enum;
  for (const m of text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) {
    const t = m[1];
    if (/^(errors_not|unshare_not|audit_trim|no_files|no_success|lib_version_)/.test(t) && !notes.includes(t)) {
      out.push(`${where}: \`${t}\` reads as a note code and is not one`);
    }
  }
  return out;
}

export function llmsProblems(text, schema) {
  const lines = text.split('\n').filter((l) => l.includes('usage-report'));
  if (lines.length === 0) return ['llms.txt: no line about the usage report'];
  return dottedProblems(lines.join('\n'), schema, 'llms.txt');
}

// --- 6. the schema's $id is served by the site ---------------------------------
// The schema names itself by URL. A reader, or a validator, that follows the
// $id must find the same file, or the name is a claim nothing backs.
export function idProblems(schemaObj, schemaText, webRoot = join(ROOT, 'web')) {
  const id = schemaObj.$id;
  const m = /^https:\/\/filelayer\.dev\/(.+)$/.exec(id ?? '');
  if (!m) return [`$id: ${JSON.stringify(id)} is not a URL on filelayer.dev`];
  const served = join(webRoot, m[1]);
  if (!existsSync(served)) return [`$id: ${id} has no file at web/${m[1]}; run \`npm run build:guides\``];
  if (readFileSync(served, 'utf8') !== schemaText) return [`$id: web/${m[1]} differs from the schema the package ships; run \`npm run build:guides\``];
  return [];
}

// --- 7. a standard validator compiles the schema with its defaults ------------
const requireFromCore = createRequire(join(CORE, 'package.json'));
export function ajv() {
  const Ajv2020 = requireFromCore('ajv/dist/2020').default;
  return new Ajv2020();
}
export function ajvProblems(schemaObj) {
  try {
    ajv().compile(schemaObj);
    return [];
  } catch (e) {
    return [`ajv (draft 2020-12, default options) cannot compile the schema: ${e.message}`];
  }
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

  const nullNotes = JSON.parse(readFileSync(NULL_NOTES_PATH, 'utf8'));
  const noRule = structuredClone(nullNotes);
  delete noRule.nullRequiresNote.days_active;
  noRule.nullRequiresNote.errors = ['no_such_code'];
  const nr = nullRuleProblems(schema, noRule).join('\n');
  const ruleOk = /days_active can be null and has no rule/.test(nr) && /no_such_code/.test(nr) && nullRuleProblems(schema, nullNotes).length === 0;
  if (!ruleOk) bad++;
  console.log(`  ${ruleOk ? 'ok  ' : 'FAIL'} a nullable field with no rule, and a rule naming no real code, are refused`);
  const clean = schemaProblems(schema).length === 0;
  if (!clean) bad++;
  console.log(`  ${clean ? 'ok  ' : 'FAIL'} the real schema passes`);

  const page = readFileSync(PAGE, 'utf8');
  const plantedRow = page.replace('| `node_major` |', '| `host_name` | the machine it ran on |\n| `node_major` |');
  const plantedOps = page.replace('| `job_run` |', '| `list` | every listing |\n| `job_run` |');
  const plantedRef = `${page}\nSee \`ops.downloads\` and \`audit_trimmed_partly\`.\n`;
  const pageOk =
    plantedRow !== page && pageProblems(plantedRow, schema).some((p) => /host_name/.test(p)) &&
    plantedOps !== page && pageProblems(plantedOps, schema).some((p) => /`list`/.test(p)) &&
    pageProblems(plantedRef, schema).some((p) => /ops\.downloads/.test(p)) &&
    pageProblems(plantedRef, schema).some((p) => /audit_trimmed_partly/.test(p)) &&
    pageProblems(page, schema).length === 0;
  if (!pageOk) bad++;
  console.log(`  ${pageOk ? 'ok  ' : 'FAIL'} planted page field, ops row, dotted field and note code are refused; the real page passes`);
  const emptyWeb = mkdtempSync(join(tmpdir(), 'usage-report-web-'));
  const text = readFileSync(SCHEMA_PATH, 'utf8');
  const idOk = idProblems(schema, text, emptyWeb).some((p) => /has no file at web\//.test(p)) &&
    idProblems({ ...schema, $id: 'https://example.com/x.json' }, text).length === 1;
  if (!idOk) bad++;
  console.log(`  ${idOk ? 'ok  ' : 'FAIL'} an $id with no file under web/, and an $id off the domain, are refused`);
  // 0.35.1's schema: today's, with the rules back inside it as a custom keyword.
  const v0351 = { ...structuredClone(schema), 'x-nullRequiresNote': structuredClone(nullNotes.nullRequiresNote) };
  const ap = ajvProblems(v0351).join('\n');
  const ajvOk = /unknown keyword: "x-nullRequiresNote"/.test(ap) && ajvProblems(schema).length === 0;
  if (!ajvOk) bad++;
  console.log(`  ${ajvOk ? 'ok  ' : 'FAIL'} 0.35.1's schema (x-nullRequiresNote inside it) does not compile under Ajv defaults; today's does`);
  console.log(`check-usage-report --self-test: ${7 - bad}/7 controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

const problems = [];

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
problems.push(...schemaProblems(schema).map((p) => `schema ${p}`));
const nullNotesText = readFileSync(NULL_NOTES_PATH, 'utf8');
problems.push(...nullRuleProblems(schema, JSON.parse(nullNotesText)));
problems.push(...idProblems(schema, readFileSync(SCHEMA_PATH, 'utf8')));
problems.push(...idProblems({ $id: JSON.parse(nullNotesText).schema.replace(/usage-report\.schema\.json$/, 'usage-report.null-notes.json') }, nullNotesText));
problems.push(...ajvProblems(schema));

const net = networkProblems(ENTRY);
problems.push(...net.problems.map((p) => `network ${p}`));

if (!existsSync(PAGE)) problems.push('page: docs/USAGE-REPORT.md does not exist');
else problems.push(...pageProblems(readFileSync(PAGE, 'utf8'), schema).map((p) => `docs/USAGE-REPORT.md ${p}`));
problems.push(...llmsProblems(readFileSync(LLMS, 'utf8'), schema));

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
    try {
      const validate = ajv().compile(schema);
      if (!validate(report)) problems.push(`runtime: Ajv refuses the built report: ${JSON.stringify(validate.errors)}`);
    } catch {
      // check 7 already names a schema Ajv cannot compile.
    }
    if (report.install_id !== again.install_id) problems.push('runtime: install_id changed between two reports of one database');
    if (report.ops.upload !== 1 || report.ops.read_allowed !== 1 || report.ops.read_denied < 1) {
      problems.push(`runtime: counts do not match the activity (upload 1, read_allowed 1, read_denied >= 1): ${JSON.stringify(report.ops)}`);
    }
    for (const [label, mutate] of [
      ['a planted org_id', (r) => { r.org_id = 'x'; }],
      ['an unknown ops key', (r) => { r.ops.list = 1; }],
      ['a storage kind outside the list', (r) => { r.storage_kind = ['dropbox']; }],
      ['errors reported as 0', (r) => { r.errors = 0; }],
      ['ops.unshare reported as 0', (r) => { r.ops.unshare = 0; }],
      ['ops.upload null without audit_trimmed or before_install', (r) => { r.ops.upload = null; }],
      ['notes emptied while errors is null', (r) => { r.notes = []; }],
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
    `report built with the network trapped and valid (${built}), and Ajv agrees; seven planted violations refused; ` +
    'Ajv compiles the schema with its defaults; schema and null-notes served at their URLs; ' +
    'docs/USAGE-REPORT.md tables, example and llms.txt agree with the schema.',
);
