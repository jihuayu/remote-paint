import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

const assets=await prepareViewerAssets(),font=await readFile(new URL('./fixtures/NotoSansSC-subset.ttf',import.meta.url));
const server=createServer((request,response)=>{
 const path=new URL(request.url,'http://localhost').pathname;
 if(path==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><meta charset="utf-8"><title>Presentation verification</title>');return;}
 if(path==='/font.ttf'){response.end(font);return;}
 const asset=assets.get(path);if(!asset?.bytes){response.writeHead(404);response.end();return;}response.setHeader('Content-Type',asset.type);response.end(asset.bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}`;

async function probe(origin){
 const check=(condition,message)=>{if(!condition)throw new Error(message);};
 const {default:init}=await import(`${origin}/canvaskit-worker.mjs`),{FramePresenter}=await import(`${origin}/frame-presenter.mjs`);
 const wasm=await fetch(`${origin}/vendor/canvaskit.wasm`).then(r=>{check(r.ok,'Wasm fetch failed');return r.arrayBuffer();});
 const ck=await init({wasmBinary:wasm,locateFile:file=>`${origin}/vendor/${file}`});
 const typeface=ck.Typeface.MakeFreeTypeFaceFromData(await fetch(`${origin}/font.ttf`).then(r=>r.arrayBuffer())),font=new ck.Font(typeface,18);
 const identity=[1,0,0,0,1,0,0,0,1],area=[0,0,960,640],solid=(color,rect=area,extra={})=>({kind:'solid',color,rect,visible:rect,matrix:identity,clip:null,opacity:1,...extra});
 const recorder=new ck.PictureRecorder(),canvas=recorder.beginRecording([0,0,100,60]),paint=new ck.Paint();canvas.clear(ck.TRANSPARENT);paint.setColor([0,0.2,0.8,0.7]);canvas.drawCircle(45,30,20,paint);paint.setColor(ck.BLACK);canvas.drawText('测试文本',0,18,paint,font);
 const picture=recorder.finishRecordingAsPicture(),resources=new Map([['picture',picture.serialize()]]);
 const frame={viewport:{cssWidth:960,cssHeight:640},scene:{rootPass:'root',passes:[
  {id:'child',output:area,quads:[solid([1,.5,0,.5])]},
  {id:'root',output:area,quads:[{kind:'picture',resourceId:'picture',width:100,height:60,quadScale:1,contentOrigin:[0,0],rect:[0,0,100,60],visible:[0,0,100,60],matrix:identity,clip:null,opacity:.8},
   {kind:'pass',passId:'child',rect:area,visible:area,matrix:[1,0,5,0,1,3,0,0,1],clip:[10,10,118,86],roundedClip:[10,10,118,86,8,8,8,8,8,8,8,8],opacity:.5}]}
 ]}};
 const gpuCanvas=new OffscreenCanvas(960,640),gpu=new FramePresenter(ck,gpuCanvas,{gpu:true}),cpuCanvas=new OffscreenCanvas(960,640);
 check(gpu.presentation.mode==='webgl2-bitmap',`GPU required: ${JSON.stringify(gpu.presentation)}`);
 const read=(target,width=target.width,height=target.height)=>{const c=new OffscreenCanvas(width,height),context=c.getContext('2d');context.drawImage(target,0,0);return context.getImageData(0,0,c.width,c.height).data;};
 let ckReadbacks=0,glReadbacks=0,gpuTargets=0,cpuTargets=0;
 const originalRead=ck.Image.prototype.readPixels,originalGlRead=gpu.gl.readPixels.bind(gpu.gl),originalGpu=ck.MakeRenderTarget,originalCpu=ck.MakeRasterDirectSurface;
 ck.Image.prototype.readPixels=function(...args){ckReadbacks++;return originalRead.apply(this,args);};gpu.gl.readPixels=(...args)=>{glReadbacks++;return originalGlRead(...args);};
 ck.MakeRenderTarget=(...args)=>{gpuTargets++;return originalGpu.apply(ck,args);};ck.MakeRasterDirectSurface=(...args)=>{cpuTargets++;return originalCpu.apply(ck,args);};
 let cpu,unavailable,cpu2d,automatic,budgetFallback;
 const gpuTimings=[],cpuTimings=[];
 try{
  await gpu.draw(frame,resources,ck.TRANSPARENT);const first=read(gpuCanvas);
  check(ckReadbacks===0&&glReadbacks===0&&cpuTargets===0,'GPU rendering or caches used CPU surfaces/readback');check(gpuTargets>=3,'GPU must render child/root and picture cache');
  const allocation={gpuTargets,cpuTargets,ckReadbacks,glReadbacks};
  cpu=new FramePresenter(ck,cpuCanvas,{gpu:false,output:'bitmap'});await cpu.draw(frame,resources,ck.TRANSPARENT);const expected=read(cpuCanvas);
  automatic=new FramePresenter(ck,new OffscreenCanvas(960,640));await automatic.draw(frame,resources,ck.TRANSPARENT);
  const software=/SwiftShader|llvmpipe|softpipe|software rasterizer/i.test(gpu.presentation.device.renderer);
  check(automatic.presentation.mode===(software?'cpu-2d':'webgl2-bitmap'),'Automatic backend selection ignored actual renderer');
  let different=0,maxError=0;for(let i=0;i<first.length;i++){const error=Math.abs(first[i]-expected[i]);maxError=Math.max(maxError,error);if(error>2)different++;}
  check(different/first.length<.02,`GPU/CPU alpha/text/color mismatch: ${different}/${first.length}, max ${maxError}`);
  const samples=[...first.slice((80*960+100)*4,(80*960+100)*4+4)];check(Math.abs(samples[0]-255)<=1&&Math.abs(samples[1]-128)<=2&&samples[2]===0&&Math.abs(samples[3]-64)<=1,`Premultiplied alpha mismatch: ${samples}`);
  const dark=(data,x,y)=>{const i=(y*960+x)*4;return data[i+3]>100&&data[i]<40&&data[i+1]<40&&data[i+2]<40;};
  let textInk=0,missingInk=0;for(let y=0;y<20;y++)for(let x=0;x<100;x++)if(dark(expected,x,y)){
   textInk++;let found=false;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&y+dy>=0&&dark(first,x+dx,y+dy))found=true;
   if(!found)missingInk++;
  }
  check(textInk>30&&missingInk/textInk<.05,`GPU lost text ink: ${missingInk}/${textInk}`);
  const twoD=new OffscreenCanvas(960,640);twoD.getContext('2d');cpu2d=new FramePresenter(ck,twoD);await cpu2d.draw(frame,resources,ck.TRANSPARENT);check(cpu2d.presentation.mode==='cpu-2d'&&read(twoD).every((v,i)=>v===expected[i]),'2D-only fallback changed pixels');
  const before=gpu.presentation.totalReadbackBytes;let maxDamagePixels=0,maxTwoDReadbackBytes=0;
  for(let n=0;n<60;n++){
   frame.scene.passes[1].quads[0].matrix=[1,0,n%25,0,1,0,0,0,1];
   const readsBefore=ckReadbacks,cpuTargetsBefore=cpuTargets;
   await gpu.draw(frame,resources);check(ckReadbacks===readsBefore&&cpuTargets===cpuTargetsBefore&&glReadbacks===0,'GPU damage frame used CPU raster/readback');
   gpuTimings.push({...gpu.presentation});await cpu.draw(frame,resources);cpuTimings.push({...cpu.presentation});
   await cpu2d.draw(frame,resources);
   if(n>0){
    const [x,y,r,b]=gpu.presentation.damage,pixels=(r-x)*(b-y);maxDamagePixels=Math.max(maxDamagePixels,pixels);check(pixels<10000,'Local picture move damaged the full screen');
    maxTwoDReadbackBytes=Math.max(maxTwoDReadbackBytes,cpu2d.presentation.readbackBytes);check(cpu2d.presentation.readbackBytes===pixels*4,'2D fallback copied pixels outside damage');
   }
   if(n%10===0){
    const actual=read(gpuCanvas,160,100),expected=read(cpuCanvas,160,100),twoD=read(cpu2d.canvas,160,100);let differences=0;
    for(let i=0;i<actual.length;i+=4)if([0,1,2,3].some(c=>Math.abs(actual[i+c]-expected[i+c])>16))differences++;
    check(differences<100,`GPU partial replay left stale pixels: ${differences}`);check(twoD.every((v,i)=>v===expected[i]),'2D partial readback left stale pixels');
   }
  }
  check(gpu.presentation.totalReadbackBytes===before,'GPU frames read back pixels');
  check(gpu.sceneRenderer.stats.passSurfaceAllocations===3,'GPU pass surfaces were reallocated across same-size frames');
  await gpu.draw(frame,resources);await cpu.draw(frame,resources);await cpu2d.draw(frame,resources);
  check(gpu.presentation.skipped&&cpu.presentation.skipped&&cpu2d.presentation.skipped&&cpu.presentation.readbackBytes===0,'Unchanged frame still performed presentation work');
  const damage={maxDamagePixels,viewportPixels:960*640,maxTwoDReadbackBytes,passSurfaceAllocations:gpu.sceneRenderer.stats.passSurfaceAllocations,partialPassRenders:gpu.sceneRenderer.stats.partialPassRenders,unchangedPresentationSkipped:true};
  const gpuMemory=gpu.memory.observe(ck,gpu.gr),beforeTrim=read(gpuCanvas,160,100);check(Number.isFinite(gpuMemory.observed.gpuCacheBytes),'Actual Skia GPU cache usage unavailable');check(gpuMemory.categories.passMetadata>0,'Cached pass metadata was not budgeted');
  gpu.memory.trim();const trimmed=gpu.memory.snapshot();
  check((trimmed.categories.passes??0)===0&&(trimmed.categories.pictures??0)===0&&(trimmed.categories.rasters??0)===0&&(trimmed.categories.passMetadata??0)===0,'Cache trim kept decoded/render/metadata owners');
  await gpu.draw(frame,resources);check(read(gpuCanvas,160,100).every((v,i)=>v===beforeTrim[i]),'GPU cache eviction changed pixels');
  const ownership={beforeTrim:gpuMemory,afterTrim:trimmed,afterRestore:gpu.memory.observe(ck,gpu.gr),pixelsRestored:true};
  // Resizing the GL backbuffer must recreate its surface, while cached pass
  // textures remain owned by the same context.
  frame.viewport={cssWidth:800,cssHeight:600};frame.scene.passes[1].output=[0,0,800,600];
  await gpu.draw(frame,resources);await cpu.draw(frame,resources);check(gpuCanvas.width===800&&gpuCanvas.height===600,'GPU resize failed');
  const resizedGpu=read(gpuCanvas),resizedCpu=read(cpuCanvas);check(resizedGpu.slice(-4).every((v,i)=>v===resizedCpu.slice(-4)[i]),'Resize left an invalid edge');
  const extension=gpu.gl.getExtension('WEBGL_lose_context');check(extension,'Context loss extension required');extension.loseContext();
  for(let n=0;n<50&&!gpu.gl.isContextLost();n++)await new Promise(resolve=>setTimeout(resolve,10));
  await gpu.draw(frame,resources);check(gpu.presentation.mode==='cpu-bitmap'&&gpu.presentation.fallbacks===1,'Context loss did not recover through CPU');
  const recovered=read(gpuCanvas);check(recovered.every((v,i)=>v===resizedCpu[i]),'Context loss recovery changed pixels');
  const lost={...gpu.presentation};
  const {ClientMemory,memoryPolicy}=await import(`${origin}/protocol/client-memory.mjs`),budgetMemory=new ClientMemory({...memoryPolicy({profile:'large'}),gpu:64*1024*1024,gpuCache:32*1024*1024});
  budgetFallback=new FramePresenter(ck,new OffscreenCanvas(800,600),{gpu:true,memory:budgetMemory});check(budgetFallback.presentation.mode==='webgl2-bitmap','Budget fallback probe requires actual GPU initialization');await budgetFallback.draw({...frame,resourceMemory:{version:1,resources:{picture:{imageBytes:40*1024*1024,fontBytes:0}}}},resources);check(budgetFallback.presentation.mode==='cpu-bitmap'&&budgetFallback.presentation.fallbackReason==='GPU image working set exceeds budget','Oversized GPU working set did not select CPU before image upload');check(read(budgetFallback.canvas).every((v,i)=>v===resizedCpu[i]),'GPU budget fallback changed pixels');
  const originalContext=ck.GetWebGLContext;ck.GetWebGLContext=()=>0;
  try{unavailable=new FramePresenter(ck,new OffscreenCanvas(128,96));}finally{ck.GetWebGLContext=originalContext;}
  await unavailable.draw(frame,resources);check(unavailable.presentation.mode==='cpu-2d','Unsupported GPU failed CPU fallback');
  // A CPU bitmap conversion completing after reconnect/reset must not paint
  // the old frame into the new generation.
  const previous=read(cpuCanvas),originalBitmap=globalThis.createImageBitmap;let finish;
  globalThis.createImageBitmap=(...args)=>new Promise(resolve=>{finish=()=>originalBitmap(...args).then(resolve);});
  try{const late=cpu.draw(frame,resources,ck.BLACK);cpu.clear();await finish();await late;check(read(cpuCanvas).every((v,i)=>v===previous[i]),'Reset allowed stale bitmap presentation');}finally{globalThis.createImageBitmap=originalBitmap;}
  const percentile=(list,p)=>[...list].sort((a,b)=>a-b)[Math.min(list.length-1,Math.floor(list.length*p))];
  const timings=values=>Object.fromEntries(['renderMs','readbackMs','bitmapMs','submitMs','totalMs'].map(key=>[key,{p50:percentile(values.map(v=>v[key]),.5),p95:percentile(values.map(v=>v[key]),.95)}]));
  return {device:gpu.presentation.device,automaticMode:automatic.presentation.mode,webgpuCompiled:typeof ck.MakeGPUDeviceContext==='function',allocation,damage,ownership,alphaSample:samples,textInk:{pixels:textInk,missing:missingInk},comparison:{differentChannelsOver2:different,channels:first.length,maxError},frames:60,gpu:timings(gpuTimings),cpu:timings(cpuTimings),gpuReadbackBytes:before,contextLoss:lost,unavailableFallback:unavailable.presentation.mode,twoDFallback:cpu2d.presentation.mode,resize:true,staleBitmapSuppressed:true};
 }finally{gpu.dispose();cpu?.dispose();cpu2d?.dispose();automatic?.dispose();budgetFallback?.dispose();unavailable?.dispose();ck.Image.prototype.readPixels=originalRead;ck.MakeRenderTarget=originalGpu;ck.MakeRasterDirectSurface=originalCpu;picture.delete();paint.delete();recorder.delete();font.delete();typeface.delete();}
}

let browser;
try{
 browser=await launchCaptureBrowser();const page=await browser.newPage();page.on('console',message=>{if(message.type()==='error')console.error(message.text());});page.on('requestfailed',request=>console.error('Request failed',request.url(),request.failure()));await page.goto(url);
 const main=await page.evaluate(probe,url);
 const worker=await page.evaluate(({source,origin})=>new Promise((resolve,reject)=>{
  const objectUrl=URL.createObjectURL(new Blob([`(${source})(${JSON.stringify(origin)}).then(result=>postMessage({result})).catch(error=>postMessage({error:error.stack}));`],{type:'text/javascript'}));
  const worker=new Worker(objectUrl,{type:'module'});worker.onmessage=({data})=>{worker.terminate();URL.revokeObjectURL(objectUrl);data.error?reject(new Error(data.error)):resolve(data.result);};worker.onerror=error=>{worker.terminate();URL.revokeObjectURL(objectUrl);reject(new Error(error.message));};
 }),{source:probe.toString(),origin:url});
 assert.equal(main.gpuReadbackBytes,0);assert.equal(worker.gpuReadbackBytes,0);
 const report={at:new Date().toISOString(),scope:'Real browser CanvasKit WebGL2 + CPU in main thread and Worker; direct presentation alpha/text/picture cache/resize/context loss, local 960x640 timing probe (not an end-to-end performance claim)',browser:browser.version(),build:assets.build,main,worker};
 await mkdir('artifacts/presentation',{recursive:true});await writeFile('artifacts/presentation/presentation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
