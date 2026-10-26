import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {executionHistory} from '../server/execution-history.mjs';
const dir=await mkdtemp(join(tmpdir(),'canvas-history-')),store=new Store(join(dir,'db.sqlite'),'fixture');
const team={codex:{policyModels:[{id:'strong',verified:true},{id:'unknown',verified:false}]}},node={id:'build',status:'succeeded',outputReady:true,profileId:'codex',conversationId:'one',selectionApplied:true,reasoningEffort:'medium',submittedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:02Z',modelRequested:'strong',modelUsage:{scope:'acp-prompts-including-tools',stopReason:'end_turn',requestId:'one',model:'strong',effort:'medium',elapsedMs:2000,tokens:{outputTokens:100}}};
const add=(id,n,status='succeeded',extra={})=>store.createRun({id,projectId:'fixture',title:'fixture',status,nodes:{build:n},...extra},{});
try{
 add('valid',node);add('duplicate',node);add('second',{...node,conversationId:'two',finishedAt:'2026-01-01T00:00:04Z',modelUsage:{...node.modelUsage,requestId:'two',elapsedMs:4000,tokens:{outputTokens:300}}},'failed');
 add('incomplete',{...node,outputReady:false});add('mismatch',{...node,modelUsage:{...node.modelUsage,requestId:'wrong'}});
 add('unverified',{...node,modelRequested:'unknown',modelUsage:{...node.modelUsage,model:'unknown'}});
 const [g]=executionHistory(store,team);assert.equal(g.samples,2);assert.equal(g.observedStageMsMedian,3000);assert.equal(g.outputTokensMedian,200);assert.equal(g.observedOutputTokensPerSecondMedian,62.5);
 add('missing-tokens',{...node,conversationId:'three',finishedAt:'2026-01-01T00:00:00Z',modelUsage:{...node.modelUsage,requestId:'three',elapsedMs:0,tokens:{outputTokens:null}}});
 const [updated]=executionHistory(store,team);assert.equal(updated.samples,3);assert.equal(updated.outputTokensMedian,200);assert.equal(updated.observedOutputTokensPerSecondMedian,62.5);
 add('old-stage',{...node,conversationId:'old',modelUsage:null});assert.equal(executionHistory(store,team)[0].samples,4);
 add('failed-stage',{...node,status:'failed',outputReady:false,modelCompleted:false,conversationId:'failed',modelUsage:null},'failed');assert.equal(executionHistory(store,team)[0].failedBeforeDeliverySamples,1);
 add('interrupted',{...node,status:'paused',stopConfirmed:true,conversationId:'interrupted',modelUsage:null},'cancelled',{finishedAt:'2026-01-01T00:00:06Z'});const [censored]=executionHistory(store,team);assert.equal(censored.interruptedSamples,1);assert.equal(censored.observedWaitBeforeStopMsMedian,6000);assert.equal(censored.samples,4);
 add('separate-role',{...node,phase:'verify',conversationId:'verify',modelUsage:{...node.modelUsage,requestId:'verify'}});assert.equal(executionHistory(store,team).find(g=>g.role==='verify').samples,1,'Planning, implementation and verification observations must not be mixed');
 const interruptedAttempt={profileId:'codex',conversationId:'timed-out-planner',modelRequested:'strong',reasoningEffort:'medium',complexity:'standard',selectionApplied:true,stopConfirmed:true,submittedAt:node.submittedAt,stoppedAt:'2026-01-01T00:00:05Z'};
 add('fallback-planner',{...node,conversationId:'fallback-planner',modelUsage:null,modelSelection:{complexity:'standard'},attempts:[interruptedAttempt]},'succeeded',{adaptivePlan:{plannerId:'build',directDelivery:true}});
 const history=executionHistory(store,team),attemptGroup=history.find(g=>g.role==='planning'&&g.complexity==='standard'),deliveryGroup=history.find(g=>g.role==='direct-implementation');assert.equal(attemptGroup.interruptedSamples,1);assert.equal(attemptGroup.observedWaitBeforeStopMsMedian,5000);assert.equal(attemptGroup.samples,0);assert.equal(deliveryGroup.samples,1);assert.equal(deliveryGroup.interruptedSamples,0,'Stopped primary is never a successful direct-delivery observation');
 assert.deepEqual(executionHistory(store,{}),[]);
 console.log('Passed bound verified-model observations, completed snapshot filtering, duplicate request exclusion, partial-run samples and unknown token preservation.');
}finally{store.close();await rm(dir,{recursive:true,force:true})}
