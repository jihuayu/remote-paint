import assert from 'node:assert/strict';
import CanvasKitInit from 'canvaskit-wasm/full';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {NativeBroker} from '../native/broker.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')}),broker=new NativeBroker();
const make=color=>{const recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,256,256]),paint=new ck.Paint();canvas.clear(ck.TRANSPARENT);paint.setColor(color);canvas.drawRect([0,0,256,256],paint);const pic=recorder.finishRecordingAsPicture(),bytes=Buffer.from(pic.serialize());pic.delete();paint.delete();recorder.delete();return bytes;};
const payloads=[make([1,0,0,1]),make([0,0,1,1])],ids=payloads.map(b=>createHash('sha256').update(b).digest('hex')),resources=new Map(ids.map((id,i)=>[id,payloads[i]]));
const capture={captureId:'tile-contract',producer:'contract',resources:payloads.map((b,i)=>({localId:7,quadScale:1,width:256,height:256,tileOrigin:[i*256,0],resourceId:ids[i],skp:b.toString('base64'),requiresIsolation:true})),viz:{captureId:'tile-contract',namespace:[1,2],passes:[{id:'root',output:[0,0,512,256],quads:[{kind:'picture',localId:7,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],visible:[0,0,256,256],rect:[0,0,512,256],contentOrigin:[0,0],opacity:1,vizResource:1}]}]}};
const tags={epoch:1,viewportVersion:1,viewport:{cssWidth:512,cssHeight:256,deviceScaleFactor:1}};
try{
 const first=await broker.map(capture,tags);assert.equal(first.payloads.size,1);
 for(const r of capture.resources)delete r.skp;capture.viz.passes[0].quads[0].visible=[0,0,512,256];
 const second=await broker.map(capture,tags);assert.equal(second.payloads.size,2,'offscreen native resources must already be cached before their hash becomes visible');
 const renderer=new SceneRenderer(ck),out=renderer.render(second.scene,resources,ck.WHITE);
 try{const read=x=>[...out.image.readPixels(x,10,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];assert.deepEqual(read(100),[255,0,0,255]);assert.deepEqual(read(300),[0,0,255,255]);assert.deepEqual(read(256),[0,0,255,255]);}finally{out.image.delete();out.surface.dispose();renderer.clear();}
 capture.viz.passes[0].quads[0].contentOrigin=[-128,0];const moved=await broker.map(capture,tags);assert.equal(moved.scene.passes[0].quads[0].contentOrigin[0],-128);assert.equal(moved.scene.passes[0].quads[1].contentOrigin[0],128);
 console.log('Native tile expansion: pixel composition, seam boundary, rebased coordinates and offscreen hash reuse passed');
}finally{await broker.close();}
