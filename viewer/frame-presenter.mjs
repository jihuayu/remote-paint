import {SceneRenderer} from './scene-renderer.mjs';
import {ClientMemory,MemoryLimitError} from '../protocol/client-memory.mjs';

class GpuUnavailable extends Error {}

// The visible canvas always keeps its original context. A separate GPU canvas
// lets context loss fall back to CPU without replacing DOM/input bindings or
// attempting to change a canvas from WebGL to 2D (which browsers forbid).
export class FramePresenter {
 constructor(ck,canvas,{gpu='auto',memory=new ClientMemory(),gpuCacheBytes=memory.policy.gpuCache,output='auto',displayCharge}={}){
  this.ck=ck;this.canvas=canvas;this.memory=memory;this.generation=0;this.disposed=false;this.busy=false;
  ck.setDecodeCacheLimitBytes(memory.policy.decodeCache);if(ck.wasmBinary)this.runtimeBinary=memory.buffer('wasmBinary',ck.wasmBinary);
  this.presentation={mode:'cpu-2d',frames:0,gpuFrames:0,cpuFrames:0,readbackBytes:0,totalReadbackBytes:0,fallbacks:0,gpuCacheBytes};
  if(gpu&&typeof OffscreenCanvas==='function'){
   try{
    this.gpuCanvas=new OffscreenCanvas(1,1);
    if(typeof this.gpuCanvas.transferToImageBitmap!=='function')throw new GpuUnavailable('GPU ImageBitmap transfer unavailable');
    this.onLost=event=>{event.preventDefault();this.lost=true;};
    this.gpuCanvas.addEventListener('webglcontextlost',this.onLost);
    this.handle=ck.GetWebGLContext(this.gpuCanvas,{majorVersion:2,alpha:true,premultipliedAlpha:true,antialias:false,preserveDrawingBuffer:false});
    if(!this.handle)throw new GpuUnavailable('WebGL2 context unavailable');
    this.gl=this.gpuCanvas.getContext('webgl2');
    this.gr=ck.MakeWebGLContext(this.handle);if(!this.gr)throw new GpuUnavailable('CanvasKit GPU context unavailable');
    this.gr.setResourceCacheLimitBytes(gpuCacheBytes);
    const extension=this.gl.getExtension('WEBGL_debug_renderer_info');
    this.presentation.device={version:this.gl.getParameter(this.gl.VERSION),renderer:this.gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL??this.gl.RENDERER)};
    // Software WebGL still incurs GPU command/bitmap overhead. Keep the
    // measured CPU path by default; callers can explicitly force GPU probes.
    if(gpu==='auto'&&/SwiftShader|llvmpipe|softpipe|software rasterizer/i.test(this.presentation.device.renderer))throw new GpuUnavailable('Software WebGL2 renderer; CPU preferred');
    this.presentation.mode='webgl2-bitmap';
   }catch(error){this.presentation.fallbackReason=String(error.message??error);this.releaseGpu();}
  }
  const context=type=>{try{return canvas.getContext(type);}catch{return null;}};
  // Choose the output context after probing GPU capability. Software/absent
  // GPU starts directly in 2D, so regional CPU readback avoids a full bitmap
  // conversion. A later GPU loss keeps its existing bitmaprenderer context.
  this.context=this.gr||output==='bitmap'?context('bitmaprenderer'):null;this.bitmap=!!this.context;
  if(!this.bitmap&&this.gr){this.presentation.fallbackReason='ImageBitmap presentation unavailable';this.releaseGpu();}
  if(!this.context)this.context=context('2d');
  if(!this.context){this.releaseGpu();throw new Error('Cannot allocate Viewer canvas');}
  this.presentation.mode=this.gr?'webgl2-bitmap':this.bitmap?'cpu-bitmap':'cpu-2d';
  this.createRenderer();
  try{
   this.displayCharge=displayCharge??memory.reserve('presentation',canvas.width*canvas.height*8,'browser');
   this.untrim=memory.addTrimmer(()=>{if(this.busy)return;this.sceneRenderer?.trim();ck.setDecodeCacheLimitBytes(0);ck.setDecodeCacheLimitBytes(memory.policy.decodeCache);if(this.gr){this.gr.setResourceCacheLimitBytes(0);this.gr.setResourceCacheLimitBytes(gpuCacheBytes);}memory.sample(ck,this.gr);});
   memory.observe(ck,this.gr);
  }catch(error){this.sceneRenderer.clear();this.releaseGpu();this.untrim?.();this.runtimeBinary?.();if(!displayCharge)this.displayCharge?.();throw error;}
 }
 createRenderer(){
  const ck=this.ck,options={incremental:true,memory:this.memory,memoryDomain:this.gr?'gpu':'wasm'};
  if(this.gr)options.makeSurface=(width,height,opaque=false)=>{
   if(this.gl.isContextLost())throw new GpuUnavailable('WebGL2 context lost');
   const surface=ck.MakeRenderTarget(this.gr,{width,height,colorType:ck.ColorType.RGBA_8888,alphaType:opaque?ck.AlphaType.Opaque:ck.AlphaType.Premul,colorSpace:ck.ColorSpace.SRGB});
   if(!surface)throw new GpuUnavailable('Cannot allocate GPU render target');return surface;
  };
  this.sceneRenderer=new SceneRenderer(ck,options);
 }
 get stats(){return this.sceneRenderer.stats;}
 retain(ids){this.sceneRenderer.retain(ids);}
 clear(){this.generation++;this.sceneRenderer.clear();}
 releaseGpu(){
  this.screen?.dispose();this.screen=null;
  if(this.gr){this.gr.releaseResourcesAndAbandonContext();this.gr.delete();this.gr=null;}
  if(this.handle){this.ck.deleteContext(this.handle);this.handle=null;}
  this.gpuCanvas?.removeEventListener('webglcontextlost',this.onLost);
  this.gl=null;this.gpuCanvas=null;
 }
 fallback(reason){
  this.sceneRenderer.clear();this.releaseGpu();this.createRenderer();
  this.presentation.mode=this.bitmap?'cpu-bitmap':'cpu-2d';this.presentation.fallbacks++;this.presentation.fallbackReason=reason;this.lost=false;
 }
 dispose({preserveDisplay=false}={}){if(this.disposed)return;this.disposed=true;this.clear();this.releaseGpu();const display=this.displayCharge;this.displayCharge=null;if(!preserveDisplay){this.canvas.width=0;this.canvas.height=0;display?.();}this.untrim?.();this.runtimeBinary?.();this.ck.setDecodeCacheLimitBytes(0);this.memory.sample(this.ck,null);return preserveDisplay?display:undefined;}
 async draw(frame,resources,background=this.ck.WHITE){
  try{return await this.drawOnce(frame,resources,background);}catch(error){
   if(!(error instanceof MemoryLimitError)||error.reason.startsWith('wasm heap')||error.reason==='picture decode headroom')throw error;
   if(this.gr&&error.reason==='GPU cache/texture estimate')this.fallback('GPU memory budget');
   this.memory.trim();return this.drawOnce(frame,resources,background);
  }
 }
 async drawOnce(frame,resources,background){
  if(this.disposed)throw new Error('Viewer presenter is disposed');
  const current=this.generation,ck=this.ck,{cssWidth:width,cssHeight:height}=frame.viewport;
  if(this.gr&&(this.lost||this.gl.isContextLost()))this.fallback('WebGL2 context lost');
  if(this.gr&&frame.resourceMemory){
   const images=Object.values(frame.resourceMemory.resources).reduce((sum,entry)=>sum+entry.imageBytes,0),passes=frame.scene.passes.reduce((sum,pass)=>sum+(pass.output[2]-pass.output[0])*(pass.output[3]-pass.output[1])*8,0);
   if(images+passes+this.memory.policy.gpuCache+this.sceneRenderer.rasterPixels*4>this.memory.policy.gpu)this.fallback('GPU image working set exceeds budget');
  }
  this.memory.observe(ck,this.gr);
  this.displayCharge.resize(8*Math.max(width*height,this.canvas.width*this.canvas.height,(this.gpuCanvas?.width??0)*(this.gpuCanvas?.height??0)));
  this.busy=true;const started=performance.now();let output,pixels,readCharge,bitmapCharge,rendered,read=0,bitmapMs=0,submitMs=0,gpu=!!this.gr;
  try{
   try{
    output=this.sceneRenderer.render(frame.scene,resources,background,frame.resourceMemory?.resources);this.memory.observe(ck,this.gr);rendered=performance.now();
    if(gpu&&output.damage){
     if(this.gl.isContextLost())throw new GpuUnavailable('WebGL2 context lost');
     if(!this.screen||this.gpuCanvas.width!==width||this.gpuCanvas.height!==height){
      this.screen?.dispose();this.screen=null;this.gpuCanvas.width=width;this.gpuCanvas.height=height;
      this.screen=ck.MakeOnScreenGLSurface(this.gr,width,height,ck.ColorSpace.SRGB);
      if(!this.screen)throw new GpuUnavailable('Cannot allocate GPU presentation surface');
     }
     const canvas=this.screen.getCanvas();canvas.clear(ck.TRANSPARENT);canvas.drawImage(output.image,0,0);this.screen.flush();
     if(this.gl.isContextLost())throw new GpuUnavailable('WebGL2 context lost');
     bitmapCharge=this.memory.reserve('bitmapTransit',width*height*4,'browser');const before=performance.now(),bitmap=this.gpuCanvas.transferToImageBitmap();bitmapMs=performance.now()-before;
     try{if(current!==this.generation)return;this.resize(width,height);this.context.transferFromImageBitmap(bitmap);}finally{bitmap.close();}
     submitMs=performance.now()-rendered;
    }
   }catch(error){
    if(!gpu||!(error instanceof GpuUnavailable||this.gl?.isContextLost()))throw error;
    output?.release();output=null;this.fallback(error.message);gpu=false;
    output=this.sceneRenderer.render(frame.scene,resources,background,frame.resourceMemory?.resources);rendered=performance.now();
   }
   if(!gpu&&output.damage){
    const [left,top,right,bottom]=this.bitmap?[0,0,width,height]:output.damage;
    const readWidth=right-left,readHeight=bottom-top;
    readCharge=this.memory.reserve('readback',readWidth*readHeight*4);const before=performance.now();pixels=output.image.readPixels(left,top,{width:readWidth,height:readHeight,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB});
    read=performance.now()-before;
    if(!pixels||pixels.byteLength!==readWidth*readHeight*4)throw new Error('Cannot read completed Viewer pixels');
    const data=new ImageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),readWidth,readHeight),submit=performance.now();
    if(this.bitmap){
     bitmapCharge=this.memory.reserve('bitmapTransit',readWidth*readHeight*4,'browser');
     const before=performance.now(),bitmap=await createImageBitmap(data);bitmapMs=performance.now()-before;
     try{if(current!==this.generation)return;this.resize(width,height);this.context.transferFromImageBitmap(bitmap);}finally{bitmap.close();}
    }else{if(current!==this.generation)return;this.resize(width,height);this.context.putImageData(data,left,top);}
    submitMs=performance.now()-submit;
   }
   const bytes=pixels?.byteLength??0;
   Object.assign(this.presentation,{frames:this.presentation.frames+1,gpuFrames:this.presentation.gpuFrames+Number(gpu),cpuFrames:this.presentation.cpuFrames+Number(!gpu),damage:output.damage,skipped:!output.damage,readbackBytes:bytes,totalReadbackBytes:this.presentation.totalReadbackBytes+bytes,renderMs:rendered-started,readbackMs:read,bitmapMs,submitMs,totalMs:performance.now()-started});
   this.memory.observe(ck,this.gr);
  }finally{output?.release();readCharge?.();bitmapCharge?.();this.busy=false;}
 }
 resize(width,height){if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;}
}
