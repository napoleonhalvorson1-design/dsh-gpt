import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {Storage} from '../server/storage.mjs';

const directory=await mkdtemp(join(tmpdir(),'canvas-upload-')),store=new Store(join(directory,'db.sqlite'),'fixture'),body=Buffer.from('immutable binary\0\xff'.repeat(12000)),path=join(directory,'snapshot.tar.gz');
await writeFile(path,body);store.setSetting('s3',{enabled:true,endpoint:'https://s3.example.com',bucket:'fixture',region:'us-west',prefix:'canvas/',accessKeyId:'fake',secretAccessKey:'fake'});
const storages=[],uploads=[],failure=(status,code)=>Object.assign(new Error('fixture'),{$metadata:{httpStatusCode:status},code});
let policy=()=>null;
function storage(){const s=new Storage(store,{directory,intervalMs:9999999,environment:{}});storages.push(s);s.client=()=>({destroy(){},async send(command){const i=command.input;let bytes;if(typeof i.Body==='string')bytes=Buffer.from(i.Body);else if(Buffer.isBuffer(i.Body))bytes=i.Body;else{const chunks=[];for await(const chunk of i.Body)chunks.push(chunk);bytes=Buffer.concat(chunks)}uploads.push({key:i.Key,bytes});const error=policy(i.Key);if(error)throw error;return {$metadata:{httpStatusCode:200}}}});return s}
try{
 const s=storage();let attempts=0;policy=()=>++attempts===1?failure(503):null;
 await s.putFile('retry.tar.gz',path,{kind:'artifact',id:'run',size:body.length});assert.equal(attempts,2);assert(uploads.slice(-2).every(u=>u.bytes.equals(body)),'Every attempt must reopen the complete binary source');
 attempts=0;policy=()=>{attempts++;return failure(403)};
 await assert.rejects(()=>s.putFile('denied.tar.gz',path,{kind:'artifact',id:'run',size:body.length}));assert.equal(attempts,1);assert.equal(store.objectInfo('canvas/denied.tar.gz'),undefined);
 const run={id:'receipt-run'},node={id:'build',status:'succeeded',conversationId:'conversation-one',output:'delivered'};
 policy=key=>key.endsWith('/workspace.tar.gz')?failure(403):null;
 await assert.rejects(()=>s.checkpoint(run,node,{mode:'remote'},{archivePath:path}),/不会重复执行/);
 const manifestKey='canvas/runs/receipt-run/stages/build/manifest.json',manifestWrites=()=>uploads.filter(u=>u.key===manifestKey).length;
 assert.equal(manifestWrites(),1);assert.equal(store.setting('checkpoint:receipt-run:build'),null);
 // A new Storage instance reads durable part receipts after a controller restart.
 policy=()=>null;const restarted=storage();const cp=await restarted.checkpoint(run,node,{mode:'remote'},{archivePath:path});
 assert.equal(manifestWrites(),1,'Retry must not upload an already confirmed identical manifest');assert(cp.sha256);assert(store.objectInfo(cp.key));
 const before=uploads.length;await restarted.checkpoint(run,node,{mode:'remote'},{archivePath:path});assert.equal(uploads.length,before,'Completed barriers remain idempotent');
 await restarted.checkpoint(run,{...node,conversationId:'conversation-two'},{mode:'remote'},{archivePath:path});assert.equal(manifestWrites(),2,'A new model conversation invalidates prior part receipts');
 const inputNode={...node,inputArchive:path,mergeReport:{parents:[],conflicts:[]}},inputKey='canvas/runs/input-run/inputs/build/handoff.json';
 policy=key=>key.includes('/inputs/')&&key.endsWith('workspace.tar.gz')?failure(403):null;
 await assert.rejects(()=>s.persistInput('input-run',inputNode));assert.equal(uploads.filter(u=>u.key===inputKey).length,1);
 policy=()=>null;await restarted.persistInput('input-run',inputNode);assert.equal(uploads.filter(u=>u.key===inputKey).length,1,'Input retry must reuse its confirmed handoff receipt');
 const inputCount=uploads.length;await restarted.persistInput('input-run',inputNode);assert.equal(uploads.length,inputCount,'Persisted input barriers are idempotent');
 console.log('Passed fresh-stream retry, denied-write fail-fast, durable partial upload receipts, restart reuse and conversation invalidation.');
}finally{for(const s of storages)s.close();store.close();await rm(directory,{recursive:true,force:true})}
