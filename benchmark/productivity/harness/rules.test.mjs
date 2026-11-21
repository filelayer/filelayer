/**
 * The rules that decide whether a task counts, tested on the cases the cold
 * reviews named.
 *
 *   node --test rules.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFailure, egressInWindow } from './classify.mjs';

const at = (min) => new Date(Date.parse('2026-12-01T10:00:00Z') + min * 60_000).toISOString();
const win = [at(0), at(30)];
const ok = (min, host = 'registry.npmjs.org') => ({ t: at(min), method: 'CONNECT', host, allowed: true, connected: true });
const err = (min, host = 'registry.npmjs.org') => ({ t: at(min), method: 'CONNECT', host, allowed: true, error: 'ECONNRESET' });
const attempt = (min, host = 'registry.npmjs.org') => ({ t: at(min), method: 'CONNECT', host, allowed: true });

test('egress: one ECONNRESET a retry got past is recorded and does not invalidate', () => {
  const r = egressInWindow([attempt(1), ok(1), attempt(2), err(2), attempt(2.1), ok(2.1)], ...win, 5);
  assert.deepEqual(r.errors, { 'registry.npmjs.org': 1 });
  assert.equal(r.persistent.length, 0);
});

test('egress: a host down for the whole window invalidates', () => {
  const r = egressInWindow([attempt(1), err(1), attempt(9), err(9), attempt(20), err(20)], ...win, 5);
  assert.equal(r.persistent.length, 1);
  assert.match(r.persistent[0], /no successful connection/);
});

test('egress: failing five minutes in a row without a success invalidates, four does not', () => {
  const five = egressInWindow([ok(0), err(10), err(12), err(15)], ...win, 5);
  assert.equal(five.persistent.length, 1);
  const four = egressInWindow([ok(0), err(10), err(12), err(14), ok(14.5)], ...win, 5);
  assert.equal(four.persistent.length, 0);
  const broken = egressInWindow([ok(0), err(10), ok(12), err(13), err(16)], ...win, 5);
  assert.equal(broken.persistent.length, 0, 'a success in between restarts the count');
});

test('egress: only the session window counts', () => {
  const r = egressInWindow([err(-10), err(45)], ...win, 5);
  assert.deepEqual(r.errors, {});
  assert.equal(r.persistent.length, 0);
});

test('api: read from stderr whatever stopped the session', () => {
  assert.equal(apiFailure({ stoppedBy: 'wall', stderrTail: 'API Error: 529 {"type":"overloaded_error"}' }), 'api_failure');
  assert.equal(apiFailure({ stoppedBy: 'turns', stderrTail: 'Request timed out.' }), 'api_failure');
  assert.equal(apiFailure({ stoppedBy: 'finished', stderrTail: 'Credit balance is too low' }), 'api_key_exhausted');
});

test('api: an error result, by its own error text', () => {
  const r = (resultText, subtype = 'error_during_execution') => ({ claude: { isError: true, subtype, resultText } });
  assert.equal(apiFailure(r('API Error: 401 {"type":"authentication_error"}')), 'api_auth');
  assert.equal(apiFailure(r('API Error: 500 Internal server error')), 'api_failure');
  assert.equal(apiFailure(r('Credit balance is too low')), 'api_key_exhausted');
});

test('api: never the agent\'s own words', () => {
  // The agent's summary on a normal result.
  assert.equal(apiFailure({ claude: { isError: false, subtype: 'success', resultText: 'DONE. I handled 429 rate limit errors from S3.' } }), null);
  // A budget stop whose text mentions a rate limit.
  assert.equal(apiFailure({ claude: { isError: true, subtype: 'error_max_budget_usd', resultText: 'API Error: rate limit' } }), null);
  // An error result whose text is not an error message.
  assert.equal(apiFailure({ claude: { isError: true, subtype: 'error_during_execution', resultText: 'The tests hit a 503 from moto.' } }), null);
});

import { examplesReads } from './classify.mjs';

const use = (id, name, input) => ({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const PKG = '/work/app/node_modules/@filelayer/core';

test('vault: the four reads the cold review planted are all counted', () => {
  const stream = [
    // 1. A Grep over the whole package whose results include vault.
    use('t1', 'Grep', { pattern: 'shares.create', path: PKG }),
    result('t1', `${PKG}/README.md\n${PKG}/examples/vault/server.ts\n`),
    // 2. A Glob from the examples folder with a vault pattern.
    use('t2', 'Glob', { path: `${PKG}/examples`, pattern: 'vault/**' }),
    result('t2', 'server.ts\npackage.json'),
    // 3. A cd into the examples and a relative read, in one command.
    use('t3', 'Bash', { command: `cd ${PKG}/examples && cat vault/server.ts` }),
    result('t3', 'import express ...'),
    // 4. The same over two commands.
    use('t4', 'Bash', { command: `cd ${PKG}/examples` }),
    result('t4', ''),
    use('t5', 'Bash', { command: 'sed -n 1,80p vault/server.ts' }),
    result('t5', 'import express ...'),
  ];
  assert.deepEqual(examplesReads(stream), { vault: 4, other: 0 });
});

test('vault: other examples are counted apart, and unrelated reads not at all', () => {
  const stream = [
    use('a', 'Read', { file_path: `${PKG}/examples/tier3-org-roles/server.ts` }),
    result('a', '...'),
    use('b', 'Read', { file_path: `${PKG}/README.md` }),
    result('b', 'See examples/tier3-org-roles for orgs.'),
    use('c', 'Bash', { command: 'cd /work/app && ls src' }),
    result('c', 'app.mjs'),
    use('d', 'Bash', { command: 'cat src/vault.mjs' }),
    result('d', '...'),
  ];
  assert.deepEqual(examplesReads(stream), { vault: 0, other: 1 });
});

import * as V from './verdicts.mjs';

test('verdicts: less is better (H3, H5, halves of H6)', () => {
  assert.equal(V.lessIsBetter(-0.30, [-100, -1], [-0.5, -0.2]), 'confirmed', 'exactly -30 % with the interval below zero');
  assert.equal(V.lessIsBetter(-0.45, [-100, 5], [-0.6, 0.02]), 'inconclusive', 'a big effect whose interval crosses zero');
  assert.equal(V.lessIsBetter(-0.29, [-100, -1], [-0.4, -0.2]), 'inconclusive', 'just under the threshold');
  assert.equal(V.lessIsBetter(-0.05, [-10, 2], [-0.09, 0.01]), 'refuted', 'the whole interval above -10 %');
  assert.equal(V.lessIsBetter(-0.05, [-10, 2], [-0.10, 0.01]), 'inconclusive', 'an interval that reaches -10 % does not refute');
  assert.equal(V.lessIsBetter(0.2, [5, 50], [0.05, 0.4]), 'refuted', 'worse');
  assert.equal(V.lessIsBetter(null, null, null), 'not computable');
});

test('verdicts: H1, H2, H4, H6', () => {
  assert.equal(V.h1({ kA: 9, nA: 10, kB: 4, nB: 10, p: 0.0573 }), 'inconclusive');
  assert.equal(V.h1({ kA: 10, nA: 10, kB: 3, nB: 10, p: 0.003 }), 'confirmed');
  assert.equal(V.h1({ kA: 5, nA: 10, kB: 5, nB: 10, p: 1 }), 'refuted', 'a tie refutes');
  assert.equal(V.h2({ meanA: 21, meanB: 19.5, p: 0.03 }), 'confirmed');
  assert.equal(V.h2({ meanA: 21, meanB: 20.9, p: 0.5 }), 'inconclusive');
  assert.equal(V.h2({ meanA: 20, meanB: 20, p: 1 }), 'refuted', 'a tie refutes');
  assert.equal(V.h4(-0.5, [-0.8, -0.1]), 'confirmed');
  assert.equal(V.h4(-0.5, [-0.8, 0.1]), 'inconclusive');
  assert.equal(V.h4(-0.02, [-0.08, 0.05]), 'refuted');
  assert.equal(V.h4(null, null), 'not computable');
  assert.equal(V.h6('confirmed', 'confirmed'), 'confirmed');
  assert.equal(V.h6('confirmed', 'inconclusive'), 'inconclusive');
  assert.equal(V.h6('confirmed', 'refuted'), 'refuted');
});
