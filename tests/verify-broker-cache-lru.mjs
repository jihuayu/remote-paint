import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {NativeBroker} from '../native/broker.mjs';
const broker=new NativeBroker(),rect=[0,0,100,100],tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const make=(id,resources)=>({captureId:id,producer:'cache-contract',resources,viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:rect,quads:resources.map(r=>({kind:'picture',localId:r.localId,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}))}]}});
const check=value=>{assert.ok(value.cacheBytes<=value.cacheByteLimit);assert.ok(value.resources<=value.cacheEntryLimit);assert.ok(value.referenceIndexEntries<=value.referenceIndexLimit);assert.ok(value.chunkIndexEntries<=value.chunkIndexLimit);assert.ok(value.payloadBytes+value.resourceWireBytes+value.manifestBytes+value.cacheOwnedChunkBytes<=value.cacheBytes);};
let progress;
try{
 const resources=[];
 for(let n=1;n<=3;n++){
  const bytes=Buffer.alloc(15*1024*1024);let state=n;for(let i=0;i<bytes.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&255;}bytes.write('skiapict');
  resources.push({localId:n,quadScale:1,width:100,height:100,skp:bytes.toString('base64'),resourceId:hash(bytes)});
 }
 const first=await broker.map(make('cache-first',resources),tags),pressure=await broker.request('mapperStats');check(pressure);assert.equal(first.payloads.size,3);assert.ok(pressure.resources<3);assert.ok(pressure.cacheEvictions>0);
 const incremental=resources.map(({skp,...record})=>record),next=await broker.map(make('cache-reuse',incremental),tags);assert.deepEqual(next.scene,first.scene);assert.equal(next.brokerSerial,2);check(await broker.request('mapperStats'));
 await broker.reset();const reset=await broker.request('mapperStats');assert.equal(reset.resources,0);assert.equal(reset.cacheBytes,0);assert.equal(reset.referenceIndexEntries,0);assert.equal(reset.chunkIndexEntries,0);
 const rejectedBefore=await broker.request('mapperStats');await assert.rejects(broker.map(make('after-reset',incremental),tags),/cache miss/);assert.deepEqual(await broker.request('mapperStats'),rejectedBefore);
 let firstSmall;
 for(let n=1;n<=520;n++){
  const bytes=Buffer.alloc(32);bytes.write('skiapict');bytes.writeUInt32LE(n,8);const record={localId:1,quadScale:1,width:100,height:100,skp:bytes.toString('base64'),resourceId:hash(bytes)};firstSmall??={...record};
  await broker.map(make(`small-${n}`,[record]),tags);check(await broker.request('mapperStats'));
 }
 const indexed=await broker.request('mapperStats');assert.equal(indexed.resources,512);
 delete firstSmall.skp;await assert.rejects(broker.map(make('evicted-old',[firstSmall]),tags),/cache miss/);assert.deepEqual(await broker.request('mapperStats'),indexed);
 progress={pressure,reset,indexed,fullFrameResources:first.payloads.size,hashOnlySerial:next.brokerSerial};
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Rust RPC with three15MiB synthetic header fixtures, not CanvasKit/pixel fixtures. Full45MiB frame still succeeds while strong cache stays below128MiB; uncached snapshot pins retain hash-only reuse. 520 successful small scenes keep512 strong entries and bounded weak indexes; reset releases all retained indexes, and rejected misses preserve state. Does not certify a global snapshot/queued-wire allocation budget.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),...progress};
 await mkdir('artifacts/broker-cache-lru',{recursive:true});await writeFile('artifacts/broker-cache-lru/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/broker-cache-lru',{recursive:true});await writeFile('artifacts/broker-cache-lru/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress},null,2));throw error;}
finally{await broker.close();}
