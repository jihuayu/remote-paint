import assert from 'node:assert/strict';
import {NativeBroker} from '../native/broker.mjs';
import {mkdtemp,writeFile,chmod,rm,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises';
assert.equal(typeof global.gc,'function','Run with node --expose-gc');
const directory=await mkdtemp(join(tmpdir(),'request-gc-check-')),binary=join(directory,'broker.mjs');
await writeFile(binary,`#!/usr/bin/env node
let input=Buffer.alloc(0),stalled=[],early=false;const send=v=>{const b=Buffer.from(JSON.stringify(v)),h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));};
send({event:'Ready'});process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);if(!early&&input.length>64){const prefix=input.subarray(4,256).toString();if(prefix.includes('"op":"early"')){early=true;const id=Number(prefix.match(/^\\{"id":(\\d+),/)[1]);send({id,result:'early'});process.stdin.pause();setInterval(()=>{},1000);return;}}while(!early&&input.length>=4){const n=input.readUInt32BE();if(input.length<n+4)return;const r=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);if(r.op==='stall'){stalled.push(r.id);send({event:'Received'});}else{for(const id of stalled.splice(0))send({id,result:true});send({id:r.id,result:true});}}});
`);await chmod(binary,0o700);
let broker,weakBuffer,weakBacking;
function request(op){const original=Buffer.allocUnsafeSlow;Buffer.allocUnsafeSlow=bytes=>{const buffer=original(bytes);if(bytes>1024*1024){weakBuffer=new WeakRef(buffer);weakBacking=new WeakRef(buffer.buffer);}return buffer;};try{return broker.request(op,{text:'中'.repeat(1024*1024)});}finally{Buffer.allocUnsafeSlow=original;}}
async function collect(){await immediate();for(let n=0;n<4;n++){global.gc();await delay(10);}return {bufferAlive:!!weakBuffer.deref(),backingAlive:!!weakBacking.deref(),stats:broker.requestMemory.stats()};}
let progress;
try{
 broker=new NativeBroker({binary,requestLimits:{dataBytes:16*1024*1024}});await once(broker,'event');const pending=request('stall');pending.catch(()=>{});await once(broker,'event');
 const writtenPending=await collect();assert.equal(broker.pending.size,1);assert.equal(writtenPending.stats.packetBackingBytes,0);assert.equal(writtenPending.bufferAlive,false,'Pending timer retained its already-written packet');assert.equal(writtenPending.backingAlive,false);assert.ok(writtenPending.stats.retainedEstimate>0);
 await broker.reset();await pending;const replied=await collect();assert.equal(replied.stats.owners,0);await broker.close();
 broker=new NativeBroker({binary,requestLimits:{dataBytes:16*1024*1024}});await once(broker,'event');assert.equal(await request('early'),'early');
 const blockedAfterReply=await collect();assert.equal(broker.pending.size,0);assert.ok(blockedAfterReply.stats.packetBackingBytes>3*1024*1024);assert.equal(blockedAfterReply.bufferAlive,true);assert.equal(blockedAfterReply.backingAlive,true);
 await broker.close();const closed=await collect();assert.equal(closed.stats.packetBackingBytes,0);assert.equal(closed.stats.owners,0);assert.equal(closed.bufferAlive,false,'Retained closed Broker still holds a packet');assert.equal(closed.backingAlive,false);
 progress={writtenPending,replied,blockedAfterReply,closed};
 const report={at:new Date().toISOString(),status:'passed',scope:'Real subprocess pipes and explicit GC/WeakRefs in Node parent. A consumed write is collectible while its RPC timer remains pending;an early RPC reply does not release the still-blocked pipe packet;retaining the closed Broker object does not pin its Buffer/backing after process/stream cleanup. Forced-GC reachability evidence,not natural GC timing,allocator/RSS return or child/Rust memory.',nodeSources:Object.fromEntries(await Promise.all(['native/broker.mjs','native/request-json.mjs','native/request-memory.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(name)).digest('hex')]))),...progress};
 await mkdir('artifacts/node-request-lifetime',{recursive:true});await writeFile('artifacts/node-request-lifetime/report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/node-request-lifetime',{recursive:true});await writeFile('artifacts/node-request-lifetime/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress},null,2));throw error;}
finally{await broker?.close();await rm(directory,{recursive:true,force:true});}
