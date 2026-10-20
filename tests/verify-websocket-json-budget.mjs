import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';

const output='artifacts/websocket-json',previous=process.env.REMOTE_PAINT_WEBSOCKET_JSON_BYTES,variants=[],cleanup=[];
let progress;
await mkdir(output,{recursive:true});
async function group(small){
 if(small)process.env.REMOTE_PAINT_WEBSOCKET_JSON_BYTES=String(1024*1024);else delete process.env.REMOTE_PAINT_WEBSOCKET_JSON_BYTES;
 const broker=new NativeBroker(),events=[],sockets=[],errors=[],key=randomBytes(32).toString('hex'),origin='http://127.0.0.1',renderer={name:'websocket-json-fixture'},sessionId='websocket-json-fixture';let port;
 broker.on('event',event=>events.push(event));broker.on('failure',error=>errors.push(error.message));
 const until=async predicate=>{const end=Date.now()+5000;while(!predicate()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,'WebSocket JSON contract deadline');await delay(2);}};
 const open=async path=>{const ws=new WebSocket(`ws://127.0.0.1:${port}${path}`,{origin});sockets.push(ws);ws.on('error',error=>errors.push(error.message));await once(ws,'open');return ws;};
 try{
  ({port}=await broker.request('listen',{config:{renderer,producer:'websocket-json-fixture',key,origin,host:'127.0.0.1',port:0,input:true,sessionId}}));
  for(const paired of [false,true]){
   const messages=[],data=await open(`/stream?key=${key}`);let dataCode=null,controlCode=null;data.on('close',code=>{dataCode=code;});data.on('message',(bytes,binary)=>{if(!binary)messages.push(JSON.parse(bytes));});
   const padding=small?{}:{extra:Array(4000).fill(0)};data.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:paired?['control-channel-v1']:[],...padding}));await until(()=>messages.some(message=>message.type==='Welcome'));
   const welcome=messages.find(message=>message.type==='Welcome');let control=data;
   if(paired){control=await open(`/control?key=${key}&peer=${welcome.peerId}&ticket=${welcome.control.ticket}`);control.on('close',code=>{controlCode=code;});control.on('message',bytes=>messages.push(JSON.parse(bytes)));control.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:welcome.peerId,sessionId,...padding}));await until(()=>messages.some(message=>message.type==='ControlWelcome'));}
   const handshake=await broker.request('resourceBudget');if(handshake.websocketJson)assert.equal(handshake.websocketJson.bytes,0,'Validated hello graph retained through connection');
   const message={type:'Input',sessionId,pageEpoch:1,viewportVersion:1,seq:1,event:{kind:'text',text:'中文😀',extra:Array(16000).fill(0)}},wire=JSON.stringify(message);assert.ok(Buffer.byteLength(wire)<32*1024);
   const before=events.filter(event=>event.event==='Control'&&event.peerId===welcome.peerId).length;
   progress={small,paired,stage:'dense-input',inputBytes:Buffer.byteLength(wire),parserStatsExposed:!!handshake.websocketJson,forwarded:()=>events.filter(event=>event.event==='Control'&&event.peerId===welcome.peerId).length-before};control.send(wire);
   if(small){await until(()=>paired?controlCode!==null:dataCode!==null);assert.equal(paired?controlCode:dataCode,1013);assert.equal(events.filter(event=>event.event==='Control'&&event.peerId===welcome.peerId).length,before,'Denied graph escaped as an event');if(paired){await until(()=>dataCode!==null);assert.equal(dataCode,1012);}}
   else{
    await until(()=>events.filter(event=>event.event==='Control'&&event.peerId===welcome.peerId).length===before+1);assert.deepEqual(events.find(event=>event.event==='Control'&&event.peerId===welcome.peerId),{event:'Control',peerId:welcome.peerId,message});
    const closed=once(data,'close');if(paired){const controlClosed=once(control,'close');control.close();await controlClosed;await closed;}else{data.close();await closed;}
   }
   await until(()=>events.some(event=>event.event==='PeerClosed'&&event.peerId===welcome.peerId));
   const stats=await broker.request('resourceBudget');assert.equal(broker.closed,false);assert.equal(stats.ready,true);if(stats.websocketJson){assert.equal(stats.websocketJson.bytes,0);assert.equal(stats.websocketJson.allocations,0);assert.ok(stats.websocketJson.peak<=stats.websocketJson.limit);if(small)assert.ok(stats.websocketJson.denied>0);}
   variants.push({small,paired,inputBytes:Buffer.byteLength(wire),extraNodes:16000,handshakeReleased:handshake.websocketJson?.bytes===0,deniedBeforeEvent:small?true:null,closeCode:small?(paired?controlCode:dataCode):null,pairedDataCloseCode:small&&paired?dataCode:null,exactEvent:small?null:true,brokerAlive:true,stats:stats.websocketJson});
  }
  await broker.request('stop');assert.deepEqual(errors,[]);
 }finally{
  for(const socket of sockets)socket.terminate();await broker.close();const released={small,childExited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners,stdoutBytes:broker.child.stdout.readableLength,stderrBytes:broker.child.stderr.readableLength};cleanup.push(released);assert.deepEqual(released,{small,childExited:true,pending:0,requestOwners:0,responseOwners:0,stdoutBytes:0,stderrBytes:0});
 }
}
try{
 await group(false);await group(true);assert.equal(variants.length,4);assert.ok(variants.every(variant=>variant.stats&&variant.handshakeReleased));
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Gateway fallback/paired WebSocket parsed JSON graph budget. Default valid sub32KiB dense16000-node Input passes and padded hello graph is released after validation. Explicit1MiB parser quota closes dense sender1013 before Control event,paired data closes1012,and same Broker RPC remains ready;all graph/process/Node owners release. No CDP semantics,pixels,raw Tungstenite/frame/HTTP or queue/output-copy/RSS claim.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),variants,cleanup};
 await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress:progress?{...progress,forwarded:progress.forwarded()}:null,variants,cleanup},null,2));throw error;}
finally{if(previous===undefined)delete process.env.REMOTE_PAINT_WEBSOCKET_JSON_BYTES;else process.env.REMOTE_PAINT_WEBSOCKET_JSON_BYTES=previous;}
