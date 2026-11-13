#!/usr/bin/env node
/**
 * VENDOR LINES IN YOUR PROCESS OR YOUR DATABASE.
 *
 *     node benchmark/count-vendor.mjs          # print the table
 *     node benchmark/count-vendor.mjs --json
 *
 * count-loc.mjs counts what the developer writes and leaves vendor code out, for
 * every implementation. That is the right headline and it hides something: the
 * Filelayer library is about seventeen thousand lines that run inside your
 * process, and its schema.sql runs inside your database. A review of the
 * benchmark (2026-11-03, finding 4) called that "counted as zero". This is the
 * column that stops it being zero.
 *
 * What is counted, per implementation, with one counting method (non-blank,
 * non-comment lines, the NET of count-loc.mjs):
 *
 *   process   the approach-specific packages the application imports, and their
 *             production dependencies, transitively, as installed: every .js,
 *             .cjs and .mjs file, leaving out type declarations, source maps,
 *             tests and the duplicate ESM build that AWS packages ship beside
 *             the one Node loads (dist-es). Filelayer: @filelayer/core.
 *             Raw S3: @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner.
 *   database  SQL the vendor puts into a database you run. Filelayer:
 *             schema.sql. Raw S3: none.
 *
 * Left out for every implementation alike: the Postgres driver, the web
 * framework and the test database, which are the same kind of thing whichever
 * approach you take. Supabase, Convex and Vercel Blob are "not measured": their
 * vendor code runs on the vendor's platform, or installs into a database the
 * repository only emulates, and a number for it would be a guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JSON_OUT = process.argv.includes('--json');

let GROSS = 0;
function net(file) {
  const ext = path.extname(file);
  GROSS += fs.readFileSync(file, 'utf8').split('\n').length;
  const sql = ext === '.sql';
  let inBlock = false;
  let n = 0;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    if (line.startsWith('/*')) {
      const end = line.indexOf('*/', 2);
      if (end < 0) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
      if (!line) continue;
    }
    if (line.startsWith('//') || (sql && line.startsWith('--'))) continue;
    n += 1;
  }
  return n;
}

const SKIP = /(^|\/)(node_modules|dist-es|dist-types|test|tests|__tests__)(\/|$)/;
function jsLines(dir) {
  let lines = 0;
  let files = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (SKIP.test(rel)) continue;
      if (e.isDirectory()) walk(p);
      else if (/\.(c|m)?js$/.test(e.name)) {
        lines += net(p);
        files += 1;
      }
    }
  };
  walk(dir);
  return { lines, files };
}

/** Find a package as Node would from `fromDir`, walking up node_modules. */
function locate(name, fromDir, stopAt) {
  let d = fromDir;
  for (;;) {
    const p = path.join(d, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return path.dirname(p);
    if (d === stopAt) return null;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function closure(root, names) {
  const seen = new Map();
  const queue = names.map((n) => [n, root]);
  while (queue.length) {
    const [name, from] = queue.shift();
    const dir = locate(name, from, root);
    if (!dir || seen.has(dir)) continue;
    seen.set(dir, name);
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push([dep, dir]);
  }
  let lines = 0;
  let files = 0;
  for (const dir of seen.keys()) {
    const c = jsLines(dir);
    lines += c.lines;
    files += c.files;
  }
  return { packages: seen.size, files, lines };
}

const coreDir = path.join(HERE, 'node_modules', '@filelayer', 'core');
const coreVersion = JSON.parse(fs.readFileSync(path.join(coreDir, 'package.json'), 'utf8')).version;
GROSS = 0;
const fl = jsLines(path.join(coreDir, 'dist'));
const flGross = GROSS;
GROSS = 0;
const flDb = net(path.join(coreDir, 'schema.sql'));
const flDbGross = GROSS;
GROSS = 0;
const s3Root = path.join(HERE, 'baseline-raw-s3');
const s3 = closure(s3Root, ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']);
const s3Gross = GROSS;
const g = (n) => n.toLocaleString('en-US');

const rows = [
  {
    impl: 'filelayer',
    process: fl.lines,
    database: flDb,
    what: `@filelayer/core ${coreVersion}: ${fl.files} files of dist/ (${g(flGross)} lines with comments and blanks), and schema.sql (${g(flDbGross)})`,
  },
  {
    impl: 'raw-s3',
    process: s3.lines,
    database: 0,
    what: `@aws-sdk/client-s3 and s3-request-presigner: ${s3.packages} packages, ${s3.files} files (${g(s3Gross)} lines with comments and blanks)`,
  },
  { impl: 'supabase', process: null, database: null, what: 'not measured: platform code runs on Supabase, and its storage and auth schemas are emulated here' },
  { impl: 'convex', process: null, database: null, what: 'not measured: not executed' },
  { impl: 'vercel-blob', process: null, database: null, what: 'not measured: not executed' },
];

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const f = (n) => (n === null ? 'not measured' : n.toLocaleString('en-US'));
  console.log('| Implementation | Vendor lines in your process | Vendor lines in your database | What |');
  console.log('|---|---:|---:|---|');
  for (const r of rows) console.log(`| ${r.impl} | ${f(r.process)} | ${f(r.database)} | ${r.what} |`);
}
