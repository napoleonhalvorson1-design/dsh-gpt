import assert from 'node:assert/strict';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
const store=new Store(':memory:','fixture-only'),engine=new Engine(store),launched=[];
const record=(id,dag,status='queued',nodes={})=>{store.createRun({id,projectId:'p',title:id,status,...(dag?{schedulerVersion:2}:{}),nodes},{});return id};
try{
 for(let i=0;i<30;i++)record('legacy-'+i,false);
 for(let i=0;i<30;i++)record('dag-'+i,true);
 const stopped=record('late-stop',true,'stopping');
 const recovery=record('late-recovery',true,'reconnecting',{a:{id:'a',status:'reconnecting',submittedAt:'2026-01-01T00:00:00Z',handle:{conversationId:'existing'}}});
 const candidates=store.runnable();
 assert.equal(candidates.length,42);assert(candidates.includes(stopped)&&candidates.includes(recovery));
 assert.equal(candidates.filter(id=>id.startsWith('legacy-')).length,20);assert.equal(candidates.filter(id=>id.startsWith('dag-')).length,20);
 // No network, inference or controller timer. Keep admitted workers pending.
 const pending=[];engine.execute=async id=>{launched.push(id);await new Promise(resolve=>pending.push(resolve))};
 engine.tick();
 assert.equal(launched[0],recovery);assert(launched.includes(stopped));
 assert.equal(launched.filter(id=>store.run(id).schedulerVersion===2).length,10);
 assert.equal(launched.filter(id=>store.run(id).schedulerVersion!==2).length,3);
 assert(engine.nodeActive.has(recovery+'/a'));
 engine.tick();assert.equal(launched.length,13,'An admission tick cannot duplicate workers');
 engine.close();for(const resolve of pending)resolve();
 await Promise.resolve();await Promise.resolve();
 console.log('Passed separate bounded DAG/legacy admission, backlog visibility, late-stop/restart recovery reservations and duplicate-tick checks.');
}finally{engine.close();store.close()}
