import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {fakeSource} from './live-helpers.mjs';

const previousPool=process.env.REMOTE_PAINT_RESOURCE_POOL_BYTES;
const output=process.env.REMOTE_PAINT_RESOURCE_POOL_OUTPUT??'artifacts/resource-pool';
process.env.REMOTE_PAINT_RESOURCE_POOL_BYTES=String(64*1024*1024);
const broker=new NativeBroker(),source=fakeSource(null);source.broker=broker;
let transport,socket,progress;const errors=[],frames=[],gate=new LiveFrameGate(),rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const capture=n=>{
 const bytes=Buffer.alloc(7.5*1024*1024);let value=n;for(let i=0;i<bytes.length;i++){value^=value<<13;value^=value>>>17;value^=value<<5;bytes[i]=value&255;}bytes.write('skiapict');
 const captureId=`pool-${n}`,resourceId=hash(bytes);
 return {captureId,producer:'pool-contract',resources:[{localId:1,quadScale:1,width:100,height:100,skp:bytes.toString('base64'),resourceId}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}};
};
async function until(predicate){const end=Date.now()+15000;while(!predicate()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,'Resource pool contract deadline');await delay(5);}}
const ack=frame=>socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));
async function ready(){let stats;const end=Date.now()+5000;do{stats=await broker.request('resourceBudget');if(stats.ready)return stats;assert.ok(Date.now()<end,'ACK did not return resource credit');await delay(10);}while(true);}
try{
 transport=await startLiveTransport(source,{port:0,ackTimeout:15000});
 socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',error=>errors.push(error.message));
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);assert.equal(hash(item.payload),item.id);gate.put(item.id,item.payload);return;}
  const message=JSON.parse(bytes);if(message.type==='SceneUpdate')gate.stage(message.frame);
  if(message.type==='FrameCommit'){const frame=gate.commit(message.pageEpoch,message.frameId);assert.ok(frame);frames.push(frame);}
 }catch(error){errors.push(error.stack);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,capabilities:['frame-window-v1'],frameWindow:2}));
 const first=await broker.map(capture(1),tags);await broker.request('publish',{serial:first.brokerSerial});await until(()=>frames.length===1);
 const second=await broker.map(capture(2),tags);await broker.request('publish',{serial:second.brokerSerial});await until(()=>frames.length===2);
 const before=await broker.request('resourceBudget');assert.equal(before.ready,false);assert.ok(before.bytes>40*1024*1024);assert.ok(before.bytes<=before.limit);assert.equal(before.retiredSnapshots,1);
 const state=await broker.request('mapperStats');
 await assert.rejects(broker.map(capture(3),tags),error=>error.code==='RESOURCE_BUDGET_PRESSURE');
 const denied=await broker.request('resourceBudget'),afterFailure=await broker.request('mapperStats');assert.equal(denied.bytes,before.bytes);assert.ok(denied.denied>0);assert.ok(denied.peak<=denied.limit);assert.equal(afterFailure.serial,state.serial);assert.equal(afterFailure.revision,state.revision);assert.equal(afterFailure.epoch,state.epoch);
 assert.deepEqual(await broker.request('publish',{serial:first.brokerSerial}),{coalesced:true});await assert.rejects(broker.request('publish',{serial:999999}),/Stale/);
 ack(frames[0]);ack(frames[1]);const returned=await ready();
 assert.ok(returned.bytes<before.bytes);
 const recovered=await broker.map(capture(3),tags);assert.equal(recovered.brokerSerial,second.brokerSerial+1);await broker.request('publish',{serial:recovered.brokerSerial});await until(()=>frames.length===3);ack(frames[2]);await ready();
 for(let n=4;n<=14;n++){
  const next=await broker.map(capture(n),tags);await broker.request('publish',{serial:next.brokerSerial});await until(()=>frames.length===n);ack(frames[n-1]);
  const stats=await ready();assert.ok(stats.bytes<=stats.limit&&stats.peak<=stats.limit);
 }
 await broker.reset();const peerPinned=await broker.request('resourceBudget');assert.ok(peerPinned.bytes>0,'Reset released credit still held by an ACK base');
 socket.close();await once(socket,'close');let released;const releaseEnd=Date.now()+5000;
 do{released=await broker.request('resourceBudget');if(released.bytes===0)break;assert.ok(Date.now()<releaseEnd,'Closed peer retained resource credit');await delay(10);}while(true);
 assert.deepEqual(errors,[]);progress={before,denied,returned,peerPinned,released,frames:frames.length,recoveredSerial:recovered.brokerSerial};
 const report={at:new Date().toISOString(),status:'passed',scope:'64MiB Rust resource allocation pool; actual RPC/Gateway raw-resource WebSocket with two valid unacknowledged 7.5MiB synthetic SKP-header frames inside the existing16MiB wire window. Third transaction fails with typed pressure and exact resource-credit rollback; ordered ACKs release old pins and allow serial3. Fourteen changed frames stay within the cap; reset preserves live peer credit and close returns all credits. Synthetic resource integrity/scene-gate contract, not CanvasKit pixels or process RSS. Input/parser, Snapshot JSON/indexes and WebSocket output copies are outside this pool.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress,errors};
 await mkdir(output,{recursive:true});await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir(output,{recursive:true});await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,errors,frames:frames.length},null,2));throw error;}
finally{socket?.terminate();await transport?.close();await broker.close();if(previousPool===undefined)delete process.env.REMOTE_PAINT_RESOURCE_POOL_BYTES;else process.env.REMOTE_PAINT_RESOURCE_POOL_BYTES=previousPool;}
