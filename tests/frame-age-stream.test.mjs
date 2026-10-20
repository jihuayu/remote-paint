import assert from 'node:assert/strict';
import {test} from 'node:test';
import {streamingCoverage} from './frame-age-stream.mjs';
import {calibratedLinuxSharedFrameAge,calibratedFrameAge} from './frame-age-observer.mjs';
const proof=(pid,domainId='a'.repeat(64))=>({schema:'linux-native-monotonic-probe-v1',domainId,rendererIdentity:{pid}});
const clock=(domainMs,lower,upper,pid)=>({domainMs,lower,upper,pid,provenance:{linuxMonotonic:proof(pid)}});
test('shared Linux ages require a matching actual domain and the specific producer identity; legacy remains per PID',()=>{
 const before={native:{best:clock(1000,100,104,7)},worker:{best:clock(500,600,604,0)}},after={native:{best:clock(2000,110,114,8)},worker:{best:clock(1500,610,614,0)}},sample={producer:'9:2',captureClock:'chromium-time-ticks-v1',workerClock:'worker-performance-v1',captureStartedMicros:1500000,observedMs:1050};
 assert.equal(calibratedLinuxSharedFrameAge(sample,before,after,proof(9)).estimateMs,50.5);
 assert.throws(()=>calibratedFrameAge(sample,before,after));assert.throws(()=>calibratedLinuxSharedFrameAge(sample,before,after,proof(10)));assert.throws(()=>calibratedLinuxSharedFrameAge(sample,before,after,proof(9,'b'.repeat(64))));assert.throws(()=>calibratedLinuxSharedFrameAge(sample,before,after,null));
});
test('continuous boundary proof rejects missing commits, replacement Workers, protocol gaps and mismatched rotation counters',()=>{
 const previous={window:3,all:20,protocolOrdinal:2},raw={errors:[],workerCount:1,pending:0,start:{...previous,productionFrames:25},end:{window:3,all:21,observed:1,protocolOrdinal:2,productionFrames:26},paired:1,protocolEvents:[],samples:[{window:3,windowOrdinal:1,commitOrdinal:21,productionFramePaired:true,connectionGeneration:1,pageEpoch:2,viewportVersion:1,frameId:7,pixels:[[1,2,3,255]],pixelReadMs:0,requiredResourceCount:0,requiredResourceBytes:0,largestRequiredResourceBytes:0}]};
 assert.equal(streamingCoverage(raw,previous).paired,1);
 for(const mutate of [r=>r.samples=[],r=>r.workerCount=2,r=>r.start.all=19,r=>r.end.productionFrames=27,r=>r.end.protocolOrdinal=3,r=>r.samples[0].commitOrdinal=22,r=>r.samples[0].productionFramePaired=false]){const r=structuredClone(raw);mutate(r);assert.throws(()=>streamingCoverage(r,previous));}
});
