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
 * Authentication (deviation 1, D077): the sessions are paid from the Agent
 * SDK credit of a Claude plan, through CLAUDE_CODE_OAUTH_TOKEN. The harness
 * reads the token from a file whose path is in PRODBENCH_OAUTH_TOKEN_FILE,
 * never prints it, and hands it to the container by name (`docker run -e
 * CLAUDE_CODE_OAUTH_TOKEN`), so it never appears in an argument list, a log
 * or a file of the run. ANTHROPIC_API_KEY must not be set: an API key takes
 * precedence over a plan's credentials, so the harness refuses to start with
 * one. --dry-run uses fake-claude.mjs instead of Claude Code and needs no
 * token.
 *
 * Money: before each run the phase's spend so far is read from the results.
 * A run starts only if what remains of the phase cap covers the full budgets
 * of its three tasks, so no session ever gets a budget cut short by the cap
 * (which would stop it for a reason that has nothing to do with the agent).
 * Otherwise the phase stops there.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './fingerprint.mjs';
import { costOf, taskSpend, usageCounter } from './usage.mjs';
import { API_ERROR_LINES, apiFailure, STOPS_THE_PHASE } from './classify.mjs';
import { gitVersion, historyDir, record as recordHistory } from './history.mjs';
import { startNeedUsd } from './money.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '..');
const args = process.argv.slice(2);
const arg = (name, dflt = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const flag = (name) => args.includes(name);

const planFile = resolve(arg('--plan') ?? '');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
// The harness's budget backstop (runSession): the slack the start gate keeps
// per task for a one-turn overrun.
const BUDGET_BACKSTOP_USD = cfg.runStartMarginUsd / Object.keys(cfg.tasks).length;
{
  // The harness's history needs git 2.40 or later (history.mjs).
  const g = gitVersion();
  if (!g.ok) {
    console.error(`${g.version || 'git not found'}: the harness needs git 2.40 or later (GIT_ATTR_SOURCE). Not starting.`);
    process.exit(2);
  }
}
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

// An API key would take precedence over the plan's token and bill the API
// instead (deviation 1): the harness does not start with one, dry or not.
if (process.env.ANTHROPIC_API_KEY !== undefined || process.env.ANTHROPIC_AUTH_TOKEN !== undefined) {
  console.error('ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set. Unset it: the runs are paid from the plan\'s credit (PREREG.md, deviation 1).');
  process.exit(2);
}
if (!DRY) {
  const f = process.env.PRODBENCH_OAUTH_TOKEN_FILE;
  let token = '';
  try {
    token = f ? readFileSync(f, 'utf8').trim() : '';
  } catch {
    token = '';
  }
  if (!token) {
    console.error('PRODBENCH_OAUTH_TOKEN_FILE does not name a readable file holding the token from `claude setup-token`. A real run needs it; a rehearsal is --dry-run.');
    process.exit(2);
  }
  // Passed to docker by name only (see the header).
  process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
}

// --- docker ------------------------------------------------------------------

// Every call has a time limit: a container the agent wedged (memory, pids)
// must not hang the harness (cold review of 1bba1d8, N-I4).
function docker(argv, { input, allowFail = false, timeoutMs = 300_000 } = {}) {
  const r = spawnSync('docker', argv, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' });
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
  if (!existsSync(logFile)) writeFileSync(logFile, '');
  docker(['run', '-d', '--name', c, '--network', net, '--network-alias', 'egress',
    '-v', `${join(HERE, 'egress-proxy.mjs')}:/proxy.mjs:ro`, '-v', `${allow}:/allow.txt:ro`,
    // The log file alone, not the run's directory, which holds run.json and
    // the harness's history (cold review of 21c4946, a). It is created first:
    // a missing file would be mounted as a directory.
    '-v', `${logFile}:/log/egress.jsonl`, cfg.images.node,
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
    DATABASE_URL: `postgres://app:app@postgres:5432/${db}`,
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
    ...(DRY ? [] : ['-e', 'CLAUDE_CODE_OAUTH_TOKEN']),
    // PID 1 runs as root, so that every process of the user `agent` can be
    // killed between sessions without stopping the container, and it is an
    // init (tini) that reaps them: killed processes do not linger as zombies.
    '-u', 'root', '--init',
    ...caArgs, ...dryArgs, imageTag('agent'), 'sleep', 'infinity']);
  // The contract and the smoke test, owned by root and read-only to the agent.
  const tar = spawnSync('tar', ['-C', BENCH, '-cf', '-', 'contract', 'smoke']);
  docker(['exec', '-i', '-u', 'root', c, 'tar', '-C', '/work', '-xf', '-'], { input: tar.stdout });
  docker(['exec', '-u', 'root', c, 'sh', '-c', 'chown -R root:root /work/contract /work/smoke && chmod -R a+rX,go-w /work/contract /work/smoke']);
  // The bucket of each task, made once.
  for (const b of ['documents', 'documents2', 'documents3']) {
    exec(c, `node -e "fetch('http://s3:5000/${b}',{method:'PUT'}).then(r=>process.exit(r.ok?0:1))"`);
  }
  // The service's databases belong to a role of their own that is not a
  // superuser, as in the scorer (local-env.mjs), so both arms build against
  // what they are scored against.
  exec(s.pg, `psql -v ON_ERROR_STOP=1 -U postgres -c "CREATE ROLE app LOGIN PASSWORD 'app'" -c "ALTER DATABASE app OWNER TO app" && createdb -U postgres -O app app2 && createdb -U postgres -O app app3`, { user: 'postgres' });
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
  // The project is a git repository when the task starts, as the agent may
  // expect. This commit is the agent's, inside its container; what the harness
  // counts comes from its own history (history.mjs). Whatever the agent left in
  // its global git configuration during an earlier task cannot make it fail:
  // no global configuration, hooks or fsmonitor, and no signing.
  exec(c, `cd /work/app && (test -d .git || git init -q) && printf 'node_modules/\\n' >> .git/info/exclude && ` +
    `GIT_CONFIG_GLOBAL=/dev/null git -c user.email=run@prodbench.invalid -c user.name=run -c core.hooksPath=/dev/null ` +
    `-c core.fsmonitor=false -c commit.gpgSign=false add -A && ` +
    `GIT_CONFIG_GLOBAL=/dev/null git -c user.email=run@prodbench.invalid -c user.name=run -c core.hooksPath=/dev/null ` +
    `-c core.fsmonitor=false -c commit.gpgSign=false commit -q --no-verify --allow-empty -m "before task ${task}"`);
}

/** Run one Claude Code session; resolve with what the stream said and why it stopped. */
function runSession(c, run, task, budget, out, env) {
  const t = cfg.tasks[task];
  const argv = ['exec', '-i', '-u', 'agent', '-w', '/work/app',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), c,
    'claude', '-p', '--model', run.model, '--output-format', 'stream-json', '--verbose',
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
  const seen = { toolCalls: 0, result: null, lastText: '', stderr: '', lastResponseAt: null, lastApiErrorAt: null, apiErrorTimes: [], hardKilled: false };
  const counter = usageCounter();
  let stop = null;
  let deadline = null;
  // How the session ends: on 'close', once its output has all arrived, or by
  // the synthetic end after a hard kill (cold review of 7419ac1, nit c).
  const end = { now: () => {} };
  // Every timer kill() sets is cancelled when this session ends: `pkill -u
  // agent` reaches every process of the agent, and a timer that fired during
  // the next task would kill the next session.
  const timers = [];
  const kill = (why) => {
    if (stop) return;
    stop = why;
    // Killing `docker exec` would leave the session running in the container:
    // every process of the user `agent` goes, the session and whatever it
    // started (a server in the background included).
    docker(['exec', '-u', 'root', c, 'pkill', '-TERM', '-u', 'agent'], { allowFail: true, timeoutMs: 15_000 });
    timers.push(setTimeout(() => docker(['exec', '-u', 'root', c, 'pkill', '-KILL', '-u', 'agent'], { allowFail: true, timeoutMs: 15_000 }), 5000));
    // A container that does not answer (the agent exhausted its memory or its
    // pids) is killed from the host after 10 s; the stop is still the clock's
    // or the turns', the agent's own doing. The session ends 15 s after that
    // whatever `docker exec` does.
    timers.push(setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      seen.hardKilled = true;
      docker(['kill', c], { allowFail: true, timeoutMs: 30_000 });
      deadline = setTimeout(() => end.now(null), 15_000);
    }, 10_000));
  };
  const wall = setTimeout(() => kill('wall'), t.wallMinutes * wallScale * 60_000);
  let buf = '';
  // Set when the session ends, the synthetic end after a hard kill included:
  // output that arrives later is not written to a stream already closed.
  let ended = false;
  child.stdout.on('data', (d) => {
    if (!ended) stream.write(d);
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
        seen.lastResponseAt = new Date().toISOString();
        for (const part of m.message?.content ?? []) {
          if (part.type === 'tool_use') seen.toolCalls++;
          if (part.type === 'text') seen.lastText = part.text;
        }
        if (counter.turns > t.maxTurns) kill('turns');
        // A backstop for --max-budget-usd, in case Claude Code does not apply
        // it with a plan's token (deviation 1; checked in the pilot): the
        // harness's own count of the stream's tokens, at config's prices.
        // Above the budget plus the $3 a task the start gate keeps for a
        // one-turn overrun, the session stops as if its budget had: the
        // agent's limit, never sooner than Claude Code's own check would.
        const est = costOf(cfg.prices, run.model, counter.usage);
        if (est !== null && est > budget + BUDGET_BACKSTOP_USD) kill('budget');
      }
      if (m.type === 'result') seen.result = m;
    }
  });
  child.stderr.on('data', (d) => {
    seen.stderr = (seen.stderr + d).slice(-4000);
    // When Claude Code printed each of its API error lines (classify.mjs): only
    // those after the last response can say the API ended the session.
    const n = String(d).match(API_ERROR_LINES)?.length ?? 0;
    for (let i = 0; i < n; i++) seen.apiErrorTimes.push(new Date().toISOString());
    if (n) {
      seen.apiErrorTimes = seen.apiErrorTimes.slice(-50);
      seen.lastApiErrorAt = seen.apiErrorTimes.at(-1);
    }
  });
  return new Promise((resolveP) => {
    let exitCode = null;
    // A real exit: wait for 'close', so the last line, the result line
    // included, is read; 10 s at most, if something still holds the pipe.
    child.on('exit', (code) => {
      exitCode = code;
      timers.push(setTimeout(() => end.now(code), 10_000));
    });
    child.on('close', (code) => end.now(code ?? exitCode));
    end.now = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(wall);
      if (deadline) clearTimeout(deadline);
      for (const t of timers) clearTimeout(t);
      stream.end();
      const r = seen.result;
      const why = stop ?? (r?.subtype === 'error_max_budget_usd' || /budget/i.test(r?.subtype ?? '') ? 'budget'
        : r?.subtype === 'error_max_turns' ? 'turns'
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
        lastResponseAt: seen.lastResponseAt,
        lastApiErrorAt: seen.lastApiErrorAt,
        apiErrorTimes: seen.apiErrorTimes,
        hardKilled: seen.hardKilled,
      });
    };
  });
}

/**
 * The snapshot is copied out with `docker cp`, which works on a stopped
 * container too (one the harness had to kill). It is never committed in the
 * agent's repository on this side, where its hooks, filters and fsmonitor
 * would run as the harness (cold review of d89b967, NB-1): the harness records
 * it in a history of its own (history.mjs).
 */
function copyOut(c, dest) {
  mkdirSync(dest, { recursive: true });
  const copy = spawnSync('sh', ['-c', `docker cp ${c}:/work/app - | tar -C "${dest}" --strip-components=1 --exclude=app/node_modules -xf -`],
    { timeout: 600_000, killSignal: 'SIGKILL' });
  return copy.status === 0;
}

/** The tree before the task, in the harness's history; its commit id. The copy is not kept. */
function recordBefore(c, runDir, tdir, task) {
  const tmp = join(tdir, 'before');
  const id = copyOut(c, tmp) && recordHistory(historyDir(runDir, task), tmp, 'before');
  rmSync(tmp, { recursive: true, force: true });
  return id || null;
}

/**
 * Nothing the agent started survives its session: every process of the user
 * `agent` is killed and checked gone before the next task (cold review of
 * 1bba1d8, N-I3). A container the harness had to kill is started again first;
 * its files are still there.
 */
function endAgentProcesses(c) {
  const running = docker(['inspect', '-f', '{{.State.Running}}', c], { allowFail: true, timeoutMs: 30_000 }).stdout.trim();
  if (running !== 'true') docker(['start', c], { timeoutMs: 60_000 });
  for (let i = 0; i < 10; i++) {
    docker(['exec', '-u', 'root', c, 'pkill', '-KILL', '-u', 'agent'], { allowFail: true, timeoutMs: 15_000 });
    if (docker(['exec', '-u', 'root', c, 'pgrep', '-u', 'agent'], { allowFail: true, timeoutMs: 15_000 }).status === 1) return;
    spawnSync('sleep', ['1']);
  }
  // A process that survives SIGKILL (stuck in the kernel) goes with the
  // container: restarted, its files kept, rather than the run ending in a
  // harness error for something the agent left (cold review of d89b967).
  docker(['restart', '-t', '5', c], { timeoutMs: 120_000 });
  if (docker(['exec', '-u', 'root', c, 'pgrep', '-u', 'agent'], { allowFail: true, timeoutMs: 15_000 }).status === 1) return;
  throw new Error('processes of the agent survived the end of its session and a restart of its container');
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
      // The session may have run on after the harness died, out of its
      // stream's sight: the cap is charged the whole task budget at least.
      prior.tasks.push({ task, stoppedBy: 'harness_interrupted', interrupted: true, turnsSeen: c.turns, streamUsage: c.usage,
        capChargeUsd: cfg.tasks[task].maxBudgetUsd });
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
      const tdir = join(dir, `task${task}`);
      const before = recordBefore(c, dir, tdir, task);
      record.inFlight = { task, stream: `task${task}.jsonl`, startedAt: new Date().toISOString() };
      save();
      const res = await runSession(c, run, task, budget, join(dir, `task${task}.jsonl`), contractEnv(task, adminToken));
      res.snapshotOk = copyOut(c, join(tdir, 'app'));
      const after = before && res.snapshotOk ? recordHistory(historyDir(dir, task), join(tdir, 'app'), 'after') || null : null;
      // The ids analyze.mjs diffs between; null when either was not recorded.
      res.history = { before, after };
      endAgentProcesses(c);
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

// Stopped by a signal or by an error nothing caught: take the run's
// containers (and the session in them) down with the harness. A run left this
// way is closed as interrupted by the next harness.
const teardown = () => {
  if (current?.s) stopServices(current.s, current.c);
  releaseLock();
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    teardown();
    process.exit(130);
  });
}
process.on('uncaughtException', (e) => {
  console.error(`harness: ${e.stack ?? e}`);
  teardown();
  process.exit(1);
});

// One harness per phase directory at a time: a second one would remove the
// first one's containers as orphans (cold review of 1bba1d8, N-N6).
const LOCK = join(outRoot, '.harness.lock');
function takeLock() {
  try {
    writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    const pid = Number(readFileSync(LOCK, 'utf8'));
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      /* gone */
    }
    if (alive) {
      console.error(`another harness (pid ${pid}) is running on ${outRoot}. Not starting.`);
      process.exit(2);
    }
    writeFileSync(LOCK, String(process.pid));
  }
}
function releaseLock() {
  try {
    if (readFileSync(LOCK, 'utf8') === String(process.pid)) rmSync(LOCK);
  } catch {
    /* not ours, or gone */
  }
}

/**
 * --smoke-call (D-c): one real request, before the pilot spends anything else,
 * through exactly the environment of a run: the internal network, the egress
 * proxy and the agent's container with the plan's token. A one-word answer,
 * at most one turn and $0.05. It shows what the pilot must not discover on its
 * own: whether the token authenticates through the proxy, which hosts Claude
 * Code needs (the proxy's log), and whether total_cost_usd and the usage come
 * back with a plan's token. It writes smoke-call/<time>/ beside the plan and
 * counts toward no phase.
 */
async function smokeCall() {
  const name = `smoke-${randomBytes(3).toString('hex')}`;
  const dir = join(outRoot, 'smoke-call', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const run = { id: name, model: cfg.models.at(-1), arm: 'a', fake: 'good' };
  let s;
  let c;
  try {
    s = startServices(name, dir);
    current = { s, c: null };
    c = startAgent(name, s, run);
    current.c = c;
    const r = spawnSync('docker', ['exec', '-u', 'agent', '-w', '/work/app', c,
      'claude', '-p', 'Reply with the single word OK. Do not use any tool.', '--model', run.model,
      '--output-format', 'json', '--max-turns', '1', '--max-budget-usd', '0.05', '--no-session-persistence'],
    { encoding: 'utf8', timeout: 180_000, killSignal: 'SIGKILL' });
    let result = null;
    for (const line of String(r.stdout ?? '').trim().split('\n').reverse()) {
      try {
        const m = JSON.parse(line);
        if (m.type === 'result') {
          result = m;
          break;
        }
      } catch {
        // not a JSON line
      }
    }
    const egress = existsSync(join(dir, 'egress.jsonl'))
      ? readFileSync(join(dir, 'egress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const hosts = {};
    for (const e of egress.filter((x) => x.host)) {
      const h = (hosts[e.host] ??= { allowed: e.allowed, connected: 0, errors: 0 });
      if (e.connected) h.connected++;
      if (e.error) h.errors++;
    }
    const summary = {
      at: new Date().toISOString(), model: run.model, exit: r.status,
      subtype: result?.subtype ?? null, isError: result?.is_error ?? null, result: result?.result ?? null,
      totalCostUsd: result?.total_cost_usd ?? null, usage: result?.usage ?? null,
      costFromTokensUsd: costOf(cfg.prices, run.model, result?.usage),
      hosts, stderrTail: String(r.stderr ?? '').slice(-2000),
    };
    writeFileSync(join(dir, 'smoke-call.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ ...summary, stderrTail: undefined }, null, 2));
    console.log(`written: ${join(dir, 'smoke-call.json')}`);
    const ok = r.status === 0 && result && !result.is_error && /\bOK\b/.test(String(result.result ?? ''));
    console.log(ok ? 'smoke call: OK' : 'smoke call: FAILED, see the file above; the pilot does not start until it passes');
    return ok;
  } finally {
    if (s) stopServices(s, c);
    current = null;
  }
}

takeLock();
process.on('exit', releaseLock);
removeOrphans();
if (flag('--smoke-call')) {
  buildImages();
  process.exit((await smokeCall()) ? 0 : 1);
}
recoverInterrupted();
buildImages();
for (const run of plan.runs) {
  if (phaseStop) {
    console.log(`the phase stops: ${phaseStop}. ${run.id} and the rest are not run.`);
    break;
  }
  if (only && run.id !== only) continue;
  // The three budgets plus some slack for the one-turn overruns, so that a task
  // is never skipped for want of cap (cold review of 1bba1d8, N-I7).
  const runBudget = startNeedUsd(cfg);
  const left = cfg.phaseCapUsd[plan.phase] - spentSoFar();
  if (left < runBudget) {
    console.log(`$${left.toFixed(2)} left of the phase cap of $${cfg.phaseCapUsd[plan.phase]}, less than a run's ` +
      `$${runBudget} of budgets: ${run.id} and the rest are not run`);
    break;
  }
  await runOne(run);
}
