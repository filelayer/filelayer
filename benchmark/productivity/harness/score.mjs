#!/usr/bin/env node
/**
 * SCORE THE SNAPSHOTS OF A PHASE.
 *
 *   node score.mjs --runs ../runs/pilot [--only <run id>] [--proxy container|host]
 *                  [--upstream http://host:port] [--extra-ca file] [--jobs N]
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
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const cfg = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));

if (!existsSync(join(BENCH, 'node_modules', 'pg'))) {
  console.error('Run `npm ci --omit=optional` in benchmark/productivity first.');
  process.exit(2);
}

const docker = (argv, allowFail = false) => {
  const r = spawnSync('docker', argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${argv.slice(0, 3).join(' ')}: ${(r.stderr || r.stdout).slice(-600)}`);
  return r;
};

function scoreOne(app, task, out) {
  const name = `pbs-${randomBytes(4).toString('hex')}`;
  docker(['network', 'create', '--internal', name]);
  const gw = docker(['network', 'inspect', name, '-f', '{{(index .IPAM.Config 0).Gateway}}']).stdout.trim();
  const started = [];
  let proxyChild = null;
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
        ...(upstream ? ['--upstream', upstream] : [])], { stdio: 'ignore' });
      proxyUrl = `http://${gw}:3129`;
    } else {
      docker(['run', '-d', '--name', `${name}-proxy`, '--network', name, '--network-alias', 'egress',
        '-v', `${join(HERE, 'egress-proxy.mjs')}:/proxy.mjs:ro`, '-v', `${allow}:/allow.txt:ro`, cfg.images.node,
        'node', '/proxy.mjs', '--port', '3129', '--allow', '/allow.txt']);
      started.push(`${name}-proxy`);
      docker(['network', 'connect', 'bridge', `${name}-proxy`]);
      proxyUrl = 'http://egress:3129';
    }
    const ca = extraCa ? ['-v', `${extraCa}:/etc/prodbench-ca.crt:ro`, '-e', 'NODE_EXTRA_CA_CERTS=/etc/prodbench-ca.crt',
      '-e', 'npm_config_cafile=/etc/prodbench-ca.crt'] : [];
    const installSecs = cfg.scoring.installMinutes * 60;
    // check.mjs starts the snapshot with PATH and HOME and the contract's
    // variables only, so the proxy settings below reach npm install and
    // nothing the snapshot runs afterwards.
    const script = [
      'set -u',
      'cp -r /snapshot /tmp/app',
      'cd /tmp/app',
      `if ! timeout ${installSecs} npm install --no-audit --no-fund >/out/install.log 2>&1; then echo '{"installFailed":true}' > /out/score.json; exit 0; fi`,
      'cd /bench',
      `node hidden/check.mjs /tmp/app --task ${task} --json /out/score.json > /out/check.log 2>&1; echo "exit $?" >> /out/check.log`,
    ].join('\n');
    docker(['run', '--rm', '--name', `${name}-scorer`, '--network', name, '--cpus', '2', '--memory', '4g',
      '-u', 'node',
      '-v', `${BENCH}:/bench:ro`, '-v', `${ATTACKS}:/adversarial/attacks.mjs:ro`,
      '-v', `${app}:/snapshot:ro`, '-v', `${out}:/out`,
      '-e', `PRODBENCH_PG_ADMIN_URL=postgres://postgres:postgres@postgres:5432/postgres`,
      '-e', 'PRODBENCH_S3_URL=http://s3:5000',
      '-e', `npm_config_proxy=${proxyUrl}`, '-e', `npm_config_https_proxy=${proxyUrl}`,
      ...ca, cfg.images.node, 'bash', '-c', script]);
  } finally {
    for (const c of started) docker(['rm', '-f', c], true);
    proxyChild?.kill('SIGTERM');
    docker(['network', 'rm', name], true);
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
  for (const task of [1, 2, 3]) {
    const dir = join(runsDir, d.name, `task${task}`);
    const app = join(dir, 'app');
    if (!existsSync(join(app, 'package.json'))) {
      if (existsSync(dir)) writeFileSync(join(dir, 'score.json'), JSON.stringify({ noProject: true }));
      continue;
    }
    // The scorer runs as the image's `node` user; it must be able to write here.
    spawnSync('chmod', ['a+rwx', dir]);
    scoreOne(app, task, dir);
    const s = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'));
    const f = s.functional ? `${s.functional.passed}/${s.functional.of}` : '-';
    const extra = s[`task${task}`] ? ` + task ${task} ${s[`task${task}`].passed}/${s[`task${task}`].of}` : '';
    const a = s.security ? `${s.security.defended}/${s.security.of}` : '-';
    console.log(`${d.name} task ${task}: ${s.installFailed ? 'npm install failed' : `functional ${f}${extra}, attacks ${a}, both ${s.both ? 'yes' : 'no'}`}`);
  }
}
