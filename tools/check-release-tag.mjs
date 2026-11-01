#!/usr/bin/env node
/**
 * THE TAG BEING RELEASED NAMES THE VERSION IN packages/core/package.json.
 *
 *     node tools/check-release-tag.mjs v0.34.1
 *     node tools/check-release-tag.mjs --self-test
 *
 * Run by .github/workflows/publish.yml before anything else, with the tag that
 * triggered it ($GITHUB_REF_NAME).
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * From 0.34.1 a release is published by CI when a tag `vX.Y.Z` is pushed, not
 * by a person at a terminal. npm publishes whatever version package.json says,
 * whatever the tag says. A tag `v0.35.0` pushed onto a tree that still says
 * 0.34.1 would publish 0.34.1 again (refused by npm, but only after six
 * minutes of gates) or, worse, a tree that says 0.35.0 tagged `v0.34.2` would
 * publish 0.35.0 under a tag that names something else, and the GitHub release
 * page and the registry would disagree about what that commit is. The tag is
 * the approval the maintainer gave ("ok publish" for a named version), so the
 * version it names is the only one allowed out.
 *
 * Also refused: anything that is not `v` + three numeric parts with an optional
 * pre-release, so a stray `v1` or `release-foo` tag cannot reach `npm publish`.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function judge(tag, version) {
  if (!tag) return 'no tag given; pass the tag that triggered the release ($GITHUB_REF_NAME)';
  const m = TAG.exec(tag);
  if (!m) return `"${tag}" is not a release tag (expected v<major>.<minor>.<patch>)`;
  if (m[1] !== version) return `tag ${tag} names ${m[1]}, and packages/core/package.json says ${version}`;
  return null;
}

if (process.argv.includes('--self-test')) {
  const cases = [
    { name: 'matching tag', tag: 'v0.34.1', version: '0.34.1', fails: false },
    { name: 'tag ahead of package.json', tag: 'v0.35.0', version: '0.34.1', fails: true },
    { name: 'tag behind package.json', tag: 'v0.34.0', version: '0.34.1', fails: true },
    { name: 'no v prefix', tag: '0.34.1', version: '0.34.1', fails: true },
    { name: 'two-part tag', tag: 'v0.34', version: '0.34.1', fails: true },
    { name: 'empty', tag: '', version: '0.34.1', fails: true },
    { name: 'pre-release that matches', tag: 'v0.35.0-rc.1', version: '0.35.0-rc.1', fails: false },
  ];
  let bad = 0;
  for (const c of cases) {
    const failed = judge(c.tag, c.version) !== null;
    const ok = failed === c.fails;
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${c.name} (expected ${c.fails ? 'refusal' : 'pass'})`);
  }
  console.log(`check-release-tag --self-test: ${cases.length - bad}/${cases.length} controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

const version = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')).version;
const tag = process.argv[2] ?? '';
const problem = judge(tag, version);
if (problem) {
  console.error(`check-release-tag: REFUSING TO RELEASE\n\n  - ${problem}\n\n  Nothing was published.`);
  process.exit(1);
}
console.log(`check-release-tag: ${tag} names ${version}, the version in packages/core/package.json.`);
