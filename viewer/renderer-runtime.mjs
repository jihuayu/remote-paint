import {FramePresenter} from './frame-presenter.mjs';
import {MemoryLimitError} from '../protocol/client-memory.mjs';

// CanvasKit's opaque font/allocator arenas cannot shrink through its bitmap
// cache API. Rotate only the rendering instance; protocol baselines, pinned
// bytes, sockets and the UI-thread control lease remain in their own lifetime.
export class RendererRuntime{
 constructor(ck,canvas,{factory,wasmBinary,locateFile,memory,gpu='auto'}={}){
  this.canvas=canvas;this.factory=factory;this.wasmBinary=wasmBinary;this.locateFile=locateFile;this.memory=memory;this.gpu=gpu;this.generation=0;this.recycles=0;this.disposed=false;
  this.initialArenaBytes=ck.HEAPU8.buffer.byteLength;
  this.binaryPin=memory.buffer('wasmBinary',wasmBinary);this.presenter=new FramePresenter(ck,canvas,{memory,gpu});
 }
 get ck(){return this.presenter?.ck;}
 get gr(){return this.presenter?.gr;}
 get stats(){return {...this.presenter?.stats,arenaRecycles:this.recycles};}
 get presentation(){return this.presenter?.presentation;}
 retain(ids){this.presenter?.retain(ids);}
 clear(){this.generation++;this.presenter?.clear();}
 async recycle(){
  if(this.disposed)throw new Error('Renderer runtime is disposed');
  if(this.recycling)return this.recycling;
  const work=this.rebuild();this.recycling=work;try{return await work;}finally{this.recycling=null;}
 }
 async rebuild(){
  if(this.presenter){this.displayCarry=this.presenter.dispose({preserveDisplay:true});this.memory.retire(this.presenter.ck);this.presenter=null;}
  // Retired backings can survive several normal GC cycles. Admit at least
  // the measured initial heap before calling the factory,then reconcile its
  // actual size before creating presentation resources. No GC is requested.
  const admission=this.memory.reserve('wasmInitialization',this.initialArenaBytes,'wasm');let ck;
  try{
   ck=await this.factory({wasmBinary:this.wasmBinary,locateFile:this.locateFile});
   admission.resize(ck.HEAPU8.buffer.byteLength);
   if(this.disposed)throw new Error('Renderer runtime disposed during recycle');
   this.presenter=new FramePresenter(ck,this.canvas,{memory:this.memory,gpu:this.gpu,displayCharge:this.displayCarry});this.displayCarry=null;this.recycles++;
   ck=null;
  }catch(error){if(ck)this.memory.retire(ck);throw error;}finally{admission();}
 }
 async draw(frame,resources){
  if(this.disposed)throw new Error('Renderer runtime is disposed');
  const current=this.generation;if(this.recycling)await this.recycling;if(!this.presenter)await this.recycle();this.memory.sample(this.ck,this.gr);
  if(this.memory.shouldRecycle())await this.recycle();
  if(current!==this.generation)return;
  try{return await this.presenter.draw(frame,resources);}catch(error){
   if(!(error instanceof MemoryLimitError)||!error.reason.startsWith('wasm heap')&&error.reason!=='picture decode headroom')throw error;
   await this.recycle();if(current!==this.generation)return;return this.presenter.draw(frame,resources);
  }
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.clear();if(this.presenter){this.presenter.dispose();this.memory.retire(this.presenter.ck);this.presenter=null;}this.displayCarry?.();this.displayCarry=null;this.canvas.width=0;this.canvas.height=0;this.binaryPin();this.wasmBinary=null;this.factory=null;this.locateFile=null;}
}
