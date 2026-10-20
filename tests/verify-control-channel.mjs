// Native Rust transport/lease contract with fixture capture and fake CDP;
// pixel correctness is verified separately by the native browser gates.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {ControlLease} from '../live/input.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {AssetCache,decodeAsset} from '../protocol/asset-wire.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {fakeSource,payload} from './live-helpers.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(predicate,timeout=5000)=>{const end=Date.now()+timeout;while(!predicate()){assert.ok(Date.now()<end,'Control channel progress deadline');await pause(2);}};
const netem=process.env.REMOTE_PAINT_BULK_NETEM==='1';
const tc=(...args)=>execFileSync('tc',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const clearNetwork=()=>{if(netem){try{tc('qdisc','del','dev','lo','root');}catch{}}};
const broker=new NativeBroker(),source=fakeSource(),cdpCalls=[];
Object.assign(source,{broker,pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640,deviceScaleFactor:1},inputSeq:0,page:{evaluate:async()=>null}});
source.control=new ControlLease(source,{send:async(method,params)=>cdpCalls.push({method,params})});
let serial=0,transport;const sockets=[];
async function publish(large=false){
 const captureId=`priority-${++serial}`,rect=[0,0,960,640],bytes=large?Buffer.concat([payload,randomBytes(8*1024*1024)]):payload;
 const capture={captureId,producer:'control-contract',resources:[{localId:1,width:960,height:640,quadScale:1,skp:bytes.toString('base64'),...(large?{assetRanges:[{offset:payload.length,bytes:bytes.length-payload.length,kind:'font'}]}:{})}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}};
 source.latest=await broker.map(capture,{epoch:1,viewportVersion:1,viewport:source.viewport});
 if(transport)await broker.request('publish',{serial:source.latest.brokerSerial});return bytes;
}
async function open(path){const ws=new WebSocket(`${transport.streamOrigin.replace('http','ws')}${path}`,{origin:transport.origin});sockets.push(ws);ws.on('error',()=>{});await once(ws,'open');return ws;}
async function denied(path,origin=transport.origin){const ws=new WebSocket(`${transport.streamOrigin.replace('http','ws')}${path}`,{origin});sockets.push(ws);ws.on('error',()=>{});await assert.rejects(once(ws,'open'),/403/);}
const query=()=>`key=${transport.key}`;
const controlPath=(welcome,ticket=welcome.control.ticket,peer=welcome.peerId)=>`/control?${query()}&peer=${peer}&ticket=${ticket}`;
try{
 await publish();transport=await startLiveTransport(source,{port:0});
 const data=await open(`/stream?${query()}`),gate=new LiveFrameGate(),assets=new AssetCache(),frames=[],messages=[],errors=[];
 let maxChunkBytes=0;
 data.on('message',(bytes,binary)=>{try{
  if(binary){const asset=decodeAsset(bytes);assert.equal(createHash('sha256').update(asset.payload).digest('hex'),asset.id);if(asset.kind==='chunk'){maxChunkBytes=Math.max(maxChunkBytes,asset.payload.length);assets.put(asset.id,asset.payload);}else gate.put(asset.id,asset.payload);return;}
  const message=JSON.parse(bytes);messages.push(message);
  if(message.type==='ResourceManifest'){const bytes=assets.assemble(message);assert.ok(bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),message.id);gate.put(message.id,bytes);}
  if(message.type==='SceneUpdate')gate.stage(message.frame);
  if(message.type==='FrameCommit'){assert.ok(gate.commit(message.pageEpoch,message.frameId));frames.push(gate.committed);data.send(JSON.stringify({type:'FrameAck',pageEpoch:message.pageEpoch,frameId:message.frameId}));}
  if(message.type==='ResourceRelease')for(const id of message.ids)gate.release(id);
 }catch(error){errors.push(error.message);}});
 data.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,capabilities:['asset-chunks-v1','frame-window-v1','control-channel-v1']}));
 await until(()=>messages.some(m=>m.type==='Welcome'));const welcome=messages.find(m=>m.type==='Welcome');assert.match(welcome.control.ticket,/^[a-f0-9]{64}$/);
 await pause(30);assert.equal(frames.length,0,'Data waits until its control connection authenticates');
 await denied(controlPath(welcome,'0'.repeat(64)));
 await denied(controlPath(welcome,welcome.control.ticket,'native-missing'));
 await denied(controlPath(welcome), 'https://invalid-origin.example');
 const control=await open(controlPath(welcome)),controlMessages=[];control.on('message',bytes=>controlMessages.push(JSON.parse(bytes)));
 control.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:welcome.peerId,sessionId:welcome.sessionId}));
 await until(()=>controlMessages.some(m=>m.type==='ControlWelcome')&&frames.length===1);
 await denied(controlPath(welcome));
 control.send(JSON.stringify({type:'AcquireControl',sessionId:welcome.sessionId,pageEpoch:1,viewportVersion:1}));
 await until(()=>controlMessages.some(m=>m.type==='ControlGranted'));const grant=controlMessages.find(m=>m.type==='ControlGranted');
 if(netem){
  assert.equal(process.platform,'linux');
  tc('qdisc','add','dev','lo','root','handle','1:','prio','bands','3','priomap',...Array(16).fill('0'));
  tc('qdisc','add','dev','lo','parent','1:3','handle','30:','netem','delay','40ms','4ms','loss','1%','rate','2mbit');
  tc('filter','add','dev','lo','protocol','ip','parent','1:','prio','1','u32','match','ip','protocol','6','0xff','match','ip','sport',new URL(transport.streamOrigin).port,'0xffff','match','ip','dport',String(data._socket.localPort),'0xffff','flowid','1:3');
 }
 data._socket.pause();const bulkStarted=performance.now(),bytes=await publish(true);await pause(800);
 const latencies=[];
 for(let i=0;i<16;i++){
  const started=performance.now(),seq=grant.nextSeq+i;
  control.send(JSON.stringify({...grant,type:'Input',seq,event:{kind:'text',text:'x'}}));
  await until(()=>controlMessages.some(m=>m.type==='InputAck'&&m.seq===seq&&m.accepted));latencies.push(performance.now()-started);
 }
 assert.ok(Math.max(...latencies)<300,'Paused bulk data cannot block input confirmation');
 data._socket.resume();await until(()=>frames.length===2,netem?90000:5000);assert.deepEqual(Buffer.from(gate.resources.get(frames[1].requiredResources[0])),bytes);assert.ok(maxChunkBytes<=32*1024);
 const bulkMs=performance.now()-bulkStarted,network=netem?JSON.parse(tc('-s','-j','qdisc','show','dev','lo')):null;
 assert.equal(cdpCalls.filter(c=>c.method==='Input.insertText').length,16);assert.deepEqual(errors,[]);
 const controlClosed=once(control,'close'),dataClosed=once(data,'close');control.send(JSON.stringify({type:'FrameAck',frameId:1,pageEpoch:1}));
 assert.equal((await controlClosed)[0],1008);await dataClosed;await until(()=>source.control.mode==='agent');
 clearNetwork();await until(()=>transport.peers.size===0);await publish();
 const viewers=[];
 for(let i=0;i<4;i++){
  const ws=await open(`/stream?${query()}`),messages=[];ws.on('message',(bytes,binary)=>{if(!binary){const message=JSON.parse(bytes);messages.push(message);if(message.type==='FrameCommit')ws.send(JSON.stringify({type:'FrameAck',frameId:message.frameId,pageEpoch:message.pageEpoch}));}});
  ws.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,capabilities:['control-channel-v1']}));await until(()=>messages.some(m=>m.type==='Welcome'));
  viewers.push({ws,welcome:messages.find(m=>m.type==='Welcome')});
 }
 await denied(controlPath(viewers[0].welcome,viewers[0].welcome.control.ticket,viewers[1].welcome.peerId));
 for(const viewer of viewers){const ws=await open(controlPath(viewer.welcome)),messages=[];ws.on('message',bytes=>messages.push(JSON.parse(bytes)));ws.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:viewer.welcome.peerId,sessionId:viewer.welcome.sessionId}));await until(()=>messages.some(m=>m.type==='ControlWelcome'));}
 await until(()=>transport.peers.size===4);await denied(`/stream?${query()}`);
 const report={at:new Date().toISOString(),scope:`Real native Rust data/control WebSockets, 8 MiB fixture font transfer, checksum/reassembly gate and ControlLease with fake CDP; ${netem?'Linux kernel 40ms delay/1% loss/2Mbit applied to data egress only; control connection in separate priority class':'no kernel network impairment'}; no pixel rendering`,inputAcks:latencies.length,inputAckMs:latencies,maxChunkBytes,dataReadPauseMs:800,bulkMs,network,allResourceBytesVerified:true,invalidTicketRejected:true,wrongPeerRejected:true,wrongOriginRejected:true,ticketReplayRejected:true,crossViewerFreshTicketRejected:true,controlCloseRevokesLease:true,pairedDataClosed:true,simultaneousViewerPairs:4,fifthViewerRejected:true};
 await mkdir('artifacts/network',{recursive:true});await writeFile('artifacts/network/control-channel.json',JSON.stringify(report,null,2));console.log(report);
}finally{clearNetwork();for(const socket of sockets)socket.terminate();await transport?.close();await source.control.close();await broker.close();}
