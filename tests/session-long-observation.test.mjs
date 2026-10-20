import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSessionInputFrameProofs,drainSessionMarkerWindow,validateSessionRttWelcome} from './session-long-observation.mjs';
const ack={seq:17,pageEpoch:3,viewportVersion:4,accepted:true,stage:'input-injected'};
const sample={productionFramePaired:true,pageEpoch:3,viewportVersion:4,inputSeq:17,commitOrdinal:21,frameId:8,pixels:[[1,0,199,255],[1,0,199,255],[1,0,211,255],[0,2,42,255]],age:{estimateMs:12}};
test('input proof rejects stale epoch, viewport, input watermark, pixel and unpaired commits',async()=>{
 for(const mutate of [s=>s.pageEpoch--,s=>s.viewportVersion--,s=>s.inputSeq--,s=>s.inputSeq=undefined,s=>s.pixels[3][1]=1,s=>s.pixels[3][2]=41,s=>s.pixels[3][3]=0,s=>s.productionFramePaired=false]){
  const records=[],proofs=createSessionInputFrameProofs(async p=>records.push(p));proofs.enqueue(2,ack);const bad=structuredClone(sample);mutate(bad);await proofs.consume({window:1,samples:[bad]});assert.equal(records.length,0);assert.throws(()=>proofs.finish(),/lacks/);await proofs.consume({window:2,samples:[sample]});proofs.finish();assert.equal(records.length,1);assert.equal(records[0].window,2);assert.equal(records[0].ack.seq,17);
 }
});
test('accumulated text can prove multiple ACKs; persistence failures keep pending proof and the queue is bounded',async()=>{
 let unavailable=true;const records=[],proofs=createSessionInputFrameProofs(async p=>{if(unavailable)throw new Error('disk unavailable');records.push(p);});proofs.enqueue(1,{...ack,seq:16});proofs.enqueue(2,ack);
 await assert.rejects(proofs.consume({window:1,samples:[sample]}),/disk unavailable/);assert.deepEqual(proofs.stats,{queued:2,proved:0,pending:2,limit:128});unavailable=false;await proofs.consume({window:1,samples:[sample]});proofs.finish();assert.equal(records.length,2);
 const full=createSessionInputFrameProofs(async()=>{});for(let seq=1;seq<=128;seq++)full.enqueue(seq,{...ack,seq});assert.throws(()=>full.enqueue(129,{...ack,seq:129}));assert.equal(full.stats.pending,128);assert.throws(()=>full.enqueue(1,{...ack,seq:1}));
});
test('a window rotated concurrently with the next update uses the observed counter after rotation without filtering samples',async()=>{
 let cycle=100,release;const reply={window:3,samples:[{pixels:[[101,0,199,255],[101,0,199,255],[1,0,211,255],[0,2,42,255]]}]},pending=new Promise(resolve=>release=resolve);
 const stream={drain:async options=>{assert.equal(options.stop,false);return pending;}},work=drainSessionMarkerWindow(stream,()=>cycle,1);
 // The caller's next primary update runs before the Worker rotation replies.
 cycle=101;release(reply);const observed=await work;assert.equal(observed.result,reply);assert.deepEqual(observed.bounds,{invocationCycle:100,throughCycle:101});
 assert.equal(reply.samples[0].pixels[0][0]<=observed.bounds.invocationCycle,false,'The old invocation-time upper bound would reject this actual interleaving');
});
test('the post-rotation counter still rejects future markers, wrong Session pixels, invalid channels and counter rollback',async()=>{
 const valid={pixels:[[1,0,199,255],[1,0,199,255],[1,0,211,255],[0,2,42,255]]};
 for(const change of [s=>s.pixels[0][0]=3,s=>s.pixels[1][2]=198,s=>s.pixels[2][0]=2,s=>s.pixels[3][0]=256,s=>s.pixels[0][3]=0,s=>s.pixels.pop()]){
  const s=structuredClone(valid);change(s);await assert.rejects(drainSessionMarkerWindow({drain:async()=>({samples:[s]})},()=>2,1));
 }
 const boundaries=[];await assert.rejects(drainSessionMarkerWindow({drain:async()=>({window:7,samples:[{...valid,pixels:[[3,0,199,255],...valid.pixels.slice(1)]}]})},()=>2,1,{onBoundary:async b=>boundaries.push(b)}));assert.deepEqual(boundaries,[{window:7,invocationCycle:2,throughCycle:2}]);
 let reads=0;await assert.rejects(drainSessionMarkerWindow({drain:async()=>({samples:[]})},()=>++reads===1?2:1,1),/went backwards/);
 for(const n of [-1,1.5,NaN,65536])await assert.rejects(drainSessionMarkerWindow({drain:async()=>({samples:[]})},()=>n,1),/Invalid actual/);
});
test('the RTT consumer must be read-only and acknowledge release rather than claim scene submission',()=>{
 const renderer={canvaskit:'fixture',wasmSha256:'a'.repeat(64)},welcome={type:'Welcome',protocol:4,renderer,consumerKind:'recording',ackStage:'consumer-released',input:false,inputFeedback:false,control:null};assert.equal(validateSessionRttWelcome(welcome,renderer),true);
 for(const change of [m=>m.consumerKind='display',m=>m.ackStage='scene-submitted',m=>m.input=true,m=>m.inputFeedback=true,m=>m.control={ticket:'fixture-only'},m=>m.renderer={...renderer,wasmSha256:'b'.repeat(64)},m=>m.protocol=3]){const m=structuredClone(welcome);change(m);assert.throws(()=>validateSessionRttWelcome(m,renderer));}
});
