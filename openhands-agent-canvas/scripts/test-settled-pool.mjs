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

async function testNotifications() {
  const items = Object.freeze([{}, {}, {}, {}]);
  const gates = items.map(() => Promise.withResolvers());
  const started = items.map(() => Promise.withResolvers());
  const values = items.map(() => ({}));
  const syncError = new Error('sync worker failure with notification');
  const asyncError = new Error('async worker failure with notification');
  const calls = [];
  const completed = [];
  const notices = [];
  const pending = settledPool(items, (item, index) => {
    assert.equal(item, items[index]);
    calls.push(index);
    started[index].resolve();
    if (index === 2) {
      completed.push(index);
      throw syncError;
    }
    return gates[index].promise.then(value => {
      completed.push(index);
      return value;
    }, reason => {
      completed.push(index);
      throw reason;
    });
  }, {
    concurrency: 2,
    onSettled(...args) {
      assert.equal(args.length, 2);
      notices.push(args);
    },
  });

  assert.deepEqual(calls, [0, 1]);
  gates[1].resolve(values[1]);
  await started[3].promise;
  assert.deepEqual(notices.map(([, index]) => index), [1, 2]);
  gates[0].reject(asyncError);
  await nextTurn();
  assert.deepEqual(notices.map(([, index]) => index), [1, 2, 0]);
  gates[3].resolve(values[3]);
  const results = await pending;
  assert.deepEqual(calls, [0, 1, 2, 3], 'workers must run exactly once');
  assert.deepEqual(completed, [1, 2, 0, 3]);
  assert.deepEqual(notices.map(([, index]) => index), completed);
  assert.deepEqual(results, [
    { status: 'rejected', reason: asyncError },
    { status: 'fulfilled', value: values[1] },
    { status: 'rejected', reason: syncError },
    { status: 'fulfilled', value: values[3] },
  ]);
  for (const [result, index] of notices) assert.equal(result, results[index]);
  assert.equal(results[0].reason, asyncError);
  assert.equal(results[2].reason, syncError);
  assert.equal(results[1].value, values[1]);
  assert.equal(results[3].value, values[3]);
}

async function testNotificationBackpressure() {
  const items = [0, 1, 2, 3];
  const gates = items.map(() => Promise.withResolvers());
  const notifications = items.map(() => Promise.withResolvers());
  const started = items.map(() => Promise.withResolvers());
  const calls = [];
  const notices = [];
  let active = 0;
  let peak = 0;
  let finished = false;
  const pending = settledPool(items, (_, index) => {
    calls.push(index);
    peak = Math.max(peak, ++active);
    assert.ok(active <= 2, 'workers and notifications share the concurrency limit');
    started[index].resolve();
    return gates[index].promise;
  }, {
    concurrency: 2,
    onSettled(result, index) {
      assert.equal(result.value, index);
      notices.push(index);
      return notifications[index].promise.then(() => { active--; });
    },
  });
  pending.then(() => { finished = true; }, () => { finished = true; });

  gates[1].resolve(1);
  await nextTurn();
  assert.deepEqual(notices, [1]);
  assert.deepEqual(calls, [0, 1]);
  gates[0].resolve(0);
  await nextTurn();
  assert.deepEqual(notices, [1, 0]);
  assert.deepEqual(calls, [0, 1], 'pending notifications must retain both slots');
  assert.equal(finished, false);
  notifications[1].resolve();
  await started[2].promise;
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(active, 2);
  notifications[0].resolve();
  await started[3].promise;
  assert.deepEqual(calls, items);
  assert.equal(active, 2);
  gates[2].resolve(2);
  gates[3].resolve(3);
  await nextTurn();
  assert.deepEqual(notices, [1, 0, 2, 3]);
  assert.equal(finished, false, 'pool must wait after every worker has finished');
  notifications[2].resolve();
  await nextTurn();
  assert.equal(finished, false, 'pool must wait for the last notification');
  notifications[3].resolve();
  assert.deepEqual(await pending, items.map(value => ({ status: 'fulfilled', value })));
  assert.equal(finished, true);
  assert.equal(active, 0);
  assert.equal(peak, 2);
}

async function testNotificationFailure(mode, firstError) {
  const items = [0, 1, 2, 3, 4];
  const gates = items.map(() => Promise.withResolvers());
  const firstFailure = Promise.withResolvers();
  const laterFailure = Promise.withResolvers();
  const lastNotification = Promise.withResolvers();
  const workerError = new Error('worker failure before notification failure');
  const laterError = new Error('later notification error');
  const calls = [];
  const notices = [];
  let outcome;
  const pending = settledPool(items, (_, index) => {
    calls.push(index);
    return gates[index].promise;
  }, {
    concurrency: 3,
    onSettled(result, index) {
      notices.push([result, index]);
      if (index === 0) return laterFailure.promise;
      if (index === 1) {
        if (mode === 'sync') throw firstError;
        return firstFailure.promise;
      }
      return lastNotification.promise;
    },
  });
  // Observe rejection immediately so both expected and unexpected outcomes are handled.
  const observed = pending.then(
    value => { outcome = { status: 'fulfilled', value }; },
    reason => { outcome = { status: 'rejected', reason }; },
  );
  assert.deepEqual(calls, [0, 1, 2]);
  gates[0].reject(workerError);
  await nextTurn();
  assert.deepEqual(notices, [[{ status: 'rejected', reason: workerError }, 0]]);
  assert.equal(notices[0][0].reason, workerError);
  gates[1].resolve('completed');
  await nextTurn();
  assert.deepEqual(notices.map(([, index]) => index), [0, 1]);
  assert.deepEqual(notices[1][0], { status: 'fulfilled', value: 'completed' });
  assert.equal(outcome, undefined);
  if (mode === 'async') {
    firstFailure.reject(firstError);
    await nextTurn();
  }
  assert.deepEqual(calls, [0, 1, 2], 'notification failure must stop new dispatches');
  assert.equal(outcome, undefined, 'must drain earlier notifications and started workers');
  // The first invoked notification fails later; observation order decides the pool error.
  laterFailure.reject(laterError);
  await nextTurn();
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(outcome, undefined, 'must still wait for the last worker');
  gates[2].resolve('last worker');
  await nextTurn();
  assert.deepEqual(notices.map(([, index]) => index), [0, 1, 2]);
  assert.deepEqual(notices[2][0], { status: 'fulfilled', value: 'last worker' });
  assert.equal(outcome, undefined, 'must notify and drain workers finishing after failure');
  lastNotification.resolve();
  await observed;
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason, firstError, 'retain the first observed error identity');
  assert.deepEqual(calls, [0, 1, 2]);
  assert.deepEqual(notices.map(([, index]) => index), [0, 1, 2]);
}

async function testNotificationCancellation() {
  const before = new AbortController();
  before.abort();
  let callsBefore = 0;
  let noticesBefore = 0;
  assert.deepEqual(await settledPool([0, 1], () => { callsBefore++; }, {
    signal: before.signal,
    onSettled() { noticesBefore++; },
  }), [{ status: 'skipped' }, { status: 'skipped' }]);
  assert.equal(callsBefore, 0);
  assert.equal(noticesBefore, 0);

  const during = new AbortController();
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const notifications = [Promise.withResolvers(), Promise.withResolvers()];
  const calls = [];
  const notices = [];
  let finished = false;
  const pending = settledPool([0, 1, 2, 3], (_, index, signal) => {
    assert.equal(signal, during.signal);
    calls.push(index);
    return gates[index].promise;
  }, {
    concurrency: 2,
    signal: during.signal,
    onSettled(result, index) {
      notices.push([result, index]);
      return notifications[index].promise;
    },
  });
  pending.then(() => { finished = true; }, () => { finished = true; });
  gates[1].resolve('saved');
  await nextTurn();
  assert.deepEqual(notices.map(([, index]) => index), [1]);
  during.abort();
  notifications[1].resolve();
  await nextTurn();
  assert.deepEqual(calls, [0, 1], 'abort during notification must stop later dispatches');
  assert.equal(finished, false);
  const error = new Error('worker failed after abort');
  gates[0].reject(error);
  await nextTurn();
  assert.deepEqual(notices.map(([, index]) => index), [1, 0]);
  assert.equal(finished, false, 'abort must still drain notifications');
  notifications[0].resolve();
  const results = await pending;
  assert.deepEqual(results, [
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value: 'saved' },
    { status: 'skipped' },
    { status: 'skipped' },
  ]);
  assert.equal(results[0].reason, error);
  assert.deepEqual(calls, [0, 1]);
  assert.deepEqual(notices.map(([, index]) => index), [1, 0]);
  for (const [result, index] of notices) assert.equal(result, results[index]);
  assert.equal(finished, true);
}

async function testNotificationValidation() {
  let calls = 0;
  let notices = 0;
  const worker = () => { calls++; };
  const before = new AbortController();
  before.abort();
  for (const onSettled of [null, false, true, 0, 1, 'callback', {}, [], Promise.resolve(), Symbol()]) {
    await assert.rejects(settledPool([1], worker, { onSettled }), TypeError);
    await assert.rejects(settledPool([], worker, { onSettled }), TypeError);
    await assert.rejects(settledPool([1], worker, { onSettled, signal: before.signal }), TypeError);
  }
  assert.deepEqual(await settledPool([], worker, { onSettled() { notices++; } }), []);
  assert.equal(calls, 0, 'invalid notifications must be rejected before any worker starts');
  assert.equal(notices, 0);
  assert.deepEqual(await settledPool([1], worker, { onSettled: undefined }), [
    { status: 'fulfilled', value: undefined },
  ]);
  assert.equal(calls, 1);
}

for (const concurrency of [1, 2, undefined, 32]) await testConcurrency(concurrency);
await testFailures();
await testCancellation();
await testValidationAndEmpty();
await testNotifications();
await testNotificationBackpressure();
await testNotificationFailure('sync', new Error('first synchronous notification error'));
await testNotificationFailure('async', new Error('first asynchronous notification error'));
await testNotificationFailure('sync', undefined);
await testNotificationCancellation();
await testNotificationValidation();
console.log('settled-pool: all tests passed');
