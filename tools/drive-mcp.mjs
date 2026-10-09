#!/usr/bin/env node
/**
 * THE MCP EXAMPLE, AGAINST THE PUBLISHED TARBALL, OVER REAL STDIO.
 *
 *     npm run verify:mcp
 *
 * ---------------------------------------------------------------------------
 * WHY IT PACKS AND INSTALLS INSTEAD OF JUST RUNNING THE FILES
 * ---------------------------------------------------------------------------
 *
 * `examples/mcp` imports `@filelayer/core` and `@filelayer/core/mcp` by name,
 * because that is what a developer pastes into their own project. Running it
 * against `../../packages/core/src/` would verify our checkout and would
 * quietly stop resembling what anybody installs. The same reasoning as
 * `drive-nextjs.mjs` and `check-suite-runs-from-install.mjs`, and the reason
 * all three exist is that this project has more than once checked the checkout
 * and shipped something else.
 *
 * ---------------------------------------------------------------------------
 * WHY IT INSTALLS FOUR PACKAGES AND NOT ONE
 * ---------------------------------------------------------------------------
 *
 * `@modelcontextprotocol/sdk` and `zod` are OPTIONAL peer dependencies of
 * `@filelayer/core/mcp`, so an ordinary install does not have them -- that is
 * the point of them, and it is what keeps `npm install @filelayer/core` at zero
 * runtime dependencies. The example's README tells a reader to install both, so
 * this harness installs exactly that and nothing more. PGlite is the third,
 * because `quickstart()` asks for it at runtime. Installing them by hand here
 * rather than letting the example declare them is deliberate: if the README's
 * install line were wrong, this harness would still pass, so the line is quoted
 * from the README in the step name and kept identical by review.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EXAMPLE'S OWN verify.mjs DOES THE DRIVING
 * ---------------------------------------------------------------------------
 *
 * It spawns `server.ts` as a subprocess and exchanges protocol frames over its
 * stdin and stdout, which is what an MCP client does. The package's unit tests
 * use an in-memory transport instead: faster, and blind to a whole class of
 * failure, because a server that writes one stray line to stdout passes every
 * in-memory test and is unusable from a client.
 *
 * About a minute, almost all of it `npm install`.
 */

import { mkdtempSync, rmSync, readdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const EXAMPLE = join(ROOT, 'examples', 'mcp');

const step = (what) => process.stdout.write(`${what.padEnd(40, '.')} `);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const die = (what, out) => {
  console.log('FAILED');
  console.error(`\n--- ${what} ---\n${out}`);
  process.exit(1);
};

const workdir = mkdtempSync(join(tmpdir(), 'filelayer-mcp-'));
try {
  step('pack');
  const packed = run('npm', ['pack', '--pack-destination', workdir], { cwd: CORE });
  if (packed.status !== 0) die('pack', packed.out);
  const tarball = readdirSync(workdir).find((f) => f.endsWith('.tgz'));
  if (!tarball) die('pack', `no .tgz landed in ${workdir}\n${packed.out}`);
  console.log(`ok (${tarball})`);

  step('install the tarball, the SDK, zod and pglite');
  writeFileSync(
    join(workdir, 'package.json'),
    `${JSON.stringify({ name: 'filelayer-mcp-drive', private: true, type: 'module' }, null, 2)}\n`,
  );
  const installed = run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      join(workdir, tarball),
      '@modelcontextprotocol/sdk',
      'zod',
      '@electric-sql/pglite@^0.3.11',
    ],
    { cwd: workdir },
  );
  if (installed.status !== 0) die('install', installed.out);
  console.log('ok');

  // The WHOLE example directory. Copying the files somebody remembered is how a
  // harness ends up testing a different program from the one that ships.
  step('copy the example in');
  cpSync(EXAMPLE, workdir, { recursive: true });
  console.log('ok');

  step('spawn the server and drive it over stdio');
  console.log('');
  const driven = run('node', [join(workdir, 'verify.mjs')], {
    cwd: workdir,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--no-warnings' },
  });
  if (driven.status !== 0) {
    console.error('\nverify.mjs reported failures. The output above says which.');
    process.exit(1);
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
