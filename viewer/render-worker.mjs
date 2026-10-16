import {SceneRenderer} from './scene-renderer.mjs';
import CanvasKitInit from './canvaskit-worker.mjs';
let ck,renderer,canvas,context;const resources=new Map();
const fail=(id,error)=>postMessage({type:'error',id,message:error?.message??String(error)});
self.onmessage=async event=>{
  const {type,id}=event.data;
  try{
    if(type==='init'){
      canvas=event.data.canvas;context=canvas.getContext('2d');const wasmUrl=new URL(event.data.wasmUrl,self.location.href).href;const wasm=await fetch(wasmUrl).then(r=>r.arrayBuffer());ck=await CanvasKitInit({wasmBinary:wasm,locateFile:file=>new URL(file,wasmUrl).href});renderer=new SceneRenderer(ck,{incremental:true});postMessage({type:'ready',id});return;
    }
    if(type==='clear'){renderer?.clear();resources.clear();postMessage({type:'cleared',id});return;}
    if(type==='retain'){const keep=new Set(event.data.ids??[]);for(const resourceId of resources.keys())if(!keep.has(resourceId))resources.delete(resourceId);renderer?.retain(keep);postMessage({type:'retained',id});return;}
    if(type!=='render'||!renderer)throw new Error('Render worker is not initialized');
    for(const item of event.data.resources??[])resources.set(item.id,new Uint8Array(item.buffer));
    const frame=event.data.frame,output=renderer.render(frame.scene,resources,ck.WHITE);
    try{
      const {cssWidth:width,cssHeight:height}=frame.viewport;
      const pixels=output.image.readPixels(0,0,{width,height,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB});
      if(!pixels||pixels.byteLength!==width*height*4)throw new Error('Cannot read completed Viewer pixels');
      if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),width,height),0,0);
    }finally{if(output.release)output.release();else{output.image.delete();output.surface?.dispose?.();}}
    postMessage({type:'rendered',id,renderMs:0});
  }catch(error){fail(id,error);}
};
