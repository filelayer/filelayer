/**
 * The PGlite versions createTestDb() and quickstart() accept, and the one the
 * package's own range declares, are the same set.
 *
 * @electric-sql/pglite 0.6.0 was released on 23 November 2026 and became npm's
 * latest. 0.36.0 refused it with pglite_unsupported_version, so an install with
 * no version stopped at the first quickstart(). The whole suite passes on it,
 * and from 0.36.1 it is inside the range.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pgliteSupported } from '../src/pglite-range.ts';

test('the supported PGlite versions: 0.3.11+, 0.5.8+ and every 0.6.x', () => {
  for (const v of ['0.3.11', '0.3.16', '0.5.8', '0.5.16', '0.6.0', '0.6.7']) assert.equal(pgliteSupported(v), true, v);
  for (const v of ['0.3.10', '0.4.6', '0.5.7', '0.7.0', '1.0.0', 'x']) assert.equal(pgliteSupported(v), false, v);
});

test('the runtime check and devDependencies declare the same range', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.devDependencies['@electric-sql/pglite'], '^0.3.11 || ^0.5.8 || ^0.6.0');
  assert.equal(pkg.peerDependencies?.['@electric-sql/pglite'], undefined, 'never a peer again');
});
