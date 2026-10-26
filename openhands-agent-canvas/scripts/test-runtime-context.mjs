import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {compileRuntimeContext,validateRuntimeContext} from '../server/runtime-context.mjs';
import {Profiles} from '../server/profiles.mjs';
import {compileAdaptivePlan,planningInstructions} from '../server/adaptive.mjs';
import {validateWorkflow} from '../server/engine.mjs';
import {compileExecutionPolicy} from '../server/execution-policy.mjs';
import {startConversation} from '../shared/openhands.mjs';
const example=JSON.parse(await readFile('config/ai-profiles.example.json','utf8'));
for(const entry of example.items){entry.runtimeContextVersion=1;entry.policyModels=entry.config.model==='acp:codex'?[{id:'gpt-6-astra',verified:true,efforts:['low','medium','high','xhigh']}]:entry.config.model==='acp:deepseek'?[{id:'["deepseek-official","deepseek-flash"]',verified:true,efforts:['max']}]:[{id:'opus',verified:true,efforts:['low','medium','high']}]}
const profiles=new Profiles(example.items,example.defaultId),seed=JSON.parse(await readFile('shared/five-ai-workflow.json','utf8')),bundle=profiles.compile({},seed),primary=bundle.nodeConfigs.plan;
for(const value of ['invalid',false,null,{},[]])assert.throws(()=>validateRuntimeContext(value));
assert.equal(compileRuntimeContext(primary,{},{}),primary,'Existing sessions inherit unchanged');
assert.equal(compileRuntimeContext(primary,{runtimeContext:'focused'}).runtimeContext,'focused');
assert.equal(compileRuntimeContext(primary,{runtimeContext:'focused'},{runtimeContext:'inherit'}).runtimeContext,'inherit','User project setting wins over AI stage proposal');
for(const candidate of [{...primary,runtimeContextVersion:0},{...primary,selection:null},{...primary,model:'acp:deepseek'},{...primary,mode:'cloud'}])assert.throws(()=>compileRuntimeContext(candidate,{runtimeContext:'focused'}),/未验证/);
assert.equal(profiles.list().items.find(p=>p.id==='codex-silicon').executionFeatures.runtimeContextModes[1],'focused');assert.deepEqual(profiles.list().items.find(p=>p.id==='deepseek-shanghai').executionFeatures.runtimeContextModes,['inherit']);
assert.equal(validateWorkflow({...seed,runtimeContext:'inherit'}).runtimeContext,'inherit');assert.throws(()=>validateWorkflow({...seed,runtimeContext:'bad'}));assert.throws(()=>validateWorkflow({...seed,nodes:seed.nodes.map(n=>n.id==='start'?{...n,runtimeContext:'focused'}:n)}));
const plan={schemaVersion:1,goal:'实现需求',decisions:'纯代码阶段精简，外部服务阶段继承',acceptanceCriteria:['实现功能'],maxParallelNodes:2,stages:[{id:'build',name:'实现',phase:'build',executionProfile:'codex-silicon',prompt:'完成代码',dependsOn:[],runtimeContext:'focused'},{id:'integrate',name:'外部服务集成',phase:'integrate',executionProfile:'codex-seoul',prompt:'连接授权服务',dependsOn:['build'],runtimeContext:'inherit'}]};
let compiled=compileAdaptivePlan(plan,{workflow:seed},bundle);assert.equal(compiled.nodeConfigs.build.runtimeContext,'focused');assert.equal(compiled.nodeConfigs.integrate.runtimeContext,'inherit');assert.equal(compiled.workflow.nodes.find(n=>n.id==='build').runtimeContext,'focused');assert.equal(bundle.nodeConfigs.plan.runtimeContext,undefined);
compiled=compileAdaptivePlan(plan,{workflow:{...seed,runtimeContext:'inherit'}},bundle);assert.equal(compiled.nodeConfigs.build.runtimeContext,'inherit');
assert(planningInstructions(bundle.teamProfiles,seed).includes('runtimeContext='));
const policy={budgetSeconds:300,fallbackProfile:'codex-seoul'},focused=compileRuntimeContext(primary,{runtimeContext:'focused'}),fallback=compileExecutionPolicy(focused,{executionPolicy:policy},seed,bundle.teamProfiles);assert.equal(fallback.fallbackConfig.runtimeContext,'focused');
let received=[];const server=http.createServer(async(req,res)=>{received.push(JSON.parse(Buffer.concat(await Array.fromAsync(req)).toString()));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'fixture',execution_status:'running'}))});server.listen(0,'127.0.0.1');await once(server,'listening');
try{
 const baseUrl='http://127.0.0.1:'+server.address().port,config={...focused,baseUrl};
 await startConversation(config,{conversationId:'focused',prompt:'Implement files'});let args=received[0].agent_settings.acp_args,index=args.indexOf('--context');assert(index>=0&&args[index+1]==='focused'&&index<args.indexOf('--'));assert.equal(args[args.indexOf('--')+1],primary.commands.codex);
 await startConversation({...config,runtimeContext:'inherit'},{conversationId:'inherit',prompt:'Use external plugins'});assert(!received[1].agent_settings.acp_args.includes('--context'),'Inherited/old policy scripts receive no new flag');
 await assert.rejects(()=>startConversation({...config,selection:null},{conversationId:'invalid',prompt:'x'}),/已验证模型/);assert.equal(received.length,2,'Unsupported modes are rejected before a native request');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
console.log('Passed per-stage scoped context: explicit inheritance, verified capabilities, planner choices, fallback, native request flags and no unsupported inference.');
