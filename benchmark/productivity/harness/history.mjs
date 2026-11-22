// The harness's own record of what each task changed.
//
// The agent controls everything inside /work/app, its .git included: hooks,
// core.hooksPath, filters, fsmonitor, attributes. None of that may run on the
// host, where the harness runs with the API key (cold review of d89b967,
// NB-1). So the snapshot is never committed in the agent's repository. Each
// task gets a repository of the harness's own, outside the copied tree:
// GIT_DIR is ours, no system or global configuration is read, hooks and
// fsmonitor are off in the command itself, attributes come from the empty
// tree, and the environment is only PATH and an empty HOME. The tree's own
// .git is never read, and git never adds a path named .git.
//
// The history itself lives outside every directory any container mounts
// (runs/<phase>/<run>/history/task<N>.git), so no snapshot can rewrite it
// (cold review of 7419ac1, NB-2); and git never fetches or runs a transport
// for it: protocol.allow=never and GIT_NO_LAZY_FETCH, so even a tampered config
// with a promisor remote runs nothing. The commit ids are recorded in run.json
// and the diff is taken between those ids.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SAFE = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'core.autocrlf=false',
  '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.excludesFile=/dev/null',
  '-c', 'diff.external=',
  '-c', 'user.email=run@prodbench.invalid',
  '-c', 'user.name=run',
  '-c', 'commit.gpgSign=false',
  '-c', 'protocol.allow=never',
];

let home;
function env(gitDir, workTree) {
  home ??= mkdtempSync(join(tmpdir(), 'bench-git-home-'));
  const e = {
    PATH: process.env.PATH, HOME: home, GIT_DIR: gitDir,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_SOURCE: EMPTY_TREE, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  };
  if (workTree) e.GIT_WORK_TREE = workTree;
  return e;
}

/**
 * Where a task's history lives: beside the run's task directories, never in
 * one, because the scorer mounts a task's output (cold review of 7419ac1,
 * NB-2). run.mjs writes it, analyze.mjs reads it.
 */
export const historyDir = (runDir, task) => join(runDir, 'history', `task${task}.git`);

/** git with the harness's own repository and nothing of the agent's. */
export function hgit(gitDir, workTree, args, opts = {}) {
  return spawnSync('git', [...SAFE, ...args], {
    env: env(gitDir, workTree), encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL',
    cwd: workTree ?? gitDir, ...opts,
  });
}

/**
 * Commit `tree` into the history at `gitDir` under the tag `label`; the
 * commit's id, or false. The first
 * call creates the repository. node_modules stays out whatever the tree's own
 * .gitignore says; the tree's .gitignore files still apply, as they did when
 * the diff came from the agent's repository, so build output it ignores is not
 * counted as lines changed.
 */
export function record(gitDir, tree, label) {
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(gitDir, { recursive: true });
    const init = hgit(gitDir, null, ['init', '-q', '--bare', gitDir]);
    if (init.status !== 0) return false;
    mkdirSync(join(gitDir, 'info'), { recursive: true });
    writeFileSync(join(gitDir, 'info', 'exclude'), 'node_modules/\n');
  }
  // -A: deletions since the last label count too.
  const add = hgit(gitDir, tree, ['-c', 'core.bare=false', 'add', '-A', '--', '.']);
  if (add.status !== 0) return false;
  const commit = hgit(gitDir, tree, ['-c', 'core.bare=false', 'commit', '-q', '--no-verify', '--allow-empty', '-m', label]);
  if (commit.status !== 0) return false;
  if (hgit(gitDir, null, ['tag', '-f', label]).status !== 0) return false;
  const id = hgit(gitDir, null, ['rev-parse', '--verify', `${label}^{commit}`]);
  return id.status === 0 ? id.stdout.trim() : false;
}

/**
 * git 2.40 or later: older versions ignore GIT_ATTR_SOURCE without a word
 * (Apple's git is 2.39), and the tree's attributes would then change the
 * lines counted. run.mjs refuses to start without it.
 */
export function gitVersion() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const m = /(\d+)\.(\d+)/.exec(r.stdout ?? '');
  const ok = !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 40));
  return { ok, version: (r.stdout ?? '').trim() };
}

/** Lines changed between two commits (ids from run.json), package-lock.json left out. */
export function changed(gitDir, from, to) {
  if (!/^[0-9a-f]{40,64}$/.test(from ?? '') || !/^[0-9a-f]{40,64}$/.test(to ?? '')) return null;
  const r = hgit(gitDir, null, ['diff', '--no-ext-diff', '--no-textconv', '--shortstat', from, to, '--', ':(exclude)package-lock.json']);
  if (r.status !== 0) return null;
  const n = (re) => Number(r.stdout.match(re)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), added: n(/(\d+) insertions?/), removed: n(/(\d+) deletions?/) };
}
