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
 */
import { execSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

if (task === 1 && mode === 'hang') {
  step('Thinking for a very long time.', 'Bash', { command: 'sleep 100000' });
  setInterval(() => {}, 60_000);
  await new Promise(() => {});
}

const source = task === 1 ? (mode === 'broken' ? `${arm}-t3-bug` : arm) : task === 2 ? `${arm}-t2` : arm;
step(`Writing the implementation (${source}).`, 'Write', { file_path: '/work/app/src/app.mjs' });
sh(`find /work/app -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} + && cd /fake/reference/${source} && tar --exclude=node_modules -cf - . | tar -C /work/app -xf -`);

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
process.kill(-server.pid, 'SIGTERM');

const text = `Smoke test: ${smoke}\nGitHub: ${github}\n\nDONE\nThis is the rehearsal agent; it copied ${source}.`;
step(text);
const k = turns;
emit({
  type: 'result', subtype: 'success', is_error: false, num_turns: turns,
  duration_ms: Date.now() - t0, duration_api_ms: 0,
  total_cost_usd: 0, usage: usage(k), result: text, fake: true,
});
