/**
 * THE LAUNCHABLE MCP SERVER, STARTED THE WAY A CLIENT STARTS IT.
 *
 * `filelayerMcpServer()` is for an application that already has an instance and
 * a session. `filelayer-mcp` is the other half: it builds the instance from the
 * environment so that something which knows nothing about your code can start
 * it with a command and an `env` block. That is also what makes a registry
 * entry honest rather than decorative, so the thing worth testing is whether a
 * client can genuinely launch it.
 *
 * Two halves:
 *
 *   The REFUSALS run everywhere and need no database. They are most of the
 *   value: every one of them is a misconfiguration that would otherwise present
 *   as a client saying "server failed to start" with nothing to act on. A
 *   missing storage configuration in particular must NOT fall back to memory,
 *   which would work in a demo and lose the first real file.
 *
 *   The LAUNCH needs a real PostgreSQL, because this server builds a `pg.Pool`
 *   and PGlite is not a server. It skips itself where there is none, which is
 *   the same arrangement as the contention suites, and runs in CI against the
 *   real one.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { realPostgresAvailable, stopRealPostgres } from './real-postgres.ts';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-server.ts');

/** Start it and collect what it says before it gives up. */
function start(env: Record<string, string | undefined>) {
  return new Promise<{ status: number | null; out: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', SERVER],
      {
        env: {
          ...process.env,
          DATABASE_URL: undefined,
          S3_ENDPOINT: undefined,
          FILELAYER_DATA_DIR: undefined,
          FILELAYER_AS: undefined,
          FILELAYER_ORG: undefined,
          ...env,
        },
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (status) => resolve({ status, out }));
  });
}

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'filelayer-mcp-test-'));
  dirs.push(d);
  return d;
};
after(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  // The embedded Postgres keeps the event loop alive. Without this the file
  // passes every assertion and then hangs forever, which the runner reports as
  // a timeout with no failing test -- the same arrangement contention.test.ts
  // and audit-retention.test.ts already use.
  await stopRealPostgres();
});

describe('filelayer-mcp: what it refuses to start without', () => {
  it('refuses with no storage configured, and does not fall back to memory', async () => {
    const r = await start({});
    assert.equal(r.status, 2, `expected a configuration refusal, got ${r.status}: ${r.out}`);
    assert.match(r.out, /no storage is configured/);
    assert.match(
      r.out,
      /no in-memory default/,
      'it does not explain why there is no default, which is the part that matters',
    );
  });

  it('refuses with storage but no database', async () => {
    const r = await start({ FILELAYER_DATA_DIR: scratch() });
    assert.equal(r.status, 2);
    assert.match(r.out, /DATABASE_URL is not set/);
    assert.match(r.out, /schema\.sql/, 'it does not say how to prepare the database');
  });

  it('refuses without a subject, and says why that is not negotiable', async () => {
    const r = await start({
      FILELAYER_DATA_DIR: scratch(),
      DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
    });
    assert.equal(r.status, 2);
    // Storage and DATABASE_URL are both present, so the next missing thing is
    // the subject -- and it is checked BEFORE the database is dialled, so this
    // does not depend on an unreachable host failing first.
    assert.match(r.out, /FILELAYER_AS is not set/, r.out);
    assert.match(r.out, /never derive it from a conversation/, 'the reason is missing');
  });

  it('does not echo the connection string when the database is unreachable', async () => {
    const r = await start({
      FILELAYER_DATA_DIR: scratch(),
      DATABASE_URL: 'postgres://someuser:hunter2@127.0.0.1:1/nope',
      FILELAYER_AS: 'user_alice',
      FILELAYER_ORG: 'org_acme',
    });
    assert.equal(r.status, 2);
    // THE ASSERTION THAT MATTERS, and it holds on both paths below.
    assert.ok(!r.out.includes('hunter2'), `the password reached the output:\n${r.out}`);
    assert.ok(!r.out.includes('someuser'), `the username reached the output:\n${r.out}`);

    // Two legitimate outcomes. `pg` is an OPTIONAL peer, so an environment
    // without it never gets as far as dialling -- which is the case in the
    // published verification procedure. I made this exact mistake in
    // test/cli.test.ts two days ago, fixed it there, and did not carry it
    // across; `check:suite-install` caught it again.
    assert.ok(
      /could not be reached/.test(r.out) || /pg driver is not installed/.test(r.out),
      `expected either a connection failure or a missing driver, got:\n${r.out}`,
    );
  });

  it('writes nothing to stdout while failing', async () => {
    // stdout carries protocol frames. A client parses whatever arrives there,
    // so a diagnostic on the wrong stream is a parse error that reads like a
    // broken server.
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', SERVER],
      { env: { ...process.env, DATABASE_URL: undefined, FILELAYER_DATA_DIR: undefined } },
    );
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    await new Promise<void>((r) => child.on('close', () => r()));
    assert.equal(stdout, '', `it wrote to stdout:\n${stdout}`);
  });
});

describe('filelayer-mcp: a client launching it', async () => {
  const haveReal = await realPostgresAvailable();
  const skip = haveReal
    ? false
    : 'needs a real PostgreSQL: this server builds a pg.Pool, and PGlite is not a server';

  it('comes up over stdio and answers a tool call', { skip }, async () => {
    const { createRealDb } = await import('./real-postgres.ts');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { Filelayer } = await import('../src/index.ts');
    const { FsStorage } = await import('../src/storage.ts');

    const db = await createRealDb();
    const dir = scratch();

    // The child process needs the URL and `RealDb` does not expose one, so it
    // comes off the pool's own options. Asserted rather than assumed: a pg
    // change that moved it would otherwise hand the child `undefined` and the
    // failure would look like a broken server.
    const url = (db.pool as unknown as { options?: { connectionString?: string } }).options
      ?.connectionString;
    assert.ok(typeof url === 'string', 'could not recover the database URL from the pool');

    // Seed through the library, so the server has something to answer about.
    const fl = new Filelayer(db.pool as never, new FsStorage(dir));
    await fl.orgs.create('org_acme', { owner: 'user_alice' });
    const { id } = await fl.files.put(new TextEncoder().encode('seeded'), {
      org: 'org_acme',
      owner: 'user_alice',
      name: 'seeded.txt',
      contentType: 'text/plain',
    });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', '--no-warnings', SERVER],
      env: {
        ...process.env,
        DATABASE_URL: url,
        FILELAYER_DATA_DIR: dir,
        FILELAYER_AS: 'user_alice',
        FILELAYER_ORG: 'org_acme',
        FILELAYER_MCP_AGENT_LABEL: 'launch-test/1.0',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'launch-test', version: '1' });
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      assert.equal(
        tools.length,
        7,
        `expected the default seven, got ${tools.map((t) => t.name).join(' ')}`,
      );

      const r = (await client.callTool({ name: 'file_info', arguments: { fileId: id } })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.notEqual(r.isError, true, r.content[0]?.text);
      assert.equal(JSON.parse(r.content[0]!.text).name, 'seeded.txt');

      // And the attribution, which is the reason this server is worth starting.
      const log = await fl.orgs.audit('org_acme', { as: 'user_alice' });
      assert.ok(
        log.some((e) => e.userAgent === 'launch-test/1.0'),
        `no event attributed to the agent: ${JSON.stringify([
          ...new Set(log.map((e) => e.userAgent)),
        ])}`,
      );
    } finally {
      await client.close();
      await db.close();
    }
  });
});
