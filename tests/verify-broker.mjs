import assert from 'node:assert/strict';
import {NativeBroker} from '../native/broker.mjs';
import {SceneMapper} from '../capture/scene.mjs';
import {payload} from './live-helpers.mjs';
const native={captureId:'broker-contract',producer:'fixture',frameToken:1,sourceFrame:1,resources:[{localId:19,quadScale:1,width:100,height:100,requiresIsolation:false,skp:payload.toString('base64')}],viz:{captureId:'broker-contract',namespace:[1,2],passes:[{id:'root',output:[0,0,100,100],quads:[{kind:'picture',namespace:[1,2],localId:19,matrix:[1,0,0,0,1,0,0,0,1],visible:[0,0,100,100],rect:[0,0,100,100],contentOrigin:[0,0],opacity:1,vizResource:3}]}]}};
const broker=new NativeBroker(),tags={epoch:1,viewport:{cssWidth:100,cssHeight:100,deviceScaleFactor:1},viewportVersion:1};
try{
 const expected=new SceneMapper().map(native,1),actual=await broker.map(native,tags);
 assert.deepEqual(actual.scene,expected.scene);assert.deepEqual([...actual.payloads.keys()],[...expected.payloads.keys()]);
 const incremental=structuredClone(native);delete incremental.resources[0].skp;incremental.resources[0].resourceId=[...actual.payloads.keys()][0];incremental.viz.passes[0].quads[0].matrix[5]=-20;
 const next=await broker.map(incremental,tags);assert.deepEqual(next.mappings,actual.mappings);assert.equal(next.scene.passes[0].quads[0].matrix[5],-20);
 const bad=structuredClone(native);bad.resources[0].resourceId='0'.repeat(64);await assert.rejects(broker.map(bad,tags),/checksum mismatch/);
 bad.resources[0]=native.resources[0];bad.viz.passes[0].quads[0].namespace=[3,4];await assert.rejects(broker.map(bad,tags),/Child Surface/);
 await broker.resetScene();const epoch2=await broker.map(incremental,{...tags,epoch:2});assert.equal(epoch2.pageEpoch,2);assert.deepEqual(epoch2.mappings.map(m=>m.resourceId),actual.mappings.map(m=>m.resourceId));
 await broker.reset();await assert.rejects(broker.map(incremental,tags),/cache miss/);
 console.log('Native mapper: JS parity, incremental references, checksum, namespace and reset verified');
}finally{await broker.close();}
