#!/usr/bin/env node
/**
 * Every link and every script reference in the shipped documentation must
 * resolve. Nothing else.
 *
 *   node tools/check-doc-links.mjs
 *
 * Three classes of rot, all of which we shipped at least once:
 *
 *   1. A relative link to a file that does not exist, or that exists in the
 *      repository but not in the npm tarball. A README rendered on npmjs.com
 *      resolves relative links against the REGISTRY, not against GitHub, so a
 *      link to `ARCHITECTURE-PROGRESSIVE.md` from a package whose `files` array
 *      does not contain it is a 404 for every reader who found us through npm.
 *      Links out of `README.md` and `packages/core/**` must therefore be
 *      absolute, or point at something inside the tarball.
 *   2. An in-page anchor (`#section`) with no matching heading.
 *   3. `npm run <script>` in a fenced block naming a script that no longer
 *      exists in the package.json it is being run against.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** Docs we ship, and where a relative link from each one is resolved. */
const DOCS = [
  'README.md',
  'docs/QUICKSTART.md',
  'packages/core/SEMANTICS.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'llms.txt',
  'packages/core/CHANGELOG.md',
  'packages/core/MIGRATIONS.md',
];

/**
 * The one namespace every public URL must be rooted at.
 *
 * A repository that refers to itself under two names is broken in a way no
 * individual link check can see: each URL is well-formed, and half of them
 * 404. Both values are asserted below against every file in `COHERENCE_FILES`.
 */
const GITHUB_ORG = 'filelayer';
const GITHUB_REPO = 'filelayer';
const NPM_SCOPE = 'filelayer';

/** Files that leave the repository inside the npm tarball. */
const corePkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
const TARBALL_ROOTS = new Set(corePkg.files ?? []);

/** package.json files a fenced `npm run` block might be talking about. */
const SCRIPT_SOURCES = [
  { dir: '.', scripts: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {} },
  { dir: 'packages/core', scripts: corePkg.scripts ?? {} },
];
const ALL_SCRIPTS = new Set(SCRIPT_SOURCES.flatMap((s) => Object.keys(s.scripts)));

const problems = [];
function fail(file, line, msg) {
  problems.push(`${file}:${line}  ${msg}`);
}

// -----------------------------------------------------------------------------

function headingAnchors(md) {
  const anchors = new Set();
  for (const line of md.split('\n')) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    // GitHub's rule: lowercase, drop everything that is not a word character,
    // a space or a hyphen, then replace each REMAINING space with a hyphen --
    // individually, which is why "1 — a" becomes "1--a".
    anchors.add(
      m[1]
        .toLowerCase()
        .replace(/`/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s/g, '-'),
    );
  }
  return anchors;
}

for (const doc of DOCS) {
  const abs = join(ROOT, doc);
  if (!existsSync(abs)) {
    fail(doc, 0, 'listed in DOCS but does not exist');
    continue;
  }
  const md = readFileSync(abs, 'utf8');
  const lines = md.split('\n');
  const anchors = headingAnchors(md);
  const shipsFromTarball = doc === 'README.md' || doc.startsWith('packages/core/');

  lines.forEach((rawLine, i) => {
    const n = i + 1;
    // Inline code spans are not markdown links. `fl['getFileRecord'](id)` looks
    // exactly like one to a regex.
    const line = rawLine.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length));

    // --- links -------------------------------------------------------------
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = m[1];

      // An absolute URL into OUR OWN repository IS checkable offline, and it is
      // the kind that rots silently: a doc is renamed, every relative link is
      // updated by the check below, and the absolute ones keep pointing at a
      // path that no longer exists. Nobody notices until a reader clicks.
      const self = new RegExp(
        `^https://github\\.com/${GITHUB_ORG}/${GITHUB_REPO}/(?:blob|tree)/main/([^#?]+)`,
      ).exec(target);
      if (self) {
        const p = decodeURIComponent(self[1]).replace(/\/$/, '');
        if (!existsSync(join(ROOT, p))) {
          fail(doc, n, `dead absolute self-link: ${target} (no such path: ${p})`);
        }
        continue;
      }

      if (/^(https?:|mailto:)/.test(target)) continue; // not our problem offline

      if (target.startsWith('#')) {
        const a = target.slice(1).toLowerCase();
        if (!anchors.has(a)) fail(doc, n, `dead in-page anchor: ${target}`);
        continue;
      }

      const [path] = target.split('#');
      const resolved = resolve(dirname(abs), path);
      const rel = relative(ROOT, resolved).split(sep).join('/');

      if (!existsSync(resolved)) {
        fail(doc, n, `dead relative link: ${target} (resolves to ${rel})`);
        continue;
      }
      if (shipsFromTarball) {
        // Relative to packages/core for a shipped doc; README lives at the repo
        // root but is copied into the tarball, so it must not reach upward.
        const fromCore = doc === 'README.md' ? rel : relative(join(ROOT, 'packages/core'), resolved);
        const top = String(fromCore).split('/')[0];
        if (!TARBALL_ROOTS.has(top)) {
          fail(
            doc,
            n,
            `relative link "${target}" points outside the npm tarball (${top}). ` +
              `Use an absolute https:// URL, or add it to packages/core "files".`,
          );
        }
      }
    }

    // --- script references -------------------------------------------------
    for (const m of line.matchAll(/npm (?:run |--prefix \S+ run )([a-z0-9:_-]+)/gi)) {
      const script = m[1];
      if (!ALL_SCRIPTS.has(script)) {
        fail(doc, n, `\`npm run ${script}\` — no such script in any package.json`);
      }
    }

    // --- bare file references inside backticks ------------------------------
    // `@` is in the class so that a scoped-package path such as
    // `node_modules/@filelayer/core/schema.sql` matches in FULL and is then
    // skipped by the guard below, rather than matching from the `@` onward and
    // being reported as a missing repository path.
    for (const m of rawLine.matchAll(/`((?:[\w./@-]+\/)+[\w.-]+\.(?:ts|mjs|js|sql|json|md))`/g)) {
      const path = m[1];
      if (path.startsWith('node_modules')) continue;
      const candidates = [
        join(ROOT, path),
        resolve(dirname(abs), path),
        join(ROOT, 'packages/core', path),
      ];
      if (!candidates.some(existsSync)) {
        fail(doc, n, `references a path that does not exist: ${path}`);
      }
    }
  });
}

// -----------------------------------------------------------------------------
// Every script in every package.json must point at something that exists.
// -----------------------------------------------------------------------------
for (const { dir, scripts } of SCRIPT_SOURCES) {
  for (const [name, cmd] of Object.entries(scripts)) {
    // Longest alternative first, and a boundary after it, so `tsconfig.build.json`
    // is not read as `tsconfig.build.js`.
    for (const m of String(cmd).matchAll(
      /(?:^|\s)((?:\.\.?\/)?[\w./-]+\.(?:json|mjs|sql|ts|js)(?![\w.]))/g,
    )) {
      const path = m[1];
      const abs = resolve(ROOT, dir, path);
      if (!existsSync(abs)) {
        fail(
          join(dir, 'package.json'),
          0,
          `script "${name}" references ${path}, which does not exist`,
        );
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Everything the package claims to ship must actually be there.
// -----------------------------------------------------------------------------
// `dist` is a build output, and README.md/LICENSE/NOTICE are copied in from the
// repository root by `prepack`, so all four are legitimately absent from a
// checkout that has not packed yet.
//
// This set is derived from the `prepack` script rather than hardcoded, because
// the two drifted once already: NOTICE was added to `prepack` and to `files`
// but not here, which failed the build on a file that was never supposed to
// exist yet. Keeping one source of truth means adding a copied file to
// `prepack` is now enough.
// Matches the array literal `prepack` copies from, e.g. ['README.md','LICENSE'].
// Extensionless names such as LICENSE and NOTICE must be picked up too, so this
// takes every quoted string inside the first bracketed list.
const prepackScript = corePkg.scripts?.prepack ?? '';
const prepackList = prepackScript.match(/\[([^\]]*)\]/)?.[1] ?? '';
const PREPACK_COPIES = [...prepackList.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
const PREPACK_GENERATED = new Set(['dist', ...PREPACK_COPIES]);
for (const entry of corePkg.files ?? []) {
  const abs = join(ROOT, 'packages/core', entry);
  if (PREPACK_GENERATED.has(entry)) continue;
  if (!existsSync(abs)) {
    fail('packages/core/package.json', 0, `"files" lists ${entry}, which does not exist`);
  }
}

// -----------------------------------------------------------------------------
// Namespace coherence.
// -----------------------------------------------------------------------------
// Every public reference to this project must name the same GitHub org and the
// same npm scope. This is not something a per-link check can catch: each URL is
// individually well-formed, and if half of them say `filelayer` and half say
// something else, half of them 404 and the project looks abandoned.
//
// Deliberately narrow: it only fires on a URL that is clearly about US -- a
// GitHub path whose repository name contains "filelayer", or an npm package
// whose name contains "filelayer". Links to unrelated third-party projects are
// none of its business.
// -----------------------------------------------------------------------------
const COHERENCE_FILES = [
  'README.md',
  'llms.txt',
  'packages/core/CHANGELOG.md',
  'packages/core/MIGRATIONS.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'docs/QUICKSTART.md',
  'package.json',
  'packages/core/package.json',
  'packages/core/SEMANTICS.md',
  'packages/core/CHANGELOG.md',
  'packages/core/MIGRATIONS.md',
  'openapi.json',
  'openapi.yaml',
  'NOTICE',
  '.github/workflows/ci.yml',
];

for (const file of COHERENCE_FILES) {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue; // optional members of the list
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      const n = i + 1;
      for (const m of line.matchAll(/github\.com\/([\w.-]+)\/([\w.-]*filelayer[\w.-]*)/gi)) {
        const [, org, repo] = m;
        const cleanRepo = repo.replace(/\.git$/, '');
        if (org !== GITHUB_ORG || cleanRepo !== GITHUB_REPO) {
          fail(
            file,
            n,
            `inconsistent GitHub namespace: github.com/${org}/${repo} ` +
              `(everything else says github.com/${GITHUB_ORG}/${GITHUB_REPO})`,
          );
        }
      }
      for (const m of line.matchAll(/(?:npmjs\.com\/package\/|["'(])@([\w.-]+)\/core\b/g)) {
        if (m[1] !== NPM_SCOPE) {
          fail(file, n, `inconsistent npm scope: @${m[1]}/core (expected @${NPM_SCOPE}/core)`);
        }
      }
    });
}

if (problems.length === 0) {
  console.log(
    `check-doc-links: clean. ${DOCS.length} document(s); all links, anchors, scripts ` +
      `and self-URLs resolve, and every namespace says ${GITHUB_ORG}/${GITHUB_REPO}.`,
  );
  process.exit(0);
}

console.error('\ncheck-doc-links: FAILED\n');
for (const p of problems) console.error('  ' + p);
console.error(`\n${problems.length} problem(s).\n`);
process.exit(1);
