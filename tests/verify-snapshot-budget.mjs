import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {fakeSource} from './live-helpers.mjs';

assert.equal(process.platform,'linux');
const output='artifacts/snapshot-budget',rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
await mkdir(output,{recursive:true});
const capture=(id,bytes=0)=>({captureId:id,producer:'snapshot-budget-contract',timing:{padding:'x'.repeat(bytes)},resources:[],viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'solid',matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,opacity:1,color:[0.1,0.2,0.3,1]}]}]}});
function newBroker(bytes){const previous=process.env.REMOTE_PAINT_SNAPSHOT_BYTES;process.env.REMOTE_PAINT_SNAPSHOT_BYTES=String(bytes);try{return new NativeBroker();}finally{if(previous===undefined)delete process.env.REMOTE_PAINT_SNAPSHOT_BYTES;else process.env.REMOTE_PAINT_SNAPSHOT_BYTES=previous;}}
async function until(check){const end=Date.now()+5000;for(;;){const value=await check();if(value)return value;assert.ok(Date.now()<end,'Snapshot owner release deadline');await delay(5);}}
async function metadataQuota(){
 const broker=newBroker(32*1024*1024);let progress;
 try{
  const first=await broker.map(capture('published',2*1024*1024),{...tags,metadataOnly:true});assert.equal(first.native.timing.padding.length,2*1024*1024);
  await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin:'http://127.0.0.1',key:'snapshot-contract-local-only-key',renderer:{},producer:{}}});await broker.request('publish',{serial:first.brokerSerial});
  const latest=await broker.map(capture('latest',2*1024*1024),{...tags,metadataOnly:true});assert.equal(latest.native.timing.padding.length,2*1024*1024);
  const before=await broker.request('resourceBudget'),state=await broker.request('mapperStats');assert.equal(before.bytes,0);assert.ok(before.snapshots.bytes>=4*1024*1024);assert.ok(before.snapshots.peak<=before.snapshots.limit);
  progress={before,state};let denied;
  await assert.rejects(broker.map(capture('denied',4*1024*1024),{...tags,epoch:2,viewportVersion:2,metadataOnly:true}),error=>{denied={code:error.code,message:error.message};return error.code==='RESOURCE_BUDGET_PRESSURE'&&error.message==='Snapshot allocation budget exceeded';});
  const after=await broker.request('resourceBudget'),unchanged=await broker.request('mapperStats');assert.deepEqual(unchanged,state);assert.equal(after.snapshots.bytes,before.snapshots.bytes);assert.ok(after.snapshots.denied>before.snapshots.denied);assert.ok(after.snapshots.peak<=after.snapshots.limit);assert.equal(broker.closed,false);assert.equal(first.native.timing.padding.length,2*1024*1024);
  const recovered=await broker.map(capture('recovered',1024),{...tags,metadataOnly:true});assert.equal(recovered.brokerSerial,latest.brokerSerial+1);await broker.request('publish',{serial:recovered.brokerSerial});
  const replaced=await broker.request('resourceBudget');assert.ok(replaced.snapshots.bytes<before.snapshots.bytes);await broker.resetScene();const cleared=await broker.request('resourceBudget');assert.equal(cleared.snapshots.bytes,0);assert.equal(cleared.snapshots.allocations,0);
  // Retained caller strings are deliberately still alive after Rust owners
  // vanish. They belong to the separate Node application graph scope.
  assert.equal(first.native.timing.padding.length+latest.native.timing.padding.length,4*1024*1024);
  return {quotaBytes:32*1024*1024,knownRetainedMetadataBytes:4*1024*1024,before:before.snapshots,denied,after:after.snapshots,mapperUnchanged:true,remoteAdmissionBeforeCommit:true,recoveredSerial:recovered.brokerSerial,replaced:replaced.snapshots,cleared:cleared.snapshots,callerStringsRemainOutsideRustPool:true};
 }catch(error){await writeFile(output+'/metadata-failed.json',JSON.stringify({at:new Date().toISOString(),error:error.stack,progress},null,2));throw error;}finally{await broker.close();}
}
async function minimumQuota(){
 const broker=newBroker(1024*1024);
 try{
  const first=await broker.map(capture('minimum'),tags);assert.ok(first.scene);const before=await broker.request('resourceBudget');assert.ok(before.ready);
  await assert.rejects(broker.map(capture('too-large',1024*1024),tags),error=>error.code==='RESOURCE_BUDGET_PRESSURE'&&error.message==='Snapshot allocation budget exceeded');
  assert.equal((await broker.request('mapperStats')).serial,first.brokerSerial);await broker.resetScene();const after=await broker.request('resourceBudget');assert.equal(after.snapshots.bytes,0);return {quotaBytes:1024*1024,smallSceneAccepted:true,largerSceneDenied:true,before:before.snapshots,after:after.snapshots};
 }finally{await broker.close();}
}
async function peerPins(){
 const broker=newBroker(8*1024*1024),source=fakeSource(null);source.broker=broker;
 let transport,socket;const errors=[],frames=[],gate=new LiveFrameGate();
 try{
  transport=await startLiveTransport(source,{port:0,ackTimeout:15000});
  socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',error=>errors.push(error.message));
  socket.on('message',(bytes,binary)=>{try{assert.equal(binary,false);const message=JSON.parse(bytes);if(message.type==='SceneUpdate')gate.stage(message.frame);if(message.type==='FrameCommit'){const frame=gate.commit(message.pageEpoch,message.frameId);assert.ok(frame);frames.push(frame);}}catch(error){errors.push(error.stack);}});
  await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,capabilities:['frame-window-v1'],frameWindow:2}));
  for(let n=1;n<=2;n++){const mapped=await broker.map(capture('peer-'+n,32*1024),tags);await broker.request('publish',{serial:mapped.brokerSerial});await until(()=>{assert.deepEqual(errors,[]);return frames.length===n;});}
  const before=await broker.request('resourceBudget');await broker.resetScene();const reset=await broker.request('resourceBudget');assert.ok(reset.snapshots.bytes>0);assert.ok(reset.snapshots.bytes<before.snapshots.bytes,'Mapper entry lease must release independently of peer Snapshot pins');
  for(const frame of frames)socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));
  const acked=await until(async()=>{const value=await broker.request('resourceBudget');return value.snapshots.bytes>0&&value.snapshots.bytes<reset.snapshots.bytes?value:false;});
  socket.close();await once(socket,'close');const closed=await until(async()=>{const value=await broker.request('resourceBudget');return value.snapshots.bytes===0?value:false;});assert.equal(closed.snapshots.allocations,0);assert.deepEqual(errors,[]);
  return {frames:frames.length,before:before.snapshots,afterResetWithTwoInflight:reset.snapshots,afterAckWithBasePin:acked.snapshots,afterPeerClose:closed.snapshots,errors};
 }finally{socket?.terminate();await transport?.close();await broker.close();}
}
const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust Snapshot/Mapper-entry graph reservations and staging pre-admission;32MiB metadata quota,minimum1MiB recovery and8MiB real Gateway two-frame/ACK-base pins. Denial precedes Mapper commit and keeps prior state. Reset/reclaim cannot release peer pins early;last actual peer reference returns credit. Conservative graph/staging estimates and exact bounded scene JSON capacity,not complete allocator/RSS,Node retained graphs,RPC/Gateway output copies,asset scratch or all Session ownership.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),metadata:await metadataQuota(),minimum:await minimumQuota(),peerPins:await peerPins()};
await writeFile(output+'/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,metadataBytes:report.metadata.before.bytes,denied:report.metadata.denied,recoveredSerial:report.metadata.recoveredSerial,peerFrames:report.peerPins.frames,finalPeerCredit:report.peerPins.afterPeerClose.bytes}));
