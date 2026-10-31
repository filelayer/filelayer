#!/usr/bin/env node
/**
 * A PAGE STAMPED WITH A VERSION CALLS ONLY API THAT VERSION'S PUBLISHED DIST HAS.
 *
 *     node tools/check-guide-api.mjs
 *     node tools/check-guide-api.mjs --self-test
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * On 31 October 2026 two live guides on filelayer.dev, stamped
 * `softwareVersion: 0.33.0` in their JSON-LD, told readers to call
 * `fl.runMaintenance()` and `fl.eraseActorFromAuditChain()`. Neither exists in
 * 0.33.0, the version npm serves. The guides were rendered from `main`, where
 * both had landed after the release. A reader who installs what the page says
 * and pastes what the page shows gets `is not a function`.
 *
 * `check:docs` executes every sample, but against THIS CHECKOUT's library, so
 * it passed: the code is right for the next release and wrong for the one the
 * page names. `check:web` compares the stamp with package.json, which was
 * 0.33.0 on both sides. Nothing compared the stamp with the API it promises.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES
 * -----------------------------------------------------------------------------
 *
 * For every tracked `web/**\/*.html` carrying a JSON-LD `softwareVersion` X:
 *
 *   1. Take the TypeScript/JavaScript code blocks on the page.
 *   2. Collect what they call: `.name(` and `name(`, and names imported from
 *      `@filelayer/core`.
 *   3. Keep only names that are OURS: declared in this checkout's
 *      `packages/core/dist/*.d.ts`. `res.end(`, `fetch(` or the reader's own
 *      helpers are not ours and are not judged.
 *   4. Fail on any of ours that X's published `dist/*.d.ts` does not declare.
 *
 * X's dist is read from the registry (`npm pack @filelayer/core@X`), never from
 * this checkout (D020). When X is the version in package.json and is not
 * published yet, there is no published dist to ask: the page is checked
 * against this checkout's build and the output says UNPUBLISHED, so a release
 * being prepared is not reported as a defect and is not reported as verified
 * against npm either. A stamp that is neither published nor being prepared
 * fails.
 *
 * KNOWN LIMIT: names are compared as identifiers, not by type. A new method
 * that shares its name with any identifier in X's declarations passes. That
 * errs towards silence, and is written here so nobody reads "clean" as more.
 *
 * Seen failing before it was trusted: on f5768fa it named runMaintenance on
 * background-jobs-for-user-files.html and eraseActorFromAuditChain on
 * erasing-a-user-with-an-append-only-audit-log.html, both against 0.33.0.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'packages', 'core');
const PKG_NAME = '@filelayer/core';

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'" };
const unescape = (s) => s.replace(/&(?:lt|gt|amp|quot|#39|#x27);/g, (m) => ENTITIES[m]);

/** TS/JS code blocks on a rendered page, unescaped. */
export function codeBlocks(html) {
  const out = [];
  const re = /<pre><code class="lang-(ts|typescript|js|javascript|mjs)">([\s\S]*?)<\/code><\/pre>/g;
  let m;
  while ((m = re.exec(html))) out.push(unescape(m[2].replace(/<[^>]+>/g, '')));
  return out;
}

/** Identifiers a block calls or imports from the package. */
export function usedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[1]);
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]@filelayer\/core[^'"]*['"]/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** Every identifier declared in a set of .d.ts files. Deliberately generous. */
export function declaredNames(dtsTexts) {
  const names = new Set();
  for (const t of dtsTexts) {
    const noComments = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of noComments.matchAll(/([A-Za-z_$][\w$]*)\s*[(<:?]/g)) names.add(m[1]);
    for (const m of noComments.matchAll(/(?:class|interface|type|const|function|enum|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of noComments.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const seg = part.trim().split(/\s+as\s+/);
        if (seg[seg.length - 1]) names.add(seg[seg.length - 1].replace(/^type\s+/, '').trim());
      }
    }
  }
  return names;
}

/** Problems for one page. */
export function judgePage(page, version, html, ours, published) {
  const problems = [];
  for (const code of codeBlocks(html)) {
    for (const name of usedNames(code)) {
      if (ours.has(name) && !published.has(name)) {
        problems.push(`${page}: stamped ${version}, calls \`${name}\`, which ${PKG_NAME}@${version} does not declare`);
      }
    }
  }
  return [...new Set(problems)];
}

function readDts(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((f) => f.endsWith('.d.ts')).map((f) => readFileSync(join(dir, f), 'utf8'));
}

if (process.argv.includes('--self-test')) {
  const ours = new Set(['Filelayer', 'share', 'runMaintenance', 'eraseActorFromAuditChain']);
  const published = new Set(['Filelayer', 'share']);
  const page = (code) =>
    `<pre><code class="lang-ts">${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre>`;
  const cases = [
    { name: 'new method on an older stamp', html: page('await fl.runMaintenance();'), fails: true },
    { name: 'new method imported by name', html: page("import { eraseActorFromAuditChain } from '@filelayer/core';"), fails: true },
    { name: 'published method', html: page("const fl = new Filelayer(db, s);\nawait fl.share(f, {});"), fails: false },
    { name: 'not ours (reader helper, builtin)', html: page('res.end(); await fetch(u); myHelper();'), fails: false },
    { name: 'new method in a SQL block is not code we judge', html: '<pre><code class="lang-sql">SELECT runMaintenance();</code></pre>', fails: false },
  ];
  let bad = 0;
  for (const c of cases) {
    const failed = judgePage('p', '0.0.0', c.html, ours, published).length > 0;
    const ok = failed === c.fails;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name} (expected ${c.fails ? 'refusal' : 'pass'})`);
  }
  console.log(`check-guide-api --self-test: ${cases.length - bad}/${cases.length} controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

// --- this checkout's API -----------------------------------------------------
const localDts = readDts(join(PKG_DIR, 'dist'));
if (!localDts || localDts.length === 0) {
  console.error('check-guide-api: FAILED\n\n  - packages/core/dist has no .d.ts files. Run `npm run build` first; without it nothing can be judged.');
  process.exit(1);
}
const ours = declaredNames(localDts);
const localVersion = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;

// --- pages and their stamps --------------------------------------------------
const pages = execFileSync('git', ['ls-files', '-z', 'web'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f.endsWith('.html'));
const stamped = [];
for (const p of pages) {
  const html = readFileSync(join(ROOT, p), 'utf8');
  const m = html.match(/"softwareVersion"\s*:\s*"([^"]+)"/);
  if (m) stamped.push({ page: p, version: m[1], html });
}
if (stamped.length === 0) {
  console.error('check-guide-api: FAILED\n\n  - no tracked web page carries a softwareVersion, so nothing was checked.');
  process.exit(1);
}

// --- each version's published declarations, from the registry --------------
const cache = new Map();
function publishedDts(version) {
  if (cache.has(version)) return cache.get(version);
  let result;
  try {
    const dir = mkdtempSync(join(tmpdir(), 'guide-api-'));
    const out = execFileSync('npm', ['pack', `${PKG_NAME}@${version}`, '--json', '--pack-destination', dir], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const file = JSON.parse(out)[0].filename;
    const x = join(dir, 'x');
    mkdirSync(x);
    execFileSync('tar', ['xzf', join(dir, file), '-C', x]);
    result = { state: 'published', dts: readDts(join(x, 'package', 'dist')) ?? [] };
  } catch (e) {
    // npm reports a missing version on stdout under --json and on stderr
    // without it; read both rather than depend on which.
    const msg = `${e.stdout ?? ''}\n${e.stderr ?? ''}\n${e.message ?? ''}`;
    result = /E404|No matching version|notarget/i.test(msg)
      ? { state: 'absent' }
      : { state: 'error', why: msg.split('\n').find((l) => l.trim()) ?? 'unknown error' };
  }
  cache.set(version, result);
  return result;
}

const problems = [];
const notes = [];
for (const { page, version, html } of stamped) {
  const pub = publishedDts(version);
  if (pub.state === 'error') {
    problems.push(`${page}: could not read ${PKG_NAME}@${version} from the registry (${pub.why}); nothing was checked for it`);
    continue;
  }
  if (pub.state === 'absent') {
    if (version !== localVersion) {
      problems.push(`${page}: stamped ${version}, which is not published and is not the version being prepared (${localVersion})`);
      continue;
    }
    notes.push(page);
    problems.push(...judgePage(page, version, html, ours, ours));
    continue;
  }
  problems.push(...judgePage(page, version, html, ours, declaredNames(pub.dts)));
}

if (problems.length > 0) {
  console.error(`check-guide-api: FAILED\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\n  A page may only show API its stamped version has. Publish the version, or keep the page on the old API.');
  process.exit(1);
}
const checkedPub = stamped.length - notes.length;
console.log(
  `check-guide-api: clean. ${checkedPub} page(s) checked against their published version on npm.` +
    (notes.length
      ? `\n  UNPUBLISHED: ${notes.length} page(s) stamped ${localVersion}, which npm does not have yet; ` +
        'checked against this checkout\'s build only, NOT against a published dist. Re-run after publishing.'
      : ''),
);
