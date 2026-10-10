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
import { spawnSync } from 'node:child_process';
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
function run(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: undefined, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', out: `${r.stdout}${r.stderr}` };
}

describe('the CLI', () => {
  it('prints a version line for --version and -v, and not the usage', () => {
    for (const flag of ['--version', '-v']) {
      const r = run([flag]);
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

  it('prints usage with no command, and exits 0', () => {
    const r = run([]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /filelayer doctor/);
  });

  it('exits 2 on an unknown command, and says so on stderr', () => {
    const r = run(['nonsense']);
    assert.equal(r.status, 2, 'an unknown command should be a usage error, not a finding');
    assert.match(r.stderr, /unknown command/);
    assert.equal(r.stdout, '', 'a usage error does not belong on stdout');
  });

  it('refuses a credential passed as an argument', () => {
    for (const arg of ['--database-url=postgres://u:p@h/d', '--password', '--token=abc']) {
      const r = run([arg, 'doctor']);
      assert.equal(r.status, 2, `${arg} was not refused`);
      assert.match(r.stderr, /not accepted as an argument/);
      assert.match(r.stderr, /shell history/, 'the refusal does not say why');
    }
  });

  it('does not echo the connection string when it cannot connect', () => {
    const r = run(['doctor'], {
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

  it('reports a missing DATABASE_URL as a problem, not a crash', () => {
    const r = run(['doctor']);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /DATABASE_URL/);
    assert.match(r.stdout, /no flag for it/, 'it does not say where to put it');
    assert.ok(!/ at /.test(r.stderr), `a stack trace reached stderr:\n${r.stderr}`);
  });

  it('emits parseable json, because an agent reads it', () => {
    const r = run(['doctor', '--json']);
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

  it('says that it does not check the bucket, so nobody assumes it did', () => {
    const r = run(['--help']);
    assert.match(
      r.stdout + run(['doctor'], { DATABASE_URL: undefined }).stdout,
      /bucket/i,
      'a clean doctor run that is silent about storage reads as "storage is fine"',
    );
  });
});
