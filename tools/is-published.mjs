#!/usr/bin/env node
/**
 * Is a version on npm? Asked down two independent paths, told when they
 * disagree, and told when neither has arrived yet.
 *
 *     node tools/is-published.mjs            # the version in package.json
 *     node tools/is-published.mjs 0.29.0
 *     node tools/is-published.mjs --self-test
 *
 * EXIT CODES
 *   0  published; both paths agree it is there
 *   1  not published, and no upload was attempted from this working tree
 *   2  no clean answer: the paths disagree, one is unreachable, or an attempted
 *      upload is still invisible long after replica lag would explain it
 *   3  inconclusive: absent, but an upload was attempted minutes ago
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
 *      code path, and the one a reader's `npm install` has to actually fetch.
 *
 * THEY PROPAGATE IN ORDER, AND THE ORDER MATTERS. This file first said the
 * tarball is "the one that answered correctly" on 12 October, as though one
 * endpoint were simply more reliable. Watching the 0.30.0 publish settled it
 * properly: minutes after the upload both said absent; a minute later the
 * packument said present with both dist-tags moved while the tarball still
 * answered 404; a minute after that they agreed.
 *
 * So the metadata lands before the bytes, and the dangerous read is the
 * PACKUMENT -- it says a version exists while what an install must download is
 * not there yet. That is the endpoint the wrong diagnosis on 12 October leaned
 * on. Neither is authoritative alone: the disagreement tells you where in the
 * sequence you are, which is information a single read destroys.
 *
 * ---------------------------------------------------------------------------
 * AND WHY AGREEMENT IS NOT ONE, BEFORE THE DISAGREEMENT
 * ---------------------------------------------------------------------------
 *
 * The version above had three answers, and the one it got wrong was its
 * confident one. Publishing 0.31.0 on 13 October, four minutes after
 * `npm publish` printed `+ @filelayer/core@0.31.0`, it said:
 *
 *     @filelayer/core@0.31.0 is NOT published.
 *     Both the packument and the tarball agree.
 *
 * Two minutes later they disagreed; two after that they agreed the other way.
 * The sequence this file documents ran exactly as written -- and the file still
 * reported the first step as a finding.
 *
 * TWO READS OF A SYSTEM THAT PROPAGATES IN ORDER ARE NOT TWO WITNESSES WHILE
 * NEITHER HAS ARRIVED. Agreement-on-absent is informative only AFTER you have
 * seen the disagreement; before that it means "too early to tell". It is the
 * 12 October defect again with the count changed: then one read was taken as
 * proof of an absence, then two were.
 *
 * So an absence is now reported against what this tree knows about uploads. An
 * attempt recorded minutes ago makes the absence inconclusive (exit 3) rather
 * than a finding; the same attempt half an hour old makes it alarming (exit 2),
 * because past the lag window patience is not the explanation. With no attempt
 * recorded, exit 1 stands -- and says it is local knowledge, because
 * `.measured/` does not travel and a publish from another machine leaves
 * nothing here. See `publish-attempt.mjs`, including the first design for this,
 * which was wrong in a way worth keeping written down.
 *
 * NOT A SUBSTITUTE FOR THE WRITE PATH. The only answer that cannot be stale is
 * `npm publish` itself, where a 403 "cannot publish over" means yes. This tool
 * says so whenever it cannot get agreement.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LAG_WINDOW_MS, lookup } from './publish-attempt.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/core/package.json'), 'utf8'));
const NAME = pkg.name;

const minutes = (ms) => `${Math.round(ms / 60000)} minute(s)`;

/**
 * The whole decision, as a pure function, so the controls below can reach it.
 *
 * It was not a function before, and that is why the 13 October answer had no
 * test that could have caught it: the classification lived inline between two
 * `await`s and the only way to exercise it was to publish something.
 */
export function classify({ name, version, packument: p, tarball: t, attempt }) {
  const id = `${name}@${version}`;
  const writePath =
    '  The only answer that cannot be stale is the write path: run `npm publish`.\n' +
    '  A 403 "cannot publish over the previously published versions" means it is\n' +
    '  published.';

  if (!p.ok || !t.ok) {
    return {
      exit: 2,
      stream: 'error',
      text:
        `is-published: could not get a clean answer for ${id}.\n` +
        `  packument: ${p.ok ? `present=${p.present}` : p.why}\n` +
        `  tarball:   ${t.ok ? `present=${t.present}` : t.why}\n\n${writePath}`,
    };
  }

  if (p.present !== t.present) {
    return {
      exit: 2,
      stream: 'error',
      text:
        `is-published: THE TWO PATHS DISAGREE about ${id}.\n` +
        `  packument says present=${p.present} (dist-tags ${JSON.stringify(p.tags)})\n` +
        `  tarball HEAD says present=${t.present}\n\n` +
        '  This is npm replica lag, and it is the exact state that produced a wrong\n' +
        '  diagnosis on 12 October 2026. Do not pick one. Either wait and ask again,\n' +
        '  or run `npm publish`, where a 403 "cannot publish over" means published.',
    };
  }

  if (p.present) {
    return {
      exit: 0,
      stream: 'log',
      text:
        `is-published: ${id} IS published. Both the packument and the tarball agree.\n` +
        `  dist-tags: ${JSON.stringify(p.tags)}` +
        (attempt ? `\n  (an upload was attempted from this tree at ${attempt.at}.)` : ''),
    };
  }

  // Absent on both paths. What that MEANS depends entirely on whether anything
  // tried to upload it, which is the correction this file exists for.
  if (attempt?.withinWindow) {
    return {
      exit: 3,
      stream: 'error',
      text:
        `is-published: INCONCLUSIVE for ${id}. Both paths say absent, and an upload\n` +
        `  was attempted from this tree ${minutes(attempt.ageMs)} ago, at ${attempt.at}.\n\n` +
        '  Agreement that a version is absent is only evidence AFTER the two paths\n' +
        '  have been seen to disagree. Before that, both replicas are simply equally\n' +
        '  behind, and that is what this tool reported as a finding on 13 October 2026,\n' +
        '  four minutes after `npm publish` printed the version it was denying.\n\n' +
        `  Wait and ask again. Replica lag has been under ten minutes every time it\n` +
        `  was measured here; past ${minutes(LAG_WINDOW_MS)} this becomes exit 2 instead.`,
    };
  }

  if (attempt) {
    return {
      exit: 2,
      stream: 'error',
      text:
        `is-published: ${id} is absent on both paths, and an upload was attempted\n` +
        `  from this tree ${minutes(attempt.ageMs)} ago, at ${attempt.at}.\n\n` +
        `  THAT IS TOO LONG FOR REPLICA LAG, which has never exceeded ten minutes\n` +
        '  here. Waiting is no longer the explanation. Something else is wrong: a\n' +
        '  different registry, a different package name, or an upload that failed\n' +
        '  after `prepublishOnly` had already recorded the attempt.\n\n' +
        `${writePath}`,
    };
  }

  return {
    exit: 1,
    stream: 'log',
    text:
      `is-published: ${id} is NOT published. Both the packument and the tarball\n` +
      `  agree, and no upload was attempted from this working tree.\n` +
      `  dist-tags: ${JSON.stringify(p.tags)}\n\n` +
      '  THAT LAST CLAUSE IS LOCAL. `.measured/` is not committed, so a publish from\n' +
      '  another machine or a fresh clone leaves no record here, and this absence is\n' +
      '  then worth no more than the two reads behind it.',
  };
}

if (process.argv.includes('--self-test')) {
  const now = Date.parse('2026-10-13T21:40:00.000Z');
  const ago = (ms) => ({
    at: new Date(now - ms).toISOString(),
    ageMs: ms,
    withinWindow: ms <= LAG_WINDOW_MS,
  });
  const absent = { ok: true, present: false, tags: { latest: '0.30.0' } };
  const present = { ok: true, present: true, tags: { latest: '0.31.0' } };
  const base = { name: '@filelayer/core', version: '0.31.0' };

  const cases = [
    // THE CONTROL THAT MATTERS. This is the 13 October answer, and the whole
    // reason the file changed: it must not come out as "not published".
    ['absent on both, uploaded 4 minutes ago', { packument: absent, tarball: absent, attempt: ago(4 * 60_000) }, 3],
    // The opposite error, which a careless fix would introduce: doubting every
    // absence would break the runbook's first question.
    ['absent on both, nothing attempted here', { packument: absent, tarball: absent, attempt: null }, 1],
    // An attempt must never mask a success into doubt.
    ['present on both, uploaded 4 minutes ago', { packument: present, tarball: present, attempt: ago(4 * 60_000) }, 0],
    // Past the window the advice inverts, so the exit must too.
    ['absent on both, uploaded 2 hours ago', { packument: absent, tarball: absent, attempt: ago(2 * 3600_000) }, 2],
    // Disagreement outranks everything: it is a positive reading of where in
    // the sequence you are, attempt or no attempt.
    ['paths disagree, uploaded 4 minutes ago', { packument: present, tarball: absent, attempt: ago(4 * 60_000) }, 2],
    ['packument unreachable', { packument: { ok: false, why: 'answered 503' }, tarball: absent, attempt: null }, 2],
  ];

  let bad = 0;
  for (const [what, inputs, want] of cases) {
    const got = classify({ ...base, ...inputs }).exit;
    if (got !== want) {
      console.error(`  control FAILED: ${what} -> exit ${got}, expected ${want}`);
      bad++;
    } else {
      console.log(`  ok: ${what} -> exit ${want}`);
    }
  }
  // The lag window is load-bearing, so the arithmetic behind `withinWindow` is
  // checked too rather than assumed from the cases above.
  const boundary = [
    [LAG_WINDOW_MS - 1, true],
    [LAG_WINDOW_MS + 1, false],
  ];
  for (const [age, want] of boundary) {
    const got = lookup('p', '1.0.0', now, { 'p@1.0.0': new Date(now - age).toISOString() })
      .withinWindow;
    if (got !== want) {
      console.error(`  control FAILED: age ${age}ms withinWindow=${got}, expected ${want}`);
      bad++;
    }
  }
  console.log(
    bad === 0
      ? `is-published: ${cases.length + boundary.length} controls correct.`
      : `is-published: ${bad} control(s) WRONG.`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

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

const [packument, tarball] = await Promise.all([viaPackument(), viaTarball()]);
const verdict = classify({
  name: NAME,
  version: VERSION,
  packument,
  tarball,
  attempt: lookup(NAME, VERSION),
});

(verdict.stream === 'error' ? console.error : console.log)(verdict.text);
process.exit(verdict.exit);
