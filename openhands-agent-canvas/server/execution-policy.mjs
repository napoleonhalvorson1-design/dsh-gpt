import {ApiError} from '../shared/openhands.mjs';
import {chooseModel,EFFORTS} from '../shared/model-policy.mjs';
import {selectPlanner} from '../shared/planner-policy.mjs';
export function defaultPlannerPolicy(flow,config,observations=[]){
 const node=flow.nodes?.find(n=>n.id==='plan'),primary=config.nodeConfigs?.plan;
 if(flow.collaborationMode!=='adaptive'||flow.plannerPolicy!=='strongest'||node?.executionPolicy||!primary?.selection?.planner)return null;
 const {model,effort,complexity}=primary.selection,peers=Object.fromEntries(Object.entries(config.teamProfiles||{}).filter(([id,c])=>id!==primary.profileId&&c.policyModels?.some(m=>m.verified&&m.id===model&&m.efforts.includes(effort))));
 const peer=selectPlanner(peers),sample=observations.find(x=>x.profileId===primary.profileId&&x.model===model&&x.effort===effort&&x.role==='planning'&&x.complexity===complexity&&x.samples>=3),budgetSeconds=Math.ceil(Math.max(300,Math.min(900,(sample?.observedStageMsMedian||100000)*3/1000)));
 return {budgetSeconds,...(peer?{fallbackProfile:peer.profileId,fallbackModelPolicy:{model,effort,complexity}}:{})};
}
export function validateExecutionPolicy(value){
 if(value===undefined)return;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['budgetSeconds','fallbackProfile','fallbackModelPolicy'].includes(k))||!Number.isInteger(value.budgetSeconds)||value.budgetSeconds<30||value.budgetSeconds>7200)throw new ApiError('执行预算须为 30 至 7200 秒，且只包含受支持的后备设置。');
 if(value.fallbackProfile!==undefined&&(typeof value.fallbackProfile!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value.fallbackProfile)))throw new ApiError('后备入口标识无效。');
 const p=value.fallbackModelPolicy;
 if(p!==undefined&&(!value.fallbackProfile||!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['model','effort','complexity'].includes(k))||p.model!==undefined&&(typeof p.model!=='string'||!p.model||p.model.length>160)||p.effort!==undefined&&!EFFORTS.includes(p.effort)||p.complexity!==undefined&&!['simple','standard','complex'].includes(p.complexity)))throw new ApiError('后备模型策略无效。');
}
export function compileExecutionPolicy(primary,node,flow,team={}){
 const policy=node.executionPolicy;validateExecutionPolicy(policy);if(!policy)return primary;
 if(primary.mode!=='remote')throw new ApiError('执行预算目前需要自托管执行入口。',409);
 primary.executionPolicy=structuredClone(policy);
 if(!policy.fallbackProfile)return primary;
 const candidate=team[policy.fallbackProfile];if(!candidate||candidate.mode!=='remote')throw new ApiError('后备执行入口不可用。',409);
 const next={...candidate,...(primary.runtimeContext?{runtimeContext:primary.runtimeContext==='focused'&&candidate.model==='acp:codex'&&candidate.runtimeContextVersion===1?'focused':'inherit'}:{})},manual=!flow.modelMode||flow.modelMode==='manual',definition={...node,modelPolicy:policy.fallbackModelPolicy||node.modelPolicy};
 if(primary.selection?.planner){definition.liveModel=primary.selection.model;definition.reasoningEffort=primary.selection.effort;}
 if(manual){definition.liveModel=node.liveModel||primary.selection?.model||primary.acpModel;definition.reasoningEffort=node.reasoningEffort||primary.selection?.effort;}
 next.selection=chooseModel(next,definition,{...flow,modelMode:flow.modelMode||'manual'},next.policyModels||[]);
 if(flow.runtimeContext==='focused'&&next.runtimeContext!=='focused')throw new ApiError('后备入口不支持项目指定的精简上下文。',409);
 if(!next.selection?.verified)throw new ApiError('自动后备只能使用已验证模型。',409);
 if(definition.liveModel&&next.selection.model!==definition.liveModel)throw new ApiError('后备不能改写手动指定的模型。',409);
 if(primary.selection?.planner)next.selection={...next.selection,planner:true,source:'planner',complexity:primary.selection.complexity,...(primary.selection.planningComplexity?{planningComplexity:primary.selection.planningComplexity}:{}),reason:'已验证的同一强规划模型在后备入口继续'};
 if(next.profileId===primary.profileId&&next.selection.model===(primary.selection?.model||primary.acpModel)&&next.selection.effort===primary.selection?.effort)throw new ApiError('后备须选择不同入口、模型或思考深度。');
 next.executionPolicy={budgetSeconds:policy.budgetSeconds};delete next.fallbackConfig;
 primary.fallbackConfig=next;return primary;
}
export function budgetExpired(node,config,now=Date.now()){
 const seconds=config.executionPolicy?.budgetSeconds,start=Date.parse(node.budgetStartedAt||node.submittedAt);
 return !!seconds&&!node.modelCompleted&&Number.isFinite(start)&&now-start>=seconds*1000;
}
