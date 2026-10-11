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
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * WHAT GIT TRACKS, WHICH IS NOT WHAT IS ON THE DISK.
 *
 * On 5 October 2026 this check passed locally and failed in CI on six dead
 * self-links to `LIMITATIONS.md` and `ROADMAP.md`. Both files existed on the
 * author's disk and neither was in the commit: `.gitignore` is a top-level
 * allow-list, deny-by-default, and `git add -A` says nothing about a file it
 * is ignoring.
 *
 * The allow-list did its job. This check did not, and it is the fourth time
 * today the same shape has appeared: a gate that reads the filesystem it
 * happens to be standing in rather than the artifact a reader gets. CI was
 * right and ten minutes late, and the cost of late is a red build on a push
 * rather than a message before the commit.
 *
 * So a repository self-link now has to resolve to a TRACKED path. An untracked
 * file is a dead link for everybody except the person who wrote it.
 */
const TRACKED = (() => {
  try {
    return new Set(
      execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n')
        .filter(Boolean),
    );
  } catch {
    return null; // Not a checkout. Fall back to the filesystem below.
  }
})();

/** Tracked, or a tracked file underneath it when the target is a directory. */
const isTracked = (p) => {
  if (TRACKED === null) return existsSync(join(ROOT, p));
  return TRACKED.has(p) || [...TRACKED].some((f) => f.startsWith(`${p}/`));
};

/**
 * EVERY TRACKED DOCUMENT, DISCOVERED -- NOT A LIST.
 *
 * This was a hand-written array of sixteen paths, and on 11 October 2026 the
 * repository tracked seventy-seven documents. The sixty-one it did not name
 * had never had a single link checked, and among them were the whole shipped
 * Agent Skill -- SKILL.md and six reference files, in both copies -- and two
 * documents that go out inside the npm tarball with dead relative links in
 * them: `packages/core/LIMITATIONS.md` and `packages/core/SECURITY.md`. Every
 * reader who installed the package and followed either link got a 404, for as
 * long as those lines existed, while this gate printed `clean. 16 document(s)`.
 *
 * `clean. 16 document(s)` was the whole problem. It was true, and it read as
 * coverage. This is the third tool in this repository to have the defect it
 * was written to prevent, and the rule in AGENTS.md -- registration is not
 * coverage -- was written against the second one.
 *
 * So the set is now discovered, and every tracked `.md` and `.txt` is in it.
 * An exclusion has to be declared below WITH a reason, and a declaration that
 * matches nothing fails the build, because a dead exemption is how a list
 * silently stops covering.
 */
/** Top-level directories git tracks. A backticked path starting with one of
 *  these is a claim about this repository rather than a module specifier. */
const TOP_LEVEL = new Set(
  [...(TRACKED ?? [])].map((f) => f.split('/')[0]).filter((d) => d && !d.includes('.')),
);

const NOT_SCANNED = [
  // Nothing. Deliberately empty, and kept here rather than deleted so that the
  // next person tempted to exempt a document has somewhere to write down why,
  // and so that the empty case is visibly a decision rather than an omission.
];

const DOCS = (() => {
  const tracked = [...(TRACKED ?? [])].filter((f) => /\.(md|txt)$/.test(f)).sort();
  if (tracked.length === 0) {
    console.error(
      'check-doc-links: git tracks no .md or .txt files.\n\n' +
        '  This gate would pass by finding nothing. It needs a checkout, and note that\n' +
        '  the top level of this repository is a .gitignore allow-list, so a document\n' +
        '  that is not allowed is invisible here and to every reader.',
    );
    process.exit(2);
  }
  const dead = NOT_SCANNED.filter((x) => !tracked.includes(x.path));
  if (dead.length > 0) {
    console.error(
      `check-doc-links: ${dead.length} exclusion(s) match no tracked document: ` +
        `${dead.map((x) => x.path).join(', ')}.\n\n` +
        '  Remove them. An exclusion that matches nothing is a line that looks like a\n' +
        '  decision and does nothing, and the next document to land at that path would\n' +
        '  be silently exempt.',
    );
    process.exit(2);
  }
  const excluded = new Set(NOT_SCANNED.map((x) => x.path));
  return tracked.filter((f) => !excluded.has(f));
})();

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
/** The published name, and the subpaths its `exports` map actually resolves. */
const PKG_NAME = corePkg.name;
const EXPORTED_SUBPATHS = new Set(Object.keys(corePkg.exports ?? {}));

/** package.json files a fenced `npm run` block might be talking about. */
/**
 * EVERY TRACKED package.json, DISCOVERED.
 *
 * This named two of the twenty this repository tracks, and the consequence
 * showed up the moment the document set widened: three benchmark reports
 * document `npm run loc`, the script exists in all four benchmark
 * package.json files, the runners it points at are tracked and present -- and
 * this check called all three references dead, because it had never been told
 * those package.json files exist.
 *
 * A gate that invents a defect is worse than one that misses it. It gets
 * believed once, and then it gets worked around.
 *
 * Third enumerated list in this one file, after the documents and the
 * top-level directories. They were all written by someone who knew the rule.
 */
const SCRIPT_SOURCES = [...(TRACKED ?? [])]
  .filter((f) => f === 'package.json' || f.endsWith('/package.json'))
  .sort()
  .map((f) => {
    const dir = f === 'package.json' ? '.' : dirname(f);
    try {
      return { dir, scripts: JSON.parse(readFileSync(join(ROOT, f), 'utf8')).scripts ?? {} };
    } catch {
      return { dir, scripts: {} };
    }
  });
if (SCRIPT_SOURCES.length === 0) {
  console.error('check-doc-links: git tracks no package.json. This gate needs a checkout.');
  process.exit(2);
}
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
        } else if (!isTracked(p)) {
          // ON THE DISK AND NOT IN THE COMMIT. See the note on TRACKED: this is
          // the case that passed here and failed in CI.
          fail(
            doc,
            n,
            `self-link to an UNTRACKED path: ${target}\n      ${p} exists on this disk and ` +
              `git is not tracking it, so the link is dead for every other reader. ` +
              `.gitignore at the root is an allow-list: add a line for it, in this commit.`,
          );
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
    // A DIRECTORY is a path claim too, and this check could not see one.
    //
    // The matcher below requires a file extension, so
    // `skills/filelayer-integration-workspace/trigger-2026-10-11-agent-access/`
    // was never examined at all -- a second, independent reason the same
    // MEASUREMENT.md line passed. A document that sends the reader to a
    // directory is making exactly the same promise as one that sends them to a
    // file, and a directory excluded by .gitignore keeps that promise only for
    // the author.
    //
    // Rooted at a top-level directory git actually tracks, so this is
    // discovery rather than another list to forget: a backticked token
    // beginning with one of those is a claim about THIS repository, and
    // anything else (an npm specifier, a URL fragment, `org:admin`) is not.
    for (const m of rawLine.matchAll(/`((?:[\w.@-]+\/)+[\w.@-]*)`/g)) {
      const path = m[1].replace(/\/$/, '');
      if (!path.includes('/')) continue;
      if (!TOP_LEVEL.has(path.split('/')[0])) continue;
      if (/\.(?:ts|mjs|js|sql|json|md|txt)$/.test(path)) continue; // the matcher below
      if (!isTracked(path)) {
        fail(
          doc,
          n,
          `references a directory that is not tracked: ${path}` +
            (existsSync(join(ROOT, path))
              ? '. It IS on this disk but git does not track it, so the reader cannot\n' +
                '      reach it. Describe where the material lives in words instead of citing a\n' +
                '      path: a path in backticks is an instruction to go and look, and a\n' +
                '      parenthesised "(internal)" next to it does not make it reachable. That\n' +
                '      exact combination is what this rule was written for.'
              : ''),
        );
      }
    }

    for (const m of rawLine.matchAll(/`((?:[\w./@-]+\/)+[\w.-]+\.(?:ts|mjs|js|sql|json|md))`/g)) {
      const path = m[1];
      if (path.startsWith('node_modules')) continue;

      // Only paths rooted at a top-level directory git tracks are claims about
      // THIS repository. The benchmark reports describe other people's trees --
      // Convex's `model/auth.ts`, a Vercel scaffold's `src/storage.mjs` -- and
      // this check was reporting them as our missing files the moment those
      // documents came into scope. It has no standing over a competitor's
      // layout.
      //
      // What this gives up: a typo in the FIRST segment (`pacakges/core/...`)
      // now reads as a foreign path and escapes. That is the honest cost of not
      // inventing jurisdiction, and it is the narrower failure -- a wrong first
      // segment is visible to a reader, where a wrong tail looks plausible.
      if (!TOP_LEVEL.has(path.split('/')[0])) continue;

      // A subpath import such as `@filelayer/core/openapi.json` is a MODULE
      // SPECIFIER, not a repository path, and looking for it on disk asks the
      // wrong question. The right question is whether `exports` in
      // packages/core/package.json actually resolves it -- a specifier the
      // documentation offers that npm will not resolve is exactly the class of
      // defect this file exists to catch, and until now it was invisible
      // because no such specifier had ever been documented.
      if (path.startsWith(PKG_NAME + '/')) {
        const subpath = './' + path.slice(PKG_NAME.length + 1);
        if (!EXPORTED_SUBPATHS.has(subpath)) {
          fail(
            doc,
            n,
            `documents the import specifier "${path}", which packages/core/package.json ` +
              `"exports" does not resolve. Add "${subpath}" to exports, or stop offering it. ` +
              `Exported: ${[...EXPORTED_SUBPATHS].join(', ')}`,
          );
        }
        continue;
      }

      // TRACKED, not existsSync. The header of this file promises that "a
      // repository self-link now has to resolve to a TRACKED path", and that
      // was true of the markdown links above and false right here for as long
      // as both existed -- this line read the filesystem it happened to be
      // standing in, which is the defect the header describes.
      //
      // The difference is not academic. `skills/*-workspace/` is excluded by
      // .gitignore, so a document citing a path inside it passes on the
      // author's machine and names a directory that does not exist for anyone
      // else. MEASUREMENT.md did exactly that on 11 October, in the same commit
      // that added a rule about published claims the reader cannot reach.
      //
      // The relative and packages/core candidates stay on the filesystem: they
      // resolve to a path whose tracked status is checked by the first
      // candidate when it is the same file, and keeping them loose avoids
      // re-deriving repository-root-relative forms here.
      const candidates = [resolve(dirname(abs), path), join(ROOT, 'packages/core', path)];
      if (!isTracked(path) && !candidates.some(existsSync)) {
        fail(
          doc,
          n,
          `references a path that is not tracked and does not exist: ${path}` +
            (existsSync(join(ROOT, path))
              ? '. It IS on this disk but git does not track it, so it is a dead ' +
                'reference for every other reader. `git check-ignore -v` names the rule.'
              : ''),
        );
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
// `dist` is a build output and is legitimately absent from a checkout that has
// not built yet. Nothing else in `files` is allowed to be missing.
//
// Until 0.4.3 this exemption also covered README.md, LICENSE and NOTICE, which
// `prepack` copied in from the repository root; the set was derived from the
// `prepack` script rather than hardcoded, because the two had drifted once
// already. Those files are tracked now, so the exemption shrank back to the one
// genuinely generated entry, and it is still derived rather than written twice:
// if a future `prepack` starts generating something again, that entry is
// exempt here and `tools/check-package-copies.mjs` objects to the generation.
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
