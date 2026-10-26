import http from 'node:http';
import {Readable} from 'node:stream';
import {createReadStream} from 'node:fs';
import {dirname} from 'node:path';
import {Storage,archiveRun} from './storage.mjs';
import {listFiles,readFileResult,downloadFileResult} from './files.mjs';
import {Profiles} from './profiles.mjs';
import {Access} from './access.mjs';
import {createHash,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {createDevelopmentProject} from './development.mjs';
import {Connectors} from './connectors.mjs';
import {Engine,ACTIVE,validateWorkflow} from './engine.mjs';
import {RepositorySources} from './repository-source.mjs';
import {analyzeRun} from '../shared/run-performance.mjs';
import {ApiError,validateConfig,upstream,cleanText} from '../shared/openhands.mjs';

export function createControl({database,apiKey,encryptionKey,pollMs=3000,defaults={},startEngine=true,storageIntervalMs=15000,profiles=new Profiles(),storageEnvironment=process.env}){
  if(!apiKey||!encryptionKey)throw Error('Control API credentials are required.');
  const store=new Store(database,encryptionKey),engine=new Engine(store,{pollMs,handoffDirectory:dirname(database)}),storage=new Storage(store,{directory:dirname(database),intervalMs:storageIntervalMs,environment:storageEnvironment}),access=new Access(store);
  engine.storage=storage;
  if(profiles.entries.size)store.setSetting('ai-profiles',{defaultId:profiles.defaultId,items:[...profiles.entries.values()]});else{const saved=store.setting('ai-profiles');if(saved)profiles=new Profiles(saved.items,saved.defaultId)}
  const connectors=new Connectors(store,{storage,profiles,engine,environment:storageEnvironment});
  engine.repositorySource=new RepositorySources({store,storage,connectors,directory:dirname(database)});
  storage.connectors=connectors;
  const authenticate=req=>{const received=Buffer.from(req.headers.authorization||''),expected=Buffer.from('Bearer '+apiKey);return received.length===expected.length&&timingSafeEqual(received,expected)};
  const json=(res,data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
  const body=async req=>{let text='';for await(const chunk of req){text+=chunk;if(text.length>1500000)throw new ApiError('请求内容过大。',413)}try{const value=JSON.parse(text||'{}');if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value}catch{throw new ApiError('请求 JSON 无效。')}};
  function config(value){const c=validateConfig(value||defaults);if(c.baseUrl===defaults.baseUrl){c.commands=defaults.commands;c.acpModel=c.acpModel||defaults.acpModel}return c}
  function safeRun(run){if(!run)return null;const out={...run};delete out.workflow;return out}
  function runSummary(run){return {id:run.id,projectId:run.projectId,title:run.title,status:run.status,error:run.error,createdAt:run.createdAt,updatedAt:run.updatedAt,index:run.index,total:run.order.length,revision:run.revision,schedulerVersion:run.schedulerVersion,completedCount:run.completedCount,activeNodeIds:run.activeNodeIds,maxParallelNodes:run.maxParallelNodes}}
  const server=http.createServer(async(req,res)=>{
    try{
      if(!authenticate(req))return json(res,{error:'未授权。'},401);
      const url=new URL(req.url,'http://localhost'),path=url.pathname,method=req.method;
      if(path==='/auth/check'&&method==='POST'){const data=await body(req),identity=access.verify(data.token);if(!identity)throw new ApiError('访问令牌无效或已撤销。',401);return json(res,identity)}
      if(path==='/auth/connect'&&method==='POST'){const data=await body(req);return json(res,access.connect(data.code,data.principal))}
      const identity=access.authorize(req,path,method);
      if(path==='/auth/principals'&&method==='GET')return json(res,{items:access.principals()});
      if(path.startsWith('/auth/principals/')&&method==='DELETE')return json(res,access.disconnect(decodeURIComponent(path.slice('/auth/principals/'.length))));
      if(path==='/auth/claim'&&method==='POST')return json(res,access.claim());
      if(path==='/auth/tokens'&&method==='GET')return json(res,{items:access.tokens()});
      if(path==='/auth/tokens'&&method==='POST')return json(res,access.create(await body(req)),201);
      if(/^\/auth\/tokens\/[a-zA-Z0-9_-]+$/.test(path)&&method==='DELETE')return json(res,access.revoke(path.split('/').at(-1)));
      if(path==='/storage/objects'&&method==='GET'){const object=await storage.downloadObject(url.searchParams.get('key')||'');if(res.destroyed){object.stream.destroy();return}res.writeHead(200,{'Content-Type':object.kind==='backup'?'application/vnd.sqlite3':['artifact','stage-artifact'].includes(object.kind)?'application/gzip':'application/json','Content-Disposition':`attachment; filename="${object.name}"`,'Cache-Control':'no-store'});res.once('close',()=>{if(!res.writableFinished)object.stream.destroy()});object.stream.on('error',()=>res.destroy()).pipe(res);return}
      if(path==='/storage/list'&&method==='GET')return json(res,await storage.list({limit:Number(url.searchParams.get('limit')||100),prefix:url.searchParams.get('prefix')||'',cursor:url.searchParams.get('cursor')||''}));
      if(path==='/storage'&&method==='GET')return json(res,storage.status());
      if(path==='/storage'&&method==='PUT')return json(res,storage.save(await body(req)));
      if(path==='/storage/test'&&method==='POST')return json(res,await storage.test());
      if(path==='/storage/sync'&&method==='POST')return json(res,await storage.sync());
      if(path==='/backups'&&method==='POST')return json(res,await storage.backup(),201);
      if(/^\/backups\/[a-zA-Z0-9_-]+$/.test(path)&&method==='GET'){const id=path.split('/').at(-1),stream=await storage.downloadBackup(id);if(res.destroyed){stream.destroy();return}res.writeHead(200,{'Content-Type':'application/vnd.sqlite3','Content-Disposition':`attachment; filename="${id}.sqlite"`,'Cache-Control':'no-store'});res.once('close',()=>{if(!res.writableFinished)stream.destroy()});stream.on('error',()=>res.destroy()).pipe(res);return}
      if(path.startsWith('/engine')){
        const match=path.match(/^\/engine\/(connections|pipelines|invocations)(?:\/([a-zA-Z0-9_-]{1,80}))?(?:\/(test|run))?$/),scopes=identity?.scopes||['read','write','run'];
        if(path==='/engine/types'&&method==='GET')return json(res,connectors.types());
        if(path==='/engine/export'&&method==='GET')return json(res,connectors.export());
        if(path==='/engine/invocations'&&method==='GET')return json(res,connectors.history(url.searchParams.get('cursor')||''));
        if(path==='/engine/invocations'&&method==='POST')return json(res,connectors.start(await body(req),{scopes}),202);
        if(match){const [,kind,id,action]=match;
          if(kind==='connections'){
            if(!id&&method==='GET')return json(res,connectors.list());
            if(id&&action==='test'&&method==='POST')return json(res,await connectors.test(id));
            if(id&&!action&&method==='GET'){const c=connectors.connection(id);if(!c)throw new ApiError('连接不存在。',404);return json(res,connectors.public(c))}
            if(id&&!action&&method==='PUT')return json(res,connectors.save(id,await body(req)));
            if(id&&!action&&method==='DELETE')return json(res,connectors.remove(id,Number(url.searchParams.get('revision'))));
          }
          if(kind==='pipelines'){
            if(!id&&method==='GET')return json(res,connectors.pipelines());
            if(id&&action==='run'&&method==='POST')return json(res,connectors.startPipeline({...await body(req),pipelineId:id},{scopes}),202);
            if(id&&!action&&method==='PUT')return json(res,connectors.savePipeline(id,await body(req)));
            if(id&&!action&&method==='GET'){const p=connectors.pipeline(id);if(!p)throw new ApiError('流程不存在。',404);return json(res,p)}
          }
          if(kind==='invocations'&&id&&method==='GET'){const r=connectors.job(id);if(!r)throw new ApiError('调用不存在。',404);return json(res,r)}
        }
        throw new ApiError('引擎接口不存在。',404);
      }
      if(path==='/health'&&method==='GET')return json(res,{ok:true,version:'5.6.0',integrationEngine:true,backgroundRuns:true,persistence:'sqlite'});
      if(path==='/profiles'&&method==='GET')return json(res,profiles.list());
      if(path==='/model-policy/preview'&&method==='POST'){const data=await body(req),flow=validateWorkflow(data.workflow),bundle=profiles.compile(config(data.backend),flow);return json(res,{mode:flow.modelMode||'manual',choices:flow.nodes.filter(n=>!['start','end'].includes(n.type)).map(n=>({nodeId:n.id,name:n.name,profileId:bundle.nodeConfigs?.[n.id]?.profileId,profileLabel:bundle.nodeConfigs?.[n.id]?.profileLabel,selection:bundle.nodeConfigs?.[n.id]?.selection||null})),planningPending:flow.collaborationMode==='adaptive',inferenceStarted:false})}
      if(path==='/development/projects'&&method==='POST')return json(res,createDevelopmentProject(store,profiles,await body(req)),201);
      if(path==='/projects'&&method==='GET')return json(res,{items:store.projects()});
      const projectMatch=path.match(/^\/projects\/([a-zA-Z0-9_-]{1,100})$/);
      if(projectMatch){const id=projectMatch[1];if(method==='GET'){const p=store.project(id);if(!p)throw new ApiError('项目不存在。',404);return json(res,p)}
        if(method==='PUT'){const data=await body(req);if(data.state?.preset==='five-ai'){if(Number(data.expectedRevision)!==0)throw new ApiError('五 AI 快捷创建仅用于新项目；修改请读取当前项目后保存完整工作流。');return json(res,createDevelopmentProject(store,profiles,{id,title:data.state.title,task:data.state.task,modelMode:data.state.modelMode,reasoningEffort:data.state.reasoningEffort,repository:data.state.repository,branch:data.state.branch,githubConnectionId:data.state.githubConnectionId}))}const flow=validateWorkflow(data.state);delete flow.order;const snapshot={...flow,projectId:id};const saved=store.putProject(id,snapshot,Number(data.expectedRevision)||0);if(!saved)throw new ApiError('此项目已在另一台设备更新，请重新载入或保留为副本。',409);return json(res,saved)}
        if(method==='DELETE'){if(store.listRuns(id).some(r=>ACTIVE.has(r.status)))throw new ApiError('项目仍有运行中的任务，请先停止运行。',409);store.deleteProject(id);return json(res,{ok:true})}}
      if(path==='/runs'&&method==='GET')return json(res,{items:store.listRuns(url.searchParams.get('projectId')||undefined).map(runSummary)});
      if(path==='/runs'&&method==='POST'){const data=await body(req),run=engine.enqueue(data,profiles.compile(config(data.backend),data.workflow));return json(res,safeRun(run),202)}
      const match=path.match(/^\/runs\/([a-zA-Z0-9_-]{1,100})(?:\/(events|stop|resume|artifacts|files|file|file-download|performance))?$/);
      if(match){const [,id,action]=match,run=store.run(id);if(!run)throw new ApiError('运行记录不存在。',404);
        if(!action&&method==='GET')return json(res,url.searchParams.get('version')===String(run.revision)?{unchanged:true,revision:run.revision}:safeRun(run));
        if(action==='performance'&&method==='GET')return json(res,{id:run.id,status:run.status,performance:analyzeRun(run,{now:Date.now()})});
        if(action==='events'&&method==='GET'){const after=Math.max(0,Number(url.searchParams.get('after'))||0),items=store.events(id,after);return json(res,{items,nextCursor:items.at(-1)?.seq||after,hasMore:items.length===200})}
        if(action==='stop'&&method==='POST'){const data=await body(req);const saved=store.config(id);if(data.backend&&!saved.nodeConfigs){const next=config(data.backend);if(next.baseUrl===saved.baseUrl)store.setConfig(id,next)}return json(res,safeRun(engine.stop(id)))}
        if(action==='resume'&&method==='POST'){const data=await body(req);return json(res,safeRun(await engine.resume(id,store.config(id).nodeConfigs?profiles.compile(config(data.backend),run.workflow):config(data.backend))))}
        if(action==='files'&&method==='GET'){const files=await listFiles(store,id,dirname(database));return json(res,{items:files.items,partial:files.partial,sourceStage:files.sourceStage})}
        if(action==='file-download'&&method==='GET'){const file=await downloadFileResult(store,id,dirname(database),url.searchParams.get('path'));res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.content.length,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name),'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(file.content);return}
        if(action==='file'&&method==='GET')return json(res,await readFileResult(store,id,dirname(database),url.searchParams.get('path')));
        if(action==='artifacts'&&method==='GET'){
          const archive=await archiveRun(store,id,dirname(database));res.writeHead(200,{'Content-Type':'application/gzip','Content-Length':archive.size,'Content-Disposition':`attachment; filename="openhands-${id}${archive.partial?'-partial':''}.tar.gz"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});createReadStream(archive.path).on('error',()=>res.destroy()).pipe(res);return;
        }
      }
      throw new ApiError('接口不存在。',404);
    }catch(error){if(res.headersSent){res.destroy();return}json(res,{error:error instanceof ApiError?error.message:'服务暂时不可用，请稍后重试。'},error instanceof ApiError?error.status:500)}
  });
  if(startEngine)engine.start();
  return {server,store,engine,storage,access,connectors,close:async()=>{engine.close();storage.close();await connectors.close();await new Promise(resolve=>server.close(resolve))}};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
  const env=process.env,defaults={mode:env.OPENHANDS_MODE||'remote',baseUrl:env.OPENHANDS_BASE_URL,apiKey:env.OPENHANDS_API_KEY,model:env.OPENHANDS_MODEL||'acp:codex',acpModel:env.OPENHANDS_ACP_MODEL||'gpt-5.6-sol',workspace:env.OPENHANDS_WORKSPACE||'/srv/openhands-workspaces',commands:{codex:env.OPENHANDS_CODEX_ACP_COMMAND,'claude-code':env.OPENHANDS_CLAUDE_ACP_COMMAND}};
  const app=createControl({database:env.CANVAS_DATABASE_PATH||'/srv/openhands/control/canvas.sqlite',apiKey:env.CANVAS_CONTROL_API_KEY,encryptionKey:env.CANVAS_CONTROL_ENCRYPTION_KEY,defaults,profiles:Profiles.fromFile(env.CANVAS_AI_PROFILES_PATH)});
  app.server.listen(Number(env.CANVAS_CONTROL_PORT)||18110,'127.0.0.1',()=>console.log('OpenHands workflow service listening on loopback.'));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{app.engine.close();app.storage.close();app.connectors.close();app.server.close();setTimeout(()=>process.exit(0),30000).unref();const timer=setInterval(()=>{if(!app.engine.active.size){clearInterval(timer);app.store.close();process.exit(0)}},100);timer.unref()});
}
