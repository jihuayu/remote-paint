// Replay Viz's render-pass graph. No source DOM, styles, fonts or image fetches.
export class SceneRenderer {
 constructor(ck){this.ck=ck;this.pictures=new Map();}
 clear(){for(const p of this.pictures.values())p.delete();this.pictures.clear();}
 retain(ids){for(const [id,p] of this.pictures)if(!ids.has(id)){p.delete();this.pictures.delete(id);}}
 render(scene,resources){
  const ck=this.ck,passes=new Map();let root=null,totalPixels=0;
  try{
   for(const pass of scene.passes){
    const [x,y,right,bottom]=pass.output,width=right-x,height=bottom-y;
    if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=8192)||(totalPixels+=width*height)>32*1024*1024)throw new Error('Render-pass surface budget exceeded');
    const surface=ck.MakeSurface(width,height);if(!surface)throw new Error('Cannot allocate render-pass surface');
    const canvas=surface.getCanvas();canvas.clear(ck.TRANSPARENT);canvas.translate(-x,-y);
    const record={surface,output:pass.output,image:null};passes.set(pass.id,record);
    for(const q of [...pass.quads].reverse()){
     if(q.opacity===0)continue;
     canvas.save();let alpha;
     try{
      if(q.clip)canvas.clipRect(q.clip,ck.ClipOp.Intersect,false);
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
   }
   root=passes.get(scene.rootPass);if(!root)throw new Error('Missing root render pass');
   const output={surface:root.surface,image:root.image,output:root.output};passes.delete(scene.rootPass);return output;
  }finally{for(const p of passes.values()){p.image?.delete();p.surface.dispose();}}
 }
}
