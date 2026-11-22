/**
 * Only regular files come back from the scorer's directory, and nothing there
 * or in the destination is followed (cold review of 21c4946, I-2 and I-4).
 *
 *   node --test harness/copy-back.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyBack, COPY_LIMIT_BYTES } from './copy-back.mjs';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'cb-'));
  const from = join(root, 'score-out');
  const to = join(root, 'task1');
  mkdirSync(from);
  mkdirSync(to);
  return { root, from, to };
}

test('a regular file is copied, and what an earlier attempt left is removed', () => {
  const { root, from, to } = dirs();
  writeFileSync(join(from, 'score.json'), '{"ok":1}');
  writeFileSync(join(to, 'check.log'), 'stale');
  const r = copyBack(from, to, ['score.json', 'check.log']);
  assert.deepEqual(r, { 'score.json': 'copied', 'check.log': 'missing' });
  assert.equal(readFileSync(join(to, 'score.json'), 'utf8'), '{"ok":1}');
  assert.equal(existsSync(join(to, 'check.log')), false);
  rmSync(root, { recursive: true });
});

test('a link, a FIFO and a directory in the scorer\'s directory are refused', () => {
  const { root, from, to } = dirs();
  const secret = join(root, 'secret');
  writeFileSync(secret, 'host file');
  symlinkSync(secret, join(from, 'install.log'));
  execFileSync('mkfifo', [join(from, 'check.log')]);
  mkdirSync(join(from, 'score.json'));
  const r = copyBack(from, to, ['install.log', 'check.log', 'score.json']);
  assert.deepEqual(r, { 'install.log': 'refused', 'check.log': 'refused', 'score.json': 'refused' });
  for (const n of ['install.log', 'check.log', 'score.json']) assert.equal(existsSync(join(to, n)), false, n);
  rmSync(root, { recursive: true });
});

test('a link already in the destination is replaced, never followed', () => {
  const { root, from, to } = dirs();
  const target = join(root, 'elsewhere');
  writeFileSync(target, 'untouched');
  symlinkSync(target, join(to, 'score.json'));
  writeFileSync(join(from, 'score.json'), '{"ok":1}');
  copyBack(from, to, ['score.json']);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(lstatSync(join(to, 'score.json')).isSymbolicLink(), false);
  rmSync(root, { recursive: true });
});

test('a file over the limit is dropped, or for a log, its end kept', () => {
  const { root, from, to } = dirs();
  writeFileSync(join(from, 'score.json'), '');
  truncateSync(join(from, 'score.json'), COPY_LIMIT_BYTES + 1);
  writeFileSync(join(from, 'install.log'), '');
  truncateSync(join(from, 'install.log'), COPY_LIMIT_BYTES + 10);
  appendFileSync(join(from, 'install.log'), 'npm error code ETIMEDOUT\n');
  const r = copyBack(from, to, ['score.json', 'install.log'], { truncate: ['install.log'] });
  assert.deepEqual(r, { 'score.json': 'refused', 'install.log': 'truncated' });
  assert.equal(existsSync(join(to, 'score.json')), false);
  assert.equal(lstatSync(join(to, 'install.log')).size, COPY_LIMIT_BYTES);
  assert.match(readFileSync(join(to, 'install.log'), 'utf8').slice(-40), /ETIMEDOUT\n$/);
  rmSync(root, { recursive: true });
});
