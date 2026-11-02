#!/usr/bin/env node
/**
 * THE PUBLISH WORKFLOW NEVER PRINTS THE MCP KEY, AND PUBLISHES THE REGISTRY
 * ENTRY ONLY AFTER A SUCCESSFUL npm PUBLISH.
 *
 *     node tools/check-publish-workflow.mjs
 *     node tools/check-publish-workflow.mjs --self-test
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * From 0.35.1 `.github/workflows/publish.yml` holds the private key that proves
 * control of filelayer.dev to the MCP registry (D049), as the environment
 * secret MCP_DNS_PRIVATE_KEY. GitHub masks a secret's exact value in logs, and
 * that is where its protection ends: a `set -x`, an `env` dump, a value piped
 * through `base64`, or a `cat` of a file it was written to all print it in a
 * form the mask does not recognise, and the workflow logs of this repository
 * are public. The key would then let anyone publish a registry entry under our
 * domain that sends MCP clients to whatever package they like.
 *
 * And the order matters for the same reader. An MCP client installs what the
 * registry entry names. An entry published when the npm publish failed names a
 * version that does not exist.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT CHECKS, reading the workflow as text
 * -----------------------------------------------------------------------------
 *
 *   1. `secrets.MCP_DNS_PRIVATE_KEY` appears exactly once, as the value of an
 *      `env:` entry in the `mcp-registry` job, and no other secret is read
 *      anywhere in the file.
 *   2. Every line that names MCP_DNS_PRIVATE_KEY is either that env entry, an
 *      emptiness test, or the `mcp-publisher login dns ... --private-key` line;
 *      nothing echoes, prints, writes, encodes or dumps it, and nothing turns
 *      on shell tracing anywhere in the file.
 *   3. The `mcp-registry` job `needs: publish`, and its `if:` lets a tag push
 *      through only when `needs.publish.result == 'success'`, and a manual run
 *      only when publish was skipped, on main.
 *   4. mcp-publisher is pinned: a version, a sha256, and `sha256sum --check`
 *      before the binary is run.
 *   5. Before the entry is published, the job waits for npm to serve the
 *      version through tools/wait-npm-version.mjs with an explicit
 *      `--timeout-s`: bounded, and not a single ask. A single ask is what failed
 *      on the v0.35.1 release run (npm had not propagated yet); an unbounded
 *      wait would hang a release instead of refusing it.
 *
 * --self-test feeds it a copy of the workflow with each of those broken, one at
 * a time, and requires each to be refused.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, '.github', 'workflows', 'publish.yml');
const SECRET = 'MCP_DNS_PRIVATE_KEY';

/** The text of one top-level job, from `  <name>:` to the next job or EOF. */
function jobBlock(text, name) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

export function judge(text) {
  const out = [];
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  // 1. One read of the secret, in the mcp-registry job, as an env value.
  const reads = [...code.matchAll(/\$\{\{\s*secrets\.([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]);
  if (reads.filter((r) => r === SECRET).length !== 1) out.push(`secrets.${SECRET} is read ${reads.filter((r) => r === SECRET).length} times; exactly once is allowed`);
  for (const r of reads) if (r !== SECRET) out.push(`secrets.${r} is read; this workflow may read no other secret`);
  const mcp = jobBlock(code, 'mcp-registry');
  if (mcp === null) out.push('there is no mcp-registry job');
  else if (!new RegExp(`^\\s+${SECRET}:\\s*\\$\\{\\{\\s*secrets\\.${SECRET}\\s*\\}\\}\\s*$`, 'm').test(mcp)) {
    out.push(`secrets.${SECRET} is not an env entry of the mcp-registry job`);
  }

  // 2. Nothing prints it, and nothing traces.
  if (/\bset\s+-[a-wyz]*x|\bbash\s+-[a-z]*x|\bset\s+-o\s+xtrace/.test(code)) out.push('shell tracing is turned on somewhere; it would print the key');
  for (const line of code.split('\n')) {
    if (!line.includes(SECRET)) continue;
    const t = line.trim();
    const allowed =
      new RegExp(`^${SECRET}:\\s*\\$\\{\\{\\s*secrets\\.${SECRET}\\s*\\}\\}$`).test(t) ||
      new RegExp(`^\\[ -n "\\$${SECRET}" \\] \\|\\| \\{ echo "[^"$]*"; exit 1; \\}$`).test(t) ||
      new RegExp(`^"\\$RUNNER_TEMP/mcp-publisher" login dns .*--private-key "\\$${SECRET}"( >/dev/null)?$`).test(t);
    if (!allowed) out.push(`a line uses ${SECRET} in a way that is not allowed: ${t.slice(0, 120)}`);
  }
  if (/\b(printenv|env\s*$|env\s*\||export\s+-p)\b/m.test(code)) out.push('the environment is dumped somewhere');

  // 3. Order: only after a successful npm publish.
  if (mcp !== null) {
    if (!/^\s+needs:\s*publish\s*$/m.test(mcp)) out.push('the mcp-registry job does not need publish');
    const ifExpr = (/^\s+if:\s*>-?\n((?:\s{6,}.*\n?)+)/m.exec(mcp)?.[1] ?? /^\s+if:\s*(.+)$/m.exec(mcp)?.[1] ?? '').replace(/\s+/g, ' ');
    if (!/github\.event_name == 'push' && needs\.publish\.result == 'success'/.test(ifExpr)) {
      out.push("the mcp-registry job's if: does not require needs.publish.result == 'success' on a tag push");
    }
    if (/github\.event_name == 'workflow_dispatch'/.test(ifExpr) &&
        !/github\.event_name == 'workflow_dispatch' && needs\.publish\.result == 'skipped' && github\.ref == 'refs\/heads\/main'/.test(ifExpr)) {
      out.push("a manual run of the mcp-registry job is not limited to publish skipped, on main");
    }
    if (/\|\|\s*always\(\)|\bif:\s*always\(\)\s*$/m.test(mcp)) out.push('the mcp-registry job can run regardless of the npm publish');
    // 4. Pinned.
    if (!/MCP_PUBLISHER_VERSION:\s*'\d+\.\d+\.\d+'/.test(mcp)) out.push('mcp-publisher has no pinned version');
    if (!/MCP_PUBLISHER_SHA256:\s*'[0-9a-f]{64}'/.test(mcp)) out.push('mcp-publisher has no pinned sha256');
    const check = mcp.indexOf('sha256sum --check');
    const firstRun = mcp.indexOf('"$RUNNER_TEMP/mcp-publisher"');
    if (check < 0) out.push('the mcp-publisher archive is not checked with sha256sum --check');
    else if (firstRun >= 0 && firstRun < check) out.push('mcp-publisher is run before its checksum is checked');
    // 5. A bounded wait for npm, before publishing.
    const wait = /node tools\/wait-npm-version\.mjs "@filelayer\/core" "\$v" --timeout-s \d+/.exec(mcp);
    const publishAt = mcp.indexOf('"$RUNNER_TEMP/mcp-publisher" publish');
    if (!wait) out.push('the mcp-registry job does not wait, a bounded time (--timeout-s), for npm to serve the version');
    else if (publishAt >= 0 && publishAt < wait.index) out.push('the entry is published before npm is seen to serve the version');
  }
  return out;
}

if (process.argv.includes('--self-test')) {
  const real = readFileSync(FILE, 'utf8');
  const login = `"$RUNNER_TEMP/mcp-publisher" login dns --algorithm ecdsap384 --domain filelayer.dev --private-key "$${SECRET}" >/dev/null`;
  const cases = [
    ['an echo of the key', real.replace(login, `echo "$${SECRET}"\n          ${login}`)],
    ['the key piped through base64', real.replace(login, `printf %s "$${SECRET}" | base64\n          ${login}`)],
    ['shell tracing', real.replace(login, `set -x\n          ${login}`)],
    ['the secret read a second time', real.replace('      - name: Publish the entry', `      - name: Publish the entry\n        env:\n          K: \${{ secrets.${SECRET} }}`)],
    ['another secret read', real.replace('NODE_AUTH_TOKEN:-}', 'NODE_AUTH_TOKEN:-}${{ secrets.NPM_TOKEN }}')],
    ['needs: publish removed', real.replace('    needs: publish\n', '')],
    ['success no longer required', real.replace("needs.publish.result == 'success'", "needs.publish.result != 'cancelled'")],
    ['a manual run allowed off main', real.replace(" && github.ref == 'refs/heads/main'", '')],
    ['the checksum check removed', real.replace(/\n.*sha256sum --check --strict/, '')],
    ['the npm wait replaced by a single ask', real.replace(/node tools\/wait-npm-version\.mjs "@filelayer\/core" "\$v"[^\n]*/, 'npm view "@filelayer/core@$v" version | grep -qx "$v"')],
    ['the npm wait with no bound', real.replace(/ --timeout-s \d+/, '')],
  ];
  let bad = 0;
  for (const [name, text] of cases) {
    const refused = text !== real && judge(text).length > 0;
    if (!refused) bad++;
    console.log(`  ${refused ? 'ok  ' : 'FAIL'} ${name} is refused`);
  }
  const clean = judge(real).length === 0;
  if (!clean) bad++;
  console.log(`  ${clean ? 'ok  ' : 'FAIL'} the real workflow passes`);
  console.log(`check-publish-workflow --self-test: ${cases.length + 1 - bad}/${cases.length + 1} controls behaved`);
  process.exit(bad === 0 ? 0 : 1);
}

const problems = judge(readFileSync(FILE, 'utf8'));
if (problems.length) {
  console.error('check-publish-workflow: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-publish-workflow: clean. ${SECRET} is read once, never printed, and the MCP entry is published only after a successful npm publish, by a pinned and checksummed mcp-publisher, once npm is seen serving the version (a bounded wait).`);
