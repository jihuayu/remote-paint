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

test('a confirmed disable remains stopped when subsequent clock calibration fails; raw window survives',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{startFrameAgeStream}=await import('./frame-age-stream.mjs');
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-stop-contract-'));let probes=0,disables=0;
 // Contract transport: valid shared-domain startup probes, then an unavailable
 // Source immediately after the actual disable reply. No browser claim here.
 const nativeProbe=async()=>{if(++probes>12)throw new Error('Source clock unavailable after disable');return {reply:{clock:'chromium-time-ticks-v1',nowMicros:1000000,rendererProcessId:9},pageEpoch:1,viewportVersion:1,provenance:{producer:'9:2',linuxMonotonic:{schema:'linux-native-monotonic-probe-v1',domainId:'a'.repeat(64),rendererIdentity:{pid:9},interval:{nativeMicros:1000000,beforeNs:'1000000000',afterNs:'1000000000'}}}};};
 const page={waitForTimeout:async()=>{},evaluate:async(_fn,op)=>{if(op==='clock')return {clock:'worker-performance-v1',now:100};if(op===undefined)return {window:1,all:0,protocolOrdinal:0,now:100};assert.equal(op,'disable');disables++;return {operation:'disable',completed:{unvalidated:true}};}};
 try{const stream=await startFrameAgeStream(page,{streaming:true,diagnosticFaults:false},{nativeProbe,directory});await assert.rejects(stream.drain({stop:true}),/clock unavailable/);assert.equal(stream.active,false);await assert.rejects(stream.drain({stop:true}),/drain after stop/);assert.equal(disables,1);assert.equal(JSON.parse((await readFile(join(directory,'stream-raw-windows.jsonl'),'utf8')).trim()).raw.unvalidated,true);}finally{await rm(directory,{recursive:true,force:true});}
});

test('failed rotate calibration still advances the actual window cursor and cleanup disables once without accepting uncalibrated frames',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{startFrameAgeStream}=await import('./frame-age-stream.mjs');
 for(const corruptCleanup of [false,true]){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-rotate-failure-'));let probes=0,rotates=0,disables=0;
 const nativeProbe=async()=>{if(++probes>12)throw new Error('injected post-rotate clock failure');return {reply:{clock:'chromium-time-ticks-v1',nowMicros:1000000,rendererProcessId:9},pageEpoch:1,viewportVersion:1,provenance:{producer:'9:2',linuxMonotonic:{schema:'linux-native-monotonic-probe-v1',domainId:'a'.repeat(64),rendererIdentity:{pid:9},interval:{nativeMicros:1000000,beforeNs:'1000000000',afterNs:'1000000000'}}}};};
 const raw=window=>({errors:[],workerCount:1,pending:0,start:{window,all:window-1,protocolOrdinal:0,productionFrames:window-1},end:{window,all:window,observed:1,protocolOrdinal:0,productionFrames:window},paired:1,protocolEvents:[],socketStarts:[],socketCloses:[],samples:[{window,windowOrdinal:1,commitOrdinal:window,productionFramePaired:true,connectionGeneration:1,pageEpoch:1,viewportVersion:1,frameId:window,pixels:[[1,2,3,255]],pixelReadMs:0,requiredResourceCount:0,requiredResourceBytes:0,largestRequiredResourceBytes:0}]});
 const page={waitForTimeout:async()=>{},evaluate:async(_fn,op)=>{if(op==='clock')return {clock:'worker-performance-v1',now:100};if(op===undefined)return {window:1,all:0,protocolOrdinal:0,now:100};if(op==='rotate'){rotates++;return {operation:'rotate',window:1,nextWindow:2,all:1,protocolOrdinal:0,now:101,completed:raw(1)};}assert.equal(op,'disable');disables++;const completed=raw(2);if(corruptCleanup)completed.start.window=1;return {operation:'disable',window:2,all:2,protocolOrdinal:0,now:102,completed};}};
 try{
  const stream=await startFrameAgeStream(page,{streaming:true,diagnosticFaults:false},{nativeProbe,directory});
  await assert.rejects(stream.drain(),/injected post-rotate clock failure/);assert.equal(stream.active,true);
  const stopped=await stream.drain({stop:true});assert.equal(stopped.aborted,true);assert.equal(stopped.validation,'not-accepted');assert.equal(stream.active,false);assert.equal(rotates,1);assert.equal(disables,1);assert.equal(probes,13);assert.equal(stream.totals.windows,0);assert.equal(stream.totals.successfulCommits,0);assert.equal(stream.lifetime.acceptanceFailed,true);
  const rows=(await readFile(join(directory,'stream-raw-windows.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(x=>x.raw.start.window),[1,corruptCleanup?1:2]);assert.equal(rows.flatMap(x=>x.raw.samples).length,2);
  const cleanup=JSON.parse((await readFile(join(directory,'stream-aborted-windows.jsonl'),'utf8')).trim());assert.equal(cleanup.window,corruptCleanup?1:2);if(corruptCleanup){assert.equal(cleanup.rawCoverage,null);assert.equal(typeof cleanup.coverageError,'string');}else{assert.equal(cleanup.rawCoverage.paired,1);assert.equal(cleanup.coverageError,null);}assert.equal(cleanup.validation,'not-accepted');
  await assert.rejects(stream.drain({stop:true}),/drain after stop/);assert.equal(disables,1);
 }finally{await rm(directory,{recursive:true,force:true});}
 }
});
