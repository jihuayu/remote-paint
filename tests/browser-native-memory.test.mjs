import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {sampleBrowserNativeMemory,BROWSER_NATIVE_MEMORY_LIMITS} from './browser-native-memory.mjs';
const owner={pages:[{id:'primary',nonce:'persistent-page'}],workers:['persistent-worker']},first=[{id:2,type:'renderer'},{id:1,type:'browser'}],next=[{id:3,type:'renderer'},{id:1,type:'browser'}];
const missing=(fields={})=>Object.assign(new Error('actual batch failed'),{code:'NATIVE_MEMORY_OS_READ',nativeBatch:true,nativeStatus:2,errno:3,failedPid:2,receipt:{requestId:1},...fields});
const result=rows=>({processes:rows.map(p=>({pid:p.id,kind:p.type,rssBytes:p.id*1024})),sampling:{requestId:2,helperPid:9},scope:'Modeled native batch;not OS proof.'});
test('confirmed kernel disappearance retries one whole fresh census with the same lifetime and retains both attempts',async()=>{
 const inventories=[first,next,next],calls=[],events=[];const native={sample:async rows=>{calls.push(structuredClone(rows));if(calls.length===1)throw missing();return result(rows);}};
 const value=await sampleBrowserNativeMemory({getInventory:async()=>inventories.shift(),readLifetime:async()=>owner,sampler:native,onCohort:async row=>events.push(row)});
 assert.deepEqual(calls,[first.toSorted((a,b)=>a.id-b.id),next.toSorted((a,b)=>a.id-b.id)]);assert.equal(calls[1].some(p=>p.id===3),true);assert.equal(value.processes.length,2);assert.deepEqual(value.sampling.cohort.attempts.map(a=>a.status),['retired-process-confirmed','passed']);assert.equal(value.sampling.cohort.attempts[0].error.requestId,1);assert.equal(value.sampling.cohort.attempts[1].measured.sampling.requestId,2);assert.equal(value.sampling.cohort.phaseDeadlineMs,5000);assert.equal(BROWSER_NATIVE_MEMORY_LIMITS.attempts,2);assert.equal(events.length,4);assert.deepEqual(value.sampling.cohort.lifetime,owner);
});
test('missing-but-still-listed PID cannot be removed from the requested census',async()=>{
 let calls=0;await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>first,readLifetime:async()=>owner,sampler:{sample:async()=>{calls++;throw missing();}}}),error=>error.code==='NATIVE_MEMORY_OS_READ'&&error.cohort.attempts[0].status==='failed-process-still-listed');assert.equal(calls,1);
});
test('permissions,protocol,identity,deadlines and a second missing batch fail without speculative retries',async()=>{
 for(const fields of [{errno:13},{nativeStatus:3},{nativeStatus:6},{code:'NATIVE_MEMORY_PROTOCOL'},{code:'NATIVE_MEMORY_IDENTITY_CHANGED'},{code:'NATIVE_MEMORY_REQUEST_TIMEOUT'},{nativeBatch:false},{failedPid:8}]){
  let calls=0;const error=missing(fields);await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>first,readLifetime:async()=>owner,sampler:{sample:async()=>{calls++;throw error;}}}),e=>e===error);assert.equal(calls,1);
 }
 let calls=0;await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>calls?next:first,readLifetime:async()=>owner,sampler:{sample:async()=>{calls++;throw missing({failedPid:calls===1?2:3});}}}),error=>error.cohort.attempts.length===2);assert.equal(calls,2);
});
test('a changed positive census fails and retains its measured rows rather than selecting another lower batch',async()=>{
 let calls=0;const events=[];await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>calls?next:first,readLifetime:async()=>owner,sampler:{sample:async rows=>{calls++;return result(rows);}},onCohort:async row=>events.push(row)}),error=>error.code==='BROWSER_MEMORY_COHORT_CHANGED'&&error.cohort.attempts[0].measured.processes.length===2);assert.equal(calls,1);assert.equal(events.at(-1).status,'failed-census-changed');
});
test('page or Worker replacement fails both a retired-process retry and a positive final measurement',async()=>{
 for(const rejectBatch of [true,false])for(const change of ['page','worker']){
  let reads=0,calls=0;await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>first,readLifetime:async()=>{reads++;const value=structuredClone(owner);if(reads>1){if(change==='page')value.pages[0].nonce='replaced';else value.workers[0]='replaced';}return value;},sampler:{sample:async rows=>{calls++;if(rejectBatch)throw missing();return result(rows);}}}),error=>error.code==='BROWSER_MEMORY_LIFETIME_CHANGED');assert.equal(calls,1);
 }
});
test('the original5s total budget includes browser discovery and never starts a late native batch',async()=>{
 let nativeCalls=0;await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>first,readLifetime:async()=>{await delay(5010);return owner;},sampler:{sample:async()=>{nativeCalls++;}}}),error=>error.code==='BROWSER_MEMORY_PHASE_DEADLINE');await delay(20);assert.equal(nativeCalls,0);
});
test('invalid inventories/lifetime and evidence write failures fail closed',async()=>{
 for(const rows of [[],[first[0],first[0]],[{id:0,type:'browser'}],[{id:1,type:''}]])await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>rows,readLifetime:async()=>owner,sampler:{sample:async()=>assert.fail('invalid census reached native sampler')}}),e=>e.code==='BROWSER_MEMORY_INVENTORY');
 await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>first,readLifetime:async()=>({pages:[],workers:[]}),sampler:{sample:async()=>assert.fail()}}),e=>e.code==='BROWSER_MEMORY_LIFETIME');
 const disk=new Error('evidence unavailable');let calls=0;await assert.rejects(sampleBrowserNativeMemory({getInventory:async()=>first,readLifetime:async()=>owner,sampler:{sample:async()=>{calls++;}},onCohort:async()=>{throw disk;}}),e=>e===disk);assert.equal(calls,0);
});
