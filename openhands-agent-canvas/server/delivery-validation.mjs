import {readFileSync,createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {ApiError,upstream,redact} from '../shared/openhands.mjs';
import {transferWorkspace} from './handoff.mjs';
const script=readFileSync(new URL('./delivery-check.py',import.meta.url),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export const DELIVERY_REPAIR_ID='_canvas_delivery_repair';
export function validationConfig(flow,bundle){
 if(!flow.deliveryValidation)return;
 const leader=bundle.nodeConfigs?.plan;
 if(flow.deliveryValidation.autoRepair&&(!leader?.selection?.planner||!leader.selection.verified))throw new ApiError('自动定点修复需要已验证的强规划负责人；固定工作流可设置 autoRepair=false。',409);
 return {version:1,policy:structuredClone(flow.deliveryValidation),attempts:[],repairCount:0,autoRepairCount:0,checkGeneration:0};
}
async function digest(path){const h=createHash('sha256');for await(const bytes of createReadStream(path))h.update(bytes);return h.digest('hex')}
export async function nativeCheck(config,run,attempt,operation){
 const spec={operation,root:config.workspace.replace(/\/$/,''),workspace:attempt.workspace,runId:run.id,requestId:attempt.requestId,artifactSha256:attempt.artifactSha256,command:run.deliveryCheck.policy.command,timeoutSeconds:run.deliveryCheck.policy.timeoutSeconds};
 const input=Buffer.from(JSON.stringify(spec)).toString('base64'),command='/usr/bin/python3 -I - '+input+" <<'CANVAS_DELIVERY_CHECK'\n"+script+'\nCANVAS_DELIVERY_CHECK';
 const result=await upstream(config,'/api/bash/execute_bash_command',{method:'POST',body:{command,timeout:10},timeoutMs:15000});
 let receipt;try{receipt=JSON.parse(result.stdout)}catch{}
 if(result.exit_code!==0||receipt?.requestId!==attempt.requestId||receipt.artifactSha256!==attempt.artifactSha256||receipt.commandSha256!==createHash('sha256').update(spec.command).digest('hex')||!['missing','starting','running','passed','failed','cancelled','uncertain'].includes(receipt.status))throw new ApiError('交付检查缺少匹配的执行回执，未重跑命令或模型。',502);
 if(receipt.status==='passed'&&receipt.exitCode!==0)throw new ApiError('交付检查未确认成功退出。',502);
 if(receipt.status==='failed'&&(!Number.isInteger(receipt.exitCode)||receipt.exitCode===0))throw new ApiError('交付检查未确认真实失败，未调用修复模型。',502);
 return {...receipt,...(receipt.output?{output:redact(receipt.output,config).slice(-4000)}:{})};
}
function patch(engine,id,change){engine.patch(id,r=>Object.assign(r.deliveryCheck,change))}
export async function prepareDeliveryRepair(engine,run,receipt,{manual=false}={}){
 if(!manual&&(!run.deliveryCheck.policy.autoRepair||run.deliveryCheck.autoRepairCount))return false;
 const bundle=engine.store.config(run.id),leader=bundle.nodeConfigs?.plan;
 if(!leader?.selection?.planner||!leader.selection.verified)return false;
 const generation=run.deliveryCheck.repairCount+1,id=DELIVERY_REPAIR_ID+(generation>1?'_'+generation:''),parents=run.order.filter(id=>!Object.values(run.nodes).some(n=>n.dependencies.includes(id))),model=leader.selection;
 const definition={id,type:'code',phase:'integrate',name:'按检查错误定点修复',executionProfile:leader.profileId,liveModel:model.model,reasoningEffort:model.effort,tools:['文件读写','终端'],x:0,y:0,prompt:'指定交付检查失败（退出码 '+receipt.exitCode+'）：\n'+(receipt.output||receipt.reason||'命令返回非零状态')+'\n\n完整已校验成果已继承。保留已有文件，只修具体失败，不重新生成项目、不另写计划或审查报告。引擎会在修复后自动重跑相同指定检查一次，不重复执行该检查。'};
 const repairConfig={...leader,selection:{...model},executionPolicy:{budgetSeconds:leader.executionPolicy?.budgetSeconds||300}};delete repairConfig.fallbackConfig;
 const latest=engine.store.run(run.id);if(engine.closed||!manual&&latest.cancelRequested||latest.deliveryCheck.repairCount!==run.deliveryCheck.repairCount)return false;
 latest.workflow.nodes.splice(latest.workflow.nodes.length-1,0,definition);latest.workflow.edges=latest.workflow.edges.filter(([from,to])=>!(to==='end'&&parents.includes(from)));latest.workflow.edges.push(...parents.map(p=>[p,id]),[id,'end']);
 latest.nodes[id]={id,name:definition.name,phase:definition.phase,status:'pending',conversationId:randomUUID(),handle:null,output:'',cursor:null,since:null,fatal:null,profileId:leader.profileId,profileLabel:leader.profileLabel,server:leader.server,workspace:leader.workspace.replace(/\/$/,'')+'/runs/'+run.id+'/'+id,modelUsed:model.model,modelRequested:model.model,modelSelection:{...model},reasoningEffort:model.effort,dependencies:parents,inputReady:false,outputReady:false};
 if(latest.deliveryCheck.current&&!latest.deliveryCheck.attempts.some(a=>a.requestId===latest.deliveryCheck.current.requestId))latest.deliveryCheck.attempts.push(latest.deliveryCheck.current);
 latest.order.push(id);latest.deliveryCheck.repairCount=generation;latest.deliveryCheck.autoRepairCount=(latest.deliveryCheck.autoRepairCount||0)+(manual?0:1);latest.deliveryCheck.current=null;
 if(latest.adaptivePlan?.directDelivery){latest.adaptivePlan.initialDirectDelivery=true;latest.adaptivePlan.directDelivery=false;latest.adaptivePlan.deliveryRepair=true}
 engine.store.db.exec('BEGIN IMMEDIATE');try{engine.store.setConfig(run.id,{...bundle,nodeConfigs:{...bundle.nodeConfigs,[id]:repairConfig}});engine.store.saveRun(latest);engine.store.db.exec('COMMIT')}catch(e){engine.store.db.exec('ROLLBACK');throw e}
 engine.log(run.id,id,'指定检查失败，已保留完整成果，交给原强负责人定点修复一次。');return true;
}
export async function validateDelivery(engine,initial,path,leaves){
 if(initial.deliveryCheck?.version!==1)return;
 let run=engine.store.run(initial.id),state=run.deliveryCheck,bundle=engine.store.config(run.id),attempt=state.current;
 const config=bundle.nodeConfigs?.plan||bundle.nodeConfigs?.[leaves[0]]||bundle;
 if(config.mode!=='remote')throw new ApiError('指定交付检查需要自托管执行入口。',409);
 if(!attempt){
  const artifactSha256=await digest(path);if(engine.closed)return {pending:true};run=engine.store.run(run.id);if(run.cancelRequested)return {pending:true};
  attempt={requestId:randomUUID(),artifactSha256,sourceNodeIds:[...leaves],workspace:config.workspace.replace(/\/$/,'')+'/runs/'+run.id+'/delivery-check-'+state.repairCount+'-'+(state.checkGeneration||0),inputReady:false,status:'preparing'};
  patch(engine,run.id,{current:attempt});engine.log(run.id,'workflow','实现已完成，正在准备指定交付检查。');
 }
 if(!attempt.checkpoint){
  const source={id:'_canvas_delivery_source_'+state.repairCount+'_'+(state.checkGeneration||0),conversationId:attempt.requestId,name:'交付检查的固定源码',status:'succeeded'};
  const existing=leaves.length===1?run.nodes[leaves[0]].checkpoint:null;
  const checkpoint=existing?.sha256===attempt.artifactSha256?existing:await engine.storage.checkpoint(run,source,config,{archivePath:path});if(engine.closed)return {pending:true};
  attempt={...attempt,checkpoint};patch(engine,run.id,{current:attempt});
 }
 // Restore and hash the exact frozen input on every recovery. A check never
 // silently migrates to a new tree or overwrites a remotely submitted workspace.
 path=await engine.storage.restoreCheckpoint(attempt.checkpoint,{reuseVerified:true});if(await digest(path)!==attempt.artifactSha256)throw new ApiError('交付检查源码哈希不一致。',409);
 if(!attempt.inputReady){
  if(engine.closed||engine.store.run(run.id).cancelRequested)return {pending:true};
  await upstream(config,'/api/file/create_directory?'+new URLSearchParams({path:attempt.workspace}),{method:'POST',allowEmpty:true});
  await transferWorkspace({runId:run.id,nodeId:'delivery-check-'+state.repairCount,source:config,target:config,sourceWorkspace:run.workspace,targetWorkspace:attempt.workspace,directory:engine.handoffDirectory,sourceArchive:path});
  if(engine.closed)return {pending:true};attempt={...attempt,inputReady:true};patch(engine,run.id,{current:attempt});
 }
 let receipt=['passed','failed','cancelled'].includes(attempt.status)?attempt:null;
 while(!engine.closed&&!['passed','failed','cancelled'].includes(receipt?.status)){
  run=engine.store.run(run.id);
  // A lost start acknowledgement is recovered using this reserved native ID.
  // Status is read before start; an unknown old claim is never replayed.
  receipt=await nativeCheck(config,run,attempt,run.cancelRequested?'cancel':'status');
  if(receipt.status==='missing'&&!run.cancelRequested){if(attempt.dispatchAttempted)throw new ApiError('原交付检查回执缺失，执行结果不确定；未重跑命令或模型。',502);attempt={...attempt,dispatchAttempted:true};patch(engine,run.id,{current:attempt});receipt=await nativeCheck(config,run,attempt,'start');}
  patch(engine,run.id,{current:{...attempt,...receipt}});
  if(['passed','failed','cancelled'].includes(receipt.status))break;
  if(receipt.status==='uncertain')throw new ApiError('交付检查结果不确定，请核对后继续；不会自动重跑命令或模型。',502);
  if(run.cancelRequested&&receipt.status==='missing')return {pending:true};
  await delay(Math.max(20,Math.min(engine.pollMs,500)));
 }
 if(engine.closed)return {pending:true};run=engine.store.run(run.id);
 if(run.cancelRequested||receipt.status==='cancelled')return {pending:true};
 const attempts=[...state.attempts.filter(a=>a.requestId!==attempt.requestId),{...attempt,...receipt}];patch(engine,run.id,{attempts,current:{...attempt,...receipt}});
 if(receipt.status==='passed'){if(attempt.status!=='passed')engine.log(run.id,'workflow','指定交付检查已通过。',{success:true});return {passed:true};}
 if(await prepareDeliveryRepair(engine,engine.store.run(run.id),receipt))return {repairPrepared:true};
 throw new ApiError('指定交付检查未通过：'+(receipt.output||receipt.reason||'退出码 '+receipt.exitCode),400);
}
export async function stopDeliveryCheck(engine,run){
 const attempt=run.deliveryCheck?.current;if(!attempt?.inputReady||['passed','failed','cancelled'].includes(attempt.status))return;
 const bundle=engine.store.config(run.id),leaves=run.order.filter(id=>!Object.values(run.nodes).some(n=>n.dependencies.includes(id))),config=bundle.nodeConfigs?.plan||bundle.nodeConfigs?.[leaves[0]]||bundle;
 while(!engine.closed){const receipt=await nativeCheck(config,run,attempt,'cancel');patch(engine,run.id,{current:{...attempt,...receipt}});if(['missing','passed','failed','cancelled'].includes(receipt.status))return;if(receipt.status==='uncertain')throw new ApiError('交付检查停止尚未确认，请核对后继续停止；未派发修复。',502);await delay(Math.max(20,Math.min(engine.pollMs,500)))}
}
