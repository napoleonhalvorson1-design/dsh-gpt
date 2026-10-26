import {ApiError} from '../shared/openhands.mjs';
import {validateWorkflow} from './serial-engine.mjs';
import {chooseModel} from '../shared/model-policy.mjs';
const phaseOrder={build:0,integrate:1,verify:2,deliver:3};
const fail=message=>{throw new ApiError('AI 协作计划无效：'+message,400)};
const text=(v,max)=>typeof v==='string'&&v.trim()&&v.length<=max;
export function validateAdaptiveSeed(flow){
 if(flow.collaborationMode!=='adaptive')return;
 const agents=flow.nodes.filter(n=>!['start','end'].includes(n.type));
 if(agents.length!==1||agents[0].id!=='plan'||agents[0].type!=='planner'||flow.edges.length!==2||!flow.edges.some(([a,b])=>a==='start'&&b==='plan')||!flow.edges.some(([a,b])=>a==='plan'&&b==='end')||flow.nodes.length!==3)fail('自动协作项目须从单个 plan 规划节点开始。');
}
export function planningInstructions(team,flow={},observations=[]){
 const speedGuide="\n\n以整项任务尽快完成为目标。每个执行节点会自动收到完整用户任务；stages[].prompt 只写本节点负责的文件、分工差异和必要接口，通常 150 字以内。单实现节点无需重写需求规格；acceptanceCriteria 通常最多三个短要点。简短 plan.json 写完即交给引擎派发。需要较长代码、测试、文档输出的常规工作可优先委派给 DeepSeek V4.1 Flash + max，结合已观测耗时、任务能力与成本决定；复杂核心保留强模型，小修改可直接交付。实际观测有反证时及时调整入口选择。人数、模型、深度和并行仍由你决定。";
 const observed=observations.length?"\n最近已完成任务的执行观测（含工具等待，任务各异，只供估时，不代表能力排名或未来保证；interruptedSamples 的停止前等待不是成功耗时，不能作为已交付样本）："+JSON.stringify(observations):"";
 const catalog=Object.entries(team).map(([id,c])=>({id,name:c.profileLabel,engine:c.model,models:(c.policyModels||[]).filter(m=>m.verified===true).map(m=>({id:m.id,efforts:m.efforts}))}));
 return `\n\n你是需求负责人。优先做出用户要的功能，简短规划后立即开发；自己决定人数、分工与并行。简单需求一个实现节点即可。不要例行安排风险审查、重复验收、长报告或为凑齐五个 AI 增加任务。\n可用入口：${JSON.stringify(catalog)}。自动模式下可为每个阶段选择 modelPolicy={model:"目录中的已验证ID",effort:"支持的深度",complexity:"simple/standard/complex"}；按本阶段难度选择，常规实干优先便宜快速的 DeepSeek，复杂核心工作保留强模型。用户手动模式和深度优先。DeepSeek 始终 V4.1 Flash + max。\n只需写 .canvas-collaboration/plan.json；PLAN.md、CONTRACT.md 仅确有共享接口需要时再写，不另写流程文档。格式：{"schemaVersion":1,"goal":"用户目标","decisions":"一句分工理由","acceptanceCriteria":["关键需求"],"maxParallelNodes":5,"stages":[{"id":"implement","name":"实现需求","phase":"build","executionProfile":"入口ID","prompt":"完成具体功能与负责的文件，完成后做必要的小检查","dependsOn":[]}]}。\n简单需求可以由你直接实现并做必要检查，然后写 deliveryMode="direct"、deliverables=["实际交付文件相对路径"]、stages=[]，无需另开实现 AI。只有代码或用户要求的文件已经完成才可直接交付，不能只有计划或说明。复杂任务继续安排 1 至 10 个阶段；通常 1 至 3 个实干节点。委派模式 phase 为 build/integrate/verify/deliver，必须有 build；verify 和 deliver 都可省略。${flow.coordinationPolicy==='lean'?'verify/deliver 合计最多一个，不可拆成测试后再审查两次调用。':''}优先由最后一个实干节点检查并直接交付，确有必要才单独测试。只检查与改动相关的行为一次；有失败再定点修复，不循环复核。依赖无环，id 为 1 至 60 位英文数字/下划线/短横线，不为 start/plan/end。独立文件并行；需要集成则安排真实整合工作。每个 verify 必须等待全部 build/integrate，若有 deliver 则等待其余成果。多个分支汇合须有唯一共同基线。每个最终节点只简短交代成果、文件和必要检查结果；不强制 README/TEST/REVIEW 报告，已有使用说明需变更再更新。`+speedGuide+observed;
}
export function compactHandoffs(parents,{perParent=1400,total=5000}={}){
 let remaining=total;return parents.filter(n=>n.output).map(n=>{if(remaining<=0)return '';const summary=n.output.slice(-Math.min(perParent,remaining));remaining-=summary.length;return '【'+n.name+' 的交接信息】\n'+summary}).filter(Boolean).join('\n\n');
}
export function compileAdaptivePlan(plan,run,bundle){
 if(!plan||plan.schemaVersion!==1||!text(plan.goal,2000)||!text(plan.decisions,4000)||!Array.isArray(plan.acceptanceCriteria)||!plan.acceptanceCriteria.length||plan.acceptanceCriteria.length>30||!plan.acceptanceCriteria.every(x=>text(x,1000)))fail('缺少需求目标、分工理由或验收标准。');
 if(!Number.isInteger(plan.maxParallelNodes)||plan.maxParallelNodes<1||plan.maxParallelNodes>5)fail('并行数须为 1 至 5。');
 const direct=plan.deliveryMode==='direct';if(plan.deliveryMode!==undefined&&!['direct','delegated'].includes(plan.deliveryMode))fail('交付模式无效。');
 if(direct&&(!Array.isArray(plan.deliverables)||!plan.deliverables.length||plan.deliverables.length>100||plan.deliverables.some(p=>typeof p!=='string'||p.length>1000||p.startsWith('/')||p.includes('\\')||p.split('/').some(x=>!x||x==='.'||x==='..')||p.startsWith('.canvas-collaboration/')||/[\x00-\x1f\x7f]/.test(p))))fail('直接交付须列出实际成果文件。');
 if(!Array.isArray(plan.stages)||plan.stages.length<(direct?0:1)||plan.stages.length>10||direct&&plan.stages.length)fail('须提供 1 至 10 个以需求实现为主的阶段。');
 const stages=plan.stages,ids=new Set(stages.map(n=>n?.id));if(ids.size!==stages.length)fail('阶段 ID 重复。');
 for(const n of stages){if(!n||!/^[a-zA-Z0-9_-]{1,60}$/.test(n.id)||['start','plan','end','__proto__','constructor','prototype'].includes(n.id)||!text(n.name,100)||!text(n.prompt,12000)||!Object.hasOwn(phaseOrder,n.phase)||!Object.hasOwn(bundle.teamProfiles||{},n.executionProfile))fail('阶段、职责或 AI 入口无效。');if(!Array.isArray(n.dependsOn)||new Set(n.dependsOn).size!==n.dependsOn.length||n.dependsOn.some(p=>!ids.has(p)||p===n.id))fail('阶段依赖无效。');if(n.liveModel!==undefined||n.reasoningEffort!==undefined||n.config!==undefined)fail('计划不能改写运行模式或服务器配置。');}
 const ancestors=new Map(),visiting=new Set(),byId=new Map(stages.map(n=>[n.id,n]));
 function visit(id){if(visiting.has(id))fail('阶段依赖包含循环。');if(ancestors.has(id))return ancestors.get(id);visiting.add(id);const found=new Set();for(const p of byId.get(id).dependsOn){found.add(p);for(const a of visit(p))found.add(a);if(phaseOrder[byId.get(p).phase]>phaseOrder[byId.get(id).phase])fail('实现或集成不能安排在最终测试之后。');}visiting.delete(id);ancestors.set(id,found);return found}
 for(const n of stages)visit(n.id);
 const builds=stages.filter(n=>['build','integrate'].includes(n.phase)),tests=stages.filter(n=>n.phase==='verify'),deliveries=stages.filter(n=>n.phase==='deliver');if(!direct&&!stages.some(n=>n.phase==='build')||deliveries.length>1)fail('须有需求实现，单独交付阶段最多一个。');
 if(run.workflow.coordinationPolicy==='lean'&&tests.length+deliveries.length>1)fail('精简协作最多一个独立测试/交付节点，由实干节点检查后交付即可。');
 for(const test of tests)if(builds.some(n=>!ancestors.get(test.id).has(n.id)))fail('测试须等待全部需求实现和集成完成。');
 const delivery=deliveries[0],leaves=stages.filter(n=>!stages.some(other=>other.dependsOn.includes(n.id)));if(delivery&&stages.some(n=>n!==delivery&&!ancestors.get(delivery.id).has(n.id)))fail('交付须包含全部实现及最终测试成果。');
 // Reject ambiguous cross-joins before any implementation is submitted.
 for(const n of [...stages,{dependsOn:leaves.map(n=>n.id)}])if(n.dependsOn.length>1){const sets=n.dependsOn.map(p=>new Set(['plan',p,...ancestors.get(p)])),common=[...sets[0]].filter(id=>sets.every(s=>s.has(id))),maximal=common.filter(id=>!common.some(other=>other!==id&&(ancestors.get(other)?.has(id)||id==='plan')));if(maximal.length>1)fail('复杂交叉汇合须先建立单一共同基线。');}
 const sorted=[],todo=[...stages];while(todo.length){const index=todo.findIndex(n=>n.dependsOn.every(p=>sorted.some(s=>s.id===p)));sorted.push(...todo.splice(index,1))}
 const seed=run.workflow,nodes=[seed.nodes.find(n=>n.id==='start'),seed.nodes.find(n=>n.id==='plan'),...sorted.map((n,i)=>({id:n.id,type:n.phase==='verify'?'review':'code',name:n.name,phase:n.phase,executionProfile:n.executionProfile,...(n.modelPolicy?{modelPolicy:n.modelPolicy}:{}),prompt:n.prompt+'\n\n用户验收标准：\n'+plan.acceptanceCriteria.join('\n').slice(0,1000)+'\n\n以用户需求和验收标准为准；保留上游成果。'+(n.phase==='verify'?'主要实现已完成，仅做与改动相关的必要验证和定点修复。':'优先完成实际需求和集成。')+(leaves.some(last=>last.id===n.id)?'完成后做一次适合本次改动的最小检查，简短返回成果、文件与结果；不另写风险审查或验收长报告，不重复复核。':'交接只简短说明文件和接口，避免长报告。'),tools:['文件读写','终端'],x:460+i*230,y:(i%3)*180})),{id:'end',type:'end',name:'交付结果',x:690+sorted.length*230,y:0}],edges=[['start','plan'],...(direct?[['plan','end']]:[]),...sorted.flatMap(n=>(n.dependsOn.length?n.dependsOn:['plan']).map(p=>[p,n.id])),...leaves.map(n=>[n.id,'end'])],flow=validateWorkflow({...seed,nodes,edges,maxParallelNodes:Math.min(seed.maxParallelNodes,plan.maxParallelNodes)}),configs={...bundle.nodeConfigs};
 for(const node of nodes.filter(n=>!['start','end','plan'].includes(n.id))){const c={...bundle.teamProfiles[node.executionProfile]};if(c.mode!=='remote')fail('自动协作需要自托管执行入口。');c.selection=chooseModel(c,node,flow,c.policyModels||[]);configs[node.id]=c}
 delete flow.order;return {workflow:flow,nodeConfigs:configs,stages:sorted,summary:{directDelivery:direct,...(direct?{deliverables:plan.deliverables}:{}),goal:plan.goal,decisions:plan.decisions,acceptanceCriteria:plan.acceptanceCriteria,coordinationPolicy:seed.coordinationPolicy,reviewStages:tests.length+deliveries.length,maxParallelNodes:flow.maxParallelNodes}};
}

export function validateDirectDelivery(plan,manifest){if(plan.deliveryMode!=="direct")return;const files=new Map((manifest.items||[]).map(f=>[f.path,f]));if(plan.deliverables.some(p=>!files.has(p)||files.get(p).size===0))fail("直接交付的成果文件缺失或为空。");}
