import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {payload} from './live-helpers.mjs';

assert.equal(process.platform,'linux');
const output='artifacts/viz-fault-pairing';await mkdir(output,{recursive:true});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),resourceId=hash(payload),u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=s=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);};
const prefix=id=>Buffer.concat([Buffer.from('RPA2\x01\x01'),str(id)]),rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
const metadata=id=>({captureId:id,producer:'viz-fault-pairing',nativeResources:true,resources:[{localId:1,quadScale:1,width:100,height:100,resourceId}]}),raw=id=>Buffer.concat([prefix(id),str(JSON.stringify(metadata(id))),u32(1),str(resourceId),u32(payload.length),payload]);
const scene=id=>({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]});
const capture=id=>({captureId:id,viz:{native:true},nativeResources:true});
const variants=[],cleanup=[];let progress;
async function variant(reason,fullPool){
 const prior=process.env.REMOTE_PAINT_INPUT_POOL_BYTES;process.env.REMOTE_PAINT_INPUT_POOL_BYTES=String(1024*1024);const broker=new NativeBroker();if(prior===undefined)delete process.env.REMOTE_PAINT_INPUT_POOL_BYTES;else process.env.REMOTE_PAINT_INPUT_POOL_BYTES=prior;
 let viz,stream,holder;const faults=[],rejections=[];
 broker.on('event',event=>{if(event.event==='VizReady'&&event.error)faults.push(event);if(event.event==='VizRejected')rejections.push(event);});
 const code=reason===1?'VIZ_OUTPUT_OVERLOAD':'VIZ_OUTPUT_TRANSPORT',message=reason===1?'Viz scene writer overloaded':'Viz scene transport failed';
 const send=body=>new Promise((resolve,reject)=>stream.write(Buffer.concat([u32(body.length),body]),error=>error?reject(error):resolve()));
 const register=async id=>{const ready=viz.waitFor(id);ready.catch(()=>{});await ready.registered;return {ready};};
 const budget=async predicate=>{const end=Date.now()+2000;let previous;while(Date.now()<end){const value=await broker.request('inputBudget');if(predicate(value)&&value.bytes===previous)return value;previous=value.bytes;await delay(5);}throw new Error('Stable Viz input budget deadline');};
 try{
  viz=await startVizIPC({broker,nativeResources:true});stream=net.createConnection(viz.endpoint);await once(stream,'connect');
  const completed=await register('completed');await send(raw('completed'));await send(Buffer.from(JSON.stringify(scene('completed'))));await completed.ready;
  const base=await budget(value=>value.bytes>0),before=await broker.request('mapperStats');
  const partial=await register('partial');await send(Buffer.from(JSON.stringify(scene('partial'))));await partial.ready;
  const rawFirst=await register('raw-first');await send(raw('raw-first'));const beforeHold=await budget(value=>value.bytes>base.bytes+60000);
  const both=await register('both');let heldBytes=0,heldBudget;
  if(fullPool){
   const length=beforeHold.limit-beforeHold.bytes-128;assert.ok(length>256*1024);heldBytes=length+128;
   holder=net.createConnection(viz.endpoint);await once(holder,'connect');holder.write(Buffer.concat([u32(length),prefix('both')]));heldBudget=await budget(value=>value.bytes===value.limit);assert.equal(heldBudget.bytes,1024*1024);
  }
  // Invalid fixed-length control cannot discard or wake any valid pair.
  let mapSettled=false;const mapping=broker.map(capture('partial'),tags);mapping.then(()=>mapSettled=true,()=>mapSettled=true);mapping.catch(()=>{});
  await delay(25);await send(Buffer.from('BAD2\x01\x01\x01'));await delay(25);assert.equal(mapSettled,false);assert.equal(faults.length,0);assert.ok(rejections.some(event=>event.reason==='Invalid Viz fault receipt'));
  const fault=Buffer.from([82,86,69,50,1,1,reason]),fragmentedFault=fullPool&&reason===1;
  if(fragmentedFault){stream.write(Buffer.concat([u32(7),fault.subarray(0,3)]));await delay(25);assert.equal(mapSettled,false,'Incomplete control body was accepted');}
  const started=performance.now();if(fragmentedFault)await new Promise((resolve,reject)=>stream.write(fault.subarray(3),error=>error?reject(error):resolve()));else await send(fault);
  await assert.rejects(mapping,error=>error.code===code&&error.message===message);const failureMs=performance.now()-started;assert.ok(failureMs<2000,'Fault fell through to the existing3s resource pairing timeout');
  await assert.rejects(rawFirst.ready,error=>error.code===code&&error.message===message);await assert.rejects(both.ready,error=>error.code===code&&error.message===message);
  assert.deepEqual(await broker.request('mapperStats'),before);const afterFault=await budget(value=>value.bytes===base.bytes+heldBytes);
  if(fullPool){assert.equal(afterFault.denied,heldBudget.denied,'Fixed fault attempted a denied data allocation');assert.ok(afterFault.bytes>=heldBytes,'Incomplete read returned its still-live buffer credit');}
  holder?.destroy();holder=null;const releasedRead=await budget(value=>value.bytes===base.bytes);
  // Both late publications must remain unregistered. Repeated writer faults
  // must not taint the complete pair or retire it as unfinished.
  await send(raw('raw-first'));await send(Buffer.from(JSON.stringify(scene('both'))));await send(Buffer.from([82,86,69,50,1,1,reason]));
  for(const id of ['partial','raw-first','both'])viz.cancel(id);
  const first=await broker.map(capture('completed'),tags);assert.equal(first.brokerSerial,1);
  const fresh=await register('fresh');await send(raw('fresh'));await send(Buffer.from(JSON.stringify(scene('fresh'))));await fresh.ready;const second=await broker.map(capture('fresh'),tags);assert.equal(second.brokerSerial,2);assert.deepEqual(second.scene,first.scene);
  const final=await budget(value=>value.bytes===0);assert.equal(broker.closed,false);
  const typed=faults.filter(event=>event.code===code).map(event=>event.captureId).sort();assert.deepEqual(typed,['both','partial','raw-first']);
  progress={reason,code,fullPool,fragmentedFault,failureMs,base,beforeHold,heldBudget,heldBytes,afterFault,releasedRead,final,completedSerial:first.brokerSerial,recoveredSerial:second.brokerSerial,typedFaultIds:typed,rejections,vizProxyDiagnostics:viz.stats};variants.push(progress);
 }finally{
  holder?.destroy();stream?.destroy();const steps=await Promise.allSettled([viz?.close(),broker.close()]);const errors=steps.filter(step=>step.status==='rejected').map(step=>step.reason);cleanup.push({reason,fullPool,errors:errors.map(error=>error.stack),brokerExited:broker.exited,nodeRequestOwners:broker.requestMemory.stats().owners});if(errors.length)throw new AggregateError(errors,'Viz fault test cleanup failed');assert.equal(broker.exited,true);assert.equal(broker.requestMemory.stats().owners,0);
 }
}
try{
 for(const reason of [1,2])for(const fullPool of [false,true])await variant(reason,fullPool);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux private RPA2+Viz protocol,overload and transport receipts,normal and fully occupied1MiB Viz input pool. Scene-first map already requested,raw-first and both-unfinished requests reject with precise typed reason under2s;complete pair survives and maps serial1,then a fresh capture maps serial2 on the same stream. Fixed7-byte fault bypasses data admission,while an incomplete packet keeps its actual full reservation until EOF. Malformed/late/repeated messages do not resurrect or retire completed state. No claim that Chromium itself emitted this injected receipt or that actual pending native capture cancellation was observed.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),variants,cleanup};
 await writeFile(`${output}/contract.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,variants:variants.map(({code,fullPool,failureMs,heldBytes,completedSerial,recoveredSerial})=>({code,fullPool,failureMs,heldBytes,completedSerial,recoveredSerial}))}));
}catch(error){await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,variants,cleanup},null,2));throw error;}
