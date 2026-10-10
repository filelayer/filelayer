/**
 * THE CLI, SPAWNED, BECAUSE THAT IS HOW IT IS USED.
 *
 * Importing it and calling a function would test a different program: the exit
 * codes, the stream a message lands on, and the argument ordering are the
 * contract, and none of them exist outside a process.
 *
 * What these hold down, in the order they would be missed:
 *
 *   1. A credential passed as an argument is REFUSED, with exit 2, rather than
 *      ignored. Ignoring it would let a script that leaks a password into CI
 *      logs appear to work.
 *   2. A connection failure does not echo the connection string. The driver's
 *      message is useful and the URL carries the password, and this output goes
 *      into terminals people paste from.
 *   3. `--version` prints the version. It has no positional argument, so the
 *      no-command branch swallowed it and printed the usage, which looks like
 *      help working rather than a broken flag.
 *   4. Exit codes separate "problems found" from "could not run": 1 and 2. A
 *      script that treats every non-zero the same cannot tell a misconfigured
 *      database from a typo in a command.
 *   5. `--json` is parseable, because an agent reads it.
 *
 * The schema states themselves are not retested here; `test/schema-version.ts`
 * owns those against a real database. What is tested here is the CLI around
 * them.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

/**
 * Runs the CLI source rather than `dist/cli.js`, because `npm run verify` builds
 * AFTER it tests, so dist is stale or absent at this point. The built file being
 * reachable as the `bin` target is a packaging question and `check:published`
 * answers it against the published tarball.
 */
/**
 * ASYNCHRONOUS, and that is not a style choice.
 *
 * This used `spawnSync`, which blocks the test process's event loop. The
 * storage tests below stand up an HTTP server IN THAT PROCESS, so the spawned
 * CLI asked it for bytes and the server could not accept the connection until
 * the spawn returned -- a deadlock that showed up as the whole file printing
 * `TAP version 13` and nothing else.
 */
function run(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ status: number | null; stdout: string; stderr: string; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', CLI, ...args],
      { env: { ...process.env, DATABASE_URL: undefined, ...env } },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr, out: `${stdout}${stderr}` }));
  });
}

describe('the CLI', () => {
  it('prints a version line for --version and -v, and not the usage', async () => {
    for (const flag of ['--version', '-v']) {
      const r = await run([flag]);
      assert.equal(r.status, 0, `${flag} exited ${r.status}`);
      const line = r.stdout.trim();
      // Semver OR the literal `unknown`, and the second one is legitimate: the
      // CLI reads its version from its own package.json, and the published
      // verification procedure REPLACES that file to prove the suite needs no
      // development dependencies. In that environment the version is genuinely
      // unknowable, and a test that demanded a number there would be asserting
      // something about the harness rather than about the program.
      assert.ok(
        /^\d+\.\d+\.\d+$/.test(line) || line === 'unknown',
        `${flag} printed ${JSON.stringify(r.stdout.slice(0, 120))}`,
      );
      // The point of the test: the flag is not swallowed by the no-command
      // branch, which printed the usage and looked like help working.
      assert.ok(!r.stdout.includes('filelayer doctor'), `${flag} printed the usage`);
      assert.ok(line.split('\n').length === 1, `${flag} printed more than one line`);
    }
  });

  it('prints usage with no command, and exits 0', async () => {
    const r = await run([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /filelayer doctor/);
  });

  it('exits 2 on an unknown command, and says so on stderr', async () => {
    const r = await run(['nonsense']);
    assert.equal(r.status, 2, 'an unknown command should be a usage error, not a finding');
    assert.match(r.stderr, /unknown command/);
    assert.equal(r.stdout, '', 'a usage error does not belong on stdout');
  });

  it('refuses a credential passed as an argument', async () => {
    for (const arg of ['--database-url=postgres://u:p@h/d', '--password', '--token=abc']) {
      const r = await run([arg, 'doctor']);
      assert.equal(r.status, 2, `${arg} was not refused`);
      assert.match(r.stderr, /not accepted as an argument/);
      assert.match(r.stderr, /shell history/, 'the refusal does not say why');
    }
  });

  it('does not echo the connection string when it cannot connect', async () => {
    const r = await run(['doctor'], {
      DATABASE_URL: 'postgres://someuser:hunter2@127.0.0.1:1/nope',
    });
    assert.equal(r.status, 1, 'an unreachable database is a finding, not a usage error');

    // THE ASSERTION THAT MATTERS, and it holds on both paths below.
    assert.ok(!r.out.includes('hunter2'), `the password reached the output:\n${r.out}`);
    assert.ok(!r.out.includes('someuser'), `the username reached the output:\n${r.out}`);

    // Two legitimate outcomes, depending on whether `pg` is present. It is an
    // OPTIONAL peer, so an environment without it never gets as far as dialling
    // -- which is the case in the published verification procedure, and the
    // first version of this test asserted the development environment's answer
    // and failed there.
    assert.ok(
      /could not be reached/.test(r.out) || /pg driver: not installed/.test(r.out),
      `expected either a connection failure or a missing driver, got:\n${r.out}`,
    );
  });

  it('reports a missing DATABASE_URL as a problem, not a crash', async () => {
    const r = await run(['doctor']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /DATABASE_URL/);
    assert.match(r.stdout, /no flag for it/, 'it does not say where to put it');
    assert.ok(!/ at /.test(r.stderr), `a stack trace reached stderr:\n${r.stderr}`);
  });

  it('emits parseable json, because an agent reads it', async () => {
    const r = await run(['doctor', '--json']);
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.findings), r.stdout.slice(0, 200));
    assert.ok(
      parsed.findings.some((f: { name: string }) => f.name === 'DATABASE_URL'),
      r.stdout.slice(0, 200),
    );
    for (const f of parsed.findings) {
      assert.ok(['ok', 'problem', 'unknown'].includes(f.state), `bad state ${f.state}`);
    }
  });

  it('says that it does not check the bucket, so nobody assumes it did', async () => {
    const help = await run(['--help']);
    const doctor = await run(['doctor']);
    assert.match(
      help.stdout + doctor.stdout,
      /bucket/i,
      'a clean doctor run that is silent about storage reads as "storage is fine"',
    );
  });
});

/**
 * A stand-in object store that answers every request with one status.
 *
 * That is all the anonymous-read probe looks at, and standing up a real store
 * would test `S3Storage` rather than the check. The three statuses below are
 * the three real answers: 403 from a private bucket, 404 from one that serves
 * anonymous readers, and anything else.
 */
async function fakeStore(status: number) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end('<Error/>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('the CLI: the anonymous-read probe', () => {
  it('says the bucket was not checked when S3_ENDPOINT is unset', async () => {
    const r = await run(['doctor']);
    assert.match(r.stdout, /no bucket was checked/);
    assert.match(r.stdout, /FsStorage that is expected/, 'it does not say when that is fine');
  });

  it('reports the bucket even when the database never answers', async () => {
    // The first version ran the storage check only after a successful
    // connection, so the most common first run -- no DATABASE_URL yet -- said
    // nothing about the bucket, which is the silence this check exists to end.
    const r = await run(['doctor']);
    assert.match(r.stdout, /DATABASE_URL/);
    assert.match(r.stdout, /storage/, 'storage was omitted on the no-database path');
  });

  it('treats a refusal as what a private bucket does', async () => {
    const store = await fakeStore(403);
    try {
      const r = await run(['doctor', '--json'], { S3_ENDPOINT: store.endpoint, S3_BUCKET: 'b' });
      const f = JSON.parse(r.stdout).findings.find((x: { name: string }) => x.name === 'storage');
      assert.equal(f.state, 'ok', JSON.stringify(f));
      assert.match(f.detail, /bucket root only/, 'it overstates what a refusal proves');
    } finally {
      await store.close();
    }
  });

  it('treats an honest 404 as a public bucket, and fails', async () => {
    const store = await fakeStore(404);
    try {
      const r = await run(['doctor', '--json'], { S3_ENDPOINT: store.endpoint, S3_BUCKET: 'b' });
      assert.equal(r.status, 1, 'a publicly readable bucket is not a clean run');
      const f = JSON.parse(r.stdout).findings.find((x: { name: string }) => x.name === 'storage');
      assert.equal(f.state, 'problem', JSON.stringify(f));
      assert.match(f.fix, /Block Public Access/);
    } finally {
      await store.close();
    }
  });

  it('does not interpret a status it does not recognise', async () => {
    const store = await fakeStore(500);
    try {
      const r = await run(['doctor', '--json'], { S3_ENDPOINT: store.endpoint, S3_BUCKET: 'b' });
      const f = JSON.parse(r.stdout).findings.find((x: { name: string }) => x.name === 'storage');
      assert.equal(f.state, 'unknown', JSON.stringify(f));
      assert.match(f.detail, /does not interpret/);
    } finally {
      await store.close();
    }
  });

  it('reports an unreachable endpoint as a problem rather than crashing', async () => {
    const r = await run(['doctor', '--json'], {
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_BUCKET: 'b',
    });
    const f = JSON.parse(r.stdout).findings.find((x: { name: string }) => x.name === 'storage');
    assert.equal(f.state, 'problem', JSON.stringify(f));
    assert.match(f.detail, /could not be reached/);
  });

  it('never sends or prints the storage credentials', async () => {
    const store = await fakeStore(403);
    try {
      const r = await run(['doctor'], {
        S3_ENDPOINT: store.endpoint,
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
        S3_SECRET_ACCESS_KEY: 'shhh-this-is-the-secret',
      });
      assert.ok(!r.out.includes('shhh-this-is-the-secret'), `the secret reached the output:\n${r.out}`);
      assert.ok(!r.out.includes('AKIAEXAMPLEKEYID'), `the key id reached the output:\n${r.out}`);
    } finally {
      await store.close();
    }
  });
});
