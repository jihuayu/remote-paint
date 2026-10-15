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
test('rounded input clips stay in target coordinates when their caret quad moves',()=>{
 const renderer=new SceneRenderer(ck),roundedClip=[10,10,70,70,20,20,0,0,10,10,0,0];
 const output=renderer.render({rootPass:'root',passes:[{id:'root',output:rect,quads:[
  solid([1,0,0,1],rect,{matrix:[1,0,10,0,1,0,0,0,1],roundedClip}),solid([0,0,1,1]),
 ]}]},new Map());
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));
  assert.deepEqual(pixel(png,40,20),[255,0,0,255]);
  assert.deepEqual(pixel(png,12,12),[0,0,255,255]);
  assert.deepEqual(pixel(png,75,40),[0,0,255,255]);
  assert.deepEqual(pixel(png,68,12),[255,0,0,255]);
  assert.deepEqual(pixel(png,68,68),[0,0,255,255]);
  assert.deepEqual(pixel(png,12,68),[255,0,0,255]);
 }finally{output.image.delete();output.surface.dispose();renderer.clear();}
});
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
 }finally{output.image.delete();output.surface.dispose();renderer.clear();}
});
test('CanvasKit composites an earlier render pass at its actual output origin',()=>{
 const renderer=new SceneRenderer(ck);const area=[10,20,30,40];
 const output=renderer.render({rootPass:'root',passes:[
  {id:'child',output:area,quads:[solid([0,1,0,1],area)]},
  {id:'root',output:rect,quads:[{kind:'pass',passId:'child',matrix,rect:area,visible:area,clip:null,opacity:1}]},
 ]},new Map());
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));assert.deepEqual(pixel(png,15,25),[0,255,0,255]);assert.deepEqual(pixel(png,5,5),[0,0,0,0]);}
 finally{output.image.delete();output.surface.dispose();renderer.clear();}
});

test('premultiplied pass surfaces preserve translucent colors through nested passes',()=>{
 const renderer=new SceneRenderer(ck),output=renderer.render({rootPass:'root',passes:[
  {id:'child',output:rect,quads:[solid([1,0.5,0,0.5])]},
  {id:'root',output:rect,quads:[{kind:'pass',passId:'child',matrix,rect,visible:rect,clip:null,opacity:0.5}]},
 ]},new Map());
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes())),actual=pixel(png,50,50);
  [255,128,0,64].forEach((value,c)=>assert.ok(Math.abs(actual[c]-value)<=1,`${actual}`));
 }finally{output.image.delete();output.surface.dispose();renderer.clear();}
});

test('Viewer white background applies only to the root and preserves transparent child blending',()=>{
 const renderer=new SceneRenderer(ck),output=renderer.render({rootPass:'root',passes:[
  {id:'child',output:rect,quads:[solid([1,0.5,0,0.5])]},
  {id:'root',output:rect,quads:[{kind:'pass',passId:'child',matrix,rect,visible:rect,clip:null,opacity:0.5}]},
 ]},new Map(),ck.WHITE);
 try{
  const pixels=output.image.readPixels(50,50,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB});
  [255,223,191,255].forEach((value,c)=>assert.ok(Math.abs(pixels[c]-value)<=1,`${pixels}`));
 }finally{output.image.delete();output.surface.dispose();renderer.clear();}
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
 }finally{output.image.delete();output.surface.dispose();renderer.clear();picture.delete();recorder.delete();paint.delete();}
});

test('transparent picture clears never punch through previously composed content',()=>{
 const recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,20,20]),paint=new ck.Paint();
 canvas.clear(ck.TRANSPARENT);paint.setColor([1,0,0,1]);canvas.drawCircle(10,10,8,paint);
 const picture=recorder.finishRecordingAsPicture(),renderer=new SceneRenderer(ck);
 const output=renderer.render({rootPass:'root',passes:[{id:'root',output:rect,quads:[
  {kind:'picture',resourceId:'circle',width:20,height:20,quadScale:1,contentOrigin:[0,0],matrix,rect:[0,0,20,20],visible:[0,0,20,20],clip:null,opacity:1},
  solid([0,0,1,1]),
 ]}]},new Map([['circle',picture.serialize()]]));
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));
  assert.deepEqual(pixel(png,1,1),[0,0,255,255]);assert.deepEqual(pixel(png,10,10),[255,0,0,255]);
 }finally{output.image.delete();output.surface.dispose();renderer.clear();picture.delete();recorder.delete();paint.delete();}
});

test('CanvasKit frees actual CPU surface pixel buffers across frames and render errors',()=>{
 const malloc=ck._malloc,free=ck._free,live=new Set();let allocated=0,freed=0;
 ck._malloc=size=>{const pointer=malloc(size);live.add(pointer);allocated++;return pointer;};
 ck._free=pointer=>{if(live.delete(pointer))freed++;free(pointer);};
 const renderer=new SceneRenderer(ck),scene={rootPass:'root',passes:[
  {id:'child',output:rect,quads:[solid([0,1,0,1])]},
  {id:'root',output:rect,quads:[{kind:'pass',passId:'child',matrix,rect,visible:rect,clip:null,opacity:1}]},
 ]};
 try{
  for(let i=0;i<100;i++){
   const output=renderer.render(scene,new Map());
   assert.equal(live.size,1,'Only the returned root surface may retain pixels');
   output.image.delete();output.surface.dispose();assert.equal(live.size,0);
  }
  scene.passes[1].quads[0].kind='invalid';
  assert.throws(()=>renderer.render(scene,new Map()),/Unsupported scene command/);
  assert.equal(live.size,0,'Failed rendering must release every surface buffer');
  assert.equal(allocated,202);assert.equal(freed,allocated);
  const makeSurface=ck.MakeRasterDirectSurface;
  try{
   ck.MakeRasterDirectSurface=()=>null;
   assert.throws(()=>renderer.render({rootPass:'root',passes:[{id:'root',output:rect,quads:[]}]},new Map()),/Cannot allocate/);
   assert.equal(live.size,0,'A refused native surface must free its already allocated buffer');
   assert.equal(allocated,203);assert.equal(freed,allocated);
  }finally{ck.MakeRasterDirectSurface=makeSurface;}
 }finally{renderer.clear();ck._malloc=malloc;ck._free=free;}
});
