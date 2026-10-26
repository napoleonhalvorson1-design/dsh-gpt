// Explicit capability preference over models already verified on the user's servers.
export const PLANNER_MODELS=['gpt-6-astra','gpt-6.1-sol','opus','gpt-6-sol','gpt-5.6-sol'];
export function selectPlanner(configs){
 const entries=Object.entries(configs).filter(([,c])=>c.mode==='remote');
 const location=id=>id==='codex-silicon'?0:id==='codex-seoul'?1:id==='codex-shanghai'?2:3;
 entries.sort(([a],[b])=>location(a)-location(b));
 for(const model of PLANNER_MODELS)for(const [id,config] of entries){const match=config.policyModels?.find(m=>m.id===model&&m.verified===true);if(match&&match.efforts?.length)return {profileId:id,model,modelLabel:match.label||model,config}}
 return null;
}
