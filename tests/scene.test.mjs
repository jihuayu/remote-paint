import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {SceneMapper} from '../capture/scene.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {validateScene} from '../protocol/live-wire.mjs';
const rect=[0,0,100,100],matrix=[1,0,0,0,1,0,0,0,1];
const capture=()=>({captureId:'capture-a',producer:'123:4',frameToken:7,sourceFrame:8,
 resources:[{localId:19,quadScale:1,width:100,height:100,skp:Buffer.concat([Buffer.from('skiapict'),Buffer.alloc(24)]).toString('base64')}],
 viz:{captureId:'capture-a',namespace:[4,2],passes:[{id:'5',output:rect,quads:[{kind:'picture',contentOrigin:[0,0],localId:19,namespace:[4,2],matrix,rect,visible:rect,opacity:1,vizResource:77}]}]}});
test('native rounded input clips survive mapping and reject invalid radii before decoding',()=>{
 const native=capture(),rounded=[10,10,70,50,6,6,6,6,6,6,6,6];native.viz.passes[0].quads[0].roundedClip=rounded;
 const mapped=new SceneMapper().map(native,1),viewport={cssWidth:100,cssHeight:100};
 assert.deepEqual(mapped.scene.passes[0].quads[0].roundedClip,rounded);validateScene(mapped.scene,[...mapped.payloads.keys()],viewport);
 mapped.scene.passes[0].quads[0].roundedClip=[...rounded];mapped.scene.passes[0].quads[0].roundedClip[4]=-1;
 assert.throws(()=>validateScene(mapped.scene,[...mapped.payloads.keys()],viewport),/rounded clip/);
 native.viz.passes[0].quads[0].roundedClip=rounded.slice(1);assert.throws(()=>new SceneMapper().map(native,1),/rounded clip/);
});
test('map actual namespaced stable layer IDs; remapped Viz handles never identify content',()=>{
 const mapper=new SceneMapper();const a=capture();const first=mapper.map(a,1);const old=first.mappings[0];
 a.viz.passes[0].quads[0].vizResource=900;a.viz.passes[0].quads[0].matrix=[1,0,0,0,1,-40,0,0,1];
 const second=mapper.map(a,1);assert.deepEqual(second.mappings[0],old);
 assert.equal(second.scene.passes[0].quads[0].source.vizResource,900);
 a.viz.passes[0].quads[0].namespace=[8,2];assert.throws(()=>mapper.map(a,1),/Child Surface/);
 a.viz.passes[0].quads[0].namespace=[4,2];a.viz.captureId='another';assert.throws(()=>mapper.map(a,1),/Unpaired/);
});
test('release logical resources, and never reuse a released revision within an epoch',()=>{
 const mapper=new SceneMapper();const a=capture();const first=mapper.map(a,1).mappings[0];
 const b=capture();b.viz.passes[0].quads=[];const released=mapper.map(b,1);assert.deepEqual(released.released,[first.logical]);
 const next=mapper.map(a,1).mappings[0];assert.ok(next.revision>first.revision);
 assert.notEqual(mapper.map(a,2).mappings[0].logical,first.logical);
});
test('private length-prefixed Viz IPC correlates one requested frame and rejects unknown/oversize packets',async()=>{
 const ipc=await startVizIPC();
 async function send(buffer){await new Promise((resolve,reject)=>{const socket=net.createConnection(ipc.endpoint);socket.on('connect',()=>socket.end(buffer));socket.on('error',reject);socket.on('close',resolve);});}
 async function persistentSend(buffers){await new Promise((resolve,reject)=>{const socket=net.createConnection(ipc.endpoint);socket.on('connect',()=>socket.end(Buffer.concat(buffers)));socket.on('error',reject);socket.on('close',resolve);});}
 const encode=value=>{const body=Buffer.from(JSON.stringify(value)),size=Buffer.alloc(4);size.writeUInt32BE(body.length);return Buffer.concat([size,body]);};
 try{
  assert.equal((await stat(ipc.endpoint)).mode&0o777,0o600);
  const wanted=ipc.waitFor('x'),wanted2=ipc.waitFor('y');
  await persistentSend([encode({type:'VizScene',captureId:'x',passes:[]}),encode({type:'VizScene',captureId:'y',passes:[]})]);
  assert.equal((await wanted).captureId,'x');assert.equal((await wanted2).captureId,'y');
  await send(encode({type:'VizScene',captureId:'not-registered'}));
  const size=Buffer.alloc(4);size.writeUInt32BE(1024*1024);await send(size);
  assert.equal(ipc.stats.received,2);assert.equal(ipc.stats.rejected,2);
 }finally{await ipc.close();}
});

test('rebased tile coordinates move full-layer content while retaining its immutable resource',()=>{
 const mapper=new SceneMapper(),native=capture();const first=mapper.map(native,1);
 native.viz.passes[0].quads[0].contentOrigin=[0,-700];
 const next=mapper.map(native,1);
 assert.deepEqual(next.mappings,first.mappings);
 assert.deepEqual(next.scene.passes[0].quads[0].contentOrigin,[0,-700]);
 native.viz.passes[0].quads[0].contentOrigin=[0,Infinity];
 assert.throws(()=>mapper.map(native,1),/Invalid native content origin/);
});

test('incremental native resources reuse the mapper cache and verify their checksum',()=>{
 const mapper=new SceneMapper(),firstNative=capture(),first=mapper.map(firstNative,1);
 const id=first.mappings[0].resourceId;
 const incremental=capture();delete incremental.resources[0].skp;incremental.resources[0].resourceId=id;
 const second=mapper.map(incremental,1);
 assert.deepEqual(second.mappings,first.mappings);
 assert.deepEqual([...second.payloads.keys()],[id]);
 const corrupted=capture();corrupted.resources[0].resourceId='0'.repeat(64);
 assert.throws(()=>mapper.map(corrupted,1),/checksum/);
});

const variant=(n,size=32)=>{const value=capture(),bytes=Buffer.alloc(size);bytes.write('skiapict');bytes.writeUInt32LE(n,8);value.resources[0].skp=bytes.toString('base64');return value;};
const mapperState=mapper=>({entries:mapper.entries,resources:[...mapper.resources],memory:[...mapper.resourceMemory],bytes:mapper.resourceBytes,revision:mapper.revision,epoch:mapper.epoch});
function unchanged(mapper,before){assert.equal(mapper.entries,before.entries);assert.deepEqual(mapperState(mapper),before);for(const [id,bytes]of before.resources)assert.equal(mapper.resources.get(id),bytes);}
function incremental(native,id){const next=structuredClone(native);delete next.resources[0].skp;next.resources[0].resourceId=id;return next;}

test('rejected Node scenes cannot accumulate a cache-sized flood or consume revisions/epochs',()=>{
 const mapper=new SceneMapper(),native=capture(),first=mapper.map(native,1),before=mapperState(mapper);
 let rejected;
 for(let n=1;n<=140;n++){
  rejected=variant(n,1024*1024);rejected.viz.passes[0].quads.push({...rejected.viz.passes[0].quads[0],kind:'unknown'});
  assert.throws(()=>mapper.map(rejected,n%2?1:2),/Unknown Viz quad/);unchanged(mapper,before);
 }
 // A failed payload was never admitted; the last committed hash still works.
 const failedId=createHash('sha256').update(Buffer.from(rejected.resources[0].skp,'base64')).digest('hex');
 assert.throws(()=>mapper.map(incremental(native,failedId),1),/cache miss/);unchanged(mapper,before);
 const recovered=mapper.map(incremental(native,first.mappings[0].resourceId),1);assert.deepEqual(recovered.mappings,first.mappings);
});

test('Node protocol/viewport and metadata validation precede every cache and descriptor commit',()=>{
 const mapper=new SceneMapper(),native=capture(),first=mapper.map(native,1),before=mapperState(mapper),id=first.mappings[0].resourceId;
 const profile=structuredClone(native);Object.assign(profile.resources[0],{assetRangeVersion:1,assetRangesComplete:true,assetRanges:[]});
 assert.throws(()=>mapper.map(profile,2,{cssWidth:99,cssHeight:100}),/Root viewport mismatch/);unchanged(mapper,before);assert.equal(mapper.resourceMemory.get(id),null);
 const longPass=variant(7);longPass.viz.passes[0].id='p'.repeat(65);assert.throws(()=>mapper.map(longPass,1),/Invalid render pass/);unchanged(mapper,before);
 const metadata=variant(8),quad={...metadata.viz.passes[0].quads[0],vizResource:'x'.repeat(256)};metadata.viz.passes[0].quads=Array.from({length:1500},()=>({...quad}));
 assert.throws(()=>mapper.map(metadata,1),/Scene metadata budget/);unchanged(mapper,before);
 const upgraded=mapper.map(profile,1);assert.deepEqual(upgraded.resourceMemory.resources[id],{imageBytes:0,fontBytes:0});assert.deepEqual(upgraded.mappings,first.mappings);
});

test('Node scene-byte rejection leaves committed resources and incremental recovery intact',()=>{
 const mapper=new SceneMapper(),native=capture(),first=mapper.map(native,1),before=mapperState(mapper),big=variant(20,13*1024*1024),quad=big.viz.passes[0].quads[0];
 big.resources=[];big.viz.passes[0].quads=[];
 for(let n=0;n<5;n++){const record=variant(n+20,13*1024*1024).resources[0];record.localId=19+n;big.resources.push(record);big.viz.passes[0].quads.push({...quad,localId:record.localId});}
 assert.throws(()=>mapper.map(big,1),/Scene resource budget/);unchanged(mapper,before);
 assert.deepEqual(mapper.map(incremental(native,first.mappings[0].resourceId),1).mappings,first.mappings);
});

test('Node history stays within both byte and index limits while returned snapshots remain valid',()=>{
 const mapper=new SceneMapper(),native=capture(),first=mapper.map(native,1),oldBytes=first.payloads.values().next().value;
 for(let n=1;n<=9;n++){mapper.map(variant(n,16*1024*1024),1);assert.ok(mapper.resourceBytes<=128*1024*1024);}
 assert.ok(mapper.resources.size<=8);assert.equal(mapper.resourceBytes,128*1024*1024);assert.equal(first.payloads.values().next().value,oldBytes);assert.equal(oldBytes.subarray(0,8).toString(),'skiapict');
 mapper.reset();for(let n=1;n<=520;n++){mapper.map(variant(n),1);assert.ok(mapper.resources.size<=512);}
 assert.equal(mapper.resources.size,512);assert.equal(mapper.resourceMemory.size,512);
 const evicted=variant(1),id=createHash('sha256').update(Buffer.from(evicted.resources[0].skp,'base64')).digest('hex'),before=mapperState(mapper);
 assert.throws(()=>mapper.map(incremental(evicted,id),1),/cache miss/);unchanged(mapper,before);
});

test('conflicting same-hash and invalid incremental descriptors roll back Node staged upgrades',()=>{
 const mapper=new SceneMapper(),native=capture(),first=mapper.map(native,1),before=mapperState(mapper),id=first.mappings[0].resourceId;
 const conflict=structuredClone(native),record=conflict.resources[0];Object.assign(record,{assetRangeVersion:1,assetRangesComplete:true,assetRanges:[]});
 conflict.resources.push({...record,localId:20,assetRanges:[{offset:8,bytes:16,kind:'font',glyphSlots:1}]});conflict.viz.passes[0].quads.push({...conflict.viz.passes[0].quads[0],localId:20});
 assert.throws(()=>mapper.map(conflict,1),/Conflicting resource memory descriptor/);unchanged(mapper,before);
 const bad=incremental(native,id);Object.assign(bad.resources[0],{assetRangeVersion:1,assetRangesComplete:false,assetRanges:[]});
 assert.throws(()=>mapper.map(bad,1),/Incomplete or incompatible/);unchanged(mapper,before);
});
