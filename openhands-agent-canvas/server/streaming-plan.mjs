import {readFileSync,createReadStream,createWriteStream} from 'node:fs';
import {mkdir,unlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {upstream,ApiError} from '../shared/openhands.mjs';
import {archiveOperation,validateMerge} from './collaboration.mjs';
import {compileAdaptivePlan} from './adaptive.mjs';
const script=readFileSync(new URL('./stream-plan.py',import.meta.url),'utf8');
export const COORDINATOR_RESULT='_canvas_coordinator_result';
export function streamCapability(c){return c?.mode==='remote'&&c.selection?.planner&&c.selection.verified&&(c.bulkHandoff?.version===1||c.nativePlanCommitVersion===1)}
export function dataCheckpoint(run,node){return node.id==='plan'&&node.planCommitted?run.streamingPlan?.checkpoint:node.checkpoint}
export function checkCommittedPlan(archive,runId,commit){return archiveOperation('check-frozen',archive,[],{runId,files:[...commit.files,{path:'.canvas-collaboration/plan.json',sha256:commit.planSha256,mode:0o644}]})}
async function download(config,receipt,path){
 const response=await fetch(config.baseUrl+'/api/file/download?'+new URLSearchParams({path:receipt.archive}),{headers:{'X-Session-API-Key':config.apiKey},redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(!response.ok||!response.body)throw new ApiError('提前交接文件暂时无法下载。',502);
 let size=0;const hash=createHash('sha256'),limit=new Transform({transform(bytes,encoding,done){size+=bytes.length;hash.update(bytes);done(size>34*1024*1024?Error('limit'):null,bytes)}}),temporary=path+'.part';
 try{await pipeline(Readable.fromWeb(response.body),limit,createWriteStream(temporary,{mode:0o600}));if(size!==receipt.size||hash.digest('hex')!==receipt.archiveSha256)throw Error('hash');await rename(temporary,path)}catch{await unlink(temporary).catch(()=>{});throw new ApiError('提前交接文件校验失败，尚未启动下游。',502)}
}
export async function maybeStreamPlan(engine,id){
 let run=engine.store.run(id),node=run?.nodes.plan;
 if(run?.streamPlanVersion!==1||!engine.storage?.config().enabled||run.adaptivePlan?.status!=='pending'||run.streamingPlan?.checkpoint||run.cancelRequested||!node?.handle||node.modelCompleted||node.status!=='running')return;
 const key=id+'/'+node.conversationId,last=engine.streamProbes.get(key)||0;if(Date.now()-last<3000)return;engine.streamProbes.set(key,Date.now());
 const bundle=engine.store.config(id),config=bundle.nodeConfigs.plan,spec={root:config.workspace.replace(/\/$/,''),workspace:node.workspace,runId:id,requestId:node.conversationId,model:node.modelSelection.model,effort:node.reasoningEffort};
 try{
  const command='/usr/bin/python3 -I - '+Buffer.from(JSON.stringify(spec)).toString('base64')+" <<'CANVAS_STREAM_PLAN'\n"+script+'\nCANVAS_STREAM_PLAN';
  const result=await upstream(config,'/api/bash/execute_bash_command',{method:'POST',body:{command,timeout:10},timeoutMs:15000});if(result.exit_code!==0)return;const receipt=JSON.parse(result.stdout);
  if(!receipt.available)return;
  const expectedRoot=config.workspace.replace(/\/$/,'')+'/runs/'+id+'/.canvas-stream-plans/';
  if(receipt.requestId!==node.conversationId||!/^([a-f0-9]{64})$/.test(receipt.archiveSha256)||receipt.archive!==expectedRoot+receipt.archiveSha256+'.tar.gz'||!Array.isArray(receipt.files)||receipt.files.length>20)return;
  const folder=join(engine.handoffDirectory,'stream-plans',id);await mkdir(folder,{recursive:true,mode:0o700});const capture=join(folder,receipt.archiveSha256+'.tar.gz');await download(config,receipt,capture);
  const plan=await archiveOperation('plan',capture,[id]);if(plan.deliveryMode!=='streamed')return;
  compileAdaptivePlan(plan,{...run,streamingPlan:{checkpoint:{}}},bundle);
  await validateMerge(capture,id,{conflicts:[],selection:{model:spec.model,effort:spec.effort,requestId:spec.requestId}});
  const input=await engine.saveInput(id,node);if(!input.ok)return;
  const path=join(folder,receipt.archiveSha256+'-input.tar.gz');await archiveOperation('stream-commit',path,[],{runId:id,capture,base:node.inputArchive});
  const cpNode={id:'_canvas_plan_commit_'+node.conversationId,name:'负责人提前交接',conversationId:node.conversationId,status:'succeeded'};
  const checkpoint=await engine.storage.checkpoint(run,cpNode,config,{archivePath:path});
  if(!checkpoint)throw new ApiError('提前交接尚未完整写入数据桶。',502);
  if(engine.closed)return;run=engine.store.run(id);if(run.cancelRequested||run.adaptivePlan?.status!=='pending'||run.nodes.plan.conversationId!==node.conversationId||['failed','paused'].includes(run.nodes.plan.status))return;
  // A coordinator may have finished while the immutable snapshot was saved.
  if(run.nodes.plan.modelCompleted&&run.nodes.plan.checkpoint){const final=await engine.storage.restoreCheckpoint(run.nodes.plan.checkpoint,{reuseVerified:true});await checkCommittedPlan(final,id,receipt)}
  if(engine.closed)return;const latest=engine.store.run(id);if(latest.cancelRequested||latest.nodes.plan.conversationId!==node.conversationId||['failed','paused'].includes(latest.nodes.plan.status))return;
  engine.patch(id,r=>{r.streamingPlan={version:1,checkpoint,files:receipt.files,planSha256:receipt.planSha256,markerSha256:receipt.markerSha256,committedAt:new Date().toISOString()};r.nodes.plan.planCommitted=true});
  await engine.expandPlan(id);engine.log(id,'workflow','计划与接口已校验入桶，负责人继续实现，独立 AI 可并行开工。',{success:true});
 }catch(error){if(!engine.closed)engine.patch(id,r=>{r.streamCommitError='提前交接尚未完成：'+(error.status>=500?'连接或存储暂时不可用。':'计划、接口或回执未通过校验。')})}
}
export function publishCoordinatorResult(engine,id){
 const run=engine.store.run(id),parent=run.nodes.plan,result=run.nodes[COORDINATOR_RESULT];
 if(!result||!parent.modelCompleted||!parent.outputReady)return;
 engine.patchNode(id,{id:COORDINATOR_RESULT,status:'succeeded',modelCompleted:true,outputReady:true,checkpoint:parent.checkpoint,conversationId:parent.conversationId,sourceNodeId:'plan',startedAt:parent.finishedAt,inputReadyAt:parent.snapshotReadyAt,finishedAt:parent.finishedAt,snapshotReadyAt:parent.snapshotReadyAt,outputReadyAt:parent.outputReadyAt,profileId:parent.profileId,server:parent.server});
}
