/**
 * THE PREREGISTERED DECISION RULES, apart from report.mjs so that they are
 * tested (rules.test.mjs). PREREG.md states them in prose; these are the same
 * rules in code, and the thresholds are here and nowhere else.
 */
export const CONFIRM = 0.3; // at least 30 % better
export const REFUTE = 0.1; // the whole interval above -10 %

/**
 * "Less is better" (H3, H5, and each half of H6). Confirmed: at least 30 %
 * lower, and the interval of the difference excludes zero. Refuted: the whole
 * interval of the relative difference lies above -10 %.
 */
export function lessIsBetter(rel, diff95, relative95) {
  if (rel === null || rel === undefined) return 'not computable';
  if (rel <= -CONFIRM && diff95 && diff95[1] < 0) return 'confirmed';
  if (relative95 && relative95[0] > -REFUTE) return 'refuted';
  return 'inconclusive';
}

/** H1: A's share higher and two-sided Fisher p < 0.05; refuted if not higher. */
export function h1({ kA, nA, kB, nB, p }) {
  if (!nA || !nB) return 'not computable';
  if (!(kA / nA > kB / nB)) return 'refuted';
  return p < 0.05 ? 'confirmed' : 'inconclusive';
}

/** H2: A's mean defended higher and two-sided Mann-Whitney p < 0.05; refuted if not higher. */
export function h2({ meanA, meanB, p }) {
  if (meanA === null || meanB === null || p === null || p === undefined) return 'not computable';
  if (meanA <= meanB) return 'refuted';
  return p < 0.05 ? 'confirmed' : 'inconclusive';
}

/** H4: as H3, on the bootstrap interval of the relative cost per correct implementation. */
export function h4(rel, relative95) {
  if (rel === null || rel === undefined || !relative95) return 'not computable';
  if (rel <= -CONFIRM && relative95[1] < 0) return 'confirmed';
  if (relative95[0] > -REFUTE) return 'refuted';
  return 'inconclusive';
}

/** H6: confirmed only if tokens and time both are; refuted if either is. */
export function h6(tokens, time) {
  const v = [tokens, time];
  if (v.includes('not computable')) return 'not computable';
  if (v.includes('refuted')) return 'refuted';
  return v.every((x) => x === 'confirmed') ? 'confirmed' : 'inconclusive';
}
