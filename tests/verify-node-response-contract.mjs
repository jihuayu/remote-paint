import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {setImmediate as turn} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {responseFixture} from './response-child-fixture.mjs';

const directory=await mkdtemp(join(tmpdir(),'response-max-')),binary=join(directory,'fixture.mjs');await writeFile(binary,responseFixture);await chmod(binary,0o700);await mkdir('artifacts/node-response-contract',{recursive:true});
const broker=new NativeBroker({binary});let report;
try{
 await once(broker,'event');await turn();const overhead=Buffer.byteLength(JSON.stringify({id:1,result:''})),bytes=90*1024*1024-overhead,before=broker.responses.stats(),concat=Buffer.concat,allocate=Buffer.allocUnsafeSlow;let concatCalls=0,allocations=[];
 Buffer.concat=(...args)=>{concatCalls++;return concat(...args);};Buffer.allocUnsafeSlow=size=>{const buffer=allocate(size);if(size>80*1024*1024)allocations.push({bytes:size,backingBytes:buffer.buffer.byteLength});return buffer;};
 let result,elapsedMs;
 try{const started=performance.now();result=await broker.request('echo',{bytes});elapsedMs=performance.now()-started;}finally{Buffer.concat=concat;Buffer.allocUnsafeSlow=allocate;}
 assert.equal(result.length,bytes);assert.equal(concatCalls,0);assert.deepEqual(allocations,[{bytes:90*1024*1024,backingBytes:90*1024*1024}]);await turn();
 const status=await broker.request('resourceBudget');assert.equal(status.ready,true);assert.equal(result.length,bytes);assert.ok(status.nodeResponses.peakDataBytes<=status.nodeResponses.dataLimit);assert.equal(status.nodeResponses.dataBytes,0);assert.equal(broker.responses.stats().copiedBodyBytes-before.copiedBodyBytes,90*1024*1024+Buffer.byteLength(JSON.stringify({id:2,result:{ready:true,fixture:true}})));
 report={at:new Date().toISOString(),status:'passed',scope:'Real child pipe sends one exact90MiB valid JSON response in32KiB writes under default768MiB data quota. Parent uses one exact private90MiB backing,no Buffer.concat,and a following reserved control succeeds. Returned large string remains retained by caller after transient credits retire;that application graph/decoded-string lifetime is explicitly outside this checkpoint. No RSS or latency SLA claim.',payloadBytes:bytes,packetBytes:90*1024*1024,concatCalls,allocations,elapsedMs,budgetStatus:status.nodeResponses};
}finally{await broker.close();await rm(directory,{recursive:true,force:true});assert.equal(broker.responses.stats().owners,0);}
await writeFile('artifacts/node-response-contract/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,packetBytes:report.packetBytes,concatCalls:report.concatCalls,elapsedMs:report.elapsedMs}));
