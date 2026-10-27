import assert from 'node:assert/strict';
import { analyzeRun } from '../shared/run-performance.mjs';
const node = (a, b, extra = {}) => ({ dependencies: [], status: 'succeeded', startedAt: a, inputReadyAt: a, submittedAt: a, finishedAt: b, snapshotReadyAt: b, outputReadyAt: b, ...extra });
const run = (nodes, extra = {}) => ({ createdAt: 0, finishedAt: 100, status: 'succeeded', order: Object.keys(nodes), nodes, ...extra });
let checks = 0;
function test(name, fn) { fn(); checks++; console.log(`ok ${name}`); }
test('parallel union, work, peak and ratios', () => {
  const r = analyzeRun(run({ a: node(10, 60), b: node(40, 90) }));
  assert.equal(r.modelWallMs, 80); assert.equal(r.modelWorkMs, 100); assert.equal(r.observedPeakModels, 2);
  assert.equal(r.overall.modelRatio, .8); assert.equal(r.overall.overheadRatio, .2);
  assert.equal(r.slowestNode.id, 'a');
  assert.equal(analyzeRun(run({ a: node(0, 50), b: node(50, 100) })).observedPeakModels, 1);
});
const running = run({ a: node(10, undefined, { status: 'running' }) }, { status: 'running', finishedAt: undefined });
test('explicit running clock', () => { const r = analyzeRun(running, { now: 70 }); assert.equal(r.elapsedMs, 70); assert.equal(r.modelWallMs, 60); assert.equal(r.overall.modelRatio, null); });
test('history and partial coverage', () => {
  const r = analyzeRun(run({ old: { startedAt: 10, finishedAt: 80, status: 'succeeded' }, a: node(20, 30) }));
  assert.equal(r.modelWallMs, null); assert.equal(r.knownModelWallMs, 10); assert.equal(r.slowestNode.id, 'old'); assert.equal(r.nodes.old.modelMs, null);
});
test('reversed times', () => { const r = analyzeRun(run({ a: node(20, 10) })); assert.equal(r.modelWallMs, null); assert.equal(r.nodes.a.endToEndMs, null); assert(r.warnings.some(w => w.includes('reversed'))); });
test('real zero', () => { const r = analyzeRun(run({ a: node(0, 0) }, { finishedAt: 0 })); assert.equal(r.elapsedMs, 0); assert.equal(r.modelWallMs, 0); assert.equal(r.modelWorkMs, 0); assert.equal(r.observedPeakModels, 0); assert.equal(r.overall.modelRatio, null); });
test('invalid and absent clocks', () => { for (const now of ['invalid', NaN, Infinity, undefined, '2026-02-30T00:00:00Z']) { const r = analyzeRun(running, { now }); assert.equal(r.elapsedMs, null); assert.equal(r.modelWallMs, null); } });
test('calendar and timestamp formats', () => {
  assert.equal(analyzeRun(run({}, { createdAt: '2026-02-30T00:00:00Z' })).elapsedMs, null);
  assert.equal(analyzeRun(run({}, { createdAt: '2024-02-29T08:00:00+08:00', finishedAt: '2024-02-29T00:00:01Z' })).elapsedMs, 1000);
});
test('empty nodes', () => { const r = analyzeRun(run({})); assert.equal(r.modelWallMs, null); assert.equal(r.observedPeakModels, null); assert.equal(r.slowestNode, null); });
test('failure and cancellation', () => {
  assert.equal(analyzeRun(run({ a: node(10, 30, { status: 'failed' }) })).modelWallMs, 20);
  assert.equal(analyzeRun(run({ a: { status: 'cancelled', startedAt: 10, submittedAt: 20 } }), { now: 1000 }).modelWallMs, null);
});
test('queue and phase separation', () => {
  const r = analyzeRun(run({ a: node(0, 10), b: node(20, 60, { dependencies: ['a'], inputReadyAt: 30, submittedAt: 40, snapshotReadyAt: 70, outputReadyAt: 80 }) }));
  assert.deepEqual(r.nodes.b, { queueMs: 10, preparationMs: 10, submissionWaitMs: 10, modelMs: 20, snapshotMs: 10, barrierMs: 10, endToEndMs: 60, endToEndEndpoint: 'outputReadyAt' });
});
test('immutable and private input', () => {
  const n = Object.freeze({ ...node(10, 20), dependencies: Object.freeze([]), prompt: 'PRIVATE' });
  const input = Object.freeze({ ...run(Object.freeze({ a: n })), order: Object.freeze(['a']), apiKey: 'PRIVATE' });
  const before = JSON.stringify(input); const result = analyzeRun(input);
  assert.equal(JSON.stringify(input), before); assert(!JSON.stringify(result).includes('PRIVATE'));
});
console.log(`${checks} checks passed`);
