import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {NativeBroker} from '../native/broker.mjs';

const output='artifacts/mapper-indices',allowance=16*1024*1024;
const saved=process.env.REMOTE_PAINT_MAPPER_INDEX_BYTES,variants=[],cleanup=[];
await mkdir(output,{recursive:true});
const viewport={cssWidth:10,cssHeight:10,deviceScaleFactor:1},rect=[0,0,10,10];
function capture(count,seed){
 const resources=[],quads=[];
 for(let n=0;n<count;n++){
  const bytes=Buffer.alloc(8208);let value=(seed*257+n+1)>>>0;
  for(let i=0;i<bytes.length;i++){value^=value<<13;value^=value>>>17;value^=value<<5;bytes[i]=value&255;}
  bytes.write('skiapict');
  resources.push({localId:n,quadScale:1,width:10,height:10,skp:bytes.toString('base64'),assetRanges:Array.from({length:256},(_,i)=>({offset:16+i*32,bytes:16,kind:'font'}))});
  quads.push({kind:'picture',localId:n,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1});
 }
 const captureId=`mapper-indices-${seed}`;
 return {captureId,producer:'mapper-indices',resources,viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads}]}};
}
function hashOnly(native){
 return {...native,resources:native.resources.map(({skp,...record})=>({...record,resourceId:createHash('sha256').update(Buffer.from(skp,'base64')).digest('hex')}))};
}
async function group(mode){
 process.env.REMOTE_PAINT_MAPPER_INDEX_BYTES=String(mode==='quota'?1024*1024:allowance);
 const broker=new NativeBroker(),pid=broker.child.pid,errors=[];
 broker.on('failure',error=>errors.push(error.message));
 const map=(native,epoch=1)=>broker.map(native,{epoch,viewport,viewportVersion:epoch,metadataOnly:true});
 const stats=()=>broker.request('mapperStats');
 const budget=()=>broker.request('resourceBudget');
 const empty=async()=>{
  const value=await budget(),state=await stats();
  assert.equal(value.mapperIndices.bytes,0);assert.equal(value.mapperIndices.allocations,0);
  assert.equal(state.indexAllowanceBytes,0);
  for(const name of ['strongIndexCapacity','recencyIndexCapacity','referenceIndexCapacity','chunkIndexCapacity'])assert.equal(state[name],0);
  assert.equal(broker.child.pid,pid);return {budget:value,state};
 };
 try{
  const initial=await empty();
  if(mode==='quota'){
   const native=capture(1,1);
   for(let i=0;i<2;i++)await assert.rejects(map(native),error=>error.code==='RESOURCE_BUDGET_PRESSURE'&&error.message==='Mapper index allocation budget exceeded');
   const denied=await empty();assert.ok(denied.budget.mapperIndices.denied>=2);
   assert.equal(denied.budget.bytes,0);assert.equal(denied.budget.snapshots.bytes,0);
   assert.equal(denied.state.serial,0);assert.equal(denied.state.epoch,0);
   await broker.reset();const reset=await empty();
   variants.push({mode,deniedBeforeRetain:true,initial,denied,reset,pidUnchanged:broker.child.pid===pid});
  }else{
   const native=capture(256,2),first=await map(native),held=await stats();
   assert.equal(first.payloads.size,256);assert.equal(held.chunkIndexEntries,8192);
   assert.equal(held.indexAllowanceBytes,allowance);assert.equal(held.mapperIndices.bytes,allowance);assert.equal(held.mapperIndices.allocations,1);
   assert.equal(held.mapperIndices.ready,true);assert.equal(held.mapperIndices.canAdmitMapper,false);
   assert.ok(held.chunkIndexCapacity>=8192);
   // A late validation failure must leave keys,counters,capacities and the
   // previously accepted generation untouched,including index ownership.
   const malformed=capture(1,3);malformed.viz.passes[0].quads.push({...malformed.viz.passes[0].quads[0],kind:'invalid'});
   await assert.rejects(map(malformed,2),/Unknown quad kind/);
   assert.deepEqual(await stats(),held);
   const polled=await budget(),afterPoll=await stats();
   assert.equal(polled.mapperIndices.bytes,allowance);assert.equal(polled.mapperIndices.ready,true);assert.equal(polled.ready,true);
   assert.equal(afterPoll.resources,0);assert.ok(afterPoll.strongIndexCapacity>0);
   assert.equal(afterPoll.chunkIndexEntries,8192);assert.ok(afterPoll.referenceIndexEntries>0);
   const second=await map(hashOnly(native));assert.deepEqual(second.scene,first.scene);
   assert.equal(second.brokerSerial,first.brokerSerial+1);assert.equal(second.payloads.size,256);
   await broker.resetScene();const reclaimed=await budget(),retained=await stats();
   assert.equal(reclaimed.mapperIndices.bytes,allowance);assert.equal(reclaimed.bytes,0);
   assert.equal(retained.resources,0);assert.equal(retained.chunkIndexEntries,0);
   assert.ok(retained.strongIndexCapacity>0&&retained.chunkIndexCapacity>0);
   assert.equal(retained.mapperIndices.allocations,1);
   // Fixed credit covers reuse even while no second Mapper could be admitted.
   const third=await map(capture(1,4));assert.equal(third.payloads.size,1);
   assert.equal((await stats()).mapperIndices.allocations,1);
   await broker.reset();const reset=await empty();assert.equal(reset.budget.bytes,0);
   const fourth=await map(capture(1,5));assert.equal(fourth.payloads.size,1);
   assert.equal((await stats()).mapperIndices.bytes,allowance);
   await broker.reset();const final=await empty();
   variants.push({mode,resources:256,assetRangesPerResource:256,lateFailurePreservedState:true,hashOnlyReuse:true,sameAllowanceContinued:true,resetReturnedActualBuckets:true,held,polled,afterPoll,reclaimed,retained,reset,final,pidUnchanged:broker.child.pid===pid});
  }
  assert.deepEqual(errors,[]);
 }finally{
  await broker.close();const value={mode,childExited:broker.exited,pending:broker.pending.size,requestOwners:broker.requestMemory.stats().owners,responseOwners:broker.responses.stats().owners,stdoutBytes:broker.child.stdout.readableLength,stderrBytes:broker.child.stderr.readableLength};
  cleanup.push(value);assert.deepEqual(value,{mode,childExited:true,pending:0,requestOwners:0,responseOwners:0,stdoutBytes:0,stderrBytes:0});
 }
}
try{
 for(const mode of ['quota','exact-allowance'])await group(mode);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Rust Mapper retained strong/recency/weak-resource/chunk capacities and pre-admitted16MiB allowance.1MiB denies before first retention;256resources*256ranges exercise staged hash indices,late failure rollback,hash-only reuse after strong-cache reclaim,retained empty bucket credit,reset actual backing destruction and same-process readmission. Synthetic SKP-header byte/hash ownership only,no decoded-pixel/RSS/VM/Session claim. Actual native Source and four-SKP pixels are separate regressions.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),variants,cleanup};
 await writeFile(output+'/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,modes:variants.map(v=>v.mode),resources:256,hashOnlyReuse:true,cleanup}));
}catch(error){await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,variants,cleanup},null,2));throw error;}
finally{if(saved===undefined)delete process.env.REMOTE_PAINT_MAPPER_INDEX_BYTES;else process.env.REMOTE_PAINT_MAPPER_INDEX_BYTES=saved;}
