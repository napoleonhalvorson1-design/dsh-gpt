import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Store} from '../server/store.mjs';
import {listFiles,readFileResult,downloadFileResult} from '../server/files.mjs';
const root=await mkdtemp(join(tmpdir(),'canvas-files-')),id='test-run',store=new Store(join(root,'db.sqlite'),'test-only-key');
try{const folder=join(root,id);await mkdir(folder);await writeFile(join(folder,'index.html'),'<h1>中文预览</h1>');await writeFile(join(folder,'README.md'),'test');await writeFile(join(folder,'图片.bin'),Buffer.from([0,255,1,254]));await mkdir(join(root,'artifacts'));execFileSync('tar',['-czf',join(root,'artifacts',id+'.tar.gz'),'-C',root,id]);store.createRun({id,projectId:'p',title:'test',status:'succeeded',nodes:{},order:[]},{mode:'remote'});const files=await listFiles(store,id,root);assert.equal(files.items.length,3);const file=await readFileResult(store,id,root,'index.html');assert(file.html&&file.content.includes('中文预览'));await assert.rejects(()=>readFileResult(store,id,root,'../etc/passwd'));await assert.rejects(()=>readFileResult(store,id,root,'/etc/passwd'));await assert.rejects(()=>readFileResult(store,id,root,'--checkpoint-action=exec=x'));await assert.rejects(()=>readFileResult(store,id,root,'missing.txt'));assert.deepEqual((await downloadFileResult(store,id,root,'图片.bin')).content,Buffer.from([0,255,1,254]));await assert.rejects(()=>downloadFileResult(store,id,root,'../etc/passwd'));console.log('Passed 9 artifact listing, text preview, path traversal, absolute path, argument injection and missing-file checks.')}finally{store.close();await rm(root,{recursive:true,force:true})}
