import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {gzipSync,gunzipSync} from 'node:zlib';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {join,basename,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createControl} from '../server/http.mjs';

// These are real HTTP protocol fixtures. No request can reach an AI provider or
// a production bucket, and each native backend keeps its own workspace files.
const directory=await mkdtemp(join(tmpdir(),'canvas-parallel-'));
const workspaces=new Map(),conversations=new Map(),objects=new Map(),plans=new Map(),creates=[];
const repositoryFixture={sha:'a'.repeat(40),lookups:0,archives:0,gets:0},repositoryFiles=new Map([['existing/source.js',Buffer.from('export const source = 1;\n')],['existing/delete.txt',Buffer.from('delete this\n')],['existing/中文.bin',Buffer.from([0,255,10,128])],['.canvas-collaboration/plan.json',Buffer.from('stale protocol must be excluded')]]);
const fixtureErrors=[],peaks=new Map(),deliveryChecks=new Map();
let checks=0,app,controlBase;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const check=(value,message)=>{assert.ok(value,message);checks++};
function tar(root,files){
 const blocks=[];
 for(const [path,value] of files){
  const body=Buffer.from(value),header=Buffer.alloc(512),name=root+'/'+path;
  assert(Buffer.byteLength(name)<=100,'Fixture tar path must fit a USTAR name');
  header.write(name);header.write('0000644\0',100);header.write('0000000\0',108);header.write('0000000\0',116);
  header.write(body.length.toString(8).padStart(11,'0')+'\0',124);header.write('00000000000\0',136);
  header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);
  let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);
  blocks.push(header,body,Buffer.alloc((512-body.length%512)%512));
 }
 return gzipSync(Buffer.concat([...blocks,Buffer.alloc(1024)]));
}
function untar(bytes){
 const data=gunzipSync(bytes),files=new Map();
 for(let offset=0;offset+512<=data.length;){
  const header=data.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
  const field=(start,end)=>header.subarray(start,end).toString().split('\0')[0];
  const size=parseInt(field(124,136).trim()||'0',8),name=[field(345,500),field(0,100)].filter(Boolean).join('/');
  if([0,48].includes(header[156]))files.set(name,Buffer.from(data.subarray(offset+512,offset+512+size)));
  offset+=512+Math.ceil(size/512)*512;
 }
 return files;
}
function workspace(region,path){
 const candidates=[...workspaces.values()].filter(w=>w.region===region&&(path===w.path||path.startsWith(w.path+'/')));
 return candidates.sort((a,b)=>b.path.length-a.path.length)[0];
}
function planFor(runId){const plan=plans.get(runId);assert(plan,'Unexpected fixture run '+runId);return plan}
function stageFiles(nodeId,files,plan){
 if(nodeId==='plan'){
  if(plan.adaptive)files.set('.canvas-collaboration/plan.json',Buffer.from(JSON.stringify(plan.adaptive)));
  files.set('shared.txt',Buffer.from('baseline\n'));files.set('untouched.txt',Buffer.from('keep me\n'));
  files.set('assets/binary.bin',Buffer.from([0,13,10,255,128,1]));
 }else if(nodeId==='a'){
  if(plan.repositoryDelete)files.delete('existing/delete.txt');
  files.set('shared.txt',Buffer.from('changed by branch a\n'));files.set('frontend/a.txt',Buffer.from('frontend output\n'));
 }else if(nodeId==='b'){
  files.set('backend/b.txt',Buffer.from('backend output\n'));
  if(plan.conflict)files.set('shared.txt',Buffer.from('changed by branch b\n'));
 }else if(nodeId==='c'||nodeId==='d')files.set('branch-'+nodeId+'.txt',Buffer.from(nodeId+' output\n'));
 else if(nodeId.startsWith('_canvas_delivery_repair'))files.set('shared.txt',Buffer.from('targeted repair\n'));
 else if(nodeId==='join'){
  files.set('DELIVERY.md',Buffer.from('Integrated both branches\n'));
  if(plan.conflict){
   const resolved=Buffer.from('Explicitly integrated a and b\n');files.set('shared.txt',resolved);
   if(plan.resolution!=='missing')files.set('.canvas-collaboration/resolutions.json',Buffer.from(JSON.stringify({resolutions:{'shared.txt':{source:'custom',sha256:plan.resolution==='wrong'?'0'.repeat(64):createHash('sha256').update(resolved).digest('hex'),reason:'Combined both branch changes'}}})));
  }
 }
}
const fixture=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost'),parts=url.pathname.split('/').filter(Boolean),body=Buffer.concat(await Array.fromAsync(req));
  const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))};
  if(parts[0]==='github'){
   const path=decodeURIComponent(url.pathname.slice('/github'.length));
   if(path==='/archive'){assert(!req.headers.authorization,'Archive redirect must not receive the GitHub token');repositoryFixture.archives++;res.writeHead(200,{'Content-Type':'application/gzip'});res.end(tar('owner-repo-source',repositoryFiles));return}
   assert.equal(req.headers.authorization,'Bearer github-fixture-private');
   if(path==='/repos/owner/repo/git/ref/heads/main'){repositoryFixture.lookups++;json({object:{sha:repositoryFixture.sha,type:'commit'}});return}
   if(path.startsWith('/repos/owner/repo/tarball/')){assert(path.endsWith('a'.repeat(40)),'Retries preserve the originally resolved commit');res.writeHead(302,{Location:'/github/archive'});res.end();return}
   throw Error('Unexpected repository fixture '+path);
  }
  if(parts[0]==='bucket'){
   assert.match(req.headers.authorization||'',/AWS4-HMAC-SHA256/,'S3 requests must use Signature V4');
   const key=decodeURIComponent(parts.slice(1).join('/'));
   if(req.method==='PUT'){
    const inputMatch=key.match(/runs\/([^/]+)\/inputs\/([^/]+)(?:\/repair-\d+)?(?:\/attempt-\d+)?\/(workspace\.tar\.gz|handoff\.json)$/);
    if(inputMatch){const plan=planFor(inputMatch[1]);if(plan.inputGate?.nodeId===inputMatch[2]){plan.inputGate.entered=true;await plan.inputGate.promise}if(plan.failInput===inputMatch[2]){res.writeHead(403,{'Content-Type':'application/xml'});res.end('<Error><Code>AccessDenied</Code></Error>');return}}
    const match=key.match(/runs\/([^/]+)\/stages\/([^/]+)(?:\/repair-(\d+))?\/workspace\.tar\.gz$/);
    if(match){
     const plan=planFor(match[1]),nodeId=match[2];
     if(plan.checkpointDelayMs)await sleep(plan.checkpointDelayMs);
     if(plan.checkpointGate?.nodeId===nodeId){plan.checkpointGate.entered=true;await plan.checkpointGate.promise}
     if(plan.failCheckpoint===nodeId||plan.failRepairCheckpoint&&match[3]){res.writeHead(403,{'Content-Type':'application/xml'});res.end('<Error><Code>AccessDenied</Code></Error>');return}
    }
    objects.set(key,Buffer.from(body));res.writeHead(200,{ETag:'"fixture"'});res.end();return;
   }
   if(req.method==='GET'){if(key.includes('_canvas_repository_source'))repositoryFixture.gets++;const value=objects.get(key);if(!value){res.writeHead(404);res.end();return}res.writeHead(200,{'Content-Length':value.length});res.end(value);return}
   throw Error('Unexpected S3 operation '+req.method);
  }
  assert.equal(req.headers['x-session-api-key'],'native-fixture-private');
  const region=parts.shift(),path='/'+parts.join('/'),target=url.searchParams.get('path');
  if(path==='/api/bash/execute_bash_command'){
   const data=JSON.parse(body),encoded=data.command.match(/^\/usr\/bin\/python3 -I - ([A-Za-z0-9+/=]+) <<'CANVAS_DELIVERY_CHECK'/)?.[1];assert(encoded,'Only the request-bound check helper is allowed');
   const spec=JSON.parse(Buffer.from(encoded,'base64')),plan=planFor(spec.runId),key=spec.requestId;let job=deliveryChecks.get(key);
   const binding={requestId:key,artifactSha256:spec.artifactSha256,commandSha256:createHash('sha256').update(spec.command).digest('hex')};
   if(spec.operation==='start'&&!job){plan.checkStarts=(plan.checkStarts||0)+1;job={spec,status:plan.checkHold?'running':plan.checkFailAlways||plan.checkFailOnce&&plan.checkStarts===1?'failed':'passed'};deliveryChecks.set(key,job);if(plan.checkLostAck){plan.checkLostAck=false;json({error:'Lost check acknowledgement'},503);return}}
   if(job){assert.equal(job.spec.command,spec.command);assert.equal(job.spec.artifactSha256,spec.artifactSha256);if(spec.operation==='cancel'&&!plan.checkUncertain)job.status='cancelled';if(job.status==='running'&&!plan.checkHold)job.status=plan.checkFailAlways?'failed':'passed'}
   const status=plan.checkUncertain&&job?'uncertain':job?.status||'missing',receipt={...binding,status,...(status==='passed'?{exitCode:0}:status==='failed'?{exitCode:7,output:'calendar date failed native-fixture-private'}:{})};
   if(plan.checkCancelOnFailure&&status==='failed'){plan.checkCancelOnFailure=false;app.engine.stop(spec.runId)}
   if(plan.checkWrongReceipt)receipt.requestId='wrong';json({exit_code:0,stdout:JSON.stringify(receipt)});return;
  }
  if(path==='/api/file/create_directory'){
   const match=target.match(/^\/workspace\/runs\/([^/]+)\/([^/]+)$/);
   if(match&&!workspaces.has(region+target))workspaces.set(region+target,{region,path:target,runId:match[1],nodeId:match[2].replace(/-repair-\d+$/,''),repair:/-repair-\d+$/.test(match[2]),files:new Map()});
   json({success:true});return;
  }
  if(path==='/api/file/archive'||path.endsWith('/file/archive')){
   const ws=workspace(region,target);assert(ws,'Archive must name an existing node workspace: '+target);
   const plan=planFor(ws.runId);
   if(plan.failSnapshot===ws.nodeId&&records(ws.runId,ws.nodeId).length){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Fixture snapshot temporarily unavailable'}));return}
   res.writeHead(200,{'Content-Type':'application/gzip'});res.end(tar(basename(target),ws.files));return;
  }
  if(path==='/api/file/upload'){
   const ws=workspace(region,target);assert(ws,'Upload must target an existing node workspace');
   const boundary=req.headers['content-type'].match(/boundary=(?:"([^"]+)"|([^;]+))/);assert(boundary,'Multipart upload required');
   const start=body.indexOf(Buffer.from('\r\n\r\n'))+4,end=body.lastIndexOf(Buffer.from('\r\n--'+(boundary[1]||boundary[2])));
   assert(start>=4&&end>=start,'Valid multipart file body required');
   ws.files.set(target.slice(ws.path.length+1),Buffer.from(body.subarray(start,end)));json({success:true});return;
  }
  if(path==='/api/conversations'&&req.method==='POST'){
   const data=JSON.parse(body),ws=workspace(region,data.workspace.working_dir);assert(ws,'Conversation must use its own node workspace');
   const plan=planFor(ws.runId),record={id:data.conversation_id,runId:ws.runId,nodeId:ws.nodeId,workspace:ws.path,region,system:data.agent_settings?.agent_context?.system_message_suffix||'',prompt:data.initial_message.content[0].text,inherited:new Map(ws.files),status:'running',interrupts:0,readsAfterPause:0,readyAt:Date.now()+(plan.modelDelayMs||0)};
   record.fail=plan.failNodes?.has(ws.nodeId)||false;creates.push(record);conversations.set(record.id,record);stageFiles(ws.nodeId,ws.files,ws.repair&&plan.repairedAdaptive?{...plan,adaptive:plan.repairedAdaptive}:plan);
   const args=data.agent_settings?.acp_args||[],value=flag=>args[args.indexOf(flag)+1];
   if(args.includes('--request-id'))ws.files.set('.canvas-collaboration/runtime-selection.json',Buffer.from(JSON.stringify({schemaVersion:1,requestId:data.conversation_id,model:value('--model'),effort:value('--effort'),modelApplied:true,effortApplied:true})));
   if(plan.capacityGroup){const active=creates.filter(item=>item.status==='running'&&planFor(item.runId).capacityGroup===plan.capacityGroup).length;peaks.set(plan.capacityGroup,Math.max(peaks.get(plan.capacityGroup)||0,active))}
   if(plan.uncertainCreate&&!plan.createFaultSeen){plan.createFaultSeen=true;plan.hiddenLookups=2;json({error:'Fixture lost creation acknowledgement'},503);return}
   json({id:record.id,execution_status:'running'},201);return;
  }
  const match=path.match(/^\/api\/conversations\/([^/]+)(?:\/(events\/search|interrupt|pause|run))?$/);
  if(match){
   const record=conversations.get(match[1]);if(!record){json({error:'not found'},404);return}
   const plan=planFor(record.runId);
   if(!match[2]&&plan.hiddenLookups>0){plan.hiddenLookups--;json({error:'Fixture temporarily invisible'},404);return}
   if(['interrupt','pause'].includes(match[2])){record.interrupts++;if(!plan.unconfirmedStops?.has(record.nodeId))record.status='paused';json({success:true});return}
   if(match[2]==='run'){record.status='running';json({success:true});return}
   if(match[2]==='events/search'){
    const message=record.fail?'Warning\n'+JSON.stringify({type:'error',status:400,error:{code:'model_not_found',message:'Fixture provider failure'}}):record.nodeId+' completed';
    json({items:record.status==='finished'||plan.fatalWhileRunning?.has(record.nodeId)?[{id:record.id+'-output',kind:'ActionEvent',source:'agent',action:{kind:'FinishAction',message}}]:[],next_page_id:null});return;
   }
   if(record.status==='running'&&!plan.hold?.has(record.nodeId)&&Date.now()>=record.readyAt)record.status='finished';
   if(record.status==='paused')record.readsAfterPause++;
   json({id:record.id,execution_status:record.status});return;
  }
  json({error:'Unexpected fixture route '+path},404);
 }catch(error){fixtureErrors.push(error);res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}))}
});
fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
const fixtureBase='http://127.0.0.1:'+fixture.address().port;
const storageEnvironment={CANVAS_S3_ENDPOINT:fixtureBase,CANVAS_S3_BUCKET:'bucket',CANVAS_S3_REGION:'us-west',CANVAS_S3_FORCE_PATH_STYLE:'true',CANVAS_S3_ACCESS_KEY_ID:'FAKE_ACCESS',CANVAS_S3_SECRET_ACCESS_KEY:'FAKE_SECRET',CANVAS_S3_READ_ONLY:'false'};
const options={database:join(directory,'db.sqlite'),apiKey:'control-fixture-private',encryptionKey:'test-encryption-only',pollMs:10,storageIntervalMs:9999999,storageEnvironment};
const nodeIds=['plan','a','b','join'],regions={plan:'shanghai',a:'silicon',b:'silicon',c:'shanghai',d:'seoul',join:'seoul'};
const configs=Object.fromEntries(Object.keys(regions).map(nodeId=>[nodeId,{mode:'remote',baseUrl:fixtureBase+'/'+regions[nodeId],apiKey:'native-fixture-private',workspace:'/workspace',model:'acp:codex',profileId:'fixture-'+nodeId}]));
const bundle={...configs.plan,nodeConfigs:configs,teamProfiles:Object.fromEntries(Object.values(configs).map(c=>[c.profileId,c]))};
const flow={title:'Parallel fixture',task:'Isolated protocol acceptance only',executionMode:'parallel',maxParallelNodes:5,nodes:[{id:'start',type:'start',name:'Start',x:0,y:0},...nodeIds.map((id,i)=>({id,type:'code',name:id,prompt:'fixture:'+id,x:200+i*200,y:0})),{id:'end',type:'end',name:'End',x:1200,y:0}],edges:[['start','plan'],['plan','a'],['plan','b'],['a','join'],['b','join'],['join','end']]};
const fourBranches=['a','b','c','d'],wideFlow={...flow,nodes:[...flow.nodes,...['c','d'].map((id,i)=>({id,type:'code',name:id,prompt:'fixture:'+id,x:500,y:200+i*200}))],edges:[['start','plan'],...fourBranches.map(id=>['plan',id]),...fourBranches.map(id=>[id,'join']),['join','end']]};
async function open(){app=createControl(options);app.server.listen(0,'127.0.0.1');await once(app.server,'listening');controlBase='http://127.0.0.1:'+app.server.address().port}
async function waitFor(predicate,message,timeout=15000){
 const deadline=Date.now()+timeout;
 while(Date.now()<deadline){if(fixtureErrors.length)throw fixtureErrors[0];const value=await predicate();if(value)return value;await sleep(15)}
 throw Error('Timed out: '+message+'; runs='+JSON.stringify(app.store.listRuns().map(run=>({id:run.id,status:run.status,error:run.error,nodes:Object.fromEntries(Object.entries(run.nodes).map(([id,node])=>[id,node.status]))}))));
}
async function request(path,method='GET',body){const response=await fetch(controlBase+path,{method,headers:{Authorization:'Bearer control-fixture-private','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});assert.equal(response.status,200,'Control request '+path);return response.json()}
async function state(id){return request('/runs/'+id)}
async function waitRun(id,status){return waitFor(async()=>{const run=await state(id);return run.status===status&&!app.engine.active.has(id)&&run},id+' '+status)}
async function idle(){
 if(!app)return;app.engine.close();
 const deadline=Date.now()+20000;while(app.engine.active.size&&Date.now()<deadline)await sleep(15);
 assert.equal(app.engine.active.size,0,'Engine workers close without interrupting native conversations');
 await app.close();app.store.close();app=null;
}
function records(runId,nodeId){return creates.filter(record=>record.runId===runId&&(!nodeId||record.nodeId===nodeId))}
function start(id,plan={},workflow=flow,configuration=bundle){
 plan.hold??=new Set();plans.set(id,plan);app.store.putProject(id,workflow,0);
 const run=app.engine.enqueue({id,projectId:id,workflow},configuration);
 check(run.schedulerVersion===2,'New parallel runs use the DAG scheduler');return run;
}
function gate(nodeId){let release;const promise=new Promise(resolve=>{release=resolve});return {nodeId,promise,release,entered:false}}
async function runningBranches(id){return waitFor(async()=>{const run=await state(id);return ['a','b'].every(nodeId=>run.nodes[nodeId]?.status==='running'&&run.nodes[nodeId].handle)&&run},id+' concurrently running branches')}
try{
 await open();app.storage.save({enabled:true,endpoint:fixtureBase,bucket:'bucket',region:'us-west',forcePathStyle:true,prefix:'canvas/'});

 const checkpointGate=gate('b'),filePlan={hold:new Set(['a','b']),checkpointGate};start('parallel-files',filePlan);
 const running=await runningBranches('parallel-files');
 check(Object.values(running.nodes).filter(node=>node.status==='running').length>=2,'Control API exposes concurrent running branches');
 check(running.nodes.a.workspace!==running.nodes.b.workspace,'Branches on the same server have separate workspaces');
 for(const id of nodeIds)check(running.nodes[id].workspace.endsWith('/'+id),'Each node workspace ends in its node id');
 check(records('parallel-files','join').length===0,'Join cannot start while parents are running');
 filePlan.hold.delete('a');await waitFor(()=>app.store.run('parallel-files').nodes.a.checkpoint,'First branch checkpoint');
 check(records('parallel-files','join').length===0,'Join waits for every parent, even after one parent succeeds');
 filePlan.hold.delete('b');await waitFor(()=>checkpointGate.entered,'Second branch checkpoint upload blocked');
 check(records('parallel-files','join').length===0,'Join waits for parent checkpoint persistence, not just model completion');
 checkpointGate.release();const completed=await waitRun('parallel-files','succeeded'),joined=records('parallel-files','join')[0];
 check(joined.inherited.get('shared.txt')?.toString()==='changed by branch a\n','An unchanged sibling copy cannot overwrite another branch edit');
 check(joined.inherited.get('frontend/a.txt')?.toString()==='frontend output\n'&&joined.inherited.get('backend/b.txt')?.toString()==='backend output\n','Join inherits unrelated files from all parents');
 check(joined.inherited.get('untouched.txt')?.toString()==='keep me\n','Join retains common ancestor files');
 assert.deepEqual(joined.inherited.get('assets/binary.bin'),Buffer.from([0,13,10,255,128,1]));checks++;
 check(joined.prompt.includes('a completed')&&joined.prompt.includes('b completed'),'Join receives all direct parent results');
 const provenance=JSON.parse(joined.inherited.get('.canvas-collaboration/handoff.json'));
 check(provenance.sources.length===2&&provenance.sources.every(source=>/^[a-f0-9]{64}$/.test(source.checkpoint?.sha256||'')),'Join receives checksum-backed sources for every parent');
 check(JSON.stringify(provenance.lineage.map(source=>source.id).sort())===JSON.stringify(['a','b','plan']),'Join retains the full upstream execution lineage');
 check(provenance.scheduler.version===2&&provenance.sources.every(source=>source.submittedAt&&source.finishedAt),'Handoff includes scheduler and observed submission/completion timings');
 check(records('parallel-files').length===4,'Each DAG node executes exactly once');
 for(const node of Object.values(completed.nodes)){
  check(!!node.checkpoint?.sha256,'Every completed node has a verified persistent checkpoint');
  const archive=untar(objects.get(node.checkpoint.key));
  check([...archive.keys()].every(path=>path.startsWith('parallel-files/')),'Node snapshots normalize their archive root to the run id');
 }
 const manifest=await request('/runs/parallel-files/files');check(manifest.items.some(file=>file.path==='DELIVERY.md'),'Published files come from the joined output');

 start('parallel-conflict',{conflict:true});const conflictRun=await waitRun('parallel-conflict','succeeded'),conflictJoin=records('parallel-conflict','join')[0];
 check(!conflictJoin.inherited.has('shared.txt'),'Divergent edits do not silently choose a default winner');
 check(conflictJoin.inherited.get('.canvas-collaboration/inputs/a/shared.txt')?.toString()==='changed by branch a\n','Conflicting branch a content remains available to the join agent');
 check(conflictJoin.inherited.get('.canvas-collaboration/inputs/b/shared.txt')?.toString()==='changed by branch b\n','Conflicting branch b content remains available to the join agent');
 const handoff=JSON.parse(conflictJoin.inherited.get('.canvas-collaboration/handoff.json'));
 check(handoff.schemaVersion===1&&handoff.runId==='parallel-conflict'&&handoff.nodeId==='join'&&handoff.base==='plan','Conflict report identifies the run, join and common ancestor');
 assert.deepEqual(new Set(handoff.parents),new Set(['a','b']));checks++;
 const conflict=handoff.conflicts.find(item=>item.path==='shared.txt');
 check(conflict?.baseSha256===createHash('sha256').update('baseline\n').digest('hex'),'Conflict report records the common ancestor hash');
 for(const parent of ['a','b']){
  const variant=conflict.variants.find(item=>item.parent===parent),path='.canvas-collaboration/inputs/'+parent+'/shared.txt';
  check(variant?.path===path&&!variant.deleted&&variant.sha256===createHash('sha256').update(conflictJoin.inherited.get(path)).digest('hex'),'Conflict variant metadata matches the retained parent file');
 }
 const resolvedArchive=untar(objects.get(conflictRun.nodes.join.checkpoint.key));
 check(resolvedArchive.get('parallel-conflict/shared.txt')?.toString()==='Explicitly integrated a and b\n','Explicitly resolved conflict is present in the final checkpoint');
 for(const resolution of ['missing','wrong']){
  const id='parallel-conflict-'+resolution;start(id,{conflict:true,resolution});const invalid=await waitRun(id,'failed');
  check(invalid.nodes.join.status==='failed','Unacknowledged or incorrectly hashed conflict resolution cannot succeed');
  check(!invalid.nodes.join.checkpoint,'Invalid resolution cannot become a deliverable checkpoint');
 }

 const retryPlan={hold:new Set(['b']),failNodes:new Set(['b'])};start('parallel-retry',retryPlan);
 await waitFor(()=>app.store.run('parallel-retry').nodes.a.checkpoint,'Successful sibling checkpoint before failure');retryPlan.hold.delete('b');
 const failed=await waitRun('parallel-retry','failed');
 check(failed.nodes.a.status==='succeeded'&&failed.nodes.b.status==='failed','Provider failure is isolated to its branch');
 check(records('parallel-retry','join').length===0,'A failed dependency blocks downstream execution');
 const successfulCount=records('parallel-retry','a').length,rootCount=records('parallel-retry','plan').length;
 retryPlan.failNodes.clear();await app.engine.resume('parallel-retry',bundle);await waitRun('parallel-retry','succeeded');
 check(records('parallel-retry','a').length===successfulCount&&records('parallel-retry','plan').length===rootCount,'Retry preserves successful branches and their common ancestor');
 check(records('parallel-retry','b').length===2&&records('parallel-retry','join').length===1,'Retry only repeats the failed branch before joining');

 const checkpointPlan={failCheckpoint:'plan'};start('parallel-checkpoint',checkpointPlan);
 const checkpointFailed=await waitRun('parallel-checkpoint','failed');
 check(checkpointFailed.nodes.plan.status==='succeeded'&&!checkpointFailed.nodes.plan.checkpoint,'Checkpoint failure preserves completed AI state');
 check(records('parallel-checkpoint').length===1,'Checkpoint failure prevents every dependent branch from starting');
 checkpointPlan.failCheckpoint=null;await app.engine.resume('parallel-checkpoint',bundle);await waitRun('parallel-checkpoint','succeeded');
 check(records('parallel-checkpoint','plan').length===1,'Checkpoint retry never calls the completed AI again');

 const inputGate=gate('plan'),inputPlan={inputGate};start('parallel-input-overlap',inputPlan);
 await waitFor(()=>inputGate.entered&&records('parallel-input-overlap','plan').length===1,'Model starts while input storage is pending');
 await waitFor(()=>app.store.run('parallel-input-overlap').nodes.plan.modelCompleted,'Model completion overlaps input persistence');
 check(records('parallel-input-overlap').length===1&&!app.store.run('parallel-input-overlap').nodes.plan.outputReady,'Pending input persistence remains a downstream checkpoint barrier');
 inputGate.release();await waitRun('parallel-input-overlap','succeeded');
 check(Object.values(app.store.run('parallel-input-overlap').nodes).every(n=>n.inputStored),'Every successful stage has persisted its input');
 const inputFailure={failInput:'plan'};start('parallel-input-failure',inputFailure);const inputFailed=await waitRun('parallel-input-failure','failed');
 check(inputFailed.nodes.plan.modelCompleted&&!inputFailed.nodes.plan.outputReady&&records('parallel-input-failure').length===1,'Input storage failure preserves completed inference and prevents downstream work');
 inputFailure.failInput=null;await app.engine.resume('parallel-input-failure',bundle);await waitRun('parallel-input-failure','succeeded');
 check(records('parallel-input-failure','plan').length===1,'Input persistence retry never repeats successful inference');

 const singleFlow={...flow,nodes:flow.nodes.filter(n=>['start','plan','end'].includes(n.id)),edges:[['start','plan'],['plan','end']]},previousLimit=app.engine.maxNodeActive;
 const uncertainCreation={uncertainCreate:true,hold:new Set(['plan'])};start('uncertain-creation',uncertainCreation,singleFlow);const uncertainFailed=await waitRun('uncertain-creation','failed'),reservedNative=uncertainFailed.nodes.plan.conversationId;
 await app.engine.resume('uncertain-creation',bundle);await waitFor(()=>app.store.run('uncertain-creation').nodes.plan.handle,'Resume rediscovers the original uncertain native conversation');check(app.store.run('uncertain-creation').nodes.plan.conversationId===reservedNative&&records('uncertain-creation').length===1,'A temporarily missing acknowledgement never replaces a potentially submitted request with another identity');uncertainCreation.hold.clear();await waitRun('uncertain-creation','succeeded');

 app.engine.maxNodeActive=1;const slotGate=gate('plan');start('storage-slot-free',{checkpointGate:slotGate},singleFlow);await waitFor(()=>slotGate.entered,'Completed inference enters its storage barrier');
 const nextSlot={hold:new Set(['plan'])};start('storage-slot-next',nextSlot,singleFlow);await waitFor(()=>records('storage-slot-next','plan').length===1,'Another run uses the released inference slot');
 check(!app.store.run('storage-slot-free').nodes.plan.outputReady&&app.engine.nodeActive.size===1,'Storage waits release inference capacity while preserving output barriers');
 slotGate.release();nextSlot.hold.clear();await waitRun('storage-slot-free','succeeded');await waitRun('storage-slot-next','succeeded');app.engine.maxNodeActive=previousLimit;

 // Inference limits count preparation/inference, never completed-model uploads.
 const sameRunGate=gate('a'),sameRunPlan={checkpointGate:sameRunGate,hold:new Set(['b']),capacityGroup:'storage-per-run'};
 start('storage-per-run',sameRunPlan,{...flow,maxParallelNodes:1});
 await waitFor(()=>sameRunGate.entered&&records('storage-per-run','b').length===1,'Independent sibling starts while the previous sibling persists');
 check(peaks.get('storage-per-run')===1&&!app.store.run('storage-per-run').nodes.a.outputReady,'Per-run inference limit stays one; bucket barrier remains closed');
 check(records('storage-per-run','join').length===0,'A true dependent still waits for both output barriers');
 sameRunGate.release();sameRunPlan.hold.clear();await waitRun('storage-per-run','succeeded');

 const admissionIds=Array.from({length:5},(_,i)=>'dag-admission-'+i),admissionPlans=admissionIds.map(id=>{const p={hold:new Set(['plan']),capacityGroup:'admission'};start(id,p,singleFlow);return p});
 await waitFor(()=>admissionIds.every(id=>records(id,'plan').length===1),'Five single-node DAG runs fill all global inference slots');
 check(peaks.get('admission')===5,'The old three-workflow admission limit no longer leaves two inference slots idle');
 for(const p of admissionPlans)p.hold.clear();await Promise.all(admissionIds.map(id=>waitRun(id,'succeeded')));

 const oldStageLimit=app.engine.maxStageActive,oldNodeLimit=app.engine.maxNodeActive;app.engine.maxStageActive=2;app.engine.maxNodeActive=1;
 const pressureGates=[gate('plan'),gate('plan')];
 start('stage-pressure-a',{checkpointGate:pressureGates[0]},singleFlow);await waitFor(()=>pressureGates[0].entered,'First pending snapshot');
 start('stage-pressure-b',{checkpointGate:pressureGates[1]},singleFlow);await waitFor(()=>pressureGates[1].entered,'Second pending snapshot');
 const pressureNext={hold:new Set(['plan'])};start('stage-pressure-next',pressureNext,singleFlow);
 await waitFor(()=>app.engine.active.has('stage-pressure-next'),'Backpressured DAG is resident');
 await sleep(80);check(records('stage-pressure-next').length===0&&app.engine.stageActive.size===2&&app.engine.nodeActive.size===0,'Global stage backpressure bounds storage without claiming inference is busy');
 pressureGates[0].release();await waitFor(()=>records('stage-pressure-next').length===1,'A released persistence slot dispatches the waiting node');
 check(app.engine.stageActive.size<=2,'All outstanding stage work stays within the separate bound');
 await request('/runs/stage-pressure-b/stop','POST',{});check((await state('stage-pressure-b')).status==='stopping','Cancellation stays pending while an already completed snapshot is persisting');
 pressureGates[1].release();pressureNext.hold.clear();await waitRun('stage-pressure-a','succeeded');await waitRun('stage-pressure-b','cancelled');await waitRun('stage-pressure-next','succeeded');
 app.engine.maxStageActive=oldStageLimit;app.engine.maxNodeActive=oldNodeLimit;

 const snapshotPlan={failSnapshot:'plan'};start('parallel-snapshot',snapshotPlan);
 const snapshotFailed=await waitRun('parallel-snapshot','failed');
 check(snapshotFailed.nodes.plan.status==='succeeded'&&snapshotFailed.nodes.plan.modelCompleted&&!snapshotFailed.nodes.plan.checkpoint,'Transient archive failure preserves completed AI state');
 check(records('parallel-snapshot').length===1,'Unavailable snapshot blocks downstream branches');
 snapshotPlan.failSnapshot=null;await app.engine.resume('parallel-snapshot',bundle);await waitRun('parallel-snapshot','succeeded');
 check(records('parallel-snapshot','plan').length===1,'Snapshot retry recaptures files without repeating the completed AI');

 const stopPlan={hold:new Set(['a','b']),unconfirmedStops:new Set(['b'])};start('parallel-stop',stopPlan);await runningBranches('parallel-stop');
 await request('/runs/parallel-stop/stop','POST',{});
 await waitFor(()=>['a','b'].every(id=>records('parallel-stop',id)[0]?.interrupts>0),'Stop reaches all running branches');
 check((await state('parallel-stop')).status==='stopping','One confirmed branch cannot mark the whole run cancelled');
 stopPlan.unconfirmedStops.clear();const stopped=await waitRun('parallel-stop','cancelled');
 check(['a','b'].every(id=>stopped.nodes[id].status==='paused'),'Cancellation confirms all running branch states');
 check(['a','b'].every(id=>records('parallel-stop',id)[0].readsAfterPause>=2),'Every running backend receives repeated stop confirmation');
 check(records('parallel-stop','join').length===0,'Stopping never starts a pending join');

 const restartPlan={hold:new Set(['a','b'])};start('parallel-restart',restartPlan);await runningBranches('parallel-restart');
 const beforeRestart=records('parallel-restart').length;await idle();await open();
 await runningBranches('parallel-restart');
 check(records('parallel-restart').length===beforeRestart,'Controller restart reconnects existing conversations without resubmission');
 restartPlan.hold.clear();await waitRun('parallel-restart','succeeded');
 check(records('parallel-restart').length===4,'Restart recovers both branches and starts the join exactly once');

 const cappedPlan={hold:new Set(fourBranches),capacityGroup:'per-run'};
 start('parallel-cap-two',cappedPlan,{...wideFlow,maxParallelNodes:2});
 await waitFor(async()=>{const run=await state('parallel-cap-two');return fourBranches.filter(id=>run.nodes[id].status==='running'&&run.nodes[id].handle).length===2},'Two of four branches occupy run slots');
 check(records('parallel-cap-two').filter(record=>fourBranches.includes(record.nodeId)).length===2,'Per-run limit keeps extra ready branches pending');
 const firstActive=records('parallel-cap-two').find(record=>fourBranches.includes(record.nodeId));cappedPlan.hold.delete(firstActive.nodeId);
 await waitFor(()=>records('parallel-cap-two').filter(record=>fourBranches.includes(record.nodeId)).length===3,'Completing one branch releases exactly one run slot');
 check(peaks.get('per-run')===2,'Four-branch workflow has an actual native execution peak of two');
 cappedPlan.hold.clear();await waitRun('parallel-cap-two','succeeded');
 check(peaks.get('per-run')===2,'Per-run cap remains respected through final integration');

 const globalPlans=['parallel-global-one','parallel-global-two'].map(id=>{const plan={hold:new Set(fourBranches),capacityGroup:'global'};start(id,plan,wideFlow);return plan});
 await waitFor(()=>creates.filter(record=>record.status==='running'&&planFor(record.runId).capacityGroup==='global').length===5,'Different workflows fill the five global native execution slots');
 check(peaks.get('global')===5,'Global limit allows five concurrent native conversations across workflows');
 check(['parallel-global-one','parallel-global-two'].every(id=>records(id).some(record=>fourBranches.includes(record.nodeId))),'Both workflows receive global execution slots');
 for(const plan of globalPlans)plan.hold.clear();
 await Promise.all(['parallel-global-one','parallel-global-two'].map(id=>waitRun(id,'succeeded')));
 check(peaks.get('global')===5,'Global native execution peak never exceeds five when workflows compete');

 const restartStopPlan={hold:new Set(fourBranches)};
 start('parallel-restart-stop',restartStopPlan,{...wideFlow,maxParallelNodes:2});await runningBranches('parallel-restart-stop');
 await idle();await open();await runningBranches('parallel-restart-stop');
 await request('/runs/parallel-restart-stop/stop','POST',{});const restartStopped=await waitRun('parallel-restart-stop','cancelled');
 check(records('parallel-restart-stop').length===3,'Restart cancellation reconnects started nodes and never submits pending branches');
 check(['c','d','join'].every(id=>restartStopped.nodes[id].status==='pending'&&!restartStopped.nodes[id].handle),'Restart cancellation preserves every never-started node as pending');
 check(['a','b'].every(id=>restartStopped.nodes[id].status==='paused'&&records('parallel-restart-stop',id)[0].interrupts>0),'Restart cancellation confirms both recovered native branches');

 const rootOnlyFlow={title:'Automatically parallel roots',task:'Isolated protocol acceptance only',nodes:flow.nodes.filter(node=>['start','a','b','end'].includes(node.id)),edges:[['start','a'],['start','b'],['a','end'],['b','end']]};
 const rootOnlyPlan={hold:new Set(['a','b'])};start('parallel-auto-roots',rootOnlyPlan,rootOnlyFlow);
 const rootOnlyRunning=await runningBranches('parallel-auto-roots');
 check(Object.values(rootOnlyRunning.nodes).filter(node=>node.status==='running').length===2,'Multiple root agents run concurrently without an explicit executionMode');
 rootOnlyPlan.hold.clear();await waitRun('parallel-auto-roots','succeeded');
 check(records('parallel-auto-roots').length===2,'Automatic parallel roots do not require a planning or integration conversation');
 const rootOnlyFiles=await request('/runs/parallel-auto-roots/files');
 check(['frontend/a.txt','backend/b.txt'].every(path=>rootOnlyFiles.items.some(file=>file.path===path)),'Independent terminal branches are merged into the final artifact');
 check((await request('/runs/parallel-auto-roots/file?path=frontend/a.txt')).content==='frontend output\n'&&(await request('/runs/parallel-auto-roots/file?path=backend/b.txt')).content==='backend output\n','Final artifact preserves the actual output bytes of both terminal branches');

 const failedStopPlan={hold:new Set(['b']),failNodes:new Set(['b']),fatalWhileRunning:new Set(['b']),unconfirmedStops:new Set(['b'])};
 start('parallel-failed-stop',failedStopPlan);const failedBeforeStop=await waitRun('parallel-failed-stop','failed'),unconfirmed=failedBeforeStop.nodes.b;
 check(!!unconfirmed.handle&&!!unconfirmed.submittedAt&&!unconfirmed.modelCompleted&&!unconfirmed.stopConfirmed&&records('parallel-failed-stop','b')[0].status==='running','Failed run can retain a submitted native conversation whose stop is unconfirmed');
 const failedStopResponse=await request('/runs/parallel-failed-stop/stop','POST',{});
 check(failedStopResponse.status==='stopping','Stopping a failed run with an unconfirmed conversation enters stopping');
 await waitFor(()=>records('parallel-failed-stop','b')[0].interrupts>0,'Failed run stop reaches its submitted native conversation');
 check((await state('parallel-failed-stop')).status==='stopping','A failed run cannot be cancelled before its native conversation confirms stop');
 failedStopPlan.unconfirmedStops.clear();const failedStopped=await waitRun('parallel-failed-stop','cancelled');
 check(failedStopped.nodes.b.status==='paused'&&failedStopped.nodes.b.stopConfirmed&&records('parallel-failed-stop','b')[0].readsAfterPause>=2,'Failed run cancellation requires repeated native stop confirmation');
 check(records('parallel-failed-stop','join').length===0&&records('parallel-failed-stop','b').length===1,'Stopping a failed run never starts downstream or resubmits the failed conversation');
 const stage=(id,phase,dependsOn=[])=>({id,name:id,phase,prompt:'fixture:'+id,executionProfile:configs[id].profileId,dependsOn});
 const aiPlan={schemaVersion:1,goal:'按需求实现两个模块',decisions:'a/b 独立实现并行，join 汇合后 c 测试，d 交付',acceptanceCriteria:['两个模块共同可用'],maxParallelNodes:2,stages:[stage('a','build'),stage('b','build'),stage('join','integrate',['a','b']),stage('c','verify',['join']),stage('d','deliver',['c'])]},seed={...flow,collaborationMode:'adaptive',nodes:flow.nodes.filter(n=>['start','plan','end'].includes(n.id)).map(n=>n.id==='plan'?{...n,type:'planner'}:n),edges:[['start','plan'],['plan','end']]};
 const adaptive={adaptive:aiPlan,hold:new Set(['a','b'])};start('adaptive-team',adaptive,seed);await runningBranches('adaptive-team');
 let planned=await state('adaptive-team');check(planned.adaptivePlan.status==='applied'&&planned.order.length===6,'AI output expands the runtime DAG only after the planner snapshot');check(planned.maxParallelNodes===2&&planned.nodes.a.profileId==='fixture-a'&&planned.nodes.b.profileId==='fixture-b','AI decides profiles and concurrency');check(records('adaptive-team','c').length===0&&records('adaptive-team','d').length===0,'No testing or delivery starts during implementation');check(records('adaptive-team','plan')[0].prompt.includes('\"decisions\"')&&!records('adaptive-team','plan')[0].prompt.includes('native-fixture-private'),'Planning prompt includes task-led decisions without private credentials');
 const coordinatorPrompt=records('adaptive-team','plan')[0].prompt;check(coordinatorPrompt.indexOf('modelSets')<coordinatorPrompt.indexOf('用户任务：')&&coordinatorPrompt.split('Team and observations:').length===2,'Compact coordination data precedes the variable user task exactly once');
 const adaptiveCreated=records('adaptive-team').length;await idle();await open();await runningBranches('adaptive-team');check(records('adaptive-team').length===adaptiveCreated,'Restart preserves the expanded plan and existing AI calls');adaptive.hold.clear();const adaptiveDone=await waitRun('adaptive-team','succeeded');check(adaptiveDone.nodes.c.outputReady&&adaptiveDone.nodes.d.outputReady&&records('adaptive-team','plan').length===1,'Final tests and delivery run once after implementation');check(objects.has(adaptiveDone.nodes.plan.checkpoint.key)&&JSON.parse(untar(objects.get(adaptiveDone.nodes.plan.checkpoint.key)).get('adaptive-team/.canvas-collaboration/plan.json')).decisions===aiPlan.decisions,'AI decisions and dependency plan are in the bucket checkpoint');
 const invalid={adaptive:{...aiPlan,stages:aiPlan.stages.map(n=>n.id==='c'?{...n,dependsOn:['a']}:n)}};start('adaptive-invalid',invalid,seed);const rejected=await waitRun('adaptive-invalid','failed');check(rejected.nodes.plan.planningRejected&&records('adaptive-invalid').length===1,'Premature tests cause plan rejection before any implementation call');invalid.adaptive=aiPlan;await app.engine.resume('adaptive-invalid',bundle);await waitRun('adaptive-invalid','succeeded');check(records('adaptive-invalid','plan').length===2&&records('adaptive-invalid','a').length===1,'Explicit resume can replan invalid output without replaying successful implementation');
 const cancelled={adaptive:aiPlan,hold:new Set(['plan'])};start('adaptive-stop-before-plan',cancelled,seed);await waitFor(()=>records('adaptive-stop-before-plan','plan').length,'Planner starts');await request('/runs/adaptive-stop-before-plan/stop','POST',{});await waitRun('adaptive-stop-before-plan','cancelled');check(records('adaptive-stop-before-plan').length===1,'Stopping during planning never submits future tasks');
 const leanSeed={...seed,coordinationPolicy:'lean'},leanOne={...aiPlan,stages:[{...stage('a','build'),estimatedSeconds:37}]};start('lean-single',{adaptive:leanOne},leanSeed);const leanDone=await waitRun('lean-single','succeeded');check(leanDone.schedulingVersion===1&&leanDone.scheduling?.estimates.a.durationMs===37000&&leanDone.scheduling.estimates.a.source==='planner','AI duration hints are frozen atomically with the expanded DAG');check(leanDone.order.length===2&&records('lean-single').length===2,'Small work uses only planner and implementer, with no mandatory reviewer');check(leanDone.adaptivePlan.reviewStages===0&&leanDone.nodes.a.outputReady,'Implementation delivers through the same validated snapshot barrier');check(records('lean-single','a')[0].system.length<150&&!records('lean-single','a')[0].system.includes('fixture:a'),'Lean session does not duplicate the entire task in its system prompt');
 start('lean-independent',{adaptive:{...aiPlan,stages:[stage('a','build'),stage('b','build')]}},leanSeed);const independent=await waitRun('lean-independent','succeeded');check(records('lean-independent').length===3&&independent.order.length===3,'Independent AI work merges automatically without an extra delivery call');const independentFiles=await request('/runs/lean-independent/files');check(independentFiles.items.some(f=>f.path==='frontend/a.txt')&&independentFiles.items.some(f=>f.path==='backend/b.txt'),'Automatic final merge preserves files from both workers');
 start('lean-over-review',{adaptive:aiPlan},leanSeed);const tooManyReviews=await waitRun('lean-over-review','failed');check(tooManyReviews.error.includes('最多一个')&&records('lean-over-review').length===1,'Lean coordination rejects redundant separate verification and delivery calls before implementation');
 const directPlan={...aiPlan,deliveryMode:'direct',deliverables:['shared.txt','assets/binary.bin'],stages:[]};start('direct-delivery',{adaptive:directPlan},leanSeed);const directDone=await waitRun('direct-delivery','succeeded');
 check(directDone.adaptivePlan.directDelivery&&directDone.order.length===1&&records('direct-delivery').length===1,'A capable coordinator delivers directly without a second inference');
 const directFiles=await request('/runs/direct-delivery/files');check(directFiles.items.some(f=>f.path==='shared.txt')&&directDone.nodes.plan.outputReady&&objects.has(directDone.nodes.plan.checkpoint.key),'Direct delivery uses real artifact files and the same persistent checkpoint barrier');
 const directMissing={adaptive:{...directPlan,deliverables:['missing-implementation.js']}};start('direct-missing',directMissing,leanSeed);const directRejected=await waitRun('direct-missing','failed');check(directRejected.nodes.plan.planningRejected&&records('direct-missing').length===1,'A direct-delivery claim without its actual implementation cannot succeed');
 const directRetry={adaptive:directPlan,failCheckpoint:'plan'};start('direct-storage-retry',directRetry,leanSeed);await waitRun('direct-storage-retry','failed');directRetry.failCheckpoint=null;await app.engine.resume('direct-storage-retry',bundle);await waitRun('direct-storage-retry','succeeded');check(records('direct-storage-retry').length===1,'Direct-delivery storage retry preserves the completed coordinator without inference replay');

 const strongSelection={mode:'auto',model:'gpt-6-astra',effort:'medium',complexity:'standard',planner:true,verified:true},strongConfig={...configs.plan,commands:{codex:'/fixture/codex'},policyRuntimePath:'/workspace/.canvas-runtime/fixture.py',policyModels:[{id:'gpt-6-astra',verified:true,efforts:['medium']}],selection:strongSelection},strongBundle={...bundle,nodeConfigs:{...configs,plan:strongConfig},teamProfiles:{...bundle.teamProfiles,[strongConfig.profileId]:strongConfig}},strongSeed={...leanSeed,plannerPolicy:'strongest'},missingPlan={...directPlan,deliverables:['missing-output.js']};
 const checkedSeed={...strongSeed,deliveryValidation:{command:'node contract.mjs',timeoutSeconds:10}};
 start('delivery-check-pass',{adaptive:directPlan},checkedSeed,strongBundle);const checkPassed=await waitRun('delivery-check-pass','succeeded');check(checkPassed.deliveryCheck.current.status==='passed'&&checkPassed.deliveryCheck.attempts.length===1&&checkPassed.deliveryCheck.current.checkpoint.key===checkPassed.nodes.plan.checkpoint.key&&records(checkPassed.id).length===1,'Explicit final check passes without another AI call');
 const fixCheck={adaptive:directPlan,checkFailOnce:true};start('delivery-check-fix',fixCheck,checkedSeed,strongBundle);const fixedCheck=await waitRun('delivery-check-fix','succeeded');check(fixedCheck.deliveryCheck.repairCount===1&&fixedCheck.deliveryCheck.autoRepairCount===1&&fixedCheck.deliveryCheck.attempts.length===2&&fixCheck.checkStarts===2&&records(fixedCheck.id).length===2,'One confirmed failure immediately triggers one strongest repair and one fresh check');
 const repairCall=records(fixedCheck.id,'_canvas_delivery_repair')[0];check(repairCall.prompt.includes('calendar date failed')&&!repairCall.prompt.includes('native-fixture-private')&&repairCall.inherited.get('untouched.txt').toString()==='keep me\n'&&repairCall.inherited.get('assets/binary.bin').equals(Buffer.from([0,13,10,255,128,1])),'Targeted repair gets redacted failure and complete existing text/binary artifacts');check(fixedCheck.nodes._canvas_delivery_repair.modelSelection.model===strongSelection.model&&fixedCheck.nodes._canvas_delivery_repair.reasoningEffort===strongSelection.effort&&fixedCheck.nodes.plan.outputReady,'Strongest frozen model/depth repairs without replaying completed implementation');
 const exhaustedCheck={adaptive:directPlan,checkFailAlways:true};start('delivery-check-exhausted',exhaustedCheck,checkedSeed,strongBundle);const exhaustedDelivery=await waitRun('delivery-check-exhausted','failed');check(records(exhaustedDelivery.id).length===2&&exhaustedCheck.checkStarts===2&&exhaustedDelivery.deliveryCheck.autoRepairCount===1,'Second check failure stops automatic inference');exhaustedCheck.checkFailAlways=false;await app.engine.resume(exhaustedDelivery.id,strongBundle);const manualDelivery=await waitRun(exhaustedDelivery.id,'succeeded');check(manualDelivery.deliveryCheck.repairCount===2&&manualDelivery.deliveryCheck.autoRepairCount===1&&records(manualDelivery.id).length===3,'Explicit continuation can repair once more while retaining the automatic cap');
 const checkLost={adaptive:directPlan,checkLostAck:true};start('delivery-check-ack',checkLost,checkedSeed,strongBundle);await waitRun('delivery-check-ack','failed');await app.engine.resume('delivery-check-ack',strongBundle);await waitRun('delivery-check-ack','succeeded');check(checkLost.checkStarts===1&&records('delivery-check-ack').length===1,'Lost check acknowledgement resumes the reserved command and never repeats inference');
 const checkStorage={adaptive:{...aiPlan,stages:[stage('a','build'),stage('b','build')]},failCheckpoint:'_canvas_delivery_source_0_0'};start('delivery-check-storage',checkStorage,checkedSeed,strongBundle);await waitRun('delivery-check-storage','failed');check(!checkStorage.checkStarts,'A failed check-source bucket barrier cannot dispatch the check');checkStorage.failCheckpoint=null;await app.engine.resume('delivery-check-storage',strongBundle);await waitRun('delivery-check-storage','succeeded');check(records('delivery-check-storage').length===3&&checkStorage.checkStarts===1,'Check-source storage recovery only completes storage and check');
 const checkRestart={adaptive:directPlan,checkHold:true};start('delivery-check-restart',checkRestart,checkedSeed,strongBundle);await waitFor(()=>app.store.run('delivery-check-restart')?.deliveryCheck?.current?.status==='running','Native final check starts');await idle();await open();checkRestart.checkHold=false;await waitRun('delivery-check-restart','succeeded');check(checkRestart.checkStarts===1&&records('delivery-check-restart').length===1,'Controller restart reconnects the same command receipt without inference or check replay');
 const checkStop={adaptive:directPlan,checkHold:true};start('delivery-check-stop',checkStop,checkedSeed,strongBundle);await waitFor(()=>app.store.run('delivery-check-stop')?.deliveryCheck?.current?.status==='running','Check starts before cancellation');await request('/runs/delivery-check-stop/stop','POST',{});await waitRun('delivery-check-stop','cancelled');check(checkStop.checkStarts===1&&records('delivery-check-stop').length===1,'Cancellation waits for native check termination and never starts repair');checkStop.checkHold=false;await app.engine.resume('delivery-check-stop',strongBundle);await waitRun('delivery-check-stop','succeeded');check(checkStop.checkStarts===2&&records('delivery-check-stop').length===1,'Explicit continuation after a cancelled check starts a new check identity without model replay');
 const checkUnknown={adaptive:directPlan,checkUncertain:true};start('delivery-check-uncertain',checkUnknown,checkedSeed,strongBundle);await waitRun('delivery-check-uncertain','failed');await app.engine.resume('delivery-check-uncertain',strongBundle);await waitRun('delivery-check-uncertain','failed');check(checkUnknown.checkStarts===1&&records('delivery-check-uncertain').length===1,'Uncertain native result cannot be replayed or converted into an AI repair');checkUnknown.checkUncertain=false;await request('/runs/delivery-check-uncertain/stop','POST',{});await waitRun('delivery-check-uncertain','cancelled');
 const cachedId='delivery-check-pass',cachedRun=app.store.run(cachedId);deliveryChecks.delete(cachedRun.deliveryCheck.current.requestId);app.engine.patch(cachedId,r=>{r.status='failed';r.finishedAt=null;r.error='Fixture final artifact copy interruption'});await app.engine.resume(cachedId,strongBundle);await waitRun(cachedId,'succeeded');check(planFor(cachedId).checkStarts===1&&records(cachedId).length===1,'A durable completed check is reused even if its remote receipt later disappears');
 const missingReceipt={adaptive:directPlan,checkLostAck:true};start('delivery-check-missing-receipt',missingReceipt,checkedSeed,strongBundle);await waitRun('delivery-check-missing-receipt','failed');deliveryChecks.delete(app.store.run('delivery-check-missing-receipt').deliveryCheck.current.requestId);await app.engine.resume('delivery-check-missing-receipt',strongBundle);await waitRun('delivery-check-missing-receipt','failed');check(missingReceipt.checkStarts===1&&records('delivery-check-missing-receipt').length===1,'A missing receipt after reserved dispatch cannot replay an uncertain command');
 const cancelFailed={adaptive:directPlan,checkFailOnce:true,checkCancelOnFailure:true};start('delivery-check-cancel-failed',cancelFailed,checkedSeed,strongBundle);await waitRun('delivery-check-cancel-failed','cancelled');check(records('delivery-check-cancel-failed').length===1,'A cancellation concurrent with a failing check prevents automatic repair');await app.engine.resume('delivery-check-cancel-failed',strongBundle);const explicitlyFixed=await waitRun('delivery-check-cancel-failed','succeeded');check(explicitlyFixed.deliveryCheck.attempts.length===2&&explicitlyFixed.deliveryCheck.attempts[0].status==='failed'&&explicitlyFixed.deliveryCheck.autoRepairCount===0,'Explicit repair after cancellation preserves the failed check receipt');
 const checkWrong={adaptive:directPlan,checkWrongReceipt:true};start('delivery-check-binding',checkWrong,checkedSeed,strongBundle);await waitRun('delivery-check-binding','failed');check(records('delivery-check-binding').length===1,'A mismatched check receipt never passes or triggers inference');
 const corrected={adaptive:missingPlan,repairedAdaptive:directPlan};start('automatic-plan-repair',corrected,strongSeed,strongBundle);const correctedRun=await waitRun('automatic-plan-repair','succeeded'),correctedNode=correctedRun.nodes.plan,repairRecord=records(correctedRun.id,'plan')[1];
 check(records(correctedRun.id).length===2&&correctedNode.autoPlanRepairCount===1&&correctedNode.attempts[0].outcome==='invalid-plan','Verified strongest planning gets one targeted correction with a distinct durable request');
 check(correctedNode.modelRequested==='gpt-6-astra'&&correctedNode.reasoningEffort==='medium'&&repairRecord.workspace.endsWith('/plan-repair-1'),'Correction preserves the same model/depth and uses another isolated workspace');
 check(repairRecord.prompt.includes('上一轮规划未通过校验')&&repairRecord.prompt.includes('rejected-plan.json')&&repairRecord.inherited.has('shared.txt')&&repairRecord.inherited.get('assets/binary.bin')?.equals(Buffer.from([0,13,10,255,128,1])),'Specific failure and verified prior code/binary artifacts reach the correction');
 check(repairRecord.inherited.has('.canvas-collaboration/rejected-plan.json')&&!repairRecord.inherited.has('.canvas-collaboration/runtime-selection.json'),'Rejected plan is available without stale model-policy receipts');
 const rejectedCheckpoint=correctedNode.attempts[0].checkpoint;check(rejectedCheckpoint.key!==correctedNode.checkpoint.key&&createHash('sha256').update(objects.get(rejectedCheckpoint.key)).digest('hex')===rejectedCheckpoint.sha256,'Original rejected snapshot remains immutable at its own bucket key');
 const correctedPerformance=(await request('/runs/automatic-plan-repair/performance')).performance;check(correctedPerformance.modelIntervalsComplete&&correctedPerformance.nodes[0].previousAttempts.length===1&&!correctedPerformance.nodes[0].previousAttempts[0].interrupted,'Timing includes both model attempts and distinguishes completed invalid planning from an interruption');

 const repairUpload={adaptive:missingPlan,repairedAdaptive:directPlan,failRepairCheckpoint:true};start('repair-storage-retry',repairUpload,strongSeed,strongBundle);const repairUploadFailed=await waitRun('repair-storage-retry','failed');check(repairUploadFailed.nodes.plan.modelCompleted&&records('repair-storage-retry').length===2,'A corrected model result is retained when its generation checkpoint fails');repairUpload.failRepairCheckpoint=false;await app.engine.resume('repair-storage-retry',strongBundle);await waitRun('repair-storage-retry','succeeded');check(records('repair-storage-retry').length===2,'Repair storage recovery does not invoke the model again');

 const boundedRepair={adaptive:missingPlan};start('repair-bounded',boundedRepair,strongSeed,strongBundle);const repairBounded=await waitRun('repair-bounded','failed');check(records('repair-bounded').length===2&&repairBounded.nodes.plan.planningRejected&&repairBounded.nodes.plan.autoPlanRepairCount===1,'A second invalid plan stops instead of recursively calling models');boundedRepair.repairedAdaptive=directPlan;await app.engine.resume('repair-bounded',strongBundle);const manualCorrection=await waitRun('repair-bounded','succeeded');check(records('repair-bounded').length===3&&manualCorrection.nodes.plan.planRepair.generation===2&&manualCorrection.nodes.plan.attempts.length===2,'Explicit continuation reuses the latest rejected generation and retains both prior attempts');

 const originalRepairLog=app.engine.log.bind(app.engine);let reservedRepair;app.engine.log=(id,node,text,...rest)=>{originalRepairLog(id,node,text,...rest);if(id==='repair-reserved'&&text.startsWith('规划未通过')){reservedRepair=app.store.run(id).nodes.plan.conversationId;app.engine.close()}};start('repair-reserved',{adaptive:missingPlan,repairedAdaptive:directPlan},strongSeed,strongBundle);await waitFor(()=>app.engine.closed,'Controller stops after durably preparing repair');check(records('repair-reserved').length===1&&!!reservedRepair,'Prepared correction has not dispatched a second inference before the simulated restart');await idle();await open();const resumedCorrection=await waitRun('repair-reserved','succeeded');check(resumedCorrection.nodes.plan.conversationId===reservedRepair&&records('repair-reserved').length===2,'Restart uses the same reserved correction identity exactly once');

 const cancelRepairLog=app.engine.log.bind(app.engine);app.engine.log=(id,node,text,...rest)=>{cancelRepairLog(id,node,text,...rest);if(id==='repair-cancelled'&&text.startsWith('规划未通过'))app.engine.stop(id)};start('repair-cancelled',{adaptive:missingPlan,repairedAdaptive:directPlan},strongSeed,strongBundle);await waitRun('repair-cancelled','cancelled');check(records('repair-cancelled').length===1,'Cancellation after repair preparation prevents its inference');app.engine.log=cancelRepairLog;
 start('repair-old-run',{adaptive:missingPlan,repairedAdaptive:directPlan},strongSeed,strongBundle);const oldRepair=app.store.run('repair-old-run');delete oldRepair.planRepairVersion;app.store.saveRun(oldRepair);await waitRun('repair-old-run','failed');check(records('repair-old-run').length===1,'Historical runs without the frozen opt-in do not gain automatic inference');
 const shortBudget={...strongSeed,nodes:strongSeed.nodes.map(n=>n.id==='plan'?{...n,executionPolicy:{budgetSeconds:30}}:n)};start('repair-budget',{adaptive:missingPlan,repairedAdaptive:directPlan},shortBudget,{...strongBundle,nodeConfigs:{...strongBundle.nodeConfigs,plan:{...strongConfig,executionPolicy:{budgetSeconds:30}}}});await waitRun('repair-budget','failed');check(records('repair-budget').length===1,'Insufficient original execution budget prevents automatic correction');
 app.connectors.save('source-github',{expectedRevision:0,type:'github',label:'Repository source fixture',enabled:true,readOnly:true,config:{baseUrl:fixtureBase+'/github',allowPrivate:true,owner:'owner',auth:{type:'bearer'}},secrets:{token:'github-fixture-private'}});
 const repositoryFlow={...flow,repository:'owner/repo',branch:'main',githubConnectionId:'source-github'},sourceBefore={...repositoryFixture};start('repository-import',{},repositoryFlow);const imported=await waitRun('repository-import','succeeded'),sourceRoot=records('repository-import','plan')[0];
 check(sourceRoot.inherited.get('existing/source.js')?.toString()==='export const source = 1;\n'&&sourceRoot.inherited.get('existing/中文.bin')?.equals(Buffer.from([0,255,10,128])),'The first real native conversation receives repository source bytes and binary files');
 check(!sourceRoot.inherited.has('.canvas-collaboration/plan.json'),'Tracked stale collaboration metadata is excluded from the repository seed');
 check(imported.repositorySource.commitSha==='a'.repeat(40)&&imported.repositorySource.checkpoint?.sha256&&repositoryFixture.lookups-sourceBefore.lookups===1&&repositoryFixture.archives-sourceBefore.archives===1,'One resolved commit and bucket-backed repository download serve the whole DAG');
 const sourceMetadata=JSON.parse(sourceRoot.inherited.get('.canvas-collaboration/handoff.json'));check(sourceMetadata.repository.commitSha===imported.repositorySource.commitSha&&!JSON.stringify(sourceMetadata).includes('github-fixture-private')&&!sourceRoot.prompt.includes('github-fixture-private'),'Source provenance reaches the AI without GitHub credentials');
 const sourceFailure={failCheckpoint:'_canvas_repository_source'},beforeFailure={...repositoryFixture};start('repository-storage-retry',sourceFailure,repositoryFlow);const rejectedSource=await waitRun('repository-storage-retry','failed');check(records('repository-storage-retry').length===0&&rejectedSource.repositorySource.commitSha==='a'.repeat(40),'Repository storage failure blocks every inference after freezing the commit');
 sourceFailure.failCheckpoint=null;repositoryFixture.sha='b'.repeat(40);await app.engine.resume('repository-storage-retry',bundle);await waitRun('repository-storage-retry','succeeded');check(repositoryFixture.lookups-beforeFailure.lookups===1&&repositoryFixture.archives-beforeFailure.archives===1,'Storage retry keeps the frozen source even when the branch advances and does not download again');repositoryFixture.sha='a'.repeat(40);
 const repositoryRoots={...rootOnlyFlow,repository:'owner/repo',branch:'main',githubConnectionId:'source-github'},rootPlan={hold:new Set(['a','b']),repositoryDelete:true},beforeRoots={...repositoryFixture};start('repository-roots',rootPlan,repositoryRoots);await runningBranches('repository-roots');const sourceCheckpoint=app.store.run('repository-roots').repositorySource.checkpoint;
 await idle();await rm(join(directory,'repositories','repository-roots'),{recursive:true,force:true});await rm(join(directory,'checkpoints','repository-roots','_canvas_repository_source.tar.gz'),{force:true});await open();await runningBranches('repository-roots');rootPlan.hold.clear();await waitRun('repository-roots','succeeded');const repositoryRootFiles=await request('/runs/repository-roots/files');
 check(!repositoryRootFiles.items.some(f=>f.path==='existing/delete.txt')&&repositoryRootFiles.items.some(f=>f.path==='existing/source.js'),'Independent roots use the repository common base so an unchanged sibling cannot resurrect a deleted source file');
 check(repositoryFixture.archives-beforeRoots.archives===1&&repositoryFixture.gets>beforeRoots.gets&&records('repository-roots').length===2,'Restart restores the verified source from S3 without another GitHub download or AI call');

 // Incremental development inherits the immutable completed tree, including
 // deletions across independent roots. The repository remains a delivery target.
 const sourceFlow={...flow,baseRunId:'repository-roots'};
 for(const baseRunId of ['',null,3,'../bad'])assert.throws(()=>app.engine.enqueue({id:'bad-id',projectId:'repository-roots',workflow:{...sourceFlow,baseRunId}},bundle),/标识/);
 const saveRun=app.store.saveRun.bind(app.store);app.store.saveRun=(run,...args)=>{if(run.id==='atomic-source'&&run.artifactSource)throw Error('fixture source persistence failure');return saveRun(run,...args)};
 assert.throws(()=>app.engine.enqueue({id:'atomic-source',projectId:'repository-roots',workflow:sourceFlow},bundle),/persistence failure/);app.store.saveRun=saveRun;
 check(!app.store.run('atomic-source'),'Source pinning and run creation roll back together before any scheduler can see a partial run');
 const editFlow={...rootOnlyFlow,nodes:rootOnlyFlow.nodes.filter(n=>n.id!=='b'),edges:[['start','a'],['a','end']],baseRunId:'repository-roots',repository:'owner/repo',branch:'changed-main',githubConnectionId:'missing-connection'};
 const baseBefore=records('repository-roots').length,githubBefore={...repositoryFixture};
 plans.set('incremental-edit',{});const edit=app.engine.enqueue({id:'incremental-edit',projectId:'repository-roots',workflow:editFlow},bundle);
 check(edit.artifactSource.sourceRunId==='repository-roots'&&edit.artifactSource.parents.length===2,'Enqueue freezes the completed source branches and original baseline');
 const editDone=await waitRun('incremental-edit','succeeded'),editor=records('incremental-edit','a')[0];
 check(!editor.inherited.has('existing/delete.txt')&&editor.inherited.get('existing/source.js')?.toString()==='export const source = 1;\n','New development preserves merged deletion semantics and existing source');
 check(editor.inherited.has('frontend/a.txt')&&editor.inherited.has('backend/b.txt')&&editor.inherited.get('existing/中文.bin')?.equals(Buffer.from([0,255,10,128])),'Every branch and binary file arrives in the incremental workspace');
 check(!editor.inherited.has('.canvas-collaboration/plan.json')&&!editor.inherited.has('.canvas-collaboration/runtime-selection.json'),'Old coordination and model receipts never enter the new task');
 check(editor.prompt.includes('repository-roots')&&editor.prompt.includes('增量需求')&&!editor.prompt.includes('undefined'),'Incremental prompt identifies the verified source and new responsibility');
 const inheritedReport=JSON.parse(editor.inherited.get('.canvas-collaboration/handoff.json'));
 check(inheritedReport.sourceRun.id==='repository-roots'&&inheritedReport.sourceRun.sha256===editDone.artifactSource.archiveSha256&&editDone.artifactSource.checkpoint.sha256===editDone.artifactSource.archiveSha256,'New input provenance and its bucket checkpoint share the normalized SHA');
 check(records('repository-roots').length===baseBefore&&repositoryFixture.lookups===githubBefore.lookups&&repositoryFixture.archives===githubBefore.archives,'Incremental work neither reruns old AI nor fetches a moving repository');
 const incrementalRetryPlan={failCheckpoint:'_canvas_previous_run_source'};plans.set('incremental-retry',incrementalRetryPlan);app.engine.enqueue({id:'incremental-retry',projectId:'repository-roots',workflow:editFlow},bundle);const incrementalFailed=await waitRun('incremental-retry','failed');
 check(records('incremental-retry').length===0&&incrementalFailed.artifactSource.status==='prepared','An unpersisted incremental baseline blocks new inference');
 const pinnedHash=incrementalFailed.artifactSource.archiveSha256,oldSource=app.store.run('repository-roots');
 app.store.saveRun({...oldSource,status:'failed'});incrementalRetryPlan.failCheckpoint=null;
 await idle();await open();await app.engine.resume('incremental-retry',bundle);const incrementalDone=await waitRun('incremental-retry','succeeded');
 check(incrementalDone.artifactSource.archiveSha256===pinnedHash&&records('incremental-retry').length===1&&records('repository-roots').length===baseBefore,'Restart retries only storage using pinned source even if its mutable source row changes');app.store.saveRun(oldSource);
 const restoredSource=await app.engine.runSource.get(app.store.run('incremental-retry'));await (await import('node:fs/promises')).writeFile(restoredSource.path,'tampered local cache');
 const restoredAgain=await app.engine.runSource.get(app.store.run('incremental-retry'));check(createHash('sha256').update(await (await import('node:fs/promises')).readFile(restoredAgain.path)).digest('hex')===pinnedHash,'Ready baselines restore from the verified bucket rather than trusting changed local bytes');

 const sourceStopGate=gate('_canvas_previous_run_source');plans.set('incremental-stop',{checkpointGate:sourceStopGate});app.engine.enqueue({id:'incremental-stop',projectId:'repository-roots',workflow:editFlow},bundle);await waitFor(()=>sourceStopGate.entered,'Incremental checkpoint upload starts');
 await request('/runs/incremental-stop/stop','POST',{});sourceStopGate.release();await waitRun('incremental-stop','cancelled');check(records('incremental-stop').length===0,'Stop during source storage prevents every new model request');
 const invalidSources=['missing','parallel-stop','parallel-files'];
 for(const baseRunId of invalidSources)assert.throws(()=>app.engine.enqueue({id:'invalid-'+baseRunId,projectId:'repository-roots',workflow:{...editFlow,baseRunId}},bundle),/本项目|成功交付/);
 assert.throws(()=>app.engine.enqueue({id:'self-source',projectId:'repository-roots',workflow:{...editFlow,baseRunId:'self-source'}},bundle),/自身/);
 check(!app.store.run('self-source')&&!app.store.run('invalid-missing'),'Invalid sources create no run or model request');
 const savedSetting=app.store.setting('s3');app.store.setSetting('s3',{...savedSetting,prefix:'different/'});await assert.rejects(()=>app.engine.runSource.get(app.store.run('incremental-retry')),/存储配置/);app.store.setSetting('s3',savedSetting);
 check(fixtureErrors.length===0,'All native and S3 protocol requests were valid');
 console.log(`Passed ${checks} parallel DAG, isolated workspace, common-ancestor merge, explicit conflict resolution, checkpoint barriers, binary handoff, branch/checkpoint retry, run/global concurrency limits, all-branch stop and controller restart checks.`);
 // Optional full HTTP/SQLite/native-files/signed-S3 fixture comparison. The
 // historical Engine is loaded unchanged; controlled model delays are not real AI.
 if(process.env.CANVAS_SCHEDULER_BASELINE){
  const {Engine:Before}=await import(pathToFileURL(join(resolve(process.env.CANVAS_SCHEDULER_BASELINE),'server/engine.mjs'))),current=Object.getPrototypeOf(app.engine),samples={};
  const ids=['plan',...fourBranches],benchmarkFlow={...wideFlow,maxParallelNodes:1,nodes:wideFlow.nodes.filter(n=>n.id!=='join'),edges:[['start','plan'],...fourBranches.map(id=>['plan',id]),...fourBranches.map(id=>[id,'end'])]};
  for(const [version,prototype] of [['before',Before.prototype],['after',current]]){
   assert.equal(app.engine.active.size,0);Object.setPrototypeOf(app.engine,prototype);const started=performance.now(),runIds=Array.from({length:5},(_,i)=>'scheduler-bench-'+version+'-'+i);
   for(const id of runIds)start(id,{modelDelayMs:80,checkpointDelayMs:300,capacityGroup:'bench-'+version},benchmarkFlow);
   const runs=await Promise.all(runIds.map(id=>waitRun(id,'succeeded')));
   const elapsedMs=Math.round(performance.now()-started);
   for(const run of runs){assert.equal(records(run.id).length,5);for(const node of Object.values(run.nodes))assert(node.outputReady&&node.checkpoint?.sha256);const files=await request('/runs/'+run.id+'/files');for(const file of ['shared.txt','frontend/a.txt','backend/b.txt','branch-c.txt','branch-d.txt','assets/binary.bin'])assert(files.items.some(f=>f.path===file));}
   samples[version]={elapsedMs,modelCalls:runs.length*ids.length,completedRuns:runs.length,observedPeakModels:peaks.get('bench-'+version)};
  }
  Object.setPrototypeOf(app.engine,current);const report={scope:'Complete five-run development scheduler with actual native-file HTTP and signed-S3 fixtures; model responses controlled at 80ms, stage archive PUT delayed 300ms',samples,speedFactor:Math.round(samples.before.elapsedMs/samples.after.elapsedMs*100)/100,wholeRealTaskSpeedupProven:false};
  if(process.env.CANVAS_SCHEDULER_REPORT)await writeFile(process.env.CANVAS_SCHEDULER_REPORT,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
 }
}finally{
 for(const plan of plans.values())plan.checkpointGate?.release();
 await idle();await new Promise(resolve=>fixture.close(resolve));await rm(directory,{recursive:true,force:true});
}
