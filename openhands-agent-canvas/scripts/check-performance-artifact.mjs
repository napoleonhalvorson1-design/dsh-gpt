// Same acceptance contract for independently produced old/new engine artifacts.
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const {analyzeRun}=await import(pathToFileURL(join(resolve(process.argv[2]||'.'),'shared/run-performance.mjs')));
const run={createdAt:0,finishedAt:100,status:'succeeded',order:['a','b'],nodes:{
 a:{dependencies:[],status:'succeeded',startedAt:0,inputReadyAt:0,submittedAt:10,finishedAt:70,snapshotReadyAt:70,outputReadyAt:80},
 b:{dependencies:[],status:'succeeded',startedAt:0,inputReadyAt:0,submittedAt:40,finishedAt:90,snapshotReadyAt:90,outputReadyAt:100}}};
const before=structuredClone(run),actual=analyzeRun(run);
assert.deepEqual(run,before);assert.equal(actual.elapsedMs,100);assert.equal(actual.modelWallMs,80);assert.equal(actual.modelWorkMs,110);assert.equal(actual.observedPeakModels,2);
const legacy=analyzeRun({createdAt:0,finishedAt:100,status:'succeeded',nodes:{one:{status:'succeeded',startedAt:0,finishedAt:80}}});
assert.equal(legacy.modelWallMs,null,'Historical start time cannot stand in for a missing model submission time');
assert.equal(analyzeRun({createdAt:100,finishedAt:0,status:'failed',nodes:{}}).elapsedMs,null);
console.log('Shared artifact acceptance passed: overlap, real elapsed time, immutable input, unknown legacy model time and reversed time.');
