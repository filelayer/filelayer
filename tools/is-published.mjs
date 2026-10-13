#!/usr/bin/env node
/**
 * Is a version on npm? Asked down two independent paths, and told when they
 * disagree.
 *
 *     node tools/is-published.mjs            # the version in package.json
 *     node tools/is-published.mjs 0.29.0
 *
 * Exits 0 if published, 1 if not, 2 if the two paths disagree or neither could
 * be reached.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 *
 * On 12 October 2026 the MCP registry refused the entry for 0.29.0 twice,
 * saying the npm version was not found. That was read as "the publish never
 * ran", and the evidence was one fetch of the packument, which reported 0.29.0
 * absent and both dist-tags a release behind.
 *
 * The publish HAD run. npm's write path then refused a re-publish with "You
 * cannot publish over the previously published versions: 0.29.0", and a
 * re-read a minute later showed it present with `latest` and `alpha` on it. A
 * wrong diagnosis was reported with confidence, and a publish was
 * re-attempted on the strength of it.
 *
 * `PUBLISH-RUNBOOK.md` section 4 ALREADY recorded a publish that answered 404
 * on its own tarball minutes after succeeding. The rule was written down and
 * cited in that very session, and then not applied -- which is worse than not
 * having it, because a written rule is what made the answer feel checked.
 *
 * So the method moved out of prose and into a command. The point is not that
 * this tool is cleverer: it is that "did it publish?" now has an answer you run
 * instead of a judgement you make.
 *
 * ---------------------------------------------------------------------------
 * THE TWO PATHS, AND WHY DISAGREEMENT IS AN ANSWER
 * ---------------------------------------------------------------------------
 *
 *   1. The PACKUMENT (`registry.npmjs.org/<pkg>`). What npm clients read to
 *      resolve a range. Served from replicas that lag.
 *   2. The TARBALL URL (`.../-/<name>-<version>.tgz`), with HEAD. A different
 *      code path, and the one that answered correctly on 12 October while the
 *      packument did not.
 *
 * When they disagree this exits 2 and says so, rather than trusting whichever
 * is convenient. That is the whole correction: the failure was not reading the
 * wrong endpoint, it was taking a single read as proof of an absence.
 *
 * NOT A SUBSTITUTE FOR THE WRITE PATH. The only answer that cannot be stale is
 * `npm publish` itself, where a 403 "cannot publish over" means yes. This tool
 * says so when it cannot get agreement.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
const NAME = pkg.name;
const VERSION = process.argv[2] ?? pkg.version;

// `@scope/name` -> `name-<version>.tgz`, which is how npm lays tarballs out.
const bare = NAME.includes('/') ? NAME.split('/')[1] : NAME;
const TARBALL = `https://registry.npmjs.org/${NAME}/-/${bare}-${VERSION}.tgz`;

async function viaPackument() {
  const res = await fetch(`https://registry.npmjs.org/${NAME}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    cache: 'no-store',
  });
  if (!res.ok) return { ok: false, why: `packument answered ${res.status}` };
  const body = await res.json();
  return {
    ok: true,
    present: Object.keys(body.versions ?? {}).includes(VERSION),
    tags: body['dist-tags'] ?? {},
  };
}

async function viaTarball() {
  const res = await fetch(TARBALL, { method: 'HEAD', cache: 'no-store' });
  if (res.status === 200) return { ok: true, present: true };
  if (res.status === 404) return { ok: true, present: false };
  return { ok: false, why: `tarball HEAD answered ${res.status}` };
}

const [p, t] = await Promise.all([viaPackument(), viaTarball()]);

if (!p.ok || !t.ok) {
  console.error(
    `is-published: could not get a clean answer for ${NAME}@${VERSION}.\n` +
      `  packument: ${p.ok ? `present=${p.present}` : p.why}\n` +
      `  tarball:   ${t.ok ? `present=${t.present}` : t.why}\n\n` +
      '  The only answer that cannot be stale is the write path: run `npm publish`.\n' +
      '  A 403 "cannot publish over the previously published versions" means it is\n' +
      '  published.',
  );
  process.exit(2);
}

if (p.present !== t.present) {
  console.error(
    `is-published: THE TWO PATHS DISAGREE about ${NAME}@${VERSION}.\n` +
      `  packument says present=${p.present} (dist-tags ${JSON.stringify(p.tags)})\n` +
      `  tarball HEAD says present=${t.present}\n\n` +
      '  This is npm replica lag, and it is the exact state that produced a wrong\n' +
      '  diagnosis on 12 October 2026. Do not pick one. Either wait and ask again,\n' +
      '  or run `npm publish`, where a 403 "cannot publish over" means published.',
  );
  process.exit(2);
}

if (p.present) {
  console.log(
    `is-published: ${NAME}@${VERSION} IS published. Both the packument and the tarball ` +
      `agree.\n  dist-tags: ${JSON.stringify(p.tags)}`,
  );
  process.exit(0);
}

console.log(
  `is-published: ${NAME}@${VERSION} is NOT published. Both the packument and the tarball ` +
    'agree.\n  dist-tags: ' +
    `${JSON.stringify(p.tags)}`,
);
process.exit(1);
