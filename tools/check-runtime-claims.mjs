#!/usr/bin/env node
/**
 * A RUNTIME IS NAMED AS SUPPORTED ONLY IF CI RUNS IT.
 *
 *     node tools/check-runtime-claims.mjs
 *     node tools/check-runtime-claims.mjs --self-test
 *
 * WHY. Until 18 November 2026 the README, the quickstart, llms.txt, the Agent
 * Skill, the Next.js example, the roadmap, the website and context7.json listed
 * Cloudflare Workers, Deno and Bun among the runtimes `deliveryFetch` serves.
 * Nothing had ever run the package in any of them. When it was tried, the
 * published package did not even load in workerd (the optional PGlite import
 * does not bundle, and `dist/db.js` calls `fileURLToPath(import.meta.url)` at
 * load). A runtime list is a support claim, and an agent choosing a library
 * reads it as one.
 *
 * WHAT IT DOES. For each runtime below, if no workflow under .github/workflows/
 * contains the evidence pattern (a step that actually runs that runtime), then
 * every paragraph of the public surfaces that names the runtime must also say,
 * in the same paragraph, that it is not supported or not tested. Naming it as
 * unsupported is allowed; naming it beside the ones that work is not.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIMES = [
  { name: 'Cloudflare Workers', mention: /\bWorkers?\b|\bworkerd\b/, evidence: /\bwrangler\b|\bworkerd\b/ },
  { name: 'Deno', mention: /\bDeno\b/, evidence: /setup-deno|\bdeno (?:run|test|task)\b/ },
  { name: 'Bun', mention: /\bBun\b/, evidence: /setup-bun|\bbun (?:run|test)\b/ },
];
// The paragraph has to say this, or something with the same meaning.
const DISCLAIMED = /not supported|not run in CI|not tested|not claimed|did not run|does not run|never been run|does not bundle/i;

// The public surfaces: what a reader or an agent reads as a description of the
// package. Source comments, tests, tools and the changelog are history or
// implementation, and are not scanned.
const PUBLIC = (rel) =>
  /^(README|ROADMAP|LIMITATIONS|TRUST|SECURITY)\.md$/.test(rel) ||
  /^(llms\.txt|context7\.json|server\.json|\.claude-plugin\/plugin\.json)$/.test(rel) ||
  /^docs\/.*\.md$/.test(rel) ||
  /^skills\/.*\.md$/.test(rel) ||
  /^examples\/.*\.md$/.test(rel) ||
  /^web\/.*\.html$/.test(rel) ||
  /^packages\/core\/(?!CHANGELOG)[^/]*\.md$/.test(rel) ||
  /^packages\/core\/llms\.txt$/.test(rel) ||
  /^packages\/core\/(docs|skills|examples)\/.*\.md$/.test(rel);

function workflowsText(root) {
  const dir = join(root, '.github/workflows');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

function paragraphs(text, rel) {
  const body = rel.endsWith('.html') ? text.replace(/<[^>]+>/g, ' ') : text;
  return body.split(/\n\s*\n/);
}

export function check(files, workflows) {
  const problems = [];
  for (const rt of RUNTIMES) {
    if (rt.evidence.test(workflows)) continue; // CI runs it: naming it is backed
    for (const [rel, text] of files) {
      for (const p of paragraphs(text, rel)) {
        if (!rt.mention.test(p) || DISCLAIMED.test(p)) continue;
        const line = p.split('\n').find((l) => rt.mention.test(l)) ?? p;
        problems.push(`${rel}: names ${rt.name}, which no CI job runs, without saying it is not supported:\n      ${line.trim().slice(0, 160)}`);
      }
    }
  }
  return problems;
}

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
const files = tracked.filter(PUBLIC).map((rel) => [rel, readFileSync(join(ROOT, rel), 'utf8')]);
const workflows = workflowsText(ROOT);

if (process.argv.includes('--self-test')) {
  let bad = 0;
  const claim = [['README.md', 'deliveryFetch serves Next.js, Hono, Cloudflare Workers, Deno and Bun.']];
  const caught = check(claim, '');
  if (caught.length !== 3) { bad++; console.error(`  self-test: a support claim for three runtimes gave ${caught.length} problem(s), expected 3`); }
  if (check([['README.md', 'Cloudflare Workers is not supported yet.']], '').length !== 0) { bad++; console.error('  self-test: a disclaimer was refused'); }
  if (check(claim, 'run: npx wrangler dev\nuses: denoland/setup-deno@v2\nuses: oven-sh/setup-bun@v2').length !== 0) { bad++; console.error('  self-test: a claim backed by CI was refused'); }
  if (check([['web/quickstart.html', '<p>Mount it on <a>Cloudflare Workers</a>.</p>']], '').length !== 1) { bad++; console.error('  self-test: a claim in HTML passed'); }
  if (bad) process.exit(1);
  console.log('check-runtime-claims --self-test: 4 controls correct.');
  process.exit(0);
}

const problems = check(files, workflows);
if (problems.length) {
  console.error(`check-runtime-claims: FAILED, ${problems.length} unbacked runtime claim(s)\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nEither add a CI job that runs the runtime, or say in the same paragraph that it is not supported.');
  process.exit(1);
}
console.log(`check-runtime-claims: clean. ${files.length} public file(s); no runtime is named as supported without a CI job that runs it.`);
