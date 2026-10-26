import assert from 'node:assert/strict';
import { analyzeRun } from '../shared/run-performance.mjs';
const node = (start, end) => ({ startedAt: start, inputReadyAt: start, submittedAt: start,
  finishedAt: end, snapshotReadyAt: end, outputReadyAt: end, status: 'completed' });
const parallel = { createdAt: 0, finishedAt: 30, status: 'completed', order: ['a', 'b'],
  nodes: { a: node(0, 20), b: node(10, 30) } };
const before = structuredClone(parallel);
Object.freeze(parallel.nodes.a); Object.freeze(parallel.nodes.b);
Object.freeze(parallel.nodes); Object.freeze(parallel);
const p = analyzeRun(parallel);
assert.equal(p.modelWallMs, 30); assert.equal(p.modelWorkMs, 40);
assert.equal(p.observedPeakModels, 2); assert.equal(p.overall.modelRatio, 1);
assert.equal(p.slowestNode.id, 'a'); assert.deepEqual(parallel, before);
const running = { createdAt: 0, status: 'running', nodes: { a: {
  startedAt: 2, inputReadyAt: 5, submittedAt: 10, status: 'running' } } };
const r = analyzeRun(running, { now: 25 });
assert.equal(r.elapsedMs, 25); assert.equal(r.nodes.a.modelMs, 15);
assert.equal(r.nodes.a.preparationMs, 3); assert.equal(r.nodes.a.submissionWaitMs, 5);
assert.equal(r.nodes.a.endToEndMs, 23); assert.equal(r.overall, null);
assert.equal(r.nodes.a.modelProvisional, true);
assert.equal(analyzeRun(running).modelWallMs, null);
const invalid = analyzeRun(running, { now: 'not-a-date' });
assert.equal(invalid.elapsedMs, null); assert.equal(invalid.modelWallMs, null);
assert.ok(invalid.warnings.some(w => w.startsWith('now:')));
const invalidDate = analyzeRun({ createdAt: '2026-02-30T00:00:00.000Z',
  finishedAt: '2026-03-03T00:00:00.000Z', status: 'succeeded', nodes: {} });
assert.equal(invalidDate.elapsedMs, null);
assert.ok(invalidDate.warnings.includes('run.createdAt: invalid time'));
for (const date of ['2026-02-29', '1900-02-29', '2026-04-31']) {
  const result = analyzeRun(running, { now: `${date}T00:00:00.000Z` });
  assert.equal(result.elapsedMs, null);
  assert.equal(result.nodes.a.modelMs, null);
  assert.ok(result.warnings.includes('now: invalid time'));
}
for (const date of ['2024-02-29', '2000-02-29', '2026-02-28']) {
  const timestamp = `${date}T00:00:00.000+08:00`;
  assert.equal(analyzeRun({ createdAt: timestamp, finishedAt: timestamp, nodes: {} }).elapsedMs, 0);
}
for (const status of ['completed', 'failed', 'cancelled']) {
  const h = analyzeRun({ createdAt: 0, finishedAt: 20, nodes: {
    old: { startedAt: 2, finishedAt: 15, status } } });
  assert.equal(h.nodes.old.modelMs, null); assert.equal(h.modelWallMs, null);
  assert.equal(h.slowestNode.endToEndMs, 13); assert.equal(h.overall, null);
}
const reversed = analyzeRun({ createdAt: 20, finishedAt: 10, nodes: { a: node(10, 5) } });
assert.equal(reversed.elapsedMs, null); assert.equal(reversed.nodes.a.modelMs, null);
assert.equal(reversed.slowestNode, null); assert.ok(reversed.warnings.length);
const zero = analyzeRun({ createdAt: 0, finishedAt: 0, nodes: { a: node(0, 0) } });
assert.equal(zero.elapsedMs, 0); assert.equal(zero.modelWallMs, 0);
assert.equal(zero.nodes.a.modelMs, 0); assert.equal(zero.overall, null);
const empty = analyzeRun({ createdAt: 0, finishedAt: 10, nodes: {} });
assert.equal(empty.modelWallMs, null); assert.equal(empty.observedPeakModels, null);
assert.equal(empty.slowestNode, null); assert.equal(empty.overall, null);
const adjacent = analyzeRun({ createdAt: 0, finishedAt: 20, nodes: { a: node(0, 10), b: node(10, 20) } });
assert.equal(adjacent.observedPeakModels, 1);
const partial = analyzeRun({ ...parallel, nodes: { a: node(0, 20), b: { startedAt: 0 } } });
assert.equal(partial.modelCoverage, 'partial'); assert.equal(partial.modelWallMs, 20);
assert.equal(partial.overall, null);
const failed = analyzeRun({ createdAt: 0, finishedAt: 20, nodes: { a: { ...node(1, 12), status: 'failed' } } });
assert.equal(failed.modelWorkMs, 11);
const outside = analyzeRun({ createdAt: 5, finishedAt: 10, nodes: { a: node(0, 20) } });
assert.equal(outside.overall, null);
const badEnd = analyzeRun({ createdAt: 0, finishedAt: 20, nodes: { a: { ...node(0, 10), outputReadyAt: 'bad' } } });
assert.equal(badEnd.nodes.a.endToEndMs, null);
assert.doesNotThrow(() => JSON.stringify(p));
console.log('run-performance: all assertions passed');
