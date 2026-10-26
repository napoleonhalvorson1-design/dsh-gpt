import {ApiError} from './openhands.mjs';
export const MODEL_MODES=[{id:'auto',name:'自动调节',description:'按任务难度和阶段选择模型与思考深度'},{id:'fast',name:'速度优先',description:'优先已验证的轻量模型，复杂验收保留必要思考'},{id:'balanced',name:'均衡模式',description:'日常开发使用主力模型与适中思考'},{id:'deep',name:'深度模式',description:'复杂实现与审查优先强模型及深入思考'},{id:'manual',name:'手动配置',description:'各节点指定模型和思考深度'}];
export const EFFORTS=['auto','low','medium','high','xhigh','max'];
export const DEEPSEEK_LOCK={model:'deepseek-flash',nativeModel:'["deepseek-official","deepseek-flash"]',label:'DeepSeek V4.1 Flash',effort:'max'};
const preferences={codex:{fast:['gpt-6-luna','gpt-5.6-luna','gpt-6.1-sol','gpt-6-astra'],balanced:['gpt-6.1-sol','gpt-6-sol','gpt-6-astra','gpt-5.6-terra'],deep:['gpt-6-astra','gpt-6.1-sol','gpt-5.6-sol']},'claude-code':{fast:['haiku','sonnet','default'],balanced:['sonnet','default','opus'],deep:['opus','default','sonnet']}};
export function validateModelPolicy(flow){if(!flow||typeof flow!=="object"||Array.isArray(flow))throw new ApiError("模型配置无效。");if(flow.modelMode!==undefined&&!MODEL_MODES.some(m=>m.id===flow.modelMode))throw new ApiError('模型模式无效。');for(const n of [flow,...(Array.isArray(flow.nodes)?flow.nodes:[])])if(n?.reasoningEffort!==undefined&&!EFFORTS.includes(n.reasoningEffort))throw new ApiError('思考深度无效。');for(const key of ['taskComplexity','planningComplexity'])if(flow[key]!==undefined&&!['auto','simple','standard','complex'].includes(flow[key]))throw new ApiError('任务或规划难度无效。')}
export function taskComplexity(flow){if(flow.taskComplexity&&flow.taskComplexity!=='auto')return flow.taskComplexity;const task=flow.task||'';if(task.length>1400||/权限|安全|支付|迁移|分布式|并发|数据丢失|authentication|security|payment|migration|concurren/i.test(task))return 'complex';if(task.length<300&&/文案|颜色|拼写|简单|小修改|只改|docs|typo|rename|readme/i.test(task))return 'simple';return 'standard'}
export function chooseModel(config,node,flow,models=[]){
 const provider=config.model?.startsWith('acp:')?config.model.slice(4):'',pinned=provider==='deepseek';
 if(!pinned&&!flow.modelMode&&!node.reasoningEffort&&!flow.reasoningEffort)return null;
 if(!['codex','claude-code','deepseek'].includes(provider))return null;
 const mode=flow.modelMode||'manual',policy=mode==='auto'&&!node.liveModel?node.modelPolicy:null;
 if(policy!==undefined&&policy!==null&&(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(k=>!['model','effort','complexity'].includes(k))||policy.model!==undefined&&(typeof policy.model!=='string'||!policy.model||policy.model.length>160)||policy.effort!==undefined&&!EFFORTS.includes(policy.effort)||policy.complexity!==undefined&&!['simple','standard','complex'].includes(policy.complexity)))throw new ApiError('AI 分工的模型策略无效。',400);
 const complexity=flow.taskComplexity&&flow.taskComplexity!=='auto'?flow.taskComplexity:policy?.complexity||taskComplexity(flow),critical=['integrate','verify'].includes(node.phase)||['review'].includes(node.type)||/integrat|verif|release|审查|联调|整合|验收/.test(node.id+' '+node.name);
 const tier=mode==='fast'?'fast':mode==='deep'?'deep':mode==='balanced'?'balanced':mode==='manual'?'balanced':complexity==='complex'?'deep':complexity==='simple'&&!critical?'fast':critical?'deep':'balanced';
 if(pinned)return {mode,complexity,model:DEEPSEEK_LOCK.nativeModel,modelLabel:DEEPSEEK_LOCK.label,effort:'max',locked:true,reason:'用户固定：DeepSeek V4.1 Flash + max，所有模式一致',source:'pinned',verified:models.find(m=>m.id===DEEPSEEK_LOCK.nativeModel)?.verified===true};
 if(!models.length)throw new ApiError('此入口尚未配置模型能力目录，请先刷新或完成模式配置。',409);
 const explicit=node.liveModel||policy?.model||'',current=config.acpModel||'default';let chosen;
 if(explicit){chosen=models.find(m=>m.id===explicit);if(!chosen)throw new ApiError('所选模型不在此入口的能力目录：'+explicit,409)}
 else if(mode==='manual'){chosen=models.find(m=>m.id===current)||models.find(m=>m.verified===true)||models[0]}
 else{const allowed=models.filter(m=>m.verified===true);chosen=(preferences[provider]?.[tier]||[]).map(id=>allowed.find(m=>m.id===id)).find(Boolean)||allowed.find(m=>m.id===current)||allowed[0];if(!chosen)throw new ApiError('此入口没有已验证模型，请先做小任务验证或手动选择。',409)}
 if(policy&&explicit&&chosen.verified!==true)throw new ApiError('AI 分工只能选择已验证模型。',400);
 const levels=(chosen.efforts||[]).filter(x=>EFFORTS.includes(x)&&x!=='auto');if(!levels.length)throw new ApiError('此模型未暴露可调节的思考深度。',409);
 const override=node.reasoningEffort&&node.reasoningEffort!=='auto'?node.reasoningEffort:flow.reasoningEffort&&flow.reasoningEffort!=='auto'?flow.reasoningEffort:policy?.effort&&policy.effort!=='auto'?policy.effort:null;
 let effort=override||(tier==='fast'?'low':tier==='deep'?(complexity==='complex'?'xhigh':'high'):'medium');
 if(!levels.includes(effort)){if(override)throw new ApiError('此模型不支持思考深度 '+effort+'，请选择：'+levels.join('、'),409);effort=levels.filter(e=>EFFORTS.indexOf(e)<=EFFORTS.indexOf(effort)).at(-1)||levels[0]}
 return {mode,complexity,model:chosen.id,modelLabel:chosen.label||chosen.id,effort,locked:false,source:node.liveModel||node.reasoningEffort&&node.reasoningEffort!=='auto'||flow.reasoningEffort&&flow.reasoningEffort!=='auto'||mode==='manual'?'manual':policy?'planner':'auto',verified:chosen.verified===true,reason:(policy?'规划 AI 按分工选择模型与深度':explicit?'节点指定模型':mode==='manual'?'沿用入口默认模型':`${MODEL_MODES.find(m=>m.id===mode)?.name} · ${complexity==='complex'?'复杂任务':complexity==='simple'?'简单任务':'常规任务'}${critical?' · 验收/集成阶段':''}`)+(policy?.effort&&override===policy.effort?' · 分工指定深度':override?' · 手动思考深度':' · 自动思考深度')};
}
