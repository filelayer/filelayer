#!/usr/bin/env node
/**
 * WAIT, A BOUNDED TIME, FOR NPM TO SERVE A VERSION.
 *
 *   node tools/wait-npm-version.mjs <package> <version> [--timeout-s 600] [--interval-s 15]
 *   node tools/wait-npm-version.mjs --self-test
 *
 * Exit 0 as soon as `npm view <package>@<version> version` prints exactly
 * <version>. Exit 1 once the timeout has passed without that, saying how many
 * times it asked and what npm last answered.
 *
 * WHY. The release run of v0.35.1 (2026-11-02, run 41541791051) published to
 * npm, and the MCP registry job that needs it started seconds later. Its guard
 * asked npm once, npm answered 404 because the new version had not propagated
 * yet, and the guard correctly refused to publish an entry pointing at nothing.
 * The entry went out from the catch-up run instead, so "npm and MCP in one run"
 * (D049) did not hold. The guard was right and the timing was wrong: a version
 * npm has accepted becomes visible within minutes, so the guard now waits for
 * it, a bounded time, and still refuses if it never appears.
 *
 * The lookup is injectable so --self-test can show the loop failing on a version
 * that never becomes visible, passing on one that appears late, and respecting
 * its bound, without touching the network.
 */
import { execFile } from 'node:child_process';

function npmView(pkg, version) {
  return new Promise((resolve) => {
    execFile('npm', ['view', `${pkg}@${version}`, 'version'], { timeout: 60_000 }, (err, stdout, stderr) => {
      const out = String(stdout).trim();
      if (!err && out === version) return resolve({ ok: true, said: out });
      const lines = String(stderr || stdout || (err && err.message) || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const said = lines.find((l) => /^npm (error|ERR!)/.test(l)) ?? lines[0];
      resolve({ ok: false, said: said || '(no output)' });
    });
  });
}

export async function waitForVersion({ pkg, version, timeoutS, intervalS, lookup = npmView, sleep, now = () => Date.now() }) {
  const pause = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let tries = 0;
  let last = '';
  for (;;) {
    tries += 1;
    const r = await lookup(pkg, version);
    if (r.ok) return { ok: true, tries };
    last = r.said;
    if (now() - start + intervalS * 1000 > timeoutS * 1000) return { ok: false, tries, last };
    await pause(intervalS * 1000);
  }
}

async function selfTest() {
  let clock = 0;
  const fake = (visibleFrom) => {
    let n = 0;
    return async () => {
      n += 1;
      return n >= visibleFrom ? { ok: true, said: '1.2.3' } : { ok: false, said: 'npm error code E404' };
    };
  };
  const sleep = async (ms) => {
    clock += ms;
  };
  const now = () => clock;
  const base = { pkg: '@x/y', version: '1.2.3', timeoutS: 60, intervalS: 15, sleep, now };
  const cases = [];

  clock = 0;
  let r = await waitForVersion({ ...base, lookup: fake(1) });
  cases.push(['visible at once: passes on the first ask', r.ok && r.tries === 1]);

  clock = 0;
  r = await waitForVersion({ ...base, lookup: fake(3) });
  cases.push(['visible on the third ask: passes, after waiting', r.ok && r.tries === 3 && clock === 30_000]);

  clock = 0;
  r = await waitForVersion({ ...base, lookup: fake(Infinity) });
  cases.push([
    'never visible: fails, says what npm answered, and stops at its bound',
    !r.ok && r.last === 'npm error code E404' && clock <= 60_000 && r.tries === 5,
  ]);

  let bad = 0;
  for (const [name, ok] of cases) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) bad += 1;
  }
  console.log(`wait-npm-version --self-test: ${cases.length - bad}/${cases.length} controls behaved`);
  process.exit(bad ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === '--self-test') {
  await selfTest();
} else {
  const opt = (name, dflt) => {
    const i = args.indexOf(name);
    if (i === -1) return dflt;
    const v = Number(args[i + 1]);
    if (!Number.isFinite(v) || v <= 0) {
      console.error(`wait-npm-version: ${name} needs a positive number`);
      process.exit(2);
    }
    args.splice(i, 2);
    return v;
  };
  const timeoutS = opt('--timeout-s', 600);
  const intervalS = opt('--interval-s', 15);
  const [pkg, version] = args;
  if (!pkg || !version) {
    console.error('usage: node tools/wait-npm-version.mjs <package> <version> [--timeout-s N] [--interval-s N]');
    process.exit(2);
  }
  const r = await waitForVersion({ pkg, version, timeoutS, intervalS });
  if (r.ok) {
    console.log(`wait-npm-version: npm serves ${pkg}@${version} (asked ${r.tries} time(s)).`);
  } else {
    console.error(
      `::error::${pkg}@${version} is not on npm after ${timeoutS}s (asked ${r.tries} time(s); last answer: ${r.last}). ` +
        'The entry would point at nothing.',
    );
    process.exit(1);
  }
}
