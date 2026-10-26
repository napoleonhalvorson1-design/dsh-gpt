import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {Engine as SerialEngine} from '../server/serial-engine.mjs';
const folder=await mkdtemp(join(tmpdir(),'canvas-event-checkpoint-')),secret='fixture-private-key',clock='2026-10-27T00:00:00.000Z';
let fixtureEvents=[],nextPage=null;const server=http.createServer((req,res)=>{assert.equal(req.headers['x-session-api-key'],secret);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({items:fixtureEvents,next_page_id:nextPage}))});server.listen(0,'127.0.0.1');await once(server,'listening');
const config={mode:'remote',baseUrl:'http://127.0.0.1:'+server.address().port,apiKey:secret};
const raw=(id,text)=>({id,timestamp:clock,kind:'ActionEvent',source:'agent',action:{kind:'FinishAction',message:text}});
const runInput=id=>({id,projectId:'p',title:id,status:'running',order:['a'],nodes:{a:{id:'a',name:'a',status:'running',handle:{conversationId:'native'},output:'',cursor:null,since:null,fatal:null},b:{id:'b',status:'pending',output:''}}});
async function pull(engine,run,node,dag){return dag?engine.pullDagEvents(run.id,node,config):engine.pullEvents(run,node,config)}
try{
 for(const [label,Class,dag] of [['dag',Engine,true],['serial',SerialEngine,false]]){
  const path=join(folder,label+'.sqlite');let store=new Store(path,'fixture-encryption');const engine=new Class(store);let run=store.createRun(runInput(label),config),node=run.nodes.a;
  fixtureEvents=[raw('one','First output '+secret),{id:'ignored',timestamp:clock,kind:'UnknownInternalKind'},raw('two','Second output')];nextPage='page-two';
  const before=JSON.stringify(node),revision=store.run(label).revision,save=store.saveRun.bind(store);store.saveRun=()=>{throw Error('Injected failure after inserting events')};
  await assert.rejects(()=>pull(engine,run,node,dag),/Injected/);store.saveRun=save;
  assert.equal(store.events(label).length,0);assert.equal(store.run(label).revision,revision);assert.equal(JSON.stringify(node),before);assert.equal(store.db.isTransaction,false);
  // Reopen the real file-backed WAL database; rolled-back events/cursors cannot
  // hide model output from the subsequent recovery fetch.
  store.close();store=new Store(path,'fixture-encryption');engine.store=store;run=store.run(label);node=run.nodes.a;
  assert.equal(store.events(label).length,0);assert.equal(node.output,'');assert.equal(await pull(engine,run,node,dag),true);
  const saved=store.run(label);assert.equal(saved.nodes.a.cursor,'page-two');assert(saved.nodes.a.output.includes('First output [已隐藏密钥]'));assert(!JSON.stringify(store.events(label)).includes(secret));assert.equal(saved.nodes.a.since,clock);assert.equal(store.events(label).length,2);
  // A COMMIT failure rolls back both events and the proposed in-memory cursor.
  fixtureEvents=[raw('three','Third output')];nextPage=null;const checkpoint=JSON.stringify(node),exec=store.db.exec.bind(store.db);store.db.exec=sql=>{if(sql==='COMMIT')throw Error('Injected commit failure');return exec(sql)};
  await assert.rejects(()=>pull(engine,run,node,dag),/commit failure/);store.db.exec=exec;assert.equal(store.events(label).length,2);assert.equal(JSON.stringify(node),checkpoint);assert.equal(store.run(label).nodes.a.cursor,'page-two');
  if(dag){const sibling=store.run(label);sibling.nodes.b.output='Concurrent sibling retained';sibling.cancelRequested=true;store.saveRun(sibling)}
  assert.equal(await pull(engine,run,node,dag),false);assert.equal(store.events(label).length,3);assert.equal(store.run(label).nodes.a.output,node.output);assert(node.output.includes('Third output'));
  if(dag){assert.equal(store.run(label).nodes.b.output,'Concurrent sibling retained');assert.equal(store.run(label).cancelRequested,true)}
  await pull(engine,run,node,dag);assert.equal(store.events(label).length,3);assert.equal(node.output.split('Third output').length,2);
  fixtureEvents=[raw('fatal','{"type":"error","status":400,"error":{"code":"model_not_found"}}')];await pull(engine,run,node,dag);assert(store.run(label).nodes.a.fatal);
  engine.close();store.close();
 }
 console.log('Passed atomic event/output/cursor checkpoints: file-backed WAL reopen, insert/commit failure rollback, pagination/replay, redaction/fatal events, latest sibling merge and preserved cancellation for DAG/serial engines.');
 // Kill a separate process at each side of the durable boundary. This checks
 // actual WAL crash recovery, beyond an exception followed by a clean rollback.
 for(const phase of ['after-event','after-commit']){
  const path=join(folder,'crash-'+phase+'.sqlite'),initial=new Store(path,'fixture-encryption');initial.createRun(runInput('crash'),config);initial.close();
  fixtureEvents=[raw('crash-output','Completed model output')];nextPage='recovery-page';
  const code=`import {Store} from ${JSON.stringify(pathToFileURL(resolve('server/store.mjs')).href)};
import {Engine} from ${JSON.stringify(pathToFileURL(resolve('server/engine.mjs')).href)};
const store=new Store(${JSON.stringify(path)},'fixture-encryption'),engine=new Engine(store),run=store.run('crash');
${phase==='after-event'?"const add=store.addEvent.bind(store);store.addEvent=(...args)=>{add(...args);process.exit(73)};":"const exec=store.db.exec.bind(store.db);store.db.exec=sql=>{const result=exec(sql);if(sql==='COMMIT')process.exit(74);return result};"}
await engine.pullDagEvents('crash',run.nodes.a,${JSON.stringify(config)});`;
  const child=spawn(process.execPath,['--input-type=module','-'],{stdio:['pipe','ignore','pipe']});let errors='';child.stderr.on('data',b=>{errors+=b});child.stdin.end(code);const [status]=await once(child,'exit');assert.equal(status,phase==='after-event'?73:74,errors);
  const store=new Store(path,'fixture-encryption'),run=store.run('crash');
  if(phase==='after-event'){assert.equal(store.events('crash').length,0);assert.equal(run.nodes.a.output,'');assert.equal(run.nodes.a.cursor,null);const engine=new Engine(store);await engine.pullDagEvents('crash',run.nodes.a,config);engine.close();}
  assert.equal(store.events('crash').length,1);assert.equal(store.run('crash').nodes.a.output,'Completed model output');assert.equal(store.run('crash').nodes.a.cursor,'recovery-page');store.close();
 }
 console.log('Passed real process-death recovery before and after COMMIT; completed model output is recovered with its events and cursor.');
 // Optional actual WAL FULL durability comparison, not model performance.
 if(process.env.CANVAS_EVENT_BASELINE){
  const beforeSource=await readFile(join(resolve(process.env.CANVAS_EVENT_BASELINE),'engine.mjs'),'utf8');const imports=beforeSource.replace(/from '(\.\.?\/[^']+)'/g,(_,p)=>"from '"+pathToFileURL(resolve('server',p)).href+"'");const {Engine:Before}=await import('data:text/javascript;base64,'+Buffer.from(imports).toString('base64'));
  fixtureEvents=Array.from({length:100},(_,i)=>raw('benchmark-'+i,'Useful output '+i));nextPage=null;const samples={};
  for(const [label,Class] of [['before',Before],['after',Engine]]){const store=new Store(join(folder,'benchmark-'+label+'.sqlite'),'fixture-encryption'),engine=new Class(store),run=store.createRun(runInput('benchmark-'+label),config);const started=performance.now();await engine.pullDagEvents(run.id,run.nodes.a,config);samples[label]={elapsedMs:Math.round((performance.now()-started)*100)/100,events:store.events(run.id).length,outputChars:store.run(run.id).nodes.a.output.length};assert.equal(samples[label].events,100);engine.close();store.close()}
  console.log(JSON.stringify({scope:'One actual native-event HTTP page of 100 outputs, real file-backed SQLite WAL synchronous=FULL; no models',samples,speedFactor:Math.round(samples.before.elapsedMs/samples.after.elapsedMs*100)/100,wholeRealTaskSpeedupProven:false}));
 }
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(folder,{recursive:true,force:true})}
