import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {transferWorkspace} from '../server/handoff.mjs';
const root=await mkdtemp(join(tmpdir(),'canvas-handoff-')),id='run-handoff',realFetch=globalThis.fetch;
try{await mkdir(join(root,'source',id),{recursive:true});await mkdir(join(root,'target',id),{recursive:true});await writeFile(join(root,'source',id,'PLAN.md'),'DEEPSEEK_PLAN_OK');await mkdir(join(root,'source',id,'sub'));await writeFile(join(root,'source',id,'sub','code.js'),'console.log(1)');execFileSync('tar',['-czf',join(root,'source.tgz'),'-C',join(root,'source'),id]);execFileSync('tar',['-czf',join(root,'target.tgz'),'-C',join(root,'target'),id]);const source={baseUrl:'https://shanghai.example.com',mode:'remote',apiKey:'source-private'},target={baseUrl:'https://silicon.example.com',mode:'remote',apiKey:'target-private'},uploaded=[];
 globalThis.fetch=async(url,options={})=>{if(url.includes('/archive?'))return new Response(await readFile(join(root,url.startsWith(source.baseUrl)?'source.tgz':'target.tgz')));if(url.includes('/upload?')){assert.equal(options.headers['X-Session-API-Key'],'target-private');uploaded.push({path:new URL(url).searchParams.get('path'),text:await options.body.get('file').text()});return new Response('{}')}throw Error('Unexpected request')};
 const result=await transferWorkspace({runId:id,nodeId:'next',source,target,sourceWorkspace:'/workspace/'+id,targetWorkspace:'/workspace/'+id,directory:root});assert.equal(result.files,2);assert.equal(uploaded.find(x=>x.path.endsWith('/PLAN.md')).text,'DEEPSEEK_PLAN_OK');assert(uploaded.some(x=>x.path.endsWith('/sub/code.js')));assert((await transferWorkspace({runId:id,nodeId:'same',source,target:source,sourceWorkspace:'/same',targetWorkspace:'/same',directory:root})).skipped);console.log('Passed cross-server archive validation, authenticated binary upload, nested file preservation and same-workspace skip checks.');
}finally{globalThis.fetch=realFetch;await rm(root,{recursive:true,force:true})}
