import {isHash} from './wire.mjs';
export const LIVE_VERSION=4;
export const LIVE_LIMITS=Object.freeze({resourceBytes:16*1024*1024,sceneBytes:256*1024,frameBytes:64*1024*1024,
 cacheBytes:128*1024*1024,cacheResources:512,passes:64,quads:2048,dimension:4096});
export class RecoveryRequired extends Error {}
const integer=(n,min=1)=>Number.isSafeInteger(n)&&n>=min;
const numbers=(a,n)=>Array.isArray(a)&&a.length===n&&a.every(x=>Number.isFinite(x)&&Math.abs(x)<1e7);
export function validateScene(scene,required,viewport){
 if(!scene||!Array.isArray(scene.passes)||!scene.passes.length||scene.passes.length>LIVE_LIMITS.passes)throw new Error('Invalid scene graph');
 const ids=new Set(),used=new Set();let quads=0,pixels=0;
 for(const p of scene.passes){
  if(typeof p.id!=='string'||p.id.length>64||ids.has(p.id)||!numbers(p.output,4)||!p.output.every(Number.isInteger)||!Array.isArray(p.quads))throw new Error('Invalid render pass');
  const width=p.output[2]-p.output[0],height=p.output[3]-p.output[1];
  if(width<=0||height<=0||width>8192||height>8192||(pixels+=width*height)>32*1024*1024)throw new Error('Render-pass budget exceeded');
  for(const q of p.quads){
   if(++quads>LIVE_LIMITS.quads||!numbers(q.matrix,9)||!numbers(q.visible,4)||!numbers(q.rect,4)||
      q.clip!==null&&!numbers(q.clip,4)||!Number.isFinite(q.opacity)||q.opacity<0||q.opacity>1)throw new Error('Invalid quad');
   if(q.roundedClip!==undefined&&(!numbers(q.roundedClip,12)||q.roundedClip[2]<=q.roundedClip[0]||q.roundedClip[3]<=q.roundedClip[1]||q.roundedClip.slice(4).some(n=>n<0||n>8192)))throw new Error('Invalid rounded clip');
   if(q.kind==='picture'){
    if(!numbers(q.contentOrigin,2)||!isHash(q.resourceId)||typeof q.logical!=='string'||q.logical.length>512||!integer(q.revision)||
      !integer(q.width)||!integer(q.height)||q.width>8192||q.height>8192||!Number.isFinite(q.quadScale)||q.quadScale<=0||q.quadScale>128)throw new Error('Invalid picture reference');
    used.add(q.resourceId);
   }else if(q.kind==='pass'){if(!ids.has(q.passId))throw new Error('Cyclic or missing child pass');}
   else if(q.kind==='solid'){if(!numbers(q.color,4)||q.color.some(n=>n<0||n>1))throw new Error('Invalid color');}
   else throw new Error('Unknown quad kind');
  }
  ids.add(p.id);
 }
 const root=scene.passes.at(-1);
 if(scene.rootPass!==root.id||JSON.stringify(root.output)!==JSON.stringify([0,0,viewport.cssWidth,viewport.cssHeight]))throw new Error('Root viewport mismatch');
 if(used.size!==required.length||required.some(id=>!used.has(id)))throw new Error('Resource dependency mismatch');
 return scene;
}
function validateHeader(frame){
 if(frame?.protocol!==LIVE_VERSION||!integer(frame.pageEpoch)||!integer(frame.frameId)||!integer(frame.viewportVersion)||
   frame.baseFrameId!==null&&!integer(frame.baseFrameId)||!integer(frame.lastProcessedInputSeq,0))throw new Error('Invalid frame header');
 const v=frame.viewport;
 if(!v||![v.cssWidth,v.cssHeight].every(n=>integer(n)&&n<=LIVE_LIMITS.dimension)||v.deviceScaleFactor!==1)throw new Error('Invalid viewport');
 if(!Array.isArray(frame.requiredResources)||frame.requiredResources.length>256||!frame.requiredResources.every(isHash)||new Set(frame.requiredResources).size!==frame.requiredResources.length)throw new Error('Invalid dependencies');
}
export function makeDelta(previous,scene){
 const old=new Map(previous.passes.map(p=>[p.id,p]));const next=new Set(scene.passes.map(p=>p.id));
 return {rootPass:scene.rootPass,order:scene.passes.map(p=>p.id),
  upsert:scene.passes.filter(p=>JSON.stringify(old.get(p.id))!==JSON.stringify(p)),remove:[...old.keys()].filter(id=>!next.has(id))};
}
export function applyDelta(previous,delta){
 if(!delta||!Array.isArray(delta.upsert)||!Array.isArray(delta.remove)||!Array.isArray(delta.order)||
   delta.order.length>64||delta.upsert.length>64||delta.remove.length>64||new Set(delta.order).size!==delta.order.length)throw new Error('Invalid scene delta');
 const passes=new Map(previous.passes.map(p=>[p.id,p]));
 for(const id of delta.remove){if(typeof id!=='string')throw new Error('Invalid removal');passes.delete(id);}
 const changes=new Set();for(const pass of delta.upsert){if(!pass||typeof pass.id!=='string'||changes.has(pass.id))throw new Error('Duplicate pass update');changes.add(pass.id);passes.set(pass.id,pass);}
 if(passes.size!==delta.order.length||delta.order.some(id=>!passes.has(id)))throw new Error('Incomplete delta pass order');
 return {rootPass:delta.rootPass,passes:delta.order.map(id=>passes.get(id))};
}
export class LiveFrameGate {
 constructor(){this.resources=new Map();this.bytes=0;this.pending=null;this.committed=null;}
 put(id,payload){
  if(!isHash(id)||payload.byteLength<28||payload.byteLength>LIVE_LIMITS.resourceBytes)throw new Error('Invalid resource');
  if(this.resources.has(id))return;
  if(this.resources.size>=LIVE_LIMITS.cacheResources||this.bytes+payload.byteLength>LIVE_LIMITS.cacheBytes)throw new Error('Resource cache budget exceeded');
  this.resources.set(id,payload);this.bytes+=payload.byteLength;
 }
 stage(frame){
  validateHeader(frame);const old=this.committed;
  if(old&&(frame.pageEpoch<old.pageEpoch||frame.frameId<=old.frameId||frame.pageEpoch===old.pageEpoch&&frame.viewportVersion<old.viewportVersion))throw new Error('Stale frame');
  let scene;
  if(frame.baseFrameId===null){if(frame.delta)throw new Error('Full frame contains delta');scene=frame.scene;}
  else{
   if(!old||frame.pageEpoch!==old.pageEpoch||frame.viewportVersion!==old.viewportVersion||frame.baseFrameId!==old.frameId)throw new RecoveryRequired('Missing delta base');
   if(frame.scene)throw new Error('Delta contains full scene');scene=applyDelta(old.scene,frame.delta);
  }
  validateScene(scene,frame.requiredResources,frame.viewport);
  this.pending={...frame,scene};return this.pending;
 }
 commit(epoch,id,display=()=>{}){
  const frame=this.pending;
  if(!frame||frame.pageEpoch!==epoch||frame.frameId!==id)throw new Error('Unmatched frame commit');
  if(frame.requiredResources.some(id=>!this.resources.has(id)))return null;
  display(frame,this.resources); // Decode/render must succeed before advancing dependencies.
  this.committed=frame;this.pending=null;return frame;
 }
 release(id){
  if(this.committed?.requiredResources.includes(id)||this.pending?.requiredResources.includes(id))return false;
  const payload=this.resources.get(id);if(payload){this.bytes-=payload.byteLength;this.resources.delete(id);}return true;
 }
 collect(){for(const id of this.resources.keys())this.release(id);}
 recover(){this.pending=null;this.collect();}
}
