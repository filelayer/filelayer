#!/usr/bin/env node
/**
 * SCORE THE SNAPSHOTS OF A PHASE.
 *
 *   node score.mjs --runs ../runs/pilot [--only <run id>] [--proxy container|host]
 *                  [--upstream http://host:port] [--extra-ca file] [--jobs N] [--late] [--unfrozen]
 *
 * It refuses to score unless the benchmark files match FINGERPRINT.txt, and
 * writes the fingerprint into every score.json. --unfrozen is for
 * rehearsals before the freeze; its scores say so (frozen: false), and
 * analyze.mjs refuses them unless it is told --unfrozen as well.
 *
 * A score.json is written once: a task already scored is left as it is,
 * unless its score is a scorer failure. --late scores only the attacks
 * written after the freeze, into late-score.json, and never touches
 * score.json.
 *
 * --jobs N scores N runs at once, each in a process of its own with
 * networks and containers of its own.
 *
 * Each snapshot (runs/<phase>/<run>/task<N>/app) is scored in a container of
 * its own (node:22 with this folder mounted read-only), on a new internal
 * network with a new PostgreSQL and moto, and npm as the only host it can
 * reach. In there: copy the snapshot, `npm install` (the contract's first
 * step; a failure scores the task as failed), then hidden/check.mjs with the
 * task's checks. The agent's own node_modules never come along.
 *
 * Writes runs/<phase>/<run>/task<N>/score.json, with the three blocks.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprint } from './fingerprint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BENCH = resolve(HERE, '..');
const ATTACKS = resolve(BENCH, '..', 'adversarial', 'attacks.mjs');
const args = process.argv.slice(2);
const arg = (name, dflt = null) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt);
const runsDir = resolve(arg('--runs') ?? '');
const only = arg('--only');
const proxyMode = arg('--proxy', 'container');
const upstream = arg('--upstream');
const extraCa = arg('--extra-ca') ? resolve(arg('--extra-ca')) : null;
const late = args.includes('--late');
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));

if (!existsSync(join(BENCH, 'node_modules', 'pg'))) {
  console.error('Run `npm ci --omit=optional` in benchmark/productivity first.');
  process.exit(2);
}

const docker = (argv, allowFail = false, timeoutMs = 300_000) => {
  const r = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${argv.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).slice(-600)}`);
  return r;
};

function scoreOne(app, task, out, arm) {
  const name = `pbs-${randomBytes(4).toString('hex')}`;
  docker(['network', 'create', '--internal', name]);
  const gw = docker(['network', 'inspect', name, '-f', '{{(index .IPAM.Config 0).Gateway}}']).stdout.trim();
  const started = [];
  let proxyChild = null;
  // The scorer's own egress log, one per attempt (cold review, I6). The late
  // attacks are scored in a directory of their own (N-N4), so nothing of
  // theirs can land next to the primary score.
  const egressLog = join(out, 'score-egress.jsonl');
  rmSync(egressLog, { force: true });
  try {
    docker(['run', '-d', '--name', `${name}-pg`, '--network', name, '--network-alias', 'postgres',
      '-e', 'POSTGRES_PASSWORD=postgres', cfg.images.postgres]);
    started.push(`${name}-pg`);
    docker(['run', '-d', '--name', `${name}-s3`, '--network', name, '--network-alias', 's3', cfg.images.s3]);
    started.push(`${name}-s3`);
    for (let i = 0; i < 120 && docker(['exec', `${name}-pg`, 'pg_isready', '-U', 'postgres'], true).status !== 0; i++) {
      spawnSync('sleep', ['0.5']);
    }
    let proxyUrl;
    const allow = join(HERE, 'allowlist-score.txt');
    if (proxyMode === 'host') {
      proxyChild = spawn(process.execPath, [join(HERE, 'egress-proxy.mjs'), '--port', '3129', '--listen', gw, '--allow', allow,
        '--log', egressLog, ...(upstream ? ['--upstream', upstream] : [])], { stdio: 'ignore' });
      proxyUrl = `http://${gw}:3129`;
    } else {
      docker(['run', '-d', '--name', `${name}-proxy`, '--network', name, '--network-alias', 'egress',
        '-v', `${join(HERE, 'egress-proxy.mjs')}:/proxy.mjs:ro`, '-v', `${allow}:/allow.txt:ro`, '-v', `${out}:/log`,
        cfg.images.node, 'node', '/proxy.mjs', '--port', '3129', '--allow', '/allow.txt', '--log', `/log/${basename(egressLog)}`]);
      started.push(`${name}-proxy`);
      docker(['network', 'connect', 'bridge', `${name}-proxy`]);
      proxyUrl = 'http://egress:3129';
    }
    const ca = extraCa ? ['-v', `${extraCa}:/etc/prodbench-ca.crt:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/etc/prodbench-ca.crt',
      '-e', 'npm_config_cafile=/etc/prodbench-ca.crt'] : [];
    const installSecs = cfg.scoring.installMinutes * 60;
    const result = late ? '/out/late-score.json' : '/out/score.json';
    mkdirSync(out, { recursive: true });
    const seed = `${arm === 'a' ? 'a-filelayer' : 'b-own'}-t3-bug`;
    // check.mjs starts the snapshot with PATH and HOME and the contract's
    // variables only, so the proxy settings below reach npm install and
    // nothing the snapshot runs afterwards.
    const script = [
      'set -u',
      'cp -r /snapshot /tmp/app',
      'cd /tmp/app',
      // The contract's first step. Its exit code goes to a file; score.mjs
      // decides from the scorer's egress log whose failure it was.
      `timeout ${installSecs} npm install --no-audit --no-fund >/out/install.log 2>&1; echo $? > /out/install.exit`,
      '[ "$(cat /out/install.exit)" = 0 ] || exit 0',
      // Task 3's seeded reference, installed here from its own package-lock
      // (fingerprinted), not taken from the scoring machine (cold review, N5).
      ...(task === 3 && !late ? [
        `cp -r /bench/reference/${seed} /tmp/seed && rm -rf /tmp/seed/node_modules && cd /tmp/seed`,
        `if ! timeout ${installSecs} npm ci --no-audit --no-fund >/out/seed-install.log 2>&1; then echo '{"scorerError":"seed_install"}' > ${result}; exit 0; fi`,
      ] : []),
      'cd /bench',
      `node hidden/check.mjs /tmp/app --task ${task} ${task === 3 && !late ? '--seed /tmp/seed ' : ''}${late ? '--late ' : ''}--json ${result} > /out/check.log 2>&1; echo "exit $?" >> /out/check.log`,
    ].join('\n');
    // A last bound on the whole scoring. Per request (30 s) and per check
    // (120 s) the limits are the snapshot's own failures; this one, far past
    // them, is the scorer's.
    const r = docker(['run', '--rm', '--name', `${name}-scorer`, '--network', name, '--cpus', '2', '--memory', '4g',
      '-u', 'node',
      '-v', `${BENCH}:/bench:ro`, '-v', `${ATTACKS}:/adversarial/attacks.mjs:ro`,
      '-v', `${app}:/snapshot:ro`, '-v', `${out}:/out`,
      '-e', `PRODBENCH_PG_ADMIN_URL=postgres://postgres:postgres@postgres:5432/postgres`,
      '-e', 'PRODBENCH_S3_URL=http://s3:5000',
      '-e', `npm_config_proxy=${proxyUrl}`, '-e', `npm_config_https_proxy=${proxyUrl}`,
      ...ca, cfg.images.node, 'bash', '-c', script], true, cfg.scoring.globalTimeoutMinutes * 60_000);
    if (r.error || r.status === null) {
      docker(['rm', '-f', `${name}-scorer`], true);
      writeFileSync(join(out, late ? 'late-score.json' : 'score.json'), JSON.stringify({ scorerError: 'scorer_timeout' }));
    }
  } finally {
    for (const c of started) docker(['rm', '-f', c], true);
    proxyChild?.kill('SIGTERM');
    docker(['network', 'rm', name], true);
  }
}

/**
 * Whose failure is a failed `npm install`? The scorer's, only when the npm
 * registry itself could not be reached: a connection error to
 * registry.npmjs.org in the scorer's egress log, or a 5xx or 429 from it in
 * npm's log. Any other failure is the agent's, including a dependency that
 * reaches a host the scorer does not allow (allowlist-score.txt): declared in
 * PREREG.md, the same for both arms (cold review, I6).
 */
function installVerdict(out) {
  // No exit code: the scorer stopped before installing (its global limit);
  // what it wrote, a scorer error, stands.
  if (!existsSync(join(out, 'install.exit'))) return { ok: true };
  const exit = readFileSync(join(out, 'install.exit'), 'utf8').trim();
  if (exit === '0') return { ok: true };
  const log = existsSync(join(out, 'install.log')) ? readFileSync(join(out, 'install.log'), 'utf8') : '';
  const egress = existsSync(join(out, 'score-egress.jsonl'))
    ? readFileSync(join(out, 'score-egress.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  // npm's own verdict on the package comes first: a missing version, an
  // unresolvable tree or a bad manifest is the agent's, whatever the network
  // did meanwhile (cold review of 1bba1d8, N-N3).
  const agentsOwn = /npm error code (E404|ETARGET|ERESOLVE|EBADENGINE|ENOENT|EJSONPARSE|EINVALIDPACKAGENAME|ENOVERSIONS|E403)\b/.test(log);
  const registryDown = !agentsOwn && (egress.some((e) => e.host === 'registry.npmjs.org' && e.error) ||
    /(E50[0-9]|E429)[\s\S]{0,300}registry\.npmjs\.org|registry\.npmjs\.org[\s\S]{0,300}(E50[0-9]|E429)/.test(log));
  const refused = [...new Set(egress.filter((e) => e.allowed === false).map((e) => e.host))];
  return { ok: false, network: registryDown, refused, exit };
}

const FP = fingerprint();
const unfrozen = args.includes('--unfrozen');
if (unfrozen) {
  // A rehearsal's flag, never a real run's (cold review of 1bba1d8, N-I5).
  const real = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, 'run.json')))
    .filter((d) => JSON.parse(readFileSync(join(runsDir, d.name, 'run.json'), 'utf8')).dryRun !== true);
  if (real.length) {
    console.error(`--unfrozen is for rehearsals: ${real.length} run(s) here are real (${real[0].name}...). Not scoring.`);
    process.exit(2);
  }
}
if (!unfrozen) {
  // Score only with exactly the checks PREREG.md fixed (cold review, B3).
  const committed = existsSync(join(BENCH, 'FINGERPRINT.txt')) ? readFileSync(join(BENCH, 'FINGERPRINT.txt'), 'utf8') : '';
  if (committed !== FP.text) {
    console.error('The benchmark files differ from FINGERPRINT.txt: not scoring. A rehearsal is --unfrozen.');
    process.exit(2);
  }
}

const jobs = Number(arg('--jobs', '1'));
if (jobs > 1 && !only) {
  const ids = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(runsDir, d.name, 'run.json'))).map((d) => d.name);
  const rest = args.filter((a, i) => a !== '--jobs' && args[i - 1] !== '--jobs');
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      await new Promise((r) => {
        const c = spawn(process.execPath, [fileURLToPath(import.meta.url), ...rest, '--only', id], { stdio: 'inherit' });
        c.on('exit', r);
      });
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  process.exit(0);
}

for (const d of readdirSync(runsDir, { withFileTypes: true })) {
  if (!d.isDirectory() || (only && d.name !== only)) continue;
  if (!existsSync(join(runsDir, d.name, 'run.json'))) continue;
  const arm = JSON.parse(readFileSync(join(runsDir, d.name, 'run.json'), 'utf8')).arm;
  for (const task of [1, 2, 3]) {
    const taskDir = join(runsDir, d.name, `task${task}`);
    const dir = late ? join(taskDir, 'late') : taskDir;
    const app = join(taskDir, 'app');
    const file = join(dir, late ? 'late-score.json' : 'score.json');
    const attemptsFile = join(dir, 'score-attempts.jsonl');
    const attempts = () => (existsSync(attemptsFile) ? readFileSync(attemptsFile, 'utf8').split('\n').filter(Boolean).length : 0);
    const read = () => {
      try {
        return JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        return { scorerError: 'no_result' };
      }
    };
    // A score is written once. Only a scorer failure is scored again, and only
    // once: every attempt is appended to score-attempts.jsonl, across
    // invocations, and after two there are no more, whatever score.json says
    // or whether it is there at all (cold review of 1bba1d8, N-I2).
    if (existsSync(file) && !read().scorerError) {
      console.log(`${d.name} task ${task}: already scored, left as it is`);
      continue;
    }
    if (attempts() >= 2) {
      console.log(`${d.name} task ${task}: scored twice already, not again`);
      continue;
    }
    if (!existsSync(join(app, 'package.json'))) {
      if (existsSync(taskDir) && !late) writeFileSync(file, JSON.stringify({ noProject: true, fingerprint: FP.all, frozen: !unfrozen }));
      continue;
    }
    mkdirSync(dir, { recursive: true });
    // The scorer runs as the image's `node` user; it must be able to write here.
    spawnSync('chmod', ['a+rwx', dir]);
    let s;
    while (attempts() < 2) {
      rmSync(file, { force: true });
      scoreOne(app, task, dir, arm);
      const inst = installVerdict(dir);
      if (!inst.ok) {
        s = inst.network
          ? { scorerError: 'install_network', detail: 'the npm registry could not be reached' }
          : { installFailed: true, refusedHosts: inst.refused };
        if (!late) writeFileSync(file, JSON.stringify(s, null, 2));
      } else {
        s = read();
      }
      appendFileSync(attemptsFile, JSON.stringify({ at: new Date().toISOString(), result: s.scorerError ?? (s.installFailed ? 'installFailed' : 'scored') }) + '\n');
      // A failure of the scorer says nothing about the agent: score again, once.
      if (!s.scorerError) break;
      const again = attempts() < 2;
      console.log(`${d.name} task ${task}: scorer error (${s.scorerError})${again ? ', scoring again' : ''}`);
      if (again) spawnSync('sleep', ['20']);
    }
    s.attempts = attempts();
    s = { ...s, fingerprint: FP.all, frozen: !unfrozen };
    if (!late || !s.installFailed) writeFileSync(file, JSON.stringify(s, null, 2));
    if (late) {
      console.log(`${d.name} task ${task}: late attacks ${s.late ? `${s.late.defended}/${s.late.of}` : `not scored (${s.scorerError ?? (s.installFailed ? 'npm install failed' : 'no result')})`}`);
      continue;
    }
    const f = s.functional ? `${s.functional.passed}/${s.functional.of}` : '-';
    const extra = s[`task${task}`] ? ` + task ${task} ${s[`task${task}`].passed}/${s[`task${task}`].of}` : '';
    const a = s.security ? `${s.security.defended}/${s.security.of}` : '-';
    console.log(`${d.name} task ${task}: ${s.scorerError ? `SCORER ERROR (${s.scorerError}), the task is invalid` : s.installFailed ? 'npm install failed' : s.serverFailed ? 'the snapshot did not start' : `functional ${f}${extra}, attacks ${a}, both ${s.both ? 'yes' : 'no'}`}`);
  }
}
