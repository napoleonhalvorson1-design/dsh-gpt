import assert from 'node:assert/strict';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {freezeSchedule,stageOrder} from '../server/critical-path.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
const stage=(id,dependsOn=[],extra={})=>({id,name:id,phase:'build',dependsOn,...extra});
const stages=[stage('a'),stage('b'),stage('c'),stage('d'),stage('root'),stage('middle',['root']),stage('tip',['middle'])];
const configs=Object.fromEntries(stages.map(s=>[s.id,{profileId:'codex',selection:{verified:true,model:'same-model',effort:'high',complexity:'standard'}}]));
const observation={profileId:'codex',model:'same-model',effort:'high',role:'build',complexity:'standard',samples:3,observedStageMsMedian:12000};
const runOf=(s=stages,schedule=freezeSchedule(s,configs))=>({id:'r',order:s.map(n=>n.id),schedulingVersion:1,scheduling:schedule,nodes:Object.fromEntries(s.map(n=>[n.id,{id:n.id,dependencies:n.dependsOn,status:'pending',outputReady:false}]))});
const input=JSON.stringify({stages,configs});
const plain=runOf();assert.equal(stageOrder(plain)[0],'root');assert.equal(stageOrder(plain)[1],'middle');
assert.deepEqual(stageOrder({...plain,schedulingVersion:undefined}),plain.order);
assert.deepEqual(stageOrder({...plain,scheduling:undefined}),plain.order);
assert.equal(plain.scheduling.estimates.a.durationMs,null);assert.equal(plain.scheduling.estimates.a.source,'unknown');
const measured=freezeSchedule(stages,configs,[observation]);assert.equal(measured.estimates.a.durationMs,12000);assert.equal(measured.estimates.a.samples,3);
for(const patch of [{samples:2},{samples:0},{observedStageMsMedian:0},{observedStageMsMedian:NaN},{observedStageMsMedian:Infinity},{observedStageMsMedian:7200001},{model:'different'},{effort:'low'},{role:'planning'},{complexity:'complex'},{profileId:'other'}])assert.equal(freezeSchedule(stages,configs,[{...observation,...patch}]).estimates.a.source,'unknown');
assert.equal(freezeSchedule(stages,{...configs,a:{...configs.a,selection:{...configs.a.selection,verified:false}}},[observation]).estimates.a.source,'unknown');
const ai=freezeSchedule([stage('a',[],{estimatedSeconds:2}),stage('b',[],{estimatedSeconds:7200})],configs,[observation]);
assert.equal(ai.estimates.a.durationMs,2000);assert.equal(ai.estimates.a.source,'planner');assert.equal(stageOrder(runOf([stage('a'),stage('b')],ai))[0],'b');
const completed=runOf();completed.nodes.middle.modelCompleted=true;completed.nodes.tip.outputReady=true;assert.equal(stageOrder(completed)[0],'a');
assert.equal(JSON.stringify({stages,configs}),input);
// Same deterministic workload and capacity. This measures ordering only, not AI speed.
function simulate(priority){
 const r=runOf(),active=[],pending=new Set(r.order);let now=0;const calls=[];
 while(pending.size||active.length){
  for(const id of priority?stageOrder(r):r.order){if(active.length>=2)break;if(!pending.has(id)||r.nodes[id].dependencies.some(p=>!r.nodes[p].outputReady))continue;pending.delete(id);active.push({id,end:now+100});calls.push(id)}
  assert(active.length);now=Math.min(...active.map(a=>a.end));
  for(let i=active.length-1;i>=0;i--)if(active[i].end===now){r.nodes[active[i].id].outputReady=true;active.splice(i,1)}
 }
 return {elapsedUnits:now,calls};
}
const baseline=simulate(false),current=simulate(true);assert.equal(baseline.elapsedUnits,500);assert.equal(current.elapsedUnits,400);assert.deepEqual([...baseline.calls].sort(),[...current.calls].sort());
// Exercise the real DAG scheduler with held promises: capacity, dependencies,
// storage barrier and old-run behavior, without native model calls.
async function integration(enabled){
 const store=new Store(':memory:','fixture'),engine=new Engine(store,{pollMs:20,maxNodeActive:2}),started=[],gates=new Map();
 const r={...runOf(),id:enabled?'prioritized':'old',projectId:'p',title:'fixture',status:'queued',schedulerVersion:2,maxParallelNodes:2,completedCount:0,activeNodeIds:[]};
 if(!enabled)delete r.schedulingVersion;
 store.createRun(r,{});
 engine.executeNode=async(id,nodeId)=>{started.push(nodeId);const gate=Promise.withResolvers();gates.set(nodeId,gate);await gate.promise;engine.patchNode(id,{id:nodeId,status:'succeeded',modelCompleted:true,outputReady:true});};
 engine.finalizeDag=async r=>engine.patch(r.id,x=>{x.status='succeeded';x.activeNodeIds=[]});
 const done=engine.executeDag(r.id);
 const waitFor=async predicate=>{for(let i=0;i<200&&!predicate();i++)await new Promise(resolve=>setTimeout(resolve,2));assert(predicate(),'scheduler progress timeout')};
 try{
  await waitFor(()=>started.length===2);assert.deepEqual(started,enabled?['root','a']:['a','b']);
  if(enabled){
   // Model completion alone cannot release a dependent stage through its bucket barrier.
   engine.patchNode(r.id,{id:'root',status:'succeeded',modelCompleted:true,outputReady:false});
   await new Promise(resolve=>setTimeout(resolve,30));assert(!started.includes('middle'));
   gates.get('a').resolve();await waitFor(()=>started.includes('b'));assert(!started.includes('middle'));
   gates.get('root').resolve();await waitFor(()=>started.includes('middle'));
  }
  for(let i=0;i<100&&store.run(r.id).status!=='succeeded';i++){for(const gate of gates.values())gate.resolve();await nextTurn();await new Promise(resolve=>setTimeout(resolve,2))}
  await done;assert.equal(store.run(r.id).status,'succeeded');assert.equal(new Set(started).size,stages.length);assert.equal(started.length,stages.length);
 }finally{engine.close();for(const gate of gates.values())gate.resolve();await done;store.close()}
}
await integration(true);await integration(false);
console.log(JSON.stringify({scope:'deterministic ordering fixture; no model or whole-task speed claim',baseline,current}));
