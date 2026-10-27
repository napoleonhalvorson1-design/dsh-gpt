/** Pure run timing analysis. All timestamps and durations use milliseconds. */
const FIELDS = ['startedAt', 'inputReadyAt', 'submittedAt', 'finishedAt', 'snapshotReadyAt', 'outputReadyAt'];
const TERMINAL = new Set(['completed', 'succeeded', 'success', 'failed', 'error', 'cancelled', 'canceled']);
const ACTIVE = new Set(['running', 'in_progress']);
const RUN_ACTIVE = new Set(['queued', 'running', 'reconnecting', 'stopping', 'in_progress']);

function timestamp(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : null;
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  const leap = +y % 4 === 0 && (+y % 100 !== 0 || +y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > days[+mo - 1] || +h > 23 || +mi > 59 || +s > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

export function analyzeRun(run, { now } = {}) {
  const warnings = [];
  const warn = (scope, code, field) => warnings.push({ scope, code, field });
  const read = (value, scope, field) => {
    const n = timestamp(value);
    if (n === null) warn(scope, value == null ? 'missing_time' : 'invalid_time', field);
    return n;
  };
  const duration = (a, b, scope, field) => {
    if (a === null || b === null) return null;
    if (b < a || !Number.isSafeInteger(b - a)) {
      warn(scope, 'invalid_interval', field);
      return null;
    }
    return b - a;
  };
  run = run && typeof run === 'object' ? run : {};
  const live = RUN_ACTIVE.has(run.status);
  // No implicit clock: the same input and options always produce the same output.
  const clock = now === undefined ? null : read(now, 'run', 'now');
  const created = read(run.createdAt, 'run', 'createdAt');
  const ended = run.finishedAt != null ? read(run.finishedAt, 'run', 'finishedAt')
    : live ? clock : read(run.finishedAt, 'run', 'finishedAt');
  if (live && run.finishedAt == null && now === undefined) warn('run', 'missing_time', 'now');
  const elapsedMs = duration(created, ended, 'run', 'elapsedMs');
  const source = run.nodes && typeof run.nodes === 'object' && !Array.isArray(run.nodes) ? run.nodes : {};
  const ids = [...new Set([...(Array.isArray(run.order) ? run.order.filter(id => typeof id === 'string' && Object.hasOwn(source, id)) : []), ...Object.keys(source)])].filter(id=>source[id]?.artifactOnly!==true);
  const parsed = new Map(ids.map(id => {
    const node = source[id] && typeof source[id] === 'object' ? source[id] : {};
    return [id, { node, times: FIELDS.map(field => read(node[field], id, field)) }];
  }));
  const intervals = [];
  let allComplete = ids.length > 0;
  let modelIntervalsComplete = true;
  const nodes = ids.map(id => {
    const { node, times } = parsed.get(id);
    let chronological = true;
    let previous = null;
    for (const t of times) {
      if (t === null) continue;
      if (previous !== null && t < previous) chronological = false;
      previous = t;
    }
    if (!chronological) warn(id, 'out_of_order', 'timeline');
    // Canvas marks inference succeeded before its snapshot/bucket barrier.
    // Require explicit flags so missing historical delivery clocks stay unknown.
    const activeNode = live && (ACTIVE.has(node.status) || node.status === 'reconnecting'
      || node.status === 'succeeded' && node.modelCompleted === true && node.outputReady === false) && clock !== null;
    const canObserve = activeNode && chronological && times.every(t => t === null || t <= clock);
    const last = times.findLastIndex(t => t !== null);
    const segment = (a, b, name) => {
      let end = times[b];
      // Only the current stage can be observed up to now. Invalid endpoints
      // and absent historical endpoints must never be replaced by the clock.
      if (node[FIELDS[b]] == null && canObserve && last === a) end = clock;
      return duration(times[a], end, id, name);
    };
    let ready = null;
    if (Array.isArray(node.dependencies)) {
      const dependencyEnds = node.dependencies.map(dep => source[dep]?.artifactOnly===true ? timestamp(source[dep].outputReadyAt) : dep==='plan'&&source[dep]?.planCommitted ? timestamp(run.streamingPlan?.committedAt) : parsed.get(dep)?.times[5] ?? null);
      if (created !== null && dependencyEnds.every(t => t !== null)) ready = Math.max(created, ...dependencyEnds);
      else warn(id, 'unknown_dependencies', 'queueMs');
    } else warn(id, 'unknown_dependencies', 'queueMs');
    const queueMs = duration(ready, times[0], id, 'queueMs');
    const attemptStart = node.attemptStartedAt === undefined ? times[0] : read(node.attemptStartedAt, id, 'attemptStartedAt');
    const attemptStartValid = attemptStart !== null && (times[0] === null || attemptStart >= times[0]) && (times[1] === null || attemptStart <= times[1]);
    if (node.attemptStartedAt !== undefined && !attemptStartValid) warn(id, 'invalid_attempt_order', 'attemptStartedAt');
    const preparationMs = !attemptStartValid ? null : node.attemptStartedAt === undefined ? segment(0, 1, 'preparationMs')
      : duration(attemptStart, times[1] ?? (canObserve && last === 0 ? clock : null), id, 'preparationMs');
    const submissionWaitMs = segment(1, 2, 'submissionWaitMs');
    const modelMs = segment(2, 3, 'modelMs');
    const snapshotMs = segment(3, 4, 'snapshotMs');
    const barrierMs = segment(4, 5, 'barrierMs');
    const modelEnd = times[3] ?? (node.finishedAt == null && canObserve && last === 2 ? clock : null);
    if (modelMs !== null) intervals.push([times[2], modelEnd]);
    else modelIntervalsComplete = false;
    const previousAttempts = [];
    let previousAttemptWorkMs = 0, attemptsKnown = true, previousStop = null;
    if (node.attempts !== undefined && !Array.isArray(node.attempts)) { attemptsKnown = false; warn(id, 'invalid_attempts', 'attempts'); }
    for (const [index, attempt] of (Array.isArray(node.attempts) ? node.attempts : []).entries()) {
      const a = attempt && typeof attempt === 'object' ? attempt : {};
      const start = read(a.submittedAt, id, `attempts[${index}].submittedAt`);
      const stop = read(a.finishedAt ?? (a.stopConfirmed === true ? a.stoppedAt : undefined), id, `attempts[${index}].endedAt`);
      let ms = duration(start, stop, id, `attempts[${index}].modelMs`);
      if (ms !== null && (created !== null && start < created || ended !== null && stop > ended
        || previousStop !== null && start < previousStop || attemptStart !== null && stop > attemptStart)) {
        warn(id, 'invalid_attempt_order', `attempts[${index}]`); ms = null;
      }
      if (ms === null) attemptsKnown = false;
      else { intervals.push([start, stop]); previousAttemptWorkMs += ms; previousStop = stop; }
      previousAttempts.push({ index, modelMs: ms, interrupted: !a.finishedAt && a.stopConfirmed === true });
    }
    if (!attemptsKnown) modelIntervalsComplete = false;
    let end = times[5];
    let endField = 'outputReadyAt';
    let endToEndComplete = end !== null;
    if (end === null && node.outputReadyAt == null && canObserve) {
      end = clock;
      endField = 'now';
      endToEndComplete = false;
    } else if (end === null && node.outputReadyAt == null && TERMINAL.has(node.status) && times[3] !== null) {
      end = times[last];
      endField = FIELDS[last];
      warn(id, 'unknown_tail', 'endToEndMs');
    }
    const endToEndMs = chronological ? duration(times[0], end, id, 'endToEndMs') : null;
    if (activeNode && times.some(t => t !== null && t > clock)) {
      warn(id, 'future_time', 'now');
    }
    const complete = attemptsKnown && preparationMs !== null && chronological && times.every(t => t !== null) && queueMs !== null
      && created !== null && ended !== null && times.every(t => t >= created && t <= ended);
    if (!complete) allComplete = false;
    return { id, queueMs, preparationMs, submissionWaitMs, modelMs, snapshotMs, barrierMs,
      ...(previousAttempts.length ? { previousAttempts, previousAttemptWorkMs: attemptsKnown ? previousAttemptWorkMs : null } : {}),
      endToEndMs, endToEndEndField: end === null ? null : endField, endToEndComplete: endToEndComplete && endToEndMs !== null,
      timingComplete: complete };
  });
  // Half-open intervals: finishes at t precede starts at t. Zero-length
  // intervals are genuine observations but do not increase concurrency.
  const events = intervals.flatMap(([a, b]) => a === b ? [] : [[a, 1], [b, -1]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0, peak = 0, wall = 0, previous = null;
  for (const [t, delta] of events) {
    if (active > 0) wall += t - previous;
    active += delta;
    peak = Math.max(peak, active);
    previous = t;
  }
  const observed = intervals.length > 0 || ids.length === 0;
  const work = intervals.reduce((sum, [a, b]) => sum + (b - a), 0);
  const modelWallMs = observed && Number.isSafeInteger(wall) ? wall : null;
  const modelWorkMs = observed && Number.isSafeInteger(work) ? work : null;
  if (observed && (modelWallMs === null || modelWorkMs === null)) warn('run', 'numeric_overflow', 'modelTotals');
  const ratiosKnown = allComplete && modelIntervalsComplete && elapsedMs > 0 && modelWallMs !== null;
  const slowest = nodes.reduce((best, node) => node.endToEndMs !== null && (!best || node.endToEndMs > best.endToEndMs) ? node : best, null);
  return { schemaVersion: 1, elapsedMs, nodes, modelWallMs, modelWorkMs,
    observedPeakModels: observed ? peak : null, modelIntervalsComplete,
    overall: { modelRatio: ratiosKnown ? modelWallMs / elapsedMs : null,
      overheadRatio: ratiosKnown ? (elapsedMs - modelWallMs) / elapsedMs : null,
      nonModelWallMs: ratiosKnown ? elapsedMs - modelWallMs : null },
    slowestNode: slowest ? { id: slowest.id, endToEndMs: slowest.endToEndMs,
      endField: slowest.endToEndEndField, complete: slowest.endToEndComplete } : null,
    warnings };
}
