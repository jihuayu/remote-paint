import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {NativeBroker} from '../native/broker.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {payload} from './live-helpers.mjs';
const broker=new NativeBroker(),viz=await startVizIPC({broker,nativeResources:true}),socket=net.createConnection(viz.endpoint);
const hash=createHash('sha256').update(payload).digest('hex'),tags={epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1}};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;},str=s=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);},send=body=>socket.write(Buffer.concat([u32(body.length),body]));
const metadata=id=>({captureId:id,producer:'native-test',resources:[{localId:1,quadScale:1,width:100,height:100,resourceId:hash}],nativeResources:true});
const scene=id=>({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:[0,0,100,100],quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect:[0,0,100,100],visible:[0,0,100,100],contentOrigin:[0,0],opacity:1,vizResource:1}]}]});
try{
 await once(socket,'connect');
 const pending=viz.waitFor('raw-first');await pending.registered;
 send(Buffer.from(JSON.stringify(scene('raw-first'))));
 const ref=await pending;
 // Native map waits for its separately arriving resource packet; Node never
 // receives the raw SKP, base64 SKP or resource metadata in the completion.
 const map=broker.map({captureId:'raw-first',nativeResources:true,viz:ref},tags);
 const body=Buffer.concat([Buffer.from('RPA2\x01\x01'),str('raw-first'),str(JSON.stringify(metadata('raw-first'))),u32(1),str(hash),u32(payload.length),payload]);
 for(let offset=0;offset<body.length;offset+=7){if(!offset)socket.write(u32(body.length));socket.write(body.subarray(offset,offset+7));}
 const first=await map;assert.equal(first.scene.passes[0].quads[0].resourceId,hash);
 const second=viz.waitFor('raw-cached');await second.registered;
 send(Buffer.concat([Buffer.from('RPA2\x01\x01'),str('raw-cached'),str(JSON.stringify(metadata('raw-cached'))),u32(0)]));send(Buffer.from(JSON.stringify(scene('raw-cached'))));
 const cached=await broker.map({captureId:'raw-cached',nativeResources:true,viz:await second},{...tags,epoch:2});assert.equal(cached.scene.passes[0].quads[0].resourceId,hash);
 console.log('Native SKP IPC: fragmented raw payload, out-of-order scene/resources, hash-only epoch reuse, no Node resource bytes passed');
}finally{socket.destroy();await viz.close();await broker.close();}
