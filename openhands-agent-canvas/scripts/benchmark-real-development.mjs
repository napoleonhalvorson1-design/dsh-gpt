// Runs actual paid models. Deliberately excluded from npm test.
// Credentials stay in the environment and the protected SQLite configuration.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1]};
if(!args.includes('--allow-real-models')||!option('--source')||!option('--task')||!option('--id')||!option('--directory')){
 throw Error('Requires --allow-real-models --source SOURCE --task requirements.json --id UNIQUE_ID --directory PROTECTED_DIR [--environment-file PATH] [--storage-environment-file PATH]. Runs actual models; never invoke for upgrade checks.');
}
process.umask(0o077);
if(option('--environment-file'))process.loadEnvFile(option('--environment-file'));
if(option('--storage-environment-file'))process.loadEnvFile(option('--storage-environment-file'));
const source=resolve(option('--source')),directory=resolve(option('--directory')),id=option('--id');
if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('Invalid benchmark ID');
const input=JSON.parse(await readFile(option('--task'),'utf8'));
if(typeof input.task!=='string'||!input.task.trim())throw Error('Task text is required');
const env=process.env,profilesPath=env.CANVAS_AI_PROFILES_PATH;
if(!profilesPath||!env.CANVAS_CONTROL_ENCRYPTION_KEY)throw Error('Protected runtime profile/encryption configuration is required');
await mkdir(directory,{recursive:true,mode:0o700});
const {createControl}=await import(pathToFileURL(join(source,'server/http.mjs')));
const {Profiles}=await import(pathToFileURL(join(source,'server/profiles.mjs')));
const template=JSON.parse(await readFile(join(source,'shared/five-ai-workflow.json'),'utf8'));
const workflow={...template,title:input.title,task:input.task};
// Use the source version's real planner and prompts, with the same user request,
// automatic model mode, verified profile catalogue and strongest-planner policy.
const profiles=Profiles.fromFile(profilesPath),bundle=profiles.compile(null,workflow);
const app=createControl({database:join(directory,'canvas.sqlite'),apiKey:'isolated-benchmark',
 encryptionKey:env.CANVAS_CONTROL_ENCRYPTION_KEY,profiles,pollMs:3000,startEngine:false,storageIntervalMs:15000});
const prefix='openhands-canvas/performance/'+id+'/';
const existing=app.store.run(id);
if(!existing){
 if(!app.storage.status().hasCredentials)throw Error('Real S3 configuration is required before starting inference');
 app.storage.save({...app.storage.status(),enabled:true,prefix});
 app.store.putProject(id,workflow,0);
}
let last='';
try{
 if(!existing)app.engine.enqueue({id,projectId:id,workflow},bundle);
 app.engine.start();
 for(;;){
  const run=app.store.run(id),state=JSON.stringify({id,status:run.status,nodes:Object.values(run.nodes).map(n=>({id:n.id,status:n.status,model:n.modelUsed,effort:n.reasoningEffort,inputReady:!!n.inputReady,modelCompleted:!!n.modelCompleted,outputReady:!!n.outputReady}))});
  if(state!==last){console.log(state);last=state}
  if(['succeeded','failed','cancelled','awaiting_input'].includes(run.status)&&!app.engine.active.has(id)){
   const nodes=Object.values(run.nodes).map(n=>Object.fromEntries(['id','status','profileId','modelUsed','reasoningEffort','selectionApplied','startedAt','inputReadyAt','submittedAt','finishedAt','snapshotReadyAt','outputReadyAt','handoffMetrics'].filter(k=>n[k]!==undefined).map(k=>[k,n[k]])));
   const report={scope:'real model development, isolated controller, native files and real S3',id,source,
    taskSha256:createHash('sha256').update(input.task).digest('hex'),status:run.status,error:run.error,
    createdAt:run.createdAt,finishedAt:run.finishedAt||null,elapsedMs:run.finishedAt?Date.parse(run.finishedAt)-Date.parse(run.createdAt):null,
    adaptivePlan:run.adaptivePlan,nodes,storagePrefix:prefix,
    limitations:['One run does not establish a general speedup. Compare equal-quality artifacts and record all failures.','No CI or PR time is included in controller elapsedMs.']};
   await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report));
   if(run.status!=='succeeded')process.exitCode=1;
   break;
  }
  await sleep(1000);
 }
}finally{await app.close();app.store.close()}
