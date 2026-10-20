import {createHash} from 'node:crypto';
import {inspectResourceMemory,makeResourceMemory} from '../protocol/resource-memory.mjs';
import {LIVE_LIMITS,validateScene} from '../protocol/live-wire.mjs';
const sameNamespace=(a,b)=>Array.isArray(a)&&a.length===2&&a.every((n,i)=>Number.isSafeInteger(n)&&n>=0&&n===b[i]);
const finite=(a,count)=>Array.isArray(a)&&a.length===count&&a.every(n=>Number.isFinite(n)&&Math.abs(n)<1e7);
export class SceneMapper {
 constructor(){this.entries=new Map();this.resources=new Map();this.resourceMemory=new Map();this.resourceBytes=0;this.revision=0;this.epoch=0;}
 reset(){this.entries.clear();this.resources.clear();this.resourceMemory.clear();this.resourceBytes=0;this.revision=0;this.epoch=0;}
 map(capture,pageEpoch,viewport){
  const viz=capture.viz;
  if(!viz||viz.captureId!==capture.captureId||!Array.isArray(viz.namespace)||viz.namespace.length!==2||
    typeof capture.producer!=='string'||!Number.isSafeInteger(pageEpoch)||pageEpoch<1)throw new Error('Unpaired compositor/Viz capture');
  if(!Array.isArray(capture.resources)||capture.resources.length>256||!Array.isArray(viz.passes)||!viz.passes.length||viz.passes.length>64)throw new Error('Invalid native scene size');
  const byId=new Map(capture.resources.map(r=>[r.localId,r]));
  if(byId.size!==capture.resources.length)throw new Error('Duplicate native content ID');
  // A failed scene must not publish resources, memory descriptors or revisions.
  // Stage only this frame's additions; do not clone the retained history.
  const staged=new Map(),stagedMemory=new Map(),payloads=new Map(),entries=new Map(),passes=[],passIds=new Set();
  const memory=id=>stagedMemory.has(id)?stagedMemory.get(id):this.resourceMemory.get(id);
  let quads=0,frameBytes=0,revision=this.epoch===pageEpoch?this.revision:0;
  for(const pass of viz.passes){
   if(typeof pass.id!=='string'||passIds.has(pass.id)||!finite(pass.output,4)||!Array.isArray(pass.quads))throw new Error('Invalid Viz render pass');
   const mapped=[];
   for(const q of pass.quads){
    if(++quads>2048||!finite(q.matrix,9)||!finite(q.visible,4)||!finite(q.rect,4)||q.clip&&!finite(q.clip,4)||!Number.isFinite(q.opacity)||q.opacity<0||q.opacity>1)throw new Error('Invalid Viz quad');
    const out={kind:q.kind,matrix:q.matrix,visible:q.visible,rect:q.rect,clip:q.clip??null,opacity:q.opacity};
    if(q.roundedClip!==undefined){
     if(!finite(q.roundedClip,12)||q.roundedClip[2]<=q.roundedClip[0]||q.roundedClip[3]<=q.roundedClip[1]||q.roundedClip.slice(4).some(n=>n<0||n>8192))throw new Error('Invalid Viz rounded clip');
     out.roundedClip=q.roundedClip;
    }
    if(q.kind==='solid'){
     if(!finite(q.color,4)||q.color.some(c=>c<0||c>1))throw new Error('Invalid Viz color');out.color=q.color;
    }else if(q.kind==='pass'){
     if(!passIds.has(q.passId))throw new Error('Cyclic or missing Viz pass');out.passId=q.passId;
    }else if(q.kind==='picture'){
     if(!sameNamespace(q.namespace,viz.namespace))throw new Error('Child Surface painting is not implemented');
     if(!finite(q.contentOrigin,2))throw new Error('Invalid native content origin');
     out.contentOrigin=q.contentOrigin;
     const r=byId.get(q.localId);
     if(!r||!Number.isInteger(r.localId)||!Number.isFinite(r.quadScale)||r.quadScale<=0||r.quadScale>128||
       ![r.width,r.height].every(n=>Number.isInteger(n)&&n>0&&n<=8192))throw new Error('Viz content has no matching native full-layer record');
     const logical=`${pageEpoch}/${capture.producer}/${viz.namespace.join(':')}/${r.localId}`;
     let entry=entries.get(logical);
     if(!entry){
      let bytes,hash=r.resourceId;
      if(typeof r.skp==='string'){
       if(r.skp.length>24*1024*1024)throw new Error('Resource byte budget exceeded');
       bytes=Buffer.from(r.skp,'base64');if(bytes.length<28||bytes.length>LIVE_LIMITS.resourceBytes||bytes.subarray(0,8).toString()!=='skiapict')throw new Error('Invalid native SKP');
       const observed=createHash('sha256').update(bytes).digest('hex');
       if(hash!==undefined&&hash!==observed)throw new Error('Native resource checksum mismatch');
       hash=observed;bytes=staged.get(hash)??this.resources.get(hash)??bytes;
      }else{
       if(typeof hash!=='string'||!/^[0-9a-f]{64}$/.test(hash))throw new Error('Incremental native resource has no checksum');
       bytes=staged.get(hash)??this.resources.get(hash);if(!bytes)throw new Error('Incremental native resource cache miss');
      }
      const decoded=inspectResourceMemory(bytes,r),previous=memory(hash);
      if(previous&&decoded&&(previous.imageBytes!==decoded.imageBytes||previous.fontBytes!==decoded.fontBytes))throw new Error('Conflicting resource memory descriptor');
      staged.set(hash,bytes);stagedMemory.set(hash,decoded??previous??null);
      if(!payloads.has(hash)){frameBytes+=bytes.length;if(frameBytes>LIVE_LIMITS.frameBytes)throw new Error('Scene resource budget exceeded');}
      const old=this.epoch===pageEpoch?this.entries.get(logical):null;
      entry={logical,resourceId:hash,revision:old?.resourceId===hash?old.revision:++revision};entries.set(logical,entry);payloads.set(hash,bytes);
     }
     Object.assign(out,entry,{quadScale:r.quadScale,width:r.width,height:r.height,
       // Older captures did not carry the analysis bit; keep their safe
       // isolated replay semantics until a native producer explicitly says
       // that direct SrcOver replay is safe.
       requiresIsolation:r.requiresIsolation!==false,
       source:{namespace:q.namespace,stableLayerId:q.localId,vizResource:q.vizResource}});
    }else throw new Error('Unknown Viz quad');
    mapped.push(out);
   }
   passIds.add(pass.id);passes.push({id:pass.id,output:pass.output,quads:mapped});
  }
  const scene={rootPass:passes.at(-1).id,passes},required=[...payloads.keys()],root=passes.at(-1).output;
  viewport??={cssWidth:root[2],cssHeight:root[3]};
  if(![viewport.cssWidth,viewport.cssHeight].every(n=>Number.isSafeInteger(n)&&n>0&&n<=LIVE_LIMITS.dimension)||viewport.deviceScaleFactor!==undefined&&viewport.deviceScaleFactor!==1)throw new Error('Invalid viewport');
  validateScene(scene,required,viewport);
  if(Buffer.byteLength(JSON.stringify(scene))>LIVE_LIMITS.sceneBytes)throw new Error('Scene metadata budget exceeded');
  const result={scene,payloads,released:[...this.entries.keys()].filter(k=>!entries.has(k)),mappings:[...entries.values()],
    resourceMemory:makeResourceMemory(required,new Map(required.map(id=>[id,memory(id)]))),native:{captureId:capture.captureId,producer:capture.producer,namespace:viz.namespace,frameToken:capture.frameToken,sourceFrame:capture.sourceFrame,bitmapGlyphs:capture.resources.reduce((n,r)=>n+(r.bitmapGlyphs??0),0),timing:capture.timing??null}};
  let cacheBytes=this.resourceBytes,cacheEntries=this.resources.size;const victims=[];
  for(const [id,bytes]of staged)if(!this.resources.has(id)){cacheBytes+=bytes.length;cacheEntries++;}
  for(const [id,bytes] of this.resources){
   if(cacheBytes<=LIVE_LIMITS.cacheBytes&&cacheEntries<=LIVE_LIMITS.cacheResources)break;
   if(payloads.has(id))continue;victims.push(id);cacheBytes-=bytes.length;cacheEntries--;
  }
  if(cacheBytes>LIVE_LIMITS.cacheBytes||cacheEntries>LIVE_LIMITS.cacheResources)throw new Error('Mapper cache budget exceeded');
  // All validation and result construction succeeded. Commit without an await.
  for(const id of victims){this.resources.delete(id);this.resourceMemory.delete(id);}
  for(const [id,bytes]of staged){this.resources.set(id,bytes);this.resourceMemory.set(id,stagedMemory.get(id));}
  this.resourceBytes=cacheBytes;this.entries=entries;this.revision=revision;this.epoch=pageEpoch;
  return result;
 }
}
