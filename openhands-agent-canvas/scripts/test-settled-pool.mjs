import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { settledPool } from '../shared/settled-pool.mjs';

async function testConcurrency(concurrency) {
  const limit = concurrency ?? 4;
  const items = Object.freeze(Array.from({ length: limit + 2 }, (_, id) => Object.freeze({ id })));
  const original = items.slice();
  const gates = items.map(() => Promise.withResolvers());
  const started = items.map(() => Promise.withResolvers());
  const values = items.map(({ id }) => ({ result: id }));
  const calls = [];
  let active = 0;
  let peak = 0;
  const worker = (item, index, signal) => {
    assert.equal(item, items[index]);
    assert.equal(signal, undefined);
    calls.push(index);
    peak = Math.max(peak, ++active);
    assert.ok(active <= limit);
    started[index].resolve();
    return gates[index].promise.finally(() => { active--; });
  };
  const pending = concurrency === undefined
    ? settledPool(items, worker)
    : settledPool(items, worker, { concurrency });

  assert.deepEqual(calls, Array.from({ length: limit }, (_, index) => index));
  // Finish out of order while the first slot stays occupied (when limit > 1).
  const firstFinished = limit > 1 ? 1 : 0;
  gates[firstFinished].resolve(values[firstFinished]);
  await started[limit].promise;
  assert.deepEqual(calls, Array.from({ length: limit + 1 }, (_, index) => index));
  assert.equal(active, limit);
  gates[limit].resolve(values[limit]);
  await started[limit + 1].promise;
  assert.deepEqual(calls, items.map((_, index) => index));
  assert.equal(active, limit);

  gates.forEach((gate, index) => gate.resolve(values[index]));
  const results = await pending;
  assert.deepEqual(results, values.map(value => ({ status: 'fulfilled', value })));
  results.forEach((result, index) => assert.equal(result.value, values[index]));
  assert.equal(peak, limit);
  assert.equal(active, 0);
  assert.deepEqual(items, original);
}

async function testFailures() {
  const syncError = new Error('sync failure');
  const asyncError = new Error('async failure');
  const failed = Promise.withResolvers();
  const succeeded = Promise.withResolvers();
  const fourthStarted = Promise.withResolvers();
  const syncValue = { kind: 'sync' };
  const asyncValue = { kind: 'async' };
  const calls = [];
  const pending = settledPool([0, 1, 2, 3, 4, 5], (_, index) => {
    calls.push(index);
    switch (index) {
      case 0: throw syncError;
      case 1: return failed.promise;
      case 2: return syncValue;
      case 3:
        fourthStarted.resolve();
        return succeeded.promise;
      case 4: throw undefined;
      case 5: return undefined;
    }
  }, { concurrency: 1 });

  assert.deepEqual(calls, [0, 1]);
  failed.reject(asyncError);
  await fourthStarted.promise;
  assert.deepEqual(calls, [0, 1, 2, 3]);
  succeeded.resolve(asyncValue);
  const results = await pending;
  assert.deepEqual(calls, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(results, [
    { status: 'rejected', reason: syncError },
    { status: 'rejected', reason: asyncError },
    { status: 'fulfilled', value: syncValue },
    { status: 'fulfilled', value: asyncValue },
    { status: 'rejected', reason: undefined },
    { status: 'fulfilled', value: undefined },
  ]);
  assert.equal(results[0].reason, syncError);
  assert.equal(results[1].reason, asyncError);
  assert.equal(results[2].value, syncValue);
  assert.equal(results[3].value, asyncValue);
}

async function testCancellation() {
  const before = new AbortController();
  before.abort();
  let callsBefore = 0;
  assert.deepEqual(await settledPool([1, 2], () => { callsBefore++; }, {
    signal: before.signal,
  }), [{ status: 'skipped' }, { status: 'skipped' }]);
  assert.equal(callsBefore, 0);

  const during = new AbortController();
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const calls = [];
  let finished = false;
  const pending = settledPool([0, 1, 2, 3, 4], (_, index, signal) => {
    assert.equal(signal, during.signal);
    calls.push(index);
    return gates[index].promise;
  }, { concurrency: 2, signal: during.signal });
  pending.then(() => { finished = true; });
  assert.deepEqual(calls, [0, 1]);
  during.abort();
  // Give an incorrect early-return implementation time to settle.
  await nextTurn();
  assert.equal(finished, false);
  const value = { saved: true };
  gates[1].resolve(value);
  await nextTurn();
  assert.equal(finished, false, 'must wait for every started worker');
  assert.deepEqual(calls, [0, 1]);
  const error = new Error('started worker failed after abort');
  gates[0].reject(error);
  const results = await pending;
  assert.equal(finished, true);
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(results, [
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value },
    { status: 'skipped' },
    { status: 'skipped' },
    { status: 'skipped' },
  ]);
  assert.equal(results[0].reason, error);
  assert.equal(results[1].value, value);

  const inside = new AbortController();
  const insideCalls = [];
  assert.deepEqual(await settledPool([0, 1, 2], (_, index) => {
    insideCalls.push(index);
    inside.abort();
    return 'completed';
  }, { concurrency: 3, signal: inside.signal }), [
    { status: 'fulfilled', value: 'completed' },
    { status: 'skipped' },
    { status: 'skipped' },
  ]);
  assert.deepEqual(insideCalls, [0]);
}

async function testValidationAndEmpty() {
  let calls = 0;
  const worker = () => { calls++; };
  assert.deepEqual(await settledPool(Object.freeze([]), worker), []);
  const controller = new AbortController();
  assert.deepEqual(await settledPool([], worker, { signal: controller.signal }), []);
  for (const items of [null, undefined, {}, 'items', new Set([1]), { 0: 1, length: 1 }]) {
    await assert.rejects(settledPool(items, worker), TypeError);
  }
  for (const invalidWorker of [undefined, null, {}, 1, 'worker']) {
    await assert.rejects(settledPool([1], invalidWorker), TypeError);
    await assert.rejects(settledPool([], invalidWorker), TypeError);
  }
  for (const concurrency of [0, -1, 33, 1.5, NaN, Infinity, -Infinity, '2', null, true, 2n]) {
    await assert.rejects(settledPool([1], worker, { concurrency }), RangeError);
    await assert.rejects(settledPool([], worker, { concurrency }), RangeError);
  }
  for (const signal of [null, false, 1, 'signal', controller,
    { aborted: false, addEventListener() {}, removeEventListener() {} },
    Object.create(AbortSignal.prototype)]) {
    await assert.rejects(settledPool([1], worker, { signal }), TypeError);
    await assert.rejects(settledPool([], worker, { signal }), TypeError);
  }
  controller.abort();
  await assert.rejects(settledPool([1], worker, {
    concurrency: 0, signal: controller.signal,
  }), RangeError);
  await assert.rejects(settledPool([1], worker, null), TypeError);
  assert.equal(calls, 0, 'empty and invalid inputs must not start work');
}

for (const concurrency of [1, 2, undefined, 32]) await testConcurrency(concurrency);
await testFailures();
await testCancellation();
await testValidationAndEmpty();
console.log('settled-pool: all tests passed');
