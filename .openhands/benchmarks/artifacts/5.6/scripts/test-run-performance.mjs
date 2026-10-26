import assert from 'node:assert/strict';
import { analyzeRun } from '../shared/run-performance.mjs';

const node = (start, end, extra = {}) => ({
  dependencies: [], status: 'completed', startedAt: start, inputReadyAt: start,
  submittedAt: start, finishedAt: end, snapshotReadyAt: end, outputReadyAt: end,
  ...extra,
});
const run = (nodes, extra = {}) => ({ createdAt: 0, finishedAt: 100, status: 'completed', nodes, ...extra });
const warning = (result, code) => result.warnings.some(item => item.code === code);

// Union, accumulated work, and peak have distinct meanings.
{
  const result = analyzeRun(run({ a: node(10, 60), b: node(40, 90) }));
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.elapsedMs, 100);
  assert.equal(result.modelWallMs, 80);
  assert.equal(result.modelWorkMs, 100);
  assert.equal(result.observedPeakModels, 2);
  assert.deepEqual(result.overall, { modelRatio: 0.8, overheadRatio: 0.2, nonModelWallMs: 20 });
  assert.deepEqual(result.slowestNode.ids, ['a', 'b']);
  assert.equal(result.slowestNode.complete, true);
}

// Half-open intervals and zero-length intervals do not create artificial peaks.
{
  const result = analyzeRun(run({ a: node(0, 50), b: node(50, 100), z: node(50, 50) }));
  assert.equal(result.modelWallMs, 100);
  assert.equal(result.modelWorkMs, 100);
  assert.equal(result.observedPeakModels, 1);
  assert.equal(result.nodes[2].modelMs, 0);
  const zero = analyzeRun(run({ z: node(0, 0) }, { finishedAt: 0 }));
  assert.equal(zero.elapsedMs, 0);
  assert.equal(zero.modelWorkMs, 0);
  assert.equal(zero.observedPeakModels, 0);
  assert.equal(zero.overall, null);
}

{
  const active = run({ a: {
    dependencies: [], status: 'running', startedAt: 5, inputReadyAt: 10, submittedAt: 20,
  } }, { status: 'running', finishedAt: undefined });
  const result = analyzeRun(active, { now: 70 });
  assert.equal(result.elapsedMs, 70);
  assert.equal(result.nodes[0].preparationMs, 5);
  assert.equal(result.nodes[0].submissionWaitMs, 10);
  assert.equal(result.nodes[0].modelMs, 50);
  assert.equal(result.nodes[0].snapshotMs, null);
  assert.equal(result.nodes[0].endToEndMs, 65);
  assert.equal(result.nodes[0].endToEndEnd, 'now');
  assert.equal(result.nodes[0].endToEndComplete, false);
  assert.equal(result.modelWallMs, 50);
  assert.equal(result.overall, null);
  for (const now of [undefined, NaN, Infinity, 'tomorrow', '2026-02-30T00:00:00.000Z', new Date(70)]) {
    const invalid = analyzeRun(active, { now });
    assert.equal(invalid.elapsedMs, null);
    assert.equal(invalid.modelWallMs, null);
    assert.equal(invalid.nodes[0].modelMs, null);
    assert.equal(invalid.nodes[0].preparationMs, 5);
    assert.ok(warning(invalid, 'now_required'));
  }
  const backwards = analyzeRun(active, { now: 15 });
  assert.equal(backwards.nodes[0].modelMs, null);
  assert.ok(warning(backwards, 'reversed_time'));
  const preparing = analyzeRun(run({ a: { dependencies: [], status: 'running', startedAt: 5 } },
    { status: 'running', finishedAt: undefined }), { now: 20 });
  assert.equal(preparing.nodes[0].preparationMs, 15);
  assert.equal(preparing.modelWallMs, null);
}

// Historical start means preparation, and a model finish is not a bucket finish.
{
  const result = analyzeRun(run({ old: { startedAt: 10, finishedAt: 80, status: 'completed' } }));
  assert.equal(result.nodes[0].endToEndMs, 70);
  assert.equal(result.nodes[0].endToEndEnd, 'finishedAt');
  assert.equal(result.nodes[0].endToEndComplete, false);
  assert.equal(result.nodes[0].modelMs, null);
  assert.equal(result.modelWallMs, null);
  assert.equal(result.observedPeakModels, null);
  assert.equal(result.slowestNode.complete, false);
  assert.equal(result.overall, null);
  assert.ok(warning(result, 'missing_time'));
  const partial = analyzeRun(run({ old: { startedAt: 0, status: 'completed' }, good: node(10, 30) }));
  assert.equal(partial.modelWallMs, 20);
  assert.equal(partial.modelCoverage.kind, 'observed_lower_bound');
  assert.equal(partial.modelCoverage.knownIntervals, 1);
  assert.equal(partial.slowestNode.candidateCount, 1);
}

{
  const reversed = analyzeRun(run({ a: node(50, 20) }));
  assert.equal(reversed.nodes[0].modelMs, null);
  assert.equal(reversed.nodes[0].endToEndMs, null);
  assert.equal(reversed.modelWallMs, null);
  assert.equal(reversed.overall, null);
  assert.ok(warning(reversed, 'stage_order'));
  const cross = analyzeRun(run({ a: node(0, 50, { inputReadyAt: 40, submittedAt: 30 }) }));
  assert.equal(cross.nodes[0].modelMs, 20);
  assert.equal(cross.nodes[0].submissionWaitMs, null);
  assert.equal(cross.modelCoverage.complete, false);
  assert.equal(cross.overall, null);
  const invalid = analyzeRun(run({ a: node(0, 10, { submittedAt: 'secret-invalid-value' }) }));
  assert.equal(invalid.nodes[0].modelMs, null);
  assert.ok(warning(invalid, 'invalid_time'));
  assert.ok(!JSON.stringify(invalid).includes('secret-invalid-value'));
}

// Terminal failure/cancellation preserves closed intervals and never extends now.
for (const status of ['failed', 'cancelled', 'canceled']) {
  const closed = analyzeRun(run({ a: node(10, 30, { status, outputReadyAt: undefined }) }, { status }), { now: 1000 });
  assert.equal(closed.modelWallMs, 20);
  assert.equal(closed.nodes[0].endToEndMs, 20);
  assert.equal(closed.nodes[0].outputBarrierMs, null);
  assert.equal(closed.overall, null);
  const open = analyzeRun(run({ a: { dependencies: [], status, startedAt: 10, submittedAt: 20 } }, { status }), { now: 1000 });
  assert.equal(open.modelWallMs, null);
  assert.equal(open.nodes[0].modelMs, null);
}

// Later evidence forbids filling an earlier gap with now.
{
  const result = analyzeRun(run({ a: node(0, 40, {
    status: 'running', finishedAt: undefined, outputReadyAt: undefined,
  }) }, { status: 'running', finishedAt: undefined }), { now: 80 });
  assert.equal(result.nodes[0].modelMs, null);
  assert.equal(result.nodes[0].outputBarrierMs, 40);
  assert.equal(result.overall, null);
}

// Slowest uses observed end-to-end spans, not model work.
{
  const result = analyzeRun(run({
    a: node(0, 20, { submittedAt: 10, snapshotReadyAt: 80, outputReadyAt: 90 }),
    b: node(20, 70),
  }));
  assert.deepEqual(result.slowestNode.ids, ['a']);
  assert.equal(result.slowestNode.endToEndMs, 90);
}

{
  const empty = analyzeRun(run({}));
  assert.equal(empty.modelWallMs, 0);
  assert.equal(empty.modelWorkMs, 0);
  assert.equal(empty.observedPeakModels, 0);
  assert.equal(empty.modelCoverage.kind, 'complete');
  assert.equal(empty.slowestNode, null);
  assert.equal(empty.overall.modelRatio, 0);
  const missing = analyzeRun({ createdAt: 0, finishedAt: 100, status: 'completed' });
  assert.equal(missing.modelWallMs, null);
  assert.equal(missing.overall, null);
  const order = analyzeRun(run({ a: node(0, 10), b: node(20, 30) }, { order: ['a'] }));
  assert.equal(order.nodes.length, 2);
  assert.equal(order.structureComplete, false);
  assert.equal(order.overall, null);
  const dependency = analyzeRun(run({ a: node(0, 10, { dependencies: ['missing'] }) }));
  assert.ok(warning(dependency, 'invalid_dependencies'));
  assert.equal(dependency.overall, null);
  const ready = analyzeRun(run({ a: node(0, 20), b: node(10, 40, { inputReadyAt: 25, submittedAt: 30, dependencies: ['a'] }) }));
  assert.equal(ready.nodes[1].dependencyReadinessWaitMs, 10);
  const conflict = analyzeRun(run({ a: node(0, 30), b: node(10, 40, { inputReadyAt: 20, dependencies: ['a'] }) }));
  assert.ok(warning(conflict, 'dependency_order'));
  assert.equal(conflict.overall, null);
  const outside = analyzeRun(run({ a: node(0, 110) }));
  assert.equal(outside.overall, null);
  assert.ok(outside.overallUnavailableReasons.includes('node_boundary_unknown_or_outside_run'));
}

// Strict formats, immutable input, and a JSON-only whitelist.
{
  const iso = analyzeRun(run({ a: node('1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.010Z') }));
  assert.equal(iso.modelWallMs, 10);
  for (const value of ['', false, '10', '2026-10-27', 1.5, Number.MAX_SAFE_INTEGER]) {
    assert.equal(analyzeRun(run({ a: node(value, 20) })).nodes[0].modelMs, null);
  }
  const input = run({ a: node(0, 10, { prompt: 'PRIVATE_PROMPT', apiKey: 'PRIVATE_KEY', files: ['PRIVATE_FILE'] }) });
  const before = structuredClone(input);
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  }
  freeze(input);
  const result = analyzeRun(input, { now: 'invalid-now-secret' });
  assert.deepEqual(input, before);
  assert.equal(result.nodes[0].modelMs, 10);
  assert.equal(result.overall.modelRatio, 0.1);
  const json = JSON.stringify(result);
  assert.deepEqual(JSON.parse(json), result);
  for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_KEY', 'PRIVATE_FILE', 'invalid-now-secret']) assert.ok(!json.includes(secret));
}

console.log('run-performance: all assertions passed');
