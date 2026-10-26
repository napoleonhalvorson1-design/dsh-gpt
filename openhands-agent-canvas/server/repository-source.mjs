import http from 'node:http';import https from 'node:https';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,stat,rename,unlink,copyFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';import {createHash,randomUUID} from 'node:crypto';
import {Transform} from 'node:stream';import {pipeline} from 'node:stream/promises';
import {request,endpoint,target,safeLookup} from './connector-http.mjs';
import {authHeaders} from './connector-adapters.mjs';
import {archiveOperation} from './collaboration.mjs';
import {ApiError} from '../shared/openhands.mjs';
export const SOURCE_NODE_ID='_canvas_repository_source';
const isSha=s=>/^[a-f0-9]{40}$/i.test(s||'');
async function digest(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex')}
async function matches(path,sha){try{return !!sha&&(await stat(path)).isFile()&&await digest(path)===sha}catch{return false}}
export function repositoryName(value){if(typeof value!=='string'||!/^([a-zA-Z0-9][a-zA-Z0-9-]{0,38})\/([a-zA-Z0-9_.-]{1,100})$/.test(value)||['.','..'].includes(value.split('/')[1]))throw new ApiError('仓库名称格式应为 owner/repository。');return value}
function refName(value){if(typeof value!=='string'||!value||value.length>150||/[\\\x00-\x20\x7f~^:?*\[\]@]/.test(value)||value.includes('..')||value.includes('//')||value.startsWith('/')||value.endsWith('/'))throw new ApiError('仓库分支或提交引用无效。');return value}
// Auth is used only at the API origin; signed archive redirects never receive it.
export async function downloadRepository(config,path,destination,{headers={},signal}={}){
 const first=target(endpoint(config.baseUrl,config),path),temporary=destination+'.'+randomUUID()+'.part';await mkdir(dirname(destination),{recursive:true,mode:0o700});
 async function receive(url,currentHeaders,hops){
  const response=await new Promise((resolve,reject)=>{const req=(url.protocol==='https:'?https:http).request(url,{headers:currentHeaders,signal,lookup:safeLookup(config.allowPrivate)},resolve);const timer=setTimeout(()=>req.destroy(),90000);req.on('close',()=>clearTimeout(timer));req.on('error',()=>reject(new ApiError(signal?.aborted?'仓库导入已中断。':'无法下载仓库归档。',502)));req.end()});
  response.on('error',()=>{});
  if([301,302,303,307,308].includes(response.statusCode)){const location=response.headers.location;response.resume();let next;try{next=new URL(location,url)}catch{throw new ApiError('仓库归档重定向无效。',502)}
   const official=first.hostname==='api.github.com'&&next.hostname==='codeload.github.com'&&next.protocol==='https:';if(hops>=2||!location||next.username||next.password||next.hash||!(next.origin===first.origin||official))throw new ApiError('仓库归档跳转目标未获授权。',403);
   endpoint(next.origin,config);return receive(next,{'User-Agent':'OpenHands-Canvas-Engine'},hops+1);
  }
  if(response.statusCode!==200){response.resume();throw new ApiError('仓库归档下载失败（HTTP '+response.statusCode+'），请核对仓库读取权限。',502)}
  let size=0;const limited=new Transform({transform(bytes,encoding,done){size+=bytes.length;done(size>128*1024*1024?new ApiError('仓库归档超过 128 MiB 限制。',413):null,bytes)}});await pipeline(response,limited,createWriteStream(temporary,{mode:0o600}),{signal});await rename(temporary,destination);return size;
 }
 try{return await receive(first,headers,0)}catch(e){await unlink(temporary).catch(()=>{});if(e instanceof ApiError)throw e;throw new ApiError('仓库归档传输中断，已保留固定的提交 SHA。',502)}
}
export class RepositorySources {
 constructor({store,storage,connectors,directory}){Object.assign(this,{store,storage,connectors,directory});this.tasks=new Map();this.closed=false}
 close(){this.closed=true;for(const task of this.tasks.values())task.controller.abort()}
 abort(id){this.tasks.get(id)?.controller.abort()}
 get(run){if(!run.workflow.repository)return Promise.resolve(null);if(this.closed)return Promise.reject(new ApiError('仓库导入正在关闭。',503));if(this.tasks.has(run.id))return this.tasks.get(run.id).promise;const controller=new AbortController(),promise=this.prepare(run,controller.signal).finally(()=>this.tasks.delete(run.id));this.tasks.set(run.id,{controller,promise});return promise}
 patch(id,metadata,signal){signal.throwIfAborted();if(this.closed)throw new ApiError('仓库导入正在关闭。',503);const run=this.store.run(id);run.repositorySource=metadata;this.store.saveRun(run)}
 async prepare(initial,signal){
  const run=this.store.run(initial.id),repository=repositoryName(run.workflow.repository),[owner,name]=repository.split('/'),selected=run.workflow.githubConnectionId||'github-public',connection=this.connectors.connection(selected);
  if(run.workflow.githubConnectionId&&!connection)throw new ApiError('所选 GitHub 仓库连接不存在。',409);
  if(connection&&(connection.type!=='github'||!connection.enabled))throw new ApiError('仓库读取连接不可用。',409);
  if(connection?.config.owner&&connection.config.owner.toLowerCase()!==owner.toLowerCase())throw new ApiError('此连接未授权读取该 GitHub owner 的仓库。',403);
  const config=connection?.config||{baseUrl:'https://api.github.com',allowPrivate:false,auth:{type:'none'}},secrets=connection?this.connectors.resolved(connection):{},headers={...authHeaders({type:'github',config},secrets),Accept:'application/vnd.github+json','User-Agent':'OpenHands-Canvas-Engine','X-GitHub-Api-Version':'2022-11-28'},api='repos/'+encodeURIComponent(owner)+'/'+encodeURIComponent(name),send=path=>request(config,path,{headers,signal});
  let metadata=run.repositorySource;if(metadata&&metadata.repository!==repository)throw new ApiError('运行的仓库来源已变化，请新建运行。',409);
  if(!metadata?.commitSha){const ref=refName(run.workflow.branch||(await send(api)).data.default_branch);let commitSha;if(isSha(ref)){commitSha=(await send(api+'/git/commits/'+ref)).data.sha}else{const record=(await send(api+'/git/ref/heads/'+encodeURIComponent(ref))).data;if(record.object?.type&&record.object.type!=='commit')throw new ApiError('仓库引用没有指向提交。',400);commitSha=record.object?.sha}if(!isSha(commitSha))throw new ApiError('GitHub 未返回有效仓库提交。',502);metadata={repository,ref,commitSha,connectionId:connection?.id||null,status:'loading',resolvedAt:new Date().toISOString()};this.patch(run.id,metadata,signal)}
  if(!isSha(metadata.commitSha))throw new ApiError('运行记录中的仓库提交无效。',409);
  if(metadata.checkpoint&&this.storage?.config().enabled){const current=this.storage.config(),cp=metadata.checkpoint;if(cp.bucket!==current.bucket||cp.endpoint!==current.endpoint||!cp.key.startsWith(current.prefix)||!this.store.objectInfo(cp.key))throw new ApiError('仓库基线所属存储配置已变化，请恢复原配置后继续。',409);}
  const directory=join(this.directory,'repositories',run.id),path=join(directory,'workspace.tar.gz');await mkdir(directory,{recursive:true,mode:0o700});
  if(!await matches(path,metadata.archiveSha256)){
   if(metadata.checkpoint&&this.storage?.config().enabled){const restored=await this.storage.restoreCheckpoint(metadata.checkpoint,{reuseVerified:true});signal.throwIfAborted();await copyFile(restored,path);if(!await matches(path,metadata.archiveSha256))throw new ApiError('仓库快照校验失败。',502)}
   else{const raw=join(directory,randomUUID()+'-raw.tar.gz'),normalized=join(directory,randomUUID()+'-normalized.tar.gz');try{await downloadRepository(config,api+'/tarball/'+metadata.commitSha,raw,{headers,signal});const report=await archiveOperation('repository',raw,[normalized,run.id]);signal.throwIfAborted();await rename(normalized,path);metadata={...metadata,archiveSha256:await digest(path),files:report.files,bytes:report.bytes,status:'prepared'};this.patch(run.id,metadata,signal)}finally{await unlink(raw).catch(()=>{});await unlink(normalized).catch(()=>{})}}
  }
  if(this.storage?.config().enabled&&!metadata.checkpoint){const node={id:SOURCE_NODE_ID,status:'succeeded',name:'GitHub 仓库源代码',conversationId:'source-'+metadata.commitSha,output:repository+' @ '+metadata.commitSha};const checkpoint=await this.storage.checkpoint(this.store.run(run.id),node,{mode:'remote'}, {archivePath:path});signal.throwIfAborted();if(!checkpoint?.sha256)throw new ApiError('仓库快照尚未保存到数据桶，AI 未启动。',502);metadata={...metadata,checkpoint};if(checkpoint.sha256!==metadata.archiveSha256){const restored=await this.storage.restoreCheckpoint(checkpoint,{reuseVerified:true});await copyFile(restored,path);metadata.archiveSha256=checkpoint.sha256}}
  metadata={...metadata,status:'ready',readyAt:metadata.readyAt||new Date().toISOString()};this.patch(run.id,metadata,signal);return {path,metadata};
 }
}
