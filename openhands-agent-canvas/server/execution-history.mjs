// Workload observations inform the strongest planner; they do not rank quality
// or force model/depth choices. Missing usage is never reported as zero tokens.
export function executionHistory(store,team){
 const groups=new Map(),seen=new Set();
 for(const row of store.db.prepare("SELECT payload FROM runs WHERE status IN ('succeeded','failed','cancelled') ORDER BY created_at DESC LIMIT 50").iterate()){
  const run=JSON.parse(row.payload);
  for(const node of Object.values(run.nodes||{})){
   const usage=node.modelUsage,profile=team[node.profileId],model=node.modelRequested,role=node.id===run.adaptivePlan?.plannerId?(run.adaptivePlan.directDelivery?'direct-implementation':'planning'):node.phase||'implementation',complexity=node.modelSelection?.complexity||'unknown';
   if(profile?.policyModels?.some(m=>m.verified&&m.id===model)&&node.status==='paused'&&node.stopConfirmed&&node.selectionApplied&&node.submittedAt&&run.status==='cancelled'){
    const elapsed=Date.parse(run.finishedAt)-Date.parse(node.submittedAt),request=JSON.stringify([node.profileId,node.conversationId]),key=JSON.stringify([node.profileId,model,node.reasoningEffort,role,complexity]);if(!Number.isSafeInteger(elapsed)||elapsed<0||seen.has(request))continue;seen.add(request);
    if(!groups.has(key))groups.set(key,{profileId:node.profileId,model,effort:node.reasoningEffort,role,complexity,times:[],tokens:[],rates:[],failed:0,invalidPlans:0,interrupted:[]});
    groups.get(key).interrupted.push(elapsed);continue;
   }
   if(profile?.policyModels?.some(m=>m.verified&&m.id===model)&&node.status==='failed'&&!node.modelCompleted&&!run.cancelRequested&&node.submittedAt){
    const request=JSON.stringify([node.profileId,node.conversationId]),key=JSON.stringify([node.profileId,model,node.reasoningEffort,role,complexity]);if(seen.has(request))continue;seen.add(request);
    if(!groups.has(key))groups.set(key,{profileId:node.profileId,model,effort:node.reasoningEffort,role,complexity,times:[],tokens:[],rates:[],failed:0,invalidPlans:0,interrupted:[]});
    const group=groups.get(key);if(node.planningRejected)group.invalidPlans++;else group.failed++;continue;
   }
   if(!node.outputReady||node.status!=='succeeded'||!node.selectionApplied||!profile?.policyModels?.some(m=>m.verified&&m.id===model))continue;
   if(usage&&(usage.scope!=='acp-prompts-including-tools'||usage.stopReason!=='end_turn'||usage.requestId!==node.conversationId||usage.model!==model))continue;
   const start=Date.parse(node.submittedAt),end=Date.parse(node.finishedAt),elapsed=end-start;
   if(!Number.isSafeInteger(elapsed)||elapsed<0)continue;
   const request=JSON.stringify([node.profileId,node.conversationId]);if(seen.has(request))continue;seen.add(request);
   const key=JSON.stringify([node.profileId,model,node.reasoningEffort,role,complexity]);
   if(!groups.has(key))groups.set(key,{profileId:node.profileId,model,effort:node.reasoningEffort,role,complexity,times:[],tokens:[],rates:[],failed:0,invalidPlans:0,interrupted:[]});
   const group=groups.get(key);if(group.times.length>=20)continue;group.times.push(elapsed);
   const tokens=usage?.tokens?.outputTokens;if(Number.isSafeInteger(tokens)&&tokens>=0){group.tokens.push(tokens);if(elapsed>0)group.rates.push(tokens*1000/elapsed)}
  }
 }
 const median=values=>{if(!values.length)return null;values.sort((a,b)=>a-b);const i=Math.floor(values.length/2);return Math.round((values.length%2?values[i]:(values[i-1]+values[i])/2)*100)/100};
 return [...groups.values()].slice(0,15).map(g=>({profileId:g.profileId,model:g.model,effort:g.effort,role:g.role,complexity:g.complexity,samples:g.times.length,failedBeforeDeliverySamples:g.failed,invalidPlanSamples:g.invalidPlans,interruptedSamples:g.interrupted.length,observedWaitBeforeStopMsMedian:median(g.interrupted),observedStageMsMedian:median(g.times),outputTokensMedian:median(g.tokens),observedOutputTokensPerSecondMedian:median(g.rates)}));
}
