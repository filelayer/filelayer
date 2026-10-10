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
import { createRequire } from 'node:module';
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

/**
 * Subpaths a published page tells a reader to IMPORT. Shipping the file is not
 * the same as the import resolving: `exports` is an allow-list, so a file can
 * sit in the tarball while `import '@filelayer/core/errors.json'` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The file list below checks presence; this one
 * checks reachability, and only this one matches what the reader types.
 */
const DOCUMENTED_SUBPATHS = [
  { spec: 'errors.json', json: true, where: 'skills/.../references/errors.md' },
  { spec: 'schema.sql', json: false, where: 'README.md, docs/QUICKSTART.md' },
  { spec: 'llms.txt', json: false, where: 'filelayer.dev, llms.txt' },
  { spec: 'openapi.json', json: true, where: 'docs/, check:openapi' },
  { spec: 'mcp', json: false, where: 'README.md, llms.txt: `@filelayer/core/mcp`' },
];

/** Files that must ship inside the tarball because a page tells a reader to open them. */
const DOCUMENTED_FILES = [
  { path: 'schema.sql', where: 'README.md, docs/QUICKSTART.md' },
  { path: 'ERRORS.md', where: 'skills/.../references/errors.md' },
  { path: 'errors.json', where: 'skills/.../references/errors.md' },
  { path: 'llms.txt', where: 'filelayer.dev' },
  // The CLI's `bin` target. Documented as `npx filelayer doctor`, which fails
  // with a confusing npm error rather than a useful one if the file is missing
  // from the tarball -- and it would be missing the moment `files` or the build
  // stopped including `dist`.
  { path: 'dist/cli.js', where: 'README.md, llms.txt: `npx filelayer doctor`' },
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
  // `--prefer-online` is load-bearing, not tidiness. npm answers dist-tag and
  // packument reads out of its local cache, so without it this check can report
  // the state of whoever's laptop it ran on rather than the state of the
  // registry: green after a bad publish, red after a good one. The first run of
  // this gate after `latest` was moved to 0.20.0 still said 0.17.0 for exactly
  // that reason, and a check that can be wrong in the reassuring direction is
  // the one failure mode this file exists to prevent.
  execFileSync('npm', ['install', SPEC, '--no-audit', '--no-fund', '--prefer-online'], {
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

// ---------------------------------------------------------------------------
// This gate does TWO jobs, and only one of them depends on this checkout being
// published. Separating them matters, because the first version conflated them
// and so a release commit could never have a green build: the docs describe the
// version being prepared, which by definition is not on the registry yet. That
// is the third time today the same mistake went into a gate -- `check:since`
// had it, and the first `check:published` compared the served README against
// the working tree. Verifying against the registry is right; making unreleased
// work look like a defect is not.
//
//   JOB 1, always checkable: `latest` is the newest version on the registry.
//           This is the one that catches a stuck dist-tag, which is the defect
//           that started all of this -- `latest` sat on 0.17.0 for two days
//           while four releases went out under `alpha`.
//
//   JOB 2, only when this checkout is published: what a reader installs has the
//           API these pages document. Before the publish the pages legitimately
//           run ahead, and after it they must not.
// ---------------------------------------------------------------------------
let newestPublished = resolved;
try {
  const res = await fetch(`https://registry.npmjs.org/${PKG}`, {
    headers: { accept: 'application/json' },
  });
  const packument = await res.json();
  const cmp = (a, b) => {
    const [x, y] = [a, b].map((v) => v.split('.').map(Number));
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  };
  const all = Object.keys(packument.versions).sort(cmp);
  newestPublished = all[all.length - 1];
  const latestTag = packument['dist-tags']?.latest;
  if (latestTag !== newestPublished) {
    fail(
      `the \`latest\` dist-tag is not the newest published version`,
      `\`latest\` points at ${latestTag} and the newest published version is\n` +
        `        ${newestPublished}. A reader following the published install command gets\n` +
        `        the older one. This is the defect that went unnoticed for two days:\n` +
        `        releases published under another tag do not move \`latest\`, and nothing\n` +
        `        else in this suite looks at what the registry actually serves.\n` +
        `        Fix: npm dist-tag add ${PKG}@${newestPublished} latest`,
    );
  }
} catch (e) {
  fail(
    'the published version list could not be read',
    `${String(e.message).slice(0, 160)}\n` +
      '        This check needs it; passing without it would report a verification that\n' +
      '        did not happen.',
  );
}

const thisCheckoutIsPublished = resolved === declared;

if (!thisCheckoutIsPublished) {
  if (declared === newestPublished) {
    fail(
      `${declared} is published but \`npm install\` gives ${resolved}`,
      'So the release happened and the tag did not move. See the dist-tag failure above.',
    );
  } else {
    console.log(
      `  ${declared} is not on the registry yet, so the API checks below are UNVERIFIED\n` +
        `  for it. They run against ${resolved}, which is what a reader installs today.\n` +
        '  This is a pending release, not a defect. After publishing, re-run this gate:\n' +
        '  that run is what proves the pages and the package agree.',
    );
  }
}

// -----------------------------------------------------------------------------
// Does the thing they received have the API the pages tell them to import?
// -----------------------------------------------------------------------------
// JOB 2. Only answerable for a version that is on the registry. When this
// checkout is unpublished the pages legitimately describe API the installed
// copy does not have, and the run after the publish is the one that proves
// they agree.
if (thisCheckoutIsPublished) {
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

  // Resolution, from inside the installed tree, exactly as a reader's own code
  // would do it. `createRequire` anchored at the scratch package.json gives the
  // same resolution `exports` governs, without this repository on the path.
  {
    const require = createRequire(join(work, 'package.json'));
    const pkgExports = JSON.parse(
      readFileSync(join(work, 'node_modules', PKG, 'package.json'), 'utf8'),
    ).exports ?? {};
    for (const { spec, where } of DOCUMENTED_SUBPATHS) {
      if (!(`./${spec}` in pkgExports)) {
        fail(
          `${PKG}/${spec} is documented as an import but is not in the exports map`,
          `Referenced by: ${where}. The file may well be in the tarball; the import\n` +
            `        still throws ERR_PACKAGE_PATH_NOT_EXPORTED, which is the error the\n` +
            `        reader sees.`,
        );
        continue;
      }
      try {
        require.resolve(`${PKG}/${spec}`);
      } catch (e) {
        fail(
          `${PKG}/${spec} is in the exports map but does not resolve`,
          `Referenced by: ${where}. ${String(e.code || e.message).slice(0, 120)}`,
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
} else {
  console.log('  SKIPPED the documented-API checks: see the notice above.');
}

const tarballReadme = (() => {
  try {
    return readFileSync(join(work, 'node_modules', PKG, 'README.md'), 'utf8');
  } catch {
    fail(
      'the published tarball ships no README.md',
      'npm has nothing to hoist, so the packument description can only be empty.',
    );
    return '';
  }
})();

rmSync(work, { recursive: true, force: true });

// -----------------------------------------------------------------------------
// The packument README: the description an agent reads.
//
// npm hoists a version's README into the top of the packument, and it does that
// ONLY for the version published as `latest`. `npm dist-tag add` does not
// trigger it. So after moving `latest` from 0.17.0 to 0.20.0, the install was
// correct and the description was still three releases old -- and the packument
// is the only description a non-browser client can read, because npmjs.com
// answers 403 to everything else. That is the copy every coding agent sees.
//
// Checked against the exports the current README documents: if the hoisted copy
// does not mention them, it is not the current README.
// -----------------------------------------------------------------------------
try {
  const res = await fetch(`https://registry.npmjs.org/${PKG}`, {
    headers: { accept: 'application/json' },
  });
  const packument = await res.json();
  const hoisted = packument.readme ?? '';
  if (hoisted.length === 0) {
    fail(
      'the packument carries no README at all',
      'Every non-browser client, and every coding agent, reads this field and would\n' +
        '        find the package undescribed. Fix: publish a version with `--tag latest`.',
    );
  } else {
    // Compare the served copy against this repository's README directly.
    //
    // The first version of this check looked for the documented export names in
    // the served copy and skipped any the local README did not mention -- which
    // made it vacuous, because the local README mentions almost none of them.
    // It reported `clean` against a packument that was missing everything. A
    // check whose assertion is conditional on the thing it is checking is not a
    // check. Normalising whitespace only, this compares the two texts.
    // Compared against the README inside the PUBLISHED tarball, not the one in
    // the working tree. Those are different questions. A working tree ahead of
    // the registry is unreleased work, which is normal and is not a defect --
    // comparing against it would mean no README could be improved without an
    // immediate publish, and a gate that punishes ordinary work gets worked
    // around. A hoisted copy that differs from the tarball it was published
    // from is the actual failure: the release carried a README the registry
    // never served.
    const norm = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();
    if (norm(hoisted) !== norm(tarballReadme)) {
      const hLines = norm(hoisted).split('\n');
      const rLines = norm(tarballReadme).split('\n');
      // findIndex returns -1 when one text is a prefix of the other, which is
      // what a pure append or truncation looks like. Reporting "line 0" there
      // sends the reader to the top of a 27 kB file; the boundary is the
      // interesting line.
      const firstDiff = hLines.findIndex((l, i) => l !== rLines[i]);
      const at = firstDiff === -1 ? Math.min(hLines.length, rLines.length) : firstDiff;
      fail(
        'the packument README is not the one in the published tarball',
        `${hoisted.length} bytes served, ${tarballReadme.length} bytes in the\n` +
          `        tarball; first difference at line ${at + 1}.\n` +
          `        served:  ${JSON.stringify((hLines[at] ?? '<end>').slice(0, 90))}\n` +
          `        tarball: ${JSON.stringify((rLines[at] ?? '<end>').slice(0, 90))}\n` +
          '        npm hoists a README only for the version published AS `latest`, and a\n' +
          '        dist-tag move does NOT re-hoist it. Fix: publish with `--tag latest`.',
      );
    }
  }
} catch (e) {
  fail(
    'the packument could not be read',
    `${String(e.message).slice(0, 160)}\n` +
      '        This check needs it; passing without it would report a verification that\n' +
      '        did not happen.',
  );
}

if (failures > 0) {
  console.error(
    `\ncheck-published-install: ${failures} failure(s). What a reader installs is not\n` +
      'what this repository documents. The fix is a publish or a dist-tag, not a doc edit.',
  );
  process.exit(1);
}

if (thisCheckoutIsPublished) {
  console.log(
    `  all ${DOCUMENTED_EXPORTS.length} documented export(s), ${DOCUMENTED_SUBPATHS.length} documented ` +
      `subpath(s) and ${DOCUMENTED_FILES.length} documented file(s) check out in ${resolved}.`,
  );
} else {
  // Saying "all N check out" after skipping them is the exact failure this
  // gate exists to prevent, one layer up.
  console.log(
    `  the registry is coherent: \`latest\` is ${resolved}, the newest published version,\n` +
      `  and the README it serves is the one in that tarball. ${declared} itself is\n` +
      '  UNCHECKED here and stays unchecked until it is published.',
  );
}
console.log('check-published-install: clean.');
