import {passDamage,quadBounds,intersect} from './damage.mjs';
import {MemoryLimitError,estimateJsMetadata} from '../protocol/client-memory.mjs';
// Replay Viz's render-pass graph. No source DOM, styles, fonts or image fetches.
export class SceneRenderer {
 constructor(ck,{incremental=false,rasterCache=incremental,rasterPixels=8*1024*1024,makeSurface=(width,height,opaque)=>makePremultipliedSurface(ck,width,height,opaque),memory,memoryDomain='wasm'}={}){
  this.ck=ck;this.memory=memory;this.memoryDomain=memoryDomain;this.pictureBytes=0;this.pictureCharges=new Map();this.busy=false;
  this.makeSurface=(width,height,opaque=false,category='passes')=>{
   const release=memory?.reserve(category,width*height*(category==='passes'?8:4),memoryDomain);let surface;
   try{surface=makeSurface(width,height,opaque);if(!surface){release?.();return null;}}catch(error){release?.();throw error;}
   const dispose=surface.dispose.bind(surface);let disposed=false;surface.dispose=()=>{if(disposed)return;disposed=true;try{dispose();}finally{release?.();}};return surface;
  };
  this.incremental=incremental;this.rasterCache=rasterCache;this.rasterLimit=Math.min(rasterPixels,(memory?.policy.rasters??Infinity)/4);this.rasterPixels=0;this.rasters=new Map();this.pictures=new Map();this.passCache=new Map();this.passVersion=0;this.stats={pictureDecodes:0,pictureRasters:0,pictureRasterHits:0,passRenders:0,passHits:0,isolatedDraws:0,passSurfaceAllocations:0,damagedPixels:0,partialPassRenders:0,quadsDrawn:0,quadsCulled:0,pictureEvictions:0,rasterEvictions:0};
 }
 dropPicture(id){try{this.pictures.get(id)?.delete();}finally{this.pictures.delete(id);const entry=this.pictureCharges.get(id);if(entry){entry.release?.();if(!entry.transient)this.pictureBytes-=entry.bytes;this.pictureCharges.delete(id);}}}
 dropRaster(id){const entry=this.rasters.get(id);if(!entry)return;entry.image.delete();entry.release?.();this.rasterPixels-=entry.pixels;this.rasters.delete(id);}
 dropPassMetadata(entry){entry.metadataRelease?.();entry.metadataRelease=null;entry.pass=null;entry.signature=null;entry.background=null;}
 dropPass(id){const entry=this.passCache.get(id);if(!entry)return;try{entry.image.delete();}finally{try{entry.surface.dispose();}finally{this.dropPassMetadata(entry);this.passCache.delete(id);}}}
 passMetadata(pass,background,childVersions){
  const data={pass,background,childVersions},estimate=this.memory?estimateJsMetadata(data,{maxBytes:Math.min(this.memory.policy.js,16*1024*1024),shared:false}):0;
  // JSON escaping can expand one UTF-16 unit to six. Reserve signature work
  // plus the expanded deep copy before either allocation; then resize this
  // same lease to the retained copy estimate and actual signature length.
  let release=this.memory?.reserve('passMetadata',estimate*7+512);let signature;
  try{signature=JSON.stringify(data);}catch(error){release?.();throw error;}
  return {signature,take(){release?.resize(estimate+signature.length*2+544);const copy=JSON.parse(signature),owned={signature,pass:copy.pass,background:copy.background,release};release=null;return owned;},dispose(){release?.();release=null;}};
 }
 clear(){for(const id of this.pictures.keys())this.dropPicture(id);for(const id of this.passCache.keys())this.dropPass(id);for(const id of this.rasters.keys())this.dropRaster(id);this.webglLabel?.delete();this.webglLabel=null;this.labelRelease?.();this.labelRelease=null;}
 trim(){if(this.busy)return;this.stats.pictureEvictions+=this.pictures.size;this.stats.rasterEvictions+=this.rasters.size;this.clear();}
 pictureWork(bytes,decode){
  if(!decode||!this.memory)return;
  if(!bytes||!['imageBytes','fontBytes'].every(key=>Number.isSafeInteger(decode[key])&&decode[key]>=0&&decode[key]<=2**40))throw new Error('Invalid resource decode estimate');
  const decoded=decode.imageBytes+decode.fontBytes;
  this.memory.observeWasm(this.ck);
  return this.memory.reserve('pictureDecode',bytes.byteLength*2+decoded*2+1024*1024,'wasm');
 }
 picture(id,bytes,width,height,decode,work){
  let picture=this.pictures.get(id);
  const decoded=decode?decode.imageBytes+decode.fontBytes:0,prior=this.pictureCharges.get(id)?.decode;
  if(picture&&decode&&prior&&(prior.imageBytes!==decode.imageBytes||prior.fontBytes!==decode.fontBytes))throw new Error('Resource memory descriptor changed');
  if(picture&&decode&&!prior){this.dropPicture(id);picture=null;}
  if(picture){this.pictures.delete(id);this.pictures.set(id,picture);}
  else{
   if(!bytes)throw new Error('Missing committed picture resource');
   const temporary=!decode?this.memory?.reserve('pictureDecode',bytes.byteLength*2,'wasm'):undefined;let release;
   try{
    const expected=bytes.byteLength+decoded,transient=!!decode&&expected>(this.memory?.policy.pictures??Infinity);
    if(!transient)while(this.pictureBytes+expected>(this.memory?.policy.pictures??Infinity)&&this.pictures.size){this.dropPicture(this.pictures.keys().next().value);this.stats.pictureEvictions++;}
    if(decode)release=work?.split(transient?'pictureTransient':'pictures',expected,'wasm',{metadataBytes:512+id.length*2});
    picture=this.ck.MakePicture(bytes);if(!picture)throw new Error('CanvasKit refused native SKP');
    if(decode)this.memory?.observeWasm(this.ck);
    const size=Math.max(bytes.byteLength,picture.approximateBytesUsed())+decoded;
    if(!transient)while(this.pictureBytes+size>(this.memory?.policy.pictures??Infinity)&&this.pictures.size){this.dropPicture(this.pictures.keys().next().value);this.stats.pictureEvictions++;}
    if(release)release.resize(size);else release=this.memory?.reserve(transient?'pictureTransient':'pictures',size,'wasm',{metadataBytes:512+id.length*2});this.pictures.set(id,picture);this.pictureCharges.set(id,{bytes:size,release,transient,decode:decode?{imageBytes:decode.imageBytes,fontBytes:decode.fontBytes}:null});if(!transient)this.pictureBytes+=size;this.stats.pictureDecodes++;
   }catch(error){try{picture?.delete();}finally{release?.();}throw error;}finally{temporary?.();}
  }
  const cull=picture.cullRect();if(cull[0]!==0||cull[1]!==0||cull[2]!==width||cull[3]!==height){this.dropPicture(id);throw new Error('Native picture bounds mismatch');}
  return picture;
 }
 layer(canvas,paint,bytes){const release=this.memory?.reserve('layers',bytes,this.memoryDomain);try{canvas.saveLayer(paint);}catch(error){release?.();throw error;}return()=>{try{canvas.restore();}finally{release?.();}};}
 drawPlaceholder(canvas,q){
  if(q.reason!=='webgl')throw new Error('Unsupported placeholder');
  const ck=this.ck,paint=new ck.Paint();
  try{paint.setColor(ck.BLACK);paint.setAntiAlias(false);canvas.drawRect(q.rect,paint);}finally{paint.delete();}
  // This label is Viewer UI, not source page text. Rasterize it once using
  // the client's system CJK font; keep it inside the same Viz clip/transform.
  if(!this.webglLabel){
   const label=typeof OffscreenCanvas!=='undefined'?new OffscreenCanvas(384,56):typeof document!=='undefined'?Object.assign(document.createElement('canvas'),{width:384,height:56}):null;
   const context=label?.getContext('2d');
   if(context){const release=this.memory?.reserve('label',384*56*4,'wasm');try{context.clearRect(0,0,384,56);context.font='32px sans-serif';context.fillStyle='white';context.textAlign='center';context.textBaseline='middle';context.fillText('WebGL 无法显示',192,28);this.webglLabel=ck.MakeImage({width:384,height:56,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB},context.getImageData(0,0,384,56).data,384*4);if(this.webglLabel)this.labelRelease=release;else release?.();}catch(error){release?.();throw error;}}
  }
  if(this.webglLabel){
   const [x,y,r,b]=q.rect,scale=Math.min(1,(r-x)/192,(b-y)/28),w=192*scale,h=28*scale;
   if(scale>0)canvas.drawImageRect(this.webglLabel,[0,0,384,56],[(x+r-w)/2,(y+b-h)/2,(x+r+w)/2,(y+b+h)/2],null);
  }
 }
 retain(ids){for(const id of this.pictures.keys())if(!ids.has(id))this.dropPicture(id);for(const id of this.rasters.keys())if(!ids.has(id))this.dropRaster(id);}
 raster(id,picture,width,height){
  if(!this.rasterCache)return null;
  const old=this.rasters.get(id);if(old){this.rasters.delete(id);this.rasters.set(id,old);this.stats.pictureRasterHits++;return old.image;}
  const pixels=width*height;if(pixels>this.rasterLimit)return null;
  while(this.rasterPixels+pixels>this.rasterLimit){this.dropRaster(this.rasters.keys().next().value);this.stats.rasterEvictions++;}
  let surface;try{surface=this.makeSurface(width,height,false,'rasterWork');}catch(error){if(error instanceof MemoryLimitError)return null;throw error;}if(!surface)throw new Error('Cannot allocate picture cache surface');
  let image,release;
  try{const canvas=surface.getCanvas();canvas.clear(this.ck.TRANSPARENT);canvas.drawPicture(picture);surface.flush();image=surface.makeImageSnapshot();if(!image)throw new Error('Cannot snapshot picture cache');release=this.memory?.reserve('rasters',pixels*4,this.memoryDomain,{metadataBytes:256+id.length*2});this.rasters.set(id,{image,pixels,release});this.rasterPixels+=pixels;this.stats.pictureRasters++;return image;}
  catch(error){image?.delete();release?.();if(error instanceof MemoryLimitError)return null;throw error;}finally{surface.dispose();}
 }
 render(scene,resources,background=this.ck.TRANSPARENT,resourceMemory){
  const ck=this.ck,passes=new Map(),damages=new Map();let root=null,totalPixels=0;this.busy=true;
  try{
   const activePasses=new Set(scene.passes.map(pass=>pass.id));
   if(this.incremental)for(const id of this.passCache.keys())if(!activePasses.has(id))this.dropPass(id);
   for(const pass of scene.passes){
    let prepared,retained;try{
    const [x,y,right,bottom]=pass.output,width=right-x,height=bottom-y;
    if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||(totalPixels+=width*height)>32*1024*1024)throw new Error('Render-pass surface budget exceeded');
      const childVersions=pass.quads.filter(q=>q.kind==='pass').map(q=>`${q.passId}:${this.passCache.get(q.passId)?.version??0}`).join(',');
      const passBackground=pass.id===scene.rootPass?[...background]:null;
      prepared=this.incremental?this.passMetadata(pass,passBackground,childVersions):null;const signature=prepared?.signature??null;
      const cached=this.incremental&&this.passCache.get(pass.id);
      let damage=this.incremental?passDamage(pass,cached?.pass,damages,{backgroundChanged:cached&&JSON.stringify(cached.background)!==JSON.stringify(passBackground)}):pass.output.slice();
      if(cached?.signature===signature)damage=null;
      damages.set(pass.id,damage);
      if(cached&&!damage){if(cached.signature!==signature){retained=prepared.take();const oldRelease=cached.metadataRelease;Object.assign(cached,{signature:retained.signature,pass:retained.pass,background:retained.background,metadataRelease:retained.release});retained=null;oldRelease?.();}this.stats.passHits++;passes.set(pass.id,{surface:null,output:cached.output,image:cached.image,cached:true});continue;}
    if(prepared)retained=prepared.take();
    const opaque=pass.id===scene.rootPass&&background[3]===1;
    const reuse=cached&&cached.opaque===opaque&&JSON.stringify(cached.output)===JSON.stringify(pass.output);
    const surface=reuse?cached.surface:this.makeSurface(width,height,opaque);if(!surface)throw new Error('Cannot allocate render-pass surface');
    if(!reuse)this.stats.passSurfaceAllocations++;
    const record={surface,output:pass.output.slice(),image:null,cached:false};passes.set(pass.id,record);
    if(reuse){try{cached.image.delete();}finally{this.dropPassMetadata(cached);this.passCache.delete(pass.id);}}
    this.stats.passRenders++;this.stats.damagedPixels+=(damage[2]-damage[0])*(damage[3]-damage[1]);
    if(JSON.stringify(damage)!==JSON.stringify(pass.output))this.stats.partialPassRenders++;
    const canvas=surface.getCanvas();canvas.save();
    try{
     canvas.translate(-x,-y);canvas.clipRect(damage,ck.ClipOp.Intersect,false);canvas.clear(pass.id===scene.rootPass?background:ck.TRANSPARENT);
    for(const q of [...pass.quads].reverse()){
     if(q.opacity===0)continue;
     if(!intersect(quadBounds(q,pass.output),damage)){this.stats.quadsCulled++;continue;}
     this.stats.quadsDrawn++;
     canvas.save();let alpha,restoreAlpha;
     try{
      if(q.clip)canvas.clipRect(q.clip,ck.ClipOp.Intersect,false);
      if(q.roundedClip)canvas.clipRRect(q.roundedClip,ck.ClipOp.Intersect,true);
      if(q.opacity!==1){alpha=new ck.Paint();alpha.setAlphaf(q.opacity);restoreAlpha=this.layer(canvas,alpha,(damage[2]-damage[0])*(damage[3]-damage[1])*4);}
      try{
       canvas.concat(q.matrix);canvas.clipRect(q.visible,ck.ClipOp.Intersect,false);
       if(q.kind==='picture'){
        const raw=resources.get(q.resourceId),decode=resourceMemory?.[q.resourceId],rasterHit=this.rasterCache&&this.rasters.has(q.resourceId),decodeWork=rasterHit?undefined:this.pictureWork(raw,decode);
        try{
        const picture=rasterHit?null:this.picture(q.resourceId,raw,q.width,q.height,decode,decodeWork);
        const image=this.raster(q.resourceId,picture,q.width,q.height);
        const isolate=!image&&q.requiresIsolation!==false;
        let restoreIsolate;if(isolate){restoreIsolate=this.layer(canvas,undefined,(damage[2]-damage[0])*(damage[3]-damage[1])*4);this.stats.isolatedDraws++;}
        try{canvas.translate(...q.contentOrigin);canvas.scale(q.quadScale,q.quadScale);if(image)canvas.drawImage(image,0,0);else canvas.drawPicture(picture);}
        finally{restoreIsolate?.();}
        }finally{try{if(this.pictureCharges.get(q.resourceId)?.transient)this.dropPicture(q.resourceId);}finally{decodeWork?.();}}
       }else if(q.kind==='placeholder'){
        this.drawPlaceholder(canvas,q);
       }else if(q.kind==='solid'){
        const paint=new ck.Paint();try{paint.setColor(q.color);paint.setAntiAlias(false);canvas.drawRect(q.rect,paint);}finally{paint.delete();}
       }else if(q.kind==='pass'){
        const child=passes.get(q.passId);if(!child?.image)throw new Error('Missing or cyclic render pass');
        canvas.drawImage(child.image,child.output[0],child.output[1]);
       }else throw new Error('Unsupported scene command');
      }finally{restoreAlpha?.();}
     }finally{canvas.restore();alpha?.delete();}
    }
    }finally{canvas.restore();}
      surface.flush();record.image=surface.makeImageSnapshot();if(!record.image)throw new Error('Cannot snapshot render pass');
      if(this.incremental){
       if(this.passCache.has(pass.id))this.dropPass(pass.id);
       this.passCache.set(pass.id,{signature:retained.signature,image:record.image,surface,opaque,output:record.output,pass:retained.pass,background:retained.background,metadataRelease:retained.release,version:++this.passVersion});retained=null;
       record.surface=null;record.cached=true;
      }
    }finally{prepared?.dispose();retained?.release?.();}
   }
   root=passes.get(scene.rootPass);if(!root)throw new Error('Missing root render pass');
   const output={surface:root.surface,image:root.image,output:root.output,damage:damages.get(scene.rootPass),release:this.incremental?()=>{}:undefined};passes.delete(scene.rootPass);return output;
  }finally{for(const p of passes.values()){if(p.cached)continue;p.image?.delete();p.surface?.dispose();}this.busy=false;}
 }
}

// CanvasKit.MakeSurface uses Unpremul for HTML ImageData. Intermediate Skia
// layers should stay premultiplied: otherwise every saveLayer restore and
// image blend converts the whole destination between alpha representations.
function makePremultipliedSurface(ck,width,height,opaque=false){
 const pixels=ck.Malloc(Uint8Array,width*height*4);let surface;
 try{
  surface=ck.MakeRasterDirectSurface({width,height,colorType:ck.ColorType.RGBA_8888,
   alphaType:opaque?ck.AlphaType.Opaque:ck.AlphaType.Premul,colorSpace:ck.ColorSpace.SRGB},pixels,width*4);
  if(!surface){ck.Free(pixels);return null;}
 }catch(error){ck.Free(pixels);throw error;}
 let disposed=false;
 surface.dispose=()=>{if(disposed)return;disposed=true;try{surface.delete();}finally{ck.Free(pixels);}};
 return surface;
}
