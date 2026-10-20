// Real Rust/WebSocket transport with fixture captures, not a pixel or WAN test.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {fakeSource,payload} from './live-helpers.mjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {createRequire} from 'node:module';

const broker=new NativeBroker(),source=fakeSource();source.broker=broker;
let serial=0,transport;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,timeout=3000){const end=Date.now()+timeout;while(!predicate()){assert.ok(Date.now()<end,'Transport progress deadline');await pause(2);}}
async function publish({epoch=1,large=false,seed,count=1,base=payload}={}){
 const captureId=`window-${++serial}`,rect=[0,0,960,640];
 // Different immutable bytes exercise retirement while frames remain inflight.
 const resources=[],quads=[];
 for(let i=0;i<count;i++){
  const suffix=Buffer.alloc(8);suffix.writeUInt32BE(seed??serial);suffix.writeUInt32BE(i,4);
  const bytes=Buffer.concat([base,...(large?[Buffer.alloc(9*1024*1024,serial)]:[]),suffix]);
  resources.push({localId:i+1,quadScale:1,width:960,height:640,skp:bytes.toString('base64')});
  quads.push({kind:'picture',localId:i+1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1});
 }
 const capture={captureId,producer:'window-contract',resources,viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads}]}};
 source.latest=await broker.map(capture,{epoch,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640,deviceScaleFactor:1}});
 if(transport)await broker.request('publish',{serial:source.latest.brokerSerial});
}
async function connect(window,firstFrameTimeout=3000){
 const ws=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});
 const gate=new LiveFrameGate(),messages=[],frames=[],errors=[];
 ws.on('message',(bytes,binary)=>{try{
  if(binary){const {id,payload}=decodeResource(bytes);gate.put(id,payload);return;}
  const message=JSON.parse(bytes);messages.push(message);
  if(message.type==='SceneUpdate')gate.stage(message.frame);
  if(message.type==='FrameCommit'){assert.ok(gate.commit(message.pageEpoch,message.frameId));frames.push(gate.committed);}
  if(message.type==='ResourceRelease')for(const id of message.ids)gate.release(id);
 }catch(error){errors.push(error.message);}});
 await once(ws,'open');ws.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,...(window?{capabilities:['frame-window-v1'],frameWindow:window}:{})}));
 await until(()=>frames.length===1,firstFrameTimeout);
 return {ws,gate,messages,frames,errors,ack(frame){ws.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));},async close(){if(ws.readyState===WebSocket.CLOSED)return;const closed=once(ws,'close');ws.close();const timer=setTimeout(()=>ws.terminate(),500);try{await closed;}finally{clearTimeout(timer);}}};
}
try{
 await publish();transport=await startLiveTransport(source,{port:0,ackTimeout:1500});
 const client=await connect(6);
 try{
  assert.equal(client.messages[0].frameWindow,6);assert.equal(client.messages[0].ackStage,'scene-submitted');
  for(let i=2;i<=6;i++){await publish(i===3?{seed:1}:{});await until(()=>client.frames.length===i);}
  assert.equal(client.frames[2].requiredResources[0],client.frames[0].requiredResources[0]);
  assert.deepEqual(client.frames.map(f=>f.baseFrameId),[null,1,2,3,4,5]);
  assert.equal(client.messages.filter(m=>m.type==='ResourceRelease').length,0,'Unacknowledged resources remain pinned');
  for(let i=7;i<=20;i++)await publish();await pause(30);assert.equal(client.frames.length,6);
  client.ack(client.frames[0]);await until(()=>client.frames.length===7);
  assert.equal(client.frames[6].native.captureId,'window-20');assert.equal(client.frames[6].baseFrameId,6);
  for(const frame of client.frames.slice(1))client.ack(frame);
  await pause(30);assert.ok(client.messages.some(m=>m.type==='ResourceRelease'));assert.deepEqual(client.errors,[]);
  await publish({epoch:2});await until(()=>client.frames.length===8);assert.equal(client.frames[7].baseFrameId,null);
  // Ask for recovery while the old ACK can still be travelling in the socket.
  client.ws.send(JSON.stringify({type:'RequestKeyframe'}));client.ack(client.frames[7]);
  await until(()=>client.frames.length===9);assert.equal(client.frames[8].baseFrameId,null);client.ack(client.frames[8]);
  await pause(30);assert.equal(client.ws.readyState,WebSocket.OPEN);assert.deepEqual(client.errors,[]);
 }finally{await client.close();}
 const legacy=await connect();
 try{assert.equal(legacy.messages[0].frameWindow,1);await publish({epoch:2});await pause(30);assert.equal(legacy.frames.length,1);legacy.ack(legacy.frames[0]);await until(()=>legacy.frames.length===2);}
 finally{await legacy.close();}
 // A raw 9MiB WebSocket message is not observable until all bytes arrive.
 // Use the server's existing 15s resource-progress bound for these two waits;
 // the 3s control/small-frame gates and 1.5s post-commit ACK deadline remain.
 await publish({large:true});const bounded=await connect(6,15000);
 try{await publish({large:true});await pause(30);assert.equal(bounded.frames.length,1,'Byte credit also bounds a multi-frame window');bounded.ack(bounded.frames[0]);await until(()=>bounded.frames.length===2,15000);assert.deepEqual(bounded.errors,[]);}
 finally{await bounded.close();}
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});
 const recorder=new ck.PictureRecorder();recorder.beginRecording([0,0,960,640]);const picture=recorder.finishRecordingAsPicture();
 const base=Buffer.from(picture.serialize());picture.delete();recorder.delete();
 await publish({count:180,base});const resourceBound=await connect(6);
 try{
  await publish({count:180,base});await until(()=>resourceBound.frames.length===2);
  await publish({count:180,base});await pause(30);assert.equal(resourceBound.frames.length,2,'Resource count credit prevents the 513th raw resource');
  resourceBound.ack(resourceBound.frames[0]);await pause(20);assert.equal(resourceBound.frames.length,2,'The acknowledged base is still pinned');
  resourceBound.ack(resourceBound.frames[1]);await until(()=>resourceBound.frames.length===3);assert.deepEqual(resourceBound.errors,[]);
 }finally{await resourceBound.close();}
 const invalid=await connect(6),closed=once(invalid.ws,'close');invalid.ack({...invalid.frames[0],frameId:99999});assert.equal((await closed)[0],1008);
 const report={at:new Date().toISOString(),scope:'Native Rust WebSocket + fixture capture + validating LiveFrameGate; no pixels or kernel packet loss',window:6,orderedDeltaBases:true,unsentSnapshotsCoalesced:14,resourceLifetime:true,recoveryWithLateAck:true,epochBarrier:true,legacyWindow:1,byteCreditMiB:16,resourceCountCredit:512,invalidAckClose:1008};
 await mkdir('artifacts/network',{recursive:true});await writeFile('artifacts/network/frame-window.json',JSON.stringify(report,null,2));console.log(report);
}finally{await transport?.close();await broker.close();}
