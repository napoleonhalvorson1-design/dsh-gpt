import {readFileSync} from 'node:fs';
const script=readFileSync(new URL('./dsh-trace.py',import.meta.url),'utf8'),active=new Map(),observed=new Map();
const number=v=>Number.isSafeInteger(v)&&v>=0?v:null;
const nullable=['activeStepMs','maxStepOutputTokens','maxBeforeToolMs','lastEventMs'];
function sanitized(value){
 if(value?.available!==true)return {available:false,reason:['binding-unavailable','binding-mismatch','unsupported-workspace','trace-not-found','ambiguous-trace','trace-limit','unsupported-trace'].includes(value?.reason)?value.reason:'trace-unavailable'};
 const raw=value.summary;if(!raw||!Array.isArray(raw.steps)||raw.steps.length>20)return {available:false,reason:'invalid-trace'};
 const summary={};for(const key of ['stepCount','meteredMessages','unmeteredMessages','knownToolMs']){summary[key]=number(raw[key]);if(summary[key]===null)return {available:false,reason:'invalid-trace'}}
 for(const key of nullable)summary[key]=number(raw[key]);
 summary.knownTokens=Object.fromEntries(['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens','totalTokens'].map(k=>[k,number(raw.knownTokens?.[k])]));
 summary.usageIsLowerBound=true;summary.timingIsLowerBound=true;summary.turnEnded=raw.turnEnded===true;
 summary.steps=raw.steps.map(row=>({...Object.fromEntries(['index','toolCalls','startMs','endMs','toolCallMs','toolResultMs','outputTokens','beforeToolMs','toolMs','durationMs'].map(k=>[k,number(row[k])])),tool:['none','multiple','bash','pwsh','read','write','edit','search','glob','grep','other'].includes(row.tool)?row.tool:'other'}));
 return {available:true,source:'dsh-v4-session',binding:'unique-workspace-and-request-receipt',traceReadComplete:value.traceReadComplete===true,observedAtMs:number(value.observedAtMs),summary};
}
export function traceObservations(team){return [...observed.values()].filter(o=>team[o.profileId]?.baseUrl===o.route&&team[o.profileId]?.policyModels?.some(m=>m.id===o.model&&m.verified===true)).slice(-5).map(({route,...value})=>value)}
export async function nativeTrace(run,nodeId,bundle,profiles){
 const configs=bundle.nodeConfigs||{},candidates=Object.values(run.nodes||{}).filter(n=>(configs[n.id]||bundle).model==='acp:deepseek');
 const node=nodeId?(Object.hasOwn(run.nodes||{},nodeId)?run.nodes[nodeId]:null):candidates.length===1?candidates[0]:null;
 if(!node)return {id:run.id,status:run.status,trace:{available:false,reason:nodeId?'node-not-found':'select-node'},nodes:candidates.map(n=>({id:n.id,name:n.name}))};
 const saved=configs[node.id]||bundle,profile=profiles.entries.get(node.profileId)?.config;
 const base={id:run.id,nodeId:node.id,status:run.status};
 if(saved.model!=='acp:deepseek'||profile?.nativeTrace?.version!==1||profile.baseUrl!==saved.baseUrl||profile.model!==saved.model||!node.workspace?.startsWith(saved.workspace.replace(/\/$/,'')+'/runs/'+run.id+'/'))return {...base,trace:{available:false,reason:'unsupported-profile'}};
 const selection=node.modelSelection;if(!selection?.locked||selection.effort!=='max')return {...base,trace:{available:false,reason:'binding-unavailable'}};
 const key=run.id+'/'+node.id+'/'+node.conversationId;if(active.has(key))return active.get(key);
 const task=(async()=>{try{
  const input=Buffer.from(JSON.stringify({root:profile.nativeTrace.root,workspace:node.workspace,requestId:node.conversationId,model:selection.model,effort:selection.effort})).toString('base64');
  const command="/usr/bin/python3 -I - "+input+" <<'CANVAS_DSH_TRACE'\n"+script+"\nCANVAS_DSH_TRACE";
  const response=await fetch(profile.baseUrl+'/api/bash/execute_bash_command',{method:'POST',headers:{'X-Session-API-Key':profile.apiKey,'Content-Type':'application/json'},body:JSON.stringify({command,timeout:10}),redirect:'manual',signal:AbortSignal.timeout(12000)});
  if(!response.ok)return {...base,trace:{available:false,reason:'trace-unavailable'}};
  const text=await response.text();if(text.length>65536)return {...base,trace:{available:false,reason:'trace-limit'}};const result=JSON.parse(text);
  const trace=result.exit_code===0?sanitized(JSON.parse(result.stdout)):{available:false,reason:'trace-unavailable'};
  if(trace.available&&trace.summary.meteredMessages){observed.delete(key);observed.set(key,{route:profile.baseUrl,profileId:node.profileId,model:selection.model,effort:selection.effort,runStatus:run.status,source:'dsh-v4-session',usageIsLowerBound:true,knownOutputTokens:trace.summary.knownTokens.outputTokens,maxStepOutputTokens:trace.summary.maxStepOutputTokens,maxBeforeToolMs:trace.summary.maxBeforeToolMs,observedAtMs:trace.observedAtMs});while(observed.size>64)observed.delete(observed.keys().next().value)}
  return {...base,trace};
 }catch{return {...base,trace:{available:false,reason:'trace-unavailable'}}}})();active.set(key,task);try{return await task}finally{active.delete(key)}
}
