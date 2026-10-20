import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSessionInputFrameProofs} from './session-long-observation.mjs';
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
