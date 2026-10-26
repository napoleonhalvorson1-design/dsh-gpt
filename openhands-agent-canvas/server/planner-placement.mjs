import {selectPlanner} from '../shared/planner-policy.mjs';
import {compileExecutionPolicy} from './execution-policy.mjs';
import {compileRuntimeContext} from './runtime-context.mjs';
import {ApiError} from '../shared/openhands.mjs';

// Count controller reservations, not provider queue lengths or account limits.
export function plannerReservations(store){
 const loads=new Map();
 for(const row of store.db.prepare("SELECT payload FROM runs WHERE status IN ('queued','running','reconnecting','stopping')").iterate()){
  const run=JSON.parse(row.payload);
  for(const [id,node] of Object.entries(run.nodes||{})){
   if(!node.profileId||node.modelCompleted||node.outputReady||node.stopConfirmed)continue;
   const started=['running','reconnecting'].includes(node.status);
   const ready=node.status==='pending'&&!node.error&&!run.cancelRequested&&(run.schedulerVersion===2?(node.dependencies||[]).every(id=>run.nodes[id]?.outputReady===true):id===run.order?.[run.index||0]);
   if(started||ready)loads.set(node.profileId,(loads.get(node.profileId)||0)+1);
  }
 }
 return loads;
}

export function placePlanner(store,flow,bundle){
 const original=bundle.nodeConfigs?.plan,definition=flow.nodes?.find(n=>n.id==='plan');
 if(flow.collaborationMode!=='adaptive'||flow.plannerPolicy!=='strongest'||flow.modelMode==='manual'||!original?.selection?.planner||!original.selection.verified||!bundle.teamProfiles)return bundle;
 const loads=plannerReservations(store),{model,effort}=original.selection,candidates=new Map();
 for(const [id,profile] of Object.entries(bundle.teamProfiles)){
  if(profile.mode!=='remote'||profile.model!==original.model||!profile.commands?.[original.model.slice(4)]||!profile.policyRuntimePath||!profile.policyModels?.some(m=>m.id===model&&m.verified===true&&m.efforts?.includes(effort)))continue;
  try{
   const base={...profile,selection:{...original.selection}};
   const contextual=compileRuntimeContext(base,{...definition,runtimeContext:original.runtimeContext??definition.runtimeContext},flow);
   candidates.set(id,compileExecutionPolicy(contextual,definition,flow,bundle.teamProfiles));
  }catch(error){if(!(error instanceof ApiError))throw error;}
 }
 if(!candidates.size)return bundle;
 const minimum=Math.min(...[...candidates.keys()].map(id=>loads.get(id)||0));
 // Keep the existing warm route on ties; use capability preference for new ties.
 let chosen=candidates.get(original.profileId);
 if(!chosen||(loads.get(original.profileId)||0)>minimum){
  const peers=Object.fromEntries([...candidates].filter(([id])=>(loads.get(id)||0)===minimum).map(([id,c])=>[id,{...c,policyModels:c.policyModels.filter(m=>m.id===model)}]));
  chosen=candidates.get(selectPlanner(peers)?.profileId);
 }
 if(!chosen||chosen.profileId===original.profileId)return bundle;
 chosen.selection={...chosen.selection,reason:original.selection.reason+' · 同模型同深度分散到较空闲入口',placement:{strategy:'least-reserved-compatible',from:original.profileId,to:chosen.profileId,reservations:minimum}};
 return {...bundle,nodeConfigs:{...bundle.nodeConfigs,plan:chosen}};
}
