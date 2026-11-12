/**
 * The MCP client configuration, started the way a client starts it.
 *
 *     node tools/check-mcp-npx.mjs              # the documented args
 *     node tools/check-mcp-npx.mjs --self-test  # it must fail on broken args
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * Until 0.35.3 the printed configuration was
 *
 *     "command": "npx", "args": ["-y", "-p", "@filelayer/core", "filelayer-mcp"]
 *
 * and `check:published` ran it and passed. It ran it UNCONFIGURED, inside a
 * directory where `pg` was already installed, and accepted the server's refusal
 * about storage as proof the binary resolved. That refusal comes before the
 * server touches `pg`, the MCP SDK or zod, so the check could not see that npx
 * installs none of the three: they are OPTIONAL peers, and npx installs exactly
 * the packages named with `-p`. A client that pasted the block and filled in
 * the `env` got "the pg driver is not installed" and no server. A cold
 * first-user run found it on 12 November 2026.
 *
 * So this check gets PAST the configuration, which is the part a client cares
 * about:
 *
 *   - an EMPTY directory, outside any project, with a NEW npm cache, so nothing
 *     already installed can resolve a peer on the server's behalf;
 *   - the documented args, unchanged except that the `-p @filelayer/core`
 *     package is the freshly packed tarball, so this tree is what is tested and
 *     not whatever version npm serves today;
 *   - a real PostgreSQL with `schema.sql` applied, as the documentation says to
 *     do first, and a data directory for the bytes;
 *   - the MCP handshake over the process's real stdin and stdout, then
 *     `tools/list`, which must return exactly the default tool set.
 *
 * The database is FILELAYER_MCP_NPX_DATABASE_URL when set (CI points it at the
 * service container; a fresh database is created inside it and dropped after),
 * otherwise an embedded PostgreSQL started here, as `check:migrations` does.
 *
 * `--self-test` runs the same procedure with args known to be broken and
 * requires each to fail: the 0.35.2 configuration, and the fixed one with the
 * MCP SDK left out. Not the fixed one without zod: it starts, because the SDK
 * brings zod in as its own dependency today. The args still name zod so that
 * does not rest on the SDK's dependency list. A check that cannot fail on the
 * defect it exists for is worth nothing.
 *
 * Needs the network for npm. About a minute, most of it npm.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { documentedClientConfig, ROOT } from './documented-client-config.mjs';

const CORE = join(ROOT, 'packages', 'core');
const requireFromCore = createRequire(join(CORE, 'package.json'));
const importFromCore = (name) => import(pathToFileURL(requireFromCore.resolve(name)).href);

/** What `filelayerMcpServer()` registers when no FILELAYER_MCP_* flag is set. */
const DEFAULT_TOOLS = [
  'create_share_link',
  'file_info',
  'list_files',
  'list_shares',
  'revoke_share',
  'share_with_user',
  'unshare_user',
];

const SELF_TEST = process.argv.includes('--self-test');

const work = mkdtempSync(join(tmpdir(), 'filelayer-mcp-npx-'));
let embedded = null;
let adminUrl = null;
const createdDbs = [];

async function cleanup() {
  if (adminUrl && createdDbs.length) {
    const { Client } = requireFromCore('pg');
    const c = new Client({ connectionString: adminUrl });
    try {
      await c.connect();
      for (const d of createdDbs) await c.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`);
    } catch {
      // best effort: a scratch database left behind is not a test result
    } finally {
      await c.end().catch(() => {});
    }
  }
  if (embedded) await embedded.stop().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}

function die(msg) {
  console.error(`\ncheck-mcp-npx: ${msg}\n`);
  return cleanup().then(() => process.exit(1));
}

// --- the tarball -------------------------------------------------------------
function pack() {
  const r = spawnSync('npm', ['pack', '--pack-destination', work], { cwd: CORE, encoding: 'utf8' });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (r.status !== 0 || !tgz) throw new Error(`npm pack failed:\n${r.stdout}${r.stderr}`);
  return join(work, tgz);
}

// --- the database --------------------------------------------------------------
async function database() {
  const given = process.env.FILELAYER_MCP_NPX_DATABASE_URL;
  if (given) {
    adminUrl = given;
  } else {
    const { default: EmbeddedPostgres } = await importFromCore('embedded-postgres');
    const port = 57000 + Math.floor(Math.random() * 2000);
    const log = [];
    embedded = new EmbeddedPostgres({
      databaseDir: join(work, 'pg'),
      user: 'postgres',
      password: 'postgres',
      port,
      persistent: false,
      onLog: (m) => log.push(String(m)),
      onError: (m) => log.push(String(m?.message ?? m)),
    });
    await embedded.initialise();
    await embedded.start();
    adminUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
  }
  const { Client } = requireFromCore('pg');
  const name = `fl_mcp_npx_${randomUUID().slice(0, 8)}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  createdDbs.push(name);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  // The documentation's first step: apply schema.sql once before starting.
  const c = new Client({ connectionString: u.toString() });
  await c.connect();
  await c.query(readFileSync(join(CORE, 'schema.sql'), 'utf8'));
  await c.end();
  return u.toString();
}

// --- the args ------------------------------------------------------------------
/**
 * The documented args with the `-p @filelayer/core[@x]` package pointed at the
 * tarball. Exactly one such `-p` must exist: if the documentation stopped
 * naming the package with `-p`, that is a finding, not something to repair.
 */
function againstTarball(args, tgz) {
  const at = [];
  args.forEach((a, i) => {
    if ((args[i - 1] === '-p' || args[i - 1] === '--package') && /^@filelayer\/core(@.*)?$/.test(a)) at.push(i);
  });
  if (at.length !== 1) {
    throw new Error(
      `expected exactly one \`-p @filelayer/core\` in the args, found ${at.length}: ${JSON.stringify(args)}`,
    );
  }
  return args.map((a, i) => (i === at[0] ? tgz : a));
}

// --- one launch ----------------------------------------------------------------
/**
 * Start `npx ...args` in an empty directory with a new npm cache, do the MCP
 * handshake, ask for tools/list. Resolves `{ ok, tools, why, stderr }`.
 */
function launch(args, databaseUrl, label) {
  const dir = mkdtempSync(join(work, 'client-'));
  const cache = join(dir, '.npm-cache');
  const data = join(dir, 'data');
  mkdirSync(data);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('FILELAYER_') || k.startsWith('S3_') || k === 'DATABASE_URL') delete env[k];
    // npm config inherited from a parent `npm run` would point npx at this
    // repository's settings; the client has none of them.
    if (k.toLowerCase().startsWith('npm_')) delete env[k];
  }
  Object.assign(env, {
    npm_config_cache: cache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    DATABASE_URL: databaseUrl,
    FILELAYER_AS: 'user_alice',
    FILELAYER_ORG: 'org_acme',
    FILELAYER_DATA_DIR: data,
  });

  return new Promise((resolve) => {
    const child = spawn('npx', args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve({ ...r, stderr });
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `${label}: no tools/list answer within 240 s` }),
      240_000,
    );
    const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);

    child.stderr.on('data', (b) => (stderr += b));
    child.on('exit', (code) => finish({ ok: false, why: `${label}: the process exited (${code}) before answering tools/list` }));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (b) => {
      stdout += b;
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return finish({ ok: false, why: `${label}: a non-protocol line on stdout: ${line.slice(0, 120)}` });
        }
        if (msg.id === 1) {
          if (msg.error) return finish({ ok: false, why: `${label}: initialize failed: ${JSON.stringify(msg.error)}` });
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (msg.id === 2) {
          if (msg.error) return finish({ ok: false, why: `${label}: tools/list failed: ${JSON.stringify(msg.error)}` });
          const tools = (msg.result?.tools ?? []).map((t) => t.name).sort();
          return finish({ ok: true, tools });
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'check-mcp-npx', version: '1' },
      },
    });
  });
}

function tail(s) {
  return s.trim().split('\n').slice(-8).join('\n').replace(/^/gm, '        ');
}

// --- main ----------------------------------------------------------------------
try {
  const tgz = pack();
  const databaseUrl = await database();

  if (!SELF_TEST) {
    const cfg = documentedClientConfig();
    if (!cfg.args) await die(`no single documented client \`args\` array (${cfg.found.length} found)`);
    const args = againstTarball(cfg.args, tgz);
    console.log(`\ncheck-mcp-npx: npx ${cfg.args.join(' ')}   (from ${cfg.where}; @filelayer/core = the packed tarball)`);
    const r = await launch(args, databaseUrl, 'the documented configuration');
    if (!r.ok) {
      await die(
        `${r.why}\n\n        The documented client configuration does not start a working server\n` +
          `        from an empty directory. Its stderr ended with:\n${tail(r.stderr)}`,
      );
    }
    if (r.tools.join(',') !== DEFAULT_TOOLS.join(',')) {
      await die(`tools/list returned ${r.tools.join(', ')}; expected ${DEFAULT_TOOLS.join(', ')}`);
    }
    console.log(
      `check-mcp-npx: clean. From an empty directory with a new npm cache, the documented args started ` +
        `filelayer-mcp against PostgreSQL and tools/list returned the ${r.tools.length} default tools.`,
    );
  } else {
    const broken = [
      {
        label: 'the 0.35.2 configuration (no peers named)',
        args: ['-y', '-p', '@filelayer/core', 'filelayer-mcp'],
        expect: /pg driver is not installed/,
      },
      {
        label: 'the fixed configuration without the MCP SDK',
        args: ['-y', '-p', '@filelayer/core', '-p', 'pg', '-p', 'zod', 'filelayer-mcp'],
        expect: /needs @modelcontextprotocol\/sdk/,
      },
    ];
    let caught = 0;
    for (const b of broken) {
      const r = await launch(againstTarball(b.args, tgz), databaseUrl, b.label);
      if (r.ok) {
        console.log(`  NOT caught: ${b.label} listed ${r.tools.length} tools`);
      } else if (!b.expect.test(r.stderr)) {
        console.log(`  NOT caught for the right reason: ${b.label}\n${tail(r.stderr)}`);
      } else {
        caught += 1;
        console.log(`  caught: ${b.label} -- ${r.stderr.match(b.expect)[0]}`);
      }
    }
    if (caught !== broken.length) await die(`self-test: ${caught}/${broken.length} broken configurations caught`);
    console.log(`check-mcp-npx --self-test: ${caught}/${broken.length} broken configurations refused, each for its own reason.`);
  }
  await cleanup();
} catch (e) {
  await die(e?.stack ?? String(e));
}
