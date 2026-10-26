import {EFFORTS, DEEPSEEK_LOCK} from './model-policy.mjs';

const ENGINES = new Set(['acp:codex', 'acp:claude-code', 'acp:deepseek']);
const ROLES = new Set(['planning', 'direct-implementation', 'implementation', 'build', 'integrate', 'verify', 'deliver']);
const COMPLEXITIES = new Set(['unknown', 'simple', 'standard', 'complex']);
// Run statuses from server/serial-engine.mjs and server/engine.mjs (not native session statuses).
const RUN_STATUSES = new Set(['queued', 'running', 'reconnecting', 'stopping', 'awaiting_input', 'succeeded', 'failed', 'cancelled']);
const PROFILE_COLUMNS = ['id', 'engine', 'runtimeContextModes', 'models'];
const OBSERVATION_COLUMNS = [
  'profileId', 'model', 'effort', 'role', 'complexity', 'samples',
  'failedBeforeDeliverySamples', 'invalidPlanSamples', 'interruptedSamples',
  'observedWaitBeforeStopMsMedian', 'observedStageMsMedian', 'outputTokensMedian',
  'observedOutputTokensPerSecondMedian',
];
const TRACE_COLUMNS = [
  'profileId', 'model', 'effort', 'runStatus', 'knownOutputTokens',
  'maxStepOutputTokens', 'maxBeforeToolMs', 'observedAtMs', 'usageIsLowerBound',
];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const decimal = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const validModel = id => typeof id === 'string' && id.trim().length > 0 && id.length <= 160 && !/[\x00-\x1f\x7f]/.test(id);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Compact resolved team configs and numeric record arrays without retaining input objects. */
export function compactPlannerContext({team = {}, observations = [], nativeTraces = []} = {}) {
  const modelSets = [], definitions = new Map(), capabilities = new Map(), rows = [];
  for (const [id, config] of Object.entries(object(team) ? team : {}).sort(([a], [b]) => compare(a, b))) {
    // Keep this profile ID rule aligned with server/profiles.mjs.
    if (!/^[a-z0-9_-]{1,80}$/.test(id) || !object(config) || config.mode !== 'remote' || !ENGINES.has(config.model)) continue;
    const models = new Map();
    for (const model of Array.isArray(config.policyModels) ? config.policyModels : []) {
      if (!object(model) || model.verified !== true || !validModel(model.id) || !Array.isArray(model.efforts)) continue;
      let efforts = EFFORTS.filter(e => e !== 'auto' && model.efforts.includes(e));
      if (config.model === 'acp:deepseek') {
        if (model.id !== DEEPSEEK_LOCK.nativeModel) continue;
        efforts = efforts.includes(DEEPSEEK_LOCK.effort) ? [DEEPSEEK_LOCK.effort] : [];
      }
      if (!efforts.length) continue;
      const definition = [model.id, efforts];
      models.set(JSON.stringify(definition), definition);
    }
    if (!models.size) continue;
    const indices = [], supported = new Map();
    for (const [key, definition] of [...models].sort(([a], [b]) => compare(a, b))) {
      if (!definitions.has(key)) {
        definitions.set(key, modelSets.length);
        modelSets.push(definition);
      }
      indices.push(definitions.get(key));
      if (!supported.has(definition[0])) supported.set(definition[0], new Set());
      for (const effort of definition[1]) supported.get(definition[0]).add(effort);
    }
    capabilities.set(id, {engine: config.model, supported});
    rows.push([id, config.model, config.model === 'acp:codex' && config.runtimeContextVersion === 1 ? ['inherit', 'focused'] : ['inherit'], indices]);
  }
  const result = {schemaVersion: 1, modelSets, profiles: {columns: [...PROFILE_COLUMNS], rows}};
  const matches = record => object(record) && typeof record.profileId === 'string' && typeof record.model === 'string' &&
    capabilities.get(record.profileId)?.supported.get(record.model)?.has(record.effort) === true;
  const observationRows = [];
  for (const record of Array.isArray(observations) ? observations : []) {
    if (!matches(record) || !ROLES.has(record.role) || !COMPLEXITIES.has(record.complexity)) continue;
    observationRows.push(OBSERVATION_COLUMNS.map((column, i) => i < 5 ? record[column] : i < 9 ? integer(record[column]) : decimal(record[column])));
  }
  if (observationRows.length) result.observations = {columns: [...OBSERVATION_COLUMNS], rows: observationRows};
  const traceRows = [];
  for (const record of Array.isArray(nativeTraces) ? nativeTraces : []) {
    if (!matches(record) || capabilities.get(record.profileId).engine !== 'acp:deepseek' ||
        record.model !== DEEPSEEK_LOCK.nativeModel || record.effort !== DEEPSEEK_LOCK.effort ||
        record.source !== 'dsh-v4-session' || !RUN_STATUSES.has(record.runStatus) || record.usageIsLowerBound !== true) continue;
    traceRows.push(TRACE_COLUMNS.map((column, i) => i < 4 ? record[column] : i < 8 ? integer(record[column]) : true));
  }
  if (traceRows.length) result.nativeTraces = {columns: [...TRACE_COLUMNS], rows: traceRows};
  return result;
}
