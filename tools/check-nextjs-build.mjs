#!/usr/bin/env node
/**
 * THE NEXT.JS EXAMPLE, BUILT AND SERVED THE WAY A NEW PROJECT WOULD.
 *
 *     npm run check:nextjs-build               # needs the network (npm)
 *     node tools/check-nextjs-build.mjs --self-test
 *
 * `verify:nextjs` calls the route handlers as functions. That covers their
 * logic and none of Next.js: not the build, not the type check, not what Next
 * caches. A cold integration on 2026-11-03 found the example did not build in
 * a project created by create-next-app 16, which turns `cacheComponents` on:
 * `export const dynamic = 'force-dynamic'` is a build error there, and so is a
 * `.ts` extension in an import path. Neither could be seen from here.
 *
 * So this check does what the developer does:
 *
 *   1. `create-next-app` at a pinned version, with its defaults. The check
 *      refuses to go on if the project does not have `cacheComponents: true`,
 *      because then it would not test what it says it tests.
 *   2. The template's layout loads Google Fonts at build time; it is replaced
 *      by a five-line layout with none, so the check needs npm and nothing
 *      else. Nothing else in the project is touched.
 *   3. The four files of examples/nextjs are copied in unchanged, the packed
 *      @filelayer/core and PGlite are installed.
 *   4. `next build` must succeed.
 *   5. `next start`, then over real HTTP: upload, read as the owner, a stranger
 *      refused, a share link minted and downloaded, the link revoked, and the
 *      SAME link asked for again, which must now be refused. A cached or
 *      prerendered answer anywhere on that path fails step 5.
 *
 * --self-test runs the same steps twice more, each on a copy that must fail:
 *   - the example as 0.35.2 shipped it (with `dynamic` exports and `.ts`
 *     imports), which must fail to build;
 *   - the example with the share-link answer wrapped in `'use cache'`, which
 *     must build and must then serve the revoked link. That is the caching bug
 *     the example's README warns about, and the check must catch it.
 *
 * Bump CREATE_NEXT_APP when a new major lands; the check prints what it used.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CREATE_NEXT_APP = '16.4.6';
const PGLITE = '0.3.16';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const EXAMPLE = join(ROOT, 'examples', 'nextjs');
const SELF_TEST = process.argv.includes('--self-test');

// Every child is bounded. On its first CI run this check printed "clean" and
// then held the job for ten minutes, because the server it had started was
// still alive; a hang must be a failure with a name, never a six-hour wait.
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 300_000, killSignal: 'SIGKILL', ...opts });
  const timedOut = r.error?.code === 'ETIMEDOUT' ? `\n[timed out after 300 s: ${cmd} ${args.join(' ')}]` : '';
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${timedOut}` };
};

/** Pack once; every variant installs the same tarball. */
function pack(dir) {
  const r = run('npm', ['pack', '--pack-destination', dir], { cwd: CORE });
  const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'));
  if (r.status !== 0 || !tgz) throw new Error(`npm pack failed:\n${r.out}`);
  return join(dir, tgz);
}

/** A new project, once; each variant gets a copy of it. */
function scaffold(dir, tarball) {
  const r = run('npx', ['-y', `create-next-app@${CREATE_NEXT_APP}`, 'app', '--yes', '--use-npm', '--skip-git'], {
    cwd: dir,
  });
  const app = join(dir, 'app');
  if (r.status !== 0 || !existsSync(app)) throw new Error(`create-next-app failed:\n${r.out}`);
  const config = readFileSync(join(app, 'next.config.ts'), 'utf8');
  if (!/cacheComponents:\s*true/.test(config)) {
    throw new Error(
      `create-next-app@${CREATE_NEXT_APP} did not turn cacheComponents on; this check would not test ` +
        `what it claims. next.config.ts:\n${config}`,
    );
  }
  writeFileSync(
    join(app, 'app', 'layout.tsx'),
    'export default function RootLayout({ children }: { children: React.ReactNode }) {\n' +
      '  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n',
  );
  const i = run('npm', ['install', '--no-audit', '--no-fund', tarball, `@electric-sql/pglite@${PGLITE}`], {
    cwd: app,
  });
  if (i.status !== 0) throw new Error(`installing the tarball failed:\n${i.out}`);
  const next = JSON.parse(readFileSync(join(app, 'node_modules', 'next', 'package.json'), 'utf8')).version;
  return { app, next };
}

/**
 * Put the example files into THE project, fresh, optionally changed. One
 * project for every variant, reset in place: copying a project with its
 * node_modules breaks React's single-copy assumption and the template's own
 * page then fails to prerender, which would be a failure of this check, not of
 * the example.
 */
function variant(app, mutate) {
  for (const d of [join(app, 'app', 'api'), join(app, 'app', '[...filelayer]'), join(app, 'lib'), join(app, '.next')]) {
    rmSync(d, { recursive: true, force: true });
  }
  cpSync(join(EXAMPLE, 'app'), join(app, 'app'), { recursive: true });
  cpSync(join(EXAMPLE, 'lib'), join(app, 'lib'), { recursive: true });
  mutate?.(app);
  return app;
}

async function serveAndDrive(app) {
  const port = 4300 + Math.floor(Math.random() * 600);
  // `next start` forks `next-server`. Started in its own process group, so the
  // whole group is stopped at the end: killing only the direct child left
  // next-server running and the check never exited.
  const server = spawn(process.execPath, [join(app, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(port)], {
    cwd: app,
    env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const exited = new Promise((r) => server.once('exit', r));
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  // Every request is bounded, so a hung server fails this check with a name
  // rather than hanging it.
  const realFetch = globalThis.fetch;
  const fetch = (url, init = {}) => realFetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  try {
    for (let t = 0; ; t++) {
      if (t > 120) throw new Error(`next start did not answer within 60 s:\n${log}`);
      try {
        await fetch(`${base}/api/files?org=x`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const as = (u) => ({ 'x-demo-user': u });
    const steps = [];
    const expect = (name, ok, detail) => steps.push({ name, ok, detail });

    const form = new FormData();
    form.set('org', 'acme');
    form.set('file', new File(['CONTRACT BODY'], 'contract.txt', { type: 'text/plain' }));
    const up = await fetch(`${base}/api/files`, { method: 'POST', headers: as('alice'), body: form });
    const upBody = await up.json().catch(() => ({}));
    expect('upload', up.status === 201 && typeof upBody.id === 'string', `status ${up.status}`);
    const id = upBody.id;

    const own = await fetch(`${base}/f/${id}`, { headers: as('alice') });
    expect('the owner reads it', own.status === 200 && (await own.text()) === 'CONTRACT BODY', `status ${own.status}`);
    const stranger = await fetch(`${base}/f/${id}`, { headers: as('bob') });
    expect('a stranger right after is refused', stranger.status === 404, `status ${stranger.status}`);

    const mint = await fetch(`${base}/api/files/${id}/share`, {
      method: 'POST',
      headers: { ...as('alice'), 'content-type': 'application/json' },
      body: '{}',
    });
    const link = await mint.json().catch(() => ({}));
    expect('a share link is minted', mint.status === 201 && typeof link.url === 'string', `status ${mint.status}`);
    const path = link.url ? new URL(link.url).pathname : '/d/none';

    const first = await fetch(`${base}${path}`);
    expect('the link downloads', first.status === 200 && (await first.text()) === 'CONTRACT BODY', `status ${first.status}`);

    const revoke = await fetch(`${base}/api/files/${id}/share?grant=${encodeURIComponent(link.grantId)}`, {
      method: 'DELETE',
      headers: as('alice'),
    });
    expect('alice revokes it', revoke.status === 200, `status ${revoke.status}`);

    const again = await fetch(`${base}${path}`);
    expect('the SAME link, on the next request, is refused', again.status === 404, `status ${again.status}`);
    return steps;
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {}
    const stopped = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 10_000))]);
    if (!stopped) {
      try {
        process.kill(-server.pid, 'SIGKILL');
      } catch {}
    }
  }
}

// The build's own route table must call every example route dynamic (`ƒ`):
// that is Next saying, in its words, that nothing of these is prerendered.
const ROUTES = ['/[...filelayer]', '/api/files', '/api/files/[id]/share'];

async function check(base, mutate) {
  const app = variant(base, mutate);
  const b = run('npx', ['next', 'build'], { cwd: app });
  if (b.status !== 0) return { built: false, out: b.out };
  const notDynamic = ROUTES.filter((r) => !new RegExp(`ƒ ${r.replace(/[[\]./]/g, '\\$&')}\\s*$`, 'm').test(b.out));
  const steps = [
    { name: 'next build lists every example route as dynamic (ƒ)', ok: notDynamic.length === 0, detail: notDynamic.join(', ') || 'all three' },
    ...(await serveAndDrive(app)),
  ];
  return { built: true, steps, out: b.out };
}

const work = mkdtempSync(join(tmpdir(), 'filelayer-next-build-'));
let failed = false;
try {
  const tarball = pack(work);
  const { app: base, next } = scaffold(mkdtempSync(join(work, 'base-')), tarball);
  console.log(`create-next-app@${CREATE_NEXT_APP} (next ${next}), cacheComponents on, @filelayer/core from ${tarball.split('/').pop()}`);

  if (!SELF_TEST) {
    const r = await check(base);
    if (!r.built) {
      console.error(r.out.split('\n').filter((l) => l.trim()).slice(-25).join('\n'));
      console.error('\ncheck-nextjs-build: FAILED. examples/nextjs does not build in a new create-next-app project.');
      process.exit(1);
    }
    for (const s of r.steps) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}  (${s.detail})`);
    if (r.steps.some((s) => !s.ok)) {
      console.error('\ncheck-nextjs-build: FAILED. The built app does not hold on the path above.');
      process.exit(1);
    }
    console.log('check-nextjs-build: clean. The example builds under cacheComponents and a revoked link is refused on the next request.');
  } else {
    // Control 1: the example as 0.35.2 shipped it.
    const old = await check(base, (app) => {
      for (const f of ['app/[...filelayer]/route.ts', 'app/api/files/route.ts', 'app/api/files/[id]/share/route.ts']) {
        const p = join(app, f);
        let s = readFileSync(p, 'utf8').replace(/from '(\.\.[^']*lib\/filelayer)'/, "from '$1.ts'");
        s += "\nexport const dynamic = 'force-dynamic';\n";
        writeFileSync(p, s);
      }
    });
    const c1 = !old.built && /not compatible with `nextConfig.cacheComponents`|allowImportingTsExtensions/.test(old.out);
    console.log(`  ${c1 ? 'ok  ' : 'FAIL'} the 0.35.2 example (dynamic export, .ts imports) does not build`);

    // Control 2: the share-link answer cached.
    const cached = await check(base, (app) => {
      const p = join(app, 'app', '[...filelayer]', 'route.ts');
      let s = readFileSync(p, 'utf8');
      const anchor = 'async function handler(req: Request): Promise<Response> {';
      if (!s.includes(anchor)) throw new Error('self-test: the catch-all route changed shape; update the control');
      s = s.replace(
        anchor,
        `async function cachedLink(url: string): Promise<{ status: number; body: string; type: string }> {
  'use cache';
  const res = await handler(new Request(url));
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type') ?? '' };
}

async function cachedGet(req: Request): Promise<Response> {
  if (!new URL(req.url).pathname.startsWith('/d/')) return handler(req);
  const r = await cachedLink(req.url);
  return new Response(r.body, { status: r.status, headers: { 'content-type': r.type } });
}

${anchor}`,
      );
      s = s.replace('export const GET = handler;', 'export const GET = cachedGet;');
      writeFileSync(p, s);
    });
    const revokedServed = cached.built && cached.steps.find((x) => x.name.startsWith('the SAME link'))?.ok === false;
    console.log(
      `  ${revokedServed ? 'ok  ' : 'FAIL'} with 'use cache' on the share link, the revoked link is still served and the check fails` +
        (cached.built ? '' : ` (did not build:\n${cached.out.slice(-1500)})`),
    );
    failed = !(c1 && revokedServed);
    console.log(`check-nextjs-build --self-test: ${(c1 ? 1 : 0) + (revokedServed ? 1 : 0)}/2 controls behaved`);
    if (failed) process.exit(1);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
// Nothing this check started may keep the process, or the job, alive.
process.exit(failed ? 1 : 0);
