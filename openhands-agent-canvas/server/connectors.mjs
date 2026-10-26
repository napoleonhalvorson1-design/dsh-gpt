import {randomUUID,createHash} from 'node:crypto';
import {ApiError} from '../shared/openhands.mjs';
import {endpoint,target} from './connector-http.mjs';
import {TYPES,operations,validateInput,importOpenApi,template} from './connector-catalog.mjs';
import {invokeAdapter,redactSecrets,authHeaders,waitForAgentRun} from './connector-adapters.mjs';
const validId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(v),now=()=>new Date().toISOString();
const stable=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])):value??null);
const hash=v=>createHash('sha256').update(stable(v)).digest('hex');
export class Connectors {
 constructor(store,{storage,profiles,engine,environment=process.env,maxActive=8}={}){
  Object.assign(this,{store,storage,profiles,engine,environment,maxActive});this.active=new Map();this.closed=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS engine_connections(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS engine_pipelines(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS engine_invocations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,connection_id TEXT,status TEXT NOT NULL,fingerprint TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS engine_calls ON engine_invocations(created_at DESC,id DESC);`);
  for(const row of store.db.prepare("SELECT id FROM engine_invocations WHERE status IN ('running','interrupted')").all()){
   const r=this.job(row.id),c=r.connectionId?this.connection(r.connectionId):null,linked=r.linkedRun?.runId&&store.run(r.linkedRun.runId);
   if(r.kind==='operation'&&r.operation==='run'&&c?.type==='agent'&&linked&&linked.projectId===r.linkedRun.projectId){this.attachAgent(r);continue}
   if(r.status==='running'){r.status='interrupted';r.error='服务已重启。外部操作可能已经执行，请先核对结果；引擎不会自动重放。';this.saveJob(r)}
  }
 }
 attachAgent(record){
  const controller=new AbortController();record.status='running';record.error=null;record.recoveredAt=now();this.saveJob(record);
  const pending=waitForAgentRun(this.store,record.linkedRun,controller.signal).then(result=>{const r=this.job(record.id);r.status='succeeded';r.result=result;this.saveJob(r)}).catch(error=>{const r=this.job(record.id);r.status=controller.signal.aborted?'interrupted':'failed';r.error=error instanceof ApiError?error.message:'关联 AI 任务恢复失败，请查看原运行。';this.saveJob(r)}).finally(()=>this.active.delete(record.id));this.active.set(record.id,{controller,pending,connectionId:record.connectionId});
 }
 raw(id){const row=this.store.db.prepare('SELECT * FROM engine_connections WHERE id=?').get(id);return row?{...this.store.decrypt(row.payload),revision:row.revision,updatedAt:row.updated_at}:null}
 builtins(){return [...this.profiles.list().items.map(p=>({id:'ai-'+p.id,label:p.label,type:'agent',system:true,enabled:true,readOnly:false,revision:0,config:{profileId:p.id},secrets:{}})),{id:'primary-bucket',label:'七彩云 · 工作台数据桶',type:'canvas-storage',system:true,enabled:true,readOnly:true,revision:0,config:{},secrets:{}}]}
 connection(id){return this.raw(id)||this.builtins().find(c=>c.id===id)||null}
 public(c){const out={...c,secretNames:Object.keys(c.secrets||{}),operations:operations(c)};if(c.type==='github'){let ready=false;try{ready=Object.entries(authHeaders(c,this.resolved(c))).some(([name,value])=>name.toLowerCase()==='authorization'&&!!value)}catch{}out.authorization={status:ready?'configured':'required',credentialConfigured:ready,writeConfigured:!c.readOnly,writeReady:ready&&!c.readOnly,repositoryPermissions:'unverified',owner:c.config.owner||null};out.operations=out.operations.map(op=>({...op,available:op.readOnly||ready&&!c.readOnly,...(!op.readOnly&&!ready?{unavailableReason:'网站后台尚未配置 GitHub 凭据；Codex 的已连接 GitHub 是独立授权。'}:{})}))};delete out.secrets;out.config={...c.config};return out}
 list(){const ids=this.store.db.prepare('SELECT id FROM engine_connections ORDER BY updated_at DESC').all().map(x=>x.id),values=ids.map(id=>this.raw(id));for(const c of this.builtins())if(!ids.includes(c.id))values.push(c);return {schemaVersion:1,items:values.map(c=>this.public(c))}}
 types(){return {schemaVersion:1,items:TYPES.map(t=>({...t,operations:t.system?[]:operations({type:t.id,config:{operations:[]}})}))}}
 save(id,input){
  if(!validId(id))throw new ApiError('连接 ID 无效。');const old=this.connection(id),expected=Number(input.expectedRevision);if((old?.revision||0)!==expected)throw new ApiError('连接已更新，请读取当前版本后重试。',409);
  if(this.activeConnection(id))throw new ApiError('连接仍有调用正在执行，请等待完成。',409);
  if(this.store.db.prepare('SELECT COUNT(*) AS n FROM engine_connections').get().n>=200&&!this.raw(id))throw new ApiError('最多保存 200 个连接。');
  for(const key of ['enabled','readOnly'])if(input[key]!==undefined&&typeof input[key]!=='boolean')throw new ApiError(key+' 必须是布尔值。');
  const type=old?.system?old.type:input.type||old?.type;if(!TYPES.some(t=>t.id===type)||!old?.system&&['agent','canvas-storage'].includes(type))throw new ApiError('请选择有效的连接器类型。');
  if(old&&old.type!==type)throw new ApiError('更换连接器类型请创建新的连接，避免已有流程引用发生变化。');
  const config=old?.system?old.config:{...old?.config,...input.config};
  if(!old?.system){
   const t=TYPES.find(t=>t.id===type);config.baseUrl=endpoint(config.baseUrl||t.baseUrl||config.endpoint,{allowPrivate:config.allowPrivate===true});config.allowPrivate=config.allowPrivate===true;config.auth=config.auth||{type:['openai','github','google-drive','onedrive'].includes(type)?'bearer':type==='anthropic'?'apiKey':type==='webdav'?'basic':'none',...(type==='anthropic'?{header:'x-api-key'}:{})};if(!['none','bearer','basic','apiKey'].includes(config.auth.type))throw new ApiError('认证方式无效。');config.timeoutMs=Math.max(1000,Math.min(120000,Number(config.timeoutMs)||30000));
   if(config.headers||config.apiKey||config.token||config.password||config.secretAccessKey)throw new ApiError('凭据必须通过 secrets 字段或环境变量引用配置，不能放在 config 中。');
   if(type==='github'&&config.owner!==undefined&&(!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(config.owner)))throw new ApiError('GitHub owner 无效。');
   if(type==='github'&&config.requiredChecks!==undefined&&(!Array.isArray(config.requiredChecks)||config.requiredChecks.length>100||config.requiredChecks.some(n=>typeof n!=='string'||!n||n.length>200)))throw new ApiError('GitHub 必要检查名称无效。');
   if(type==='s3'){config.endpoint=config.baseUrl;if(!config.bucket||typeof config.bucket!=='string'||!config.region)throw new ApiError('请填写 S3 Bucket 和 Region。');if(config.prefix&&(/^[\/\\]/.test(config.prefix)||config.prefix.split('/').some(p=>p==='..')||config.prefix.length>1000))throw new ApiError('S3 前缀无效。');}
   if(type==='http'){
    if(input.openApi)config.operations=importOpenApi(input.openApi);
    if(!Array.isArray(config.operations)||config.operations.length<1||config.operations.length>80)throw new ApiError('通用接口需要 1 至 80 个操作定义。');
    const ids=new Set();for(const op of config.operations){if(!validId(op.id)||ids.has(op.id)||!['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE','PROPFIND','MKCOL'].includes(op.method))throw new ApiError('接口操作 ID 或方法无效。');ids.add(op.id);target(config.baseUrl,String(op.path||''));for(const name of Object.keys(op.headers||{}))if(/^(authorization|proxy-authorization|cookie|host|connection|content-length|transfer-encoding)$/i.test(name)||config.auth.type==='apiKey'&&name.toLowerCase()===String(config.auth.header).toLowerCase())throw new ApiError('操作不能覆盖认证或传输 Header。请使用连接 auth 配置。');if(op.path?.includes('{{secrets.')||JSON.stringify(op.query||{}).includes('{{secrets.'))throw new ApiError('密钥不能放入 URL，请使用认证 Header。');}
   }
  }
  const secrets={...old?.secrets};for(const [key,value] of Object.entries(input.secrets||{})){
   if(!/^[a-zA-Z][\w-]{0,79}$/.test(key))throw new ApiError('凭据字段名无效。');if(value===null){delete secrets[key];continue}if(value==='')continue;
   if(typeof value!=='string'&&!(value&&typeof value==='object'&&typeof value.env==='string'&&/^[A-Z][A-Z0-9_]{0,100}$/.test(value.env)&&Object.keys(value).length===1)||typeof value==='string'&&value.length>15000)throw new ApiError('凭据应为文本或 {"env":"环境变量名"}。');if(typeof value==='object'&&!this.allowedEnvironment(value.env))throw new ApiError('外部凭据请使用 CANVAS_ENGINE_ 前缀环境变量，或由控制器 CANVAS_ENGINE_ALLOWED_ENV 显式允许；服务内部密钥不可引用。',403);secrets[key]=value;
  }
  if(old?.system&&Object.keys(input.secrets||{}).length)throw new ApiError('内置连接凭据由原有服务管理。');
  const c={id,type,label:String(input.label||old?.label||id).slice(0,100),enabled:input.enabled??old?.enabled??true,readOnly:input.readOnly??old?.readOnly??true,system:!!old?.system,config,secrets},stamp=now();
  this.store.db.prepare('INSERT INTO engine_connections VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at').run(id,expected+1,this.store.encrypt(c),stamp);return this.public(this.raw(id));
 }
 activeConnection(id){return [...this.active.values()].some(v=>v.connectionId===id)||this.store.db.prepare("SELECT 1 FROM engine_invocations WHERE status='running' AND kind='pipeline' LIMIT 1").get()}
 remove(id,revision){const c=this.raw(id);if(!c)throw new ApiError('连接不存在。',404);if(c.system)throw new ApiError('内置连接可禁用，不能删除。',409);if(c.revision!==revision)throw new ApiError('连接版本冲突。',409);if(this.activeConnection(id))throw new ApiError('仍有调用使用此连接。',409);this.store.db.prepare('DELETE FROM engine_connections WHERE id=?').run(id);return {ok:true}}
 allowedEnvironment(name){return name!=='CANVAS_ENGINE_ALLOWED_ENV'&&(/^CANVAS_ENGINE_[A-Z0-9_]+$/.test(name)||String(this.environment.CANVAS_ENGINE_ALLOWED_ENV||'').split(',').map(s=>s.trim()).includes(name))&&!/^(CANVAS_(CONTROL_|ACCESS_|SESSION_|S3_)|OPENHANDS_|AWS_)/.test(name)}
 resolved(c){const result={};for(const [k,v] of Object.entries(c.secrets||{})){if(typeof v!=='string'&&!this.allowedEnvironment(v.env))throw new ApiError('此环境变量未授权给接入引擎。',403);const value=typeof v==='string'?v:this.environment[v.env];if(typeof value!=='string'||!value)throw new ApiError('凭据 '+k+' 的环境变量尚未配置。',409);result[k]=value}return result}
 operation(id,operation,input){const c=this.connection(id);if(!c)throw new ApiError('连接不存在。',404);if(!c.enabled)throw new ApiError('连接已禁用。',409);const op=operations(c).find(o=>o.id===operation);if(!op)throw new ApiError('操作不存在。',404);if(c.readOnly&&!op.readOnly)throw new ApiError('此连接为只读，请在连接设置明确启用写入后再执行。',403);validateInput(input,op.inputSchema);return {c,op}}
 job(id){const row=this.store.db.prepare('SELECT payload FROM engine_invocations WHERE id=?').get(id);return row?this.store.decrypt(row.payload):null}
 saveJob(r){r.updatedAt=now();this.store.db.prepare('UPDATE engine_invocations SET status=?,payload=?,updated_at=? WHERE id=?').run(r.status,this.store.encrypt(r),r.updatedAt,r.id);return r}
 history(cursor=''){let boundary=null;if(cursor){try{boundary=JSON.parse(Buffer.from(cursor,'base64url').toString());if(!Array.isArray(boundary)||boundary.length!==2)throw Error()}catch{throw new ApiError('调用分页标识无效。')}}const rows=boundary?this.store.db.prepare('SELECT id,created_at FROM engine_invocations WHERE (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT 31').all(...boundary):this.store.db.prepare('SELECT id,created_at FROM engine_invocations ORDER BY created_at DESC,id DESC LIMIT 31').all(),page=rows.slice(0,30);return {items:page.map(({id})=>{const r=this.job(id);return {id,kind:r.kind,connectionId:r.connectionId,operation:r.operation,pipelineId:r.pipelineId,status:r.status,error:r.error,createdAt:r.createdAt,updatedAt:r.updatedAt,linkedRun:r.linkedRun||null}}),hasMore:rows.length>30,nextCursor:rows.length>30?Buffer.from(JSON.stringify([page.at(-1).created_at,page.at(-1).id])).toString('base64url'):null}}
 async perform(c,operation,input,id,signal){const secrets=this.resolved(c),redactions={...secrets,...authHeaders(c,secrets)};try{return redactSecrets(await invokeAdapter(c,operation,input,{secrets,signal,store:this.store,storage:this.storage,profiles:this.profiles,engine:this.engine,invocationId:id,onLink:link=>{const r=this.job(id);if(r){r.linkedRun=link;this.saveJob(r)}}}),redactions)}catch(e){throw new ApiError(redactSecrets({message:e instanceof ApiError?e.message:'连接器调用失败，请检查凭据、权限和参数。'},secrets).message,e instanceof ApiError?e.status:502)}}
 start(input,{scopes=['read','write','run']}={}){
  const id=input.id||randomUUID();if(!validId(id))throw new ApiError('调用 ID 无效。');const args=input.input||{},fingerprint=hash({kind:'operation',connectionId:input.connectionId,operation:input.operation,input:args}),old=this.job(id);if(old){if(old.fingerprint!==fingerprint)throw new ApiError('调用 ID 已用于不同参数，请使用新的 ID。',409);return old}
  const {c,op}=this.operation(input.connectionId,input.operation,args);if(!scopes.includes(op.readOnly?'read':'run'))throw new ApiError('没有执行此操作的权限。',403);if(this.active.size>=this.maxActive)throw new ApiError('引擎并发调用已满，请稍后提交。',429);
  return this.launch({id,kind:'operation',connectionId:c.id,connectionRevision:c.revision,operation:op.id,input:args,fingerprint},signal=>this.perform(c,op.id,args,id,signal));
 }
 launch(record,work){
  if(this.closed)throw new ApiError('引擎正在关闭。',503);
  const controller=new AbortController(),r={...record,status:'running',createdAt:now(),updatedAt:now(),error:null,result:null};this.store.db.prepare('INSERT INTO engine_invocations VALUES(?,?,?,?,?,?,?,?)').run(r.id,r.kind,r.connectionId||null,r.status,r.fingerprint,this.store.encrypt(r),r.createdAt,r.updatedAt);
  const pending=Promise.resolve().then(()=>work(controller.signal)).then(result=>{const value=this.job(r.id);value.status='succeeded';value.result=result;this.saveJob(value)}).catch(e=>{const value=this.job(r.id);value.status=controller.signal.aborted?'interrupted':'failed';value.error=e instanceof ApiError?e.message:'引擎操作失败，请检查连接和流程配置。';this.saveJob(value)}).finally(()=>this.active.delete(r.id));this.active.set(r.id,{controller,pending,connectionId:r.connectionId});return r;
 }
 async test(id){const c=this.connection(id);if(!c)throw new ApiError('连接不存在。',404);if(!c.enabled)throw new ApiError('连接已禁用。',409);const op=operations(c).find(o=>o.id===c.config.testOperation)||operations(c).find(o=>o.readOnly);if(!op||!op.readOnly)throw new ApiError('请配置一个只读的 testOperation。');let input=c.config.testInput||{};if(c.type==='webdav')input={path:''};if(c.type==='github'){const authenticated=this.public(c).authorization.credentialConfigured,r=await this.perform(c,'test',{},'test-'+randomUUID(),AbortSignal.timeout(30000));return {ok:true,operation:authenticated?'user':'rate_limit',status:r.status,authenticated,writeConfigured:!c.readOnly,message:authenticated?'GitHub 后台凭据有效；具体仓库读写仍以仓库权限为准。':'GitHub 公共读取可用；网站后台未配置凭据，私有仓库及写入尚未授权。'}}
  validateInput(input,op.inputSchema);const result=await this.perform(c,op.id,input,'test-'+randomUUID(),AbortSignal.timeout(30000));return {ok:true,operation:op.id,status:result.status||200,message:c.type==='agent'?'执行入口已配置；此检查未调用模型。':'只读连接测试通过。',preview:JSON.stringify(result.data).slice(0,1200)};
 }
 pipeline(id){const row=this.store.db.prepare('SELECT * FROM engine_pipelines WHERE id=?').get(id);return row?{...this.store.decrypt(row.payload),revision:row.revision,updatedAt:row.updated_at}:null}
 pipelines(){return {items:this.store.db.prepare('SELECT id FROM engine_pipelines ORDER BY updated_at DESC').all().map(r=>this.pipeline(r.id))}}
 savePipeline(id,input){if(!validId(id))throw new ApiError('流程 ID 无效。');const old=this.pipeline(id),expected=Number(input.expectedRevision);if((old?.revision||0)!==expected)throw new ApiError('流程版本冲突。',409);if(!old&&this.store.db.prepare('SELECT COUNT(*) AS n FROM engine_pipelines').get().n>=200)throw new ApiError('最多保存 200 个流程。');const steps=input.steps;if(!Array.isArray(steps)||!steps.length||steps.length>30)throw new ApiError('流程需要 1 至 30 个步骤。');const seen=new Set();for(const s of steps){if(!validId(s.id)||seen.has(s.id)||!validId(s.connectionId)||typeof s.operation!=='string')throw new ApiError('流程步骤无效或重复。');seen.add(s.id);const c=this.connection(s.connectionId);if(!c||!operations(c).some(o=>o.id===s.operation))throw new ApiError('步骤引用了不存在的连接或操作。');if(c.type==='github'&&s.operation==='merge_pull_request')throw new ApiError('合并须在 CI 通过后由 Codex 单独批准，不能放入自动流程。',409);if(s.input!==undefined&&(!s.input||typeof s.input!=='object'||Array.isArray(s.input)))throw new ApiError('步骤 input 必须是对象。')}
  const p={id,label:String(input.label||id).slice(0,100),steps},stamp=now();this.store.db.prepare('INSERT INTO engine_pipelines VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at').run(id,expected+1,this.store.encrypt(p),stamp);return this.pipeline(id);
 }
 startPipeline(input,{scopes=['read','write','run']}={}){
  if(!scopes.includes('run')||!scopes.includes('read'))throw new ApiError('执行流程需要 read 和 run 权限。',403);const id=input.id||randomUUID(),p=this.pipeline(input.pipelineId);if(!validId(id)||!p)throw new ApiError('流程或调用 ID 无效。');const args=input.input||{},fingerprint=hash({kind:'pipeline',pipelineId:p.id,input:args}),old=this.job(id);if(old){if(old.fingerprint!==fingerprint)throw new ApiError('调用 ID 已用于其他参数。',409);return old}if(this.active.size>=this.maxActive)throw new ApiError('引擎并发调用已满。',429);
  const snapshots=Object.fromEntries(p.steps.map(s=>[s.connectionId,this.connection(s.connectionId)]));for(const step of p.steps){const c=snapshots[step.connectionId];if(!c?.enabled)throw new ApiError('流程连接已禁用或删除。',409);const op=operations(c).find(o=>o.id===step.operation);if(c.type==='github'&&step.operation==='merge_pull_request')throw new ApiError('合并须在 CI 通过后单独批准。',409);if(!op||c.readOnly&&!op.readOnly)throw new ApiError('流程操作不可用或连接只读。',403)}
  return this.launch({id,kind:'pipeline',pipelineId:p.id,pipelineRevision:p.revision,input:args,steps:p.steps.map(s=>({id:s.id,status:'pending'})),fingerprint},async signal=>{
   const context={input:args,steps:{}};
   for(let i=0;i<p.steps.length;i++){
    if(signal.aborted)throw new ApiError('流程已中断。');const s=p.steps[i],params=template(s.input||{},context),{op}=this.operation(s.connectionId,s.operation,params),c=snapshots[s.connectionId];validateInput(params,op.inputSchema);const childId=createHash('sha256').update(id+':'+s.id).digest('hex'),r=this.job(id);r.steps[i].status='running';r.steps[i].invocationId=childId;this.saveJob(r);
    const child=this.launch({id:childId,kind:'operation',connectionId:c.id,connectionRevision:c.revision,operation:s.operation,input:params,parentId:id,fingerprint:hash(params)},()=>this.perform(c,s.operation,params,childId,signal));await this.active.get(child.id).pending;const done=this.job(child.id),next=this.job(id);next.steps[i].status=done.status;this.saveJob(next);if(done.status!=='succeeded')throw new ApiError('步骤 '+s.id+' 失败：'+done.error,502);context.steps[s.id]=done.result;
   }return {steps:context.steps};
  });
 }
 export(){return {schemaVersion:1,connections:this.list().items.map(c=>{const out={...c};delete out.operations;delete out.secretNames;return out}),pipelines:this.pipelines().items,note:'不含密钥；导入后需重新配置凭据。'}}
 async sync(){
  if(!this.storage.config().enabled)return;
  const state=this.export(),fingerprint=hash(state),cfg=this.storage.config(),scope=cfg.endpoint+'/'+cfg.bucket+'/'+cfg.prefix,last=this.store.setting('engine-sync');
  if(last?.fingerprint!==fingerprint||last?.scope!==scope){const revision=Date.now();await this.storage.json('engine/versions/'+revision+'-'+fingerprint.slice(0,12)+'.json',state,{kind:'engine-config-version',id:'engine',revision});await this.storage.json('engine/latest.json',state,{kind:'engine-config',id:'engine',revision});this.store.setSetting('engine-sync',{fingerprint,scope})}
  for(const {id} of this.store.db.prepare('SELECT id FROM engine_invocations ORDER BY created_at DESC LIMIT 1000').all()){
   const job=this.job(id),key='engine/invocations/'+id+'.json',revision=Date.parse(job.updatedAt);if(this.store.objectInfo(cfg.prefix+key)?.revision===revision)continue;await this.storage.json(key,job,{kind:'engine-invocation',id,revision});
  }
 }
 async close(){this.closed=true;for(const v of this.active.values())v.controller.abort();await Promise.allSettled([...this.active.values()].map(v=>v.pending))}
}

