#!/usr/bin/env node
/**
 * EVERY RELATIVE PATH INSIDE THE TARBALL MUST RESOLVE INSIDE THE TARBALL.
 *
 *   node tools/check-install-reach.mjs              # check, exit 1 on a hit
 *   node tools/check-install-reach.mjs --list       # what it resolved
 *   node tools/check-install-reach.mjs --self-test  # the negative control only
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * On 4 October 2026 an outside analyst was handed the published `0.13.1` tarball
 * and nothing else, and asked to describe the package. Inside an hour it had
 * found two things no gate in this repository could see, for the same reason:
 *
 *   1. `test/tiers.test.ts` and `test/vault-example.test.ts` imported
 *      `../../../examples/...`. From `packages/core/test/` that is the
 *      repository root and resolves. From `node_modules/@filelayer/core/test/`
 *      it escapes the package, so both files threw `ERR_MODULE_NOT_FOUND` and
 *      28 tests -- every example-integration test there is -- did not run for
 *      anyone using the shipped suite. Which is the only audience a shipped
 *      suite has.
 *
 *   2. `TRUST.md`, `SECURITY.md`, `ARCHITECTURE-PROGRESSIVE.md` and
 *      `benchmark/load/RESULTS.md` are cited from documents that DO ship, for
 *      numbers those documents rely on, and none of the four was in the
 *      tarball. An offline reviewer following the README's most prominent link
 *      arrived nowhere.
 *
 * Both are the same class of defect and the class has a name:
 * **every gate in this repository ran beside the repository.** `check:links`
 * resolves a relative path from the file's location in the checkout, where
 * `../../../examples/` and `TRUST.md` both exist. `check:offline` asks whether
 * the files on a hand-written ANCHORS list ship, which is a question about the
 * list, not about the documents. `npm test` runs in `packages/core`, where the
 * three-level import is correct. Each gate was individually right and the set
 * of them never asked the reader's question, which is:
 *
 *     I have `npm install`ed this and nothing else. Does what it tells me to
 *     open, open? Does what it tells me to run, run?
 *
 * So this check packs the package, extracts the tarball, and asks that question
 * inside the extracted directory, where the repository is not reachable. A path
 * that only works because the checkout is one directory up cannot pass here.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT CHECKS
 * -----------------------------------------------------------------------------
 *
 *   1. IMPORTS. Every relative `import`/`export ... from '<path>'` and
 *      `import('<path>')` in every shipped `.ts`, `.mts`, `.mjs` and `.js` file
 *      resolves to a file that is in the tarball. This is the one that catches
 *      an escape, because `../../../anything` from inside the extracted
 *      package lands outside it and there is nothing there.
 *
 *   2. DOCUMENT LINKS. Every relative markdown link target and every backticked
 *      repository path in a shipped `.md` or `.txt` file resolves inside the
 *      tarball, or is excused by name with a reason. A document that ships and
 *      points at a document that does not is the defect above; the fix is
 *      either to ship the target or to cite it as an absolute URL, and this
 *      check is indifferent to which, because both answers work for the reader.
 *
 * Absolute URLs are not this check's business -- `check:links` already resolves
 * those against the repository and `check:web` against the site.
 *
 * -----------------------------------------------------------------------------
 * THE NEGATIVE CONTROL
 * -----------------------------------------------------------------------------
 *
 * The scan is run against a copy of the extracted package with two deliberate
 * breaks injected: an import that escapes the package root, and a markdown link
 * to a file that is not shipped. If either survives, this gate is not working
 * and says so instead of printing a tick. It runs on every invocation.
 */

import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  statSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE = join(ROOT, 'packages', 'core');
const KEEP = process.argv.includes('--keep');

/**
 * Relative document targets that are allowed not to be in the tarball, each
 * with the reason. The reason is the point: an exception without one is how a
 * gate becomes decoration.
 *
 * Scoped to one file each, because a bare target string would excuse the same
 * path in a document where it IS a trap. The right fix for a citation of an
 * unshipped file is usually "cite it as a URL" or "ship it"; this list is for
 * the third case, where the unresolvable path is the subject of the sentence.
 */
const DOC_EXCEPTIONS = [
  {
    file: 'CHANGELOG.md',
    target: '../../packages/core/src/index.ts',
    why:
      'the 0.14.0 entry quotes the two import paths it fixed, which is the one ' +
      'place a path that does not resolve from an install is the correct thing ' +
      'to write. A changelog that cannot name the defect it records is a worse ' +
      'changelog, and a gate that forbids it teaches people to stop recording ' +
      'defects.',
  },
];

/**
 * Directories this package NEVER ships. A backticked path under one of these is
 * prose naming a file in the repository, which is legitimate -- a changelog
 * that cannot name the gate it added is a worse changelog. Nobody with an
 * install goes looking for `tools/`, because no version of this package has
 * ever had a `tools/`.
 *
 * The rule has teeth where it matters: a backticked path under a directory the
 * package DOES ship (`docs/`, `test/`, `examples/`, `src/`) must exist, because
 * a reader who finds `docs/` in their install will reasonably look for
 * `docs/whatever-you-just-named.md` and must not come up empty.
 *
 * MARKDOWN LINKS ARE NOT COVERED BY THIS. A link is an instruction to open
 * something; it must resolve inside the tarball or be an absolute URL,
 * wherever it points.
 */
const NEVER_SHIPPED_DIRS = ['tools/', 'benchmark/', 'architecture/', 'web/', '.github/', '.measured/'];

/**
 * `dist/` is excluded from the IMPORT scan, and this is the one exclusion in
 * this file that is not a judgement call.
 *
 * `tsc` emits `export * from './authz.ts'` into the `.d.ts` files, because the
 * sources use `.ts` specifiers under `allowImportingTsExtensions`. There is no
 * `dist/authz.ts`, so a path-existence test reports 26 unreachable imports --
 * and a consumer compiles against them without complaint, because TypeScript
 * resolves a `.ts` specifier in a declaration file to the adjacent `.d.ts`.
 * Verified by typechecking a consumer against the installed `dist/` on
 * 4 October 2026: resolution succeeds. The `packaging` CI job additionally
 * imports and calls the package at runtime from a directory that has never
 * seen this repository, which is the stronger statement.
 *
 * Reporting those 26 would be a gate that cries wolf 26 times on every run,
 * and a gate nobody reads is the failure mode this whole family of checks
 * exists to avoid.
 */
const IMPORT_SCAN_SKIP = ['dist/'];

const CODE_EXT = new Set(['.ts', '.mts', '.mjs', '.js', '.cts', '.cjs']);
const DOC_EXT = new Set(['.md', '.txt']);

/**
 * Blank out inline code spans before looking for markdown links.
 *
 * `fl['getFileRecord'](id)` inside backticks is `[...](...)`, which the link
 * pattern reads as a link to a file called `id`. Found by this gate's first
 * run against SEMANTICS.md:791. Replaced with spaces rather than removed so
 * every reported line number stays correct.
 */
const withoutCodeSpans = (text) =>
  text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * A relative specifier, resolved the way Node would for an explicit extension,
 * plus the two implicit forms this package actually uses. Deliberately NOT a
 * full resolver: the specifiers here all carry an extension, and a resolver
 * that guesses would hide a missing extension rather than report it.
 */
function resolvesTo(fromFile, spec, rootDir) {
  const base = resolve(dirname(fromFile), spec);
  // OUTSIDE THE PACKAGE IS A FAILURE EVEN IF IT EXISTS ON THIS MACHINE. The
  // whole defect was a path that resolved because the repository happened to be
  // there, so a containment test comes before an existence test.
  const rel = relative(rootDir, base);
  if (rel.startsWith('..')) return { ok: false, why: 'escapes the package root', at: base };
  for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.js')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return { ok: true, at: candidate };
  }
  return { ok: false, why: 'not in the tarball', at: base };
}

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[\s\S]{0,400}?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Markdown links, and backticked paths that look like a repository file. */
const MD_LINK_RE = /\[[^\]]*\]\(\s*(?!https?:|mailto:|#)([^)\s#]+)(?:#[^)\s]*)?\s*\)/g;
const BACKTICK_PATH_RE =
  /`((?:\.\/|\.\.\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:md|txt|sql|json|ts|mjs|yaml|yml))`/g;

function scan(rootDir) {
  const findings = [];
  const resolved = [];
  for (const file of walk(rootDir)) {
    const ext = extname(file);
    const rel = relative(rootDir, file);
    if (CODE_EXT.has(ext)) {
      if (IMPORT_SCAN_SKIP.some((d) => rel.startsWith(d))) continue;
      const text = readFileSync(file, 'utf8');
      const re = new RegExp(IMPORT_RE.source, IMPORT_RE.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;
        const line = text.slice(0, m.index).split('\n').length;
        const r = resolvesTo(file, spec, rootDir);
        if (r.ok) resolved.push({ kind: 'import', rel, spec });
        else findings.push({ kind: 'import', rel, line, spec, why: r.why });
      }
    } else if (DOC_EXT.has(ext)) {
      const raw = readFileSync(file, 'utf8');
      for (const [kind, pattern, source] of [
        ['link', MD_LINK_RE, withoutCodeSpans(raw)],
        ['path', BACKTICK_PATH_RE, raw],
      ]) {
        const re = new RegExp(pattern.source, pattern.flags);
        const text = source;
        let m;
        while ((m = re.exec(text)) !== null) {
          const spec = m[1];
          if (!spec || /^[a-z][a-z0-9+.-]*:/i.test(spec)) continue;
          // SCOPED TO ONE FILE. A bare target string would excuse the same
          // path everywhere, including in a document where it IS a trap.
          if (DOC_EXCEPTIONS.some((e) => e.file === rel && e.target === spec)) continue;
          // See NEVER_SHIPPED_DIRS: prose may name a repository-only file, a
          // link may not.
          if (
            kind === 'path' &&
            NEVER_SHIPPED_DIRS.some((d) => spec.startsWith(d) || spec.includes(`/${d}`))
          ) {
            continue;
          }
          const line = text.slice(0, m.index).split('\n').length;
          // A BACKTICKED PATH IS RESOLVED FROM THE PACKAGE ROOT AS WELL AS FROM
          // THE FILE. Prose writes `packages/core/test/range.test.ts` meaning
          // the repository, and `test/range.test.ts` meaning the install; both
          // are the same file and both are legitimate for a reader.
          const fromFile = resolvesTo(file, spec.startsWith('.') ? spec : `./${spec}`, rootDir);
          const fromRoot = resolvesTo(join(rootDir, 'x'), `./${spec.replace(/^packages\/core\//, '')}`, rootDir);
          if (fromFile.ok || fromRoot.ok) resolved.push({ kind: 'doc', rel, spec });
          else findings.push({ kind: 'doc', rel, line, spec, why: fromFile.why });
        }
      }
    }
  }
  return { findings, resolved };
}

// --- pack and extract -------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'filelayer-reach-'));
let pkgRoot;
try {
  execFileSync('npm', ['pack', '--pack-destination', work], { cwd: CORE, encoding: 'utf8' });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error(`npm pack produced no tarball in ${work}`);
  execFileSync('tar', ['-xzf', join(work, tgz), '-C', work], { encoding: 'utf8' });
  pkgRoot = join(work, 'package');
  if (!existsSync(pkgRoot)) throw new Error('the tarball did not contain a package/ directory');
} catch (e) {
  console.error(`\ncheck-install-reach: could not pack and extract: ${e.message}\n`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

// --- the negative control, on a copy ---------------------------------------
const control = (() => {
  const dir = join(work, 'control');
  cpSync(pkgRoot, dir, { recursive: true });
  mkdirSync(join(dir, 'test'), { recursive: true });
  writeFileSync(join(dir, 'test', 'zz-control.ts'), "import { x } from '../../../outside/thing.ts';\n");
  writeFileSync(join(dir, 'ZZ-CONTROL.md'), 'See [the missing one](docs/not-shipped-anywhere.md).\n');
  const { findings } = scan(dir);
  const caughtImport = findings.some((f) => f.kind === 'import' && f.rel.endsWith('zz-control.ts'));
  const caughtDoc = findings.some((f) => f.kind === 'doc' && f.rel === 'ZZ-CONTROL.md');
  return { caughtImport, caughtDoc, ok: caughtImport && caughtDoc };
})();

if (process.argv.includes('--self-test')) {
  console.log(
    control.ok
      ? 'check-install-reach: negative control passed (an escaping import and an unshipped link both caught).'
      : `control DID NOT FAIL: import=${control.caughtImport} doc=${control.caughtDoc}`,
  );
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  process.exit(control.ok ? 0 : 1);
}

const { findings, resolved } = scan(pkgRoot);

if (process.argv.includes('--list')) {
  for (const r of resolved) console.log(`ok   [${r.kind}] ${r.rel}  ->  ${r.spec}`);
}

if (!KEEP) rmSync(work, { recursive: true, force: true });
else console.log(`\n  kept: ${work}`);

if (!control.ok) {
  console.error(
    '\ncheck-install-reach: the negative control did not fail ' +
      `(import=${control.caughtImport}, doc=${control.caughtDoc}). The gate is not working.\n`,
  );
  process.exit(1);
}

if (findings.length) {
  console.error('\ncheck-install-reach: FAILED\n');
  const imports = findings.filter((f) => f.kind === 'import');
  const docs = findings.filter((f) => f.kind === 'doc');
  if (imports.length) {
    console.error('  SHIPPED CODE THAT CANNOT RESOLVE ITS OWN IMPORTS:\n');
    for (const f of imports) {
      console.error(`  - ${f.rel}:${f.line}  imports '${f.spec}'  — ${f.why}`);
    }
    console.error(
      '\n    This file is in the tarball, so somebody will run it from an install. ' +
        'Rewrite\n    the specifier so it resolves from the PACKAGE root, not from the ' +
        'checkout.\n',
    );
  }
  if (docs.length) {
    console.error('  SHIPPED DOCUMENTS POINTING AT FILES THAT ARE NOT SHIPPED:\n');
    for (const f of docs) {
      console.error(`  - ${f.rel}:${f.line}  points at '${f.spec}'  — ${f.why}`);
    }
    console.error(
      '\n    Either add the target to `files` in packages/core/package.json and give it a\n' +
        '    tracked copy under packages/core/ (see tools/check-package-copies.mjs), or cite\n' +
        '    it as an absolute https:// URL. Both work for a reader with only an install;\n' +
        '    a relative path to a file that is not there does not.\n',
    );
  }
  console.error(`  ${findings.length} unreachable reference(s) inside the published tarball.\n`);
  process.exit(1);
}

console.log(
  `check-install-reach: clean. ${resolved.filter((r) => r.kind === 'import').length} relative ` +
    `import(s) and ${resolved.filter((r) => r.kind === 'doc').length} document reference(s) ` +
    'all resolve inside the extracted tarball; negative control correct.',
);
