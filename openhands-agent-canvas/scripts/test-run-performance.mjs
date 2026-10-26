import assert from 'node:assert/strict';
import { analyzeRun } from '../shared/run-performance.mjs';

const node = (a, b, extra = {}) => ({ dependencies: [], startedAt: a, inputReadyAt: a,
  submittedAt: a, finishedAt: b, snapshotReadyAt: b, outputReadyAt: b,
  status: 'completed', ...extra });
const run = nodes => ({ createdAt: 0, finishedAt: 100, status: 'completed', nodes });
const parallel = analyzeRun(run({ a: node(10, 60), b: node(40, 90) }));
assert.equal(parallel.modelWallMs, 80);
assert.equal(parallel.modelWorkMs, 100);
assert.equal(parallel.observedPeakModels, 2);
assert.equal(parallel.overall.modelRatio, 0.8);
assert.equal(parallel.overall.overheadRatio, 0.2);
assert.equal(parallel.nodes[0].queueMs, 10);
assert.equal(parallel.slowestNode.id, 'a');
const touching = analyzeRun(run({ a: node(0, 50), b: node(50, 100) }));
assert.equal(touching.observedPeakModels, 1);

const running = { createdAt: 0, status: 'running', nodes: { a: {
  dependencies: [], status: 'running', startedAt: 10, inputReadyAt: 20, submittedAt: 30 } } };
const live = analyzeRun(running, { now: 80 });
assert.equal(live.elapsedMs, 80);
assert.equal(live.nodes[0].preparationMs, 10);
assert.equal(live.nodes[0].submissionWaitMs, 10);
assert.equal(live.nodes[0].modelMs, 50);
assert.equal(live.modelWallMs, 50);
assert.equal(live.nodes[0].snapshotMs, null);
assert.equal(live.nodes[0].endToEndMs, 70);
assert.equal(live.overall.modelRatio, null);
const saving = analyzeRun({ ...running, nodes: { a: { ...running.nodes.a,
  status: 'succeeded', modelCompleted: true, outputReady: false,
  finishedAt: 50, snapshotReadyAt: 55 } } }, { now: 80 });
assert.equal(saving.nodes[0].barrierMs, 25);
assert.equal(saving.nodes[0].endToEndMs, 70);
assert.equal(saving.nodes[0].endToEndComplete, false);
const reconnecting = analyzeRun({ ...running, status: 'reconnecting', nodes: {
  a: { ...running.nodes.a, status: 'reconnecting' } } }, { now: 80 });
assert.equal(reconnecting.modelWallMs, 50);
assert.equal(analyzeRun(running).elapsedMs, null);
for (const now of ['bad', NaN, Infinity, '2026-02-30T00:00:00Z']) {
  const bad = analyzeRun(running, { now });
  assert.equal(bad.elapsedMs, null);
  assert.equal(bad.modelWallMs, null);
  assert.ok(bad.warnings.some(w => w.field === 'now' && w.code === 'invalid_time'));
}
assert.equal(analyzeRun(running, { now: 25 }).nodes[0].endToEndMs, null);
const history = analyzeRun(run({ a: { startedAt: 10, finishedAt: 80, status: 'completed' } }));
assert.equal(history.nodes[0].modelMs, null);
assert.equal(history.modelWallMs, null);
assert.equal(history.modelWorkMs, null);
assert.equal(history.observedPeakModels, null);
assert.equal(history.overall.modelRatio, null);
assert.equal(history.slowestNode.endToEndMs, 70);
assert.equal(history.slowestNode.complete, false);
assert.ok(history.warnings.length > 0);
const reversed = analyzeRun(run({ a: node(60, 20) }));
assert.equal(reversed.modelWallMs, null);
assert.equal(reversed.nodes[0].endToEndMs, null);
assert.ok(reversed.warnings.some(w => w.code === 'invalid_interval'));
assert.equal(analyzeRun({ ...run({}), createdAt: 200 }).elapsedMs, null);
const zero = analyzeRun({ ...run({ a: node(0, 0) }), finishedAt: 0 });
assert.equal(zero.elapsedMs, 0);
assert.equal(zero.modelWallMs, 0);
assert.equal(zero.modelWorkMs, 0);
assert.equal(zero.nodes[0].endToEndMs, 0);
assert.equal(zero.observedPeakModels, 0);
assert.equal(zero.overall.modelRatio, null);
for (const status of ['failed', 'cancelled']) {
  const failed = analyzeRun(run({ a: { startedAt: 10, submittedAt: 20, finishedAt: 60, status } }));
  assert.equal(failed.nodes[0].modelMs, 40);
  assert.equal(failed.nodes[0].endToEndMs, 50);
}
const half = analyzeRun(run({ a: { submittedAt: 10, status: 'completed' }, b: node(20, 40) }));
assert.equal(half.nodes[0].modelMs, null);
assert.equal(half.modelWallMs, 20);
assert.equal(half.modelIntervalsComplete, false);
assert.equal(half.overall.modelRatio, null);
const empty = analyzeRun(run({}));
assert.deepEqual([empty.modelWallMs, empty.modelWorkMs, empty.observedPeakModels], [0, 0, 0]);
assert.equal(empty.slowestNode, null);
assert.equal(empty.overall.modelRatio, null);
const deps = analyzeRun(run({ a: node(0, 20), b: node(30, 80, { dependencies: ['a'] }) }));
assert.equal(deps.nodes[1].queueMs, 10);
const slow = analyzeRun(run({ a: node(10, 30, { outputReadyAt: 95 }), b: node(20, 80) }));
assert.equal(slow.slowestNode.id, 'a');
assert.equal(slow.slowestNode.endToEndMs, 85);
const invalidEndpoint = analyzeRun({ ...running, nodes: { a: { ...running.nodes.a, finishedAt: 'bad' } } }, { now: 80 });
assert.equal(invalidEndpoint.modelWallMs, null);
const iso = analyzeRun({ createdAt: '2026-10-27T00:00:00Z', finishedAt: '2026-10-27T00:00:01+00:00', nodes: {} });
assert.equal(iso.elapsedMs, 1000);
const input = { ...run({ a: node(10, 20) }), order: ['a'], apiKey: 'SECRET', prompt: 'PRIVATE', files: ['CONTENT'] };
const original = structuredClone(input);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } }
freeze(input);
const result = analyzeRun(input);
assert.deepEqual(input, original);
assert.equal(/SECRET|PRIVATE|CONTENT/.test(JSON.stringify(result)), false);
assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
console.log('run-performance: all assertions passed');
