#!/usr/bin/env node
/**
 * THE CLAUDE PLUGIN DIRECTORY'S COPY: claude-plugin/.
 *
 *     node tools/plugin-folder.mjs            # check, exit 1 on any difference
 *     node tools/plugin-folder.mjs --write    # rewrite the copy from the sources
 *     node tools/plugin-folder.mjs --self-test
 *
 * WHY A SUBFOLDER. The plugin directory scans every file under the folder it is
 * given. Pointed at the repository root it refused 12 things that are right for
 * this repository and wrong for that catalogue: a local MCP server (.mcp.json,
 * which only verified organizations may ship there), scripts and a
 * package.json with scripts, and the fake S3 keys of the test suite. So the
 * directory is given claude-plugin/, which holds the plugin manifest without
 * mcpServers, the icon, and a copy of skills/filelayer-integration with only
 * its .md and .json files. The root .mcp.json and .claude-plugin/ stay as they
 * are: cursor.directory and Claude Code read those.
 *
 * WHAT IT CHECKS. The copy of the skill is byte-identical to the source, file
 * for file, with nothing missing and nothing extra; the folder holds only
 * .md, .json and the icon; its manifest names the package version, has no
 * mcpServers, and agrees with the root manifest on everything else.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = 'skills/filelayer-integration';
const DEST = 'claude-plugin';
const ALLOWED = /\.(md|json)$/;

const tracked = (prefix) =>
  execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);

function expected() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
  const root = JSON.parse(readFileSync(join(ROOT, '.claude-plugin/plugin.json'), 'utf8'));
  const { mcpServers, skills, ...rest } = root;
  // The root manifest's description names the MCP server; this copy has none.
  const WITH_SERVER = ' This plugin adds the integration skill and the filelayer-mcp server.';
  if (!rest.description.endsWith(WITH_SERVER)) {
    throw new Error(`.claude-plugin/plugin.json description no longer ends with "${WITH_SERVER.trim()}"; update tools/plugin-folder.mjs`);
  }
  const description = rest.description.slice(0, -WITH_SERVER.length) + ' This plugin adds the integration skill.';
  const manifest = { ...rest, description, version: pkg.version, skills: [`./${SRC}`] };
  const files = new Map();
  files.set(`${DEST}/.claude-plugin/plugin.json`, Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  files.set(`${DEST}/.claude-plugin/icon.png`, readFileSync(join(ROOT, '.claude-plugin/icon.png')));
  // The directory refuses a folder with no README (README_MISSING). Generated
  // here so that nothing in this folder is edited by hand.
  files.set(`${DEST}/README.md`, Buffer.from(README(pkg.version)));
  for (const f of tracked(SRC)) {
    if (!ALLOWED.test(f)) continue;
    files.set(`${DEST}/${f}`, readFileSync(join(ROOT, f)));
  }
  return files;
}

const README = (version) => `# Filelayer, the Agent Skill

This plugin installs one skill, \`filelayer-integration\`, for adding user files to
a SaaS application with [\`@filelayer/core\`](https://www.npmjs.com/package/@filelayer/core):
private uploads, per-user and per-organization permissions, share links that
expire and can be revoked, and an audit trail of every allowed and refused
access, on the application's own Postgres and S3 or R2 bucket.

The skill first decides whether a library is the right answer at all, then
finds what the project already has, mounts the routes that match its runtime,
and checks the result with \`auditIntegration()\`. It describes
\`@filelayer/core\` ${version}; if your installed version differs, copy the skill
from \`node_modules/@filelayer/core/skills/\` instead.

The skill, the library and its MCP server run on your own machines and
infrastructure. They do not collect, store or send any data to Filelayer. The
only network requests they make go to the S3 or R2 endpoint you configure, and
the S3 credentials you set are used for your own bucket and nothing else.

The library is Apache-2.0: https://github.com/filelayer/filelayer. This folder is
generated from the repository's \`skills/filelayer-integration\` by
\`tools/plugin-folder.mjs\`.
`;

export function diff(want, have) {
  const problems = [];
  for (const [rel, bytes] of want) {
    const got = have.get(rel);
    if (!got) problems.push(`${rel} is missing`);
    else if (!got.equals(bytes)) problems.push(`${rel} differs from its source`);
  }
  for (const rel of have.keys()) {
    if (!want.has(rel)) problems.push(`${rel} has no source: the copy holds a file the skill does not`);
  }
  return problems;
}

function actual() {
  const have = new Map();
  for (const f of tracked(DEST)) have.set(f, readFileSync(join(ROOT, f)));
  // An untracked file in the folder would be submitted too, but is invisible
  // to git; read what is on disk for the expected paths as well.
  for (const rel of expected().keys()) if (!have.has(rel) && existsSync(join(ROOT, rel))) have.set(rel, readFileSync(join(ROOT, rel)));
  return have;
}

if (process.argv.includes('--write')) {
  rmSync(join(ROOT, DEST), { recursive: true, force: true });
  for (const [rel, bytes] of expected()) {
    mkdirSync(dirname(join(ROOT, rel)), { recursive: true });
    writeFileSync(join(ROOT, rel), bytes);
  }
  console.log(`plugin-folder: wrote ${expected().size} file(s) under ${DEST}/. Stage them and run the check.`);
  process.exit(0);
}

if (process.argv.includes('--self-test')) {
  const want = expected();
  let bad = 0;
  const changed = new Map(want);
  const skill = `${DEST}/${SRC}/SKILL.md`;
  changed.set(skill, Buffer.concat([want.get(skill), Buffer.from('\nedited in the copy only\n')]));
  if (diff(want, changed).length !== 1) { bad++; console.error('  self-test: an edited copy passed'); }
  const missing = new Map(want); missing.delete(skill);
  if (diff(want, missing).length !== 1) { bad++; console.error('  self-test: a missing file passed'); }
  const extra = new Map(want); extra.set(`${DEST}/run.mjs`, Buffer.from('x'));
  if (diff(want, extra).length !== 1) { bad++; console.error('  self-test: an extra file passed'); }
  if (diff(want, new Map(want)).length !== 0) { bad++; console.error('  self-test: an identical copy was refused'); }
  if (bad) process.exit(1);
  console.log('plugin-folder --self-test: 4 controls correct.');
  process.exit(0);
}

const problems = diff(expected(), actual());
for (const rel of tracked(DEST)) {
  if (!/\.(md|json|png)$/.test(rel)) problems.push(`${rel}: only .md, .json and the icon belong in ${DEST}/`);
}
const m = JSON.parse(readFileSync(join(ROOT, `${DEST}/.claude-plugin/plugin.json`), 'utf8'));
if ('mcpServers' in m) problems.push(`${DEST}/.claude-plugin/plugin.json declares mcpServers, which the plugin directory refuses for an unverified organization`);
if (problems.length) {
  console.error(`plugin-folder: FAILED, ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRun `node tools/plugin-folder.mjs --write` after changing the skill or the root manifest.');
  process.exit(1);
}
console.log(`plugin-folder: clean. ${DEST}/ matches ${SRC} and the root manifest (${expected().size} files).`);
