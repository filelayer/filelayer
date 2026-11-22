#!/usr/bin/env node
// The assertions of the "hooks" rehearsal (fake-claude.mjs), after run.mjs and
// score.mjs have run it:
//
//   node harness/check-hooks-rehearsal.mjs --runs <dir>
//
// Exit 0 when every run of the directory held; 1 with what failed. The
// rehearsal's agent leaves traps in its repository and its server reaches for
// the scorer's output (cold review of 7419ac1, NB-1 and NB-2; of 21c4946, I-2).

import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attemptLog } from './attempts.mjs';

const i = process.argv.indexOf('--runs');
const runs = i > 0 ? process.argv[i + 1] : null;
if (!runs || !existsSync(runs)) {
  console.error('usage: check-hooks-rehearsal.mjs --runs <dir>');
  process.exit(2);
}

const failed = [];
const fail = (what) => failed.push(what);

// Nothing the agent's repository holds ran on this machine.
const marks = readdirSync(tmpdir()).filter((f) => f.startsWith('prodbench-nb1-'));
if (marks.length) fail(`markers on the host: ${marks.join(', ')}`);

let seen = 0;
for (const d of readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  const runFile = join(runs, d.name, 'run.json');
  if (!existsSync(runFile)) continue;
  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  for (const t of run.tasks ?? []) {
    seen++;
    const where = `${d.name} task ${t.task}`;
    const dir = join(runs, d.name, `task${t.task}`);
    if (!t.history?.before || !t.history?.after) fail(`${where}: no history ids in run.json`);
    if (!existsSync(join(runs, d.name, 'history', `task${t.task}.git`))) fail(`${where}: no history beside the task directories`);
    if (existsSync(join(dir, 'history.git'))) fail(`${where}: a history inside the task directory`);
    if (existsSync(join(dir, 'planted.txt'))) fail(`${where}: the file the snapshot planted reached the task directory`);
    if (existsSync(join(dir, 'install.log')) && lstatSync(join(dir, 'install.log')).isSymbolicLink()) fail(`${where}: install.log is a link`);
    if ((lstatSync(dir).mode & 0o002) !== 0) fail(`${where}: the task directory is world-writable`);
    const log = attemptLog(join(dir, 'score-attempts.jsonl'));
    if (!log.length) fail(`${where}: not scored`);
    if (log.some((e) => !e.at)) fail(`${where}: the attempts log holds a line the scorer did not write`);
  }
}
if (!seen) fail('no task found');
if (failed.length) {
  for (const f of failed) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log(`hooks rehearsal: ${seen} task(s), every assertion held`);
