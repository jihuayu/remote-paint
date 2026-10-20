import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';

assert.equal(typeof global.gc,'function','Run with --expose-gc');
const output='artifacts/node-stream-close';await mkdir(output,{recursive:true});
const fixture=`#!/usr/bin/env node
let input=Buffer.alloc(0);
function packet(value){const body=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32BE(body.length);return Buffer.concat([head,body]);}
process.stdout.on('error',()=>process.exit(0));process.stderr.on('error',()=>process.exit(0));
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4){const bytes=input.readUInt32BE();if(input.length<bytes+4)return;const message=JSON.parse(input.subarray(4,bytes+4));input=input.subarray(bytes+4);
 if(message.op==='ready')process.stdout.write(packet({id:message.id,result:true}));
 else if(message.op==='fill'){
  const one=packet({event:'MustNotDispatchFromDiscard',padding:'x'.repeat(32*1024)}),wire=Buffer.concat(Array(64).fill(one));
  if(message.fragmented){let offset=0;const timer=setInterval(()=>{if(offset>=wire.length){clearInterval(timer);return;}const end=Math.min(wire.length,offset+257);process.stdout.write(wire.subarray(offset,end));process.stderr.write(Buffer.alloc(end-offset,255));offset=end;},1);}
  else{process.stdout.write(wire);process.stderr.write(Buffer.alloc(2*1024*1024,255));}
 }
}});
process.stdin.on('end',()=>process.exit(0));
`;
function observe(stream){
 const weak=[],seen=new Set();let views=0,viewBytes=0,backingBytes=0;
 // Observation only. Production cleanup uses public read()/destroy(),not this
 // diagnostic queue access. No strong Buffer/backing escapes this helper.
 for(const bytes of stream.readableBuffer){if(!Buffer.isBuffer(bytes))continue;views++;viewBytes+=bytes.length;weak.push(new WeakRef(bytes));if(!seen.has(bytes.buffer)){seen.add(bytes.buffer);backingBytes+=bytes.buffer.byteLength;weak.push(new WeakRef(bytes.buffer));}}
 return {weak,summary:{views,viewBytes,backingBytes}};
}
async function collect(refs){for(let n=0;n<16;n++){await turn();global.gc();await turn();if(refs.every(ref=>ref.deref()===undefined))return true;await delay(1);}return false;}
async function until(check){const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'Paused child streams did not fill');await delay(5);}}
const report={at:new Date().toISOString(),status:'running',nodeVersion:process.version,platform:process.platform,scope:'Real child stdout/stderr queues on paused binary streams,normal/forced/fragmented close,and forced-GC reachability while closed Broker and streams remain retained. No natural-GC/RSS or active-stream admission claim.',variants:[]};
try{
 for(const mode of ['normal','forced','fragmented']){
  const directory=await mkdtemp(join(tmpdir(),'node-stream-close-')),binary=join(directory,'fixture.mjs');await writeFile(binary,fixture);await chmod(binary,0o700);const broker=new NativeBroker({binary});let waiting;
  try{
   assert.equal(await broker.request('ready'),true);await turn();await turn();const retained={broker,stdout:broker.child.stdout,stderr:broker.child.stderr};retained.stdout.pause();retained.stderr.pause();
   let protocolEvents=0,closedDataCallbacks=0,closedReadableCallbacks=0;broker.on('event',()=>protocolEvents++);waiting=broker.request('fill',{fragmented:mode==='fragmented'});waiting.catch(()=>{});
   await until(()=>retained.stdout.readableLength>=retained.stdout.readableHighWaterMark&&retained.stderr.readableLength>=retained.stderr.readableHighWaterMark);
   const stdout=observe(retained.stdout),stderr=observe(retained.stderr),refs=[...stdout.weak,...stderr.weak];assert.ok(refs.length>=4);const before={stdout:stdout.summary,stderr:stderr.summary};assert.equal(protocolEvents,0);
   for(const stream of [retained.stdout,retained.stderr]){stream.on('data',()=>{if(broker.closed)closedDataCallbacks++;});stream.on('readable',()=>{if(broker.closed)closedReadableCallbacks++;});}
   const parse=JSON.parse;let parses=0;JSON.parse=(...args)=>{parses++;return parse(...args);};
   try{if(mode==='forced')broker.fail(new Error('forced stream teardown'));await broker.close();await assert.rejects(waiting,mode==='forced'?/forced stream teardown/:/Native Broker closed/);}finally{JSON.parse=parse;}
   const collectible=await collect(refs),after={stdout:retained.stdout.readableLength,stderr:retained.stderr.readableLength,collectible,closedDataCallbacks,closedReadableCallbacks,parses,protocolEvents,childExited:broker.exited};const result={mode,before,after};report.variants.push(result);await writeFile(output+'/progress.json',JSON.stringify(report,null,2));
   assert.equal(after.stdout,0);assert.equal(after.stderr,0);assert.equal(collectible,true,'Retained closed Broker/stream still pins unread Buffer/backing');assert.equal(closedDataCallbacks,0);assert.equal(closedReadableCallbacks,0);assert.equal(parses,0);assert.equal(protocolEvents,0);assert.equal(broker.pending.size,0);assert.equal(broker.requestMemory.stats().owners,0);assert.equal(broker.responses.stats().owners,0);assert.equal(broker.exited,true);
  }finally{await broker.close();if(waiting)await Promise.allSettled([waiting]);await rm(directory,{recursive:true,force:true});}
 }
 report.status='passed';await writeFile(output+'/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,variants:report.variants.map(v=>({mode:v.mode,queuedViewBytes:v.before.stdout.viewBytes+v.before.stderr.viewBytes,queuedBackingBytes:v.before.stdout.backingBytes+v.before.stderr.backingBytes,...v.after}))}));
}catch(error){report.status='failed';report.error=error.stack;await writeFile(output+'/failed.json',JSON.stringify(report,null,2));throw error;}
