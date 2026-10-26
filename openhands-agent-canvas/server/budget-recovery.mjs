import {randomUUID} from 'node:crypto';
import {ApiError} from '../shared/openhands.mjs';

export async function recoverBudget(engine,id,initial,config){
 let node={...engine.store.run(id).nodes[initial.id]};
 if(!node.budgetRecovery||node.budgetRecovery.state!=='stopping'){
  node.budgetRecovery={state:'stopping',reason:'execution-budget',requestedAt:new Date().toISOString(),conversationId:node.conversationId};
  node.status='reconnecting';node.error=null;engine.patchNode(id,node);
  engine.log(id,node.id,'执行预算已到，正在确认原会话停止；确认前不会启动后备入口。');
 }
 const stopped=await engine.stopNode(id,node);if(engine.closed)return;
 let run=engine.store.run(id);node={...run.nodes[node.id]};
 if(run.cancelRequested)return;
 node.budgetRecovery={...node.budgetRecovery,stoppedAt:node.budgetRecovery.stoppedAt||new Date().toISOString()};engine.patchNode(id,node);
 // A completed result wins the race with the deadline and interrupt request.
 if(stopped?.executionStatus==='finished'){
  let more;do{more=await engine.pullDagEvents(id,node,config);if(engine.closed)return}while(more);
  if(!node.fatal&&node.output?.trim()){
   node.status='succeeded';node.modelCompleted=true;node.finishedAt??=new Date().toISOString();node.snapshotReady=false;node.error=null;node.budgetRecovery={...node.budgetRecovery,state:'completed-before-switch'};
   engine.patchNode(id,node);engine.nodeActive.delete(id+'/'+node.id);await engine.persistDagStage(id,node,config);return;
  }
 }
 const stored=await engine.saveInput(id,node);if(engine.closed||engine.store.run(id).cancelRequested)return;
 if(!stored.ok){node.budgetRecovery={...node.budgetRecovery,state:'storage-blocked'};node.status='failed';node.error=stored.error.message;engine.patchNode(id,node);return}
 const stoppedAt=node.budgetRecovery.stoppedAt,attempt={conversationId:node.conversationId,profileId:node.profileId,modelRequested:node.modelRequested,modelUsed:node.modelUsed,reasoningEffort:node.reasoningEffort,selectionApplied:node.selectionApplied===true,complexity:node.modelSelection?.complexity,runtimeContextRequested:node.runtimeContextRequested,workspace:node.workspace,startedAt:node.attemptStartedAt||node.startedAt,inputReadyAt:node.inputReadyAt,submittedAt:node.submittedAt,stoppedAt,stopConfirmed:true,outcome:'budget-exceeded'};
 const next=config.fallbackConfig;
 if(!next||node.fallbackCount){
  node.status='failed';node.error='执行预算已到，原会话已确认停止；后备次数已用尽或未配置。';node.budgetRecovery={...node.budgetRecovery,state:'exhausted',stoppedAt};engine.patchNode(id,node);return;
 }
 const definition=run.workflow.nodes.find(n=>n.id===node.id),selection=next.selection,bundle=engine.store.config(id);
 // Commit configuration and the new request identity before any external call.
 const replacement={...node,status:'pending',conversationId:randomUUID(),handle:null,profileId:next.profileId,profileLabel:next.profileLabel,server:next.server,workspace:next.workspace.replace(/\/$/,'')+'/runs/'+id+'/'+node.id+'-fallback-1',modelUsed:selection.model,modelSelection:selection,runtimeContextRequested:next.runtimeContext||'inherit',modelRequested:selection.model,reasoningEffort:selection.effort,attemptStartedAt:new Date().toISOString(),attempts:[...(node.attempts||[]),attempt],fallbackCount:1,budgetRecovery:{...node.budgetRecovery,state:'switched',stoppedAt},workspaceReady:false,inputReady:false,inputStored:false,inputPersistenceVersion:null,inputArchive:null,mergeReport:null,outputReady:false,modelCompleted:false,snapshotReady:false,checkpoint:null,selectionApplied:false,modelUsage:null,reasoningEffortUsed:null,cursor:null,since:null,fatal:null,output:'',error:null,stopConfirmed:false,resumeRequested:false,submittedAt:null,budgetStartedAt:null,inputReadyAt:null,finishedAt:null,snapshotReadyAt:null,outputReadyAt:null};
 definition.executionProfile=next.profileId;if(next.runtimeContext)definition.runtimeContext=next.runtimeContext;definition.executionPolicy={...next.executionPolicy};
 if(run.workflow.modelMode==='auto')definition.modelPolicy={model:selection.model,effort:selection.effort,complexity:selection.complexity};
 run.nodes[node.id]=replacement;bundle.nodeConfigs??={};bundle.nodeConfigs[node.id]=next;
 engine.store.db.exec('BEGIN IMMEDIATE');try{engine.store.setConfig(id,bundle);engine.store.saveRun(run);engine.store.db.exec('COMMIT')}catch(error){engine.store.db.exec('ROLLBACK');throw new ApiError('后备切换尚未保存，请继续以恢复。',502)}
 engine.log(id,node.id,'原会话已确认停止，使用相同上游快照切换到 '+next.profileLabel+'；原目录保留。');
}
