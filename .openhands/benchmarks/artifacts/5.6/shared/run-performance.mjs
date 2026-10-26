// Standalone Node.js 22 / ESM. No input objects are retained in the result.
const FIELDS = ['startedAt', 'inputReadyAt', 'submittedAt', 'finishedAt', 'snapshotReadyAt', 'outputReadyAt'];
const SEGMENTS = ['preparationMs', 'submissionWaitMs', 'modelMs', 'snapshotMs', 'outputBarrierMs'];
const TERMINAL = new Set(['completed', 'succeeded', 'failed', 'cancelled', 'canceled']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absent = value => value === undefined || value === null;

// Deliberately restrict strings to UTC ISO timestamps with millisecond precision.
// The round trip rejects impossible calendar dates that Date.parse normalizes.
function timestamp(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && Math.abs(value) <= 8640000000000000 ? value : null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : null;
}

/** Analyze observed run timings without mutation or an implicit wall clock. */
export function analyzeRun(run, { now } = {}) {
  const warnings = [];
  const warn = (code, nodeId, field) => warnings.push({ code, ...(nodeId === undefined ? {} : { nodeId }), ...(field === undefined ? {} : { field }) });
  const read = (value, nodeId, field) => {
    const parsed = timestamp(value);
    if (parsed === null) warn(absent(value) ? 'missing_time' : 'invalid_time', nodeId, field);
    return parsed;
  };
  const clock = timestamp(now);
  if (!absent(now) && clock === null) warn('invalid_now');
  const duration = (start, end, nodeId, field) => {
    if (start === null || end === null) return null;
    if (end < start) { warn('reversed_time', nodeId, field); return null; }
    const result = end - start;
    if (!Number.isSafeInteger(result)) { warn('unsafe_duration', nodeId, field); return null; }
    return result;
  };
  let structureComplete = true;
  if (!record(run)) { warn('invalid_run'); run = {}; structureComplete = false; }
  const source = record(run.nodes) ? run.nodes : {};
  if (!record(run.nodes)) { warn('invalid_nodes'); structureComplete = false; }
  const ids = Object.keys(source);
  const idSet = new Set(ids);
  if (run.order !== undefined) {
    if (!Array.isArray(run.order) || run.order.length !== ids.length ||
        new Set(run.order).size !== ids.length || run.order.some(id => typeof id !== 'string' || !idSet.has(id))) {
      warn('order_mismatch'); structureComplete = false;
    }
  }
  const runRunning = run.status === 'running';
  const runTerminal = TERMINAL.has(run.status);
  if (!runRunning && !runTerminal) warn('unknown_run_status');
  const created = read(run.createdAt, undefined, 'createdAt');
  const finished = read(run.finishedAt, undefined, 'finishedAt');
  let boundaryConsistent = true;
  if (runRunning && !absent(run.finishedAt)) { warn('running_run_has_finish'); boundaryConsistent = false; }
  const runEnd = finished ?? (runRunning && absent(run.finishedAt) ? clock : null);
  if (runRunning && absent(run.finishedAt) && clock === null) warn('now_required');
  const elapsedMs = duration(created, runEnd, undefined, 'elapsedMs');
  const nodes = [];
  const internals = new Map();
  const intervals = [];
  let modelKnown = 0;
  let modelComplete = structureComplete;
  let fullNodes = true;

  for (const id of ids) {
    const validNode = record(source[id]);
    const node = validNode ? source[id] : {};
    if (!validNode) { warn('invalid_node', id); structureComplete = false; }
    const times = FIELDS.map(field => read(node[field], id, field));
    const running = node.status === 'running';
    const terminal = TERMINAL.has(node.status);
    if (!running && !terminal) warn('unknown_node_status', id);
    let timelineConsistent = validNode;
    let previous = null;
    for (let i = 0; i < times.length; i++) {
      if (times[i] === null) continue;
      if (previous !== null && times[i] < previous) {
        warn('stage_order', id, FIELDS[i]); timelineConsistent = false;
      }
      previous = times[i];
    }
    if (running && !absent(node.outputReadyAt)) {
      warn('running_node_has_output', id); timelineConsistent = false;
    }
    if (runTerminal && running) { warn('node_running_after_run', id); timelineConsistent = false; }
    const segments = {};
    const openSegments = [];
    let modelInterval = null;
    for (let i = 0; i < SEGMENTS.length; i++) {
      let end = times[i + 1];
      const mayOpen = running && runRunning && timelineConsistent && times[i] !== null &&
        FIELDS.slice(i + 1).every(field => absent(node[field]));
      if (mayOpen) {
        end = clock;
        if (clock === null) warn('now_required', id, SEGMENTS[i]);
        else openSegments.push(SEGMENTS[i]);
      }
      segments[SEGMENTS[i]] = duration(times[i], end, id, SEGMENTS[i]);
      if (i === 2 && segments.modelMs !== null) modelInterval = [times[i], end];
    }
    // Cross-stage contradictions do not erase separately proven local durations.
    // They do prevent claiming complete coverage or trustworthy proportions.
    let end = times[5];
    let endField = end === null ? null : 'outputReadyAt';
    let observedToNow = false;
    if (end === null && running && runRunning && timelineConsistent &&
        FIELDS.every((field, i) => absent(node[field]) || times[i] !== null) && clock !== null) {
      const latest = times.filter(t => t !== null).at(-1);
      if (latest !== undefined && clock >= latest) { end = clock; endField = 'now'; observedToNow = true; }
    }
    if (end === null) {
      for (const i of [4, 3]) {
        if (times[i] !== null) { end = times[i]; endField = FIELDS[i]; break; }
      }
    }
    const endToEndMs = duration(times[0], end, id, 'endToEndMs');
    const complete = timelineConsistent && terminal && times.every(t => t !== null) &&
      Object.values(segments).every(t => t !== null);
    fullNodes &&= complete;
    if (modelInterval) { intervals.push(modelInterval); modelKnown++; }
    modelComplete &&= !!modelInterval && timelineConsistent && (terminal || (running && runRunning));
    const result = {
      id, ...segments, dependencyReadinessWaitMs: null, endToEndMs,
      endToEndEnd: endField, endToEndComplete: endToEndMs !== null && endField === 'outputReadyAt' && timelineConsistent,
      observedToNow, openSegments, timelineConsistent, complete,
    };
    nodes.push(result);
    internals.set(id, { node, times, result });
  }

  for (const id of ids) {
    const { node, times, result } = internals.get(id);
    if (!Array.isArray(node.dependencies) || new Set(node.dependencies).size !== node.dependencies.length ||
        node.dependencies.some(dep => typeof dep !== 'string' || !idSet.has(dep) || dep === id)) {
      warn('invalid_dependencies', id); structureComplete = false; continue;
    }
    if (!node.dependencies.length) { result.dependencyReadinessWaitMs = 0; continue; }
    const ready = node.dependencies.map(dep => internals.get(dep).times[5]);
    if (times[0] === null || times[1] === null || ready.some(t => t === null)) {
      warn('dependency_time_unknown', id); continue;
    }
    const lastReady = ready.reduce((latest, time) => Math.max(latest, time), -Infinity);
    if (lastReady > times[1] || times[1] < times[0]) {
      warn('dependency_order', id);
      result.timelineConsistent = false;
      result.complete = false;
      result.endToEndComplete = false;
      fullNodes = false;
      continue;
    }
    result.dependencyReadinessWaitMs = duration(times[0], Math.max(times[0], lastReady), id, 'dependencyReadinessWaitMs');
  }

  const knownEmpty = ids.length === 0 && structureComplete;
  const hasKnown = intervals.length > 0 || knownEmpty;
  let modelWorkMs = hasKnown ? 0 : null;
  let modelWallMs = hasKnown ? 0 : null;
  let observedPeakModels = hasKnown ? 0 : null;
  const events = [];
  for (const [start, end] of intervals) {
    modelWorkMs += end - start;
    if (end > start) events.push([start, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let previous = null;
  for (const [time, delta] of events) {
    if (active > 0) modelWallMs += time - previous;
    active += delta;
    observedPeakModels = Math.max(observedPeakModels, active);
    previous = time;
  }
  if (modelWorkMs !== null && !Number.isSafeInteger(modelWorkMs)) { modelWorkMs = null; warn('unsafe_model_work'); modelComplete = false; }
  if (modelWallMs !== null && !Number.isSafeInteger(modelWallMs)) { modelWallMs = null; warn('unsafe_model_wall'); modelComplete = false; }
  modelComplete &&= structureComplete && nodes.every(node => node.timelineConsistent);
  const reasons = [];
  if (!structureComplete) reasons.push('structure_incomplete');
  if (!runTerminal || !boundaryConsistent || !nodes.every(node => internals.get(node.id) && TERMINAL.has(internals.get(node.id).node.status))) reasons.push('status_incomplete');
  if (elapsedMs === null || elapsedMs <= 0) reasons.push('run_boundary_unknown_or_nonpositive');
  if (!fullNodes || !modelComplete) reasons.push('node_timeline_incomplete');
  const inside = created !== null && runEnd !== null && nodes.every(({ id }) =>
    internals.get(id).times.every(time => time !== null && time >= created && time <= runEnd));
  if (!inside) reasons.push('node_boundary_unknown_or_outside_run');
  if (modelWallMs === null || modelWorkMs === null) reasons.push('model_aggregate_unknown');
  const overall = reasons.length ? null : {
    modelRatio: modelWallMs / elapsedMs,
    overheadRatio: (elapsedMs - modelWallMs) / elapsedMs,
    nonModelWallMs: elapsedMs - modelWallMs,
  };
  if (reasons.length) warn('overall_unavailable');
  const candidates = nodes.filter(node => node.endToEndMs !== null);
  const max = candidates.length ? candidates.reduce((longest, node) => Math.max(longest, node.endToEndMs), 0) : null;
  return {
    schemaVersion: 1, elapsedMs, nodes, modelWallMs, modelWorkMs, observedPeakModels,
    modelCoverage: {
      totalNodes: ids.length, knownIntervals: modelKnown, complete: modelComplete,
      kind: modelComplete ? 'complete' : hasKnown ? 'observed_lower_bound' : 'unknown',
    },
    overall, overallUnavailableReasons: reasons,
    slowestNode: max === null ? null : {
      ids: candidates.filter(node => node.endToEndMs === max).map(node => node.id),
      endToEndMs: max, candidateCount: candidates.length,
      complete: structureComplete && nodes.every(node => node.endToEndComplete),
    },
    structureComplete, warnings,
  };
}
