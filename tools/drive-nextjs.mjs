#!/usr/bin/env node
/**
 * THE NEXT.JS EXAMPLE, AGAINST THE PUBLISHED TARBALL.
 *
 *     npm run verify:nextjs
 *
 * ---------------------------------------------------------------------------
 * WHY IT PACKS AND INSTALLS INSTEAD OF JUST RUNNING THE FILES
 * ---------------------------------------------------------------------------
 *
 * `examples/nextjs` imports `@filelayer/core` by name, because that is what a
 * developer pastes into their own project. Running it against
 * `../../packages/core/src/` would verify our checkout and would quietly stop
 * resembling what anybody installs -- which is the same reasoning as
 * `drive-starter.mjs` and `check-suite-runs-from-install.mjs`, and the reason
 * both of those exist is that an earlier version of this project checked the
 * checkout and shipped something else.
 *
 * So: pack, install the tarball into a scratch directory that has never seen
 * this repository, copy the example in, run its own `verify.mjs` there.
 *
 * No database to provision and no server to boot: the example uses
 * `Filelayer.quickstart()`, which runs PostgreSQL in-process, and App Router
 * handlers are plain `(Request) => Response` functions that the harness calls
 * directly. About forty seconds, almost all of it `npm install`.
 */

import { mkdtempSync, rmSync, readdirSync, writeFileSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const EXAMPLE = join(ROOT, 'examples', 'nextjs');

const step = (what) => process.stdout.write(`${what.padEnd(34, '.')} `);
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const die = (what, out) => {
  console.log('FAILED');
  console.error(`\n--- ${what} ---\n${out}`);
  process.exit(1);
};

function addTsExtensions(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'node_modules') walk(p);
        continue;
      }
      if (!e.name.endsWith('.ts')) continue;
      const src = readFileSync(p, 'utf8');
      const out = src.replace(/from '(\.{1,2}\/[^']+)'/g, (whole, spec) => {
        if (/\.[cm]?[jt]s$/.test(spec)) return whole;
        if (!existsSync(join(dirname(p), `${spec}.ts`))) {
          throw new Error(`${p}: '${spec}' resolves to no .ts file`);
        }
        n++;
        return `from '${spec}.ts'`;
      });
      if (out !== src) writeFileSync(p, out);
    }
  };
  walk(dir);
  return n;
}

const workdir = mkdtempSync(join(tmpdir(), 'filelayer-nextjs-'));
let ok = false;
try {
  step('pack');
  const packed = run('npm', ['pack', '--pack-destination', workdir], { cwd: CORE });
  if (packed.status !== 0) die('pack', packed.out);
  const tarball = readdirSync(workdir).find((f) => f.endsWith('.tgz'));
  if (!tarball) die('pack', `no .tgz landed in ${workdir}\n${packed.out}`);
  console.log(`ok (${tarball})`);

  // PGlite is a peer, not a dependency: `quickstart()` asks for it at runtime
  // and says so in a long error if it is absent. The example uses it, so the
  // harness installs it exactly as the example's README tells a reader to.
  step('install the tarball and pglite');
  writeFileSync(
    join(workdir, 'package.json'),
    `${JSON.stringify({ name: 'filelayer-nextjs-drive', private: true, type: 'module' }, null, 2)}\n`,
  );
  const installed = run(
    'npm',
    ['install', '--no-audit', '--no-fund', join(workdir, tarball), '@electric-sql/pglite@^0.3.11'],
    { cwd: workdir },
  );
  if (installed.status !== 0) die('install the tarball and pglite', installed.out);
  console.log('ok');

  // The WHOLE example directory, not a hand-picked subset. Copying the files
  // somebody remembered is how a harness ends up testing a different program
  // from the one that ships.
  step('copy the example in');
  cpSync(EXAMPLE, workdir, { recursive: true });
  // The example imports `../../lib/filelayer` with no extension, which is what
  // a Next.js project compiles (a `.ts` extension in an import path is a type
  // error there without allowImportingTsExtensions; a new create-next-app
  // project has no such setting, and check:nextjs-build builds exactly that).
  // Node's type stripping resolves only the exact file, so the copy, and only
  // the copy, gets the extension written in. Every rewrite is counted, and a
  // relative import that resolves to no .ts file is an error, not a guess.
  const rewritten = addTsExtensions(workdir);
  console.log(`ok (${rewritten} import${rewritten === 1 ? '' : 's'} given a .ts extension in the copy)`);

  step('drive the route handlers');
  console.log('');
  const driven = run('node', [join(workdir, 'verify.mjs')], {
    cwd: workdir,
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '--experimental-strip-types --no-warnings' },
  });
  if (driven.status !== 0) {
    console.error('\nverify.mjs reported failures. The output above says which.');
    process.exit(1);
  }
  ok = true;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log(ok ? '\nnextjs: the example runs against the published tarball.\n' : '');
