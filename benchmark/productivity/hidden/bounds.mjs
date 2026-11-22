/**
 * Every time limit of the scoring, in one place, and the worst case they add
 * up to (cold review of d89b967, NI-4). A check that reaches its limit fails,
 * and that is the snapshot's failure. The scorer's global limit is the
 * scorer's failure, so it must be out of reach of the per-check limits:
 * rules.test.mjs checks that it is, with room to spare.
 */

export const REQUEST_MS = 30_000; // one HTTP request (client.mjs)
export const START_MS = 60_000; // a server answering /health (local-env.mjs)
export const CHECK_MS = 120_000; // one functional or task-2 check
export const T3_CHECK_MS = 240_000; // T3-01, which builds a world of its own
export const SEED_MS = 120_000; // seeding task 3 from the seeded reference
// One attack, all of it: its world (adapterFor), its positive control and the
// attack itself.
export const ATTACK_MS = 180_000;
// The room the global limit keeps above the worst case: the services, the
// copy of the snapshot, stopping servers and probing the environment.
export const SPARE_MINUTES = 30;

/**
 * The longest one scoring can take before the scorer's global limit, in
 * minutes, for the larger of task 2 and task 3 (task 1 is task 2 without its
 * own checks), or for the late attacks alone.
 */
export function worstCaseMinutes({ installMinutes, functional, task2, task3, attacks, late = 0 }) {
  const min = (ms) => ms / 60_000;
  const primary = Math.max(
    // Task 2: install, start, the task-1 battery, its own checks, the attacks.
    installMinutes + min(START_MS) + functional * min(CHECK_MS) + task2 * min(CHECK_MS) + attacks * min(ATTACK_MS),
    // Task 3: the seeded reference installed, started and seeded first.
    2 * installMinutes + 2 * min(START_MS) + min(SEED_MS) + functional * min(CHECK_MS) + task3 * min(T3_CHECK_MS) + attacks * min(ATTACK_MS),
  );
  const lateOnly = installMinutes + min(START_MS) + late * min(ATTACK_MS);
  return Math.max(primary, lateOnly);
}

/**
 * Run `work(signal)` for at most `ms`. Past the limit the promise rejects and
 * the signal aborts, so every request of the abandoned work fails at once
 * instead of reaching the service during the next check.
 */
export function bounded(ms, what, work) {
  const ac = new AbortController();
  let t;
  const limit = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error(`${what} took more than ${ms / 1000} s`);
      ac.abort(e);
      reject(e);
    }, ms);
  });
  return Promise.race([Promise.resolve().then(() => work(ac.signal)), limit]).finally(() => clearTimeout(t));
}
