/** Pure, dependency-free run timing analysis. All durations are milliseconds. */
export function analyzeRun(run, { now } = {}) {
  const warnings = [];
  const warn = (scope, message) => warnings.push(`${scope}: ${message}`);
  const active = status => ['running', 'in_progress'].includes(status);
  const parse = (value, scope) => {
    if (value === undefined || value === null) return null;
    const time = typeof value === 'number' ? value
      : typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
    if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) {
      warn(scope, 'invalid time');
      return null;
    }
    return time;
  };
  const current = parse(now, 'now');
  const duration = (start, end, scope) => {
    if (start === null || end === null) {
      warn(scope, 'missing time');
      return null;
    }
    if (end < start) {
      warn(scope, 'reversed time');
      return null;
    }
    return end - start;
  };
  const source = run && typeof run === 'object' ? run : {};
  const created = parse(source.createdAt, 'run.createdAt');
  const finished = parse(source.finishedAt, 'run.finishedAt');
  const runEnd = source.finishedAt == null && active(source.status) ? current : finished;
  const elapsedMs = duration(created, runEnd, 'run.elapsedMs');
  const fields = ['startedAt', 'inputReadyAt', 'submittedAt', 'finishedAt', 'snapshotReadyAt', 'outputReadyAt'];
  const segmentNames = ['preparationMs', 'submissionWaitMs', 'modelMs', 'snapshotMs', 'outputBarrierMs'];
  const entries = Object.entries(source.nodes && typeof source.nodes === 'object' ? source.nodes : {});
  const order = Array.isArray(source.order) ? source.order : [];
  entries.sort(([a], [b]) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || a.localeCompare(b);
  });
  const nodes = Object.create(null);
  const intervals = [];
  let completeModels = entries.length > 0;
  let slowestNode = null;
  for (const [id, raw] of entries) {
    const node = raw && typeof raw === 'object' ? raw : {};
    const times = fields.map(field => parse(node[field], `node[${id}].${field}`));
    let previous = null, reversed = false;
    for (const time of times) {
      if (time === null) continue;
      if (previous !== null && time < previous) reversed = true;
      previous = time;
    }
    if (reversed) warn(`node[${id}]`, 'reversed milestone order');
    const runningModel = active(node.status) && node.finishedAt == null &&
      node.snapshotReadyAt == null && node.outputReadyAt == null;
    const modelEnd = runningModel ? current : times[3];
    const modelMs = duration(times[2], modelEnd, `node[${id}].modelMs`);
    const segments = {};
    for (let i = 0; i < segmentNames.length; i++) {
      const value = i === 2 ? modelMs : duration(times[i], times[i + 1], `node[${id}].${segmentNames[i]}`);
      segments[segmentNames[i]] = reversed ? null : value;
    }
    // Use the latest declared completion boundary; an invalid boundary never falls back.
    let endIndex = [5, 4, 3].find(i => node[fields[i]] != null);
    const endBoundary = endIndex !== undefined ? fields[endIndex] : active(node.status) ? 'now' : null;
    const end = endIndex !== undefined ? times[endIndex] : active(node.status) ? current : null;
    const e2e = duration(times[0], end, `node[${id}].endToEndMs`);
    const endToEndMs = reversed ? null : e2e;
    const modelKnown = segments.modelMs !== null;
    if (modelKnown) intervals.push([times[2], modelEnd]);
    else completeModels = false;
    nodes[id] = {
      ...segments, endToEndMs, endBoundary,
      modelProvisional: modelKnown && runningModel,
      endToEndProvisional: endBoundary === 'now' && endToEndMs !== null,
    };
    if (endToEndMs !== null && (!slowestNode || endToEndMs > slowestNode.endToEndMs)) {
      slowestNode = { id, endToEndMs, endBoundary, provisional: nodes[id].endToEndProvisional };
    }
  }
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let modelWallMs = intervals.length ? 0 : null;
  let modelWorkMs = intervals.length ? 0 : null;
  let unionStart = null, unionEnd = null;
  const events = [];
  for (const [start, end] of intervals) {
    modelWorkMs += end - start;
    if (unionStart === null) { unionStart = start; unionEnd = end; }
    else if (start <= unionEnd) unionEnd = Math.max(unionEnd, end);
    else { modelWallMs += unionEnd - unionStart; unionStart = start; unionEnd = end; }
    if (end > start) events.push([start, 1], [end, -1]);
  }
  if (unionStart !== null) modelWallMs += unionEnd - unionStart;
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let concurrency = 0;
  let observedPeakModels = intervals.length ? 0 : null;
  for (const [, delta] of events) {
    concurrency += delta;
    observedPeakModels = Math.max(observedPeakModels, concurrency);
  }
  const bounded = elapsedMs !== null && intervals.every(([start, end]) => start >= created && end <= runEnd);
  if (!bounded && intervals.length && elapsedMs !== null) warn('run', 'model interval outside run');
  // A full lifecycle is necessary before labeling the wall-time complement overhead.
  const completeLifecycle = entries.length > 0 && Object.values(nodes).every(node =>
    segmentNames.every(name => node[name] !== null) && node.endToEndMs !== null);
  const ratiosKnown = completeModels && completeLifecycle && bounded && elapsedMs > 0;
  return {
    schemaVersion: 1, elapsedMs, nodes, modelWallMs, modelWorkMs, observedPeakModels,
    modelCoverage: completeModels ? 'complete' : intervals.length ? 'partial' : 'unknown',
    overall: ratiosKnown ? {
      modelRatio: modelWallMs / elapsedMs,
      overheadRatio: (elapsedMs - modelWallMs) / elapsedMs,
      overheadMs: elapsedMs - modelWallMs,
    } : null,
    slowestNode, warnings,
  };
}
