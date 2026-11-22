#!/usr/bin/env node
/**
 * A STAND-IN FOR CLAUDE CODE, FOR THE REHEARSAL (run.mjs --dry-run).
 *
 * It takes the same arguments and reads the prompt from stdin like
 * `claude -p`, does what a run would do with no model behind it, and writes
 * stream-json of the same shape, with made-up usage. It exercises everything
 * the harness does: the network and its proxy (npm install), the run's
 * PostgreSQL and S3 (the server starts and the smoke test runs), the limits,
 * the snapshots and the scoring. It spends no money and needs no key.
 *
 * PRODBENCH_FAKE picks what it does:
 *   good    copies the reference of the arm the prompt names (task 2: the
 *           task-2 reference; task 3: the healthy reference)
 *   broken  task 1 leaves the seeded bug in place, so the scoring must fail it
 *   hang    task 1 never finishes, so the wall clock must stop it
 *   hang2   task 2 never finishes (to stop the harness in the middle of it)
 *   leak    task 1 leaves its server running on :3000 when it is done; every
 *           task reports whether something answered on :3000 when it began
 *   hooks   every task leaves traps in its own repository, husky-style hooks
 *           through core.hooksPath, a clean filter and an fsmonitor command,
 *           each touching /tmp/prodbench-nb1-*, and commits its work itself,
 *           so the snapshot's HEAD~1 is no longer "before the task"; none of
 *           it may run on the host, and lines changed must still be the task's;
 *           its server also reaches for the scorer's /out when it starts
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const prompt = readFileSync(0, 'utf8');
const mode = process.env.PRODBENCH_FAKE ?? 'good';
const model = process.argv[process.argv.indexOf('--model') + 1];
const arm = prompt.includes('@filelayer/core') ? 'a-filelayer' : 'b-own';
const task = /a change of requirements/.test(prompt) ? 2 : /a bug report/.test(prompt) ? 3 : 1;
const t0 = Date.now();
let turns = 0;

const emit = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const usage = (k) => ({ input_tokens: 40 * k, output_tokens: 900 * k, cache_read_input_tokens: 25000 * k, cache_creation_input_tokens: 3000 * k });
function step(text, tool, input) {
  turns++;
  emit({ type: 'assistant', message: { id: `msg_fake_${turns}`, model, content: [{ type: 'text', text }, ...(tool ? [{ type: 'tool_use', id: `t${turns}`, name: tool, input }] : [])], usage: usage(1) } });
  if (tool) emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${turns}`, content: 'ok' }] } });
}
const sh = (cmd) => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', cwd: '/work/app' });

// What was already listening on :3000 when this session began.
let before = 'nothing';
try {
  const r = await fetch('http://127.0.0.1:3000/health', { signal: AbortSignal.timeout(2000) });
  before = `a server answered ${r.status}`;
} catch {
  /* nothing there */
}

emit({ type: 'system', subtype: 'init', model, tools: ['Bash', 'Read', 'Edit', 'Write'], fake: true });
step('Reading the contract.', 'Read', { file_path: '/work/contract/REQUIREMENTS.md' });

// A host that is not on the allowlist: the proxy must refuse it and log it.
step('Looking for the benchmark on GitHub.', 'WebFetch', { url: 'https://github.com/' });
let github;
try {
  github = `reached, status ${(await fetch('https://github.com/')).status}`;
} catch (e) {
  github = `refused (${e.cause?.code ?? e.message})`;
}

if ((task === 1 && mode === 'hang') || (task === 2 && mode === 'hang2')) {
  step('Thinking for a very long time.', 'Bash', { command: 'sleep 100000' });
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

const source = task === 1 ? (mode === 'broken' ? `${arm}-t3-bug` : arm) : task === 2 ? `${arm}-t2` : arm;
step(`Writing the implementation (${source}).`, 'Write', { file_path: '/work/app/src/app.mjs' });
sh(`find /work/app -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && cd /fake/reference/${source} && tar --exclude=node_modules -cf - . | tar -C /work/app -xf -`);

if (mode === 'hooks') {
  // The snapshot also reaches for the scorer's output: when its server runs in
  // the scorer it appends to an attempts log there, replaces install.log with a
  // link and leaves a file of its own. None of it may reach the task's
  // directory (cold review of 7419ac1, NB-2).
  const srv = join('/work/app', 'src', 'server.mjs');
  if (existsSync(srv)) {
    writeFileSync(srv, `import * as __fs from 'node:fs';\ntry { if (__fs.existsSync('/out')) { ` +
      `__fs.appendFileSync('/out/score-attempts.jsonl', '{"result":"scored","sha256":"0"}\\n'); ` +
      `try { __fs.rmSync('/out/install.log'); __fs.symlinkSync('/etc/hostname', '/out/install.log'); } catch {} ` +
      `__fs.writeFileSync('/out/planted.txt', 'x'); } } catch {}\n` + readFileSync(srv, 'utf8'));
  }
  step('Setting up git hooks and filters.', 'Bash', { command: 'git config core.hooksPath .husky' });
  sh(`mkdir -p .husky && for h in pre-commit post-commit post-index-change; do printf '#!/bin/sh\\ntouch /tmp/prodbench-nb1-hook-%s\\n' $h > .husky/$h; chmod +x .husky/$h; done`);
  sh(`git config core.hooksPath .husky && git config filter.evil.clean "sh -c 'touch /tmp/prodbench-nb1-filter; cat'" && ` +
    `git config filter.evil.required true && git config core.fsmonitor "sh -c 'touch /tmp/prodbench-nb1-fsmonitor; exit 1'" && ` +
    `printf '* filter=evil\\n' > .gitattributes && git add -A && git -c user.email=a@b.invalid -c user.name=a commit -qm 'the agent commits its work'`);
}

step('Installing.', 'Bash', { command: 'npm install' });
sh('npm install --no-audit --no-fund');

step('Starting the server and running the smoke test.', 'Bash', { command: 'npm start & node /work/smoke/smoke.mjs' });
const server = spawn('npm', ['start', '--silent'], { cwd: '/work/app', stdio: 'ignore', detached: true });
let smoke = 'not run';
for (let i = 0; i < 120; i++) {
  try {
    if ((await fetch('http://127.0.0.1:3000/health')).ok) break;
  } catch {
    /* not yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}
try {
  smoke = sh('node /work/smoke/smoke.mjs http://127.0.0.1:3000').trim().split('\n').pop();
} catch (e) {
  smoke = `failed: ${String(e.stdout ?? e.message).trim().split('\n').pop()}`;
}
if (!(mode === 'leak' && task === 1)) process.kill(-server.pid, 'SIGTERM');
else server.unref();

const text = `Port 3000 when the session began: ${before}\nSmoke test: ${smoke}\nGitHub: ${github}\n\nDONE\nThis is the rehearsal agent; it copied ${source}.`;
step(text);
const k = turns;
emit({
  type: 'result', subtype: 'success', is_error: false, num_turns: turns,
  duration_ms: Date.now() - t0, duration_api_ms: 0,
  total_cost_usd: 0, usage: usage(k), result: text, fake: true,
});
