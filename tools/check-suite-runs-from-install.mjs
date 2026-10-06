#!/usr/bin/env node
/**
 * THE PUBLISHED SUITE RUNS, FROM AN INSTALL, BY THE PROCEDURE WE PUBLISH.
 *
 *   node tools/check-suite-runs-from-install.mjs
 *   node tools/check-suite-runs-from-install.mjs --self-test   # controls only
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 *
 * "547 tests travel with the package, so every behavioural claim is checkable
 * from what you installed" is the single strongest sentence this project says
 * about itself, and on 5 October 2026 it was checked for the first time by
 * actually doing it. It failed three separate ways, each of which had been true
 * for weeks:
 *
 *   1. `node --test node_modules/@filelayer/core/test/*.ts` does not run at
 *      all. Node refuses to strip types under `node_modules`, with or without
 *      `--experimental-strip-types` and `--experimental-transform-types`. Every
 *      shipped test file, not one of them.
 *   2. `llms.txt` knew about (1) and told the reader to "clone the repository
 *      to run it", which answers a different question. A checkout is not the
 *      artefact you were sent, and verifying the repository instead of the
 *      tarball gives up the entire point of shipping the tests.
 *   3. Copying `test/` and `src/` out, which is the obvious remedy, produces
 *      FIFTEEN failures: the suite also reads `schema.sql`, `migrations/` and
 *      `examples/`. A reader who took us at our word and got fifteen red tests
 *      would reasonably conclude the numbers on our website are invented.
 *
 * And underneath all three, `test/real-postgres.ts` imported `pg` statically,
 * so `contention.test.ts` crashed with ERR_MODULE_NOT_FOUND instead of
 * skipping. Its skip logic was correct and never got to run.
 *
 * None of that is subtle. It survived because the claim had never been
 * executed, which is this project's recurring defect in its purest form: a
 * sentence with no runner behind it. `check-install-reach.mjs` already packs
 * the tarball and resolves every import inside it, and reported clean
 * throughout, because resolving an import is not running a test.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT DOES, AND WHY IT READS THE DOCUMENT
 * -----------------------------------------------------------------------------
 *
 * It packs the tarball, installs it into a throwaway project the way a stranger
 * would, then EXTRACTS THE SHELL BLOCK OUT OF `docs/VERIFY-WHAT-YOU-INSTALLED.md`
 * and runs that, verbatim, with no edits and no fallback.
 *
 * Reading the document rather than reimplementing it is the whole design. A
 * gate that runs its own private copy of the procedure proves that SOME
 * procedure works, which is exactly the gap that produced the three failures
 * above: in each case something worked somewhere and the published instructions
 * did not match it. If someone improves the instructions, CI runs the
 * improvement. If someone breaks them, CI goes red on the same commit.
 *
 * Then it asserts the run matches the "What you should see" table in that same
 * document, which makes the table executable rather than asserted. So this also
 * answers a question no other gate here answers: are the numbers we publish
 * reproducible by somebody who has only the package?
 *
 * It is slow, about two minutes, and it is kept in `npm run verify` anyway. A
 * gate moved out of the default path because it is slow is a gate that runs on
 * the commits nobody was worried about.
 */

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CORE = join(ROOT, 'packages', 'core');
const DOC = 'docs/VERIFY-WHAT-YOU-INSTALLED.md';
const MARKER = 'EXECUTED BY: tools/check-suite-runs-from-install.mjs';
const KEEP = process.argv.includes('--keep');

const problems = [];
const fail = (m) => problems.push(m);

// --- the procedure, read out of the document --------------------------------

/**
 * The one shell block the document marks as executable. Exactly one, because
 * "the first bash block" silently follows an edit that inserts another one
 * above it, and this gate exists because of silent drift between a document
 * and reality.
 */
function procedureFrom(text) {
  const blocks = [];
  const re = new RegExp(`<!--[^]*?${MARKER}[^]*?-->\\s*\`\`\`bash\\n([^]*?)\`\`\``, 'g');
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]);
  if (blocks.length !== 1) {
    fail(
      `${DOC}: expected exactly one shell block marked "${MARKER}", found ${blocks.length}. ` +
        'The gate runs the published procedure rather than its own copy, so it has to know ' +
        'which block that is.',
    );
    return null;
  }
  return blocks[0];
}

// --- the controls -----------------------------------------------------------
//
// Both must be seen to fail, because this gate's whole value is that it
// executes something, and a harness that reports success without executing is
// indistinguishable from one that executes a passing suite.
const CONTROLS = [
  {
    name: 'a document with no marked block is refused',
    run: () => procedureFromQuiet('# nothing here\n\n```bash\necho hi\n```\n') === null,
  },
  {
    name: 'a document with two marked blocks is refused',
    run: () => {
      const two = `<!-- ${MARKER} -->\n\`\`\`bash\necho a\n\`\`\`\n\n<!-- ${MARKER} -->\n\`\`\`bash\necho b\n\`\`\`\n`;
      return procedureFromQuiet(two) === null;
    },
  },
  {
    name: 'the tally parser reads a failing run as failing',
    run: () => {
      const t = parseTally('# tests 547\n# pass 500\n# fail 15\n# skipped 8\n# suites 130\n');
      return t.fail === 15 && t.pass === 500;
    },
  },
  {
    name: 'the tally parser refuses output with no tally at all',
    run: () => parseTally('something went wrong and node printed nothing') === null,
  },
];

function procedureFromQuiet(text) {
  const before = problems.length;
  const r = procedureFrom(text);
  problems.length = before;
  return r;
}

/** Node's TAP summary. Returns null when there is no tally, which is itself a failure. */
function parseTally(out) {
  const n = (k) => {
    const m = out.match(new RegExp(`^# ${k} (\\d+)$`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = n('tests');
  if (tests === null) return null;
  return { tests, pass: n('pass'), fail: n('fail'), skipped: n('skipped'), suites: n('suites') };
}

const controlFailures = CONTROLS.filter((c) => {
  try {
    return !c.run();
  } catch {
    return true;
  }
}).map((c) => c.name);

if (process.argv.includes('--self-test')) {
  if (controlFailures.length) {
    console.error(`controls DID NOT behave:\n  - ${controlFailures.join('\n  - ')}`);
    process.exit(1);
  }
  console.log(`check-suite-runs-from-install: ${CONTROLS.length} controls correct.`);
  process.exit(0);
}

if (controlFailures.length) {
  fail(`this gate's own controls disagree, so its verdict is unreliable:\n      - ${controlFailures.join('\n      - ')}`);
}

// --- the run ----------------------------------------------------------------

const docText = readFileSync(join(ROOT, DOC), 'utf8');
const procedure = procedureFrom(docText);

/**
 * THE DOCUMENT'S OWN TABLE IS THE EXPECTATION, not `.measured/suite-counts.json`.
 *
 * The first version read the recorded run, and CI failed it twice for two
 * different reasons, both correct:
 *
 *   - The job that runs this gate does not run the suite, so the recorded file
 *     was not there at all.
 *   - Where it IS there, it describes a different run. CI has a real
 *     PostgreSQL, so the concurrency suite executes instead of skipping and the
 *     recorded numbers are 547 passing and 0 skipped. The published procedure
 *     uses PGlite and no server, and produces 539 passing and 8 skipped. Both
 *     are true; neither is the other's expectation.
 *
 * The table below the procedure in the document says what a reader should see.
 * That is the claim, it is the thing a stranger will compare their own output
 * against, and it does not move with the environment this gate happens to run
 * in. So it is what the run is checked against, which also makes the table
 * executable rather than asserted.
 */
const expected = (() => {
  const table = {};
  for (const m of docText.matchAll(/^\|\s*(tests|pass|fail|skipped|suites)\s*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/gm)) {
    table[m[1]] = Number(m[2]);
  }
  const want = ['tests', 'pass', 'fail', 'skipped', 'suites'];
  const absent = want.filter((k) => table[k] === undefined);
  if (absent.length) {
    fail(
      `${DOC}: the "What you should see" table is missing a row for ${absent.join(', ')}. ` +
        'This gate checks the run against that table, so a row nobody wrote is a number ' +
        'nobody checks.',
    );
    return null;
  }
  if (table.fail !== 0) {
    fail(
      `${DOC}: the table says ${table.fail} failing tests are expected. It is the procedure we ` +
        'invite strangers to run; the expected number of failures is zero.',
    );
    return null;
  }
  return table;
})();

let work = null;
if (procedure && expected && !problems.length) {
  work = mkdtempSync(join(tmpdir(), 'filelayer-install-'));
  try {
    // A consumer project: the tarball as a dependency, and nothing else. Its
    // devDependencies must NOT arrive, because the point is to test what a
    // stranger receives.
    // `stdio` captures stderr too: `npm pack` prints the whole file listing
    // there, and a gate that buries its own verdict under 115 lines of notice
    // is a gate people stop reading.
    const tgz = execFileSync('npm', ['pack', '--pack-destination', work], {
      cwd: CORE,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n').pop();

    writeFileSync(join(work, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--silent', join(work, tgz)], {
      cwd: work,
      stdio: 'pipe',
    });

    // THE PUBLISHED PROCEDURE, VERBATIM, from inside that project.
    // TMPDIR IS LEFT ALONE, deliberately. Pointing it at this gate's own
    // scratch directory looks tidier and breaks the run: the suite writes its
    // own temporary trees there, some with read-only directories, and the
    // cleanup below then fails with EACCES after a two-minute pass. The
    // procedure removes its own `$TMPDIR/filelayer-verify` at the start of
    // every run, which is the same guarantee without the entanglement.
    const out = execSync(`set -e\n${procedure}`, {
      cwd: work,
      encoding: 'utf8',
      shell: '/bin/bash',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const tally = parseTally(out);
    if (!tally) {
      fail(
        `${DOC}: the published procedure ran but printed no test tally. It is supposed to end ` +
          'in `node --test`, and whatever it ends in now did not report one.',
      );
    } else {
      for (const [k, v] of Object.entries(expected)) {
        if (tally[k] !== v) {
          fail(
            `the suite run from an install reported ${k}=${tally[k]}; ${DOC} tells a reader to ` +
              `expect ${k}=${v}.\n      That table is what a stranger compares their own output ` +
              'against, so one of the two is wrong and both are published.',
          );
        }
      }
      if (!problems.length) {
        console.log(
          `check-suite-runs-from-install: clean. The procedure in ${DOC} was run verbatim ` +
            `against a freshly packed tarball installed as a dependency: ${tally.tests} test(s), ` +
            `${tally.pass} passing, ${tally.fail} failing, ${tally.skipped} skipped across ` +
            `${tally.suites} suites, matching every row of that document's own table. ` +
            `${CONTROLS.length} controls correct.`,
        );
      }
    }
  } catch (e) {
    const detail = [e.stdout, e.stderr].filter(Boolean).join('\n').trim().slice(-2500);
    fail(
      `the procedure published in ${DOC} did not complete.\n` +
        `      This is the procedure we invite readers to run against what they installed, so a\n` +
        `      failure here is a failure they would hit.\n\n${detail.replace(/^/gm, '      ')}`,
    );
  } finally {
    // Cleanup must never turn a passing run into a failure. A leftover scratch
    // directory is untidy; a gate that reports red because it could not delete
    // one teaches people to ignore it.
    if (KEEP) console.error(`kept: ${work}`);
    else {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        console.error(`check-suite-runs-from-install: could not remove ${work}; leaving it.`);
      }
    }
  }
}

if (problems.length) {
  console.error(`\ncheck-suite-runs-from-install: FAILED\n\n${problems.map((p) => `  - ${p}`).join('\n\n')}\n`);
  process.exit(1);
}
