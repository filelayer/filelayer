#!/usr/bin/env node
/**
 * Install the package the way the documentation tells a reader to install it,
 * from the registry, and check that what arrives has the API the documentation
 * describes.
 *
 *   node tools/check-published-install.mjs
 *   node tools/check-published-install.mjs --allow-offline
 *
 * Why this exists, and why it is separate from every other install check.
 *
 * There were twenty-three gates before this one, and several of them have
 * `install` in the name. Every single one of them builds a tarball out of the
 * local checkout with `npm pack` and installs that. None of them had ever run
 * the command printed in the README. So the suite could be entirely green while
 * `npm install @filelayer/core` resolved to a release four versions behind the
 * one the documentation describes -- which is exactly what it did between
 * 0.18.0 and 0.20.0, because those were published under `--tag alpha` and the
 * registry left `latest` where it was. A reader following the published
 * instructions got a package without `deliveryFetch`, without
 * `auditIntegration`, and without the error catalogue, while five guides, a
 * worked example and an Agent Skill all told them to use those.
 *
 * The rule this encodes: verify against the published artifact, not against the
 * checkout. A tarball packed locally proves the code in the working tree is
 * coherent. It proves nothing at all about what a stranger receives.
 *
 * Offline: this check needs the network, and a check that silently passes when
 * it could not run is worse than no check. Without `--allow-offline` an
 * unreachable registry is a failure. With it, the skip is loud and the exit
 * code still reflects that nothing was verified when CI is detected.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = '@filelayer/core';
const ALLOW_OFFLINE = process.argv.includes('--allow-offline');
const IN_CI = process.env.CI === 'true' || process.env.CI === '1';

/**
 * Module exports the published documentation tells a reader to import, with the
 * surface that introduced each one. A name is listed here because a published
 * page says to import it, not because it exists in src -- the point of the
 * check is the gap between those two things.
 */
const DOCUMENTED_EXPORTS = [
  { name: 'Filelayer', where: 'README.md, every guide' },
  { name: 'FilelayerError', where: 'README.md, docs/guides/, skills/' },
  { name: 'deliveryHandler', where: 'README.md, docs/guides/serving-private-files.md' },
  { name: 'deliveryFetch', where: 'examples/nextjs/, skills/, docs/guides/' },
  { name: 'auditIntegration', where: 'skills/filelayer-integration/SKILL.md step 6' },
  { name: 'ERROR_CODES', where: 'ERRORS.md, skills/.../references/errors.md' },
  { name: 'isErrorCode', where: 'skills/.../references/errors.md' },
  { name: 'schemaStatus', where: 'README.md, docs/QUICKSTART.md' },
];

/** Files that must ship inside the tarball because a page tells a reader to open them. */
const DOCUMENTED_FILES = [
  { path: 'schema.sql', where: 'README.md, docs/QUICKSTART.md' },
  { path: 'ERRORS.md', where: 'skills/.../references/errors.md' },
  { path: 'errors.json', where: 'skills/.../references/errors.md' },
  { path: 'llms.txt', where: 'filelayer.dev' },
];

let failures = 0;
const fail = (what, detail) => {
  failures++;
  console.error(`  FAIL  ${what}\n        ${detail}`);
};

// -----------------------------------------------------------------------------
// What does the documentation actually tell a reader to type?
// -----------------------------------------------------------------------------
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const m = readme.match(new RegExp(`npm install (${PKG}(?:@[^\\s\`]+)?)`));
if (!m) {
  console.error(
    `check-published-install: no \`npm install ${PKG}\` command found in README.md.\n` +
      'This check derives the command it runs from the README rather than hard-coding\n' +
      'it, so that the thing verified is always the thing published. Refusing to pass.',
  );
  process.exit(2);
}
const SPEC = m[1];
console.log(`check-published-install: the README tells a reader to install \`${SPEC}\`.`);

// -----------------------------------------------------------------------------
// What does the registry hand them for that spec?
// -----------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'fl-published-'));
let resolved;
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', private: true }));
  execFileSync('npm', ['install', SPEC, '--no-audit', '--no-fund'], {
    cwd: work,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  resolved = JSON.parse(
    readFileSync(join(work, 'node_modules', PKG, 'package.json'), 'utf8'),
  ).version;
} catch (e) {
  rmSync(work, { recursive: true, force: true });
  const msg = String(e.stderr || e.message);
  const offline = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network|ETIMEDOUT/i.test(msg);
  if (offline && ALLOW_OFFLINE && !IN_CI) {
    console.log(
      '  SKIPPED: the registry is unreachable and --allow-offline was passed.\n' +
        '  Nothing was verified. This is only acceptable outside CI.',
    );
    process.exit(0);
  }
  console.error(
    `check-published-install: could not install ${SPEC} from the registry.\n` +
      (offline
        ? '  The registry was unreachable. This check cannot be satisfied offline, and\n' +
          '  passing anyway would report a verification that did not happen.\n'
        : '') +
      `  ${msg.split('\n').slice(0, 6).join('\n  ')}`,
  );
  process.exit(2);
}

const declared = JSON.parse(
  readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'),
).version;

console.log(`  the registry resolved it to ${resolved}; this checkout is ${declared}.`);

if (resolved !== declared) {
  fail(
    `the published install does not give a reader this version`,
    `\`npm install ${SPEC}\` resolves to ${resolved}, while the documentation in this\n` +
      `        repository describes ${declared}. Either the dist-tag the README's command\n` +
      `        reads has not been moved, or the release was never published. Until one of\n` +
      `        those is true, every page here describes software a reader cannot install.`,
  );
}

// -----------------------------------------------------------------------------
// Does the thing they received have the API the pages tell them to import?
// -----------------------------------------------------------------------------
let mod;
try {
  mod = await import(join(work, 'node_modules', PKG, 'dist/index.js'));
} catch {
  try {
    mod = await import(PKG, { parent: join(work, 'package.json') });
  } catch (e) {
    fail('the installed package could not be imported', String(e.message).slice(0, 300));
  }
}

if (mod) {
  for (const { name, where } of DOCUMENTED_EXPORTS) {
    if (!(name in mod)) {
      fail(
        `${name} is documented but not exported by ${resolved}`,
        `Described in: ${where}. A reader who follows that page gets an undefined import.`,
      );
    }
  }
}

for (const { path, where } of DOCUMENTED_FILES) {
  try {
    readFileSync(join(work, 'node_modules', PKG, path));
  } catch {
    fail(
      `${path} is documented but absent from ${resolved}`,
      `Referenced by: ${where}.`,
    );
  }
}

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
  console.error(
    `\ncheck-published-install: ${failures} failure(s). What a reader installs is not\n` +
      'what this repository documents. The fix is a publish or a dist-tag, not a doc edit.',
  );
  process.exit(1);
}

console.log(
  `  all ${DOCUMENTED_EXPORTS.length} documented export(s) and ${DOCUMENTED_FILES.length} ` +
    `documented file(s) are present in ${resolved}.`,
);
console.log('check-published-install: clean.');
