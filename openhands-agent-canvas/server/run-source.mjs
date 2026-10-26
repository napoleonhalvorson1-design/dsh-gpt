import {createReadStream} from 'node:fs';
import {mkdir,stat,rename,unlink,copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {archiveOperation,mergeArchives} from './collaboration.mjs';
import {ApiError} from '../shared/openhands.mjs';

export const RUN_SOURCE_NODE_ID='_canvas_previous_run_source';
const safeId=s=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(s);
async function digest(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex')}
async function matches(path,sha){try{return (await stat(path)).isFile()&&await digest(path)===sha}catch{return false}}

// Pin only the immutable files needed to reconstruct the final tree. No old
// prompts, credentials, model configuration or execution history enter the input.
export function pinRunSource(store,storage,{id,projectId},flow){
 if(!flow.baseRunId)return null;
 if(flow.baseRunId===id)throw new ApiError('新运行不能以自身作为开发基线。',409);
 const source=store.run(flow.baseRunId);
 if(!source||source.projectId!==projectId)throw new ApiError('开发基线须为本项目的已有运行。',409);
 if(source.status!=='succeeded')throw new ApiError('请使用已经成功交付的运行作为开发基线；未完成任务使用继续。',409);
 if(!storage?.config().enabled)throw new ApiError('继承上轮成果需要已配置的对象存储。',409);
 function checkpoint(node){const cp=node?.checkpoint;if(!cp||cp.runId!==source.id||cp.nodeId!==node.id||cp.conversationId!==node.conversationId||!/^[a-f0-9]{64}$/.test(cp.sha256||'')||!Number.isSafeInteger(cp.size)||cp.size<=0||cp.size>128*1024*1024)throw new ApiError('上轮成果缺少有效的已入桶阶段快照。',409);return structuredClone(cp)}
 const order=source.order||[],nodes=source.nodes||{};
 if(!order.length||order.some(id=>nodes[id]?.status!=='succeeded'||source.schedulerVersion===2&&nodes[id]?.outputReady!==true))throw new ApiError('上轮阶段尚未全部通过文件存储屏障。',409);
 const ancestors=(id,seen=new Set())=>{if(seen.has(id)||!nodes[id])throw new ApiError('上轮依赖记录无效。',409);const next=new Set(seen).add(id),out=new Set([id]);for(const p of nodes[id].dependencies||[])for(const a of ancestors(p,next))out.add(a);return out};
 const leaves=source.schedulerVersion===2?order.filter(id=>!order.some(other=>(nodes[other].dependencies||[]).includes(id))):order.slice(-1);
 if(!leaves.length)throw new ApiError('上轮缺少可交付的末级阶段。',409);
 const sets=leaves.map(id=>ancestors(id)),common=order.filter(id=>sets.every(s=>s.has(id))),maximal=common.filter(id=>!common.some(other=>other!==id&&ancestors(other).has(id)));
 if(maximal.length>1)throw new ApiError('上轮汇合缺少唯一文件基线。',409);
 const parents=leaves.map(id=>({id,checkpoint:checkpoint(nodes[id])}));
 let base=null;
 if(leaves.length>1){if(maximal[0])base={id:maximal[0],checkpoint:checkpoint(nodes[maximal[0]])};else if(source.workflow?.baseRunId||source.workflow?.repository){const cp=source.artifactSource?.checkpoint||source.repositorySource?.checkpoint;if(!cp)throw new ApiError('上轮源代码基线快照缺失。',409);base={id:'source',checkpoint:structuredClone(cp)}}}
 return {sourceRunId:source.id,sourceProjectId:source.projectId,parents,base,status:'pinned',pinnedAt:new Date().toISOString()};
}

export class RunSources {
 constructor({store,storage,directory}){Object.assign(this,{store,storage,directory});this.tasks=new Map();this.closed=false}
 close(){this.closed=true;for(const task of this.tasks.values())task.controller.abort()}
 abort(id){this.tasks.get(id)?.controller.abort()}
 get(run){if(!run.workflow.baseRunId)return Promise.resolve(null);if(this.closed)return Promise.reject(new ApiError('成果导入正在关闭。',503));if(this.tasks.has(run.id))return this.tasks.get(run.id).promise;const controller=new AbortController(),promise=this.prepare(run,controller.signal).finally(()=>this.tasks.delete(run.id));this.tasks.set(run.id,{controller,promise});return promise}
 patch(id,metadata,signal){signal.throwIfAborted();if(this.closed)throw new ApiError('成果导入正在关闭。',503);const run=this.store.run(id);run.artifactSource=metadata;this.store.saveRun(run)}
 check(cp){const c=this.storage?.config();if(!c?.enabled||!cp||cp.bucket!==c.bucket||cp.endpoint!==c.endpoint||!safeId(cp.runId)||!safeId(cp.nodeId)||!cp.key?.startsWith(c.prefix)||!this.store.objectInfo(cp.key)||!/^[a-f0-9]{64}$/.test(cp.sha256||'')||!Number.isSafeInteger(cp.size)||cp.size<=0||cp.size>128*1024*1024)throw new ApiError('成果基线所属存储配置已变化或快照无效，请恢复后继续。',409)}
 async restore(cp,signal){this.check(cp);const path=await this.storage.restoreCheckpoint(cp,{reuseVerified:true});signal.throwIfAborted();return path}
 async prepare(initial,signal){
  const run=this.store.run(initial.id);let metadata=run.artifactSource;
  if(!metadata||metadata.sourceRunId!==run.workflow.baseRunId||metadata.sourceProjectId!==run.projectId)throw new ApiError('运行缺少固定的上轮成果来源。',409);
  const folder=join(this.directory,'run-sources',run.id),path=join(folder,'workspace.tar.gz');await mkdir(folder,{recursive:true,mode:0o700});signal.throwIfAborted();
  if(metadata.checkpoint){const restored=await this.restore(metadata.checkpoint,signal);if(metadata.checkpoint.sha256!==metadata.archiveSha256)throw new ApiError('成果基线哈希不一致。',409);await copyFile(restored,path);signal.throwIfAborted();return {path,metadata}}
  for(const p of metadata.parents)this.check(p.checkpoint);if(metadata.base)this.check(metadata.base.checkpoint);
  if(!await matches(path,metadata.archiveSha256)){
   const parents=await Promise.all(metadata.parents.map(async p=>({id:p.id,archive:await this.restore(p.checkpoint,signal)})));let raw=parents[0]?.archive;
   if(parents.length>1){const base=metadata.base?await this.restore(metadata.base.checkpoint,signal):undefined;const merged=await mergeArchives({runId:metadata.sourceRunId,nodeId:'previous-delivery',directory:folder,parents,base,baseId:metadata.base?.id});signal.throwIfAborted();if(merged.report.conflicts.length)throw new ApiError('上轮成果重建存在未解决冲突，未启动 AI。',409);raw=merged.path}
   const normalized=join(folder,randomUUID()+'.tar.gz');try{const report=await archiveOperation('repository',raw,[normalized,run.id]);signal.throwIfAborted();await rename(normalized,path);metadata={...metadata,archiveSha256:await digest(path),files:report.files,bytes:report.bytes,status:'prepared'};this.patch(run.id,metadata,signal)}finally{await unlink(normalized).catch(()=>{})}
  }
  const checkpoint=await this.storage.checkpoint(this.store.run(run.id),{id:RUN_SOURCE_NODE_ID,status:'succeeded',name:'上轮开发成果',conversationId:'source-'+metadata.archiveSha256,output:'Source run '+metadata.sourceRunId},{mode:'remote'},{archivePath:path});signal.throwIfAborted();
  if(!checkpoint||checkpoint.sha256!==metadata.archiveSha256)throw new ApiError('成果基线尚未完整保存到数据桶，AI 未启动。',502);
  metadata={...metadata,checkpoint,status:'ready',readyAt:new Date().toISOString()};this.patch(run.id,metadata,signal);return {path,metadata};
 }
}
