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

test('egress: an essential host down for the whole window invalidates', () => {
  const r = egressInWindow([attempt(1), err(1), attempt(9), err(9), attempt(20), err(20)], ...win, 5);
  assert.equal(r.persistent.length, 1);
  assert.match(r.persistent[0], /no successful connection/);
});

test('egress: one failed attempt never decides, even with no success', () => {
  const r = egressInWindow([attempt(3, 'api.anthropic.com'), err(3, 'api.anthropic.com')], ...win, 5);
  assert.deepEqual(r.errors, { 'api.anthropic.com': 1 });
  assert.equal(r.persistent.length, 0);
});

test('egress: a documentation host is recorded and never invalidates', () => {
  const docs = 'docs.aws.amazon.com';
  const r = egressInWindow([err(1, docs), err(2, docs), err(9, docs)], ...win, 5);
  assert.deepEqual(r.errors, { [docs]: 3 });
  assert.equal(r.persistent.length, 0);
});

test('egress: five minutes of continuous failing invalidates; four, a success between, or sparse errors do not', () => {
  const five = egressInWindow([ok(0), err(10), err(11.5), err(13), err(14.2), err(15)], ...win, 5);
  assert.equal(five.persistent.length, 1);
  const four = egressInWindow([ok(0), err(10), err(12), err(14), ok(14.5)], ...win, 5);
  assert.equal(four.persistent.length, 0);
  const broken = egressInWindow([ok(0), err(10), ok(12), err(13), err(16)], ...win, 5);
  assert.equal(broken.persistent.length, 0, 'a success in between restarts the count');
  const sparse = egressInWindow([ok(0), err(10), err(15.5)], ...win, 5);
  assert.equal(sparse.persistent.length, 0, 'two errors 5 minutes apart with nothing between are not a streak');
});

test('egress: only the session window counts', () => {
  const r = egressInWindow([err(-10), err(45)], ...win, 5);
  assert.deepEqual(r.errors, {});
  assert.equal(r.persistent.length, 0);
});

test('api: never when the session ended for the agent\'s reason, whatever it retried', () => {
  // A budget stop with a retried 429 on stderr: valid.
  assert.equal(apiFailure({ stoppedBy: 'budget', claude: { isError: true, subtype: 'error_max_budget_usd', resultText: 'x' },
    stderrTail: 'API Error (429 rate_limit_error) retrying in 2s' }), null);
  // A session that finished after a retried 529: valid.
  assert.equal(apiFailure({ stoppedBy: 'finished', claude: { isError: false, subtype: 'success', resultText: 'DONE' },
    stderrTail: 'API Error: 529 {"type":"overloaded_error"} Retrying' }), null);
  // A turn stop after a timeout that was retried: valid.
  assert.equal(apiFailure({ stoppedBy: 'turns', stderrTail: 'Request timed out.' }), null);
});

// A session of an hour: started at 0, its last response at 59, ended at 60,
// unless a case says otherwise.
const sess = (o) => ({ startedAt: at(0), lastResponseAt: at(59), endedAt: at(60), ...o });

test('api: an error or exit stop, with Claude Code\'s own error line at the end', () => {
  assert.equal(apiFailure(sess({ stoppedBy: 'error', claude: { isError: true, subtype: 'error_during_execution', resultText: 'API Error: 529 {"type":"overloaded_error"}' } })), 'api_failure');
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'something\nAPI Error: 500 Internal server error', apiErrorTimes: [at(59.8)] })), 'api_failure');
  assert.equal(apiFailure(sess({ stoppedBy: 'error', claude: { isError: true, subtype: 'error_during_execution', resultText: 'API Error: 401 {"type":"authentication_error"}' } })), 'api_auth');
  assert.equal(apiFailure(sess({ stoppedBy: 'error', stderrTail: 'Credit balance is too low', apiErrorTimes: [at(59.9)] })), 'api_key_exhausted');
});

test('api: success with is_error true is Claude Code reporting a failed call, not the agent finishing (NI-1)', () => {
  // The shape Claude Code uses when the API call failed after its retries.
  const failed = { isError: true, subtype: 'success', resultText: 'API Error: 529 {"type":"overloaded_error","message":"Overloaded"}' };
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', claude: failed })), 'api_failure');
  assert.equal(apiFailure(sess({ stoppedBy: 'error', claude: { ...failed, resultText: 'Credit balance is too low' } })), 'api_key_exhausted');
  // The same subtype without is_error is the agent finishing: never.
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', claude: { ...failed, isError: false }, stderrTail: 'API Error: 529', apiErrorTimes: [at(59.9)] })), null);
  // A budget or turn subtype is the agent's limit whatever is_error says.
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', claude: { ...failed, subtype: 'error_max_turns' } })), null);
});

test('api: an error or exit stop counts only an API error after the last response, near the end (NI-2)', () => {
  // pkill node kills claude (exit_143) twenty minutes after a 429 that a retry
  // got past: the agent's own doing, valid.
  const retried = { stoppedBy: 'exit_143', stderrTail: 'API Error (429 rate_limit_error) retrying in 2s', apiErrorTimes: [at(39)], lastResponseAt: at(40) };
  assert.equal(apiFailure(sess(retried)), null, 'the 429 was before the last response');
  // The same a second before the end: a 429, the retry answered, then pkill.
  assert.equal(apiFailure(sess({ ...retried, apiErrorTimes: [at(59.8)], lastResponseAt: at(59.9) })), null, 'the retry answered after the 429');
  // An error after the last response, but long before the end, is not what ended it.
  assert.equal(apiFailure(sess({ ...retried, lastResponseAt: at(30), apiErrorTimes: [at(40)] })), null, 'the last error was 20 minutes before the end');
  // The same exit right after an error with no response since: the API.
  assert.equal(apiFailure(sess({ ...retried, lastResponseAt: at(30), apiErrorTimes: [at(40), at(59.5)] })), 'api_failure');
  // Records without times (written before apiErrorTimes) are read through lastApiErrorAt.
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'API Error: 500', lastApiErrorAt: at(59.9) })), 'api_failure');
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'API Error: 500' })), null, 'no time, no evidence');
});

test('api: never a bare number or word, and only whole error lines (LINE is anchored)', () => {
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'Warning: heap at 512 MB', apiErrorTimes: [at(59.9)] })), null);
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'see the billing page', apiErrorTimes: [at(59.9)] })), null);
  assert.equal(apiFailure(sess({ stoppedBy: 'error', claude: { isError: true, subtype: 'error_during_execution', resultText: 'The tests hit a 503 from moto.' } })), null);
  assert.equal(apiFailure({ claude: { isError: false, subtype: 'success', resultText: 'DONE. I handled 429 rate limit errors from S3.' } }), null);
  // The words in the middle of a line the agent's tools printed are not
  // Claude Code's line, which starts the line.
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'npm warn: saw "API Error: 500" in a fixture', apiErrorTimes: [at(59.9)] })), null);
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'log: Connection error retrying', apiErrorTimes: [at(59.9)] })), null);
  // Leading whitespace is still the start of the line.
  assert.equal(apiFailure(sess({ stoppedBy: 'exit_1', stderrTail: 'x\n   API Error: 500', apiErrorTimes: [at(59.9)] })), 'api_failure');
});

test('api: a wall-clock stop counts only if the API was still failing at the end (NI-3)', () => {
  const base = { stoppedBy: 'wall', stderrTail: 'API Error: 529 overloaded\nAPI Error: 529 overloaded', startedAt: at(0), endedAt: at(60) };
  assert.equal(apiFailure({ ...base, lastResponseAt: at(55), apiErrorTimes: [at(57), at(59.5)] }), 'api_failure', 'silent for 5 minutes, failing at the end');
  assert.equal(apiFailure({ ...base, lastResponseAt: at(55), apiErrorTimes: [at(59.5)] }), null, 'one error never decides');
  assert.equal(apiFailure({ ...base, lastResponseAt: at(55), apiErrorTimes: [at(56), at(57)] }), null, 'the last error three minutes before the end');
  assert.equal(apiFailure({ ...base, lastResponseAt: at(50), apiErrorTimes: [at(20), at(21)] }), null, 'the errors were before the last response');
  // The case that needs the silence condition: two recent errors after a
  // response 30 seconds before the end. It was still answering.
  assert.equal(apiFailure({ ...base, lastResponseAt: at(59.5), apiErrorTimes: [at(59.6), at(59.8)] }), null, 'it was still answering');
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
    // 5. A cd into examples/vault, then a read with no "vault" in it.
    use('t6', 'Bash', { command: `cd ${PKG}/examples/vault` }),
    result('t6', ''),
    use('t7', 'Bash', { command: 'cat server.ts' }),
    result('t7', 'import express ...'),
  ];
  assert.deepEqual(examplesReads(stream), { vault: 5, other: 0 });
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

import { readFileSync } from 'node:fs';
import { worstCaseMinutes, SPARE_MINUTES, ATTACK_MS, bounded } from '../hidden/bounds.mjs';
import { CHECKS as F_CHECKS } from '../hidden/functional.mjs';
import { CHECKS as T2_CHECKS } from '../hidden/task2.mjs';
import { CHECKS as T3_CHECKS } from '../hidden/task3.mjs';
import { ATTACKS } from '../../adversarial/attacks.mjs';

test('bounds: the per-check limits can never add up to the scorer\'s global limit (NI-4)', () => {
  const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const counts = { installMinutes: cfg.scoring.installMinutes, functional: F_CHECKS.length, task2: T2_CHECKS.length, task3: T3_CHECKS.length, attacks: ATTACKS.length };
  const worst = worstCaseMinutes(counts);
  assert.ok(cfg.scoring.globalTimeoutMinutes >= worst + SPARE_MINUTES,
    `global ${cfg.scoring.globalTimeoutMinutes} min, worst case ${worst} min + spare ${SPARE_MINUTES}`);
  // The late attacks are scored in a run of their own, under the same limit:
  // this many fit, and late/README.md says so.
  const lateFit = Math.floor((cfg.scoring.globalTimeoutMinutes - SPARE_MINUTES - cfg.scoring.installMinutes - 1) / (ATTACK_MS / 60_000));
  assert.ok(worstCaseMinutes({ ...counts, late: lateFit }) + SPARE_MINUTES <= cfg.scoring.globalTimeoutMinutes);
  assert.ok(lateFit >= 40, `room for ${lateFit} late attacks`);
});

test('bounds: work past its limit is cancelled, so it cannot reach the service during the next check', async () => {
  let requestsAfter = 0;
  let aborted = false;
  const work = (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; });
    setTimeout(() => { if (!signal.aborted) requestsAfter++; resolve('late'); }, 80);
  });
  await assert.rejects(bounded(20, 'slow check', work), /slow check took more than/);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(aborted, true);
  assert.equal(requestsAfter, 0);
  assert.equal(await bounded(200, 'quick', async () => 'ok'), 'ok');
});

import { maxCostPerRun, phaseFits, runsThatStart, startNeedUsd } from './money.mjs';

test('money: the figures of PREREG.md "Money" (NI-6)', () => {
  const cfg = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
  const need = startNeedUsd(cfg);
  assert.equal(need, 36);
  const cells = cfg.models.length * cfg.arms.length;
  const pilot = cfg.runsPerCell.pilot * cells;
  const full = cfg.runsPerCell.full * cells;
  assert.equal(pilot, 8);
  assert.equal(full, 40);
  // Central and high estimates of a run, the mean of the two models.
  const central = (5 + 2.5) / 2;
  const high = central * 2.5;
  const caps = cfg.phaseCapUsd;
  // The two caps together never exceed the approved ceiling (NI-a).
  assert.ok(caps.pilot + caps.full <= cfg.approvedCeilingUsd, `${caps.pilot} + ${caps.full} > ${cfg.approvedCeilingUsd}`);
  // The pilot's cap starts all 8 runs at the high estimate, and 3 at the
  // limits ($27 a run).
  assert.ok(phaseFits({ capUsd: caps.pilot, costPerRun: high, needUsd: need, runs: pilot }), `pilot cap ${caps.pilot}`);
  assert.equal(runsThatStart({ capUsd: caps.pilot, costPerRun: 27, needUsd: need, runs: pilot }), 3);
  // ...but not a replacement for an invalid pilot run: 9 runs need
  // 8 x 9.375 + 36 = 111 (PREREG says so).
  assert.equal(phaseFits({ capUsd: caps.pilot, costPerRun: high, needUsd: need, runs: pilot + 1 }), caps.pilot >= 111);
  // The full phase's cap starts all 40 at the central estimate, and not at
  // the high one: then the full phase needs a new approval (PREREG says so).
  assert.ok(phaseFits({ capUsd: caps.full, costPerRun: central, needUsd: need, runs: full }));
  assert.equal(phaseFits({ capUsd: caps.full, costPerRun: high, needUsd: need, runs: full }), false);
  assert.equal(Math.floor(maxCostPerRun({ capUsd: caps.full, needUsd: need, runs: full }) * 100) / 100, 9.07);
});

import { installVerdict } from './install-verdict.mjs';
import { mkdtempSync as mkd, writeFileSync as wf } from 'node:fs';
import { tmpdir as tmpd } from 'node:os';
import { join as pj } from 'node:path';

test('install: a timeout is the scorer\'s only when npm failed the way a network fails', () => {
  const dir = (exit, log, egress = []) => {
    const d = mkd(pj(tmpd(), 'inst-'));
    wf(pj(d, 'install.exit'), `${exit}\n`);
    wf(pj(d, 'install.log'), log);
    wf(pj(d, 'score-egress.jsonl'), egress.map((e) => JSON.stringify(e)).join('\n'));
    return d;
  };
  const blip = [{ host: 'registry.npmjs.org', allowed: true, error: 'ECONNRESET' }];
  // A slow install with one connection error a retry got past: the agent's.
  assert.equal(installVerdict(dir(124, 'npm http fetch GET 200 https://registry.npmjs.org/x\n', blip)).network, false);
  // A timeout with npm reporting a network failure: the scorer's.
  assert.equal(installVerdict(dir(124, 'npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/x failed\n')).network, true);
  // Not a timeout: an egress error to the registry still counts, as before.
  assert.equal(installVerdict(dir(1, 'npm error something\n', blip)).network, true);
  // npm's own verdict on the package wins.
  assert.equal(installVerdict(dir(1, 'npm error code ETARGET\n', blip)).network, false);
});

test('api: a session stopped by its own turns or budget is never the API\'s, without a result too (nit a)', () => {
  const recent = { stderrTail: 'API Error: 529\nAPI Error: 529', startedAt: at(0), lastResponseAt: at(50), endedAt: at(60), apiErrorTimes: [at(59.5), at(59.9)] };
  for (const stoppedBy of ['turns', 'budget', 'finished']) assert.equal(apiFailure({ ...recent, stoppedBy }), null, stoppedBy);
  assert.equal(apiFailure({ ...recent, stoppedBy: 'exit_1' }), 'api_failure', 'the same evidence counts for an exit');
});

test('install: a timeout while the registry kept failing is the scorer\'s (nit d)', () => {
  const d = mkd(pj(tmpd(), 'inst-'));
  wf(pj(d, 'install.exit'), '124\n');
  wf(pj(d, 'install.log'), '');
  const e = (o) => JSON.stringify({ host: 'registry.npmjs.org', allowed: true, ...o });
  wf(pj(d, 'score-egress.jsonl'), [e({ connected: true }), e({ error: 'ETIMEDOUT' }), e({ error: 'ETIMEDOUT' })].join('\n'));
  assert.equal(installVerdict(d).network, true, 'two errors and no success after them');
  wf(pj(d, 'score-egress.jsonl'), [e({ error: 'ETIMEDOUT' }), e({ error: 'ETIMEDOUT' }), e({ connected: true })].join('\n'));
  assert.equal(installVerdict(d).network, false, 'it connected again afterwards');
  wf(pj(d, 'score-egress.jsonl'), [e({ connected: true }), e({ error: 'ETIMEDOUT' })].join('\n'));
  assert.equal(installVerdict(d).network, false, 'one error never decides');
});
