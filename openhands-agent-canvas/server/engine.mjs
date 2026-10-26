import {traceObservations} from './native-trace.mjs';
import {Engine as SerialEngine,ACTIVE,validateWorkflow} from './serial-engine.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,stat,copyFile} from 'node:fs/promises';
import {join,basename} from 'node:path';
import {ApiError,upstream,conversation,eventSummary,startConversation} from '../shared/openhands.mjs';
import {transferWorkspace} from './handoff.mjs';
import {captureNode,mergeArchives,validateMerge,archiveOperation} from './collaboration.mjs';
import {chooseModel} from '../shared/model-policy.mjs';
import {EventWakeup} from './event-wakeup.mjs';
import {executionHistory} from './execution-history.mjs';
import {budgetExpired,defaultPlannerPolicy,compileExecutionPolicy} from './execution-policy.mjs';
import {recoverBudget} from './budget-recovery.mjs';
import {pinRunSource} from './run-source.mjs';
import {placePlanner} from './planner-placement.mjs';
import {preparePlanRepair} from './plan-repair.mjs';
import {validateAdaptiveSeed,planningInstructions,compileAdaptivePlan,compactHandoffs,validateDirectDelivery} from './adaptive.mjs';
export {ACTIVE,validateWorkflow};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const isAgent=n=>!['start','end'].includes(n.type);
// Preserve graph dependencies through routing start/end nodes. Array position never schedules a DAG.
function dependencies(flow){
 const byId=new Map(flow.nodes.map(n=>[n.id,n])),parents=id=>flow.edges.filter(e=>e[1]===id).map(e=>e[0]);
 const nearest=id=>parents(id).flatMap(p=>isAgent(byId.get(p))?[p]:nearest(p));
 return Object.fromEntries(flow.nodes.filter(isAgent).map(n=>[n.id,[...new Set(nearest(n.id))]]));
}
export class Engine extends SerialEngine {
 constructor(store,options={}){super(store,{...options,maxActive:options.maxActive??3});this.maxNodeActive=options.maxNodeActive??5;this.maxDagActive=options.maxDagActive??10;this.maxStageActive=options.maxStageActive??10;this.nodeActive=new Set();this.stageActive=new Set();this.inputTasks=new Map();this.eventWakeups=new Map();this.suppressTick=false;this.clock=options.clock||Date.now}
 close(){super.close();this.repositorySource?.close();this.runSource?.close();for(const feed of this.eventWakeups.values())feed.close();this.eventWakeups.clear()}
 tick(){
  if(this.suppressTick||this.closed)return;
  const ids=this.store.runnable(),recovering=run=>Object.values(run?.nodes||{}).some(n=>!n.modelCompleted&&['running','reconnecting'].includes(n.status)&&(n.handle||n.submittedAt));
  // Reserve already submitted inference before starting anything after a controller restart.
  for(const id of ids){const run=this.store.run(id);if(run.schedulerVersion===2)for(const n of Object.values(run.nodes))if(!n.modelCompleted&&['running','reconnecting'].includes(n.status)&&(n.handle||n.submittedAt))this.nodeActive.add(id+'/'+n.id)}
  ids.sort((a,b)=>Number(recovering(this.store.run(b)))-Number(recovering(this.store.run(a))));
  let dags=0,legacy=0;for(const id of this.active){if(this.store.run(id)?.schedulerVersion===2)dags++;else legacy++;}
  for(const id of ids){
   if(this.active.has(id))continue;const dag=this.store.run(id)?.schedulerVersion===2;
   // A DAG waiting for its bucket barrier must not consume a legacy workflow
   // admission slot. Bound resident DAGs and all outstanding stage work separately.
   if(dag?dags>=this.maxDagActive:legacy>=this.maxActive)continue;
   if(dag)dags++;else legacy++;this.active.add(id);
   this.execute(id).catch(error=>{if(this.closed)return;const run=this.store.run(id);if(run&&ACTIVE.has(run.status)){this.patch(id,r=>{r.status='failed';r.error=error.message});this.log(id,'workflow',error.message,{error:true})}}).finally(()=>{this.active.delete(id);this.tick()});
  }
 }
 enqueue(input,config){
  const existing=this.store.run(input.id);if(existing)return existing;
  const flow=validateWorkflow(input.workflow);validateAdaptiveSeed(flow);const artifactSource=pinRunSource(this.store,this.storage,input,flow);const observations=config.teamProfiles?executionHistory(this.store,config.teamProfiles):[],initialPolicy=defaultPlannerPolicy(flow,config,observations);config=placePlanner(this.store,flow,config);const plannerPolicy=defaultPlannerPolicy(flow,config,observations);if(plannerPolicy&&initialPolicy)plannerPolicy.budgetSeconds=Math.max(plannerPolicy.budgetSeconds,initialPolicy.budgetSeconds);if(plannerPolicy){const definition=flow.nodes.find(n=>n.id==='plan');definition.executionPolicy=plannerPolicy;config={...config,nodeConfigs:{...config.nodeConfigs,plan:compileExecutionPolicy({...config.nodeConfigs.plan},definition,flow,config.teamProfiles)}};}if(flow.collaborationMode==='adaptive'&&!config.teamProfiles)throw new ApiError('自动协作尚未配置可用 AI 团队。',409);const deps=dependencies(flow),parallel=flow.nodes.some(n=>n.executionPolicy)||!!flow.baseRunId||!!flow.repository&&config.mode==='remote'||!!flow.modelMode||!!config.selection||Object.values(config.nodeConfigs||{}).some(c=>c.selection)||flow.executionMode==='parallel'||Object.values(deps).filter(p=>!p.length).length>1||Object.values(deps).some(p=>p.length>1)||Object.keys(deps).some(id=>Object.values(deps).filter(p=>p.includes(id)).length>1);
  if(parallel&&flow.nodes.filter(isAgent).some(n=>(config.nodeConfigs?.[n.id]||config).mode!=='remote'))throw new ApiError('并行文件协作需要自托管 OpenHands 执行入口。',409);
  this.suppressTick=true;let run,transaction=false;const atomic=!!artifactSource;
  try{if(atomic){this.store.db.exec('BEGIN IMMEDIATE');transaction=true}run=super.enqueue({...input,workflow:flow},config);
  if(artifactSource){run.artifactSource=artifactSource;this.store.saveRun(run)}
  if(parallel){run.schedulerVersion=2;if(flow.collaborationMode==='adaptive'){run.adaptivePlan={status:'pending',plannerId:'plan'};if(config.nodeConfigs?.plan?.selection?.planner&&config.nodeConfigs.plan.selection.verified)run.planRepairVersion=1;}run.maxParallelNodes=flow.maxParallelNodes;run.activeNodeIds=[];run.completedCount=0;for(const [id,node] of Object.entries(run.nodes)){node.dependencies=deps[id];node.workspace+='/'+id;node.inputReady=false;node.outputReady=false}this.store.saveRun(run);this.log(run.id,'workflow','依照画布依赖并行调度，最多 '+run.maxParallelNodes+' 个 AI 同时工作；分支目录隔离，汇合前校验阶段快照。')}
  if(transaction){this.store.db.exec('COMMIT');transaction=false}}catch(error){if(transaction)this.store.db.exec('ROLLBACK');throw error}finally{this.suppressTick=false}
  this.tick();return this.store.run(run.id);
 }
 patch(id,fn,options){if(this.closed)return this.store.run(id);const run=this.store.run(id);if(!run)return null;fn(run);return this.store.saveRun(run,options)}
 patchNode(id,node){
  if(this.closed)return this.store.run(id);const run=this.store.run(id);if(!run)return null;
  const previous=run.nodes[node.id],next={...previous,...node};if(JSON.stringify(previous)===JSON.stringify(next))return run;
  run.nodes[node.id]=next;return this.store.saveRun(run);
 }
 stop(id){
  this.repositorySource?.abort(id);this.runSource?.abort(id);
  for(const [key,feed] of this.eventWakeups)if(key.startsWith(id+'/'))feed.wake();
  const old=this.store.run(id);
  if(old?.schedulerVersion===2&&old.status==='failed'&&Object.values(old.nodes).some(n=>!n.modelCompleted&&!n.stopConfirmed&&(n.handle||n.submittedAt))){this.patch(id,r=>{r.cancelRequested=true;r.status='stopping'});this.tick();return this.store.run(id)}
  const run=super.stop(id);if(run.schedulerVersion===2&&run.status==='stopping')this.tick();return run;
 }
 async resume(id,config){
  const saved=this.store.config(id);if(saved?.nodeConfigs&&config?.nodeConfigs)for(let [key,c] of Object.entries(config.nodeConfigs))if(saved.nodeConfigs[key]){const old=saved.nodeConfigs[key];if(old.selection?.planner&&old.profileId!==c.profileId){const route=config.teamProfiles?.[old.profileId];if(!route)throw new ApiError('原规划入口不可用，请恢复同一入口后继续。',409);c=config.nodeConfigs[key]={...route};}if(old.selection)c.selection=structuredClone(old.selection);for(const field of ['policyRuntimePath','executionPolicy','fallbackConfig','runtimeContext','runtimeContextVersion'])if(old[field]!==undefined)c[field]=structuredClone(old[field]);}
  let run=this.store.run(id);if(!run||run.schedulerVersion!==2)return super.resume(id,config);
  if(ACTIVE.has(run.status))return run;if(run.status==='succeeded')throw new ApiError('此工作流已完成，请创建新的运行。',409);
  const old=this.store.config(id);for(const node of Object.values(run.nodes)){const a=old.nodeConfigs?.[node.id]||old,b=config.nodeConfigs?.[node.id]||config;if(a.baseUrl!==b.baseUrl)throw new ApiError('请连接此任务原来的后端后再重试。',409)}
  // A failed stage upload resumes at the checkpoint barrier, without another model request.
  for(const nodeId of Object.keys(run.nodes)){
   const node=run.nodes[nodeId];
   if(node.outputReady)continue;
   if(node.status==='succeeded'&&node.modelCompleted){node.error=null;continue}
   if(node.budgetRecovery?.state==='storage-blocked'){node.budgetRecovery.state='stopping';node.status='pending';node.error=null;node.resumeRequested=false;continue}
   if(node.status==='failed'){
    if(nodeId==='plan'&&node.planningRejected&&run.adaptivePlan?.status==='pending'){
     const archive=await this.archiveFor(run,node),repair=await preparePlanRepair(this,id,new ApiError(node.error||'规划未通过校验。'),archive,{automatic:false});
     if(repair?.cancelled)return this.store.run(id);if(repair?.prepared){run=this.store.run(id);continue;}
    }
    const c=config.nodeConfigs?.[node.id]||config;let info;try{info=await conversation(c,node.handle?.conversationId||node.conversationId)}catch(e){if(e.status!==404)throw e}
    if(!info||['finished','error','stuck'].includes(info.execution_status)){if(info){node.conversationId=randomUUID();node.submittedAt=null}else node.budgetStartedAt=new Date().toISOString();node.handle=null;node.output='';node.cursor=null;node.since=null;node.fatal=null;node.modelCompleted=false;node.snapshotReady=false;node.checkpoint=null;node.finishedAt=null;node.planningRejected=false;node.modelUsage=null;node.selectionApplied=false;node.reasoningEffortUsed=null}
   }
   if(node.budgetRecovery?.state==='exhausted'){node.budgetRecovery=null;node.budgetStartedAt=new Date().toISOString();}node.resumeRequested=true;node.status='pending';node.error=null;node.stopConfirmed=false;
  }
  if(this.closed)return run;this.store.setConfig(id,config);run.error=null;run.cancelRequested=false;run.status='queued';run.finishedAt=null;this.store.saveRun(run,{resetCancel:true});this.log(id,'workflow','已恢复未完成分支；成功分支与文件快照保留，不会重复调用。');this.tick();return this.store.run(id);
 }
 async execute(id){
  if(this.store.run(id)?.schedulerVersion===2)return this.executeDag(id);
  while(!this.closed&&this.nodeActive.size>=this.maxNodeActive)await sleep(Math.max(20,Math.min(this.pollMs,500)));
  if(this.closed)return;const key=id+'/legacy';this.nodeActive.add(key);try{return await super.execute(id)}finally{this.nodeActive.delete(key)}
 }
 ready(node){return node.status==='succeeded'&&node.outputReady===true}
 async executeDag(id){
  const tasks=new Map();if(this.store.run(id).status!=='stopping')this.patch(id,r=>{r.status='running';r.error=null});
  try{while(!this.closed){
   let run=this.store.run(id);if(!run)return;
   if(run.cancelRequested){
    this.patch(id,r=>{r.status='stopping';r.activeNodeIds=[...tasks.keys()]});
    // Restart recovery must also stop every previously started branch.
    for(const node of Object.values(run.nodes))if(!tasks.has(node.id)&&!this.ready(node)&&!node.modelCompleted&&!node.stopConfirmed&&(node.handle||node.submittedAt||['running','reconnecting','paused'].includes(node.status)))this.launch(id,node,tasks,true);
    if(!tasks.size){this.patch(id,r=>{r.status='cancelled';r.error=null;r.activeNodeIds=[];r.finishedAt=new Date().toISOString()});this.log(id,'workflow','所有已启动分支均已确认停止，成功阶段已保留。');return}
   }else{
    if(run.adaptivePlan?.status==='pending'&&this.ready(run.nodes.plan)){await this.expandPlan(id);run=this.store.run(id)}
    for(const nodeId of run.order){
     run=this.store.run(id);const node=run.nodes[nodeId];if(run.cancelRequested)break;
     if(tasks.has(nodeId)||this.ready(node)||node.budgetRecovery?.state!=='stopping'&&(['failed','paused'].includes(node.status)||node.error))continue;
     const inferenceTasks=[...tasks.keys()].filter(id=>!run.nodes[id].modelCompleted).length;
     if(!node.modelCompleted&&inferenceTasks>=run.maxParallelNodes)continue;
     if(this.stageActive.size>=this.maxStageActive&&!this.stageActive.has(id+'/'+nodeId))continue;
     if(!node.modelCompleted&&this.nodeActive.size>=this.maxNodeActive&&!this.nodeActive.has(id+'/'+nodeId))continue;
     if(!(node.dependencies||[]).every(p=>this.ready(run.nodes[p])))continue;
     this.launch(id,node,tasks,false);
    }
    if(this.store.run(id).cancelRequested)continue;
    if(!tasks.size){
     run=this.store.run(id);const values=Object.values(run.nodes),failed=values.filter(n=>n.budgetRecovery?.state!=='stopping'&&(n.status==='failed'||n.error)),paused=values.filter(n=>n.status==='paused'&&n.budgetRecovery?.state!=='stopping');
     if(values.every(n=>this.ready(n))){await this.finalizeDag(run);return}
     if(failed.length){this.patch(id,r=>{r.status='failed';r.error=failed.map(n=>n.name+'：'+(n.error||'执行失败')).join('\n');r.activeNodeIds=[]});return}
     if(paused.length){this.patch(id,r=>{r.status='awaiting_input';r.error='分支等待后端确认或补充输入，处理后可继续。';r.activeNodeIds=[]});return}
     // Other workflows can hold the global slots. Keep waiting, without recording a false failure.
     if(this.nodeActive.size<this.maxNodeActive&&this.stageActive.size<this.maxStageActive)throw new ApiError('工作流依赖无法继续，请检查未完成的上游节点。',409);
    }
   }
   run=this.store.run(id);const active=[...tasks.keys()],completed=Object.values(run.nodes).filter(n=>this.ready(n)).length;
   if(JSON.stringify(run.activeNodeIds)!==JSON.stringify(active)||run.completedCount!==completed)this.patch(id,r=>{r.activeNodeIds=active;r.completedCount=completed;r.index=completed});
   await Promise.race([...tasks.values(),sleep(Math.max(20,Math.min(this.pollMs,500)))]);
  }}finally{if(this.closed)await Promise.allSettled([...tasks.values()])}
 }
 launch(id,node,tasks,stopping){
  const key=id+'/'+node.id;this.stageActive.add(key);if(!node.modelCompleted)this.nodeActive.add(key);
  // Reserve the branch synchronously so another tick cannot schedule it twice.
  if(!stopping)this.patch(id,r=>{if(r.nodes[node.id].status!=='succeeded')r.nodes[node.id].status='running';r.nodes[node.id].startedAt??=new Date().toISOString()});
  const promise=(stopping?this.stopNode(id,node):this.executeNode(id,node.id)).catch(error=>{
   if(this.closed)return;const run=this.store.run(id),saved=run?.nodes[node.id];if(!saved)return;this.patchNode(id,{id:node.id,status:run.cancelRequested?'reconnecting':saved.modelCompleted?'succeeded':'failed',error:error.message});this.log(id,node.id,error.message,{error:true});
  }).finally(()=>{tasks.delete(node.id);this.nodeActive.delete(key);this.stageActive.delete(key)});tasks.set(node.id,promise);
 }
 async expandPlan(id){
  let run=this.store.run(id);if(run.adaptivePlan?.status!=='pending'||run.cancelRequested)return;
  const bundle=this.store.config(id),archive=await this.archiveFor(run,run.nodes.plan);let compiled,plan;
  try{plan=await archiveOperation('plan',archive,[id]);compiled=compileAdaptivePlan(plan,run,bundle);if(compiled.summary.directDelivery)validateDirectDelivery(plan,await archiveOperation('inspect',archive,[id]))}
  catch(error){if(this.closed)return;if(error.status===400){const repair=await preparePlanRepair(this,id,error,archive);if(repair)return;this.patchNode(id,{id:'plan',status:'failed',outputReady:false,modelCompleted:false,planningRejected:true,error:error.message});}throw error}
  if(this.closed)return;run=this.store.run(id);if(run.cancelRequested||run.adaptivePlan?.status!=='pending')return;
  const deps=dependencies(compiled.workflow);for(const definition of compiled.workflow.nodes.filter(n=>isAgent(n)&&n.id!=='plan')){const c=compiled.nodeConfigs[definition.id],selection=c.selection;run.nodes[definition.id]={id:definition.id,name:definition.name,phase:definition.phase,status:'pending',conversationId:randomUUID(),handle:null,output:'',cursor:null,since:null,fatal:null,profileId:c.profileId,profileLabel:c.profileLabel,server:c.server,workspace:c.workspace.replace(/\/$/,'')+'/runs/'+id+'/'+definition.id,modelUsed:selection?.model||c.acpModel||c.model,modelSelection:selection||null,modelRequested:selection?.model,reasoningEffort:selection?.effort,...(c.runtimeContext?{runtimeContextRequested:c.runtimeContext}:{}),dependencies:deps[definition.id],inputReady:false,outputReady:false}}
  run.workflow=compiled.workflow;run.order=compiled.workflow.nodes.filter(isAgent).map(n=>n.id);run.maxParallelNodes=compiled.workflow.maxParallelNodes;run.adaptivePlan={status:'applied',plannerId:'plan',sha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex'),appliedAt:new Date().toISOString(),...compiled.summary};
  this.store.db.exec('BEGIN IMMEDIATE');try{this.store.setConfig(id,{...bundle,nodeConfigs:compiled.nodeConfigs});this.store.saveRun(run);this.store.db.exec('COMMIT')}catch(error){this.store.db.exec('ROLLBACK');throw error}
  this.log(id,'workflow',compiled.summary.directDelivery?'规划 AI 已直接完成需求，成果文件通过快照校验，无需另开实现调用。':'AI 已按需求决定 '+compiled.stages.length+' 个协作阶段；以实际实现为主，仅保留必要检查。分工依据：'+plan.decisions,{success:true});
 }
 async archiveFor(run,node){
  if(node.checkpoint&&this.storage?.config().enabled)return this.storage.restoreCheckpoint(node.checkpoint,{reuseVerified:true});
  const path=join(this.handoffDirectory,'parallel',run.id,node.id+'.tar.gz');try{if((await stat(path)).size)return path}catch{}
  throw new ApiError('分支快照丢失，请先恢复对象存储阶段文件。',409);
 }
 ancestors(run,id){const result=new Set([id]);for(const p of run.nodes[id]?.dependencies||[])for(const a of this.ancestors(run,p))result.add(a);return result}
 async inputFor(run,node){
  if(node.planRepair?.version===1){
   const source=await this.archiveFor(run,node.planRepair.source),folder=join(this.handoffDirectory,'parallel',run.id),path=join(folder,node.id+'-repair-'+node.planRepair.generation+(node.fallbackCount?'-fallback-'+node.fallbackCount:'')+'-input.tar.gz');
   const report=await archiveOperation('repair',path,[],{runId:run.id,nodeId:node.id,archive:source,source:node.planRepair.source,repository:run.repositorySource,scheduler:{version:run.schedulerVersion,maxParallelNodes:run.maxParallelNodes}});return {path,report};
  }
  const parents=node.dependencies.map(p=>run.nodes[p]),sets=parents.map(p=>this.ancestors(run,p.id)),common=sets.length?run.order.filter(id=>sets.every(s=>s.has(id))):[];
  const maximal=common.filter(id=>!common.some(other=>other!==id&&this.ancestors(run,other).has(id)));
  if(maximal.length>1)throw new ApiError('汇合存在多个独立共同祖先，请先添加整合节点形成明确的文件基线。',409);
  const baseId=maximal[0],previous=!baseId&&run.workflow?.baseRunId?await this.runSource?.get(run):null,repository=!baseId&&!run.workflow?.baseRunId&&run.workflow?.repository?await this.repositorySource?.get(run):null;
  if(!baseId&&run.workflow?.baseRunId&&!previous)throw new ApiError('上轮成果导入尚未配置，未启动 AI。',409);
  if(!baseId&&!run.workflow?.baseRunId&&run.workflow?.repository&&!repository)throw new ApiError('仓库源代码导入尚未配置，未启动 AI。',409);
  const archives=await Promise.all(parents.map(async parent=>({id:parent.id,archive:await this.archiveFor(run,parent)}))),base=baseId?(archives.find(p=>p.id===baseId)?.archive||await this.archiveFor(run,run.nodes[baseId])):undefined;
  const describe=p=>({id:p.id,name:p.name,profileId:p.profileId,server:p.server,model:p.modelUsed,conversationId:p.conversationId,submittedAt:p.submittedAt,finishedAt:p.finishedAt,checkpoint:p.checkpoint||null});
  const sources=parents.map(describe),lineage=run.order.filter(id=>sets.some(s=>s.has(id))).map(id=>describe(run.nodes[id]));
  return mergeArchives({runId:run.id,nodeId:node.id,directory:this.handoffDirectory,cacheKey:node.fallbackCount?node.id+'-attempt-'+(node.fallbackCount+1):node.id,parents:archives,base:base||previous?.path||repository?.path,baseId:baseId||(previous?'previous-run':repository?'repository':undefined),sources,lineage,sourceRun:previous?{id:previous.metadata.sourceRunId,sha256:previous.metadata.archiveSha256}:run.artifactSource?{id:run.artifactSource.sourceRunId,sha256:run.artifactSource.archiveSha256}:undefined,repository:repository?.metadata||run.repositorySource,scheduler:{version:run.schedulerVersion,maxParallelNodes:run.maxParallelNodes}});
 }
 async executeNode(id,nodeId){
  let run=this.store.run(id),node={...run.nodes[nodeId]},bundle=this.store.config(id),config=bundle.nodeConfigs?.[nodeId]||bundle;
  if(this.closed)return;if(run.cancelRequested)return this.stopNode(id,node);
  if(node.budgetRecovery?.state==='stopping')return recoverBudget(this,id,node,config);
  if(node.status==='succeeded'&&node.modelCompleted)return this.persistDagStage(id,node,config);
  node.status='running';this.patchNode(id,node);
  if(!node.workspaceReady){await upstream(config,'/api/file/create_directory?'+new URLSearchParams({path:node.workspace}),{method:'POST',allowEmpty:true});if(this.closed)return;node.workspaceReady=true;this.patchNode(id,node)}
  if(!node.handle){
   let existing;try{if(node.submittedAt)existing=await conversation(config,node.conversationId)}catch(e){if(e.status!==404)throw e}
   if(this.closed)return;
   if(existing)node.handle={kind:'conversation',id:existing.id,conversationId:existing.id};
   else{
    if(!node.inputReady){
     const input=await this.inputFor(this.store.run(id),node);if(this.closed)return;node.mergeReport=input.report;
     this.log(id,node.id,'正在从各上游快照汇合文件（'+node.dependencies.length+' 个依赖）。');
     node.handoffMetrics=await transferWorkspace({runId:id,nodeId:node.id,source:config,target:config,sourceWorkspace:node.workspace+'/input-source',targetWorkspace:node.workspace,directory:this.handoffDirectory,sourceArchive:input.path,targetRoot:basename(node.workspace)});
     if(this.closed)return;node.inputReady=true;node.inputReadyAt=new Date().toISOString();node.inputArchive=input.path;
     node.inputPersistenceVersion=1;node.inputStored=!this.storage?.config().enabled;
     if(this.closed)return;this.patchNode(id,node);this.saveInput(id,node);
    }
    if(this.store.run(id).cancelRequested)return this.stopNode(id,node);
    const definition=run.workflow.nodes.find(n=>n.id===node.id),parents=run.workflow.coordinationPolicy==='lean'?compactHandoffs(node.dependencies.map(p=>this.store.run(id).nodes[p])):node.dependencies.map(p=>this.store.run(id).nodes[p]).filter(n=>n.output).map(n=>'【'+n.name+' 的交接信息】\n'+n.output.slice(-18000)).join('\n\n');
    if(config.selection?.mode==='auto'&&['auto','planner'].includes(config.selection.source)&&node.mergeReport?.conflicts?.length){config={...config,selection:chooseModel(config,{...definition,modelPolicy:undefined},{...run.workflow,taskComplexity:'complex'},config.policyModels)};config.selection.reason+=' · 文件冲突升级';const latest=this.store.config(id);latest.nodeConfigs[node.id]=config;this.store.setConfig(id,latest);node.modelSelection=config.selection;node.modelRequested=config.selection.model;node.reasoningEffort=config.selection.effort;this.patchNode(id,node)}
    const conflictInstructions=node.mergeReport?.conflicts?.length?'\n\n存在文件冲突，先读取 .canvas-collaboration/handoff.json。各分支文件完整保存在 .canvas-collaboration/inputs/<parent>/<path>，基线在 .canvas-collaboration/base/。请整合解决，禁止忽略冲突；写 .canvas-collaboration/resolutions.json：{"resolutions":{"相对路径":{"source":"custom 或 parent ID 或 base 或 delete","sha256":"最终文件真实SHA-256（删除用null）","reason":"解决原因"}}}}。每个冲突路径必须有记录，整合后用 sha256sum 校验。':'';
    const collaborationInstructions=node.id==='plan'&&run.adaptivePlan?.status==='pending'?planningInstructions(bundle.teamProfiles,run.workflow,executionHistory(this.store,bundle.teamProfiles),traceObservations(bundle.teamProfiles)):'';
    const previous=this.store.run(id).artifactSource,source=this.store.run(id).repositorySource,repositoryInstructions=previous?'\n\n上一轮成功运行 '+previous.sourceRunId+' 的完整成果已按 SHA-256 校验并装入当前目录。基于已有代码和测试完成本次增量需求，保留无关行为及文件；不重复生成整个项目。':source?'\n\n仓库源代码已按提交 '+source.commitSha+' 装入当前目录，来源 '+source.repository+'（'+source.ref+'）。基于此快照实现需求，保留无关文件；仓库凭据由控制器管理。':'';
    const repairInstructions=node.planRepair?'\n\n上一轮规划未通过校验：'+node.planRepair.error+'。已将经过校验的已有成果加载到此隔离目录；原计划（如有）保存在 .canvas-collaboration/rejected-plan.json。保留已有实现，针对这个错误修正 plan.json 及确有缺失的交付文件，不重新生成整个项目，不另设审查。':'';
    const prompt='你是自托管引擎派发的执行分支，接入已完成；直接在本次隔离目录完成给定职责。协作分工通过本次 plan.json 交给引擎派发。'+(collaborationInstructions?collaborationInstructions+'\n\n':'')+'\n\n用户任务：\n'+run.workflow.task+'\n\n你的职责：\n'+definition.prompt+(parents?'\n\n'+parents:'')+'\n\n你在隔离的分支工作目录：'+node.workspace+'。其他 AI 可能同时工作；只修改自己负责的文件，不修改用户其他目录。上游文件已经合并到此目录，交接元数据在 .canvas-collaboration/handoff.json。保留上游内容，给出文件、接口契约与下游注意事项。'+repositoryInstructions+conflictInstructions+repairInstructions;
    this.log(id,node.id,'正在并行提交至 '+(node.profileLabel||node.profileId)+'。');node.submittedAt??=new Date().toISOString();this.patchNode(id,node);
    try{node.handle=await startConversation({...config,workspace:node.workspace},{conversationId:node.conversationId,prompt,system:run.workflow.coordinationPolicy==='lean'?'你是引擎调度的执行分支，在当前目录直接完成给定职责；协作分工通过本次 plan.json 交给引擎派发。优先实现需求，说明简短，必要验证一次。':definition.prompt,model:definition.liveModel,temperature:definition.temperature,tools:definition.tools,repository:run.workflow.repository,branch:run.workflow.branch,maxIterations:run.workflow.maxIterations})}
    catch(error){let recovered;try{recovered=await conversation(config,node.conversationId)}catch{}if(recovered)node.handle={kind:'conversation',id:recovered.id,conversationId:recovered.id};else throw error}
   }
   if(this.closed)return;this.patchNode(id,node);
  }
  if(node.resumeRequested){let info=await conversation(config,node.handle.conversationId);if(info.execution_status==='paused')await upstream(config,'/api/conversations/'+node.handle.conversationId+'/run',{method:'POST',allowEmpty:true});node.resumeRequested=false;this.patchNode(id,node)}
  this.saveInput(id,node);
  const feed=new EventWakeup(config,node.handle.conversationId),feedKey=id+'/'+node.id;this.eventWakeups.set(feedKey,feed);let reconnects=0;
  try{while(!this.closed){
   const eventVersion=feed.version;
   if(this.store.run(id).cancelRequested)return this.stopNode(id,node);
   try{
    const info=await conversation(config,node.handle.conversationId);if(this.closed)return;if(info.current_model_id)node.modelUsed=info.current_model_id;
    if(node.modelSelection&&!node.selectionApplied&&info.execution_status==='running'){const receipt=await this.readSelectionReceipt(config,node);if(receipt){node.selectionApplied=true;node.reasoningEffortUsed=receipt.effort;node.reasoningSource=receipt.effortSource;this.patchNode(id,node)}}
    let more=await this.pullDagEvents(id,node,config);for(let page=0;page<10&&more;page++)more=await this.pullDagEvents(id,node,config);if(this.closed)return;if(more)continue;
    if(node.fatal)throw new ApiError(node.fatal,400);
    if(['ERROR','MISSING'].includes(info.sandbox_status))throw new ApiError('执行沙箱不可用：'+info.sandbox_status,400);
    if(info.execution_status==='finished'){
     if(!node.output.trim())throw new ApiError('模型没有返回可用的文本结果，请检查后端配置。',400);
     // Record model completion before network-dependent snapshot capture: retries must not repeat inference.
     node.status='succeeded';node.modelCompleted=true;node.finishedAt=new Date().toISOString();node.error=null;node.snapshotReady=false;this.patchNode(id,node);this.nodeActive.delete(id+'/'+node.id);this.log(id,node.id,'AI 已完成，正在校验并保存阶段文件。',{success:true});await this.persistDagStage(id,node,config);return;
    }
    if(['error','stuck'].includes(info.execution_status))throw new ApiError(node.output||'智能体执行失败：'+info.execution_status,400);
    if(['waiting_for_confirmation','paused'].includes(info.execution_status)){node.status='paused';node.error=null;this.patchNode(id,node);this.log(id,node.id,'此分支等待后端确认，其他分支继续运行。');return}
    if(budgetExpired(node,config,this.clock()))return recoverBudget(this,id,node,config);
    reconnects=0;node.status='running';node.error=null;this.patchNode(id,node);const remaining=config.executionPolicy?Math.max(20,config.executionPolicy.budgetSeconds*1000-(this.clock()-Date.parse(node.budgetStartedAt||node.submittedAt))):this.pollMs;await feed.wait(eventVersion,Math.min(this.pollMs,remaining));
   }catch(error){if(error.status>=500&&!node.modelCompleted&&budgetExpired(node,config,this.clock()))return recoverBudget(this,id,node,config);if(error.status>=500&&reconnects++<12&&!node.modelCompleted){node.status='reconnecting';node.error=null;this.patchNode(id,node);if(reconnects===1)this.log(id,node.id,'此分支连接暂时中断，其他分支继续执行，服务器自动重连。');await sleep(Math.min(15000,2000*reconnects));continue}throw error}
  }}finally{feed.close();this.eventWakeups.delete(feedKey)}
 }
 async pullDagEvents(id,node,config){
  const query=new URLSearchParams({limit:'100',sort_order:'TIMESTAMP'});if(node.cursor)query.set('page_id',node.cursor);else if(node.since)query.set('timestamp__gte',node.since);
  const page=await upstream(config,'/api/conversations/'+node.handle.conversationId+'/events/search?'+query);if(this.closed)return false;
  const next={...node};
  // Events and the cursor/output they produced form one durable checkpoint.
  // Besides one fsync per page, this prevents a restart from losing output
  // after saving its external event ID. No network call holds the transaction.
  this.store.db.exec('BEGIN IMMEDIATE');
  try{
   for(const raw of page.items||[]){if(raw.timestamp&&(!next.since||raw.timestamp>next.since))next.since=raw.timestamp;const event=eventSummary(raw,config);if(!event)continue;this.store.addEvent(id,node.id,event);if(event.output&&event.text&&!next.output.includes(event.text))next.output=((next.output?next.output+'\n\n':'')+event.text).slice(-120000);if(event.fatal)next.fatal=event.text}
   next.cursor=page.next_page_id||null;this.patchNode(id,next);this.store.db.exec('COMMIT');
  }catch(error){this.store.db.exec('ROLLBACK');throw error}
  Object.assign(node,next);return !!node.cursor;
 }
 saveInput(id,node){
  if(node.inputPersistenceVersion!==1||node.inputStored||!this.storage?.config().enabled)return Promise.resolve({ok:true});
  const key=id+'/'+node.id+'/'+node.conversationId;if(this.inputTasks.has(key))return this.inputTasks.get(key);
  const promise=(async()=>{try{await this.storage.persistInput(id,node);node.inputStored=true;node.inputStorageError=null;if(!this.closed&&this.store.run(id)?.nodes[node.id]?.conversationId===node.conversationId)this.patchNode(id,{id:node.id,inputStored:true,inputStorageError:null});return {ok:true}}catch{const message='输入快照尚未完整写入数据桶，请继续以重试存储；已完成的 AI 保留。';node.inputStorageError=message;if(!this.closed&&this.store.run(id)?.nodes[node.id]?.conversationId===node.conversationId)this.patchNode(id,{id:node.id,inputStorageError:message});return {ok:false,error:new ApiError(message,502)}}finally{this.inputTasks.delete(key)}})();this.inputTasks.set(key,promise);return promise;
 }
 async persistDagStage(id,node,config,archive){
  const run=this.store.run(id),inputStored=await this.saveInput(id,node);if(!inputStored.ok)throw inputStored.error;
  try{archive??=node.snapshotReady?await this.archiveForLocal(run,node,config):await captureNode(config,node,id,this.handoffDirectory);const validation=await validateMerge(archive,id,{...node.mergeReport,selection:node.modelSelection?{model:node.modelSelection.model,effort:node.modelSelection.effort,requestId:node.conversationId}:null});node.modelUsage=validation.modelUsage||null}
  catch(error){if(error.status===400){node.modelCompleted=false;node.status='failed';node.snapshotReady=false;this.patchNode(id,node)}throw error}
  if(this.closed)return;node.snapshotReady=true;node.snapshotReadyAt??=new Date().toISOString();this.patchNode(id,node);
  if(this.storage?.config().enabled){node.checkpoint=await this.storage.checkpoint(run,node,config,{archivePath:archive});if(this.closed)return}
  node.outputReady=true;node.outputReadyAt=new Date().toISOString();node.error=null;if(node.modelSelection){node.selectionApplied=true;node.reasoningEffortUsed=node.modelSelection.effort}this.patchNode(id,node);this.log(id,node.id,this.storage?.config().enabled?'阶段快照已写入数据桶，下游依赖已解锁。':'阶段快照已校验，下游依赖已解锁。',{success:true});
 }
 async readSelectionReceipt(config,node){try{const r=await fetch(config.baseUrl+'/api/file/download?'+new URLSearchParams({path:node.workspace+'/.canvas-collaboration/runtime-selection.json'}),{headers:{'X-Session-API-Key':config.apiKey},redirect:'manual',signal:AbortSignal.timeout(5000)});if(!r.ok)return null;const text=await r.text();if(text.length>16000)return null;const v=JSON.parse(text);return v.requestId===node.conversationId&&v.model===node.modelSelection.model&&v.effort===node.modelSelection.effort&&v.modelApplied===true&&v.effortApplied===true?v:null}catch{return null}}
 async archiveForLocal(run,node,config){const path=join(this.handoffDirectory,'parallel',run.id,node.id+'.tar.gz');try{if((await stat(path)).size)return path}catch{}return captureNode(config,node,run.id,this.handoffDirectory)}
 async stopNode(id,node){
  if(this.closed)return;const bundle=this.store.config(id),config=bundle.nodeConfigs?.[node.id]||bundle;
  let absent=0;
  while(!this.closed&&!node.handle){
   try{const info=await conversation(config,node.conversationId);node.handle={kind:'conversation',id:info.id,conversationId:info.id};this.patchNode(id,node)}
   catch(error){
    if(error.status===404){if(++absent>=2){this.patchNode(id,{id:node.id,status:'paused',error:null,stopConfirmed:true});return}}
    else{absent=0;this.patchNode(id,{id:node.id,status:'reconnecting',error:'停止前查询后端暂时失败，仍在确认此分支。'});if(!node.stopLookupWarning){this.log(id,node.id,'停止前查询后端暂时失败，将持续重试，尚未确认取消。');node.stopLookupWarning=true}}
    await sleep(Math.max(50,Math.min(1000,this.pollMs)));
   }
  }
  if(this.closed)return;
  let confirmations=0,lastRequest=0,attempts=0;
  while(!this.closed){try{
   if(Date.now()-lastRequest>Math.max(50,Math.min(5000,this.pollMs*2))){try{await upstream(config,'/api/conversations/'+node.handle.conversationId+'/interrupt',{method:'POST',allowEmpty:true})}catch(e){if(![404,405].includes(e.status))throw e;await upstream(config,'/api/conversations/'+node.handle.conversationId+'/pause',{method:'POST',allowEmpty:true})}lastRequest=Date.now()}
   const info=await conversation(config,node.handle.conversationId);confirmations=['paused','finished','error','stuck','idle'].includes(info.execution_status)?confirmations+1:0;
   if(confirmations>=2){this.patchNode(id,{id:node.id,status:'paused',error:null,stopConfirmed:true});this.log(id,node.id,'此分支已确认停止。');return {executionStatus:info.execution_status}}
  }catch{confirmations=0;if(attempts===0)this.log(id,node.id,'此分支停止尚未确认，将继续重试。')}
  attempts++;await sleep(Math.max(50,Math.min(1000,this.pollMs)))}
 }
 async finalizeDag(run){
  const leaves=run.order.filter(id=>!Object.values(run.nodes).some(n=>n.dependencies.includes(id)));let path;
  if(leaves.length===1)path=await this.archiveFor(run,run.nodes[leaves[0]]);
  else{const merged=await this.inputFor(run,{id:'final-delivery',dependencies:leaves});if(merged.report.conflicts.length)throw new ApiError('最终分支仍有文件冲突，请在画布增加整合节点后重新运行。',409);path=merged.path}
  if(this.closed)return;const folder=join(this.handoffDirectory,'artifacts');await mkdir(folder,{recursive:true,mode:0o700});await copyFile(path,join(folder,run.id+'.tar.gz'));if(this.closed)return;
  this.patch(run.id,r=>{r.status='succeeded';r.error=null;r.completedCount=r.order.length;r.index=r.order.length;r.activeNodeIds=[];r.finishedAt=new Date().toISOString()});this.log(run.id,'workflow','全部分支已完成并汇合，交付文件已保存。',{success:true});
 }
}
