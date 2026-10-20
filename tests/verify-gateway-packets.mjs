import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';

const output='artifacts/gateway-packets',previous=process.env.REMOTE_PAINT_GATEWAY_PACKET_BYTES,variants=[],cleanup=[],CACHE=64*1024;
let progress;
await mkdir(output,{recursive:true});
const rect=[0,0,10,10],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:10,cssHeight:10,deviceScaleFactor:1}};
const capture=(n,small=false)=>{const captureId=`gateway-packets-${n}`,quad={kind:'solid',matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,opacity:1,color:[n/255,0.2,0.3,1]};return{captureId,producer:'gateway-packets-fixture',timing:{extra:small?[]:Array(16000).fill(0),unicode:'中文😀"\\\n'},resources:[],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:Array(small?1:500).fill(quad)}]}};};
async function group(mode){
 if(mode==='default-four')delete process.env.REMOTE_PAINT_GATEWAY_PACKET_BYTES;else process.env.REMOTE_PAINT_GATEWAY_PACKET_BYTES=String(mode==='cache-pressure'?256*1024:CACHE);
 const broker=new NativeBroker(),pid=broker.child.pid,key=randomBytes(32).toString('hex'),origin='http://127.0.0.1',renderer={name:'gateway-packets-fixture'},sessionId='gateway-packets-fixture',config={host:'127.0.0.1',port:0,origin,key,renderer,sessionId,input:true,producer:'gateway-packets-fixture'},sockets=[],events=[],errors=[],peers=[];let port;
 broker.on('event',event=>events.push(event));broker.on('failure',error=>errors.push(error.message));
 const until=async(predicate,note)=>{const end=Date.now()+5000;while(!await predicate()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,note??'Gateway packet contract deadline');await delay(2);}};
 const stats=async()=>(await broker.request('resourceBudget')).gatewayPackets;
 const open=async path=>{const ws=new WebSocket(`ws://127.0.0.1:${port}${path}`,{origin});sockets.push(ws);ws.on('error',error=>errors.push(error.message));await once(ws,'open');return ws;};
 const peer=async(paired=false)=>{const ws=await open(`/stream?key=${key}`),p={ws,control:null,messages:[],frames:[],wireBytes:[],gate:new LiveFrameGate(),closes:[]};peers.push(p);ws.on('close',(code,reason)=>p.closes.push({code,reason:reason.toString()}));ws.on('message',(bytes,binary)=>{try{assert.equal(binary,false);const message=JSON.parse(bytes);p.messages.push(message);if(message.type==='SceneUpdate'){p.wireBytes.push(bytes.length);p.gate.stage(message.frame);}if(message.type==='FrameCommit'){const frame=p.gate.commit(message.pageEpoch,message.frameId);assert.ok(frame);p.frames.push(frame);ws.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));}}catch(error){errors.push(error.stack);}});
  ws.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:paired?['control-channel-v1']:[]}));
  if(mode==='minimum-pressure')return p;
  await until(()=>p.messages.some(x=>x.type==='Welcome'));const welcome=p.messages.find(x=>x.type==='Welcome');assert.equal(welcome.protocol,4);assert.deepEqual(welcome.renderer,renderer);assert.equal(welcome.producer,config.producer);assert.equal(welcome.sessionId,sessionId);
  if(paired){const control=await open(`/control?key=${key}&peer=${welcome.peerId}&ticket=${welcome.control.ticket}`);p.control=control;const messages=[];control.on('message',bytes=>messages.push(JSON.parse(bytes)));control.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:welcome.peerId,sessionId}));await until(()=>messages.some(x=>x.type==='ControlWelcome'));assert.deepEqual(messages[0],{type:'ControlWelcome',protocol:4,peerId:welcome.peerId,sessionId});}
  return p;
 };
 const stop=async()=>{for(const socket of sockets)if(socket.readyState===WebSocket.OPEN)socket.close();await until(()=>peers.every(p=>p.closes.length>0));await broker.request('stop');let final;await until(async()=>{final=await stats();return final.data.bytes===0&&final.control.bytes===0;},'Gateway packet/cache backing survived stop');assert.equal(final.data.allocations,0);assert.equal(final.control.allocations,0);return final;};
 try{
  ({port}=await broker.request('listen',{config}));progress={mode,stage:'listen'};
  if(mode==='default-four'){
   for(let i=0;i<4;i++)await peer(i%2===0);
   const mapped=[];for(let n=1;n<=8;n++){const frame=await broker.map(capture(n),tags);mapped.push(frame);await broker.request('publish',{serial:frame.brokerSerial});await until(()=>peers.every(p=>p.frames.length===n));for(const p of peers){assert.deepEqual(p.frames[n-1].scene,frame.scene);assert.equal(p.frames[n-1].frameId,n);assert.equal(p.frames[n-1].baseFrameId,n===1?null:n-1);assert.equal(p.frames[n-1].native.timing.extra.length,16000);}}
   const held=await stats();assert.equal(held.scope,'gateway-packet-pool');assert.equal(held.cacheMetadataBytes,CACHE);assert.ok(held.data.bytes>CACHE);assert.ok(held.data.allocations<=10,'Same delta should be shared by four viewers');assert.ok(held.data.peak<=held.data.limit);assert.equal(held.ready,true);await broker.resetScene();const reset=await stats();assert.equal(reset.data.bytes,CACHE);assert.equal(reset.data.allocations,1);assert.equal(reset.control.bytes,0);const final=await stop();variants.push({mode,viewers:4,paired:2,framesPerViewer:8,totalCommitted:32,fullFrames:4,deltaFrames:28,exactScenes:true,denseTimingNodes:16000,maximumWireBytes:Math.max(...peers.flatMap(p=>p.wireBytes)),held,reset,final,pidUnchanged:broker.child.pid===pid});
  }else if(mode==='cache-pressure'){
   const p=await peer();for(let n=1;n<=2;n++){const frame=await broker.map(capture(n),tags);await broker.request('publish',{serial:frame.brokerSerial});await until(()=>p.frames.length===n);assert.deepEqual(p.frames[n-1].scene,frame.scene);}
   const before=await stats();assert.equal(before.ready,true,'Budget polling must reclaim evictable cached delta');assert.equal(before.data.bytes,CACHE);assert.equal(p.closes.length,0,'Cache reclamation must not require closing the active peer');
   const third=await broker.map(capture(3),tags);await broker.request('publish',{serial:third.brokerSerial});await until(()=>p.frames.length===3);assert.deepEqual(p.frames[2].scene,third.scene);
   progress.stage='fourth-delta';const denied=await broker.map(capture(4),tags);await broker.request('publish',{serial:denied.brokerSerial});await until(()=>p.closes.length>0,'Gateway packet pressure did not close sender');assert.deepEqual(p.closes[0],{code:1013,reason:'Gateway packet allocation pressure'});assert.equal(p.frames.length,3,'Denied packet escaped as a fourth commit');const held=await stats();assert.ok(held.data.denied>0);assert.ok(held.data.peak<=held.data.limit);assert.equal(held.ready,true);assert.equal(held.data.bytes,CACHE);assert.equal(broker.closed,false);
   const recovered=await peer();await until(()=>recovered.frames.length===1);assert.deepEqual(recovered.frames[0].scene,denied.scene);assert.equal(recovered.frames[0].baseFrameId,null);await broker.resetScene();const reset=await stats();assert.equal(reset.data.bytes,CACHE);assert.equal(reset.control.bytes,0);const final=await stop();variants.push({mode,before,budgetPollingReclaimsCache:true,activePeerContinuedWithoutReset:true,close:p.closes[0],committedBeforeDenial:3,deniedFrameNotCommitted:true,held,reset,recoveredFullFrame:true,recoveredWithoutReset:true,final,pidUnchanged:broker.child.pid===pid});
  }else{
   const p=await peer();await until(()=>p.closes.length>0);assert.deepEqual(p.closes[0],{code:1013,reason:'Gateway packet allocation pressure'});assert.equal(p.messages.length,0);const held=await stats();assert.equal(held.data.bytes,CACHE);assert.ok(held.data.denied>0);const final=await stop();variants.push({mode,deniedBeforeWelcome:true,close:p.closes[0],held,final,pidUnchanged:broker.child.pid===pid});
  }
  assert.deepEqual(errors,[]);
 }finally{
  for(const socket of sockets)socket.terminate();await broker.close();const released={mode,childExited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners,stdoutBytes:broker.child.stdout.readableLength,stderrBytes:broker.child.stderr.readableLength};cleanup.push(released);assert.deepEqual(released,{mode,childExited:true,pending:0,requestOwners:0,responseOwners:0,stdoutBytes:0,stderrBytes:0});
 }
}
try{
 for(const mode of ['default-four','cache-pressure','minimum-pressure'])await group(mode);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust Gateway final packet/delta cache ownership:four simultaneous viewers(two paired),32 commits match mapped scenes and exact frame/base metadata with16000-node timing. Explicit256KiB budget polling evicts cached delta and continues the same live peer without reset;actual subsequent quota denial closes1013 before fourth commit. Budget polling reclaims evictable cache,then same Broker accepts a fresh full frame without reset;explicit reset also preserves only table credit. Minimum64KiB denies before Welcome. Stop drops actual cache backing and all packet owners;library backing/JSON/command owners are separate accepted scopes. No pixels,OS/RSS,config/peer/index/other builders or wholeSession claim.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),variants,cleanup};await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,variants,cleanup},null,2));throw error;}
finally{if(previous===undefined)delete process.env.REMOTE_PAINT_GATEWAY_PACKET_BYTES;else process.env.REMOTE_PAINT_GATEWAY_PACKET_BYTES=previous;}
