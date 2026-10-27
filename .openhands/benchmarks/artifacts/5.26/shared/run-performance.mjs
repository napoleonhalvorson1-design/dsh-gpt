/** Pure, dependency-free run timing analysis. All durations are milliseconds. */
const fields = ['startedAt', 'inputReadyAt', 'submittedAt', 'finishedAt', 'snapshotReadyAt', 'outputReadyAt'];
const terminal = new Set(['succeeded', 'completed', 'failed', 'cancelled', 'canceled']);
const live = status => status === 'running';
const missing = value => value === undefined || value === null;

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? value : null;
  if (typeof value !== 'string') return null;
  // Require an explicit zone and validate the calendar before Date.parse can normalize it.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, , zone] = m;
  const year = +y, month = +mo;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || +d < 1 || +d > days[month - 1] || +h > 23 || +mi > 59 || +s > 59) return null;
  if (zone !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function analyzeRun(run, { now } = {}) {
  const warnings = [];
  const warn = message => { if (!warnings.includes(message)) warnings.push(message); };
  const read = (value, label) => {
    const t = timestamp(value);
    if (t === null) warn(`${label}: ${missing(value) ? 'missing' : 'invalid'}`);
    return t;
  };
  const span = (a, b, label) => {
    if (a === null || b === null) return null;
    if (b < a) { warn(`${label}: reversed`); return null; }
    return b - a;
  };
  const input = run && typeof run === 'object' ? run : {};
  const clock = missing(now) ? null : read(now, 'now');
  const created = read(input.createdAt, 'run.createdAt');
  const end = missing(input.finishedAt) && live(input.status) ? clock : read(input.finishedAt, 'run.finishedAt');
  if (end === null && live(input.status)) warn('run: explicit valid now required for open interval');
  const elapsedMs = span(created, end, 'run');
  const source = input.nodes && typeof input.nodes === 'object' && !Array.isArray(input.nodes) ? input.nodes : {};
  const ids = [...new Set([...(Array.isArray(input.order) ? input.order.filter(id => typeof id === 'string' && Object.hasOwn(source, id)) : []), ...Object.keys(source)])];
  const times = new Map(ids.map(id => {
    const n = source[id] && typeof source[id] === 'object' ? source[id] : {};
    return [id, { n, t: Object.fromEntries(fields.map(f => [f, read(n[f], `${id}.${f}`)])) }];
  }));
  const nodes = Object.create(null), intervals = [];
  let complete = ids.length > 0, pipelineComplete = ids.length > 0;
  let slowestNode = null;
  for (const id of ids) {
    const { n, t } = times.get(id);
    const modelEnd = missing(n.finishedAt) && live(n.status) ? clock : t.finishedAt;
    const modelMs = span(t.submittedAt, modelEnd, `${id}.model`);
    if (modelMs === null) { complete = false; warn(`${id}.model: unknown`); }
    else intervals.push([t.submittedAt, modelEnd]);
    let ready = created;
    if (!Array.isArray(n.dependencies)) { ready = null; warn(`${id}.dependencies: missing or invalid`); }
    else for (const dependency of n.dependencies) {
      const depEnd = times.get(dependency)?.t.outputReadyAt ?? null;
      if (depEnd === null) { ready = null; warn(`${id}.queue: dependency readiness unknown`); }
      else if (ready !== null) ready = Math.max(ready, depEnd);
    }
    // Do not replace an invalid endpoint with a later fallback.
    const endField = !missing(n.outputReadyAt) ? 'outputReadyAt' : !missing(n.finishedAt) ? 'finishedAt' : live(n.status) ? 'now' : null;
    const nodeEnd = endField === 'now' ? clock : endField ? t[endField] : null;
    const endToEndMs = span(t.startedAt, nodeEnd, `${id}.endToEnd`);
    nodes[id] = {
      queueMs: span(ready, t.startedAt, `${id}.queue`),
      preparationMs: span(t.startedAt, t.inputReadyAt, `${id}.preparation`),
      submissionWaitMs: span(t.inputReadyAt, t.submittedAt, `${id}.submissionWait`),
      modelMs,
      snapshotMs: span(t.finishedAt, t.snapshotReadyAt, `${id}.snapshot`),
      barrierMs: span(t.snapshotReadyAt, t.outputReadyAt, `${id}.barrier`),
      endToEndMs, endToEndEndpoint: endField,
    };
    if (endToEndMs !== null && (!slowestNode || endToEndMs > slowestNode.endToEndMs)) slowestNode = { id, endToEndMs, endpoint: endField };
    const sequence = fields.map(f => t[f]);
    if (!terminal.has(n.status) || sequence.some(v => v === null) || sequence.some((v, i) => i > 0 && v < sequence[i - 1]) || created === null || end === null || t.startedAt < created || t.outputReadyAt > end || nodes[id].queueMs === null) pipelineComplete = false;
  }
  if (!ids.length) warn('nodes: empty; model coverage unknown');
  // Half-open intervals: finishes precede starts at equal timestamps; zero intervals have no concurrency.
  const events = intervals.filter(([a, b]) => b > a).flatMap(([a, b]) => [[a, 1], [b, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let wall = 0, active = 0, peak = 0, previous = null;
  for (const [time, delta] of events) {
    if (active > 0) wall += time - previous;
    active += delta;
    peak = Math.max(peak, active);
    previous = time;
  }
  const work = intervals.reduce((sum, [a, b]) => sum + b - a, 0);
  const ratiosKnown = complete && pipelineComplete && elapsedMs > 0;
  if (!ratiosKnown) warn('overall: ratio unknown (incomplete timeline or zero elapsed)');
  return {
    schemaVersion: 1, elapsedMs, nodes,
    modelWallMs: complete ? wall : null,
    modelWorkMs: complete ? work : null,
    observedPeakModels: intervals.length ? peak : null,
    modelCoverageComplete: complete,
    knownModelWallMs: intervals.length ? wall : null,
    knownModelWorkMs: intervals.length ? work : null,
    overall: {
      modelRatio: ratiosKnown ? wall / elapsedMs : null,
      overheadRatio: ratiosKnown ? (elapsedMs - wall) / elapsedMs : null,
      nonModelElapsedMs: ratiosKnown ? elapsedMs - wall : null,
    },
    slowestNode, warnings,
  };
}
