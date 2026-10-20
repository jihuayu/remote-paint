import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {decodeResource} from '../protocol/wire.mjs';
const directory=resolve(process.env.REMOTE_PAINT_RAW_PING_DIR),events=[],errors=[];let socket,ready,grant,pingStart,pingQueued,pongMs=null,resourceAt=null,resourceBytes=null,commit=false,wireBytes=0,bytesAtPing=0,pingExpired=false,failure,closing=false,timer;
const token=randomUUID(),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),exists=async name=>readFile(join(directory,name),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
async function until(predicate,label,ms=15000){const end=performance.now()+ms;while(!await predicate()){assert.deepEqual(errors,[]);assert.ok(performance.now()<end,label);await delay(5);}}
function sendPing(){
 if(pingStart!==undefined||wireBytes<1024)return;pingStart=performance.now();bytesAtPing=wireBytes;events.push({kind:'ping-start',atMs:pingStart,wireBytes,resourceComplete:resourceAt!==null});
 timer=setTimeout(()=>{pingExpired=true;events.push({kind:'original-ping-deadline',elapsedMs:performance.now()-pingStart});},3000);
 socket.ping(token,error=>{if(error)errors.push(error.message);else{pingQueued=performance.now();events.push({kind:'ping-write-callback',elapsedMs:pingQueued-pingStart});}});
}
try{
 await until(async()=>ready=await exists('ready.json'),'Owned Source ready',30000);await writeFile(join(directory,'ticket-request.json'),'{}\n',{mode:0o600,flag:'wx'});await until(async()=>grant=await exists('ticket-reply.json'),'Fresh read-only consumer ticket');
 socket=new WebSocket(`ws://127.0.0.1:${ready.port}/consume?ticket=${grant.ticket}`,{origin:ready.origin,handshakeTimeout:3000});socket.on('error',error=>errors.push(error.message));socket.on('close',(code)=>{if(!closing)errors.push('Unexpected consumer close '+code);});
 socket.on('pong',data=>{if(data.toString()!==token)return;pongMs=performance.now()-pingStart;clearTimeout(timer);events.push({kind:'pong',elapsedMs:pongMs,resourceComplete:resourceAt!==null,wireBytes});});
 socket.on('message',(bytes,binary)=>{try{
  if(binary){assert.equal(resourceAt,null);const resource=decodeResource(bytes);assert.equal(resource.id,ready.payloadSha256);assert.equal(hash(resource.payload),ready.payloadSha256);assert.equal(resource.payload.byteLength,ready.payloadBytes);resourceAt=performance.now();resourceBytes=resource.payload.byteLength;events.push({kind:'resource-complete',sincePingMs:resourceAt-pingStart});return;}
  const message=JSON.parse(bytes);if(message.type==='Welcome'){assert.equal(message.consumerKind,'recording');assert.equal(message.ackStage,'consumer-released');assert.equal(message.input,false);assert.equal(message.control,null);events.push({kind:'authorized-recording'});}else if(message.type==='FrameCommit'){assert.notEqual(resourceAt,null);commit=true;socket.send(JSON.stringify({type:'FrameAck',pageEpoch:message.pageEpoch,frameId:message.frameId,stage:'consumer-released'}));events.push({kind:'commit'});}
 }catch(error){errors.push(error.stack);}});
 socket.once('open',()=>{
  // Test-only access to the pinned ws8.18.3 socket counts actual incoming TCP
  // bytes before logical-message reassembly. No data is removed or delayed.
  socket._socket.on('data',bytes=>{wireBytes+=bytes.byteLength;sendPing();});
  socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:ready.renderer,consumerKind:'recording',capabilities:['scene-consumer-v1']}));
 });
 await until(()=>commit&&pongMs!==null,'Actual raw resource/commit and matching Pong',20000);assert.deepEqual(errors,[]);assert.ok(pingStart!==undefined);assert.ok(bytesAtPing<ready.payloadBytes);assert.ok(pingQueued>=pingStart);assert.equal(resourceBytes,ready.payloadBytes);
 assert.equal(pingExpired,false,'Actual Gateway ping exceeded original3000ms during large raw resource');assert.ok(pongMs<3000);assert.ok(events.find(e=>e.kind==='pong').resourceComplete===false,'Pong must arrive before the raw Binary message finishes');
}catch(error){failure=error.stack;}
finally{
 closing=true;clearTimeout(timer);socket?.terminate();await writeFile(join(directory,'stop.json'),'{}\n',{mode:0o600,flag:'wx'});
}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual Rust Gateway/read-only recording ticket/no asset-chunks or frame-window negotiation,8MiB synthetic SKP-header raw resource under owned Source egress40ms/2ms/1%/20Mbit. Actual ping starts at firstTCPpayload and retainsoriginal3000ms deadline. Full resource SHA/content andcommit preserved;not website capture,rendered pixels,originalfailedPID/solefailurecause,600s/8h/all41 acceptance.',brokerSha256:ready?.brokerSha256,payloadBytes:ready?.payloadBytes,payloadSha256:ready?.payloadSha256,pongMs,pingExpired,bytesAtPing,resourceBytes,commit,wireBytes,events,errors,...(failure?{error:failure}:{})};
await writeFile(join(directory,'client-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,pongMs,pingExpired,payloadBytes:report.payloadBytes,bytesAtPing,commit,error:failure}));if(failure)throw new Error(failure);
