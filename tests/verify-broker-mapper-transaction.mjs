import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {NativeBroker} from '../native/broker.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {payload} from './live-helpers.mjs';

const broker=new NativeBroker(),viz=await startVizIPC({broker,nativeResources:true}),socket=net.createConnection(viz.endpoint),rect=[0,0,100,100];
const tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}},hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const quad={kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1,vizResource:1};
const scene=id=>({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{...quad}]}]});
const native=(id,bytes)=>({captureId:id,producer:'transaction-rpc',resources:[{localId:1,quadScale:1,width:100,height:100,resourceId:hash(bytes)}],viz:scene(id)});
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=s=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);};
const send=body=>new Promise((resolve,reject)=>socket.write(Buffer.concat([u32(body.length),body]),error=>error?reject(error):resolve()));
async function mapRaw(value,bytes,epoch=1){
 const pending=viz.waitFor(value.captureId);await pending.registered;
 const metadata={...value,nativeResources:true};delete metadata.viz;
 const blocks=bytes?Buffer.concat([u32(1),str(value.resources[0].resourceId),u32(bytes.length),bytes]):u32(0);
 await send(Buffer.concat([Buffer.from('RPA2\x01\x01'),str(value.captureId),str(JSON.stringify(metadata)),blocks]));await send(Buffer.from(JSON.stringify(value.viz)));
 return broker.map({captureId:value.captureId,nativeResources:true,viz:await pending},{...tags,epoch});
}
async function stats(){const value=await broker.request('mapperStats');assert.equal(value.scope,'mapper-retained-cache');assert.equal(broker.outputBuffer.buffer.byteLength,0);return value;}
let progress;let base64Bytes=0,rawBytes=0;const rejected=[];
try{
 await once(socket,'connect');
 const initial=native('initial',payload),first=await mapRaw(initial,payload),before=await stats();assert.equal(first.brokerSerial,1);
 const reject=async(work,pattern,label)=>{await assert.rejects(work,pattern);assert.deepEqual(await stats(),before);rejected.push(label);};
 for(let n=0;n<140;n++){
  const bytes=Buffer.alloc(1024*1024);payload.copy(bytes);bytes.writeUInt32LE(n+1,bytes.length-4);
  const base=native(`base64-${n}`,bytes);base.resources[0].skp=bytes.toString('base64');base.viz.passes[0].quads.push({...quad,kind:'invalid'});base64Bytes+=bytes.length;
  await reject(broker.map(base,{...tags,epoch:n%2?1:2}),/Unknown quad kind/,'base64-scene');
  const raw=native(`raw-${n}`,bytes);raw.viz.passes[0].output=[0,0,99,100];rawBytes+=bytes.length;
  await reject(mapRaw(raw,bytes,n%2?1:2),/Root viewport mismatch/,'raw-viewport');
  const missing=native(`missing-${n}`,bytes);await reject(broker.map(missing,tags),/cache miss/,'rejected-hash-miss');
 }
 assert.ok(base64Bytes>128*1024*1024&&rawBytes>128*1024*1024);
 const tileBytes=Buffer.concat([payload,Buffer.from('rejected-tile')]),tile=native('invalid-tile',tileBytes);tile.resources[0].tileOrigin=[1,0];
 await reject(mapRaw(tile,tileBytes,2),/Invalid tile origin/,'raw-expansion-before-map');
 const metadata=native('metadata',tileBytes);metadata.resources[0].skp=tileBytes.toString('base64');metadata.viz.passes[0].quads=Array.from({length:1500},()=>({...quad}));
 await reject(broker.map(metadata,{...tags,epoch:2}),/Scene metadata budget/,'late-metadata');
 const upgrade=native('rejected-upgrade',payload);Object.assign(upgrade.resources[0],{assetRangeVersion:1,assetRangesComplete:true,assetRanges:[]});upgrade.viz.passes[0].output=[0,0,99,100];
 await reject(mapRaw(upgrade,null,2),/Root viewport mismatch/,'raw-descriptor-upgrade');
 progress={before,base64Bytes,rawBytes,rejections:rejected.length,afterRejected:await stats()};
 const recovery=native('recovered-hash',payload),recovered=await mapRaw(recovery,null);
 assert.equal(recovered.brokerSerial,2);assert.deepEqual(recovered.scene,first.scene);assert.equal(recovered.resourceMemory,null);
 const changedBytes=Buffer.concat([payload,Buffer.from('accepted-change')]),changed=await mapRaw(native('changed',changedBytes),changedBytes);
 assert.equal(changed.brokerSerial,3);assert.equal(changed.scene.passes[0].quads[0].revision,2);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux arm64 Rust Broker RPC and private Unix RPA2/Viz path. 140 Base64 and140 raw1MiB scene failures,140 follow-up rejected-hash misses, pre-map tile expansion and late metadata/profile failures preserve exact retained-resource/chunk byte counters, entries, epoch, revision and serial. Old native hash-only recovery succeeds at serial2, then a new valid capture commits serial3/revision2. Cache counters cover Mapper-retained ownership only; no complete Session/RSS budget or rendered pixels claimed here.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress,last:await stats(),recovered:{serial:recovered.brokerSerial,revision:recovered.scene.passes[0].quads[0].revision},changed:{serial:changed.brokerSerial,revision:changed.scene.passes[0].quads[0].revision}};
 await mkdir('artifacts/rust-mapper-transaction',{recursive:true});await writeFile('artifacts/rust-mapper-transaction/rollback.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/rust-mapper-transaction',{recursive:true});await writeFile('artifacts/rust-mapper-transaction/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,base64Bytes,rawBytes,rejections:rejected.length},null,2));throw error;}
finally{socket.destroy();await viz.close();await broker.close();}
