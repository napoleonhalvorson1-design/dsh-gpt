import {randomUUID} from 'node:crypto';
import {mkdir,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {redact} from '../shared/openhands.mjs';

// One automatic correction belongs to the requested task, never to storage
// recovery or historical runs. New request identity is durable before dispatch.
export async function preparePlanRepair(engine,id,error,archive,{automatic=true}={}){
 const run=engine.store.run(id),node=run?.nodes.plan,config=engine.store.config(id)?.nodeConfigs?.plan;
 if(!node||run.adaptivePlan?.status!=='pending')return null;
 if(automatic&&(run.planRepairVersion!==1||run.cancelRequested||node.autoPlanRepairCount||!node.outputReady||!node.modelCompleted||!node.modelSelection?.planner||!node.modelSelection?.verified))return null;
 if(!automatic&&!node.planningRejected)return null;
 const budget=config?.executionPolicy?.budgetSeconds,started=Date.parse(node.budgetStartedAt||node.submittedAt);
 if(automatic&&budget&&(!Number.isFinite(started)||budget*1000-((engine.clock?.()??Date.now())-started)<30000))return null;
 const generation=(node.planRepair?.generation||0)+1,alias='plan-rejected-'+generation,folder=join(engine.handoffDirectory,'parallel',id);
 await mkdir(folder,{recursive:true,mode:0o700});await copyFile(archive,join(folder,alias+'.tar.gz'));
 if(engine.closed)return {cancelled:true};const latest=engine.store.run(id);
 if(latest.nodes.plan.conversationId!==node.conversationId||latest.adaptivePlan?.status!=='pending')return {cancelled:true};
 if(latest.cancelRequested&&(automatic||!run.cancelRequested||latest.status==='stopping'&&run.status!=='stopping'))return {cancelled:true};
 const now=new Date().toISOString(),attempt={conversationId:node.conversationId,profileId:node.profileId,modelRequested:node.modelRequested,modelUsed:node.modelUsed,reasoningEffort:node.reasoningEffort,selectionApplied:node.selectionApplied===true,complexity:node.modelSelection?.complexity,workspace:node.workspace,startedAt:node.attemptStartedAt||node.startedAt,inputReadyAt:node.inputReadyAt,submittedAt:node.submittedAt,finishedAt:node.finishedAt,stopConfirmed:true,outcome:'invalid-plan',checkpoint:node.checkpoint||null};
 const workspace=(config?.workspace||node.workspace.replace(/\/runs\/[^/]+\/[^/]+$/,'')).replace(/\/$/,'')+'/runs/'+id+'/plan-repair-'+generation;
 latest.nodes.plan={...node,status:'pending',conversationId:randomUUID(),handle:null,workspace,attemptStartedAt:now,attempts:[...(node.attempts||[]),attempt],autoPlanRepairCount:(node.autoPlanRepairCount||0)+(automatic?1:0),planRepair:{version:1,generation,automatic,error:redact(error.message||String(error),config||{}).slice(0,2000),source:{id:alias,checkpoint:node.checkpoint||null},preparedAt:now},workspaceReady:false,inputReady:false,inputStored:false,inputPersistenceVersion:null,inputArchive:null,inputStorageError:null,mergeReport:null,modelCompleted:false,outputReady:false,snapshotReady:false,checkpoint:null,modelUsage:null,selectionApplied:false,reasoningEffortUsed:null,reasoningSource:null,cursor:null,since:null,fatal:null,output:'',error:null,planningRejected:false,stopConfirmed:false,resumeRequested:false,submittedAt:null,budgetStartedAt:automatic?(node.budgetStartedAt||node.submittedAt):now,inputReadyAt:null,finishedAt:null,snapshotReadyAt:null,outputReadyAt:null};
 latest.completedCount=0;latest.index=0;latest.activeNodeIds=[];
 engine.store.saveRun(latest);
 engine.log(id,'plan',automatic?'规划未通过，保留已校验成果，由同一负责人定点修正一次；不启动开发分支。':'已保留被拒绝的规划成果，继续时只针对具体错误修正。');
 return {prepared:true};
}
