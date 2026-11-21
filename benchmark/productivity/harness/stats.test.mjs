/**
 * The statistics against values computed elsewhere, not against themselves.
 *
 *   node --test stats.test.mjs
 *
 * Reference values: R 4.x, fisher.test(matrix(c(kA, nA-kA, kB, nB-kB), 2))
 * and wilcox.test(a, b, exact = TRUE); the Wilson interval from its closed form.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootDiff, fisherGreater, fisherTwoSided, mannWhitney, median, quantile, wilson } from './stats.mjs';

const near = (x, y, tol, what) => assert.ok(Math.abs(x - y) <= tol, `${what}: ${x} is not ${y} (+/- ${tol})`);

test('Fisher exact, 9 of 10 against 4 of 10', () => {
  near(fisherTwoSided(9, 10, 4, 10), 0.05728, 5e-5, 'two-sided');
  near(fisherGreater(9, 10, 4, 10), 0.02864, 5e-5, 'one-sided');
});

test('Fisher exact, the edges', () => {
  near(fisherTwoSided(5, 10, 5, 10), 1, 1e-9, 'equal shares');
  near(fisherTwoSided(10, 10, 0, 10), 1.083e-5, 5e-8, 'all against none');
  near(fisherTwoSided(0, 10, 0, 10), 1, 1e-9, 'nobody succeeds');
});

test('Mann-Whitney, exact, no ties', () => {
  // wilcox.test(c(1,2,3), c(4,5,6)): W = 0, p = 0.1.
  const r = mannWhitney([1, 2, 3], [4, 5, 6]);
  assert.equal(r.uA, 0);
  near(r.p, 0.1, 1e-9, 'p');
  assert.equal(r.method, 'exact');
  // wilcox.test(1:10, 11:20): p = 1.083e-05.
  near(mannWhitney([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]).p, 1.0825e-5, 1e-8, '10 against 10');
});

test('Mann-Whitney, exact by permutation with ties, as the benchmark will see them', () => {
  // Identical groups: nothing to tell apart.
  near(mannWhitney([21, 21, 21], [21, 21, 21]).p, 1, 1e-9, 'all tied');
  // Most runs defend everything; a few in B do not. Permutation p by hand:
  // a = 21 x5, b = 21,21,19,19,19. Pooled ranks: the three 19s share rank 2,
  // the seven 21s share rank 7. Splits of 5 from 10 with the three 19s all in
  // A's half are as extreme: C(7,2)=21 of C(10,5)=252, both directions 42.
  near(mannWhitney([21, 21, 21, 21, 21], [21, 21, 19, 19, 19]).p, 42 / 252, 1e-9, 'ties');
});

test('Wilson interval, 9 of 10 and 0 of 10', () => {
  const [lo, hi] = wilson(9, 10);
  near(lo, 0.5958, 1e-4, 'lower');
  near(hi, 0.9821, 1e-4, 'upper');
  const [lo0, hi0] = wilson(0, 10);
  near(lo0, 0, 1e-9, 'lower at 0');
  near(hi0, 0.2775, 1e-4, 'upper at 0');
});

test('quantiles and medians interpolate like R type 7', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
});

test('the bootstrap is reproducible and brackets a real difference', () => {
  const a = [100, 102, 98, 101, 99, 103, 97, 100, 101, 99];
  const b = a.map((x) => x * 2);
  const one = bootDiff(a, b, 7);
  const two = bootDiff(a, b, 7);
  assert.deepEqual(one, two, 'the same seed gives the same interval');
  assert.ok(one.diff95[1] < 0, 'the interval excludes zero');
  assert.ok(one.relative95[0] < -0.45 && one.relative95[1] > -0.55, `relative ${one.relative95}`);
});
