import assert from 'node:assert/strict';
import {test} from 'node:test';
import {interpolateClock,calibratedFrameAge,summarizeFrameResources} from './frame-age-observer.mjs';

const probe=(domainMs,lower,upper,pid=7)=>({domainMs,lower,upper,pid});
const before={native:{best:probe(1000,100,104)},worker:{best:probe(500,600,604)}};
const after={native:{best:probe(2000,110,114)},worker:{best:probe(1500,610,614)}};
const sample={producer:'7:2',captureClock:'chromium-time-ticks-v1',workerClock:'worker-performance-v1',captureStartedMicros:1500000,observedMs:1050};
test('frame age translates both independent origins and affine drift with interval arithmetic',()=>{
 const age=calibratedFrameAge(sample,before,after);
 assert.equal(age.estimateMs,50.5);assert.equal(age.lowerMs,46.5);assert.equal(age.upperMs,54.5);assert.equal(age.uncertaintyMs,4);
 assert.notEqual(age.estimateMs,sample.observedMs-sample.captureStartedMicros/1000);
});
test('asymmetric request-response uncertainty is retained instead of assuming equal network delay',()=>{
 const c=interpolateClock(probe(0,-200,-180),probe(100,-196,-194),25);
 assert.equal(c.lower,-199);assert.equal(c.upper,-183.5);assert.equal(c.fraction,.25);
});
test('timer quantization expands both probe and endpoint bounds instead of claiming sub-resolution precision',()=>{
 const expand=(s,q)=>({...s,lower:s.lower-q,upper:s.upper+q,quantizationMs:q});
 const a={native:{best:expand(before.native.best,.001)},worker:{best:expand(before.worker.best,.2)}};
 const b={native:{best:expand(after.native.best,.001)},worker:{best:expand(after.worker.best,.2)}};
 const age=calibratedFrameAge(sample,a,b);assert.ok(Math.abs(age.estimateMs-50.5)<1e-9);
 assert.ok(Math.abs(age.uncertaintyMs-4.402)<1e-9);assert.equal(age.endpointAllowanceMs,.201);
});
test('out-of-bracket frames, stationary clocks and reversed intervals cannot receive age claims',()=>{
 for(const value of [999,2001,NaN])assert.throws(()=>interpolateClock(before.native.best,after.native.best,value));
 assert.throws(()=>interpolateClock(before.native.best,before.native.best,1000));
 assert.throws(()=>interpolateClock(probe(0,2,1),probe(100,0,1),50));
});
test('renderer and clock-domain replacements cannot silently reuse a calibration',()=>{
 assert.throws(()=>calibratedFrameAge({...sample,producer:'8:2'},before,after));
 assert.throws(()=>calibratedFrameAge(sample,before,{...after,native:{best:probe(2000,110,114,8)}}));
 assert.throws(()=>calibratedFrameAge({...sample,captureClock:'wall-clock'},before,after));
 assert.throws(()=>calibratedFrameAge({...sample,workerClock:'main-performance'},before,after));
 assert.throws(()=>calibratedFrameAge({...sample,captureStartedMicros:undefined},before,after));
});
test('impossible negative age remains a failed proof rather than being clamped to zero',()=>{
 assert.throws(()=>calibratedFrameAge({...sample,observedMs:750},before,after),/impossible negative/);
});
test('long native clock origins preserve millisecond-scale ages without unsafe integer stamps',()=>{
 const origin=10_000_000_000;
 const a={native:{best:probe(origin,1000-origin,1000-origin)},worker:{best:probe(1000,0,0)}};
 const b={native:{best:probe(origin+1000,1000-origin,1000-origin)},worker:{best:probe(2000,0,0)}};
 const age=calibratedFrameAge({...sample,captureStartedMicros:(origin+500)*1000,observedMs:1600},a,b);
 assert.ok(Math.abs(age.estimateMs-100)<.00001);assert.equal(age.uncertaintyMs,0);
});
test('resource summary counts actual required payload views and ignores unrelated cached bytes',()=>{
 const image=new Uint8Array(9*1024*1024+13),storage=new Uint8Array(100),text=storage.subarray(8,25),unused=new Uint8Array(1024*1024);
 const resources=new Map([['image',image],['text',text],['unused',unused]]),summary=summarizeFrameResources(['image','text'],resources);
 assert.deepEqual(summary,{requiredResourceCount:2,requiredResourceBytes:9*1024*1024+30,largestRequiredResourceBytes:9*1024*1024+13});
 assert.equal(resources.get('text'),text);assert.equal(text.byteLength,17);assert.equal(storage.byteLength,100);
});
test('resource-free scenes have zero dependency bytes even with a populated cache',()=>{
 assert.deepEqual(summarizeFrameResources([],new Map([['unused',new Uint8Array(1024)]])),{requiredResourceCount:0,requiredResourceBytes:0,largestRequiredResourceBytes:0});
});
test('missing, duplicate, non-byte and over-budget dependency sets cannot masquerade as a large frame',()=>{
 const resources=new Map([['valid',new Uint8Array(10)],['empty',new Uint8Array(0)],['fake',{byteLength:10*1024*1024}]]);
 for(const ids of [['missing'],['valid','valid'],['empty'],['fake'],Array.from({length:257},(_,i)=>String(i))])assert.throws(()=>summarizeFrameResources(ids,resources));
 assert.throws(()=>summarizeFrameResources(['valid'],{}));
});
