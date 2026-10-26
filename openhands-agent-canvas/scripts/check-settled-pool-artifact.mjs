// Common black-box contract for real before/after artifacts; no AI or network.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const directory=resolve(process.argv[2]||'.');
for(const file of ['shared/settled-pool.mjs','scripts/test-settled-pool.mjs','docs/settled-pool.md'])assert((await readFile(join(directory,file))).length>0);
const {settledPool}=await import(pathToFileURL(join(directory,'shared/settled-pool.mjs'))),flush=()=>new Promise(r=>setImmediate(r)),deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
const gates=Array.from({length:4},deferred),started=[],items=Object.freeze([10,20,30,40]),value={},error=new Error('actual worker error');
const task=settledPool(items,(item,index)=>{assert.equal(item,items[index]);started.push(index);return gates[index].promise},{concurrency:2});
assert.deepEqual(started,[0,1]);gates[1].resolve(value);await flush();assert.deepEqual(started,[0,1,2]);gates[0].reject(error);await flush();assert.deepEqual(started,[0,1,2,3]);gates[3].resolve(40);gates[2].resolve(30);const results=await task;assert.deepEqual(results.map(r=>r.status),['rejected','fulfilled','fulfilled','fulfilled']);assert.equal(results[0].reason,error);assert.equal(results[1].value,value);assert.deepEqual(items,[10,20,30,40]);
const controller=new AbortController(),pending=[deferred(),deferred()],calls=[];let settled=false;
const cancel=settledPool([0,1,2,3],(_,index,signal)=>{assert.equal(signal,controller.signal);calls.push(index);return pending[index].promise},{concurrency:2,signal:controller.signal}).then(x=>{settled=true;return x});controller.abort();pending[0].resolve(0);await flush();assert(!settled);assert.deepEqual(calls,[0,1]);pending[1].resolve(1);assert.deepEqual((await cancel).map(x=>x.status),['fulfilled','fulfilled','skipped','skipped']);
assert.deepEqual(await settledPool([],()=>{throw Error('must not run')}),[]);
let invalidCalls=0;const worker=()=>{invalidCalls++};for(const options of [{concurrency:0},{concurrency:33},{concurrency:1.2},{signal:{}},{signal:Object.create(AbortSignal.prototype)}])await assert.rejects(()=>settledPool([1],worker,options));assert.equal(invalidCalls,0);
const skipped=await settledPool([1,2],worker,{signal:controller.signal});assert(skipped.every(r=>r.status==='skipped'));assert.equal(invalidCalls,0);
console.log('Shared artifact contract passed: required files, bounded lazy dispatch, ordered identity-preserving settlements, isolated failure, cancellation/drain and preflight validation.');
