import test from 'node:test';
import assert from 'node:assert/strict';
import CanvasKitInit from 'canvaskit-wasm/full';
import {createRequire} from 'node:module';
import {PNG} from 'pngjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});
const matrix=[1,0,0,0,1,0,0,0,1],rect=[0,0,100,100];
const solid=(color,area=rect,extra={})=>({kind:'solid',color,rect:area,visible:area,matrix,opacity:1,clip:null,...extra});
const pixel=(png,x,y)=>[...png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4)];
test('CanvasKit replays Viz front-to-back order, target clips, scrolling transforms and opacity',()=>{
 const renderer=new SceneRenderer(ck);
 const scene={rootPass:'root',passes:[{id:'root',output:rect,quads:[
  solid([1,0,0,1],[0,0,100,20],{opacity:0.5}),
  solid([0,0,1,1],rect,{matrix:[1,0,0,0,1,-40,0,0,1],clip:[0,0,50,100]}),
 ]}]};
 const output=renderer.render(scene,new Map());
 try{
  const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));
  const p=pixel(png,10,10);assert.ok(Math.abs(p[0]-128)<=1&&Math.abs(p[2]-127)<=1);assert.equal(p[3],255);
  assert.deepEqual(pixel(png,10,30),[0,0,255,255]);
  assert.deepEqual(pixel(png,80,30),[0,0,0,0]);assert.deepEqual(pixel(png,10,70),[0,0,0,0]);
 }finally{output.image.delete();output.surface.delete();renderer.clear();}
});
test('CanvasKit composites an earlier render pass at its actual output origin',()=>{
 const renderer=new SceneRenderer(ck);const area=[10,20,30,40];
 const output=renderer.render({rootPass:'root',passes:[
  {id:'child',output:area,quads:[solid([0,1,0,1],area)]},
  {id:'root',output:rect,quads:[{kind:'pass',passId:'child',matrix,rect:area,visible:area,clip:null,opacity:1}]},
 ]},new Map());
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));assert.deepEqual(pixel(png,15,25),[0,255,0,255]);assert.deepEqual(pixel(png,5,5),[0,0,0,0]);}
 finally{output.image.delete();output.surface.delete();renderer.clear();}
});

test('full pictures honor rebased tile origins after clipping in quad coordinates',()=>{
 const recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording(rect),paint=new ck.Paint();
 paint.setColor([1,0,0,1]);canvas.drawRect([0,0,100,50],paint);
 paint.setColor([0,0,1,1]);canvas.drawRect([0,50,100,100],paint);
 const picture=recorder.finishRecordingAsPicture(),bytes=picture.serialize();
 const renderer=new SceneRenderer(ck),output=renderer.render({rootPass:'root',passes:[{id:'root',output:rect,quads:[
  {kind:'picture',resourceId:'cached',width:100,height:100,quadScale:1,contentOrigin:[0,-50],matrix,rect,visible:[0,10,100,60],clip:null,opacity:1},
 ]}]},new Map([['cached',bytes]]));
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));
  assert.deepEqual(pixel(png,10,20),[0,0,255,255]);
  assert.deepEqual(pixel(png,10,5),[0,0,0,0]);assert.deepEqual(pixel(png,10,55),[0,0,0,0]);
 }finally{output.image.delete();output.surface.delete();renderer.clear();picture.delete();recorder.delete();paint.delete();}
});
