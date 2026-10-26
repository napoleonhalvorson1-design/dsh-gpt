import assert from 'node:assert/strict';import http from 'node:http';import {once} from 'node:events';
import {invokeAdapter} from '../server/connector-adapters.mjs';import {operations,validateInput} from '../server/connector-catalog.mjs';import {Connectors} from '../server/connectors.mjs';
const base='a'.repeat(40),head='b'.repeat(40),tree='c'.repeat(40),merged='d'.repeat(40),requests=[];let branchHead=base,ci='success',prHead=head,prBase='main',mergeCalls=0,commitCalls=0,failLease=false,partial=false;
const server=http.createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer fixture-github-token');const u=new URL(req.url,'http://fixture'),body=Buffer.concat(await Array.fromAsync(req)),input=body.length?JSON.parse(body):null;requests.push({method:req.method,path:u.pathname,input});const send=data=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data))},p=decodeURIComponent(u.pathname).replace('/repos/owner/repo','');
 if(p==='')return send({default_branch:'main'});
 if(p==='/git/ref/heads/main')return send({object:{sha:base}});
 if(p==='/git/ref/heads/codex/task')return send({object:{sha:branchHead}});
 if(p==='/git/refs'&&req.method==='POST'){assert.equal(input.ref,'refs/heads/codex/task');return send({ref:input.ref,object:{sha:base}})}
 if(p==='/git/commits/'+base)return send({tree:{sha:tree}});
 if(p==='/git/blobs'){assert.equal(input.encoding,'base64');return send({sha:tree})}
 if(p==='/git/trees'){assert.equal(input.base_tree,tree);assert.equal(input.tree.length,3);assert.equal(input.tree[0].mode,'100755');assert.equal(input.tree[2].sha,null);return send({sha:tree})}
 if(p==='/git/commits'&&req.method==='POST'){commitCalls++;assert.deepEqual(input.parents,[base]);return send({sha:head})}
 if(p==='/git/refs/heads/codex/task'){assert.equal(input.force,false);branchHead=input.sha;return send({object:{sha:head}})}
 if(p==='/pulls'&&req.method==='GET')return send([]);
 if(p==='/pulls'&&req.method==='POST')return send({number:1,head:{sha:head},base:{ref:input.base}});
 if(p==='/pulls/1')return send({number:1,state:'open',draft:false,mergeable:true,head:{sha:prHead},base:{ref:prBase}});
 if(p.endsWith('/check-runs'))return send({total_count:partial?1001:1,check_runs:u.searchParams.get('page')==='1'?[{id:1,name:'canvas-ci',head_sha:prHead,status:ci==='pending'?'in_progress':'completed',conclusion:ci}]:[]});
 if(p.endsWith('/status'))return send({total_count:0,statuses:[],state:'pending'});
 if(p==='/actions/runs')return send({total_count:1,workflow_runs:[{id:1,workflow_id:10,event:'pull_request',head_sha:prHead,name:'Canvas CI',status:'completed',conclusion:ci}]});
 if(p==='/actions/workflows/ci.yml/dispatches'){assert.equal(input.ref,'codex/task');res.writeHead(204);res.end();return}
 if(p==='/pulls/1/merge'){mergeCalls++;assert.equal(input.sha,prHead);return send({merged:true,sha:merged})}
 throw Error('Unexpected GitHub fixture '+req.method+' '+p);
}catch(e){res.writeHead(500);res.end(e.message)}});server.listen(0,'127.0.0.1');await once(server,'listening');
const c={type:'github',config:{baseUrl:'http://127.0.0.1:'+server.address().port,allowPrivate:true,owner:'owner',baseBranch:'main',requiredChecks:['canvas-ci'],auth:{type:'bearer'}}},args={owner:'owner',repo:'repo'},call=(op,input={},secrets={token:'fixture-github-token'})=>{validateInput({...args,...input},operations(c).find(x=>x.id===op).inputSchema);return invokeAdapter(c,op,{...args,...input},{secrets,signal:AbortSignal.timeout(15000)})};
try{
 await call('create_branch',{branch:'codex/task'});const committed=await call('commit_files',{branch:'codex/task',expectedHeadSha:base,message:'Implement user request',files:[{path:'src/a.js',content:'export const a=1;\n',mode:'100755'},{path:'assets/data.bin',content:'AP8=',encoding:'base64'},{path:'obsolete.txt',delete:true}]});assert.equal(committed.data.headSha,head);assert.equal(branchHead,head);
 await assert.rejects(call('commit_files',{branch:'codex/task',expectedHeadSha:base,message:'stale',files:[{path:'a',content:'bad'}]}),/已更新/);assert.equal(commitCalls,1);
 await assert.rejects(call('commit_files',{branch:'main',expectedHeadSha:base,message:'bad',files:[{path:'a',content:'bad'}]}),/独立分支/);
 await assert.rejects(call('commit_files',{branch:'codex/task',expectedHeadSha:head,message:'unsafe',files:[{path:'../escape',content:'bad'}]}),/路径/);
 await call('create_pull_request',{head:'codex/task',title:'Implement request'});const status=await call('ci_status',{number:1,expectedHeadSha:head});assert(status.data.readyForApproval);assert.equal(status.data.canMerge,false);
 for(const value of ['failure','pending','cancelled','skipped']){ci=value;await assert.rejects(call('merge_pull_request',{number:1,expectedHeadSha:head,approvedHeadSha:head}),/尚不可合并/)}ci='success';partial=true;await assert.rejects(call('merge_pull_request',{number:1,expectedHeadSha:head,approvedHeadSha:head}),/尚不可合并/);partial=false;
 await assert.rejects(call('merge_pull_request',{number:1,expectedHeadSha:head,approvedHeadSha:base}),/尚不可合并/);prHead=base;await assert.rejects(call('merge_pull_request',{number:1,expectedHeadSha:head,approvedHeadSha:head}),/已变化/);prHead=head;prBase='other';await assert.rejects(call('merge_pull_request',{number:1,expectedHeadSha:head,approvedHeadSha:head}),/目标分支/);prBase='main';assert.equal(mergeCalls,0);
 await call('dispatch_workflow',{workflow:'ci.yml',ref:'codex/task'});const result=await call('merge_pull_request',{number:1,expectedHeadSha:head,approvedHeadSha:head});assert.equal(result.data.merged,true);assert.equal(result.data.ciVerified,true);assert.equal(mergeCalls,1);
 const count=requests.length;await assert.rejects(call('create_branch',{branch:'codex/task'},{}),/凭据/);assert.equal(requests.length,count);await assert.rejects(invokeAdapter(c,'repo',{owner:'other',repo:'repo'},{secrets:{token:'x'}}),/owner/);assert.equal(requests.length,count);
 assert.throws(()=>Connectors.prototype.savePipeline.call({pipeline:()=>null,connection:()=>c,store:{db:{prepare:()=>({get:()=>({n:0})})}}},'auto-merge',{expectedRevision:0,steps:[{id:'merge',connectionId:'github',operation:'merge_pull_request',input:{}}]}),/单独批准/);
 console.log('Passed authenticated branch → atomic text/binary/delete commit → PR → CI → separate approved merge; stale head, failed/pending/missing CI, target branch, credential/owner isolation and automatic pipeline rejection.');
}finally{server.closeAllConnections();await new Promise(r=>server.close(r))}
