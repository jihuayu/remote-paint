import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setImmediate as immediate} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {payload} from './live-helpers.mjs';

const broker=new NativeBroker({requestLimits:{dataBytes:2*1024*1024}}),rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const capture=(id,bytes)=>({captureId:id,producer:'node-request-contract',resources:[{localId:1,quadScale:1,width:100,height:100,skp:bytes.toString('base64'),resourceId:hash(bytes)}],viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}});
let progress;
try{
 const first=await broker.map(capture('first',payload),tags),before=await broker.request('mapperStats');await immediate();const pid=broker.child.pid,seq=broker.seq;
 const large=Buffer.concat([payload,Buffer.alloc(2*1024*1024,31)]);let pressure;
 await assert.rejects(broker.map(capture('denied',large),tags),error=>{pressure={code:error.code,budget:error.budget,phase:error.phase};return error.code==='INPUT_BUDGET_PRESSURE'&&error.budget==='node-request';});
 assert.equal(broker.seq,seq);assert.equal(broker.child.pid,pid);assert.equal(broker.closed,false);assert.equal(broker.requestMemory.stats().packetBackingBytes,0);await immediate();
 assert.deepEqual(await broker.request('mapperStats'),before);const budgetStatus=await broker.request('resourceBudget');assert.equal(budgetStatus.nodeRequests.scope,'node-broker-requests');assert.ok(budgetStatus.nodeRequests.peakDataBytes<=budgetStatus.nodeRequests.dataLimit);assert.ok(budgetStatus.nodeRequests.denied>0);
 const reuse=capture('reuse',payload);delete reuse.resources[0].skp;const second=await broker.map(reuse,tags);assert.equal(second.brokerSerial,2);assert.deepEqual(second.scene,first.scene);await immediate();
 const after=broker.requestMemory.stats();assert.equal(after.dataBytes,0);assert.equal(after.controlBytes,0);assert.equal(after.packetBackingBytes,0);assert.equal(after.owners,0);
 progress={pressure,before,budgetStatus,after,firstSerial:first.brokerSerial,reusedSerial:second.brokerSerial};
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust Broker with explicit2MiB Node outbound-request estimate quota. A real small SKP maps,then a2MiB enlarged protocol fixture is rejected in Node before packet allocation/write;request ID,process and exact Rust Mapper state remain unchanged. Reserved control/status works,and prior hash-only resource reuse commits serial2. No pixel claim for the denied fixture;default45MiB/full native57.8MB contracts run separately. Node packet backing is exact,graph/serialization are estimates,not full VM/RSS or Rust stdin coverage.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),nodeSources:Object.fromEntries(await Promise.all(['native/broker.mjs','native/request-json.mjs','native/request-memory.mjs'].map(async name=>[name,hash(await readFile(name))]))),...progress};
 await mkdir('artifacts/node-request-budget',{recursive:true});await writeFile('artifacts/node-request-budget/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/node-request-budget',{recursive:true});await writeFile('artifacts/node-request-budget/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress},null,2));throw error;}
finally{await broker.close();}
