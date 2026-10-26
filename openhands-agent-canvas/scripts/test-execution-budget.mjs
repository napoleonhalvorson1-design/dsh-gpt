import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Store} from '../server/store.mjs';
import {Storage} from '../server/storage.mjs';
import {Engine,validateWorkflow} from '../server/engine.mjs';
import {compileExecutionPolicy,validateExecutionPolicy,defaultPlannerPolicy} from '../server/execution-policy.mjs';
import {chooseModel,DEEPSEEK_LOCK} from '../shared/model-policy.mjs';

// Real native HTTP/files, signed S3 fixture, and persistent SQLite. No AI calls.
const root=await mkdtemp(join(tmpdir(),'canvas-budget-')),exec=promisify(execFile),conversations=new Map(),objects=new Map(),requests=[],errors=[];
let scenario={},engine,storage,store,currentId,base;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const server=http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://fixture'),raw=Buffer.concat(await Array.fromAsync(req)),json=(v,s=200)=>{res.writeHead(s,{'Content-Type':'application/json'});res.end(JSON.stringify(v))};
 if(url.pathname.startsWith('/bucket/')){
  assert.match(req.headers.authorization||'',/AWS4-HMAC-SHA256/);const key=decodeURIComponent(url.pathname.slice(8));requests.push({method:req.method,key});
  if(req.method==='PUT'){
   const deny=scenario.denyInput&&key.includes('/inputs/')&&key.endsWith('workspace.tar.gz')||scenario.denyOutput&&key.includes('/stages/')&&key.endsWith('workspace.tar.gz');
   if(deny){res.writeHead(403,{'Content-Type':'application/xml'});res.end('<Error><Code>AccessDenied</Code></Error>');return}
   objects.set(key,raw);res.writeHead(200,{ETag:'"fixture"'});res.end();return;
  }
  if(req.method==='GET'){const data=objects.get(key);if(!data){json({},404);return}res.end(data);return}throw Error('Unexpected bucket method');
 }
 assert.equal(req.headers['x-session-api-key'],'fixture-key');const [,region,...parts]=url.pathname.split('/'),path='/'+parts.join('/'),workspace=url.searchParams.get('path');
 if(workspace)assert(workspace.startsWith(root+'/native/'));
 if(path==='/api/file/create_directory'){await mkdir(workspace,{recursive:true});json({});return}
 if(path==='/api/file/upload'){const form=await new Response(raw,{headers:{'Content-Type':req.headers['content-type']}}).formData();await mkdir(dirname(workspace),{recursive:true});await writeFile(workspace,Buffer.from(await form.get('file').arrayBuffer()));json({});return}
 if(path==='/api/file/download'){try{res.end(await readFile(workspace))}catch{json({},404)}return}
 if(path==='/api/file/archive'){
  const archive=join(root,'export-'+Math.random()+'.tar.gz');await exec('tar',['-czf',archive,'-C',dirname(workspace),basename(workspace)]);res.end(await readFile(archive));await rm(archive);return;
 }
 if(path==='/api/conversations'&&req.method==='POST'){
  const input=JSON.parse(raw),args=input.agent_settings.acp_args,model=args[args.indexOf('--model')+1],effort=args[args.indexOf('--effort')+1],dir=input.workspace.working_dir;
  assert(dir.startsWith(root+'/native/'));if(region==='fallback')assert(!await readFile(join(dir,'primary-partial.txt')).catch(()=>null),'Fallback starts from immutable upstream input');
  await mkdir(join(dir,'.canvas-collaboration'),{recursive:true});await writeFile(join(dir,'.canvas-collaboration/runtime-selection.json'),JSON.stringify({requestId:input.conversation_id,model,effort,modelApplied:true,effortApplied:true}));
  const c={id:input.conversation_id,region,dir,interrupts:0,status:region==='fallback'&&!scenario.slowFallback||region==='primary'&&scenario.finishNormally?'finished':'running'};conversations.set(c.id,c);
  await writeFile(join(dir,region==='primary'?'primary-partial.txt':'delivered.txt'),'actual '+region+' files');json({id:c.id,execution_status:'running'},201);return;
 }
 const match=path.match(/^\/api\/conversations\/([^/]+)(.*)$/),c=match&&conversations.get(match[1]);if(!c){json({},404);return}
 if(match[2]==='/events/search'){json({items:c.status==='finished'?[{id:c.id+'-finish',kind:'ActionEvent',action:{kind:'FinishAction',message:'Delivered files'}}]:[],next_page_id:null});return}
 if(['/interrupt','/pause'].includes(match[2])){c.interrupts++;if(scenario.allowStop!==false)c.status=scenario.finishDuringStop&&c.region==='primary'?'finished':'paused';json({});return}
 if(match[2]==='/run'){c.status='finished';json({});return}
 if(!match[2]){json({id:c.id,execution_status:c.status,current_model_id:'strong'});return}
 throw Error('Unexpected native route '+path);
}catch(error){errors.push(error.message);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}});
server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
const models=[{id:'strong',verified:true,efforts:['low','medium','high','xhigh']}],team=Object.fromEntries(['primary','fallback'].map(id=>[id,{mode:'remote',baseUrl:base+'/'+id,apiKey:'fixture-key',workspace:join(root,'native',id),model:'acp:codex',acpModel:'strong',profileId:id,profileLabel:id,commands:{codex:'/fixture/acp'},policyRuntimePath:'/fixture/old-policy.py',policyModels:models}]));
const flow=policy=>({title:'Execution budget',task:'Implement actual files',executionMode:'parallel',modelMode:'auto',nodes:[{id:'start',name:'start',type:'start',x:0,y:0},{id:'build',name:'build',type:'code',x:1,y:0,executionProfile:'primary',prompt:'Implement files',tools:['终端'],executionPolicy:policy},{id:'end',name:'end',type:'end',x:2,y:0}],edges:[['start','build'],['build','end']]});
function compile(workflow){const node=workflow.nodes[1],c={...team[node.executionProfile]};c.selection=chooseModel(c,node,workflow,c.policyModels);return {...c,nodeConfigs:{build:compileExecutionPolicy(c,node,workflow,team)}}}
function open(){
 store=new Store(join(root,'db.sqlite'),'fixture');storage=new Storage(store,{directory:root,intervalMs:9999999,environment:{CANVAS_S3_ENDPOINT:base,CANVAS_S3_BUCKET:'bucket',CANVAS_S3_REGION:'us-west',CANVAS_S3_FORCE_PATH_STYLE:'true',CANVAS_S3_ACCESS_KEY_ID:'fake',CANVAS_S3_SECRET_ACCESS_KEY:'fake'}});
 if(!store.setting('s3'))storage.save({enabled:true,bucket:'bucket',endpoint:base,region:'us-west',prefix:'canvas/',forcePathStyle:true});
 engine=new Engine(store,{pollMs:10,handoffDirectory:root,clock:()=>Date.now()+(store.run(currentId)?.nodes.build.fallbackCount&&!scenario.expireFallback?0:31000)});engine.storage=storage;
}
async function close(){engine?.close();while(engine?.active.size)await sleep(5);storage?.close();store?.close()}
async function wait(predicate){const deadline=Date.now()+15000;for(;;){if(errors.length)throw Error(errors[0]);const r=store.run(currentId);if(predicate(r))return r;if(Date.now()>deadline)throw Error('Timed out '+JSON.stringify(r));await sleep(5)}}
async function start(id,options={},policy={budgetSeconds:30,fallbackProfile:'fallback'}){scenario=options;currentId=id;const workflow=flow(policy);store.putProject(id,workflow,0);const config=compile(workflow);engine.enqueue({id,projectId:id,workflow},config);return config}
try{
 for(const bad of [null,{},false,{budgetSeconds:29},{budgetSeconds:7201},{budgetSeconds:30,apiKey:'bad'},{budgetSeconds:30,fallbackProfile:false},{budgetSeconds:30,fallbackModelPolicy:{model:'strong'}}])assert.throws(()=>validateExecutionPolicy(bad));
 assert.throws(()=>validateWorkflow(flow({budgetSeconds:30,fallbackProfile:'missing',extra:'bad'})));
 const ds={...team.primary,model:'acp:deepseek',policyModels:[{id:DEEPSEEK_LOCK.nativeModel,verified:true,efforts:['max']}]},pinned=compileExecutionPolicy({...team.primary,selection:chooseModel(team.primary,{}, {modelMode:'auto'},models)},{executionPolicy:{budgetSeconds:30,fallbackProfile:'ds',fallbackModelPolicy:{effort:'low'}}},{modelMode:'auto'},{ds});assert.equal(pinned.fallbackConfig.selection.effort,'max');
 assert.throws(()=>compileExecutionPolicy({...team.primary,selection:chooseModel(team.primary,{}, {modelMode:'auto'},models)},{liveModel:'strong',executionPolicy:{budgetSeconds:30,fallbackProfile:'ds'}},{modelMode:'auto'},{ds}),/手动指定/);
 const plannerModels=['gpt-6-astra','gpt-6-luna'].map(id=>({id,verified:true,efforts:['low','medium','high','xhigh']})),leader={...team.primary,profileId:'codex-silicon',policyModels:plannerModels,selection:{model:'gpt-6-astra',effort:'medium',complexity:'standard',planner:true,verified:true}},peer={...team.fallback,profileId:'codex-seoul',policyModels:plannerModels},plannerFlow={collaborationMode:'adaptive',plannerPolicy:'strongest',modelMode:'auto',nodes:[{id:'plan'}]},plannerBundle={nodeConfigs:{plan:leader},teamProfiles:{'codex-silicon':leader,'codex-seoul':peer}};
 const defaults=defaultPlannerPolicy(plannerFlow,plannerBundle);assert.equal(defaults.budgetSeconds,300);assert.equal(defaults.fallbackProfile,'codex-seoul');
 const fast=compileExecutionPolicy({...leader},{id:'plan',executionPolicy:defaults},{...plannerFlow,modelMode:'fast'},plannerBundle.teamProfiles);assert.equal(fast.fallbackConfig.selection.model,'gpt-6-astra');assert.equal(fast.fallbackConfig.selection.effort,'medium','Fallback retains verified planning capability even in fast mode');
 assert.equal(defaultPlannerPolicy({...plannerFlow,nodes:[{id:'plan',executionPolicy:{budgetSeconds:7200}}]},plannerBundle),null,'Explicit policy wins');
 assert.equal(defaultPlannerPolicy({...plannerFlow,plannerPolicy:'manual'},plannerBundle),null);
 assert.deepEqual(defaultPlannerPolicy(plannerFlow,{...plannerBundle,teamProfiles:{'codex-silicon':leader}}),{budgetSeconds:300},'No weaker fallback when same-capability peer is absent');
 const observation={profileId:'codex-silicon',model:'gpt-6-astra',effort:'medium',complexity:'standard',role:'planning',samples:3,observedStageMsMedian:200000};assert.equal(defaultPlannerPolicy(plannerFlow,plannerBundle,[observation]).budgetSeconds,600);assert.equal(defaultPlannerPolicy(plannerFlow,plannerBundle,[{...observation,observedStageMsMedian:999999}]).budgetSeconds,900);assert.equal(defaultPlannerPolicy(plannerFlow,plannerBundle,[{...observation,samples:2}]).budgetSeconds,300);assert.equal(defaultPlannerPolicy(plannerFlow,plannerBundle,[{...observation,role:'direct-implementation'}]).budgetSeconds,300);
 open();await start('normal');let r=await wait(r=>r.status==='succeeded');assert.equal(r.nodes.build.fallbackCount,1);assert.equal(r.nodes.build.attempts[0].stopConfirmed,true);assert.equal(conversations.size,2);assert.notEqual(r.nodes.build.conversationId,r.nodes.build.attempts[0].conversationId);assert(objects.has('canvas/runs/normal/inputs/build/workspace.tar.gz'));assert(objects.has('canvas/runs/normal/inputs/build/attempt-2/workspace.tar.gz'));assert(await readFile(join(r.nodes.build.attempts[0].workspace,'primary-partial.txt')));await wait(()=>!engine.active.size);
 await start('unconfirmed',{allowStop:false});await wait(r=>r.nodes.build.budgetRecovery?.state==='stopping');const before=conversations.size;await sleep(100);assert.equal(conversations.size,before);await close();open();engine.start();await sleep(60);assert.equal(conversations.size,before,'Restart cannot start fallback without stop confirmation');scenario.allowStop=true;r=await wait(r=>r.status==='succeeded');assert.equal(r.nodes.build.fallbackCount,1);assert.equal(conversations.size,before+1);await wait(()=>!engine.active.size);
 const originalLog=engine.log.bind(engine);let switched;engine.log=(...args)=>{originalLog(...args);if(args[2].startsWith('原会话已确认停止，使用相同')){switched=store.run(currentId).nodes.build.conversationId;engine.close()}};
 const preSwitchCount=conversations.size;await start('atomic-switch');await wait(()=>engine.closed);await close();assert(switched);assert.equal(conversations.size,preSwitchCount+1,'Crash after atomic switch precedes fallback submission');open();engine.start();r=await wait(r=>r.status==='succeeded');assert.equal(r.nodes.build.conversationId,switched);assert.equal(conversations.size,preSwitchCount+2,'Restart submits exactly the reserved fallback identity');await wait(()=>!engine.active.size);
 await start('late-result',{finishDuringStop:true});r=await wait(r=>r.status==='succeeded');assert(!r.nodes.build.fallbackCount);assert.equal(r.nodes.build.budgetRecovery.state,'completed-before-switch');await wait(()=>!engine.active.size);
 await start('cancel-pending',{allowStop:false});await wait(r=>r.nodes.build.budgetRecovery?.state==='stopping');const count=conversations.size;engine.stop(currentId);scenario.allowStop=true;r=await wait(r=>r.status==='cancelled');assert.equal(conversations.size,count);await wait(()=>!engine.active.size);
 await start('bounded',{slowFallback:true,expireFallback:true});r=await wait(r=>r.status==='failed');assert.equal(r.nodes.build.fallbackCount,1);assert.equal(r.nodes.build.budgetRecovery.state,'exhausted');assert(r.nodes.build.stopConfirmed);await wait(()=>!engine.active.size);const frozen=store.config(currentId).nodeConfigs.build.policyRuntimePath,again=compile(r.workflow);again.nodeConfigs.build.policyRuntimePath='/fixture/new-policy.py';await engine.resume(currentId,again);r=await wait(r=>r.status==='succeeded');assert.equal(store.config(currentId).nodeConfigs.build.policyRuntimePath,frozen);await wait(()=>!engine.active.size);
 await start('input-barrier',{denyInput:true});r=await wait(r=>r.status==='failed');assert.equal(r.nodes.build.budgetRecovery.state,'storage-blocked');const n=conversations.size;scenario.denyInput=false;await engine.resume(currentId,compile(r.workflow));r=await wait(r=>r.status==='succeeded');assert.equal(conversations.size,n+1,'Storage recovery starts only the planned fallback');await wait(()=>!engine.active.size);
 await start('output-barrier',{denyOutput:true});r=await wait(r=>r.status==='failed');assert(r.nodes.build.modelCompleted);const completed=conversations.size;scenario.denyOutput=false;await engine.resume(currentId,compile(r.workflow));await wait(r=>r.status==='succeeded');assert.equal(conversations.size,completed,'Completed fallback is not re-inferred for output upload');await wait(()=>!engine.active.size);
 await start('already-finished',{finishNormally:true});r=await wait(r=>r.status==='succeeded');assert(!r.nodes.build.budgetRecovery);await wait(()=>!engine.active.size);
 console.log('Passed execution budgets: confirmed single fallback, isolated inputs, restart, late completion, user cancellation, exhaustion/resume and input/output storage barriers.');
}finally{await close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true})}
