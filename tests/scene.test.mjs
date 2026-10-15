import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {stat} from 'node:fs/promises';
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
 const encode=value=>{const body=Buffer.from(JSON.stringify(value)),size=Buffer.alloc(4);size.writeUInt32BE(body.length);return Buffer.concat([size,body]);};
 try{
  assert.equal((await stat(ipc.endpoint)).mode&0o777,0o600);
  const wanted=ipc.waitFor('x');await send(encode({type:'VizScene',captureId:'x',passes:[]}));assert.equal((await wanted).captureId,'x');
  await send(encode({type:'VizScene',captureId:'not-registered'}));
  const size=Buffer.alloc(4);size.writeUInt32BE(1024*1024);await send(size);
  assert.equal(ipc.stats.received,1);assert.equal(ipc.stats.rejected,2);
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
