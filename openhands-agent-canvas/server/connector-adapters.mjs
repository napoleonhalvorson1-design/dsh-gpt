import {S3Client,ListObjectsV2Command,GetObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {randomUUID} from 'node:crypto';
import {request,endpoint,MAX_BYTES,networkAgents} from './connector-http.mjs';
import {template} from './connector-catalog.mjs';
import {ApiError} from '../shared/openhands.mjs';
import {githubDelivery,GITHUB_DELIVERY_OPERATIONS,GITHUB_DELIVERY_WRITES} from './github-delivery.mjs';
const enc=encodeURIComponent,segments=p=>String(p||'').split('/').map(enc).join('/');
const qs=value=>{const p=new URLSearchParams();for(const [k,v] of Object.entries(value))if(v!==undefined&&v!==null&&v!=='')p.set(k,String(v));return p.toString()};
export function redactSecrets(value,secrets){const values=Object.values(secrets||{}).filter(s=>typeof s==='string'&&s.length).sort((a,b)=>b.length-a.length);const walk=v=>typeof v==='string'?values.reduce((s,key)=>s.split(key).join('[已隐藏]'),v):Array.isArray(v)?v.map(walk):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[walk(k),walk(x)])):v;return walk(value)}
export function authHeaders(c,secrets){const auth=c.config.auth||{};switch(auth.type){case 'bearer':if(c.type==='github'&&!secrets.token)return {};if(!secrets.token)throw new ApiError('请配置 token 凭据。');return {Authorization:'Bearer '+secrets.token};case 'basic':if(!secrets.username||!secrets.password)throw new ApiError('请配置 username/password 凭据。');return {Authorization:'Basic '+Buffer.from(secrets.username+':'+secrets.password).toString('base64')};case 'apiKey':if(!/^[a-zA-Z0-9-]+$/.test(auth.header||'')||/^(host|cookie|connection|content-length)$/i.test(auth.header))throw new ApiError('API Key Header 无效。');if(!secrets.token)throw new ApiError('请配置 token 凭据。');return {[auth.header]:(auth.prefix||'')+secrets.token};default:return {}}}
export async function invokeAdapter(c,operation,input,{secrets,signal,store,storage,profiles,engine,invocationId,onLink}){
 const headers={...authHeaders(c,secrets)},send=(path,options={})=>request({...c.config,baseUrl:c.config.baseUrl},path,{signal,timeout:c.config.timeoutMs||30000,...options,headers:{...headers,...options.headers}}),json=(path,method,body,extra={})=>send(path,{method,headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
 if(c.type==='http'){
  const context={input,secrets},def=c.config.operations.find(o=>o.id===operation),query={};for(const [k,v] of Object.entries(def.query||{})){if(typeof v==='string'){const only=v.match(/^\{\{input\.([\w-]+)\}\}$/);if(only&&input[only[1]]===undefined)continue}query[k]=template(v,context)}
  const optional=v=>typeof v==='string'&&v.match(/^\{\{input\.([\w-]+)\}\}$/)?.[1],path=template(def.path,context,{encode:true}),q=qs(query),customHeaders=template(Object.fromEntries(Object.entries(def.headers||{}).filter(([,v])=>!optional(v)||input[optional(v)]!==undefined)),context);let body=def.body===undefined||optional(def.body)&&input[optional(def.body)]===undefined?undefined:template(def.body,context);if(body!==undefined&&def.bodyType!=='text'){body=JSON.stringify(body);customHeaders['Content-Type']='application/json'}
  return send(path+(q?(path.includes('?')?'&':'?')+q:''),{method:def.method,headers:customHeaders,body});
 }
 if(c.type==='openai'||c.type==='anthropic'){
  if(operation==='models')return send('models');
  const model=input.model||c.config.model;if(!model)throw new ApiError('请配置模型或传入 model。');
  if(c.type==='anthropic')return json('messages','POST',{model,max_tokens:input.maxTokens||1024,...(input.system?{system:input.system}:{}),messages:[{role:'user',content:input.prompt}]},{'anthropic-version':'2023-06-01',...(secrets.token?{'x-api-key':secrets.token}:{})});
  return json('chat/completions','POST',{model,messages:[...(input.system?[{role:'system',content:input.system}]:[]),{role:'user',content:input.prompt}],...(input.maxTokens?{max_tokens:input.maxTokens}:{}),stream:false});
 }
 if(c.type==='github'){
  headers.Accept='application/vnd.github+json';headers['X-GitHub-Api-Version']='2022-11-28';headers['User-Agent']='OpenHands-Canvas-Engine';
  const authenticated=Object.entries(headers).some(([name,value])=>name.toLowerCase()==='authorization'&&!!value);if(c.config.owner&&input.owner&&input.owner.toLowerCase()!==c.config.owner.toLowerCase())throw new ApiError('此连接仅允许操作配置的 GitHub owner。',403);if(['put_file','create_issue',...GITHUB_DELIVERY_WRITES].includes(operation)&&!authenticated)throw new ApiError('网站后台尚未配置 GitHub 凭据，请先通过网站或环境变量授权。',409);
  if(operation==='test')return send(authenticated?'user':'rate_limit');
  if(GITHUB_DELIVERY_OPERATIONS.includes(operation))return githubDelivery(c,operation,input,{send,json});
  const repo='repos/'+enc(input.owner||'')+'/'+enc(input.repo||'');
  if(operation==='repos'){if(!authenticated&&!c.config.owner)throw new ApiError('未配置 GitHub 凭据；公开读取请配置 owner。',409);const r=await send((authenticated?'user/repos':'users/'+enc(c.config.owner)+'/repos')+'?'+qs({per_page:Math.min(input.limit||30,100),page:input.page||1,...(authenticated&&c.config.owner?{affiliation:'owner'}:{})}));if(authenticated&&c.config.owner&&Array.isArray(r.data))r.data=r.data.filter(repo=>repo.owner?.login?.toLowerCase()===c.config.owner.toLowerCase());return r};
  if(operation==='contents'){const r=await send(repo+'/contents/'+segments(input.path)+'?'+qs({ref:input.ref}));if(r.data?.encoding==='base64'&&typeof r.data.content==='string')r.data={...r.data,text:Buffer.from(r.data.content,'base64').toString('utf8')};return r}
  if(operation==='issues')return send(repo+'/issues?'+qs({per_page:Math.min(input.limit||30,100),page:input.page||1}));
  if(operation==='create_issue')return json(repo+'/issues','POST',{title:input.title,body:input.body||''});
  return json(repo+'/contents/'+segments(input.path),'PUT',{content:Buffer.from(input.content).toString('base64'),message:input.message,...(input.sha?{sha:input.sha}:{}),...(input.branch?{branch:input.branch}:{})});
 }
 if(c.type==='webdav'){
  if(operation==='list')return send(segments(input.path),{method:'PROPFIND',headers:{Depth:'1','Content-Type':'application/xml; charset=utf-8'},body:'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>'});
  return send(segments(input.path),{method:{read:'GET',put:'PUT',mkdir:'MKCOL'}[operation],...(operation==='put'?{body:input.content,headers:{'Content-Type':'application/octet-stream'}}:{})});
 }
 if(c.type==='google-drive'){
  if(operation==='list')return send('files?'+qs({q:input.q||'trashed = false',pageSize:Math.min(input.limit||30,1000),pageToken:input.cursor,fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)'}));
  if(operation==='read')return send('files/'+enc(input.fileId)+(input.exportMimeType?'/export?mimeType='+enc(input.exportMimeType):'?alt=media'));
  if(operation==='create'){
   const boundary='canvas_'+randomUUID(),meta={name:input.name,mimeType:input.mimeType||'text/plain',...(input.parentId?{parents:[input.parentId]}:{})},body='--'+boundary+'\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n'+JSON.stringify(meta)+'\r\n--'+boundary+'\r\nContent-Type: '+meta.mimeType+'\r\n\r\n'+input.content+'\r\n--'+boundary+'--';
   return request({...c.config,baseUrl:new URL(c.config.baseUrl).origin+'/upload/drive/v3'},'files?uploadType=multipart',{method:'POST',signal,headers:{...headers,'Content-Type':'multipart/related; boundary='+boundary},body});
  }
  return request({...c.config,baseUrl:new URL(c.config.baseUrl).origin+'/upload/drive/v3'},'files/'+enc(input.fileId)+'?uploadType=media',{method:'PATCH',signal,headers:{...headers,'Content-Type':'application/octet-stream'},body:input.content});
 }
 if(c.type==='onedrive'){
  const item=input.path?'me/drive/root:/'+segments(input.path):'me/drive/root';
  if(operation==='list'){
   let path=item+(input.path?':/children':'/children');
   if(input.cursor){const u=new URL(input.cursor),root=new URL(c.config.baseUrl);if(u.origin!==root.origin||!u.pathname.startsWith(root.pathname+'/'))throw new ApiError('OneDrive 分页地址不属于此连接。');path=u.pathname.slice(root.pathname.length+1)+u.search}
   return send(path);
  }
  if(operation==='put')return send(item+':/content',{method:'PUT',headers:{'Content-Type':'application/octet-stream'},body:input.content});
  const meta=await send(item),url=meta.data?.['@microsoft.graph.downloadUrl'];if(!url)throw new ApiError('此文件没有可用下载链接。',502);const u=new URL(url),base=endpoint(u.origin);return request({baseUrl:base,allowPrivate:false},u.pathname+u.search,{signal});
 }
 if(c.type==='s3'||c.type==='canvas-storage'){
  const cfg=c.type==='canvas-storage'?storage.config():{...c.config,...secrets},prefix=cfg.prefix||'';let key=input.key||'';
  if(key.startsWith('/')||key.split('/').some(x=>x==='..'||x==='.')||/[\x00-\x1f\\]/.test(key))throw new ApiError('对象键必须是安全的相对路径。');
  if(c.type==='canvas-storage'&&operation==='put'&&!key.startsWith('engine-data/'))throw new ApiError('工作台桶的引擎写入请使用 engine-data/ 前缀，保护项目和备份。');
  if(c.type==='canvas-storage'&&operation==='list'){const page=await storage.list({prefix:prefix+(input.prefix||''),cursor:input.cursor||'',limit:input.limit||30});return {data:{...page,items:page.items.map(item=>({...item,key:item.key.slice(prefix.length)}))}};}
  if(c.type==='canvas-storage'&&!cfg.enabled)throw new ApiError('工作台数据桶尚未启用。',409);
  endpoint(cfg.endpoint,c.config);
  const client=new S3Client({endpoint:cfg.endpoint,region:cfg.region||'auto',forcePathStyle:!!cfg.forcePathStyle,maxAttempts:1,requestHandler:networkAgents(c.config),credentials:{accessKeyId:cfg.accessKeyId,secretAccessKey:cfg.secretAccessKey,...(cfg.sessionToken?{sessionToken:cfg.sessionToken}:{})}});
  try{
   const params={Bucket:cfg.bucket},opts={abortSignal:signal};
   if(operation==='list'){const d=await client.send(new ListObjectsV2Command({...params,Prefix:prefix+(input.prefix||''),ContinuationToken:input.cursor||undefined,MaxKeys:Math.min(input.limit||30,1000)}),opts);return {data:{items:(d.Contents||[]).map(x=>({key:x.Key.slice(prefix.length),size:x.Size,updatedAt:x.LastModified})),nextCursor:d.NextContinuationToken||null,hasMore:!!d.IsTruncated}}}
   if(operation==='put'){if(Buffer.byteLength(input.content)>MAX_BYTES)throw new ApiError('写入内容超过 2 MiB。');const d=await client.send(new PutObjectCommand({...params,Key:prefix+key,Body:input.content,ContentType:input.contentType||'text/plain; charset=utf-8'}),opts);return {data:{key,etag:d.ETag}}}
   const d=await client.send(new GetObjectCommand({...params,Key:prefix+key}),opts);if(d.ContentLength>MAX_BYTES){d.Body.destroy();throw new ApiError('文件超过 2 MiB，请通过文件下载入口读取。',413)}let count=0,chunks=[];for await(const b of d.Body){count+=b.length;if(count>MAX_BYTES){d.Body.destroy();throw new ApiError('文件超过 2 MiB。',413)}chunks.push(b)}return {data:{key,content:Buffer.concat(chunks).toString('utf8'),contentType:d.ContentType,etag:d.ETag}};
  }finally{client.destroy()}
 }
 if(c.type==='agent'){
  const profile=profiles.resolve(c.config.profileId);if(operation==='test')return {data:{profileId:profile.profileId,label:profile.profileLabel,model:profile.acpModel||profile.model,configured:true}};
  const runId='engine-'+invocationId,projectId=runId,flow={title:c.label+' · 引擎任务',task:input.task,executionProfile:c.config.profileId,nodes:[{id:'start',type:'start',name:'起点',x:0,y:0},{id:'agent',type:'custom',name:c.label,x:240,y:0,prompt:'完成本次任务并交付结果。'}],edges:[['start','agent']]};
  if(!store.project(projectId))store.putProject(projectId,flow,0);
  const run=store.run(runId)||engine.enqueue({id:runId,projectId,workflow:flow},profiles.compile(profile,flow));onLink?.({runId:run.id,projectId});
  return waitForAgentRun(store,{runId,projectId},signal);
 }
 throw new ApiError('连接器未实现。');
}

export async function waitForAgentRun(store,{runId,projectId},signal){
 for(;;){const r=store.run(runId);if(!r||r.projectId!==projectId)throw new ApiError('关联的 AI 运行不存在或不匹配。',409);if(r.status==='succeeded')return {data:{runId,projectId,output:r.nodes.agent.output}};if(!['queued','running','reconnecting','stopping'].includes(r.status))throw new ApiError('AI 任务未完成，请查看运行 '+runId+'：'+(r.error||r.status),409);if(signal.aborted)throw new ApiError('引擎等待已中断；AI 任务状态请查询运行 '+runId+'。',409);await new Promise(resolve=>setTimeout(resolve,500))}
}
