/**
 * score.json is the file the scorer wrote last, and only the attempts log
 * opens a new attempt (cold review of d89b967, NI-5).
 *
 *   node --test harness/attempts.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptLog, checkScoreFile, FINAL } from './attempts.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
function task() {
  const d = mkdtempSync(join(tmpdir(), 'att-'));
  return { d, score: join(d, 'score.json'), log: join(d, 'score-attempts.jsonl') };
}
const attempt = (t, result, body) => {
  if (body !== undefined) writeFileSync(t.score, body);
  appendFileSync(t.log, JSON.stringify({ at: '2026-12-01T10:00:00Z', result, sha256: body === undefined ? null : sha(body) }) + '\n');
};

test('the file the scorer wrote last passes', () => {
  const t = task();
  attempt(t, 'scorerError', '{"scorerError":"scorer_timeout"}');
  attempt(t, 'scored', '{"functional":{}}');
  assert.equal(checkScoreFile(t.score, t.log), null);
  rmSync(t.d, { recursive: true });
});

test('a score file deleted by hand is reported, and the log still says the task is scored', () => {
  const t = task();
  attempt(t, 'scored', '{"functional":{}}');
  rmSync(t.score);
  assert.match(checkScoreFile(t.score, t.log), /score file is missing/);
  assert.ok(attemptLog(t.log).some((e) => FINAL.has(e.result)), 'score.mjs reads this and opens no attempt');
  rmSync(t.d, { recursive: true });
});

test('a score file edited or written by hand is reported', () => {
  const t = task();
  attempt(t, 'scored', '{"security":{"defended":3}}');
  writeFileSync(t.score, '{"security":{"defended":21}}');
  assert.match(checkScoreFile(t.score, t.log), /not the one the scorer wrote last/);
  const u = task();
  writeFileSync(u.score, '{"security":{"defended":21}}');
  assert.match(checkScoreFile(u.score, u.log), /no attempt behind it/);
  rmSync(t.d, { recursive: true });
  rmSync(u.d, { recursive: true });
});

test('a log line edited into nonsense closes the task rather than opening it', () => {
  const t = task();
  appendFileSync(t.log, 'not json\n');
  assert.ok(FINAL.has(attemptLog(t.log)[0].result));
  rmSync(t.d, { recursive: true });
});

test('late attacks that failed to install leave no file and no complaint', () => {
  const t = task();
  attempt(t, 'installFailed');
  assert.equal(checkScoreFile(t.score, t.log), null);
  rmSync(t.d, { recursive: true });
});
