import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const node=(start,end,extra={})=>({dependencies:[],status:'succeeded',startedAt:start,inputReadyAt:start,submittedAt:start,finishedAt:end,snapshotReadyAt:end,outputReadyAt:end,...extra});
const record=(nodes,extra={})=>({createdAt:0,finishedAt:100,status:'succeeded',order:Object.keys(nodes),nodes,...extra});
const tests=[
 ['parallel union/work/peak',analyze=>{const r=analyze(record({a:node(10,60),b:node(40,90)}));assert.equal(r.elapsedMs,100);assert.equal(r.modelWallMs,80);assert.equal(r.modelWorkMs,100);assert.equal(r.observedPeakModels,2)}],
 ['half-open adjacent intervals',analyze=>{assert.equal(analyze(record({a:node(0,50),b:node(50,100)})).observedPeakModels,1)}],
 ['explicit live clock',analyze=>{const r=analyze(record({a:node(10,undefined,{status:'running',snapshotReadyAt:undefined,outputReadyAt:undefined})},{status:'running',finishedAt:undefined}),{now:70});assert.equal(r.elapsedMs,70);assert.equal(r.modelWallMs,60)}],
 ['history does not invent model start',analyze=>{assert.equal(analyze(record({a:{startedAt:10,finishedAt:80,status:'succeeded'}})).modelWallMs,null)}],
 ['invalid now remains unknown',analyze=>{assert.equal(analyze(record({a:node(10,undefined,{status:'running',snapshotReadyAt:undefined,outputReadyAt:undefined})},{status:'running',finishedAt:undefined}),{now:'invalid'}).modelWallMs,null)}],
 ['invalid calendar date remains unknown',analyze=>{const r=analyze(record({a:node(10,20)},{createdAt:'2026-02-30T00:00:00.000Z',finishedAt:'2026-03-03T00:00:00.000Z'}));assert.equal(r.elapsedMs,null)}],
 ['real zero remains zero',analyze=>{const r=analyze(record({a:node(0,0)},{finishedAt:0}));assert.equal(r.elapsedMs,0);assert.equal(r.modelWallMs,0);assert.equal(r.modelWorkMs,0);assert.equal(r.observedPeakModels,0)}],
 ['reversed time remains unknown',analyze=>{assert.equal(analyze(record({a:node(20,10)})).modelWallMs,null)}],
 ['cancelled open interval is not extended',analyze=>{assert.equal(analyze(record({a:{status:'cancelled',startedAt:10,submittedAt:20}},{status:'cancelled'}),{now:1000}).modelWallMs,null)}],
 ['private fields and immutable input',analyze=>{const input=record({a:Object.freeze(node(10,20))},{apiKey:'DO_NOT_COPY_PRIVATE',prompt:'DO_NOT_COPY_PROMPT'});Object.freeze(input.nodes);Object.freeze(input);const before=JSON.stringify(input),r=analyze(input);assert.equal(JSON.stringify(input),before);assert(!JSON.stringify(r).includes('DO_NOT_COPY'))}],
];
const results=[];
for(const path of process.argv.slice(2)){const {analyzeRun}=await import(pathToFileURL(path));const checks=[];for(const [name,test] of tests){try{test(analyzeRun);checks.push({name,passed:true})}catch(e){checks.push({name,passed:false,message:e.message.slice(0,200)})}}results.push({path,passed:checks.filter(x=>x.passed).length,total:checks.length,checks})}
console.log(JSON.stringify(results,null,2));
if(results.some(x=>x.passed!==x.total))process.exitCode=1;
