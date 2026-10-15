import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveFrameGate,RecoveryRequired,makeDelta} from '../protocol/live-wire.mjs';
import {LivePeer} from '../live/peer.mjs';
import {snapshot,frame,payload,hash,fakeSource} from './live-helpers.mjs';
const renderer={canvaskit:'0.42.0',wasmSha256:'renderer'};
function peer(source,options={}){
 const ws={readyState:1,bufferedAmount:0,sent:[],send(value){this.sent.push(value);},close(code,reason){this.code=code;this.reason=reason;this.readyState=3;}};
 const peer=new LivePeer(ws,source,{renderer,producer:{},ackTimeout:1000,...options});peer.message({type:'Hello',protocol:2,renderer});return {peer,ws};
}
test('delta depends on the acknowledged base; missing resources/failed decode never advance the visible frame',()=>{
 const gate=new LiveFrameGate(),a=snapshot();gate.put(hash,payload);gate.stage(frame(a,1));assert.equal(gate.commit(1,1).frameId,1);
 const b=snapshot({translation:-100});gate.stage(frame(b,2,1,{scene:undefined,delta:makeDelta(a.scene,b.scene)}));gate.commit(1,2);
 assert.equal(gate.committed.scene.passes[0].quads[0].matrix[5],-100);
 assert.throws(()=>gate.stage(frame(b,3,1,{scene:undefined,delta:makeDelta(a.scene,b.scene)})),RecoveryRequired);
 const bytes=Buffer.concat([payload,Buffer.from('contract-change')]);const c=snapshot({resource:bytes});const id=[...c.payloads.keys()][0];
 gate.stage(frame(c,4));assert.equal(gate.commit(1,4),null);assert.equal(gate.committed.frameId,2);assert.equal(gate.release(hash),false);
 gate.put(id,bytes);assert.throws(()=>gate.commit(1,4,()=>{throw new Error('decoder failed');}),/decoder/);assert.equal(gate.committed.frameId,2);
 gate.commit(1,4);gate.collect();assert.equal(gate.resources.has(hash),false);assert.equal(gate.resources.size,1);
 assert.throws(()=>gate.stage(frame(a,5,null,{pageEpoch:0})),/header/);
 assert.throws(()=>gate.stage(frame(a,3)),/Stale/);
});
test('coalesce unsent snapshots, compute a fresh delta from ACK, reuse bytes and recover with a complete keyframe',()=>{
 const source=fakeSource(),{peer:p,ws}=peer(source);
 try{
  assert.equal(p.inflight.frameId,1);const sent=ws.sent.length;
  for(let i=2;i<=20;i++){source.latest=snapshot({captureId:`contract-${i}`,translation:-i});p.onFrame();}
  assert.equal(ws.sent.length,sent);assert.equal(p.stats.maxInflight,1);assert.equal(p.stats.coalesced,19);
  p.message({type:'FrameAck',pageEpoch:1,frameId:1});assert.equal(p.inflight.frameId,2);
  const updates=ws.sent.filter(x=>typeof x==='string').map(JSON.parse).filter(x=>x.type==='SceneUpdate');
  assert.equal(updates[1].frame.baseFrameId,1);assert.equal(updates[1].frame.native.captureId,'contract-20');assert.equal(p.stats.resources,1);
  p.message({type:'RequestKeyframe'});const last=ws.sent.filter(x=>typeof x==='string').map(JSON.parse).filter(x=>x.type==='SceneUpdate').at(-1).frame;
  assert.equal(last.baseFrameId,null);assert.ok(last.scene);assert.equal(p.stats.resources,2);assert.equal(last.frameId,3);
  source.latest=snapshot({epoch:2});p.message({type:'FrameAck',pageEpoch:1,frameId:3});
  const epoch=ws.sent.filter(x=>typeof x==='string').map(JSON.parse).filter(x=>x.type==='SceneUpdate').at(-1).frame;assert.equal(epoch.baseFrameId,null);assert.equal(epoch.pageEpoch,2);
 }finally{p.dispose();}
});
test('slow clients have one bounded window and reconnect to a new keyframe',async()=>{
 const {peer:p,ws}=peer(fakeSource(),{ackTimeout:20});await new Promise(r=>setTimeout(r,35));assert.equal(ws.code,1013);assert.equal(p.stats.slowDisconnects,1);assert.equal(p.inflight,null);
 const source=fakeSource();const second=peer(source);try{second.peer.message({type:'FrameAck',pageEpoch:1,frameId:1});source.latest=snapshot({captureId:'next'});second.ws.bufferedAmount=65*1024*1024;second.peer.onFrame();assert.equal(second.ws.code,1013);}finally{second.peer.dispose();}
});
