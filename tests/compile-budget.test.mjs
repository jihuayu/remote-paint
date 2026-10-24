import assert from 'node:assert/strict';
import test from 'node:test';
import {compileBudget, JOB_SECONDS, FINALIZATION_SECONDS} from '../ci/compile-budget.mjs';
test('compile budget spends the remaining hosted job time and reserves finalization', () => {
  const start = 1_800_000_000;
  assert.equal(compileBudget(start, start), JOB_SECONDS - FINALIZATION_SECONDS);
  assert.equal(compileBudget(start, start + 20 * 60), 315 * 60);
  assert.equal(compileBudget(start, start + JOB_SECONDS - FINALIZATION_SECONDS), 0);
  assert.equal(compileBudget(start, start + JOB_SECONDS + 1), 0);
});
test('invalid or future timestamps cannot produce an unbounded compile', () => {
  for (const value of [undefined, NaN, Infinity, '1800000000', 0, -1, 1.5]) {
    assert.throws(() => compileBudget(value, 1_800_000_000));
  }
  assert.throws(() => compileBudget(1_800_000_001, 1_800_000_000));
});
