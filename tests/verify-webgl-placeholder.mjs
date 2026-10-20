import assert from 'node:assert/strict';
import {NativeBroker} from '../native/broker.mjs';
import {validateScene} from '../protocol/live-wire.mjs';

const broker=new NativeBroker();
const q={kind:'picture',namespace:[1,2],localId:9,matrix:[1,0,20,0,1,10,0,0,1],visible:[0,0,100,80],rect:[0,0,100,80],contentOrigin:[0,0],clip:[20,10,90,60],opacity:0.5,roundedClip:[20,10,90,60,5,5,5,5,5,5,5,5]};
const capture={captureId:'webgl',producer:'contract',resources:[],webglLayers:[9],viz:{captureId:'webgl',namespace:[1,2],passes:[{id:'root',output:[0,0,200,150],quads:[q]}]}};
const tags={epoch:1,viewportVersion:1,viewport:{cssWidth:200,cssHeight:150,deviceScaleFactor:1}};
try{
 const mapped=await broker.map(capture,tags),out=mapped.scene.passes[0].quads[0];
 assert.equal(out.kind,'placeholder');assert.equal(out.reason,'webgl');assert.equal(mapped.payloads.size,0);
 for(const field of ['matrix','visible','rect','clip','opacity','roundedClip'])assert.deepEqual(out[field],q[field]);
 validateScene(mapped.scene,[],tags.viewport);
 delete capture.webglLayers;
 await assert.rejects(broker.map(capture,tags),/Missing native layer/);
 capture.webglLayers=[9];q.namespace=[4,5];
 await assert.rejects(broker.map(capture,tags),/Child Surface/);
 q.namespace=[1,2];capture.webglLayers=[9,9];
 await assert.rejects(broker.map(capture,tags),/Duplicate WebGL/);
 console.log('WebGL placeholder: native classification, geometry, clipping, opacity and resource failure isolation passed');
}finally{await broker.close();}
