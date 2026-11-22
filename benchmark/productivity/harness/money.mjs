// What a phase's cap allows, as run.mjs enforces it (cold review of d89b967,
// NI-6): a run starts only if what remains of the cap covers its three task
// budgets plus the slack. So the last run of a phase needs that whole amount
// left, whatever the runs actually cost, and the cap must be sized for it.

/** What must remain of the cap for a run to start. */
export const startNeedUsd = (cfg) => Object.values(cfg.tasks).reduce((s, t) => s + t.maxBudgetUsd, 0) + cfg.runStartMarginUsd;

/** How many runs start, at most `runs`, when each costs `costPerRun`. */
export function runsThatStart({ capUsd, costPerRun, needUsd, runs }) {
  let spent = 0;
  let started = 0;
  while (started < runs && capUsd - spent >= needUsd) {
    started++;
    spent += costPerRun;
  }
  return started;
}

/** All `runs` start when (runs - 1) runs at `costPerRun` leave `needUsd` of the cap. */
export const phaseFits = ({ capUsd, costPerRun, needUsd, runs }) => (runs - 1) * costPerRun + needUsd <= capUsd;

/** The highest mean cost per run at which every run of the phase starts. */
export const maxCostPerRun = ({ capUsd, needUsd, runs }) => (capUsd - needUsd) / (runs - 1);
