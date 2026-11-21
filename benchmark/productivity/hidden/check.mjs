#!/usr/bin/env node
/**
 * Score one implementation: start it against a fresh environment, run the
 * hidden functional checks and the 21 shared attacks, print the three blocks
 * (functional, security, both) and write them as JSON.
 *
 *   node benchmark/productivity/hidden/check.mjs <implementation dir> [--task 1|2|3] [--json out.json] [--only functional|attacks]
 *
 * --task 2 adds the checks of the requirement change; the task-1 battery and
 * the attacks still run, because everything that worked must keep working.
 * --task 3 adds the check for the seeded bug.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startEnv, startServer } from '../harness/local-env.mjs';
import { client } from './client.mjs';
import { runAttacks } from './attacks-adapter.mjs';
import { runFunctional } from './functional.mjs';
import { runTask2 } from './task2.mjs';
import { runTask3 } from './task3.mjs';

const args = process.argv.slice(2);
const dir = resolve(args[0] ?? '.');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const verbose = args.includes('--verbose');
const task = args.includes('--task') ? Number(args[args.indexOf('--task') + 1]) : 1;
if (![1, 2, 3].includes(task)) throw new Error('--task is 1, 2 or 3');

const envH = await startEnv();
let server;
const log = [];
try {
  server = await startServer(dir, envH.env, { log: (s) => log.push(s) });
  const make = () => client(server.baseUrl, server.adminToken);
  const out = { implementation: dir, task };
  if (only !== 'attacks') {
    out.functional = await runFunctional(make);
    console.log(`functional: ${out.functional.passed}/${out.functional.of}`);
    for (const f of out.functional.results.filter((r) => !r.pass)) console.log(`  FAIL ${f.id} ${f.name}: ${f.detail}`);
    if (task > 1) {
      const extra = await (task === 2 ? runTask2 : runTask3)(make);
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
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
} catch (e) {
  console.error(`check: ${e.message}`);
  console.error(log.join('').slice(-3000));
  process.exitCode = 2;
} finally {
  await server?.stop();
  await envH.stop();
}
// Nothing may keep a scorer alive once the result is written.
process.exit(process.exitCode ?? 0);
