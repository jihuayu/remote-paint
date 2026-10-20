import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';

// A real subprocess exercises pipe ownership, pending work and process reaping.
const fixture=`#!/usr/bin/env node
let input=Buffer.alloc(0);
const send=value=>{const bytes=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);process.stdout.write(Buffer.concat([header,bytes]));};
process.stdin.on('data',chunk=>{
 input=Buffer.concat([input,chunk]);while(input.length>=4){const size=input.readUInt32BE();if(input.length<size+4)return;const request=JSON.parse(input.subarray(4,size+4));input=input.subarray(size+4);
  if(request.op==='echo')send({id:request.id,result:'x'.repeat(request.bytes)});
  else if(request.op==='pressure')send({id:request.id,error:'Resource allocation budget exceeded',code:'RESOURCE_BUDGET_PRESSURE'});
  else if(request.op==='partial'){const header=Buffer.alloc(4);header.writeUInt32BE(4*1024*1024);process.stdout.write(Buffer.concat([header,Buffer.alloc(256*1024,32)]));}
  else if(request.op==='malformed'){const header=Buffer.alloc(4);header.writeUInt32BE(1);process.stdout.write(Buffer.concat([header,Buffer.from('{')]));}
  else if(request.op==='oversized'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);const header=Buffer.alloc(4);header.writeUInt32BE(90*1024*1024+1);process.stdout.write(header);}
  else if(request.op==='exit')process.exit(7);
 }
});
process.stdin.on('end',()=>{if(process.listenerCount('SIGTERM')===0)process.exit(0);});
`;
async function withBroker(run){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-broker-lifecycle-')),binary=join(directory,'broker.mjs');
 await writeFile(binary,fixture);await chmod(binary,0o700);const broker=new NativeBroker({binary});
 try{await run(broker);}finally{await broker.close();await rm(directory,{recursive:true,force:true});}
}
async function until(predicate){const end=Date.now()+5000;while(!predicate()){assert.ok(Date.now()<end,'Subprocess did not reach the requested state');await delay(5);}}
function released(broker){assert.equal(broker.pending.size,0);assert.equal(broker.outputBuffer.length,0);assert.equal(broker.outputBuffer.buffer.byteLength,0);assert.equal(broker.requestMemory.stats().owners,0);assert.equal(broker.requestMemory.stats().packetBackingBytes,0);assert.equal(broker.responses.stats().owners,0);assert.equal(broker.responses.stats().receivedBackingBytes,0);assert.equal(broker.child.stdout.readableLength,0);assert.equal(broker.child.stderr.readableLength,0);assert.equal(broker.stderr,'');assert.ok(broker.exited);assert.ok(broker.child.stdin.destroyed&&broker.child.stdout.destroyed&&broker.child.stderr.destroyed);}

test('Broker releases completed large output backing buffers and reaps after repeated close',async()=>withBroker(async broker=>{
 const output=await broker.request('echo',{bytes:2*1024*1024});assert.equal(output.length,2*1024*1024);
 assert.equal(broker.outputBuffer.length,0);assert.equal(broker.outputBuffer.buffer.byteLength,0);
 const closed=broker.close();assert.equal(closed,broker.close());await closed;released(broker);
 await assert.rejects(broker.request('echo',{bytes:1}),/closed/);
}));

test('Broker preserves typed allocation pressure without failing the subprocess',async()=>withBroker(async broker=>{
 await assert.rejects(broker.request('pressure'),error=>error.code==='RESOURCE_BUDGET_PRESSURE'&&error.message==='Resource allocation budget exceeded');
 assert.equal(broker.closed,false);assert.equal(await broker.request('echo',{bytes:3}),'xxx');
}));

test('Broker close promptly rejects pending work and discards incomplete output',async()=>withBroker(async broker=>{
 const pending=assert.rejects(broker.request('partial'),/Native Broker closed/);
 await until(()=>broker.outputBuffer.length>128*1024);assert.equal(broker.pending.size,1);
 const closed=broker.close();assert.equal(broker.pending.size,0);assert.equal(broker.outputBuffer.buffer.byteLength,0);
 await pending;await closed;released(broker);
}));

test('Malformed Broker output rejects every pending request and failure still awaits process exit',async()=>withBroker(async broker=>{
 let failures=0;broker.on('failure',()=>failures++);
 const first=assert.rejects(broker.request('malformed'),SyntaxError),second=assert.rejects(broker.request('stall'),SyntaxError);
 await Promise.all([first,second]);assert.equal(broker.closed,true);assert.equal(failures,1);
 await broker.close();released(broker);assert.equal(failures,1);
}));

test('Oversized Broker output kills and reaps a child that ignores SIGTERM',{timeout:10000},async()=>withBroker(async broker=>{
 await assert.rejects(broker.request('oversized'),/output packet limit/);assert.equal(broker.closed,true);
 const closed=broker.close();assert.equal(closed,broker.close());await closed;released(broker);
 assert.equal(broker.child.signalCode,'SIGKILL');
}));

test('Unexpected Broker exit settles pending requests and retains its exit diagnostic',async()=>withBroker(async broker=>{
 await assert.rejects(broker.request('exit'),/exited \(7\)/);await broker.close();released(broker);
}));

test('Failed Broker spawn can be closed repeatedly without leaking pending requests',async()=>{
 const broker=new NativeBroker({binary:join(tmpdir(),'remote-paint-no-such-broker-binary')});
 await assert.rejects(broker.request('echo',{bytes:1}),/ENOENT/);await broker.close();released(broker);
});
