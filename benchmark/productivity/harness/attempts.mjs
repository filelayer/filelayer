// The attempts log of one task's scoring (score-attempts.jsonl), shared by
// score.mjs, which appends to it, and analyze.mjs, which checks score.json
// against it (cold review of d89b967, NI-5).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * An attempt that ends the scoring of a task: no attempt follows it. A line
 * that does not parse ends it too, so editing the log by hand opens nothing.
 */
export const FINAL = new Set(['scored', 'installFailed', 'noProject', 'unreadable']);

/** The attempts of one task, oldest first. */
export function attemptLog(f) {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { result: 'unreadable' };
    }
  });
}

/**
 * null when the score file is the one the scorer wrote last, or why not: no
 * log, a log whose last attempt is not the file, or a file whose content is
 * not what the scorer logged.
 */
export function checkScoreFile(scoreFile, attemptsFile) {
  const log = attemptLog(attemptsFile);
  const has = existsSync(scoreFile);
  if (!log.length) return has ? 'a score file with no attempt behind it' : null;
  const last = log.at(-1);
  if (!has) return last.sha256 ? 'the attempts log has an attempt but its score file is missing' : null;
  if (!last.sha256) return 'the last attempt logged no score file';
  const sha = createHash('sha256').update(readFileSync(scoreFile)).digest('hex');
  return sha === last.sha256 ? null : 'the score file is not the one the scorer wrote last';
}
