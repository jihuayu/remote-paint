// Actual Rust Broker/TCP policy, with explicit Source resize/CDP fixtures.
// No Browser, CanvasKit or native capture is started by this contract.
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {ControlLease} from '../live/input.mjs';
import {startLiveTransport} from '../live/transport.mjs';
const {values}=parseArgs({options:{binary:{type:'string'},output:{type:'string'}}});assert.ok(values.binary&&values.output);await mkdir(values.output,{recursive:true});
function inbox(ws){const messages=[],waiters=[];ws.on('message',bytes=>{const value=JSON.parse(bytes.toString());messages.push(value);for(const waiter of [...waiters])if(waiter.match(value)){waiters.splice(waiters.indexOf(waiter),1);clearTimeout(waiter.timer);waiter.resolve(value);}});return {messages,wait(match){const old=messages.find(match);if(old)return Promise.resolve(old);return new Promise((resolve,reject)=>{const waiter={match,resolve,timer:setTimeout(()=>reject(new Error('Native viewport TCP deadline')),3000)};waiters.push(waiter);});}};}
const variants=[];
for(const paired of [false,true]){
 const broker=new NativeBroker({binary:values.binary}),sockets=[],source=Object.assign(new EventEmitter(),{broker,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1},pageEpoch:1,viewportVersion:1,latest:{},inputSeq:0,setDemand(){},page:{evaluate:async()=>null}});let live,calls=0;
 source.resize=async({width,height})=>{calls++;source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};source.viewportVersion++;source.emit('invalidate','viewport');};source.control=new ControlLease(source,{send:async()=>{}});
 try{
  live=await startLiveTransport(source,{port:0,preparedAssets:{wasmSha256:'a'.repeat(64),build:'b'.repeat(64),get:()=>null}});const stream=new WebSocket(live.streamOrigin.replace('http:','ws:')+'/stream?key='+live.key,{origin:live.origin});sockets.push(stream);stream.on('error',()=>{});const data=inbox(stream);await once(stream,'open');stream.send(JSON.stringify({type:'Hello',protocol:4,renderer:live.renderer,viewerBuild:'b'.repeat(64),capabilities:paired?['control-channel-v1']:[]}));const welcome=await data.wait(m=>m.type==='Welcome');assert.equal(welcome.viewportControl,true);
  let ws=stream,received=data;
  if(paired){ws=new WebSocket(live.streamOrigin.replace('http:','ws:')+'/control?key='+live.key+'&peer='+welcome.peerId+'&ticket='+welcome.control.ticket,{origin:live.origin});sockets.push(ws);ws.on('error',()=>{});received=inbox(ws);await once(ws,'open');ws.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:welcome.peerId,sessionId:welcome.sessionId}));await received.wait(m=>m.type==='ControlWelcome');}
  ws.send(JSON.stringify({type:'AcquireControl',sessionId:welcome.sessionId,pageEpoch:1,viewportVersion:1}));const grant=await received.wait(m=>m.type==='ControlGranted');ws.send(JSON.stringify({type:'ResizeViewport',requestId:1,width:320,height:240,sessionId:grant.sessionId,pageEpoch:grant.pageEpoch,viewportVersion:grant.viewportVersion,lease:grant.lease}));const applied=await received.wait(m=>m.type==='ViewportResized');assert.deepEqual(applied,{type:'ViewportResized',requestId:1,changed:true,pageEpoch:1,viewportVersion:2,viewport:{cssWidth:320,cssHeight:240,deviceScaleFactor:1}});assert.equal(calls,1);await source.control.tail;assert.equal(source.control.mode,'agent');
  const closed=once(ws,'close');ws.send(JSON.stringify({type:'Runtime.evaluate',expression:'must-not-execute'}));assert.equal((await closed)[0],1008);variants.push({paired,capability:true,actualAppliedReply:applied,resizeInvocations:calls,genericExecutionRejected:true});
 }finally{for(const ws of sockets)ws.terminate();await live?.close();await source.control.close();await broker.close();assert.equal(broker.exited,true);assert.equal(broker.pending.size,0);assert.equal(broker.requestMemory.stats().owners,0);assert.equal(broker.responses.stats().owners,0);}
}
const report={status:'passed',actualExitCode:0,scope:'Actual Rust Broker inline/paired TCP control + original ControlLease/Node transport;explicit Source resize/CDP fixture,no Browser/capture/pixel/physical qualification.',binarySha256:createHash('sha256').update(await readFile(values.binary)).digest('hex'),variants,brokerChildrenExited:true};await writeFile(values.output+'/report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,variants:variants.length,brokerChildrenExited:true,binarySha256:report.binarySha256}));
