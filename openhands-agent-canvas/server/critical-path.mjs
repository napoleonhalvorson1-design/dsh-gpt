// Estimates only order ready work; they never change dependencies or model policy.
const valid = ms => Number.isFinite(ms) && ms > 0 && ms <= 7200000;
export function freezeSchedule(stages, configs, observations = []) {
 const estimates = {};
 for (const stage of stages) {
  const selection = configs[stage.id]?.selection;
  const observed = selection?.verified && observations.find(o => o.profileId === configs[stage.id].profileId && o.model === selection.model && o.effort === selection.effort && o.role === stage.phase && o.complexity === selection.complexity && o.samples >= 3 && valid(o.observedStageMsMedian));
  estimates[stage.id] = Number.isInteger(stage.estimatedSeconds) && stage.estimatedSeconds >= 1 && stage.estimatedSeconds <= 7200
   ? {durationMs: stage.estimatedSeconds * 1000, source: 'planner'}
   : observed ? {durationMs: observed.observedStageMsMedian, source: 'history', samples: observed.samples}
   : {durationMs: null, source: 'unknown'};
 }
 const known = Object.values(estimates).map(e => e.durationMs).filter(valid).sort((a, b) => a - b);
 // Unknown stages share a neutral weight, not an invented measured duration.
 const neutralWeightMs = known.length ? known[Math.floor(known.length / 2)] : 1000;
 return {version: 1, policy: 'critical-path', neutralWeightMs, estimates};
}
export function stageOrder(run) {
 const order = run.order || [], schedule = run.scheduling;
 if (run.schedulingVersion !== 1 || schedule?.version !== 1) return order;
 const children = new Map(order.map(id => [id, []])), memo = new Map(), visiting = new Set();
 for (const id of order) for (const parent of run.nodes[id]?.dependencies || []) children.get(parent)?.push(id);
 function rank(id) {
  if (memo.has(id)) return memo.get(id);
  if (visiting.has(id)) throw new Error('工作流依赖包含循环。');
  visiting.add(id);
  const node = run.nodes[id], estimate = schedule.estimates?.[id]?.durationMs;
  const own = node?.outputReady || node?.modelCompleted ? 0 : valid(estimate) ? estimate : valid(schedule.neutralWeightMs) ? schedule.neutralWeightMs : 1000;
  const value = own + Math.max(0, ...children.get(id).map(rank));
  visiting.delete(id); memo.set(id, value); return value;
 }
 for (const id of order) rank(id);
 return order.map((id, index) => ({id, index, rank: memo.get(id)})).sort((a, b) => b.rank - a.rank || a.index - b.index).map(row => row.id);
}
