/**
 * Where the MCP client configuration a reader pastes actually lives.
 *
 * A LIBRARY. Nothing happens at import.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SHARED FUNCTION AND NOT A REGEX IN TWO FILES
 * ---------------------------------------------------------------------------
 *
 * The JSON block an MCP client copies verbatim is an executable claim: the
 * first one ever published was `npx -y @filelayer/core filelayer-mcp`, which
 * npm answers with "could not determine executable to run" because a package
 * with two binaries has no default. Nothing could have caught that by reading,
 * so two gates were pointed at the block:
 *
 *   - `check-published-install.mjs` EXECUTES it against the installed package.
 *   - `check-registry-entry.mjs` compares it with the argv in `server.json`.
 *
 * Both found it with `/"args":\s*(\[[^\]]*\])/` applied to `README.md`. On
 * 14 October 2026 the README was thinned and the block moved to `docs/MCP.md`.
 * Both gates then failed, saying the array was not in `README.md` -- which was
 * true, and was not the defect, and cost two separate round trips to discover
 * because the second copy of the assumption was invisible while the first was
 * being fixed.
 *
 * That is the argument for this file. A hard-coded filename duplicated across
 * two tools is one assumption pretending to be two independent checks: they do
 * not fail at different times for different reasons, they fail together for the
 * same reason, twice.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS BEYOND "FOUND IT"
 * ---------------------------------------------------------------------------
 *
 * That exactly one configuration is documented. Two surfaces printing DIFFERENT
 * blocks is worse than either being wrong: a reader copies one and cannot tell
 * which they got. Printing the SAME block twice is fine and is not reported,
 * because the copies in `packages/core/` are byte-identical by design.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ARGS = /"args":\s*(\[[^\]]*\])/;

/**
 * Every surface that could reasonably carry the block, discovered rather than
 * listed, so the next move inside `docs/` needs no edit here.
 */
export function configSurfaces() {
  return [
    'README.md',
    'llms.txt',
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`),
  ].filter((rel) => existsSync(join(ROOT, rel)));
}

/**
 * `{ surfaces, found, args, raw, conflict }`.
 *
 *   surfaces  how many files were searched, for the failure message
 *   found     the relative paths that carry a block, in search order
 *   args      the parsed array from the first one, or null
 *   conflict  the distinct block texts, when there is more than one
 *
 * A parse failure returns `args: null` with `raw` set, so the caller can report
 * the JSON error against the surface it came from rather than against a
 * filename it assumed.
 */
export function documentedClientConfig() {
  const surfaces = configSurfaces();
  const found = [];
  for (const rel of surfaces) {
    const hit = ARGS.exec(readFileSync(join(ROOT, rel), 'utf8'));
    if (hit) found.push({ rel, raw: hit[1] });
  }

  const distinct = [...new Set(found.map((f) => f.raw.replace(/\s+/g, ' ')))];
  let args = null;
  let error = null;
  if (found.length > 0) {
    try {
      args = JSON.parse(found[0].raw);
    } catch (e) {
      error = String(e.message).slice(0, 120);
    }
  }

  return {
    surfaces: surfaces.length,
    found,
    where: found[0]?.rel ?? null,
    raw: found[0]?.raw ?? null,
    args,
    error,
    conflict: distinct.length > 1 ? distinct : null,
  };
}
