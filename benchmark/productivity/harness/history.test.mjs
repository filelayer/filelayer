/**
 * The snapshot is recorded without running anything the agent left in its
 * repository (cold review of d89b967, NB-1).
 *
 *   node --test harness/history.test.mjs
 *
 * The tree is what an agent could leave: husky-style hooks through
 * core.hooksPath, a clean filter, an fsmonitor command, an external diff and a
 * textconv, all in its own .git/config and .gitattributes, each writing a
 * marker when it runs. The control commits the old way (git -C <tree>) and must
 * see the markers, so the test cannot pass because the traps are dead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, cpSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { record, changed } from './history.mjs';

function trappedTree(root, marks) {
  const t = join(root, 'tree');
  mkdirSync(t, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', t, '-c', 'user.email=a@b.invalid', '-c', 'user.name=a', ...a], { stdio: 'ignore' });
  g('init', '-q');
  writeFileSync(join(t, 'a.js'), 'one\ntwo\nthree\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'agent before');
  mkdirSync(join(t, '.husky'));
  for (const h of ['pre-commit', 'post-commit', 'pre-auto-gc', 'post-index-change']) {
    writeFileSync(join(t, '.husky', h), `#!/bin/sh\ntouch "${marks}/hook-${h}"\n`);
    chmodSync(join(t, '.husky', h), 0o755);
  }
  g('config', 'core.hooksPath', '.husky');
  g('config', 'filter.evil.clean', `sh -c 'touch "${marks}/filter-clean"; cat'`);
  g('config', 'filter.evil.smudge', `sh -c 'touch "${marks}/filter-smudge"; cat'`);
  g('config', 'filter.evil.required', 'true');
  g('config', 'core.fsmonitor', `${join(t, '.husky', 'fsm')}`);
  writeFileSync(join(t, '.husky', 'fsm'), `#!/bin/sh\ntouch "${marks}/fsmonitor"\nexit 1\n`);
  chmodSync(join(t, '.husky', 'fsm'), 0o755);
  g('config', 'diff.external', `${join(t, '.husky', 'xdiff')}`);
  writeFileSync(join(t, '.husky', 'xdiff'), `#!/bin/sh\ntouch "${marks}/external-diff"\n`);
  chmodSync(join(t, '.husky', 'xdiff'), 0o755);
  g('config', 'diff.evil.textconv', `sh -c 'touch "${marks}/textconv"; cat "$0"'`);
  writeFileSync(join(t, '.gitattributes'), '* filter=evil diff=evil\n');
  return t;
}

test('the old host-side commit runs what the agent left (control)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-ctl-'));
  const marks = join(root, 'marks');
  mkdirSync(marks);
  const t = trappedTree(root, marks);
  writeFileSync(join(t, 'b.js'), 'x\n');
  const git = (...a) => spawnSync('git', ['-C', t, '-c', 'safe.directory=*', '-c', 'user.email=run@prodbench.invalid', '-c', 'user.name=run', ...a]);
  git('add', '-A');
  git('commit', '-q', '--allow-empty', '-m', 'after');
  spawnSync('git', ['-C', t, 'diff', 'HEAD~1', 'HEAD']);
  const seen = readdirSync(marks);
  assert.ok(seen.includes('filter-clean'), `clean filter ran: ${seen}`);
  assert.ok(seen.includes('hook-pre-commit'), `pre-commit hook ran: ${seen}`);
  rmSync(root, { recursive: true, force: true });
});

test('record() and changed() run nothing the agent left, and count the task\'s own lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-'));
  const marks = join(root, 'marks');
  mkdirSync(marks);
  const before = trappedTree(root, marks);
  const history = join(root, 'history.git');
  assert.ok(record(history, before, 'before'));

  // The task: one line changed, one file added, node_modules ignored. The
  // agent also commits its work in its own repository, so its HEAD~1 is no
  // longer "before the task".
  const after = join(root, 'after');
  cpSync(before, after, { recursive: true });
  writeFileSync(join(after, 'a.js'), 'one\nTWO\nthree\n');
  writeFileSync(join(after, 'b.js'), 'four\nfive\n');
  mkdirSync(join(after, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(after, 'node_modules', 'pkg', 'index.js'), 'many\nlines\n');
  writeFileSync(join(after, 'package-lock.json'), '{\n}\n');
  execFileSync('git', ['-C', after, '-c', 'core.hooksPath=/dev/null', '-c', 'user.email=a@b.invalid', '-c', 'user.name=a',
    'commit', '-q', '-a', '-m', 'agent commits'], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  // The agent's own commit ran its filter: those markers are its, inside the
  // container. Clear them, so only what record() and changed() run is seen.
  for (const f of readdirSync(marks)) rmSync(join(marks, f));

  assert.ok(record(history, after, 'after'));
  const d = changed(history);
  assert.deepEqual(readdirSync(marks), [], 'nothing the agent left ran on the host');
  // a.js: one line changed; b.js: two lines added. .gitattributes and .husky
  // are unchanged since before; node_modules and package-lock.json do not count.
  assert.deepEqual(d, { files: 2, added: 3, removed: 1 });
  rmSync(root, { recursive: true, force: true });
});

test('a file deleted by the task counts as removed lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'hist-del-'));
  const a = join(root, 'a');
  mkdirSync(a);
  writeFileSync(join(a, 'x.js'), '1\n2\n');
  writeFileSync(join(a, 'y.js'), '1\n');
  const h = join(root, 'h.git');
  assert.ok(record(h, a, 'before'));
  const b = join(root, 'b');
  mkdirSync(b);
  writeFileSync(join(b, 'y.js'), '1\n');
  assert.ok(record(h, b, 'after'));
  assert.deepEqual(changed(h), { files: 1, added: 0, removed: 2 });
  rmSync(root, { recursive: true, force: true });
});
