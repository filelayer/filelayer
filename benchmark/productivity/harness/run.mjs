#!/usr/bin/env node
/**
 * RUN ONE PHASE OF THE PRODUCTIVITY BENCHMARK.
 *
 *   node run.mjs --plan ../runs/pilot/plan.json [--only <run id>] [--dry-run]
 *                [--proxy container|host] [--upstream http://host:port] [--extra-ca file]
 *
 * For each run of the plan, in order:
 *
 *   1. A new internal Docker network with no route out, a new PostgreSQL and
 *      a new moto (S3) container on it, and the egress proxy (egress-proxy.mjs)
 *      as the only way out, to the hosts in allowlist.txt.
 *   2. A new agent container (images/agent.Dockerfile) holding /work/contract
 *      and /work/smoke. Nothing of the hidden checks is ever in it.
 *   3. Tasks 1, 2 and 3, each a new Claude Code session (`claude -p`) with the
 *      prompt built from prompts/, the model of the run, and the limits of
 *      config.json. Task 2 starts from the reference of the run's arm, task 3
 *      from its seeded reference, each with its own database and bucket. The
 *      session's stream-json is the record of the task.
 *   4. A snapshot of /work/app after each task, without node_modules.
 *
 * The scoring (score.mjs) runs afterwards, in another container, from the
 * snapshots alone.
 *
 * The API key is read from ANTHROPIC_API_KEY in this process's environment
 * and handed to the container by name (`docker run -e ANTHROPIC_API_KEY`), so
 * it never appears in an argument list, a log or a file. --dry-run uses
 * fake-claude.mjs instead of Claude Code and needs no key.
 *
 * Money: before each run the phase's spend so far is read from the results.
 * A run starts only if what remains of the phase cap covers the full budgets
 * of its three tasks, so no session ever gets a budget cut short by the cap
 * (which would stop it for a reason that has nothing to do with the agent).
 * Otherwise the phase stops there.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './fingerprint.mjs';
import { taskSpend, usageCounter } from './usage.mjs';
import { apiFailure, STOPS_THE_PHASE } from './classify.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '..');
const args = process.argv.slice(2);
const arg = (name, dflt = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const flag = (name) => args.includes(name);

const planFile = resolve(arg('--plan') ?? '');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const DRY = flag('--dry-run');
const proxyMode = arg('--proxy', 'container');
const upstream = arg('--upstream');
const extraCa = arg('--extra-ca') ? resolve(arg('--extra-ca')) : null;
const only = arg('--only');
const outRoot = dirname(planFile);
// A dry run can shorten the clocks to exercise the limits.
const wallScale = Number(arg('--wall-scale', '1'));

// The files the preregistration fixed, as they are now.
const FP = fingerprint();
if (!DRY) {
  const committed = existsSync(join(BENCH, 'FINGERPRINT.txt')) ? readFileSync(join(BENCH, 'FINGERPRINT.txt'), 'utf8') : '';
  if (committed !== FP.text) {
    console.error('The benchmark files differ from FINGERPRINT.txt. A real run uses exactly what PREREG.md fixed.');
    process.exit(2);
  }
}

if (!DRY && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. A real run needs it; a rehearsal is --dry-run.');
  process.exit(2);
}

// --- docker ------------------------------------------------------------------

function docker(argv, { input, allowFail = false } = {}) {
  const r = spawnSync('docker', argv, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${argv.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).slice(-600)}`);
  }
  return r;
}
const exec = (c, cmd, { user = 'agent', env = {}, input, allowFail } = {}) =>
  docker(['exec', '-i', '-u', user, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c, 'bash', '-lc', cmd],
    { input, allowFail });

function waitHealthy(container, probe, ms = 60_000) {
  const until = Date.now() + ms;
  for (;;) {
    if (docker(['exec', container, 'sh', '-c', probe], { allowFail: true }).status === 0) return;
    if (Date.now() > until) throw new Error(`${container} not ready after ${ms} ms`);
    spawnSync('sleep', ['0.5']);
  }
}

function imageTag(kind) {
  const v = kind === 'agent' ? cfg.claudeCode : 'v1';
  return `prodbench-${kind}${DRY && kind === 'agent' ? '-dry' : ''}:${v}`;
}

function buildImages() {
  const agent = imageTag('agent');
  if (docker(['image', 'inspect', agent], { allowFail: true }).status !== 0) {
    if (DRY) {
      // The rehearsal image: the same base, with fake-claude.mjs as `claude`.
      docker(['build', '-q', '-t', agent, '-f', join(HERE, 'images', 'agent-dry.Dockerfile'), HERE]);
    } else {
      docker(['build', '-q', '-t', agent, '--build-arg', `CLAUDE_CODE_VERSION=${cfg.claudeCode}`,
        '-f', join(HERE, 'images', 'agent.Dockerfile'), HERE]);
    }
  }
}

// --- the environment of one run ------------------------------------------------

function startServices(name, dir) {
  const net = `pb-${name}`;
  docker(['network', 'create', '--internal', net]);
  const gw = docker(['network', 'inspect', net, '-f', '{{(index .IPAM.Config 0).Gateway}}']).stdout.trim();
  const pg = `${net}-pg`;
  const s3 = `${net}-s3`;
  docker(['run', '-d', '--name', pg, '--network', net, '--network-alias', 'postgres',
    '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_DB=app', cfg.images.postgres]);
  docker(['run', '-d', '--name', s3, '--network', net, '--network-alias', 's3', cfg.images.s3]);
  waitHealthy(pg, 'pg_isready -U postgres -d app');
  const proxy = startProxy(net, gw, name, dir);
  return { net, pg, s3, proxy, containers: [pg, s3] };
}

function startProxy(net, gw, name, dir) {
  const logFile = join(dir, 'egress.jsonl');
  const allow = join(HERE, 'allowlist.txt');
  if (proxyMode === 'host') {
    // The proxy is a process on this machine, bound to the internal network's
    // gateway address: the one address the containers can reach.
    const child = spawn(process.execPath, [join(HERE, 'egress-proxy.mjs'), '--port', '3128', '--listen', gw,
      '--allow', allow, '--log', logFile, ...(upstream ? ['--upstream', upstream] : [])], { stdio: 'ignore' });
    return { url: `http://${gw}:3128`, stop: () => child.kill('SIGTERM') };
  }
  // The proxy is a container on the internal network and on the default one.
  const c = `pb-${name}-proxy`;
  docker(['run', '-d', '--name', c, '--network', net, '--network-alias', 'egress',
    '-v', `${join(HERE, 'egress-proxy.mjs')}:/proxy.mjs:ro`, '-v', `${allow}:/allow.txt:ro`,
    '-v', `${dirname(logFile)}:/log`, cfg.images.node,
    'node', '/proxy.mjs', '--port', '3128', '--allow', '/allow.txt', '--log', '/log/egress.jsonl']);
  docker(['network', 'connect', 'bridge', c]);
  return { url: 'http://egress:3128', stop: () => docker(['rm', '-f', c], { allowFail: true }) };
}

function stopServices(s, agent) {
  for (const c of [agent, ...s.containers].filter(Boolean)) docker(['rm', '-f', c], { allowFail: true });
  s.proxy.stop();
  docker(['network', 'rm', s.net], { allowFail: true });
}

// The contract's variables for one task. Each task has a database and a bucket
// of its own: tasks 2 and 3 start from a reference, not from task 1.
function contractEnv(task, adminToken) {
  const db = task === 1 ? 'app' : `app${task}`;
  return {
    DATABASE_URL: `postgres://postgres:postgres@postgres:5432/${db}`,
    S3_ENDPOINT: 'http://s3:5000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: task === 1 ? 'documents' : `documents${task}`,
    S3_ACCESS_KEY_ID: 'benchmark',
    S3_SECRET_ACCESS_KEY: 'benchmark-secret',
    BASE_URL: 'http://127.0.0.1:3000',
    PORT: '3000',
    ADMIN_TOKEN: adminToken,
  };
}

function startAgent(name, s, run) {
  const c = `pb-${name}-agent`;
  const caArgs = extraCa
    ? ['-v', `${extraCa}:/etc/prodbench-ca.crt:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/etc/prodbench-ca.crt',
       '-e', 'npm_config_cafile=/etc/prodbench-ca.crt', '-e', 'SSL_CERT_FILE=/etc/prodbench-ca.crt']
    : [];
  const dryArgs = DRY ? ['-v', `${join(BENCH, 'reference')}:/fake/reference:ro`, '-e', `PRODBENCH_FAKE=${run.fake ?? 'good'}`] : [];
  docker(['run', '-d', '--name', c, '--network', s.net, '--cpus', '2', '--memory', '4g', '--pids-limit', '2048',
    '-e', `HTTPS_PROXY=${s.proxy.url}`, '-e', `https_proxy=${s.proxy.url}`,
    '-e', 'NO_PROXY=postgres,s3,localhost,127.0.0.1', '-e', 'no_proxy=postgres,s3,localhost,127.0.0.1',
    '-e', `npm_config_proxy=${s.proxy.url}`, '-e', `npm_config_https_proxy=${s.proxy.url}`,
    '-e', 'NODE_USE_ENV_PROXY=1',
    '-e', 'DISABLE_TELEMETRY=1', '-e', 'DISABLE_AUTOUPDATER=1', '-e', 'DISABLE_ERROR_REPORTING=1',
    '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    ...(DRY ? [] : ['-e', 'ANTHROPIC_API_KEY']),
    ...caArgs, ...dryArgs, imageTag('agent'), 'sleep', 'infinity']);
  // The contract and the smoke test, owned by root and read-only to the agent.
  const tar = spawnSync('tar', ['-C', BENCH, '-cf', '-', 'contract', 'smoke']);
  docker(['exec', '-i', '-u', 'root', c, 'tar', '-C', '/work', '-xf', '-'], { input: tar.stdout });
  docker(['exec', '-u', 'root', c, 'sh', '-c', 'chown -R root:root /work/contract /work/smoke && chmod -R a+rX,go-w /work/contract /work/smoke']);
  // The bucket of each task, made once.
  for (const b of ['documents', 'documents2', 'documents3']) {
    exec(c, `node -e "fetch('http://s3:5000/${b}',{method:'PUT'}).then(r=>process.exit(r.ok?0:1))"`);
  }
  exec(s.pg, 'createdb -U postgres app2 && createdb -U postgres app3', { user: 'postgres' });
  exec(c, 'git config --global user.email run@prodbench.invalid && git config --global user.name run && git config --global init.defaultBranch main');
  return c;
}

// --- one task ----------------------------------------------------------------

function promptFor(arm, task) {
  const t = cfg.tasks[task];
  const read = (f) => readFileSync(join(BENCH, 'prompts', f), 'utf8').trim();
  const limits = `${t.wallMinutes * wallScale} minutes of wall-clock time and ${t.maxTurns} turns for this task`;
  return `${read('common.md').replace('{{ARM}}', read(`arm-${arm}.md`)).replace('{{LIMITS}}', limits)}\n\n${read(t.prompt)}\n`;
}

function prepareApp(c, run, task) {
  if (task > 1) {
    // Task 2 starts from the arm's reference, task 3 from its seeded
    // reference, never from what task 1 left (cold review): each task measures
    // itself. Without node_modules; the agent installs them as the contract says.
    exec(c, 'rm -rf /work/app && mkdir -p /work/app', { user: 'root' });
    const name = run.arm === 'a' ? 'a-filelayer' : 'b-own';
    const ref = join(BENCH, 'reference', task === 2 ? name : `${name}-t3-bug`);
    const tar = spawnSync('tar', ['-C', ref, '--exclude=node_modules', '-cf', '-', '.']);
    docker(['exec', '-i', '-u', 'root', c, 'tar', '-C', '/work/app', '-xf', '-'], { input: tar.stdout });
    exec(c, 'chown -R agent:agent /work/app', { user: 'root' });
  }
  // A commit before the task, so the snapshot's diff is the task's own work.
  // node_modules stays out of the harness's commits whatever the project's own
  // .gitignore says.
  exec(c, `cd /work/app && (test -d .git || git init -q) && printf 'node_modules/\\n' >> .git/info/exclude && git add -A && git commit -q --allow-empty -m "before task ${task}"`);
}

/** Run one Claude Code session; resolve with what the stream said and why it stopped. */
function runSession(c, run, task, budget, out, env) {
  const t = cfg.tasks[task];
  const argv = ['exec', '-i', '-u', 'agent', '-w', '/work/app',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c,
    // Its own session and process group inside the container, so that stopping
    // it stops everything it started.
    'setsid', '-w', 'claude', '-p', '--model', run.model, '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--no-session-persistence',
    '--max-budget-usd', budget.toFixed(2),
    ...(cfg.effort ? ['--effort', cfg.effort] : []),
    ...(cfg.disallowedTools.length ? ['--disallowedTools', ...cfg.disallowedTools] : [])];
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  // 'wx': a stream is never overwritten. A run is never run twice (see
  // recoverInterrupted), so an existing file would be a harness bug.
  const stream = createWriteStream(out, { flags: 'wx' });
  const child = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(promptFor(run.arm, task));
  const seen = { toolCalls: 0, result: null, lastText: '', stderr: '' };
  const counter = usageCounter();
  let stop = null;
  const kill = (why) => {
    if (stop) return;
    stop = why;
    // Killing `docker exec` would leave the session running in the container.
    docker(['exec', '-u', 'root', c, 'pkill', '-TERM', '-f', 'claude'], { allowFail: true });
    setTimeout(() => docker(['exec', '-u', 'root', c, 'pkill', '-KILL', '-f', 'claude'], { allowFail: true }), 5000).unref();
  };
  const wall = setTimeout(() => kill('wall'), t.wallMinutes * wallScale * 60_000);
  let buf = '';
  child.stdout.on('data', (d) => {
    stream.write(d);
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === 'assistant') {
        // A turn is one API response: one message id, however many stream
        // lines carry it.
        counter.add(m);
        for (const part of m.message?.content ?? []) {
          if (part.type === 'tool_use') seen.toolCalls++;
          if (part.type === 'text') seen.lastText = part.text;
        }
        if (counter.turns > t.maxTurns) kill('turns');
      }
      if (m.type === 'result') seen.result = m;
    }
  });
  child.stderr.on('data', (d) => (seen.stderr = (seen.stderr + d).slice(-4000)));
  return new Promise((resolveP) => {
    child.on('exit', (code) => {
      clearTimeout(wall);
      stream.end();
      const r = seen.result;
      const why = stop ?? (r?.subtype === 'error_max_budget_usd' || /budget/i.test(r?.subtype ?? '') ? 'budget'
        : r?.is_error ? 'error' : r ? 'finished' : `exit_${code}`);
      const text = r?.result ?? seen.lastText ?? '';
      resolveP({
        task,
        stoppedBy: why,
        declaredDone: /(^|\n)\s*DONE\s*($|\n)/.test(text),
        wallMs: Date.now() - started,
        startedAt,
        endedAt: new Date().toISOString(),
        turnsSeen: counter.turns,
        streamUsage: counter.usage,
        toolCalls: seen.toolCalls,
        claude: r ? {
          numTurns: r.num_turns, durationMs: r.duration_ms, durationApiMs: r.duration_api_ms,
          totalCostUsd: r.total_cost_usd, usage: r.usage, modelUsage: r.modelUsage ?? null, subtype: r.subtype,
          isError: r.is_error ?? false, resultText: String(r.result ?? '').slice(-2000),
        } : null,
        // Always kept: Claude Code's own stderr is where an API failure shows,
        // whatever stopped the session.
        stderrTail: seen.stderr.slice(-4000),
      });
    });
  });
}

function snapshot(c, dest) {
  mkdirSync(dest, { recursive: true });
  exec(c, 'cd /work/app && git add -A && git commit -q --allow-empty -m after', { allowFail: true });
  const r = spawnSync('docker', ['exec', '-u', 'agent', c, 'tar', '-C', '/work/app', '--exclude=./node_modules', '-cf', '-', '.'],
    { maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) return false;
  return spawnSync('tar', ['-C', dest, '-xf', '-'], { input: r.stdout }).status === 0;
}

// --- the phase ---------------------------------------------------------------

function spentSoFar() {
  let usd = 0;
  for (const d of readdirSync(outRoot, { withFileTypes: true })) {
    const f = join(outRoot, d.name, 'run.json');
    if (d.isDirectory() && existsSync(f)) {
      const r = JSON.parse(readFileSync(f, 'utf8'));
      for (const t of r.tasks ?? []) usd += taskSpend(cfg.prices, r.model, t);
    }
  }
  return usd;
}

/**
 * A RUN THAT DID NOT FINISH IS NEVER RESUMED OR REPEATED.
 *
 * run.json is written with `state: 'started'` before the first session, and
 * again before and after every session, with the session in flight named in
 * `inFlight`. A harness that dies leaves a run that is not `finished`. When a
 * harness starts, every such run is closed here: the spend of the session in
 * flight is read from its stream, the run is marked invalid
 * (`harness_interrupted`), and plan.mjs --extend replaces it once. A run
 * directory with no run.json at all is treated the same way.
 */
function recoverInterrupted() {
  for (const run of plan.runs) {
    const dir = join(outRoot, run.id);
    if (!existsSync(dir)) continue;
    const file = join(dir, 'run.json');
    const prior = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ...run, tasks: [] };
    if (prior.state === 'finished') continue;
    const done = new Set((prior.tasks ?? []).map((t) => t.task));
    // The session in flight, and any stream on disk with no task record.
    for (const task of [1, 2, 3]) {
      const stream = join(dir, `task${task}.jsonl`);
      if (done.has(task) || !existsSync(stream)) continue;
      const c = usageCounter();
      for (const line of readFileSync(stream, 'utf8').split('\n')) {
        try {
          c.add(JSON.parse(line));
        } catch {
          /* a partial last line */
        }
      }
      prior.tasks.push({ task, stoppedBy: 'harness_interrupted', interrupted: true, turnsSeen: c.turns, streamUsage: c.usage });
    }
    prior.inFlight = null;
    prior.state = 'finished';
    prior.error = prior.error ?? 'interrupted: the harness stopped during this run';
    prior.invalid = { reason: 'harness_interrupted' };
    writeFileSync(file, JSON.stringify(prior, null, 2));
    console.log(`${run.id}: interrupted in an earlier session; recorded as invalid with $${prior.tasks.reduce((a, t) => a + taskSpend(cfg.prices, run.model, t), 0).toFixed(2)} spent`);
  }
}

/**
 * Nothing of an earlier harness may still be running: its containers (and the
 * session inside), its networks, its host-side proxies. Removed before
 * anything starts, and checked gone.
 */
function removeOrphans() {
  const prefixes = plan.runs.map((r) => `pb-${r.id}-`);
  const names = docker(['ps', '-a', '--format', '{{.Names}}']).stdout.split('\n').filter((n) => prefixes.some((p) => n.startsWith(p)));
  for (const n of names) docker(['rm', '-f', n], { allowFail: true });
  const nets = docker(['network', 'ls', '--format', '{{.Name}}']).stdout.split('\n').filter((n) => prefixes.some((p) => n.startsWith(p)));
  for (const n of nets) docker(['network', 'rm', n], { allowFail: true });
  spawnSync('pkill', ['-f', `egress-proxy.mjs.*${outRoot}`]);
  const left = docker(['ps', '-a', '--format', '{{.Names}}']).stdout.split('\n').filter((n) => prefixes.some((p) => n.startsWith(p)));
  if (left.length) {
    console.error(`containers of an earlier harness are still there: ${left.join(', ')}. Not starting.`);
    process.exit(2);
  }
  if (names.length || nets.length) console.log(`removed what an earlier harness left: ${names.length} container(s), ${nets.length} network(s)`);
}

let current = null; // the services and container of the run in progress, for the signal handlers
let phaseStop = null;

async function runOne(run) {
  const dir = join(outRoot, run.id);
  if (existsSync(dir)) {
    console.log(`${run.id}: already run, skipped`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  const runFile = join(dir, 'run.json');
  const save = () => writeFileSync(runFile, JSON.stringify(record, null, 2));
  const name = `${run.id}-${randomBytes(3).toString('hex')}`;
  const adminToken = randomBytes(24).toString('hex');
  const record = {
    ...run, state: 'started', startedAt: new Date().toISOString(), dryRun: DRY, claudeCode: cfg.claudeCode,
    fingerprint: FP.all, tasks: [], inFlight: null,
  };
  save();
  let s;
  let c;
  try {
    s = startServices(name, dir);
    current = { s, c: null };
    c = startAgent(name, s, run);
    current.c = c;
    for (const task of [1, 2, 3]) {
      // Every task gets its own fixed budget, never what is left of the run.
      // The run started only if the phase could cover all three; if earlier
      // overruns leave less than this task's budget, the task is skipped and
      // the run is invalid and replaced, rather than given a smaller budget.
      const budget = cfg.tasks[task].maxBudgetUsd;
      if (cfg.phaseCapUsd[plan.phase] - spentSoFar() < budget) {
        record.tasks.push({ task, stoppedBy: 'phase_cap', skipped: true });
        record.invalid = { reason: 'phase_cap_skip', task };
        break;
      }
      prepareApp(c, run, task);
      record.inFlight = { task, stream: `task${task}.jsonl`, startedAt: new Date().toISOString() };
      save();
      const res = await runSession(c, run, task, budget, join(dir, `task${task}.jsonl`), contractEnv(task, adminToken));
      res.snapshotOk = snapshot(c, join(dir, `task${task}`, 'app'));
      record.tasks.push(res);
      record.inFlight = null;
      save();
      console.log(`${run.id} task ${task}: ${res.stoppedBy}${res.declaredDone ? ', DONE' : ''}, ` +
        `${Math.round(res.wallMs / 1000)} s, ${res.turnsSeen} turns, $${taskSpend(cfg.prices, run.model, res).toFixed(2)}`);
      const api = apiFailure(res);
      if (STOPS_THE_PHASE.has(api)) {
        // An exhausted or refused key makes every later run fail the same way.
        // Those would be zeros the agent did not earn: the phase stops instead.
        record.invalid = { reason: api, task };
        phaseStop = api;
        break;
      }
    }
  } catch (e) {
    record.error = String(e.message ?? e).slice(0, 2000);
    console.error(`${run.id}: ${record.error}`);
  } finally {
    if (s) stopServices(s, c);
    current = null;
    record.state = 'finished';
    record.finishedAt = new Date().toISOString();
    save();
  }
}

// Stopped by a signal: take the run's containers (and the session in them)
// down with the harness. A run left this way is closed as interrupted by the
// next harness.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (current?.s) stopServices(current.s, current.c);
    process.exit(130);
  });
}

removeOrphans();
recoverInterrupted();
buildImages();
for (const run of plan.runs) {
  if (phaseStop) {
    console.log(`the phase stops: ${phaseStop}. ${run.id} and the rest are not run.`);
    break;
  }
  if (only && run.id !== only) continue;
  const runBudget = Object.values(cfg.tasks).reduce((s, t) => s + t.maxBudgetUsd, 0);
  const left = cfg.phaseCapUsd[plan.phase] - spentSoFar();
  if (left < runBudget) {
    console.log(`$${left.toFixed(2)} left of the phase cap of $${cfg.phaseCapUsd[plan.phase]}, less than a run's ` +
      `$${runBudget} of budgets: ${run.id} and the rest are not run`);
    break;
  }
  await runOne(run);
}
