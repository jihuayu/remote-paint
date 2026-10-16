// Replay Viz's render-pass graph. No source DOM, styles, fonts or image fetches.
export class SceneRenderer {
 constructor(ck,{incremental=false}={}){this.ck=ck;this.incremental=incremental;this.pictures=new Map();this.passCache=new Map();this.passVersion=0;}
 clear(){for(const p of this.pictures.values())p.delete();this.pictures.clear();for(const {image} of this.passCache.values())image.delete();this.passCache.clear();}
 retain(ids){for(const [id,p] of this.pictures)if(!ids.has(id)){p.delete();this.pictures.delete(id);}}
 render(scene,resources,background=this.ck.TRANSPARENT){
  const ck=this.ck,passes=new Map();let root=null,totalPixels=0;
   const activePasses=new Set(scene.passes.map(pass=>pass.id));
   if(this.incremental)for(const [id,cached] of this.passCache)if(!activePasses.has(id)){cached.image.delete();this.passCache.delete(id);}
  try{
   for(const pass of scene.passes){
    const [x,y,right,bottom]=pass.output,width=right-x,height=bottom-y;
    if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||(totalPixels+=width*height)>32*1024*1024)throw new Error('Render-pass surface budget exceeded');
      const childVersions=pass.quads.filter(q=>q.kind==='pass').map(q=>`${q.passId}:${this.passCache.get(q.passId)?.version??0}`).join(',');
      const signature=this.incremental?JSON.stringify({pass,background:pass.id===scene.rootPass?background:null,childVersions}):null;
      const cached=this.incremental&&this.passCache.get(pass.id);
      if(cached?.signature===signature){passes.set(pass.id,{surface:null,output:cached.output,image:cached.image,cached:true});continue;}
    const surface=makePremultipliedSurface(ck,width,height,pass.id===scene.rootPass&&background[3]===1);if(!surface)throw new Error('Cannot allocate render-pass surface');
    const canvas=surface.getCanvas();canvas.clear(pass.id===scene.rootPass?background:ck.TRANSPARENT);canvas.translate(-x,-y);
      const record={surface,output:pass.output,image:null,cached:false};passes.set(pass.id,record);
    for(const q of [...pass.quads].reverse()){
     if(q.opacity===0)continue;
     canvas.save();let alpha;
     try{
      if(q.clip)canvas.clipRect(q.clip,ck.ClipOp.Intersect,false);
      if(q.roundedClip)canvas.clipRRect(q.roundedClip,ck.ClipOp.Intersect,true);
      if(q.opacity!==1){alpha=new ck.Paint();alpha.setAlphaf(q.opacity);canvas.saveLayer(alpha);}
      try{
       canvas.concat(q.matrix);canvas.clipRect(q.visible,ck.ClipOp.Intersect,false);
       if(q.kind==='picture'){
        let picture=this.pictures.get(q.resourceId);
        if(!picture){
         const bytes=resources.get(q.resourceId);if(!bytes)throw new Error('Missing committed picture resource');
         picture=ck.MakePicture(bytes);if(!picture)throw new Error('CanvasKit refused native SKP');
         const cull=picture.cullRect();
         if(cull[0]!==0||cull[1]!==0||cull[2]!==q.width||cull[3]!==q.height){picture.delete();throw new Error('Native picture bounds mismatch');}
         this.pictures.set(q.resourceId,picture);
        }
        // A recording may clear with kSrc. Replay into an isolated layer so
        // it cannot erase previously composed quads through transparent pixels.
        canvas.saveLayer();
        try{canvas.translate(...q.contentOrigin);canvas.scale(q.quadScale,q.quadScale);canvas.drawPicture(picture);}
        finally{canvas.restore();}
       }else if(q.kind==='solid'){
        const paint=new ck.Paint();try{paint.setColor(q.color);paint.setAntiAlias(false);canvas.drawRect(q.rect,paint);}finally{paint.delete();}
       }else if(q.kind==='pass'){
        const child=passes.get(q.passId);if(!child?.image)throw new Error('Missing or cyclic render pass');
        canvas.drawImage(child.image,child.output[0],child.output[1]);
       }else throw new Error('Unsupported scene command');
      }finally{if(alpha)canvas.restore();}
     }finally{canvas.restore();alpha?.delete();}
    }
      surface.flush();record.image=surface.makeImageSnapshot();if(!record.image)throw new Error('Cannot snapshot render pass');
      if(this.incremental){
       const old=this.passCache.get(pass.id);old?.image.delete();
       this.passCache.set(pass.id,{signature,image:record.image,output:record.output,version:++this.passVersion});
       surface.dispose();record.surface=null;record.cached=true;
      }
   }
   root=passes.get(scene.rootPass);if(!root)throw new Error('Missing root render pass');
   const output={surface:root.surface,image:root.image,output:root.output,release:this.incremental?()=>{}:undefined};passes.delete(scene.rootPass);return output;
  }finally{for(const p of passes.values()){if(p.cached)continue;p.image?.delete();p.surface?.dispose();}}
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
