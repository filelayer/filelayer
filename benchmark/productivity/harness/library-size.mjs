#!/usr/bin/env node
/**
 * WHAT ARM A BRINGS ALONG: the size of the published @filelayer/core it uses.
 *
 *   node library-size.mjs [path to the installed package]
 *
 * Lines of the published dist and of schema.sql, with and without comments
 * (the shared counter's rules), its runtime and optional dependencies, and
 * the tables, indexes and functions schema.sql creates in PostgreSQL. Reported
 * next to arm A's own lines, so the library's code is not hidden.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COUNTED_EXT, countFile } from '../../loc-count.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(process.argv[2] ?? join(HERE, '..', 'reference', 'a-filelayer', 'node_modules', '@filelayer', 'core'));
const meta = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));

function count(dir, filter) {
  const out = { files: 0, gross: 0, net: 0 };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (filter(e.name)) {
        const c = countFile(p);
        out.files++;
        out.gross += c.gross;
        out.net += c.net;
      }
    }
  };
  walk(dir);
  return out;
}

const js = (n) => COUNTED_EXT.has(extname(n)) && !n.endsWith('.map') && !n.endsWith('.d.ts');
const types = (n) => n.endsWith('.d.ts');
// Statements only: comments may name a table without creating one.
const sql = readFileSync(join(pkg, 'schema.sql'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
const n = (re) => (sql.match(re) ?? []).length;
const result = {
  package: `${meta.name}@${meta.version}`,
  dist: { code: count(join(pkg, 'dist'), js), typeDeclarations: count(join(pkg, 'dist'), types) },
  schemaSql: countFile(join(pkg, 'schema.sql')),
  dependencies: { runtime: Object.keys(meta.dependencies ?? {}).sort(), optional: Object.keys(meta.optionalDependencies ?? {}).sort(), peer: Object.keys(meta.peerDependencies ?? {}).sort() },
  postgres: {
    tables: n(/CREATE TABLE/gi),
    indexes: n(/CREATE (UNIQUE )?INDEX/gi),
    functions: n(/CREATE (OR REPLACE )?FUNCTION/gi),
    triggers: n(/CREATE (OR REPLACE )?(CONSTRAINT )?TRIGGER/gi),
  },
  label: 'observed',
};
console.log(JSON.stringify(result, null, 2));
