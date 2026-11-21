#!/usr/bin/env node
/**
 * Score one implementation: start it against a fresh environment, run the
 * hidden functional checks and the 21 shared attacks, print the three blocks
 * (functional, security, both) and write them as JSON.
 *
 *   node benchmark/productivity/hidden/check.mjs <implementation dir> [--task 1|2|3]
 *        [--seed <seeded reference dir>] [--late] [--json out.json] [--only functional|attacks]
 *
 * --task 2 adds the checks of the requirement change; the task-1 battery and
 * the attacks still run, because everything that worked must keep working.
 * --late scores ONLY the attacks written after the freeze (late/), apart
 * from everything else; use it with its own --json file. It never runs, and
 * never writes, the primary checks.
 *
 * --task 3 adds the check for the seeded bug. With --seed, the seeded
 * reference is started first on the same database and bucket and builds the
 * world T3-01 checks, so the snapshot is scored on data uploaded while the
 * bug was live (see task3.mjs).
 *
 * WHOSE FAILURE IS IT. Three outcomes are kept apart, because only one of them
 * is the agent's:
 *
 *   - the services (PostgreSQL, moto) fail, before or after the scoring:
 *     `scorerError: 'environment'`, exit 3. The scoring is repeated; it says
 *     nothing about the agent.
 *   - the snapshot does not start (no /health within a minute): the agent's
 *     failure. `serverFailed: true`, every check failed, 0 attacks defended.
 *   - the checks themselves throw: `scorerError: 'exception'`, exit 3.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeEnv, startEnv, startServer } from '../harness/local-env.mjs';
import { client } from './client.mjs';
import { SHARED, runAttacks, runLateAttacks } from './attacks-adapter.mjs';
import { CHECKS as F_CHECKS, runFunctional } from './functional.mjs';
import { CHECKS as T2_CHECKS, runTask2 } from './task2.mjs';
import { CHECKS as T3_CHECKS, runTask3, seedTask3 } from './task3.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? '.');
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const jsonOut = opt('--json');
const only = opt('--only');
const seedDir = opt('--seed') ? resolve(opt('--seed')) : null;
const verbose = args.includes('--verbose');
const late = args.includes('--late');
const task = opt('--task') ? Number(opt('--task')) : 1;
if (![1, 2, 3].includes(task)) throw new Error('--task is 1, 2 or 3');

const write = (out) => {
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
};
const scorerError = (kind, detail) => {
  console.error(`check: scorer error (${kind}): ${detail}`);
  write({ implementation: dir, task, scorerError: kind, detail: String(detail).slice(0, 2000) });
  process.exitCode = 3;
};

const envH = await startEnv();
let server;
const log = [];
try {
  const before = await probeEnv(envH.env, envH.probeUrl);
  if (before) {
    scorerError('environment', before);
  } else {
    const out = { implementation: dir, task };
    let seed = null;
    if (late) {
      // The late attacks alone, against the snapshot, on an empty database.
      server = await startServer(dir, envH.env, { log: (s) => log.push(s) });
      out.late = await runLateAttacks(() => client(server.baseUrl, server.adminToken));
      console.log(`late attacks: ${out.late.defended}/${out.late.of} defended`);
      write(out);
    } else if (task === 3 && seedDir) {
      const ref = await startServer(seedDir, envH.env);
      try {
        seed = await seedTask3(client(ref.baseUrl, ref.adminToken));
      } finally {
        await ref.stop();
      }
      out.seeded = true;
    }
    if (!late) try {
      server = await startServer(dir, envH.env, { log: (s) => log.push(s) });
    } catch (e) {
      // The snapshot did not come up: the agent's failure, scored as zero.
      const none = (checks) => ({ results: [], passed: 0, of: checks.length, allPassed: false });
      Object.assign(out, {
        serverFailed: true,
        detail: `${e.message}\n${log.join('').slice(-2000)}`,
        functional: none(F_CHECKS),
        ...(task > 1 ? { [`task${task}`]: none(task === 2 ? T2_CHECKS : T3_CHECKS) } : {}),
        security: { results: [], defended: 0, of: SHARED.length, allDefended: false },
        both: false,
      });
      console.log('the snapshot did not start: every check failed, 0 attacks defended');
      write(out);
    }
    if (server && !late) {
      const make = () => client(server.baseUrl, server.adminToken);
      if (only !== 'attacks') {
        out.functional = await runFunctional(make);
        console.log(`functional: ${out.functional.passed}/${out.functional.of}`);
        for (const f of out.functional.results.filter((r) => !r.pass)) console.log(`  FAIL ${f.id} ${f.name}: ${f.detail}`);
        if (task > 1) {
          const extra = task === 2 ? await runTask2(make) : await runTask3(make, seed);
          console.log(`task ${task}: ${extra.passed}/${extra.of}`);
          for (const f of extra.results.filter((r) => !r.pass)) console.log(`  FAIL ${f.id} ${f.name}: ${f.detail}`);
          out[`task${task}`] = extra;
          // The functional block of a later task is its own checks AND the task-1 battery.
          out.functional = { ...out.functional, allPassed: out.functional.allPassed && extra.allPassed };
        }
      }
      if (only !== 'functional') {
        out.security = await runAttacks(make);
        console.log(`security: ${out.security.defended}/${out.security.of} shared attacks defended`);
        for (const r of out.security.results) {
          if (verbose || (r.scored && r.verdict !== 'defended')) console.log(`  ${r.scored ? '' : '(not scored) '}${r.id} ${r.verdict}: ${r.detail}`);
        }
      }
      if (out.functional && out.security) {
        out.both = out.functional.allPassed && out.security.allDefended;
        console.log(`both: ${out.both ? 'yes' : 'no'}`);
      }
      // Services that died during the scoring make every result after that point
      // suspect, whoever's fault the failures look like. Asked after the
      // snapshot is stopped, so its own connections are gone (N-I8).
      await server.stop();
      server = null;
      const after = await probeEnv(envH.env, envH.probeUrl);
      if (after) scorerError('environment', `after the scoring: ${after}`);
      else write(out);
    }
  }
} catch (e) {
  scorerError('exception', `${e.stack ?? e.message}\n${log.join('').slice(-2000)}`);
} finally {
  await server?.stop();
  await envH.stop();
}
// Nothing may keep a scorer alive once the result is written.
process.exit(process.exitCode ?? 0);
