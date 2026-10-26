import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {archiveOperation,mergeArchives,validateMerge} from '../server/collaboration.mjs';
import {Engine} from '../server/engine.mjs';

// Files and HTTP responses are fixtures only: no models, production servers or buckets.
const execute=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'canvas-collaboration-'));
let checks=0,serial=0,server,engine;
const check=(value,message)=>{assert.ok(value,message);checks++};
const digest=text=>createHash('sha256').update(text).digest('hex');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const packScript=`import sys,json,tarfile,io
spec=json.loads(sys.argv[2])
with tarfile.open(sys.argv[1],'w:gz') as tar:
 for item in spec:
  entry=tarfile.TarInfo(item['path'])
  if item.get('symlink'):
   entry.type=tarfile.SYMTYPE;entry.linkname=item['symlink'];tar.addfile(entry)
  else:
   data=item.get('text','').encode();entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
`;
async function archive(files,entries){
 const path=join(directory,'fixture-'+(++serial)+'.tar.gz');
 await execute('python3',['-c',packScript,path,JSON.stringify(entries||Object.entries(files).map(([path,text])=>({path:'run/'+path,text})))]);
 return path;
}
async function contents(path){
 const result=await execute('python3',['-c',"import sys,tarfile,json\nwith tarfile.open(sys.argv[1],'r:gz') as t: print(json.dumps({m.name:t.extractfile(m).read().decode() for m in t if m.isfile()}))",path]);
 return JSON.parse(result.stdout);
}
async function merge(parents,base){
 return mergeArchives({runId:'run',nodeId:'join-'+(++serial),directory,parents:await Promise.all(parents.map(async(files,i)=>({id:'parent-'+i,archive:await archive(files)}))),...(base?{base:await archive(base),baseId:'base'}:{})});
}
async function waitFor(predicate,message){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){if(predicate())return;await sleep(10)}
 throw Error('Timed out: '+message);
}

try{
 const selection={requestId:'request-one',model:'strong',effort:'medium'},receipt={...selection,modelApplied:true,effortApplied:true},usage={schemaVersion:1,...selection,scope:'acp-prompts-including-tools',completedPrompts:1,elapsedMs:2000,stopReason:'end_turn',tokens:{outputTokens:100,inputTokens:'private-secret'},privateField:'private-secret'};
 const telemetry=await archive({'.canvas-collaboration/runtime-selection.json':JSON.stringify(receipt),'.canvas-collaboration/runtime-usage.json':JSON.stringify(usage)}),usageValidation=await validateMerge(telemetry,'run',{selection});check(usageValidation.modelUsage.tokens.outputTokens===100,'Bound token usage is returned from verified snapshot');check(usageValidation.modelUsage.tokens.inputTokens===null&&!JSON.stringify(usageValidation).includes('private-secret'),'Telemetry returns only valid numeric whitelist fields');
 for(const text of ['{bad',JSON.stringify({...usage,requestId:'wrong'}),JSON.stringify({...usage,elapsedMs:-1})]){const bad=await archive({'.canvas-collaboration/runtime-selection.json':JSON.stringify(receipt),'.canvas-collaboration/runtime-usage.json':text});check((await validateMerge(bad,'run',{selection})).modelUsage===null,'Optional invalid telemetry cannot invalidate good artifacts')}
 const originals={'a':'file at a','a%2Fb':'literal percent file','a/b':'nested file','a%2Fb/c':'nested percent file'};
 const collision=await merge([{'a':originals.a,'a%2Fb':originals['a%2Fb']},{'a/b':originals['a/b'],'a%2Fb/c':originals['a%2Fb/c']}]);
 const collisionFiles=await contents(collision.path),variantPaths=collision.report.conflicts.map(c=>c.variants[0].path);
 check(collision.report.conflicts.length===4,'Every file/directory collision is reported');
 check(new Set(variantPaths).size===4,'Slash and percent spellings cannot share a preserved variant path');
 for(const conflict of collision.report.conflicts){
  const variant=conflict.variants[0];
  check(collisionFiles['run/'+variant.path]===originals[conflict.path],'Each structural variant retains its exact contents: '+conflict.path);
  check(digest(collisionFiles['run/'+variant.path])===variant.sha256,'Structural variant checksum matches its stored bytes');
 }

 const deletion=await merge([{}, {'conflict.txt':'modified'}],{'conflict.txt':'baseline'}),deletionFiles=await contents(deletion.path),conflict=deletion.report.conflicts[0];
 check(deletion.report.conflicts.length===1&&conflict.path==='conflict.txt','Deletion versus modification requires an explicit resolution');
 check(!Object.hasOwn(deletionFiles,'run/conflict.txt'),'Deletion conflict does not silently choose a winner');
 check(conflict.variants[0].deleted&&conflict.variants[0].sha256===null&&conflict.variants[0].path===null,'Deleted branch is represented explicitly');
 check(deletionFiles['run/'+conflict.variants[1].path]==='modified','Modified branch bytes remain available');
 check(deletionFiles['run/.canvas-collaboration/base/conflict.txt']==='baseline','Conflict retains common ancestor bytes');
 await assert.rejects(validateMerge(deletion.path,'run',deletion.report),/resolutions.json/);checks++;
 const resolved={...Object.fromEntries(Object.entries(deletionFiles).map(([path,text])=>[path.slice(4),text])),'conflict.txt':'integrated','.canvas-collaboration/resolutions.json':JSON.stringify({resolutions:{'conflict.txt':{source:'custom',sha256:digest('integrated'),reason:'Preserved the modified branch after reviewing the deletion'}}})};
 const validated=await validateMerge(await archive(resolved),'run',deletion.report);
 check(validated.ok&&validated.conflictsResolved===1,'An explicit correctly hashed resolution passes validation');
 resolved['conflict.txt']='changed after resolution';
 await assert.rejects(validateMerge(await archive(resolved),'run',deletion.report),/checksum mismatch/);checks++;

 const identical=await merge([{'same.txt':'same edit'},{'same.txt':'same edit'}],{'same.txt':'old'});
 check(!identical.report.conflicts.length,'Identical edits on separate branches are not conflicts');
 check((await contents(identical.path))['run/same.txt']==='same edit','Identical edits retain the shared new contents');
 const deleteUnchanged=await merge([{}, {'gone.txt':'old'}],{'gone.txt':'old'});
 check(!deleteUnchanged.report.conflicts.length&&!Object.hasOwn(await contents(deleteUnchanged.path),'run/gone.txt'),'An unchanged sibling cannot restore a deleted file');

 for(const [name,entries] of [
  ['absolute',[{path:'/run/escape',text:'bad'}]],
  ['traversal',[{path:'run/../escape',text:'bad'}]],
  ['symlink',[{path:'run/link',symlink:'/etc/passwd'}]],
  ['duplicate',[{path:'run/a',text:'first'},{path:'run/a',text:'second'}]],
  ['foreign root',[{path:'different/a',text:'bad'}]],
 ]){
  const unsafe=await archive({},entries);
  await assert.rejects(archiveOperation('normalize',unsafe,['run',join(directory,'unsafe-'+(++serial)+'.tar.gz'),'run']),/协作文件检查失败/);checks++;
 }
 const truncated=join(directory,'truncated.tar.gz');await writeFile(truncated,'not a gzip archive');
 await assert.rejects(archiveOperation('normalize',truncated,['run',join(directory,'truncated-out.tar.gz'),'run']),/协作文件检查失败/);checks++;

 const backend=new Map(),requests=[];
 server=http.createServer((request,response)=>{
  const parts=request.url.split('/').filter(Boolean),record=backend.get(parts[2]);requests.push({method:request.method,path:request.url});
  const json=(data,status=200)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(data))};
  if(!record)return json({error:'unexpected fixture conversation'},404);
  if(request.method==='GET'){
   if(!record.recover){record.lookupFailures++;return json({error:'transient gateway failure'},502)}
   if(record.status==='paused')record.pauseReads++;
   return json({id:parts[2],execution_status:record.status});
  }
  if(parts[3]==='interrupt'){record.interrupts++;record.status='paused';return json({success:true})}
  return json({error:'unexpected fixture operation'},400);
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 for(const initialStatus of ['running','failed']){
  const conversationId='recover-'+initialStatus,record={recover:false,lookupFailures:0,interrupts:0,pauseReads:0,status:'running'};backend.set(conversationId,record);
  let saved={id:'stop-'+initialStatus,projectId:'fixture',status:'stopping',schedulerVersion:2,cancelRequested:true,order:['a'],maxParallelNodes:5,nodes:{a:{id:'a',name:'A',status:initialStatus,conversationId,submittedAt:new Date().toISOString(),handle:null,dependencies:[],outputReady:false}}};
  const store={run:()=>structuredClone(saved),saveRun:run=>(saved=structuredClone(run),structuredClone(saved)),config:()=>({mode:'remote',baseUrl:'http://127.0.0.1:'+server.address().port,apiKey:'fixture-only'}),addEvent:()=>{}};
  engine=new Engine(store,{pollMs:10});
  const completion=engine.executeDag(saved.id);
  try{
   await waitFor(()=>record.lookupFailures>=2,'repeated stop lookup failures');
   check(saved.status==='stopping'&&!saved.nodes.a.stopConfirmed,'A failed lookup cannot declare cancellation: '+initialStatus);
   check(record.interrupts===0,'No stop confirmation is fabricated before the backend recovers');
   record.recover=true;await Promise.race([completion,sleep(5000).then(()=>{throw Error('Stop did not recover')})]);
   check(saved.status==='cancelled'&&saved.nodes.a.stopConfirmed,'Cancellation waits for confirmed recovery: '+initialStatus);
   check(record.interrupts>0&&record.pauseReads>=2,'Recovered backend receives interrupt and repeated confirmation');
   check(!requests.some(r=>r.method==='POST'&&r.path==='/api/conversations'),'Stop recovery never creates another model conversation');
  }finally{engine.close();await completion;engine=null}
 }
 console.log(`Passed ${checks} collaboration checks: collision preservation, deletion/modification resolution, identical edits, unsafe archives and stop lookup recovery from 502.`);
}finally{
 engine?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});
}
