/**
 * A record that `npm publish` was about to upload a particular version.
 *
 * A LIBRARY. Nothing happens at import; `record()` writes only when called.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT THE VERIFICATION STAMP
 * ---------------------------------------------------------------------------
 *
 * `is-published.mjs` asks npm down two paths and reports disagreement. On
 * 13 October 2026, four minutes after `npm publish` printed
 * `+ @filelayer/core@0.31.0`, it said:
 *
 *     is-published: @filelayer/core@0.31.0 is NOT published.
 *     Both the packument and the tarball agree.
 *
 * Both replicas were simply equally behind. Two reads of a system that
 * propagates in order are not two independent witnesses while neither has
 * arrived -- which is the 12 October defect wearing a second face: then it was
 * one read taken as proof of absence, now it was two.
 *
 * THE FIRST DESIGN FOR THIS WAS WRONG and is worth recording. The proposal was
 * to key the doubt on the verification stamp: if `verify` and `verify:release`
 * have run against this exact tree, treat an absence as inconclusive. But
 * `verify` runs constantly during development, days before anything is
 * published. That rule would turn every TRUE "not published" into "I don't
 * know", permanently, and the runbook's first question is exactly "is this
 * already published?". It would have broken the tool's main use to fix its
 * rarest answer.
 *
 * What makes an absence untrustworthy is not that the tree was verified. It is
 * that an upload was attempted. So that is what gets recorded, and the place to
 * record it is `prepublishOnly` -- npm's last hook before the bytes go, where a
 * non-zero exit means no upload happens at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT PROVE
 * ---------------------------------------------------------------------------
 *
 * `prepublishOnly` runs BEFORE the upload, so this records an intent, not a
 * success. A publish that fails afterwards (network, auth, 403) leaves a record
 * saying it was attempted. That is the safe direction: the consequence is
 * `is-published` answering "inconclusive, the write path is the only
 * non-stale answer", which is the correct advice whether the upload landed or
 * not.
 *
 * It is also LOCAL. `.measured/` is not committed, so a publish from another
 * machine, or from a fresh clone, leaves no record here. `is-published` says so
 * in that case rather than implying its absence is better evidence than it is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ATTEMPTS = join(ROOT, '.measured', 'publish-attempts.json');

/**
 * How long after an attempt an absence is explained by replica lag.
 *
 * Measured, not guessed, and generously over the measurements: 0.30.0's bytes
 * landed about two minutes after the upload, 0.31.0's about six. Thirty minutes
 * is five times the worse of the two.
 *
 * The window is what separates "wait and ask again" from "waiting is no longer
 * the explanation". Past it, an attempted publish that is still invisible is
 * not patience, it is a different fault -- the wrong registry, the wrong
 * package name, or an upload that failed after this guard passed.
 */
export const LAG_WINDOW_MS = 30 * 60 * 1000;

const key = (name, version) => `${name}@${version}`;

function readAll() {
  if (!existsSync(ATTEMPTS)) return {};
  try {
    const parsed = JSON.parse(readFileSync(ATTEMPTS, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A corrupt log is treated as no log. The consequence is `is-published`
    // giving its weaker, caveated answer, which is the safe direction.
    return {};
  }
}

/** Record that an upload of `name@version` is about to be attempted. */
export function record(name, version, at = new Date()) {
  const all = readAll();
  all[key(name, version)] = at.toISOString();
  mkdirSync(dirname(ATTEMPTS), { recursive: true });
  writeFileSync(ATTEMPTS, `${JSON.stringify(all, null, 2)}\n`);
  return all[key(name, version)];
}

/**
 * The recorded attempt for `name@version`, or null.
 *
 * Returns `{ at, ageMs, withinWindow }`. An unparseable timestamp is treated as
 * no record rather than as an infinitely old one, because "a long time ago" is
 * the answer that makes `is-published` alarming, and a corrupt field is not
 * evidence of anything.
 */
export function lookup(name, version, now = Date.now(), log = readAll()) {
  const at = log[key(name, version)];
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;
  const ageMs = now - ms;
  return { at, ageMs, withinWindow: ageMs >= 0 && ageMs <= LAG_WINDOW_MS };
}
