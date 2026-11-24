/**
 * Is npm's `latest` of every package we support a range of still inside that
 * range?
 *
 *     node tools/check-upstream-range.mjs              # asks npm
 *     node tools/check-upstream-range.mjs --self-test  # must catch a release outside
 *
 * @electric-sql/pglite 0.6.0 was released on 23 November 2026 and became npm's
 * `latest`. @filelayer/core 0.36.0 supported `^0.3.11 || ^0.5.8`, so an install
 * with no version stopped at the first quickstart() with
 * pglite_unsupported_version, and the CI jobs that installed `latest` went red
 * among our own failures, with nothing saying the cause was upstream.
 *
 * This is the one place that fails on npm's `latest`. The CI job that runs it is
 * named "upstream release outside supported range", so when it fails the name
 * says what happened: an upstream release, not a regression of ours. The other
 * jobs install the newest version INSIDE the declared range and stay green.
 * What to do when it fails: run the suite on the new release; if it passes,
 * widen the range in package.json and in src/pglite-range.ts; if not, keep the
 * range and make sure every documented install command pins it.
 *
 * Needs the network for npm. Exit 0 inside, 1 outside, 2 when npm cannot be
 * asked (that is not a verdict).
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseVersion, rangeIntervals } from './check-install-commands.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'packages', 'core', 'package.json'), 'utf8'));

/** The packages whose supported range we declare in devDependencies. */
const WATCHED = ['@electric-sql/pglite'];

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** True when `version` is inside `range` (a union of caret ranges and pins). */
export function inside(version, range) {
  const v = parseVersion(version);
  const iv = rangeIntervals(range);
  if (!v || !iv) return false;
  return iv.some(({ min, max }) => cmp(v, min) >= 0 && cmp(v, max) < 0);
}

function latestOf(pkg) {
  const r = spawnSync('npm', ['view', pkg, 'dist-tags.latest'], { encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Run only as a script: check-pglite-install.mjs imports inside().
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--self-test')) {
    const range = PKG.devDependencies[WATCHED[0]];
    const cases = [
      ['0.3.11', true], ['0.5.16', true], ['0.6.0', true],
      ['0.4.6', false], ['0.7.0', false], ['1.0.0', false], ['0.3.10', false],
    ];
    const wrong = cases.filter(([v, want]) => inside(v, range) !== want);
    if (wrong.length) {
      console.error(`check-upstream-range --self-test: FAILED on ${wrong.map(([v]) => v).join(', ')} against ${range}`);
      process.exit(1);
    }
    console.log(`check-upstream-range --self-test: ${cases.length} cases against ${range}, each classified right.`);
    process.exit(0);
  }

  let outside = 0;
  for (const pkg of WATCHED) {
    const range = PKG.devDependencies[pkg];
    const latest = latestOf(pkg);
    if (!latest) {
      console.error(`check-upstream-range: npm did not answer for ${pkg}. No verdict.`);
      process.exit(2);
    }
    if (inside(latest, range)) {
      console.log(`check-upstream-range: ${pkg} ${latest} (npm latest) is inside ${range}.`);
    } else {
      outside++;
      // The annotation's title is what a reader of the checks list sees.
      console.log(`::error title=upstream release outside supported range::${pkg} ${latest} is npm's latest and is outside ${range}. Not a regression of ours: run the suite on ${latest}, then widen the range or pin every documented install command.`);
      console.error(`check-upstream-range: ${pkg} ${latest} (npm latest) is OUTSIDE ${range}.`);
    }
  }
  process.exit(outside ? 1 : 0);
}
