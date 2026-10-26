import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createControl} from '../server/http.mjs';
const root=await mkdtemp(join(tmpdir(),'openhands-control-'));
const originalFetch=globalThis.fetch,conversations=new Map();let creates=0,hold=false,failDownstream=false,checks=0,reboundOnce=false,interrupts=0;
const ok=(value,message)=>{assert.ok(value,message);checks++};
const cfg={mode:'remote',baseUrl:'https://agent.example.com',apiKey:'private-backend-test-key',model:'acp:codex',acpModel:'gpt-5.6-sol',workspace:'/workspace'};
globalThis.fetch=async(url,options={})=>{
 if(!String(url).startsWith(cfg.baseUrl))return originalFetch(url,options);
 const path=new URL(url).pathname,respond=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(path==='/api/file/create_directory')return respond({success:true});
 if(path==='/api/conversations'&&options.method==='POST'){const b=JSON.parse(options.body);creates++;const second=b.agent_settings.agent_context.system_message_suffix==='downstream';conversations.set(b.conversation_id,{id:b.conversation_id,status:'running',polls:0,prompt:b.initial_message.content[0].text,second,fail:second&&failDownstream});return respond({id:b.conversation_id,execution_status:'running'},201)}
 const match=path.match(/^\/api\/conversations\/([^/]+)(?:\/(events\/search|pause|interrupt|run))?$/);if(match){const c=conversations.get(match[1]);if(!c)return respond({error:'not found'},404);
  if(['pause','interrupt'].includes(match[2])){interrupts++;c.status='paused';if(reboundOnce){reboundOnce=false;c.rebound=true}return respond({success:true})}
  if(match[2]==='run'){c.status='running';return respond({success:true})}
  if(match[2]==='events/search')return respond({items:c.status==='finished'?[{id:c.id+'-output',timestamp:'2026-10-26T00:00:01Z',kind:'ActionEvent',source:'agent',action:{kind:'FinishAction',message:c.fail?'Warning\n'+JSON.stringify({type:'error',status:400,error:{code:'model_not_found',message:'bad model'}}):c.second?'下游已收到交接，完成任务':'上游研究结果'}}]:[],next_page_id:null});
  if(c.rebound){c.rebound=false;const result=respond({id:c.id,execution_status:'paused'});c.status='running';return result}if(!hold&&c.status==='running'&&++c.polls>1)c.status='finished';return respond({id:c.id,execution_status:c.status})
 }
 return respond({error:'unknown'},404);
};
const options={database:join(root,'db.sqlite'),apiKey:'control-test-key',encryptionKey:'control-test-encryption-key',pollMs:10,defaults:cfg};let app=createControl(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');let base='http://127.0.0.1:'+app.server.address().port;
async function request(path,method='GET',body,auth=true){const r=await originalFetch(base+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer control-test-key'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()}}
async function waitRun(id,status){for(let i=0;i<300;i++){const r=(await request('/runs/'+id)).data;if(r.status===status)return r;if(['failed','cancelled','succeeded'].includes(r.status)&&r.status!==status)throw Error(JSON.stringify(r));await new Promise(r=>setTimeout(r,10))}throw Error('Timed out '+status)}
async function idle(){app.engine.close();while(app.engine.active.size)await new Promise(r=>setTimeout(r,10));await app.close();app.store.close()}
const flow={title:'Test project',task:'Create a result',nodes:[{id:'start',type:'start',name:'Start',x:0,y:0},{id:'one',type:'research',name:'Research',prompt:'upstream',x:200,y:0},{id:'two',type:'code',name:'Code',prompt:'downstream',x:400,y:0}],edges:[['start','one'],['one','two']]};
try{
 ok((await request('/projects','GET',null,false)).status===401,'Control authorization required');
 let p=await request('/projects/p1','PUT',{state:flow,expectedRevision:0});ok(p.status===200&&p.data.revision===1,'Project persists');
 ok((await request('/projects/p1','PUT',{state:{...flow,title:'Renamed'},expectedRevision:1})).data.revision===2,'Project revisions advance');ok((await request('/projects/p1','PUT',{state:flow,expectedRevision:1})).status===409,'Stale device updates rejected');
 const invalid=await request('/runs','POST',{id:'bad',projectId:'p1',backend:cfg,workflow:{...flow,edges:[['one','two'],['two','one']]}});ok(invalid.status===400,'Cyclic workflow rejected');
 await request('/runs','POST',{id:'run1',projectId:'p1',backend:cfg,workflow:flow});const run=await waitRun('run1','succeeded');ok(creates===2,'One actual conversation per node');ok(run.nodes.two.output.includes('下游'),'Downstream output persisted');ok([...conversations.values()].find(c=>c.second).prompt.includes('上游研究结果'),'Upstream output passed to downstream');
 const again=await request('/runs','POST',{id:'run1',projectId:'p1',backend:cfg,workflow:flow});ok(again.status===202&&creates===2,'Duplicate submission idempotent');ok(!JSON.stringify(run).includes(cfg.apiKey),'Run responses exclude credentials');
 const metrics=await request('/runs/run1/performance');ok(metrics.status===200&&metrics.data.performance.schemaVersion===1&&metrics.data.performance.elapsedMs>=0,'Performance endpoint reports actual persisted run times');ok(metrics.data.performance.modelWallMs===null,'Legacy runs without submission clocks keep unknown model time');ok(!JSON.stringify(metrics.data).includes('上游研究结果')&&!JSON.stringify(metrics.data).includes(cfg.apiKey)&&!metrics.data.workflow,'Performance view excludes outputs, prompts and credentials');ok((await request('/runs/run1/performance','GET',null,false)).status===401,'Performance requires authentication');ok((await request('/runs/absent/performance')).status===404,'Unknown run timing returns 404');
 const dbRows=app.store.db.prepare('SELECT config FROM runs').all();ok(!JSON.stringify(dbRows).includes(cfg.apiKey),'Run credentials encrypted at rest');
 const events=(await request('/runs/run1/events?after=0')).data;ok(events.items.some(e=>e.text==='上游研究结果'),'Events persisted');ok(events.nextCursor>0,'Incremental event cursor');ok((await request('/runs/run1?version='+run.revision)).data.unchanged,'Unchanged polling is compact');
 hold=true;await request('/runs','POST',{id:'restart',projectId:'p1',backend:cfg,workflow:flow});for(let i=0;i<100&&!app.store.run('restart').nodes.one.handle;i++)await new Promise(r=>setTimeout(r,10));const before=creates;await idle();
 app=createControl(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');base='http://127.0.0.1:'+app.server.address().port;hold=false;await waitRun('restart','succeeded');ok(creates===before+1,'Restart resumes existing node without duplicate inference');
 hold=true;await request('/runs','POST',{id:'cancel',projectId:'p1',backend:cfg,workflow:flow});for(let i=0;i<100&&!app.store.run('cancel').nodes.one.handle;i++)await new Promise(r=>setTimeout(r,10));
 ok((await request('/projects/p1','DELETE')).status===409,'Active project cannot be deleted');reboundOnce=true;const interruptCount=interrupts;await request('/runs/cancel/stop','POST',{});const stopped=await waitRun('cancel','cancelled');ok(stopped.nodes.one.status==='paused','Stop confirmed by real backend state');ok(interrupts>interruptCount+1,'Startup state rebound cannot falsely confirm stop; immediate interrupt retried');ok(stopped.nodes.two.status==='pending','Stop does not start downstream tasks');hold=false;
 failDownstream=true;await request('/runs','POST',{id:'provider-error',projectId:'p1',backend:cfg,workflow:flow});const failed=await waitRun('provider-error','failed');ok(failed.nodes.one.status==='succeeded'&&failed.nodes.two.status==='failed','Typed provider failure cannot count as success');const count=creates;failDownstream=false;await request('/runs/provider-error/resume','POST',{backend:cfg});await waitRun('provider-error','succeeded');ok(creates===count+1,'Retry only repeats failed node');
 const list=(await request('/runs?projectId=p1')).data;ok(list.items.length===4,'Run history survives restart');ok((await request('/projects/p1')).data.title==='Renamed','Project survives restart');
 console.log(`Passed ${checks} persistent project, background execution, handoff, idempotency, restart recovery, stop, provider error and retry checks.`);
}finally{await idle();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true})}
