import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Store} from '../server/store.mjs';
import {Storage} from '../server/storage.mjs';
const directory=await mkdtemp(join(tmpdir(),'canvas-sync-')),objects=new Map(),starts=[],completed=[],activeKeys=new Set(),errors=[],completedAt=new Map();
const pause=ms=>new Promise(r=>setTimeout(r,ms));let active=0,peak=0,latency=10,deny=()=>false,hold=null,holdKey=null,onPut=null,extraLatency=()=>0;
const server=http.createServer(async(req,res)=>{let key;try{
 assert.match(req.headers.authorization||'',/^AWS4-HMAC-SHA256 /);assert.equal(req.method,'PUT');key=decodeURIComponent(new URL(req.url,'http://fixture').pathname.slice(1));assert(!activeKeys.has(key),'Same object cannot be written concurrently');activeKeys.add(key);starts.push(key);active++;peak=Math.max(peak,active);
 const bytes=Buffer.concat(await Array.fromAsync(req));await pause(latency+extraLatency(key));if(hold&&(!holdKey||holdKey(key)))await hold;
 if(deny(key)){res.writeHead(403,{'Content-Type':'application/xml'});res.end('<Error><Code>AccessDenied</Code></Error>');return}
 if(key.endsWith('/latest.json')&&key.includes('/projects/')){const value=JSON.parse(bytes),version=key.replace('latest.json','versions/'+value.revision+'.json');assert(objects.has(version),'Immutable version must precede latest pointer');assert.equal(JSON.parse(objects.get(version)).revision,value.revision)}
 if(key.endsWith('/events/index.json')){const value=JSON.parse(bytes),prefix=key.slice(0,key.indexOf('/runs/'))+'/';assert(objects.has(prefix+value.lastChunk),'Log chunk must precede its index')}
 if(onPut)await onPut(key,bytes);objects.set(key,bytes);completed.push(key);completedAt.set(key,performance.now());res.writeHead(200,{ETag:'"fixture"'});res.end();
}catch(error){errors.push(error.message);res.writeHead(500,{'Content-Type':'application/xml'});res.end('<Error><Code>InternalError</Code></Error>')}finally{if(key)activeKeys.delete(key);active--}});
server.listen(0,'127.0.0.1');await once(server,'listening');const endpoint='http://127.0.0.1:'+server.address().port,cases=[];
async function create(label,{Class=Storage,count=12,events=true,withActive=false,concurrency}={}){
 const dir=join(directory,label);await mkdir(dir);const store=new Store(join(dir,'canvas.sqlite'),'fixture'),storage=new Class(store,{directory:dir,intervalMs:99999999,environment:{},...(concurrency?{syncConcurrency:concurrency}:{})});cases.push({store,storage});
 storage.save({enabled:true,endpoint,bucket:'bucket',region:'us-west',prefix:label+'/',forcePathStyle:true,accessKeyId:'fake',secretAccessKey:'fake'});store.setSetting('last-backup',{at:new Date().toISOString()});
 for(let i=0;i<count;i++){const id='p'+i;store.putProject(id,{title:id,task:'Actual fixture configuration',nodes:[],edges:[]},0);const rid='r'+i;store.createRun({id:rid,projectId:id,title:rid,status:i===0&&withActive?'running':'cancelled',order:[],nodes:{},workflow:{title:id,task:'Fixture',nodes:[],edges:[]}},{});if(events)store.addEvent(rid,'fixture',{text:'Actual incremental log '+i})}
 return {store,storage};
}
async function wait(predicate){const end=Date.now()+10000;while(!predicate()){if(Date.now()>end)throw Error('Timed out');await pause(5)}}
try{
 const {store,storage}=await create('isolated');storage.connectors={sync:()=>storage.json('engine/latest.json',{revision:1},{kind:'engine-config',id:'engine'})};store.setSetting('last-backup',null);
 deny=key=>key==='bucket/isolated/projects/p0/versions/1.json'||key==='bucket/isolated/runs/r0/input.json';
 await assert.rejects(()=>storage.sync(),/同步未完成/);assert(storage.lastError);assert.equal(storage.lastSync,null);assert.equal(storage.lastSyncBatch.rejected,2);assert(storage.lastSyncBatch.finishedAt);assert.deepEqual(new Set(storage.lastSyncBatch.failures.map(f=>f.kind+':'+f.id)),new Set(['project:p0','run:r0']));
 for(let i=1;i<12;i++){assert(objects.has('bucket/isolated/projects/p'+i+'/latest.json'));assert(objects.has('bucket/isolated/runs/r'+i+'/state.json'))}assert(objects.has('bucket/isolated/engine/latest.json'));assert([...objects.keys()].some(k=>k.startsWith('bucket/isolated/backups/')),'Independent backup is still attempted');assert(peak>1&&peak<=16);
 deny=()=>false;const prior=starts.filter(k=>k==='bucket/isolated/projects/p1/versions/1.json').length;const status=await storage.sync();assert.equal(status.busy,false);assert.equal(storage.lastError,null);assert(storage.lastSync);assert.equal(starts.filter(k=>k==='bucket/isolated/projects/p1/versions/1.json').length,prior,'Successful independent roots are not uploaded again');
 // Hold one project indefinitely: unrelated run/config/backup roots must finish
 // and report actual progress before that project's storage request is released.
 const mixed=await create('mixed',{count:8,withActive:true,events:false});mixed.storage.connectors={sync:()=>mixed.storage.json('engine/latest.json',{revision:1},{kind:'engine-config',id:'engine'})};mixed.store.setSetting('last-backup',null);
 let releaseProject;hold=new Promise(r=>{releaseProject=r});holdKey=key=>key==='bucket/mixed/projects/p0/versions/1.json';deny=key=>key==='bucket/mixed/projects/p1/versions/1.json';
 const mixedOutcome=mixed.storage.sync().then(()=>false,()=>true);
 await wait(()=>mixed.storage.lastSyncBatch.completed===mixed.storage.lastSyncBatch.total-1);
 const progress=mixed.storage.status();assert(progress.busy);assert.equal(progress.lastSyncBatch.finishedAt,null);assert.equal(progress.lastSyncBatch.total,18);assert.equal(progress.lastSyncBatch.active,1);assert.equal(progress.lastSyncBatch.pending,0);assert.equal(progress.lastSyncBatch.rejected,1);assert.equal(progress.lastSyncBatch.fulfilled,16);assert.equal(progress.lastSyncBatch.completed,17);
 assert(!objects.has('bucket/mixed/projects/p0/latest.json'));for(let i=0;i<8;i++)assert(objects.has('bucket/mixed/runs/r'+i+'/state.json'),'Run roots cannot wait for a held project category');assert(objects.has('bucket/mixed/engine/latest.json'));assert([...objects.keys()].some(k=>k.startsWith('bucket/mixed/backups/')));
 assert(starts.indexOf('bucket/mixed/runs/r0/input.json')<starts.indexOf('bucket/mixed/projects/p0/versions/1.json'),'Active runs receive initial slots');assert.deepEqual(progress.lastSyncBatch.failures,[{kind:'project',id:'p1'}]);
 releaseProject();hold=null;holdKey=null;assert(await mixedOutcome);assert.equal(mixed.storage.lastSyncBatch.completed,18);assert.equal(mixed.storage.lastSyncBatch.active,0);assert.equal(mixed.storage.lastSyncBatch.pending,0);deny=()=>false;
 const capped=await create('capped',{withActive:true,count:16,events:false});active=peak=0;await capped.storage.sync();assert.equal(capped.storage.lastSyncBatch.concurrency,4);assert(peak<=4&&peak>1,'Active development keeps background concurrency bounded at four');
 const revised=await create('revision',{count:1,events:false});onPut=(key)=>{if(key==='bucket/revision/projects/p0/versions/1.json')revised.store.putProject('p0',{title:'new',task:'new',nodes:[],edges:[]},1)};await revised.storage.sync();onPut=null;assert.equal(JSON.parse(objects.get('bucket/revision/projects/p0/latest.json')).revision,1);await revised.storage.sync();assert.equal(JSON.parse(objects.get('bucket/revision/projects/p0/latest.json')).revision,2);assert.equal(JSON.parse(objects.get('bucket/revision/projects/p0/versions/1.json')).revision,1);
 const closing=await create('closing',{count:40,events:false});let release;hold=new Promise(r=>{release=r});const started=starts.length,pending=closing.storage.sync(),outcome=pending.then(()=>false,()=>true);await wait(()=>starts.length>=started+16);assert.deepEqual(await closing.storage.sync(),{busy:true});const beforeClose=starts.length;await closing.storage.close();assert(await outcome);assert.equal(starts.length,beforeClose,'Close stops pending roots and drains active workers');assert.equal(closing.storage.busy,false);assert(closing.storage.lastSyncBatch.skipped>0);release();hold=null;await wait(()=>active===0);
 assert.deepEqual(errors,[]);
 console.log('Passed signed-S3 independent root concurrency, version/index ordering, failure isolation, backup progress, receipt reuse, active-run cap, revision races and close/drain checks.');
 // Optional component comparison; no models and never a whole-task speed claim.
 const baseline=process.argv[2];if(baseline){const {Storage:Before}=await import(pathToFileURL(join(resolve(baseline),'server/storage.mjs')));latency=60;const samples={};for(const [label,Class] of [['serial-before',Before],['parallel-after',Storage]]){const c=await create(label,{Class,count:48,events:false});peak=0;const from=starts.length,t0=performance.now();await c.storage.sync();samples[label]={elapsedMs:Math.round(performance.now()-t0),requests:starts.length-from,peak};}console.log(JSON.stringify({scope:'Full Storage.sync with equal signed-S3 HTTP fixture workloads at 60ms/request; no models',samples,speedFactor:Math.round(samples['serial-before'].elapsedMs/samples['parallel-after'].elapsedMs*100)/100,wholeTaskSpeedupProven:false}));
  latency=20;const readiness={};for(const [label,Class] of [['phased-before',Before],['unified-after',Storage]]){const c=await create(label,{Class,count:12,events:false,withActive:true});extraLatency=key=>key==='bucket/'+label+'/projects/p0/versions/1.json'?1200:0;const t0=performance.now();await c.storage.sync();readiness[label]={elapsedMs:Math.round(performance.now()-t0),activeRunSavedMs:Math.round(completedAt.get('bucket/'+label+'/runs/r0/state.json')-t0)};}extraLatency=()=>0;console.log(JSON.stringify({scope:'Time to persist the active run during full Storage.sync, same signed-S3 fixture with 20ms/request and one project delayed 1200ms; no models',samples:readiness,activeRunReadinessFactor:Math.round(readiness['phased-before'].activeRunSavedMs/readiness['unified-after'].activeRunSavedMs*100)/100,wholeTaskSpeedupProven:false}));}

}finally{hold=null;for(const c of cases){await c.storage.close();c.store.close()}server.closeAllConnections();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true})}
