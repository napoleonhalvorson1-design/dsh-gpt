import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Profiles} from '../server/profiles.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {placePlanner,plannerReservations} from '../server/planner-placement.mjs';

const requests=[],errors=[],server=http.createServer(async(req,res)=>{try{
 assert(['fixture-key','rotated-key'].includes(req.headers['x-session-api-key']));
 const url=new URL(req.url,'http://fixture'),profile=url.pathname.split('/')[1];res.setHeader('Content-Type','application/json');
 if(req.method==='POST'){
  const body=JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString());requests.push({profile,body});res.end(JSON.stringify({id:body.conversation_id,execution_status:'running'}));return;
 }
 res.end(JSON.stringify(url.pathname.endsWith('/events/search')?{items:[],next_page_id:null}:{id:url.pathname.split('/').at(-1),execution_status:'paused',current_model_id:'gpt-6-astra'}));
}catch(error){errors.push(error.message);res.writeHead(500);res.end('{}')}});
server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
const example=JSON.parse(await readFile('config/ai-profiles.example.json','utf8'));
for(const p of example.items){p.config={...p.config,baseUrl:'https://'+p.id+'.example.com',apiKey:'fixture-key',workspace:'/workspace/'+p.id,commands:{codex:'/fixture/acp'}};p.runtimeContextVersion=1;p.eventStream=false;p.policyModels=p.config.model==='acp:codex'?['gpt-6-astra','gpt-6.1-sol','gpt-6-luna'].map(id=>({id,verified:true,efforts:['low','medium','high','xhigh']})):p.config.model==='acp:deepseek'?[{id:'["deepseek-official","deepseek-flash"]',verified:true,efforts:['max']}]:[{id:'opus',verified:true,efforts:['low','medium','high']}]}
const profiles=new Profiles(example.items,example.defaultId);for(const [id,p] of profiles.entries)p.config.baseUrl=origin+'/'+id;const seed=JSON.parse(await readFile('shared/five-ai-workflow.json','utf8')),directory=await mkdtemp(join(tmpdir(),'canvas-placement-'));let store=new Store(join(directory,'canvas.sqlite'),'fixture'),engine=new Engine(store,{handoffDirectory:directory,pollMs:10});engine.tick=()=>{};
const compile=(flow=seed)=>profiles.compile({},flow);
const enqueue=id=>{store.putProject(id,{...seed,title:id,task:'Implement files'},0);return engine.enqueue({id,projectId:id,workflow:{...seed,title:id,task:'Implement files'}},compile())};
const loadStore=(nodes,extra={})=>({db:{prepare:()=>({iterate:()=>[{payload:JSON.stringify({schedulerVersion:2,status:'running',...extra,nodes})}]})}});
const loaded=loadStore({a:{id:'a',profileId:'codex-silicon',status:'running'},b:{id:'b',profileId:'codex-silicon',status:'running'}});
try{
 const a=enqueue('one'),b=enqueue('two'),c=enqueue('three');assert.deepEqual([a,b,c].map(r=>r.nodes.plan.profileId),['codex-silicon','codex-seoul','codex-shanghai']);assert.equal(plannerReservations(store).get('codex-silicon'),1);
 engine.close();store.close();store=new Store(join(directory,'canvas.sqlite'),'fixture');engine=new Engine(store,{handoffDirectory:directory,pollMs:10});engine.tick=()=>{};
 for(const run of [a,b,c]){const n=run.nodes.plan;assert.equal(n.modelRequested,'gpt-6-astra');assert.equal(n.reasoningEffort,'medium');assert(n.workspace.startsWith('/workspace/'+n.profileId+'/'));assert.equal(store.config(run.id).nodeConfigs.plan.baseUrl,origin+'/'+n.profileId);engine.patchNode(run.id,{id:'plan',workspaceReady:true,inputReady:true,inputStored:true,mergeReport:{conflicts:[]}});await engine.executeNode(run.id,'plan')}
 assert.deepEqual(requests.map(r=>r.profile),['codex-silicon','codex-seoul','codex-shanghai']);for(const r of requests){assert(r.body.workspace.working_dir.startsWith('/workspace/'+r.profile+'/'));const args=r.body.agent_settings.acp_args;assert.equal(args[args.indexOf('--model')+1],'gpt-6-astra');assert.equal(args[args.indexOf('--effort')+1],'medium')}
 assert.equal(plannerReservations(store).size,0,'Paused branches do not reserve inference capacity');const again=engine.enqueue({id:'two'},compile());assert.equal(again.nodes.plan.profileId,'codex-seoul','Existing request identities are never reassigned');
 let saved=store.run('two');saved.status='awaiting_input';store.saveRun(saved);const frozen=store.config('two').nodeConfigs.plan.policyRuntimePath,current=compile();current.teamProfiles['codex-seoul'].apiKey='rotated-key';current.teamProfiles['codex-seoul'].policyRuntimePath='/workspace/codex-seoul/.canvas-runtime/new.py';
 await engine.resume('two',current);assert.equal(store.config('two').nodeConfigs.plan.profileId,'codex-seoul');assert.equal(store.config('two').nodeConfigs.plan.apiKey,'rotated-key');assert.equal(store.config('two').nodeConfigs.plan.policyRuntimePath,frozen,'Resume keeps the original strategy script while using current credentials for the same route');
 saved=store.run('two');saved.status='awaiting_input';store.saveRun(saved);const wrong=compile();wrong.teamProfiles['codex-seoul'].baseUrl=origin+'/other';await assert.rejects(()=>engine.resume('two',wrong),/原来的后端/);
 const original=compile(),p=placePlanner(loaded,seed,original);assert.equal(p.nodeConfigs.plan.profileId,'codex-seoul');assert.equal(p.nodeConfigs.plan.selection.effort,original.nodeConfigs.plan.selection.effort);assert.equal(original.nodeConfigs.plan.profileId,'codex-silicon','Placement does not mutate caller configurations');
 assert.equal(placePlanner(loaded,{...seed,plannerPolicy:'manual'},original),original);assert.equal(placePlanner(loaded,{...seed,modelMode:'manual'},original),original);
 const missingCommand=compile();missingCommand.teamProfiles['codex-seoul'].commands={};assert.equal(placePlanner(loaded,seed,missingCommand).nodeConfigs.plan.profileId,'codex-shanghai','Incomplete launch configuration is not a usable peer');
 const unavailable=compile();unavailable.teamProfiles['codex-seoul'].policyModels=unavailable.teamProfiles['codex-seoul'].policyModels.map(m=>({...m,verified:false}));assert.equal(placePlanner(loaded,seed,unavailable).nodeConfigs.plan.profileId,'codex-shanghai');
 for(const id of ['codex-seoul','codex-shanghai'])unavailable.teamProfiles[id].policyModels=unavailable.teamProfiles[id].policyModels.map(m=>({...m,verified:true,efforts:['low']}));assert.equal(placePlanner(loaded,seed,unavailable).nodeConfigs.plan.profileId,'codex-silicon','No depth downgrade when a peer cannot honor the selected depth');
 const focusedFlow={...seed,runtimeContext:'focused'},focused=compile(focusedFlow);focused.teamProfiles['codex-seoul'].runtimeContextVersion=0;assert.equal(placePlanner(loaded,focusedFlow,focused).nodeConfigs.plan.profileId,'codex-shanghai');assert.equal(placePlanner(loaded,focusedFlow,focused).nodeConfigs.plan.runtimeContext,'focused');
 const policyFlow={...seed,nodes:seed.nodes.map(n=>n.id==='plan'?{...n,executionPolicy:{budgetSeconds:60,fallbackProfile:'codex-seoul'}}:n)},policy=placePlanner(loaded,policyFlow,compile(policyFlow));assert.equal(policy.nodeConfigs.plan.profileId,'codex-shanghai');assert.equal(policy.nodeConfigs.plan.fallbackConfig.profileId,'codex-seoul','A primary cannot move onto an identical reserved fallback');
 const fastFlow={...seed,modelMode:'fast'},fast=placePlanner(loaded,fastFlow,compile(fastFlow));assert.equal(fast.nodeConfigs.plan.selection.model,'gpt-6-astra');assert.equal(fast.nodeConfigs.plan.selection.effort,'low');
 const accounting=loadStore({done:{profileId:'codex-silicon',status:'succeeded',modelCompleted:true,outputReady:false},blocked:{profileId:'codex-seoul',status:'pending',dependencies:['parent']},parent:{profileId:'codex-shanghai',status:'pending',dependencies:[],outputReady:false}});assert.deepEqual([...plannerReservations(accounting)],[['codex-shanghai',1]],'Completed models and dependency-blocked stages are excluded');
 const stopping=loadStore({inflight:{profileId:'codex-silicon',status:'reconnecting'},queued:{profileId:'codex-seoul',status:'pending',dependencies:[]},confirmed:{profileId:'codex-shanghai',status:'running',stopConfirmed:true}},{cancelRequested:true});assert.deepEqual([...plannerReservations(stopping)],[['codex-silicon',1]]);
 const legacy=loadStore({now:{profileId:'codex-silicon',status:'pending'},later:{profileId:'codex-seoul',status:'pending'}},{schedulerVersion:1,order:['now','later'],index:0});assert.deepEqual([...plannerReservations(legacy)],[['codex-silicon',1]]);
 for(let i=0;i<3;i++)store.createRun({id:'history-'+i,projectId:'one',title:'History',status:'succeeded',adaptivePlan:{plannerId:'plan',directDelivery:false},nodes:{plan:{id:'plan',profileId:'codex-silicon',modelRequested:'gpt-6-astra',reasoningEffort:'medium',modelSelection:{complexity:'standard'},conversationId:'history-'+i,status:'succeeded',outputReady:true,selectionApplied:true,submittedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:03:20Z'}}},{});
 store.createRun({id:'occupied',projectId:'one',title:'Busy',status:'running',nodes:{plan:{id:'plan',profileId:'codex-silicon',status:'running'}}},{});const moved=enqueue('budget-preserved');assert.equal(moved.nodes.plan.profileId,'codex-seoul');assert.equal(store.config(moved.id).nodeConfigs.plan.executionPolicy.budgetSeconds,600,'Placement must not shrink a learned planning budget');
 assert.deepEqual(errors,[]);console.log('Passed durable least-reserved strongest-planner routing, exact model/depth/context preservation, manual and fallback constraints, actual native HTTP routing after database restart and frozen-route resume.');
}finally{engine.close();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true})}
