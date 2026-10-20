import assert from 'node:assert/strict';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {responseFixture} from './response-child-fixture.mjs';

assert.equal(typeof global.gc,'function','Run this verifier with --expose-gc');
const directory=await mkdtemp(join(tmpdir(),'response-lifetime-')),binary=join(directory,'fixture.mjs');await writeFile(binary,responseFixture);await chmod(binary,0o700);
const broker=new NativeBroker({binary});let weakBuffer,weakBacking;const allocate=Buffer.allocUnsafeSlow;
Buffer.allocUnsafeSlow=bytes=>{const buffer=allocate(bytes);if(bytes>=2*1024*1024){weakBuffer=new WeakRef(buffer);weakBacking=new WeakRef(buffer.buffer);}return buffer;};
async function collect(){for(let n=0;n<16;n++){await turn();global.gc();await turn();if(!weakBuffer.deref()&&!weakBacking.deref())return true;await delay(1);}return false;}
const retained={broker};let report;
try{
 await once(broker,'event');retained.result=await broker.request('echo',{bytes:3*1024*1024});await turn();
 assert.equal(retained.result.length,3*1024*1024);assert.equal(broker.responses.stats().privatePacketBackingBytes,0);assert.equal(await collect(),true,'Consumed private response is still reachable');
 const consumedCollectible=true,waiting=assert.rejects(broker.request('partial-known'),/Native Broker closed/);
 const end=Date.now()+5000;while(broker.responses.stats().privatePacketBackingBytes<4*1024*1024){assert.ok(Date.now()<end,'Partial response did not allocate its declared backing');await delay(5);}
 retained.diagnostic=broker.outputBuffer;await turn();global.gc();assert.ok(weakBuffer.deref()&&weakBacking.deref(),'Live incomplete response backing was not retained');
 await broker.close();await waiting;assert.equal(await collect(),true,'Retained closed Broker or diagnostic snapshot pins a response backing');assert.equal(retained.diagnostic.buffer.byteLength,4*1024*1024);assert.equal(retained.result.length,3*1024*1024);
 const stats=broker.responses.stats();assert.equal(stats.owners,0);assert.equal(stats.receivedBackingBytes,0);
 report={status:'passed',consumedCollectible,partialRetainedUntilClose:true,retainedClosedBrokerCollectible:true,returnedStringStillRetained:true,scope:'Forced-GC reachability of private Buffer+ArrayBuffer only. Application result/decoded strings remain outside the receive/parse transient ledger;not natural GC timing,VM heap or physical RSS return.'};
}finally{Buffer.allocUnsafeSlow=allocate;await broker.close();await rm(directory,{recursive:true,force:true});}
console.log(JSON.stringify(report));
