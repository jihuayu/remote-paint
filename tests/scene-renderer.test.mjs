import test from 'node:test';
import assert from 'node:assert/strict';
import CanvasKitInit from 'canvaskit-wasm/full';
import {createRequire} from 'node:module';
import {PNG} from 'pngjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
import {ClientMemory,memoryPolicy} from '../protocol/client-memory.mjs';
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

test('incremental rendering reuses unchanged passes and invalidates dependent parents',()=>{
 const renderer=new SceneRenderer(ck,{incremental:true}),area=[0,0,20,20],original=ck.MakeRasterDirectSurface,calls=[];
 ck.MakeRasterDirectSurface=(...args)=>{calls.push(args.slice(1,3));return original(...args);};
 const child={id:'child',output:area,quads:[solid([0,1,0,1],area)]};
 const scene={rootPass:'root',passes:[child,{id:'root',output:area,quads:[{kind:'pass',passId:'child',matrix,rect:area,visible:area,clip:null,opacity:1}]}]};
 try{
  const first=renderer.render(scene,new Map(),ck.WHITE);assert.equal(calls.length,2);assert.equal(first.surface,null);first.release();
  const second=renderer.render(scene,new Map(),ck.WHITE);assert.equal(calls.length,2,'unchanged child and root passes should be reused');assert.equal(second.surface,null);second.release();
  child.quads[0].color=[1,0,0,1];const third=renderer.render(scene,new Map(),ck.WHITE);
  assert.equal(calls.length,2,'changed passes must reuse their persistent surfaces');assert.equal(renderer.stats.passRenders,4,'changing a child must redraw its dependent root');
  assert.deepEqual(pixel(PNG.sync.read(Buffer.from(third.image.encodeToBytes())),5,5),[255,0,0,255]);third.release();
 }finally{renderer.clear();ck.MakeRasterDirectSurface=original;}
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

test('immutable pictures rasterize once across compositor moves and preserve transparent clears',()=>{
 const recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,20,20]),paint=new ck.Paint();canvas.clear(ck.TRANSPARENT);paint.setColor([1,0,0,1]);canvas.drawCircle(10,10,8,paint);
 const picture=recorder.finishRecordingAsPicture(),renderer=new SceneRenderer(ck,{incremental:true,rasterPixels:400});
 const q={kind:'picture',resourceId:'raster',width:20,height:20,quadScale:1,contentOrigin:[0,0],matrix:[...matrix],rect:[0,0,20,20],visible:[0,0,20,20],clip:null,opacity:1,requiresIsolation:true};
 const scene={rootPass:'root',passes:[{id:'root',output:rect,quads:[q,solid([0,0,1,1])]}]},resources=new Map([['raster',picture.serialize()]]);
 try{
  let out=renderer.render(scene,resources);assert.deepEqual(pixel(PNG.sync.read(Buffer.from(out.image.encodeToBytes())),1,1),[0,0,255,255]);out.release();
  q.matrix[2]=20;out=renderer.render(scene,resources);const png=PNG.sync.read(Buffer.from(out.image.encodeToBytes()));assert.deepEqual(pixel(png,30,10),[255,0,0,255]);assert.deepEqual(pixel(png,21,1),[0,0,255,255]);out.release();
  assert.equal(renderer.stats.pictureRasters,1);assert.equal(renderer.stats.pictureRasterHits,1);assert.equal(renderer.stats.isolatedDraws,0);assert.equal(renderer.rasterPixels,400);
  renderer.retain(new Set());assert.equal(renderer.rasterPixels,0);assert.equal(renderer.pictures.size,0);
 }finally{renderer.clear();picture.delete();recorder.delete();paint.delete();}
});

test('WebGL black placeholder preserves target clip, transform, opacity and front-to-back order',()=>{
 const renderer=new SceneRenderer(ck);
 const placeholder={kind:'placeholder',reason:'webgl',matrix:[1,0,20,0,1,10,0,0,1],rect:[0,0,60,60],visible:[0,0,60,60],clip:[20,10,60,60],opacity:0.5};
 const output=renderer.render({rootPass:'root',passes:[{id:'root',output:rect,quads:[solid([1,0,0,1],[30,30,40,40]),placeholder,solid([0,0,1,1])]}]},new Map());
 try{const png=PNG.sync.read(Buffer.from(output.image.encodeToBytes()));
  assert.deepEqual(pixel(png,5,5),[0,0,255,255]);
  assert.deepEqual(pixel(png,35,35),[255,0,0,255]);
  assert.ok(Math.abs(pixel(png,25,25)[2]-127)<=1);
  assert.deepEqual(pixel(png,70,25),[0,0,255,255]);
 }finally{output.image.delete();output.surface.dispose();renderer.clear();}
});

test('damage scissor covers both caret positions and propagates local child damage',()=>{
 const renderer=new SceneRenderer(ck,{incremental:true}),area=[0,0,200,120];
 const caret=solid([1,0,0,1],[10,10,12,30]);
 const scene={rootPass:'root',passes:[{id:'child',output:area,quads:[caret]},
  {id:'root',output:area,quads:[{kind:'pass',passId:'child',matrix:[1,0,20,0,1,10,0,0,1],rect:area,visible:area,clip:null,opacity:.5},solid([0,0,1,1],area)]}]};
 try{
  renderer.render(scene,new Map(),ck.WHITE).release();const before=renderer.stats.damagedPixels;
  caret.matrix=[1,0,4,0,1,0,0,0,1];const out=renderer.render(scene,new Map(),ck.WHITE),png=PNG.sync.read(Buffer.from(out.image.encodeToBytes()));
  assert.deepEqual(pixel(png,30,22),[0,0,255,255],'old caret must be erased');assert.ok(pixel(png,35,22)[0]>=127,'new caret must blend');
  assert.ok(out.damage[0]<=30&&out.damage[2]>=36&&out.damage[2]-out.damage[0]<20);
  assert.ok(renderer.stats.damagedPixels-before<2000,'small child update must not repaint the full child and root');assert.equal(renderer.stats.passSurfaceAllocations,2);out.release();
 }finally{renderer.clear();}
});

test('persistent damage rendering matches a fresh full replay through scroll, overlap, clipping and resize',()=>{
 const renderer=new SceneRenderer(ck,{incremental:true}),reference=new SceneRenderer(ck);
 let background=ck.WHITE;const child=solid([.8,.3,.1,.6],[15,12,35,33]);
 const parent={kind:'pass',passId:'child',matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,clip:[5,5,95,95],roundedClip:[5,5,95,95,9,9,9,9,9,9,9,9],opacity:.65};
 const foreground=solid([.1,.9,.4,.4],[20,20,60,60]);
 const scene={rootPass:'root',passes:[{id:'child',output:rect,quads:[child]},{id:'root',output:[...rect],quads:[foreground,parent,solid([.1,.2,.8,1])]}]};
 try{
  for(let n=0;n<120;n++){
   const angle=n%5===0?n*.03:0,c=Math.cos(angle),s=Math.sin(angle);
   child.matrix=[c,-s,(n*7)%45-15,s,c,(n*3)%30-10,0,0,1];
   child.color=[n%7/7,.3,.2,n%11===0?0:.6];parent.matrix=[c,-s,-n%20,s,c,n%9,0,0,1];
   parent.clip=[n%10,5,85+n%10,95];foreground.opacity=n%13===0?0:.7;
   if(n%17===0)scene.passes[1].quads.reverse();
   scene.passes[1].output=n%23===0?[0,0,110,90]:[...rect];
   background=n%19===0?ck.TRANSPARENT:ck.WHITE;
   const a=renderer.render(scene,new Map(),background),b=reference.render(scene,new Map(),background);
   try{assert.deepEqual(PNG.sync.read(Buffer.from(a.image.encodeToBytes())).data,PNG.sync.read(Buffer.from(b.image.encodeToBytes())).data,`damage replay mismatch at ${n}`);}finally{a.release();b.image.delete();b.surface.dispose();}
  }
  assert.ok(renderer.stats.partialPassRenders>100);
 }finally{renderer.clear();reference.clear();}
});

test('offscreen changes skip raster work and failed partial renders release their persistent surface',()=>{
 const renderer=new SceneRenderer(ck,{incremental:true}),q=solid([1,0,0,1],[150,150,160,160]),scene={rootPass:'root',passes:[{id:'root',output:rect,quads:[q]}]};
 try{
  renderer.render(scene,new Map(),ck.WHITE).release();const renders=renderer.stats.passRenders;
  q.matrix=[1,0,10,0,1,0,0,0,1];const out=renderer.render(scene,new Map(),ck.WHITE);assert.equal(out.damage,null);assert.equal(renderer.stats.passRenders,renders);out.release();
  q.visible=q.rect=[0,0,10,10];q.kind='invalid';assert.throws(()=>renderer.render(scene,new Map(),ck.WHITE),/Unsupported/);assert.equal(renderer.passCache.size,0);
  q.kind='solid';renderer.render(scene,new Map(),ck.WHITE).release();assert.equal(renderer.passCache.size,1);
 }finally{renderer.clear();}
});

test('decoded picture and raster eviction preserves replay and releases owned surfaces',()=>{
 const memory=new ClientMemory({...memoryPolicy(),pictures:200,rasters:1600}),renderer=new SceneRenderer(ck,{incremental:true,memory}),reference=new SceneRenderer(ck),resources=new Map(),quads=[];
 const originals=[];
 for(let n=0;n<3;n++){
  const recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,20,20]),paint=new ck.Paint();paint.setColor([n===0?1:0,n===1?1:0,n===2?1:0,1]);canvas.drawRect([0,0,20,20],paint);const picture=recorder.finishRecordingAsPicture();
  resources.set(String(n),picture.serialize());originals.push({picture,paint,recorder});quads.push({kind:'picture',resourceId:String(n),width:20,height:20,quadScale:1,contentOrigin:[0,0],matrix:[1,0,n*20,0,1,0,0,0,1],rect:[0,0,20,20],visible:[0,0,20,20],clip:null,opacity:1});
 }
 const scene={rootPass:'root',passes:[{id:'root',output:rect,quads}]};
 try{
  for(let n=0;n<12;n++){
   quads[0].matrix[5]=n;const a=renderer.render(scene,resources,ck.WHITE),b=reference.render(scene,resources,ck.WHITE);
   try{assert.deepEqual(PNG.sync.read(Buffer.from(a.image.encodeToBytes())).data,PNG.sync.read(Buffer.from(b.image.encodeToBytes())).data);}finally{a.release();b.image.delete();b.surface.dispose();}
   assert.ok(renderer.pictureBytes<=200);assert.ok(renderer.rasterPixels<=400);
  }
  assert.ok(renderer.stats.pictureEvictions>0&&renderer.stats.rasterEvictions>0);
  renderer.clear();assert.equal(memory.snapshot().domains.wasm,0);assert.equal(memory.snapshot().owners,0);
 }finally{renderer.clear();reference.clear();for(const entry of originals){entry.picture.delete();entry.paint.delete();entry.recorder.delete();}}
});

test('pass deep copies and signatures stay budgeted through hits, in-place source edits and nonvisual metadata changes',()=>{
 const memory=new ClientMemory(),renderer=new SceneRenderer(ck,{incremental:true,memory}),quad=solid([1,0,0,1]),pass={id:'root',output:rect,quads:[quad]},scene={rootPass:'root',passes:[pass]};
 try{
  renderer.render(scene,new Map(),ck.WHITE).release();const first=memory.snapshot().categories.passMetadata,owners=memory.snapshot().owners,stored=renderer.passCache.get('root').pass;assert.ok(first>0);
  renderer.render(scene,new Map(),ck.WHITE).release();assert.equal(renderer.passCache.get('root').pass,stored);assert.equal(memory.snapshot().categories.passMetadata,first);
  quad.color[0]=0;quad.color[2]=1;const changed=renderer.render(scene,new Map(),ck.WHITE);assert.deepEqual(pixel(PNG.sync.read(Buffer.from(changed.image.encodeToBytes())),50,50),[0,0,255,255]);changed.release();assert.equal(memory.snapshot().owners,owners);
  const renders=renderer.stats.passRenders;for(let n=0;n<10;n++){pass.note='x'.repeat(1000+n);renderer.render(scene,new Map(),ck.WHITE).release();assert.ok(memory.snapshot().categories.passMetadata>first);assert.equal(memory.snapshot().owners,owners);}assert.equal(renderer.stats.passRenders,renders,'metadata-only changes must not redraw pixels');delete pass.note;renderer.render(scene,new Map(),ck.WHITE).release();assert.equal(memory.snapshot().categories.passMetadata,first);
 }finally{renderer.clear();assert.equal(memory.snapshot().owners,0);assert.equal(memory.snapshot().domains.js,0);}
});
test('signature work admission fails before pixel allocation and retains the previous valid cache',()=>{
 const memory=new ClientMemory({...memoryPolicy(),js:64*1024}),renderer=new SceneRenderer(ck,{incremental:true,memory}),pass={id:'root',output:rect,quads:[solid([1,0,0,1])]},scene={rootPass:'root',passes:[pass]};
 try{renderer.render(scene,new Map(),ck.WHITE).release();const before=memory.snapshot(),allocations=renderer.stats.passSurfaceAllocations;pass.note='x'.repeat(8000);assert.throws(()=>renderer.render(scene,new Map(),ck.WHITE),/memory budget/);assert.equal(renderer.stats.passSurfaceAllocations,allocations);assert.equal(memory.snapshot().owners,before.owners);assert.equal(memory.snapshot().categories.passMetadata,before.categories.passMetadata);assert.deepEqual(pixel(PNG.sync.read(Buffer.from(renderer.passCache.get('root').image.encodeToBytes())),50,50),[255,0,0,255]);delete pass.note;renderer.render(scene,new Map(),ck.WHITE).release();}finally{renderer.clear();assert.equal(memory.snapshot().owners,0);}
});
test('failed reuse drops its pass metadata and pixels while a later replay can recover',()=>{
 const memory=new ClientMemory(),renderer=new SceneRenderer(ck,{incremental:true,memory}),quad=solid([1,0,0,1]),scene={rootPass:'root',passes:[{id:'root',output:rect,quads:[quad]}]};
 try{renderer.render(scene,new Map(),ck.WHITE).release();quad.kind='invalid';assert.throws(()=>renderer.render(scene,new Map(),ck.WHITE),/Unsupported/);assert.equal(memory.snapshot().owners,0);quad.kind='solid';renderer.render(scene,new Map(),ck.WHITE).release();assert.ok(memory.snapshot().categories.passMetadata>0);}finally{renderer.clear();assert.equal(memory.snapshot().owners,0);}
});
test('removed child passes release their metadata; a device cleanup error still releases the remaining pass surface and metadata',()=>{
 const memory=new ClientMemory(),renderer=new SceneRenderer(ck,{incremental:true,memory}),scene={rootPass:'root',passes:[{id:'child',output:rect,quads:[solid([1,0,0,1])]},{id:'root',output:rect,quads:[{kind:'pass',passId:'child',matrix,rect,visible:rect,clip:null,opacity:1}]}]};
 renderer.render(scene,new Map(),ck.WHITE).release();const both=memory.snapshot().categories.passMetadata;scene.passes=[{id:'root',output:rect,quads:[solid([0,1,0,1])]}];renderer.render(scene,new Map(),ck.WHITE).release();assert.equal(renderer.passCache.size,1);assert.ok(memory.snapshot().categories.passMetadata<both);const entry=renderer.passCache.get('root'),dispose=entry.image.delete.bind(entry.image);entry.image.delete=()=>{dispose();throw new Error('device cleanup probe');};assert.throws(()=>renderer.clear(),/device cleanup probe/);assert.equal(renderer.passCache.size,0);assert.equal(memory.snapshot().owners,0);renderer.clear();
});
test('a device error while reusing a pass releases its metadata and surface and resets render activity',()=>{
 const memory=new ClientMemory(),renderer=new SceneRenderer(ck,{incremental:true,memory}),quad=solid([1,0,0,1]),scene={rootPass:'root',passes:[{id:'root',output:rect,quads:[quad]}]};renderer.render(scene,new Map(),ck.WHITE).release();const entry=renderer.passCache.get('root'),dispose=entry.image.delete.bind(entry.image);entry.image.delete=()=>{dispose();throw new Error('reuse cleanup probe');};quad.color=[0,0,1,1];assert.throws(()=>renderer.render(scene,new Map(),ck.WHITE),/reuse cleanup probe/);assert.equal(renderer.busy,false);assert.equal(memory.snapshot().owners,0);renderer.render(scene,new Map(),ck.WHITE).release();renderer.clear();assert.equal(memory.snapshot().owners,0);
});
test('oversized decoded estimates are refused before CanvasKit MakePicture is called',()=>{
 const memory=new ClientMemory({...memoryPolicy(),wasm:ck.HEAPU8.buffer.byteLength+2*1024*1024}),renderer=new SceneRenderer(ck,{memory,rasterCache:false}),area=[0,0,10,10],quad={kind:'picture',resourceId:'large',width:10,height:10,quadScale:1,contentOrigin:[0,0],rect:area,visible:area,matrix,clip:null,opacity:1},scene={rootPass:'root',passes:[{id:'root',output:area,quads:[quad]}]},original=ck.MakePicture;let calls=0;ck.MakePicture=(...args)=>{calls++;return original(...args);};
 try{assert.throws(()=>renderer.render(scene,new Map([['large',new Uint8Array(32)]]),ck.WHITE,{large:{imageBytes:64*1024*1024,fontBytes:0}}),/picture decode headroom/);assert.equal(calls,0);assert.equal(memory.snapshot().categories.pictureDecode,undefined);}finally{ck.MakePicture=original;renderer.clear();assert.equal(memory.snapshot().owners,0);}
});
test('a picture larger than the LRU uses transient ownership, then cached rasters avoid repeated decoding',()=>{
 const memory=new ClientMemory({...memoryPolicy(),pictures:1}),renderer=new SceneRenderer(ck,{memory,incremental:false,rasterCache:true}),recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,10,10]),paint=new ck.Paint();paint.setColor(ck.RED);canvas.drawRect([0,0,10,10],paint);const picture=recorder.finishRecordingAsPicture(),bytes=picture.serialize(),area=[0,0,10,10],quad={kind:'picture',resourceId:'tiny-cache',width:10,height:10,quadScale:1,contentOrigin:[0,0],rect:area,visible:area,matrix,clip:null,opacity:1},scene={rootPass:'root',passes:[{id:'root',output:area,quads:[quad]}]};
 try{for(let n=0;n<2;n++){const out=renderer.render(scene,new Map([['tiny-cache',bytes]]),ck.WHITE,{'tiny-cache':{imageBytes:0,fontBytes:0}});assert.deepEqual(pixel(PNG.sync.read(Buffer.from(out.image.encodeToBytes())),5,5),[255,0,0,255]);out.image.delete();out.surface.dispose();assert.equal(renderer.pictureBytes,0);assert.equal(renderer.pictures.size,0);assert.equal(memory.snapshot().categories.pictureTransient,undefined);assert.equal(memory.snapshot().categories.pictureDecode,undefined);}assert.equal(renderer.stats.pictureDecodes,1);assert.equal(renderer.stats.pictureRasterHits,1);}finally{renderer.clear();picture.delete();paint.delete();recorder.delete();assert.equal(memory.snapshot().owners,0);}
});
