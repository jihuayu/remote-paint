import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {connect} from 'node:net';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';

const output='artifacts/websocket-backing',previous=process.env.REMOTE_PAINT_WEBSOCKET_BACKING_BYTES,variants=[],cleanup=[];
const FIXED=2*1024*1024,DATA=FIXED+3*(16*1024*1024+64*1024),CONTROL=FIXED+3*128*1024;
let progress;
await mkdir(output,{recursive:true});
async function group(mode){
 if(mode==='four-pairs')delete process.env.REMOTE_PAINT_WEBSOCKET_BACKING_BYTES;else process.env.REMOTE_PAINT_WEBSOCKET_BACKING_BYTES=String((mode==='fixed-pressure'?8:64)*1024*1024);
 const broker=new NativeBroker(),pid=broker.child.pid,events=[],sockets=[],partials=[],failures=[],key=randomBytes(32).toString('hex'),origin='http://127.0.0.1',renderer={name:'websocket-backing-fixture'},sessionId='websocket-backing-fixture';let port;
 broker.on('event',event=>events.push(event));broker.on('failure',error=>failures.push(error.message));
 const until=async(predicate,note)=>{const end=Date.now()+4500;while(!await predicate()){assert.deepEqual(failures,[]);assert.ok(Date.now()<end,note??'WebSocket backing contract deadline');await delay(2);}};
 const stats=async()=>(await broker.request('resourceBudget')).websocketBacking;
 const empty=async()=>{await until(async()=>{const s=await stats();return s.bytes===0&&s.allocations===0;},'WebSocket library owners did not release');const s=await stats();assert.ok(s.peak<=s.limit);assert.equal(s.ready,true);assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);return s;};
 const open=async(path,denied)=>{const ws=new WebSocket(`ws://127.0.0.1:${port}${path}`,{origin});sockets.push(ws);ws.on('error',()=>{});if(denied){await assert.rejects(once(ws,'open'),new RegExp(String(denied)));return;}await once(ws,'open');return ws;};
 const peer=async(paired=false)=>{
  const data=await open(`/stream?key=${key}`),messages=[],closes=[];
  data.on('close',(code,reason)=>closes.push({channel:'data',code,reason:reason.toString()}));data.on('message',(bytes,binary)=>{if(!binary)messages.push(JSON.parse(bytes));});
  data.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:paired?['control-channel-v1']:[]}));await until(()=>messages.some(x=>x.type==='Welcome'));
  const welcome=messages.find(x=>x.type==='Welcome');let control=data;
  if(paired){control=await open(`/control?key=${key}&peer=${welcome.peerId}&ticket=${welcome.control.ticket}`);control.on('close',(code,reason)=>closes.push({channel:'control',code,reason:reason.toString()}));control.on('message',bytes=>messages.push(JSON.parse(bytes)));control.send(JSON.stringify({type:'HelloControl',protocol:4,peerId:welcome.peerId,sessionId}));await until(()=>messages.some(x=>x.type==='ControlWelcome'));}
  return{data,control,welcome,messages,closes};
 };
 const partial=async()=>{const socket=connect({host:'127.0.0.1',port});partials.push(socket);socket.on('error',()=>{});await once(socket,'connect');socket.write('GET /stream HTTP/1.1\r\n');return socket;};
 const release=async()=>{for(const socket of sockets)if(socket.readyState===WebSocket.OPEN)socket.close();for(const socket of partials)socket.destroy();return await empty();};
 try{
  ({port}=await broker.request('listen',{config:{renderer,producer:'websocket-backing-fixture',key,origin,host:'127.0.0.1',port:0,input:true,sessionId}}));
  progress={mode,stage:'connected',pid};
  if(mode==='four-pairs'){
   const peers=[];for(let i=0;i<4;i++)peers.push(await peer(true));await open(`/stream?key=${key}`,403);
   const message={type:'Input',sessionId,pageEpoch:1,viewportVersion:1,seq:1,event:{kind:'text',text:'中文😀',padding:'a'.repeat(32000)}};assert.ok(Buffer.byteLength(JSON.stringify(message))<32*1024);
   for(const p of peers){p.control.send(JSON.stringify(message));p.control.ping('probe');}
   await until(()=>events.filter(x=>x.event==='Control').length===4);for(const event of events.filter(x=>x.event==='Control'))assert.deepEqual(event.message,message);
   const held=await stats();assert.equal(held.scope,'websocket-library-backing-pool');assert.equal(held.fixedConnectionBytes,FIXED);assert.equal(held.rawMessageBytes,FIXED);assert.equal(held.writeFactor,3);assert.ok(held.bytes>=4*(DATA+CONTROL));assert.ok(held.bytes<=4*(DATA+CONTROL)+8*FIXED);assert.equal(held.ready,true);
   const released=await release();variants.push({mode,pairs:4,fifthDenied:403,exactEvents:4,inputBytes:Buffer.byteLength(JSON.stringify(message)),held,released,pidUnchanged:broker.child.pid===pid});
  }else if(mode==='role-pressure'){
   const p=await peer();await open(`/stream?key=${key}`,503);const held=await stats();assert.ok(held.denied>0);assert.ok(held.bytes>=DATA&&held.bytes<=DATA+FIXED);
   const message={type:'Input',event:{kind:'text',text:'after failed handshake'}};p.data.send(JSON.stringify(message));await until(()=>events.some(x=>x.event==='Control'&&x.peerId===p.welcome.peerId));
   const released=await release();const recovered=await peer();assert.equal(recovered.data.readyState,WebSocket.OPEN);const recoveredReleased=await release();variants.push({mode,deniedHttp:503,existingInputPreserved:true,held,released,recoveredReleased,pidUnchanged:broker.child.pid===pid});
  }else if(mode==='raw-pressure'){
   const p=await peer();progress.stage='fill-fixed-handshakes';for(let i=0;i<6;i++)await partial();await until(()=>p.closes.length>0,'Raw payload admission did not close saturated reader');assert.equal(p.closes[0].code,1013);assert.equal(p.closes[0].reason,'WebSocket backing allocation pressure');
   const held=await stats();assert.ok(held.denied>0);assert.ok(held.peak<=held.limit);const released=await release();const recovered=await peer();assert.equal(recovered.data.readyState,WebSocket.OPEN);const recoveredReleased=await release();variants.push({mode,partialHandshakes:6,close:p.closes[0],held,released,recoveredReleased,pidUnchanged:broker.child.pid===pid});
  }else{
   for(let i=0;i<4;i++)await partial();await until(async()=>{const s=await stats();return s.bytes===4*FIXED;});const denied=await partial();let ended=denied.destroyed;denied.on('close',()=>{ended=true;});await until(()=>ended,'Fixed HTTP admission did not reject before parsing');const held=await stats();assert.equal(held.bytes,4*FIXED);assert.ok(held.denied>0);const released=await release();variants.push({mode,incompleteHandshakes:4,fifthClosedBeforeHttpParse:true,held,released,pidUnchanged:broker.child.pid===pid});
  }
  await broker.request('stop');assert.deepEqual(failures,[]);
 }finally{
  for(const socket of sockets)socket.terminate();for(const socket of partials)socket.destroy();await broker.close();const released={mode,childExited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners,stdoutBytes:broker.child.stdout.readableLength,stderrBytes:broker.child.stderr.readableLength};cleanup.push(released);assert.deepEqual(released,{mode,childExited:true,pending:0,requestOwners:0,responseOwners:0,stdoutBytes:0,stderrBytes:0});
 }
}
try{
 for(const mode of ['four-pairs','role-pressure','raw-pressure','fixed-pressure'])await group(mode);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Gateway WebSocket library backing admission:default four simultaneous authenticated pairs and sub32KiB UTF8 input,64MiB role failure503 and raw-read pressure1013,8MiB fixed HTTP preparse denial,all credits returned after actual close and same Broker recovery. No allocator usable-size/RSS/PSS,OS socket/thread,other Gateway builders or fullSession claim.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),variants,cleanup};await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,variants,cleanup},null,2));throw error;}
finally{if(previous===undefined)delete process.env.REMOTE_PAINT_WEBSOCKET_BACKING_BYTES;else process.env.REMOTE_PAINT_WEBSOCKET_BACKING_BYTES=previous;}
