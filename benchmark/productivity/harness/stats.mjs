/**
 * The statistics of report.mjs, kept apart so that stats.test.mjs can check
 * them against values computed elsewhere (R's fisher.test and wilcox.test,
 * the Wilson interval's closed form) rather than against themselves.
 */
const BOOT = 10_000;


export const sorted = (xs) => [...xs].sort((a, b) => a - b);
export function quantile(xs, q) {
  const s = sorted(xs);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
export const median = (xs) => quantile(xs, 0.5);
export const iqr = (xs) => (xs.length ? [quantile(xs, 0.25), quantile(xs, 0.75)] : null);

/** Wilson score interval for k successes in n, 95 %. */
export function wilson(k, n) {
  if (!n) return null;
  const z = 1.959964;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

/** One-sided Fisher exact test: P(A has at least kA successes) under no difference. */
export function fisherGreater(kA, nA, kB, nB) {
  const lf = (n) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const K = kA + kB;
  const N = nA + nB;
  const p = (x) => Math.exp(lf(K) + lf(N - K) + lf(nA) + lf(nB) - lf(x) - lf(K - x) - lf(nA - x) - lf(nB - K + x) - lf(N));
  let sum = 0;
  for (let x = kA; x <= Math.min(K, nA); x++) if (nB - K + x >= 0) sum += p(x);
  return Math.min(1, sum);
}

/** Two-sided Fisher exact test: the probability of tables at most as likely as the observed one. */
export function fisherTwoSided(kA, nA, kB, nB) {
  const lf = (n) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  };
  const K = kA + kB;
  const N = nA + nB;
  const p = (x) => Math.exp(lf(K) + lf(N - K) + lf(nA) + lf(nB) - lf(x) - lf(K - x) - lf(nA - x) - lf(nB - K + x) - lf(N));
  const lo = Math.max(0, K - nB);
  const hi = Math.min(K, nA);
  const observed = p(kA);
  let sum = 0;
  for (let x = lo; x <= hi; x++) {
    const px = p(x);
    if (px <= observed * (1 + 1e-9)) sum += px;
  }
  return Math.min(1, sum);
}

/**
 * Two-sided Mann-Whitney test, exact by permutation of the pooled ranks (with
 * midranks for ties) when there are at most 200 000 ways to split the groups,
 * and by the normal approximation with the tie correction otherwise.
 */
export function mannWhitney(a, b) {
  const pooled = [...a.map((v) => ({ v, g: 0 })), ...b.map((v) => ({ v, g: 1 }))].sort((x, y) => x.v - y.v);
  const ranks = new Array(pooled.length);
  for (let i = 0; i < pooled.length;) {
    let j = i;
    while (j + 1 < pooled.length && pooled[j + 1].v === pooled[i].v) j++;
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1;
    i = j + 1;
  }
  const nA = a.length;
  const nB = b.length;
  const rA = pooled.reduce((s, x, i) => s + (x.g === 0 ? ranks[i] : 0), 0);
  const uA = rA - (nA * (nA + 1)) / 2;
  const mean = (nA * nB) / 2;
  const obs = Math.abs(uA - mean);
  const choose = (n, k) => {
    let c = 1;
    for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
    return c;
  };
  if (nA && nB && choose(nA + nB, nA) <= 200_000) {
    let count = 0;
    let total = 0;
    const pick = (start, left, sum) => {
      if (left === 0) {
        total++;
        if (Math.abs(sum - (nA * (nA + 1)) / 2 - mean) >= obs - 1e-9) count++;
        return;
      }
      for (let i = start; i <= ranks.length - left; i++) pick(i + 1, left - 1, sum + ranks[i]);
    };
    pick(0, nA, 0);
    return { uA, p: count / total, method: 'exact' };
  }
  const N = nA + nB;
  const ties = {};
  for (const r of ranks) ties[r] = (ties[r] ?? 0) + 1;
  const tieTerm = Object.values(ties).reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = ((nA * nB) / 12) * (N + 1 - tieTerm / (N * (N - 1)));
  if (variance <= 0) return { uA, p: 1, method: 'normal' };
  const z = obs / Math.sqrt(variance);
  // Two-sided normal tail.
  const phi = (x) => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp((-2 * x * x) / Math.PI)));
  return { uA, p: Math.min(1, 2 * (1 - phi(z))), method: 'normal' };
}

// mulberry32, seeded, so the intervals are the same on every machine.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bootstrap 95 % interval of median(A) - median(B), and of its ratio to median(B). */
export function bootDiff(a, b, seed = 1) {
  if (a.length < 2 || b.length < 2) return null;
  const r = rng(seed);
  const pick = (xs) => Array.from(xs, () => xs[Math.floor(r() * xs.length)]);
  const diffs = [];
  const rel = [];
  for (let i = 0; i < BOOT; i++) {
    const ma = median(pick(a));
    const mb = median(pick(b));
    diffs.push(ma - mb);
    if (mb) rel.push((ma - mb) / mb);
  }
  return { diff95: [quantile(diffs, 0.025), quantile(diffs, 0.975)], relative95: [quantile(rel, 0.025), quantile(rel, 0.975)] };
}

