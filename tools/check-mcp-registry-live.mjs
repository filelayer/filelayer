#!/usr/bin/env node
/**
 * Does the entry PUBLISHED in the MCP registry describe the package PUBLISHED
 * on npm?
 *
 *     node tools/check-mcp-registry-live.mjs
 *     node tools/check-mcp-registry-live.mjs --self-test
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT `check:registry`
 * ---------------------------------------------------------------------------
 *
 * `check:registry` reads `server.json` and `packages/core/package.json` and
 * asserts they agree. That is worth doing and it is a question about this
 * checkout. It cannot see the thing that actually goes wrong.
 *
 * On 12 October 2026, minutes after `@filelayer/core@0.27.0` was published, the
 * MCP registry was serving `dev.filelayer/core` at **0.26.0** -- correctly, in
 * the sense that nobody had run `mcp-publisher publish` yet. `check:registry`
 * was clean, because `server.json` said 0.27.0 and so did `package.json`. Every
 * gate in this repository was green while the entry an MCP client reads pointed
 * at a version one release behind, and nothing in the project was capable of
 * noticing: the npm publish and the registry publish are two commands, and only
 * one of them had a gate behind it.
 *
 * So this asks the other question, and both of its operands are PUBLISHED
 * things:
 *
 *     the version the MCP registry serves  ==  the version npm serves as latest
 *
 * ---------------------------------------------------------------------------
 * WHY IT DOES NOT RUN ON PUSH
 * ---------------------------------------------------------------------------
 *
 * Because during a release those two are legitimately different for a few
 * minutes, and a gate that goes red for a non-defect stops being read -- which
 * this project has written down as a rule after conflating exactly these two
 * kinds of question three times in one day.
 *
 * It runs where `check:live` runs: on the nightly schedule and on a manual
 * dispatch, hours after any release, which is when a stale entry has stopped
 * being a release in progress and become a stale entry.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = { 'user-agent': 'filelayer-check-mcp-registry-live' };

const serverJson = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
const NAME = serverJson.name;
const PKG = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8')).name;

/** The MCP registry's entry for our name, or a reason it could not be read. */
async function mcpEntry() {
  // The search endpoint rather than a by-name lookup, because a name containing
  // a slash has to be escaped differently by different registry versions and
  // the search result carries the same version field. Matched EXACTLY on the
  // name afterwards: a search is a search, and taking the first result would
  // let a different server's version pass for ours.
  const url = `https://registry.modelcontextprotocol.io/v0/servers?search=${encodeURIComponent(NAME)}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return { error: `${url} answered ${res.status}` };
  const body = await res.json();
  const list = body.servers ?? body.data ?? [];

  // THE REGISTRY KEEPS EVERY VERSION, AND ONE OF THEM IS FLAGGED.
  //
  // The first version of this file took the first result whose name matched,
  // and that was wrong within minutes of being committed: publishing 0.27.0 did
  // not replace the 0.26.0 entry, it added to it, and the search returned both.
  // Taking the first gave 0.26.0 -- so the gate reported a stale entry at the
  // exact moment the entry had just been brought up to date, which is the
  // false-positive direction, and the worse one: a gate that cries about a
  // defect that was just fixed is a gate somebody turns off.
  //
  // `isLatest` lives under the registry's own namespaced metadata key, and it is
  // read rather than inferred by sorting versions ourselves. Sorting would be a
  // second opinion about something the registry already states, and it would be
  // wrong the first time a release is published out of order or yanked.
  const mine = list
    .map((x) => ({ server: x.server ?? x, meta: x._meta ?? x.meta ?? {} }))
    .filter((x) => x.server.name === NAME);

  if (mine.length === 0) {
    return {
      error:
        `the registry returned ${list.length} result(s) for ${NAME} and none of them ` +
        `is named ${NAME} exactly. Either the entry was never published, or it was ` +
        `published under a different name than server.json carries.`,
    };
  }

  const OFFICIAL = 'io.modelcontextprotocol.registry/official';
  const latest = mine.filter((x) => x.meta[OFFICIAL]?.isLatest === true);
  if (latest.length !== 1) {
    return {
      error:
        `${mine.length} entr(ies) are named ${NAME} and ${latest.length} of them are ` +
        `flagged isLatest. Exactly one should be.\n  Versions present: ` +
        `${mine.map((x) => `${x.server.version}${x.meta[OFFICIAL]?.isLatest ? ' (latest)' : ''}`).join(', ')}\n` +
        `  This check will not guess which one a client resolves.`,
    };
  }
  return { version: latest[0].server.version };
}

/** What npm serves as `latest`, read past any cache. */
function npmLatest() {
  // `npm view` rather than a bare fetch, so this reads the same thing an
  // installing client resolves, and `--prefer-online` because a stale
  // packument in the local cache has already made one gate in this repository
  // report a version that had moved two days earlier.
  const out = execFileSync(
    'npm',
    ['view', PKG, 'dist-tags.latest', '--prefer-online', '--silent'],
    { encoding: 'utf8' },
  );
  return out.trim();
}

if (process.argv.includes('--self-test')) {
  // Two controls, and the second exists because the first was not enough.
  //
  // Control 1 checked that a foreign name is rejected, and it passed while the
  // selection logic was still broken: the real registry returns EVERY version
  // of our own server, and taking the first match gave the oldest. A negative
  // control that only tests the case you thought of is the shape of defect this
  // whole repository keeps finding.
  const OFFICIAL = 'io.modelcontextprotocol.registry/official';
  const pick = (list) => {
    const mine = list
      .map((x) => ({ server: x.server ?? x, meta: x._meta ?? {} }))
      .filter((x) => x.server.name === NAME);
    const latest = mine.filter((x) => x.meta[OFFICIAL]?.isLatest === true);
    return latest.length === 1 ? latest[0].server.version : null;
  };

  const foreign = pick([{ server: { name: 'dev.example/other', version: '9.9.9' } }]);
  // Oldest FIRST, which is the order the registry actually returned on
  // 12 October 2026 and the order that broke the first version of this file.
  const history = pick([
    { server: { name: NAME, version: '0.26.0' }, _meta: { [OFFICIAL]: { isLatest: false } } },
    { server: { name: NAME, version: '0.27.0' }, _meta: { [OFFICIAL]: { isLatest: true } } },
  ]);
  const ambiguous = pick([
    { server: { name: NAME, version: '0.26.0' }, _meta: { [OFFICIAL]: { isLatest: true } } },
    { server: { name: NAME, version: '0.27.0' }, _meta: { [OFFICIAL]: { isLatest: true } } },
  ]);

  const ok = foreign === null && history === '0.27.0' && ambiguous === null;
  console.log(
    ok
      ? 'check-mcp-registry-live: controls passed (a foreign name is rejected, the ' +
          'flagged version wins over an earlier one listed first, and two flagged ' +
          'latests refuse to be guessed between).'
      : `controls FAILED: foreign=${foreign} history=${history} ambiguous=${ambiguous}`,
  );
  process.exit(ok ? 0 : 1);
}

const entry = await mcpEntry();
if (entry.error) {
  console.error(`\ncheck-mcp-registry-live: ${entry.error}\n`);
  process.exit(1);
}

let latest;
try {
  latest = npmLatest();
} catch (e) {
  console.error(
    `\ncheck-mcp-registry-live: could not read npm's latest for ${PKG}: ${e.message}\n`,
  );
  process.exit(1);
}

if (entry.version !== latest) {
  console.error(
    `\ncheck-mcp-registry-live: FAILED\n\n` +
      `  The MCP registry serves ${NAME} at ${entry.version}.\n` +
      `  npm serves ${PKG} at ${latest}.\n\n` +
      `  An MCP client reads the registry entry and runs what it names, so this sends\n` +
      `  it to a tarball one or more releases behind the documentation. The two\n` +
      `  publishes are separate commands; this is the one that was forgotten.\n\n` +
      `  Fix: PUBLISH-RUNBOOK.md section 7, from "Log in and publish".\n`,
  );
  process.exit(1);
}

console.log(
  `check-mcp-registry-live: clean. The MCP registry serves ${NAME} at ${entry.version}, ` +
    `which is what npm serves ${PKG} as latest.`,
);
