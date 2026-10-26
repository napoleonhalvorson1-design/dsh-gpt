import {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,ListObjectsV2Command} from '@aws-sdk/client-s3';
import {backup} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {snapshotWorkspace} from './handoff.mjs';
import {mkdir,stat,lstat,unlink,rename,readFile,copyFile} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {dirname,join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {ApiError} from '../shared/openhands.mjs';
const clientIdentity=c=>createHash('sha256').update(JSON.stringify([c.endpoint,c.region,c.forcePathStyle,c.accessKeyId,c.secretAccessKey,c.sessionToken])).digest('hex');
async function matchesCheckpoint(path,checkpoint){try{const info=await lstat(path);if(!info.isFile()||info.size!==checkpoint.size)return false;const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex')===checkpoint.sha256}catch{return false}}

export async function archiveRun(store,id,directory){
 const run=store.run(id);if(!run)throw new ApiError('运行记录不存在。',404);
 if(run.status!=='succeeded'){
  const candidates=[...(run.order||[])].reverse().map(key=>run.nodes[key]).filter(n=>n?.status==='succeeded'&&n.checkpoint&&(run.schedulerVersion!==2||n.outputReady));
  if(run.schedulerVersion===2)candidates.sort((a,b)=>String(b.finishedAt||'').localeCompare(String(a.finishedAt||'')));
  const stage=candidates[0];
  if(stage&&store.storage?.config().enabled){const path=await store.storage.restoreCheckpoint(stage.checkpoint,{reuseVerified:true});return {path,size:(await stat(path)).size,partial:true,sourceStage:{id:stage.id,name:stage.name}}}
  throw new ApiError('尚无已完成阶段的文件，任务完成阶段后即可查看。',409);
 }

 const path=join(directory,'artifacts',id+'.tar.gz');await mkdir(dirname(path),{recursive:true,mode:0o700});try{const info=await stat(path);if(info.size)return {path,size:info.size}}catch{}
 if(store.storage?.config().enabled){try{const archived=await store.storage.restoreArtifact(id,path);if(archived)return archived}catch{}}
 if(run.schedulerVersion===2){
  const leaves=run.order.filter(id=>!Object.values(run.nodes).some(n=>n.dependencies?.includes(id)));
  if(leaves.length===1&&run.nodes[leaves[0]].checkpoint&&store.storage?.config().enabled){const source=await store.storage.restoreCheckpoint(run.nodes[leaves[0]].checkpoint);await copyFile(source,path);return {path,size:(await stat(path)).size}}
  throw new ApiError('并行交付文件需要从对象存储恢复，请检查桶连接。',502);
 }
 const bundle=store.config(id),last=run.nodes[run.order.at(-1)],c=bundle.nodeConfigs?.[last.id]||bundle;if(c.mode!=='remote')throw new ApiError('云端产物请在 OpenHands Cloud 中查看。',409);
 const node=run.nodes[run.order.at(-1)],params=new URLSearchParams({path:last.workspace||run.workspace,format:'tar.gz',use_default_excludes:'true'});
 const remote=await fetch(c.baseUrl+'/api/conversations/'+node.handle.conversationId+'/file/archive?'+params,{headers:{'X-Session-API-Key':c.apiKey},redirect:'manual',signal:AbortSignal.timeout(90000)});
 if(!remote.ok||!remote.body)throw new ApiError('后端打包失败，请稍后重试。',502);
 const temporary=path+'.'+randomUUID()+'.part';try{await pipeline(Readable.fromWeb(remote.body),createWriteStream(temporary,{mode:0o600}));await rename(temporary,path)}catch(e){await unlink(temporary).catch(()=>{});throw e}return {path,size:(await stat(path)).size};
}
export class Storage {
 constructor(store,{directory,intervalMs=15000,environment=process.env}={}){this.environment=environment;store.storage=this;this.checkpointTasks=new Map();this.restoreTasks=new Map();this.verifiedCheckpoints=new Map();this.clients=new Map();this.closed=false;this.store=store;this.directory=directory;this.busy=false;this.lastError=null;this.lastSync=null;this.timer=setInterval(()=>this.sync().catch(()=>{}),intervalMs);this.timer.unref()}
 close(){clearInterval(this.timer);this.closed=true;for(const pool of this.clients.values())pool.client.destroy();this.clients.clear();this.verifiedCheckpoints.clear()}
 environmentConfig(){const e=this.environment,managed=!!(e.CANVAS_S3_ENDPOINT||e.S3_ENDPOINT||e.CANVAS_S3_BUCKET||e.S3_BUCKET||e.CANVAS_S3_ACCESS_KEY_ID||e.S3_ACCESS_KEY);if(!managed)return null;return {endpoint:e.CANVAS_S3_ENDPOINT||e.S3_ENDPOINT||'',bucket:e.CANVAS_S3_BUCKET||e.S3_BUCKET||'',region:e.CANVAS_S3_REGION||e.S3_REGION||'auto',forcePathStyle:e.CANVAS_S3_FORCE_PATH_STYLE==='true',accessKeyId:e.CANVAS_S3_ACCESS_KEY_ID||e.S3_ACCESS_KEY||e.AWS_ACCESS_KEY_ID||'',secretAccessKey:e.CANVAS_S3_SECRET_ACCESS_KEY||e.S3_SECRET_KEY||e.AWS_SECRET_ACCESS_KEY||'',sessionToken:e.CANVAS_S3_SESSION_TOKEN||'',readOnly:e.CANVAS_S3_READ_ONLY==='true',credentialsSource:'environment'}}
 config(){const saved=this.store.setting('s3')||{enabled:false,region:'auto',prefix:'openhands-canvas/',forcePathStyle:false},env=this.environmentConfig();return env?{...saved,...env,enabled:!!saved.enabled&&!env.readOnly}:saved}
 status(){const c=this.config();return {enabled:!!c.enabled,endpoint:c.endpoint||'',bucket:c.bucket||'',region:c.region||'auto',prefix:c.prefix||'openhands-canvas/',forcePathStyle:!!c.forcePathStyle,hasCredentials:!!c.accessKeyId&&!!c.secretAccessKey,credentialsSource:c.credentialsSource||'encrypted-database',readOnly:!!c.readOnly,signatureVersion:'s3v4',lastSync:this.lastSync,lastError:this.lastError,busy:this.busy,objects:this.store.objects()}}
 save(input){if(this.busy||this.checkpointTasks.size)throw new ApiError('正在同步对象存储，请等待完成后再修改配置。',409);const old=this.config();if(old.credentialsSource==='environment'&&(input.accessKeyId||input.secretAccessKey||input.sessionToken))throw new ApiError('密钥由服务器环境变量管理，请在服务器上更新。',409);const c={enabled:!!input.enabled,endpoint:String(input.endpoint||'').trim(),bucket:String(input.bucket||'').trim(),region:String(input.region||'auto').trim(),prefix:String(input.prefix||'openhands-canvas/').replace(/^\/+/,''),forcePathStyle:!!input.forcePathStyle,accessKeyId:String(input.accessKeyId||old.accessKeyId||'').trim(),secretAccessKey:String(input.secretAccessKey||old.secretAccessKey||''),sessionToken:input.sessionToken===undefined?old.sessionToken||'':String(input.sessionToken)};
 if(c.endpoint){let u;try{u=new URL(c.endpoint)}catch{}if(!u||!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new ApiError('请输入有效的 S3 Endpoint。');if(u.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname)&&process.env.CANVAS_S3_ALLOW_HTTP!=='true')throw new ApiError('公网对象存储请使用 HTTPS Endpoint。');c.endpoint=c.endpoint.replace(/\/+$/,'')}
 if(!/^[a-zA-Z0-9._-]{1,200}$/.test(c.bucket)&&c.enabled)throw new ApiError('请填写有效桶名。');if(!/^[a-zA-Z0-9/_-]{1,160}$/.test(c.prefix)||c.prefix.includes('..'))throw new ApiError('存储前缀只能包含字母、数字、横线、下划线和斜线。');if(!c.prefix.endsWith('/'))c.prefix+='/';if(c.enabled&&(!c.accessKeyId||!c.secretAccessKey))throw new ApiError('请填写对象存储凭据。');if([c.accessKeyId,c.secretAccessKey,c.sessionToken].some(x=>x.length>4000))throw new ApiError('凭据内容过长。');if([old.endpoint,old.bucket,old.prefix].join('\n')!==[c.endpoint,c.bucket,c.prefix].join('\n')){this.store.db.exec('DELETE FROM objects');this.store.setSetting('last-backup',null)}if(old.credentialsSource==='environment'){c.enabled=!!c.enabled&&!old.readOnly;for(const key of ['accessKeyId','secretAccessKey','sessionToken'])delete c[key]}this.store.setSetting('s3',c);this.lastError=null;return this.status()}
 client(c=this.config()){
  if(this.closed)throw new ApiError('存储连接正在关闭。',503);if(!c.enabled)throw new ApiError('请先启用并配置对象存储。',409);if(!c.accessKeyId||!c.secretAccessKey)throw new ApiError('尚未配置 S3 访问密钥，请在服务器环境变量中设置 AccessKey 和 SecretKey。',409);
  const key=clientIdentity(c);let pool=this.clients.get(key);
  if(!pool){for(const [oldKey,old] of this.clients){old.retired=true;if(!old.leases){old.client.destroy();this.clients.delete(oldKey)}}pool={client:new S3Client({...(c.endpoint?{endpoint:c.endpoint}:{}),region:c.region||'auto',forcePathStyle:c.forcePathStyle,credentials:{accessKeyId:c.accessKeyId,secretAccessKey:c.secretAccessKey,...(c.sessionToken?{sessionToken:c.sessionToken}:{})},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:2}),leases:0,retired:false};this.clients.set(key,pool)}
  pool.leases++;let released=false;
  // Callers keep the existing send/destroy lifecycle; destroy releases a lease, preserving keep-alive.
  return {send:(...args)=>pool.client.send(...args),destroy:()=>{if(released)return;released=true;pool.leases--;if(pool.retired&&!pool.leases){pool.client.destroy();this.clients.delete(key)}}};
 }
 async list({limit=100,prefix='',cursor=''}={}){const c=this.config();if(!c.bucket)throw new ApiError('请先配置 S3 桶名。',409);if(!Number.isInteger(Number(limit))||Number(limit)<1||Number(limit)>1000||typeof prefix!=='string'||prefix.length>1024||typeof cursor!=='string'||cursor.length>8192)throw new ApiError('列举参数无效。');const client=this.client({...c,enabled:true});try{const result=await client.send(new ListObjectsV2Command({Bucket:c.bucket,MaxKeys:Number(limit),...(prefix?{Prefix:prefix}:{}),...(cursor?{ContinuationToken:cursor}:{})}),{abortSignal:AbortSignal.timeout(30000)});return {ok:true,bucket:c.bucket,endpoint:c.endpoint,region:c.region,signatureVersion:'s3v4',items:(result.Contents||[]).map(o=>({key:o.Key,size:o.Size||0,lastModified:o.LastModified?.toISOString()||null})),hasMore:!!result.IsTruncated,nextCursor:result.NextContinuationToken||null,message:'只读列举成功，未上传、修改或删除文件。'}}catch(e){const code=['AccessDenied','InvalidAccessKeyId','SignatureDoesNotMatch','NoSuchBucket','AuthorizationHeaderMalformed','RequestTimeTooSkewed','ExpiredToken'].includes(e.name)?e.name:'S3ConnectionError';throw new ApiError('列出桶内文件失败（'+code+'），请检查密钥、Region、桶名及列举权限。',502)}finally{client.destroy()}}
 async test(){const c=this.config();if(c.readOnly)throw new ApiError('当前为只读连接，请使用列出桶内文件测试。',409);if(!c.bucket||!c.accessKeyId||!c.secretAccessKey)throw new ApiError('请先填写桶名和访问密钥。');const client=this.client({...c,enabled:true}),key=c.prefix+'_connection-tests/'+randomUUID()+'.txt',value='OpenHands Canvas storage check '+randomUUID();let uploaded=false;try{await client.send(new PutObjectCommand({Bucket:c.bucket,Key:key,Body:value,ContentType:'text/plain'}));uploaded=true;const r=await client.send(new GetObjectCommand({Bucket:c.bucket,Key:key}));if(await r.Body.transformToString()!==value)throw Error('mismatch');await client.send(new DeleteObjectCommand({Bucket:c.bucket,Key:key}));uploaded=false;return {ok:true,message:'私有桶写入、读取、删除测试通过。'}}catch(e){throw new ApiError('对象存储验证失败，请检查 Endpoint、桶名和读写删除权限。',502)}finally{if(uploaded)await client.send(new DeleteObjectCommand({Bucket:c.bucket,Key:key})).catch(()=>{});client.destroy()}}
 async put(key,body,{kind,id,revision=1,size,contentType='application/json',timeoutMs=90000}){const c=this.config(),client=this.client(c);try{await client.send(new PutObjectCommand({Bucket:c.bucket,Key:c.prefix+key,Body:body,ContentType:contentType,...(size!==undefined?{ContentLength:size}:{})}),{abortSignal:AbortSignal.timeout(timeoutMs)});this.store.object(c.prefix+key,kind,id,revision,size??Buffer.byteLength(body))}finally{client.destroy()}}
 async putFile(key,path,options){
  // SDK retries cannot replay a consumed file stream. Reopen the immutable
  // snapshot for one bounded retry; denied/invalid requests fail immediately.
  for(let attempt=0;;attempt++){
   const body=createReadStream(path);
   try{return await this.put(key,body,{...options,timeoutMs:180000})}
   catch(error){const status=error.$metadata?.httpStatusCode,retryable=status===429||status>=500||['TimeoutError','RequestTimeout','RequestTimeoutError','AbortError','NetworkingError','ECONNRESET','ETIMEDOUT','EPIPE'].includes(error.name)||['ECONNRESET','ETIMEDOUT','EPIPE'].includes(error.code);if(attempt||!retryable||this.closed)throw error;await sleep(200)}
   finally{body.destroy()}
  }
 }
 async json(key,value,options){return this.put(key,JSON.stringify(value,null,2),options)}
 async uploadParts(setting,state,specs){
  const saved=await Promise.allSettled(specs.map(async({name,key,sha256,upload})=>{
   const receipt=state.done[name];if(receipt?.key===key&&receipt.sha256===sha256&&this.store.objectInfo(key))return;
   await upload();state.done[name]={key,sha256};this.store.setSetting(setting,state);
  }));const failed=saved.find(r=>r.status==='rejected');if(failed)throw failed.reason;
 }
 async persistInput(id,node){
  const c=this.config(),root='runs/'+id+'/inputs/'+node.id+(node.fallbackCount?'/attempt-'+(node.fallbackCount+1):'')+'/',size=(await stat(node.inputArchive)).size,hash=createHash('sha256');for await(const bytes of createReadStream(node.inputArchive))hash.update(bytes);
  const sha=hash.digest('hex'),manifest=JSON.stringify(node.mergeReport,null,2),manifestSha=createHash('sha256').update(manifest).digest('hex'),setting='input-parts:'+id+':'+node.id+':'+(node.fallbackCount||0),identity=JSON.stringify([c.endpoint,c.bucket,c.prefix,node.conversationId,sha,manifestSha]),previous=this.store.setting(setting),parts=previous?.identity===identity?previous:{identity,done:{}};
  await this.uploadParts(setting,parts,[
   {name:'archive',key:c.prefix+root+'workspace.tar.gz',sha256:sha,upload:()=>this.putFile(root+'workspace.tar.gz',node.inputArchive,{kind:'stage-input',id,size,contentType:'application/gzip'})},
   {name:'manifest',key:c.prefix+root+'handoff.json',sha256:manifestSha,upload:()=>this.put(root+'handoff.json',manifest,{kind:'handoff',id})}
  ]);
 }
 async checkpoint(run,node,config,{historical=false,archivePath}={}){
  if(!this.config().enabled||node.status!=='succeeded'||config.mode!=='remote')return null;
  const id=run.id+'/'+node.id;if(this.checkpointTasks.has(id))return this.checkpointTasks.get(id);
  const task=this.captureCheckpoint(run,node,config,{historical,archivePath});this.checkpointTasks.set(id,task);try{return await task}catch{throw new ApiError('阶段文件尚未保存到对象存储，请检查连接后继续；已完成的 AI 不会重复执行。',502)}finally{this.checkpointTasks.delete(id)}
 }
 async captureCheckpoint(run,node,config,{historical,archivePath}){
  const c=this.config(),relative='runs/'+run.id+'/stages/'+node.id+'/workspace.tar.gz',key=c.prefix+relative,manifestKey=c.prefix+'runs/'+run.id+'/stages/'+node.id+'/manifest.json',setting='checkpoint:'+run.id+':'+node.id,existing=this.store.setting(setting);
  if(existing?.key===key&&existing.conversationId===node.conversationId&&existing.bucket===c.bucket&&existing.endpoint===c.endpoint&&this.store.objectInfo(key)&&this.store.objectInfo(manifestKey))return existing;
  const directory=join(this.directory,'checkpoints',run.id);await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,node.id+'.tar.gz');if(archivePath){if(archivePath!==path)await copyFile(archivePath,path)}else await snapshotWorkspace(config,node.workspace||run.workspace,path);const size=(await stat(path)).size,hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);const sha256=hash.digest('hex'),checkpoint={key,bucket:c.bucket,endpoint:c.endpoint,runId:run.id,nodeId:node.id,conversationId:node.conversationId,sha256,size,capturedAt:new Date().toISOString(),historical};
  const partsKey=setting+':parts',identity=JSON.stringify([key,c.bucket,c.endpoint,node.conversationId,sha256]),previous=this.store.setting(partsKey);
  const parts=previous?.identity===identity?previous:{identity,capturedAt:checkpoint.capturedAt,done:{}};checkpoint.capturedAt=parts.capturedAt;
  const manifest=JSON.stringify({schemaVersion:1,...checkpoint,name:node.name,profileId:node.profileId,server:node.server,model:node.modelUsed,finishedAt:node.finishedAt,output:node.output,modelUsage:node.modelUsage||null},null,2),manifestSha=createHash('sha256').update(manifest).digest('hex');
  await this.uploadParts(partsKey,parts,[
   {name:'archive',key,sha256,upload:()=>this.putFile(relative,path,{kind:'stage-artifact',id:run.id,size,contentType:'application/gzip'})},
   {name:'manifest',key:manifestKey,sha256:manifestSha,upload:()=>this.put('runs/'+run.id+'/stages/'+node.id+'/manifest.json',manifest,{kind:'stage-manifest',id:run.id})}
  ]);this.store.setSetting(setting,checkpoint);return checkpoint;
 }
 async restoreCheckpoint(checkpoint,{reuseVerified=false}={}){
  const c=this.config();if(checkpoint.bucket!==c.bucket||checkpoint.endpoint!==c.endpoint||!checkpoint.key.startsWith(c.prefix)||!this.store.objectInfo(checkpoint.key)||!/^\w[\w-]{0,99}$/.test(checkpoint.runId)||!/^\w[\w-]{0,99}$/.test(checkpoint.nodeId))throw new ApiError('阶段文件所属存储配置已变化，请恢复原配置后继续。',409);
  if(!c.enabled||!c.accessKeyId||!c.secretAccessKey){const lease=this.client(c);lease.destroy()}
  const identity=JSON.stringify([clientIdentity(c),c.bucket,c.prefix,checkpoint.key,checkpoint.sha256,checkpoint.size]),taskKey=identity+(reuseVerified?'/cached':'/fresh');
  if(this.restoreTasks.has(taskKey))return this.restoreTasks.get(taskKey);
  const task=(async()=>{
   const cached=this.verifiedCheckpoints.get(identity);if(reuseVerified&&cached&&await matchesCheckpoint(cached,checkpoint))return cached;
   const path=await this.downloadCheckpoint(checkpoint,c);this.verifiedCheckpoints.delete(identity);this.verifiedCheckpoints.set(identity,path);while(this.verifiedCheckpoints.size>64)this.verifiedCheckpoints.delete(this.verifiedCheckpoints.keys().next().value);return path;
  })();this.restoreTasks.set(taskKey,task);
  try{return await task}catch(error){this.verifiedCheckpoints.delete(identity);throw error}finally{this.restoreTasks.delete(taskKey)}
 }
 async downloadCheckpoint(checkpoint,c=this.config()){
  const client=this.client(c),directory=join(this.directory,'handoff',checkpoint.runId);await mkdir(directory,{recursive:true,mode:0o700});const path=join(directory,checkpoint.nodeId+'-bucket.tar.gz'),part=path+'.'+randomUUID()+'.part';
  try{const object=await client.send(new GetObjectCommand({Bucket:c.bucket,Key:checkpoint.key}),{abortSignal:AbortSignal.timeout(90000)});let count=0;const hash=createHash('sha256'),stream=object.Body;
   async function* checked(){for await(const chunk of stream){count+=chunk.length;if(count>128*1024*1024)throw Error('limit');hash.update(chunk);yield chunk}}
   await pipeline(Readable.from(checked()),createWriteStream(part,{mode:0o600}));if(count!==checkpoint.size||hash.digest('hex')!==checkpoint.sha256)throw Error('checksum');await rename(part,path);return path;
  }catch{await unlink(part).catch(()=>{});throw new ApiError('对象存储阶段文件下载或校验失败，请重试。',502)}finally{client.destroy()}
 }
 async restoreArtifact(id,path){const c=this.config(),known=this.store.objectInfo(c.prefix+'runs/'+id+'/artifacts.tar.gz');if(!known)return null;const client=this.client(c),part=path+'.'+randomUUID()+'.part';try{const object=await client.send(new GetObjectCommand({Bucket:c.bucket,Key:known.key}),{abortSignal:AbortSignal.timeout(90000)});let count=0;async function* checked(){for await(const chunk of object.Body){count+=chunk.length;if(count>known.size)throw Error('size');yield chunk}}await pipeline(Readable.from(checked()),createWriteStream(part,{mode:0o600}));if(count!==known.size)throw Error('size');await rename(part,path);return {path,size:count}}catch{await unlink(part).catch(()=>{});throw new ApiError('对象存储中的产物暂时无法读取。',502)}finally{client.destroy()}}
 async syncRun(run){
  const prefix=this.config().prefix,root='runs/'+run.id+'/',known=key=>this.store.objectInfo(prefix+root+key);
  if(run.workflow&&!known('input.json'))await this.json(root+'input.json',{schemaVersion:1,id:run.id,projectId:run.projectId,workflow:run.workflow},{kind:'run-input',id:run.id});
  let after=known('events/index.json')?.revision||0,events;for(let page=0;page<10&&(events=this.store.events(run.id,after)).length;page++){
   const last=events.at(-1).seq,key=root+'events/'+events[0].seq+'-'+last+'.json';await this.json(key,{schemaVersion:1,runId:run.id,events},{kind:'event-log',id:run.id,revision:last});
   await this.json(root+'events/index.json',{schemaVersion:1,runId:run.id,lastSequence:last,lastChunk:key},{kind:'event-index',id:run.id,revision:last});after=last;
  }
  const latest=this.store.run(run.id);if(known('state.json')?.revision!==latest.revision)await this.json(root+'state.json',{schemaVersion:1,...latest},{kind:'run-state',id:run.id,revision:latest.revision});
  if(run.status==='succeeded'){
   const key=root+'artifacts.tar.gz';if(!this.store.objectInfo(prefix+key)){const a=await archiveRun(this.store,run.id,this.directory);await this.putFile(key,a.path,{kind:'artifact',id:run.id,size:a.size,contentType:'application/gzip'})}
   if(!known('manifest.json'))await this.json(root+'manifest.json',{schemaVersion:1,id:run.id,projectId:run.projectId,title:run.title,status:run.status,createdAt:run.createdAt,finishedAt:run.finishedAt,files:key},{kind:'manifest',id:run.id});
  }
 }
 async backup(){const c=this.config();this.client(c).destroy();const id=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8),path=join(this.directory,'backups',id+'.sqlite');await mkdir(dirname(path),{recursive:true,mode:0o700});await backup(this.store.db,path);const size=(await stat(path)).size;await this.putFile('backups/'+id+'.sqlite',path,{kind:'backup',id,size,contentType:'application/vnd.sqlite3'});this.store.setSetting('last-backup',{at:new Date().toISOString(),id});return {ok:true,id,size,key:c.prefix+'backups/'+id+'.sqlite'}}
 async sync(){if(this.busy)return {busy:true};if(!this.config().enabled)return {enabled:false};this.busy=true;try{
  const prefix=this.config().prefix;
  for(const p of this.store.projects()){const key='projects/'+p.id+'/latest.json';if(this.store.objectInfo(prefix+key)?.revision===p.revision)continue;const snapshot=this.store.project(p.id),body=JSON.stringify({schemaVersion:1,...snapshot},null,2);await this.put('projects/'+p.id+'/versions/'+p.revision+'.json',body,{kind:'project-version',id:p.id,revision:p.revision});await this.put(key,body,{kind:'project',id:p.id,revision:p.revision})}
  for(const {id} of this.store.db.prepare('SELECT id FROM runs ORDER BY created_at').all())await this.syncRun(this.store.run(id));
  if(this.connectors)await this.connectors.sync();
  const last=this.store.setting('last-backup');if(!last||Date.now()-Date.parse(last.at)>86400000)await this.backup();this.lastSync=new Date().toISOString();this.lastError=null;return this.status();
 }catch(e){this.lastError='同步未完成，服务器数据已保留；请检查存储配置后重试。';throw new ApiError(this.lastError,502)}finally{this.busy=false}}
 async downloadObject(key){const known=this.store.db.prepare('SELECT key,kind,resource_id FROM objects WHERE key=?').get(key),c=this.config();if(!known||!key.startsWith(c.prefix))throw new ApiError('没有找到已同步的对象。',404);const client=this.client(c);try{const result=await client.send(new GetObjectCommand({Bucket:c.bucket,Key:key}));result.Body.once('end',()=>client.destroy()).once('error',()=>client.destroy()).once('close',()=>client.destroy());return {stream:result.Body,kind:known.kind,name:key.split('/').at(-1)}}catch{client.destroy();throw new ApiError('对象下载失败。',502)}}
 async downloadBackup(id){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new ApiError('备份标识无效。');const c=this.config(),client=this.client(c);try{const result=await client.send(new GetObjectCommand({Bucket:c.bucket,Key:c.prefix+'backups/'+id+'.sqlite'}));result.Body.once('end',()=>client.destroy()).once('error',()=>client.destroy()).once('close',()=>client.destroy());return result.Body}catch{client.destroy();throw new ApiError('备份下载失败。',502)}}
}
