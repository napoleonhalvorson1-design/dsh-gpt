import assert from 'node:assert/strict';
import {compactPlannerContext} from '../shared/planner-context.mjs';
import {EFFORTS, DEEPSEEK_LOCK} from '../shared/model-policy.mjs';

const levels = EFFORTS.filter(e => e !== 'auto');
const model = (id = 'gpt-6.1-sol', efforts = levels, verified = true) => ({id, efforts, verified});
const config = (policyModels = [model()], extra = {}) => ({mode: 'remote', model: 'acp:codex', policyModels, ...extra});
const unpack = matrix => matrix.rows.map(row => Object.fromEntries(matrix.columns.map((column, i) => [column, row[i]])));
const profile = (context, id) => unpack(context.profiles).find(row => row.id === id);
const resolve = (context, id) => profile(context, id).models.map(i => context.modelSets[i]);
const observation = extra => ({profileId: 'codex', model: 'gpt-6.1-sol', effort: 'high', role: 'build', complexity: 'standard', ...extra});
const trace = extra => ({profileId: 'deepseek', model: DEEPSEEK_LOCK.nativeModel, effort: 'max', source: 'dsh-v4-session', runStatus: 'cancelled', usageIsLowerBound: true, ...extra});
const deepseek = config([model(DEEPSEEK_LOCK.nativeModel, ['max'])], {model: 'acp:deepseek'});
const empty = {schemaVersion: 1, modelSets: [], profiles: {columns: ['id', 'engine', 'runtimeContextModes', 'models'], rows: []}};
assert.deepEqual(compactPlannerContext(), empty);
assert.deepEqual(compactPlannerContext({}), empty);
assert.deepEqual(compactPlannerContext({team: null, observations: null, nativeTraces: null}), empty);

// Canonical depth sets share definitions across entries; narrower sets remain distinct.
const reuse = compactPlannerContext({team: {
  z: config([model('native/model', ['max', 'low', 'max', 'auto', 'bogus'])]),
  a: config([model('native/model', ['low', 'max']), model('native/model', ['max', 'low'])]),
  narrow: config([model('native/model', ['low'])]),
  both: config([model('native/model', ['max', 'low']), model('native/model', ['low'])]),
}});
assert.equal(reuse.modelSets.length, 2);
assert.deepEqual(profile(reuse, 'z').models, profile(reuse, 'a').models);
assert.notDeepEqual(profile(reuse, 'a').models, profile(reuse, 'narrow').models);
assert.equal(profile(reuse, 'both').models.length, 2);
assert.deepEqual(resolve(reuse, 'a'), [['native/model', ['low', 'max']]]);
assert.deepEqual(resolve(reuse, 'narrow'), [['native/model', ['low']]]);
assert.equal(reuse.profiles.rows.length, 4);

const nativeId = '["provider","native/model"]';
const filtered = compactPlannerContext({team: {
  codex: config([
    model(), model('unverified', levels, false), model('truthy', levels, 'true'), {id: 'missing', efforts: levels},
    model('', levels), model('   '), model('a'.repeat(161)), model('bad\nmodel'), model(12), null,
    model('empty', []), model('auto', ['auto']), model('unknown', ['minimal']), model('no-array', 'high'),
    model(nativeId, ['high']), model('x'.repeat(160), ['low']),
  ]),
  unknown: config([model()], {model: 'acp:other'}),
  local: config([model()], {mode: 'local'}),
  absent: config([model()], {mode: undefined}),
  'Invalid': config(), 'bad.id': config(), '': config(), ['x'.repeat(81)]: config(),
  ['v'.repeat(80)]: config(), _ok: config(), empty: config([]), null: null,
}});
// Missing verification must not be treated as verified.
const missingVerification = compactPlannerContext({team: {codex: config([{id: 'missing', efforts: levels}])}});
assert.deepEqual(missingVerification, empty);
assert.deepEqual(resolve(filtered, 'codex').map(([id]) => id).sort(), [nativeId, 'gpt-6.1-sol', 'x'.repeat(160)].sort());
assert.deepEqual(unpack(filtered.profiles).map(p => p.id), ['_ok', 'codex', 'v'.repeat(80)]);

const locked = compactPlannerContext({team: {
  deepseek: config([model(DEEPSEEK_LOCK.nativeModel), model('deepseek-flash'), model('deepseek-pro')], {model: 'acp:deepseek', runtimeContextVersion: 1}),
  'no-max': config([model(DEEPSEEK_LOCK.nativeModel, ['high'])], {model: 'acp:deepseek'}),
  unverified: config([model(DEEPSEEK_LOCK.nativeModel, ['max'], false)], {model: 'acp:deepseek'}),
}});
assert.deepEqual(resolve(locked, 'deepseek'), [[DEEPSEEK_LOCK.nativeModel, ['max']]]);
assert.equal(locked.profiles.rows.length, 1);
assert.deepEqual(profile(locked, 'deepseek').runtimeContextModes, ['inherit']);
for (const version of [undefined, 0, 1, 2, '1', true]) {
  const context = compactPlannerContext({team: {
    codex: config([model()], {runtimeContextVersion: version}),
    claude: config([model('sonnet')], {model: 'acp:claude-code', runtimeContextVersion: version}),
  }});
  assert.deepEqual(profile(context, 'codex').runtimeContextModes, version === 1 ? ['inherit', 'focused'] : ['inherit']);
  assert.deepEqual(profile(context, 'claude').runtimeContextModes, ['inherit']);
}

const team = {codex: config(), deepseek};
const numericObservation = observation({samples: 0, failedBeforeDeliverySamples: 2, invalidPlanSamples: 0, interruptedSamples: 1,
  observedWaitBeforeStopMsMedian: 6000.5, observedStageMsMedian: null, outputTokensMedian: 0, observedOutputTokensPerSecondMedian: 2.75,
  prompt: 'SECRET', thinking: 'SECRET', tools: 'SECRET'});
const records = compactPlannerContext({team, observations: [numericObservation,
  observation({profileId: 'gone'}), observation({model: 'gone'}), observation({effort: 'auto'}),
  observation({role: 'review'}), observation({complexity: 'auto'}), observation({role: undefined}), null,
  observation({profileId: 'deepseek', model: DEEPSEEK_LOCK.nativeModel, effort: 'high'}),
], nativeTraces: [trace({knownOutputTokens: 0, maxStepOutputTokens: null, maxBeforeToolMs: 12, observedAtMs: 100, prompt: 'SECRET', route: 'SECRET'})]});
assert.deepEqual(records.observations.columns, ['profileId', 'model', 'effort', 'role', 'complexity', 'samples', 'failedBeforeDeliverySamples', 'invalidPlanSamples', 'interruptedSamples', 'observedWaitBeforeStopMsMedian', 'observedStageMsMedian', 'outputTokensMedian', 'observedOutputTokensPerSecondMedian']);
assert.equal(records.observations.rows.length, 1);
const [kept] = unpack(records.observations);
assert.deepEqual(kept, Object.fromEntries(records.observations.columns.map(c => [c, numericObservation[c]])));
assert.equal(kept.samples, 0, 'Interrupted samples must never become delivered samples');
assert.equal(kept.observedStageMsMedian, null, 'Stop waiting must not populate successful duration');
assert.equal(kept.observedWaitBeforeStopMsMedian, 6000.5);
assert.deepEqual(records.nativeTraces.columns, ['profileId', 'model', 'effort', 'runStatus', 'knownOutputTokens', 'maxStepOutputTokens', 'maxBeforeToolMs', 'observedAtMs', 'usageIsLowerBound']);
assert.deepEqual(records.nativeTraces.rows[0], ['deepseek', DEEPSEEK_LOCK.nativeModel, 'max', 'cancelled', 0, null, 12, 100, true]);
assert(!JSON.stringify(records).includes('SECRET'));

const countColumns = records.observations.columns.slice(5, 9);
const medianColumns = records.observations.columns.slice(9);
const traceNumbers = records.nativeTraces.columns.slice(4, 8);
for (const value of [undefined, null, -1, NaN, Infinity, -Infinity, '0', false, {}, [], 1n, () => 1]) {
  const c = compactPlannerContext({team, observations: [observation(Object.fromEntries([...countColumns, ...medianColumns].map(k => [k, value])))],
    nativeTraces: [trace(Object.fromEntries(traceNumbers.map(k => [k, value])))]});
  assert.deepEqual(c.observations.rows[0].slice(5), Array(8).fill(null));
  assert.deepEqual(c.nativeTraces.rows[0].slice(4, 8), Array(4).fill(null));
  assert.doesNotThrow(() => JSON.stringify(c));
}
for (const value of [0, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
  const c = compactPlannerContext({team, observations: [observation(Object.fromEntries([...countColumns, ...medianColumns].map(k => [k, value])))],
    nativeTraces: [trace(Object.fromEntries(traceNumbers.map(k => [k, value])))]});
  const safe = Number.isSafeInteger(value) ? value : null;
  assert.deepEqual(c.observations.rows[0].slice(5, 9), Array(4).fill(safe));
  assert.deepEqual(c.observations.rows[0].slice(9), Array(4).fill(value));
  assert.deepEqual(c.nativeTraces.rows[0].slice(4, 8), Array(4).fill(safe));
}
for (const role of ['planning', 'direct-implementation', 'implementation', 'build', 'integrate', 'verify', 'deliver']) {
  for (const complexity of ['unknown', 'simple', 'standard', 'complex']) {
    assert.equal(compactPlannerContext({team, observations: [observation({role, complexity})]}).observations.rows.length, 1);
  }
}
for (const runStatus of ['queued', 'running', 'reconnecting', 'stopping', 'awaiting_input', 'succeeded', 'failed', 'cancelled']) {
  assert.equal(unpack(compactPlannerContext({team, nativeTraces: [trace({runStatus})]}).nativeTraces)[0].runStatus, runStatus);
}
for (const extra of [
  {source: 'other'}, {source: undefined}, {usageIsLowerBound: false}, {usageIsLowerBound: 1}, {usageIsLowerBound: undefined},
  {runStatus: 'finished'}, {runStatus: 'paused'}, {runStatus: undefined}, {profileId: 'gone'},
  {profileId: 'codex', model: 'gpt-6.1-sol'}, {model: 'deepseek-flash'}, {effort: 'high'},
]) assert.equal(compactPlannerContext({team, nativeTraces: [trace(extra), null]}).nativeTraces, undefined);
assert.equal(compactPlannerContext({team, observations: [observation({effort: 'max', model: 'unverified'})]}).observations, undefined);
const narrowTeam = {codex: config([model('gpt-6.1-sol', ['low'])])};
assert.equal(compactPlannerContext({team: narrowTeam, observations: [observation()]}).observations, undefined);
assert.equal(compactPlannerContext({team: {deepseek: config([model(DEEPSEEK_LOCK.nativeModel, ['max'], false)], {model: 'acp:deepseek'})}, nativeTraces: [trace()]}).nativeTraces, undefined);

// Five real entry identities and representative verified capabilities; timings are synthetic fixtures.
const codexModels = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'].map(id => model(id));
const fiveTeam = Object.fromEntries([
  ['codex-silicon', config(codexModels, {runtimeContextVersion: 1})],
  ['codex-shanghai', config(codexModels, {runtimeContextVersion: 1})],
  ['codex-seoul', config(codexModels, {runtimeContextVersion: 1})],
  ['claude-silicon', config([model('sonnet', ['low', 'medium', 'high']), model('opus', ['low', 'medium', 'high', 'max'])], {model: 'acp:claude-code'})],
  ['deepseek-shanghai', deepseek],
].map(([id, c]) => [id, {...c, profileLabel: id + ' execution entry', baseUrl: 'https://private.invalid', apiKey: 'SECRET', commands: {agent: 'SECRET'}}]));
const fiveObservations = Object.entries(fiveTeam).flatMap(([profileId, c]) => c.policyModels.map(m => observation({profileId, model: m.id, effort: m.efforts.at(-1),
  samples: 3, failedBeforeDeliverySamples: 1, invalidPlanSamples: 0, interruptedSamples: 1, observedWaitBeforeStopMsMedian: 45000,
  observedStageMsMedian: 120000, outputTokensMedian: 4000, observedOutputTokensPerSecondMedian: 33.33})));
const fiveTraces = [trace({profileId: 'deepseek-shanghai', knownOutputTokens: 72000, maxStepOutputTokens: 36000, maxBeforeToolMs: 104, observedAtMs: 1793000000000})];
const input = {team: fiveTeam, observations: fiveObservations, nativeTraces: fiveTraces};
const before = JSON.stringify(input);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
freeze(input);
const compact = compactPlannerContext(input);
assert.equal(JSON.stringify(input), before);
assert.deepEqual(compactPlannerContext(input), compact);
assert.deepEqual(JSON.parse(JSON.stringify(compact)), compact);
assert.equal(compact.modelSets.length, 6);
assert.equal(compact.profiles.rows.length, 5);
assert.equal(compact.observations.rows.length, fiveObservations.length);
assert.equal(compact.nativeTraces.rows.length, fiveTraces.length);
for (const [id, c] of Object.entries(fiveTeam)) {
  assert.deepEqual(resolve(compact, id).map(([modelId, efforts]) => [modelId, efforts]).sort(), c.policyModels.map(m => [m.id, m.efforts]).sort());
}
assert.deepEqual(compactPlannerContext({...input, team: Object.fromEntries(Object.entries(fiveTeam).reverse())}), compact);
const legacy = {profiles: Object.entries(fiveTeam).map(([id, c]) => ({id, name: c.profileLabel, engine: c.model,
  runtimeContextModes: c.model === 'acp:codex' && c.runtimeContextVersion === 1 ? ['inherit', 'focused'] : ['inherit'],
  models: c.policyModels.filter(m => m.verified === true).map(m => ({id: m.id, efforts: m.efforts}))})), observations: fiveObservations, nativeTraces: fiveTraces};
const legacyChars = JSON.stringify(legacy).length, compactChars = JSON.stringify(compact).length;
assert(compactChars < legacyChars, `${compactChars} must be smaller than ${legacyChars}`);
assert(!JSON.stringify(compact).includes('SECRET'));
// Mutating output must not mutate frozen source capabilities.
compact.modelSets[0][1].push('test-only');
assert.equal(JSON.stringify(input), before);
console.log(`planner-context: all assertions passed; five-entry JSON chars ${legacyChars} -> ${compactChars} (${((1 - compactChars / legacyChars) * 100).toFixed(1)}% reduction; fixture only, no token or timing claim)`);
