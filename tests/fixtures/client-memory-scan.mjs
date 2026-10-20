// Pinned pre-incremental full-scan reference for differential ledger tests.
const MiB=1024*1024;
const profiles={
 compact:{total:640,js:192,wasm:256,gpu:128,render:96,pictures:16,rasters:16,chunks:64,raw:64,receive:32,decodeCache:8,gpuCache:64},
 standard:{total:1024,js:256,wasm:512,gpu:256,render:256,pictures:64,rasters:32,chunks:128,raw:128,receive:64,decodeCache:32,gpuCache:128},
 large:{total:1792,js:384,wasm:768,gpu:512,render:512,pictures:128,rasters:64,chunks:128,raw:128,receive:128,decodeCache:64,gpuCache:256},
};
export class MemoryLimitError extends Error{
 constructor(reason){super(`Viewer memory budget exceeded: ${reason}`);this.name='MemoryLimitError';this.code='VIEWER_MEMORY_LIMIT';this.reason=reason;}
}
// Estimate retained JSON-like objects separately from ArrayBuffer storage.
// Object/slot/string costs vary by engine; this deliberately counts scalar
// strings conservatively and visits shared objects only once per owner.
export function estimateJsMetadata(value,{maxBytes=16*MiB,maxNodes=262144,maxDepth=64,shared=true}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0||!Number.isSafeInteger(maxNodes)||maxNodes<1||!Number.isInteger(maxDepth)||maxDepth<1||typeof shared!=='boolean')throw new Error('Invalid metadata estimate limits');
 let bytes=0,nodes=0;const seen=new WeakSet(),active=new WeakSet();
 const add=size=>{bytes+=size;if(bytes>maxBytes)throw new MemoryLimitError('retained metadata estimate');};
 const visit=(item,depth)=>{
  if(++nodes>maxNodes||depth>maxDepth)throw new MemoryLimitError('metadata traversal limit');
  if(item===null||item===undefined){add(4);return;}
  if(typeof item==='string'){add(32+item.length*2);return;}
  if(typeof item==='number'){if(!Number.isFinite(item))throw new Error('Invalid numeric metadata');add(8);return;}
  if(typeof item==='boolean'){add(4);return;}
  if(typeof item!=='object'||ArrayBuffer.isView(item)||item instanceof ArrayBuffer)throw new Error('Expected JSON-like metadata');
  if(shared&&seen.has(item))return;if(!shared&&active.has(item))throw new Error('Cyclic metadata cannot be copied');seen.add(item);active.add(item);
  try{
  if(Array.isArray(item)){
   if(item.length>maxNodes-nodes)throw new MemoryLimitError('metadata traversal limit');
   add(64+item.length*8);for(const child of item)visit(child,depth+1);
  }else{
   const prototype=Object.getPrototypeOf(item);if(prototype!==null&&prototype!==Object.prototype)throw new Error('Expected plain metadata object');
   const keys=Object.keys(item);if(keys.length>maxNodes-nodes)throw new MemoryLimitError('metadata traversal limit');
   add(96);for(const key of keys){add(32+key.length*2);visit(item[key],depth+1);}
  }
  }finally{active.delete(item);}
 };
 visit(value,0);return bytes;
}
export function memoryPolicy({profile,deviceMemory=globalThis.navigator?.deviceMemory}={}){
 profile??=Number.isFinite(deviceMemory)&&deviceMemory<=4?'compact':'standard';
 if(!Object.hasOwn(profiles,profile))throw new Error('Invalid Viewer memory profile');
 return Object.freeze({profile,...Object.fromEntries(Object.entries(profiles[profile]).map(([key,value])=>[key,value*MiB]))});
}

// Exact ArrayBuffer ownership is deduplicated across receive/cache owners.
// Wasm objects and textures are estimates/views of their measured arenas, not
// extra memory to add a second time to Wasm heap or Skia's GPU cache usage.
export class ClientMemory{
 constructor(policy=memoryPolicy()){
  this.policy=policy;this.entries=new Map();this.buffers=new Map();this.trimmers=new Set();this.observed={wasmHeapBytes:0,decodeCacheBytes:0,gpuCacheBytes:null,gpuUsageSource:'unavailable'};
  this.stats={pressureEvents:0,failures:0,trims:0,peakResidentEstimate:0,peakJsBufferBytes:0,peakJsIndexEstimateBytes:0,retiredArenas:0,collectedArenas:0};this.trimming=false;this.retired=new Map();
  this.finalizer=typeof FinalizationRegistry==='function'?new FinalizationRegistry(token=>{if(this.retired.delete(token))this.stats.collectedArenas++;}):null;
 }
 addTrimmer(trim){this.trimmers.add(trim);return()=>this.trimmers.delete(trim);}
 trim(){if(this.trimming)return;this.trimming=true;try{for(const trim of this.trimmers)trim();this.stats.trims++;}finally{this.trimming=false;}}
 reserve(category,bytes,domain='js',{metadataBytes=0}={}){
  if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isSafeInteger(metadataBytes)||metadataBytes<0||!['js','wasm','gpu','browser'].includes(domain))throw new Error('Invalid memory reservation');
  return this.add({category,bytes,domain,metadataBytes,decodeHeadroomBytes:category==='pictureDecode'?bytes:0});
 }
 buffer(category,view,{metadataBytes=0}={}){
  const buffer=ArrayBuffer.isView(view)?view.buffer:view;
  if(!(buffer instanceof ArrayBuffer))throw new Error('Expected owned ArrayBuffer');
  if(!Number.isSafeInteger(metadataBytes)||metadataBytes<0)throw new Error('Invalid memory metadata estimate');
  return this.add({category,bytes:buffer.byteLength,domain:'js',buffer,metadataBytes});
 }
 add(entry){
  const token={};this.entries.set(token,entry);
  if(entry.buffer)this.buffers.set(entry.buffer,(this.buffers.get(entry.buffer)??0)+1);
  const release=()=>{if(!this.entries.delete(token))return;if(entry.buffer){const refs=this.buffers.get(entry.buffer)-1;if(refs)this.buffers.set(entry.buffer,refs);else this.buffers.delete(entry.buffer);}};
  release.resize=bytes=>{if(entry.buffer||!this.entries.has(token)||!Number.isSafeInteger(bytes)||bytes<0)throw new Error('Invalid memory reservation resize');const old=entry.bytes;entry.bytes=bytes;try{this.check();}catch(error){entry.bytes=old;throw error;}};
  release.split=(category,bytes,domain=entry.domain,options={})=>{if(entry.buffer||!this.entries.has(token)||!Number.isSafeInteger(bytes)||bytes<0||bytes>entry.bytes)throw new Error('Invalid memory reservation split');const old=entry.bytes;entry.bytes-=bytes;try{return this.reserve(category,bytes,domain,options);}catch(error){entry.bytes=old;throw error;}};
  try{this.check();}catch(error){release();throw error;}
  return release;
 }
 totals(){
  const categories={},domains={js:0,wasm:0,gpu:0,browser:0};let referencedJsBytes=0,ownerMetadataBytes=0,decodeHeadroomBytes=0;
  for(const entry of this.entries.values()){
   categories[entry.category]=(categories[entry.category]??0)+entry.bytes;
   if(entry.buffer)referencedJsBytes+=entry.bytes;else domains[entry.domain]+=entry.bytes;
   ownerMetadataBytes+=entry.metadataBytes??0;
   decodeHeadroomBytes+=entry.decodeHeadroomBytes??0;
  }
  let jsBufferBytes=0;for(const buffer of this.buffers.keys())jsBufferBytes+=buffer.byteLength;
  domains.js+=jsBufferBytes;
  // V8/JS-engine sizes vary. Charge conservative per-owner estimates for
  // ledger maps/tokens/closures and explicitly described cache indexes.
  // These are estimates, kept separate from exact backing-buffer storage.
  const ledgerIndexEstimateBytes=this.entries.size*512+this.buffers.size*96+this.trimmers.size*128+this.retired.size*128;
  const jsIndexEstimateBytes=ledgerIndexEstimateBytes+ownerMetadataBytes;
  categories.jsIndexEstimate=jsIndexEstimateBytes;domains.js+=jsIndexEstimateBytes;
  const renderBytes=['passes','rasters','rasterWork','layers','label'].reduce((n,key)=>n+(categories[key]??0),0);
  const retiredWasmBytes=[...this.retired.values()].reduce((n,bytes)=>n+bytes,0);
  const residentEstimate=domains.js+Math.max(this.observed.wasmHeapBytes,domains.wasm+this.observed.decodeCacheBytes)+Math.max(domains.gpu,this.observed.gpuCacheBytes??0)+domains.browser+retiredWasmBytes;
  return {categories,domains,jsBufferBytes,referencedJsBytes,jsIndexEstimateBytes,ledgerIndexEstimateBytes,ownerMetadataBytes,decodeHeadroomBytes,renderBytes,residentEstimate,retiredWasmBytes,retiredArenaCount:this.retired.size,owners:this.entries.size,buffers:this.buffers.size};
 }
 violation(t){
  const p=this.policy;
  if(this.observed.wasmHeapBytes>p.wasm)return 'wasm heap (runtime restart required)';
  if(t.decodeHeadroomBytes>0&&this.observed.wasmHeapBytes+t.decodeHeadroomBytes+(t.categories.rasterWork??0)+(t.categories.layers??0)>p.wasm)return 'picture decode headroom';
  if(t.domains.wasm+this.observed.decodeCacheBytes>p.wasm)return 'wasm object estimate';
  if(t.domains.js>p.js)return 'JavaScript buffers and metadata';
  if(t.renderBytes>p.render)return 'render working set';
  for(const category of ['pictures','rasters','chunks','raw','receive'])if((t.categories[category]??0)>p[category])return category;
  if(Math.max(t.domains.gpu,this.observed.gpuCacheBytes??0)>p.gpu)return 'GPU cache/texture estimate';
  if(t.residentEstimate>p.total)return 'combined resident estimate';
  return null;
 }
 check(){
  let totals=this.totals(),reason=this.violation(totals);
  if(reason&&!this.trimming){this.stats.pressureEvents++;this.trim();totals=this.totals();reason=this.violation(totals);}
  if(reason){this.stats.failures++;throw new MemoryLimitError(reason);}
  this.stats.peakResidentEstimate=Math.max(this.stats.peakResidentEstimate,totals.residentEstimate);this.stats.peakJsBufferBytes=Math.max(this.stats.peakJsBufferBytes,totals.jsBufferBytes);
  this.stats.peakJsIndexEstimateBytes=Math.max(this.stats.peakJsIndexEstimateBytes,totals.jsIndexEstimateBytes);
 }
 sample(ck,gr){
  this.observed.wasmHeapBytes=ck.HEAPU8?.buffer.byteLength??0;
  this.observed.decodeCacheBytes=ck.getDecodeCacheUsedBytes?.()??0;
  this.observed.gpuCacheBytes=null;this.observed.gpuUsageSource='unavailable';
  if(gr){
   let used=gr.getResourceCacheUsageBytes();
   // CanvasKit 0.42's JS wrapper activates the context but omits return.
   // Read its pinned binding after activation; never patch the vendor code.
   if(used===undefined&&typeof gr._getResourceCacheUsageBytes==='function'){used=gr._getResourceCacheUsageBytes();this.observed.gpuUsageSource='canvaskit-0.42-binding';}
   else this.observed.gpuUsageSource='public-api';
   if(Number.isFinite(used)&&used>=0)this.observed.gpuCacheBytes=used;
  }
 }
 observeWasm(ck){this.observed.wasmHeapBytes=ck.HEAPU8?.buffer.byteLength??this.observed.wasmHeapBytes;this.observed.decodeCacheBytes=ck.getDecodeCacheUsedBytes?.()??this.observed.decodeCacheBytes;this.check();}
 observe(ck,gr){this.sample(ck,gr);this.check();return this.snapshot();
 }
 shouldRecycle(){return this.observed.wasmHeapBytes>=this.policy.wasm*.7;}
 retire(ck){
  const token={};this.retired.set(token,ck.HEAPU8.buffer.byteLength);this.stats.retiredArenas++;this.finalizer?.register(ck,token);
  this.observed={wasmHeapBytes:0,decodeCacheBytes:0,gpuCacheBytes:null,gpuUsageSource:'unavailable'};
 }
 snapshot(){return {profile:this.policy.profile,decodeAdmission:this.decodeAdmission??'not-negotiated',limits:{...this.policy},...this.totals(),observed:{...this.observed},stats:{...this.stats},accounting:'ArrayBuffers exact/deduplicated; retained scenes/pass copies and cache/ledger JS metadata estimated; Wasm heap and Skia caches observed; objects/textures/browser surfaces estimated; transient parser/VM/driver/process overhead not fully covered'};}
}
