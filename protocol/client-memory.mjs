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
 #categories=new Map();
 #domains={js:0,wasm:0,gpu:0,browser:0};
 #jsBufferBytes=0;#referencedJsBytes=0;#ownerMetadataBytes=0;#decodeHeadroomBytes=0;
 #resizable=new Set();#dirty=false;
 #rebuildAggregates(){this.#categories=new Map();this.#domains={js:0,wasm:0,gpu:0,browser:0};this.#referencedJsBytes=0;this.#ownerMetadataBytes=0;this.#decodeHeadroomBytes=0;this.#dirty=false;for(const entry of this.entries.values())this.#adjust(entry,1);}
 #adjust(entry,sign){
  let category=this.#categories.get(entry.category);
  if(!category){category={bytes:0,owners:0};this.#categories.set(entry.category,category);}
  category.bytes+=sign*entry.bytes;category.owners+=sign;
  if(!category.owners)this.#categories.delete(entry.category);
  if(entry.buffer)this.#referencedJsBytes+=sign*entry.bytes;else this.#domains[entry.domain]+=sign*entry.bytes;
  this.#ownerMetadataBytes+=sign*(entry.metadataBytes??0);this.#decodeHeadroomBytes+=sign*(entry.decodeHeadroomBytes??0);
  this.#dirty ||= !Number.isSafeInteger(category.bytes)||!Number.isSafeInteger(this.#referencedJsBytes)||!Number.isSafeInteger(this.#ownerMetadataBytes)||!Number.isSafeInteger(this.#decodeHeadroomBytes)||!Number.isSafeInteger(this.#domains.js)||!Number.isSafeInteger(this.#domains.wasm)||!Number.isSafeInteger(this.#domains.gpu)||!Number.isSafeInteger(this.#domains.browser);
 }
 #changeBytes(entry,bytes){
  const delta=bytes-entry.bytes;this.#categories.get(entry.category).bytes+=delta;
  this.#domains[entry.domain]+=delta;entry.bytes=bytes;this.#dirty ||= !Number.isSafeInteger(this.#categories.get(entry.category).bytes)||!Number.isSafeInteger(this.#domains[entry.domain]);
 }
 #retainBacking(entry){
  if(!entry.buffer)return;
  let record=this.buffers.get(entry.buffer);
  if(record){record.refs++;return;}
  record={buffer:entry.buffer,refs:1,bytes:entry.buffer.byteLength};this.buffers.set(entry.buffer,record);this.#jsBufferBytes+=record.bytes;
  if(entry.buffer.resizable)this.#resizable.add(record);
 }
 #dropBacking(entry){
  if(!entry.buffer)return;const record=this.buffers.get(entry.buffer);
  if(--record.refs===0){this.#jsBufferBytes-=record.bytes;this.buffers.delete(entry.buffer);this.#resizable.delete(record);record.buffer=null;}
  // A retained release/resize/split callback must not pin returned storage.
  entry.buffer=null;
 }
 #refreshBackings(all=false){
  for(const record of all?this.buffers.values():this.#resizable){const bytes=record.buffer.byteLength;this.#jsBufferBytes+=bytes-record.bytes;record.bytes=bytes;}
 }

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
  const token={};this.entries.set(token,entry);this.#adjust(entry,1);this.#retainBacking(entry);
  const release=()=>{if(!this.entries.delete(token))return;this.#adjust(entry,-1);this.#dropBacking(entry);if(this.#dirty)this.#rebuildAggregates();};
  release.resize=bytes=>{
   if(entry.buffer||!this.entries.has(token)||!Number.isSafeInteger(bytes)||bytes<0)throw new Error('Invalid memory reservation resize');
   const old=entry.bytes;this.#changeBytes(entry,bytes);
   try{this.check();}catch(error){if(this.entries.has(token))this.#changeBytes(entry,old);if(this.#dirty)this.#rebuildAggregates();throw error;}
  };
  release.split=(category,bytes,domain=entry.domain,options={})=>{
   if(entry.buffer||!this.entries.has(token)||!Number.isSafeInteger(bytes)||bytes<0||bytes>entry.bytes)throw new Error('Invalid memory reservation split');
   const old=entry.bytes;this.#changeBytes(entry,old-bytes);
   try{return this.reserve(category,bytes,domain,options);}catch(error){if(this.entries.has(token))this.#changeBytes(entry,old);if(this.#dirty)this.#rebuildAggregates();throw error;}
  };
  try{this.check();}catch(error){release();throw error;}
  return release;
 }
 // Reporting reconciles externally resized/detached backing stores. Fixed
 // backing lengths only shrink without an explicit owner operation,so cached
 // admission totals are a safe upper bound;reconcile before pressure/eviction.
 totals(){if(this.#dirty)this.#rebuildAggregates();this.#refreshBackings(true);return this.#totals();}
 #totals(){
  const categories=Object.fromEntries([...this.#categories].map(([name,value])=>[name,value.bytes])),domains={...this.#domains};
  const jsBufferBytes=this.#jsBufferBytes,referencedJsBytes=this.#referencedJsBytes,ownerMetadataBytes=this.#ownerMetadataBytes,decodeHeadroomBytes=this.#decodeHeadroomBytes;
  domains.js+=jsBufferBytes;
  // Existing96-byte per-backing estimate covers its map slot and small
  // refs/length record. Aggregate category records are separately estimated.
  const aggregateIndexEstimateBytes=this.#categories.size*160+this.#resizable.size*128;
  const ledgerIndexEstimateBytes=this.entries.size*512+this.buffers.size*96+this.trimmers.size*128+this.retired.size*128+aggregateIndexEstimateBytes;
  const jsIndexEstimateBytes=ledgerIndexEstimateBytes+ownerMetadataBytes;
  categories.jsIndexEstimate=jsIndexEstimateBytes;domains.js+=jsIndexEstimateBytes;
  const renderBytes=['passes','rasters','rasterWork','layers','label'].reduce((n,key)=>n+(categories[key]??0),0);
  let retiredWasmBytes=0;for(const bytes of this.retired.values())retiredWasmBytes+=bytes;
  const residentEstimate=domains.js+Math.max(this.observed.wasmHeapBytes,domains.wasm+this.observed.decodeCacheBytes)+Math.max(domains.gpu,this.observed.gpuCacheBytes??0)+domains.browser+retiredWasmBytes;
  return {categories,domains,jsBufferBytes,referencedJsBytes,aggregateIndexEstimateBytes,jsIndexEstimateBytes,ledgerIndexEstimateBytes,ownerMetadataBytes,decodeHeadroomBytes,renderBytes,residentEstimate,retiredWasmBytes,retiredArenaCount:this.retired.size,owners:this.entries.size,buffers:this.buffers.size};
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
  if(this.#dirty)this.#rebuildAggregates();this.#refreshBackings();let totals=this.#totals(),reason=this.violation(totals);
  if(reason){this.#refreshBackings(true);totals=this.#totals();reason=this.violation(totals);}
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
  // Views may outlive the module wrapper. Keep the retired allocation charged
  // until its actual backing store is collectible, not merely the wrapper.
  const backing=ck.HEAPU8.buffer,token={};this.retired.set(token,backing.byteLength);this.stats.retiredArenas++;this.finalizer?.register(backing,token);
  this.observed={wasmHeapBytes:0,decodeCacheBytes:0,gpuCacheBytes:null,gpuUsageSource:'unavailable'};
 }
 snapshot(){return {profile:this.policy.profile,decodeAdmission:this.decodeAdmission??'not-negotiated',limits:{...this.policy},...this.totals(),observed:{...this.observed},stats:{...this.stats},accounting:'ArrayBuffers deduplicated/current byteLength reconciled on reports; fixed-backing admission uses conservative cached upper bounds, resizable backings refresh every check; peaks are admission estimates; category/resizable aggregate metadata estimated; retained scenes/pass copies and cache/ledger JS metadata estimated; Wasm heap and Skia caches observed; objects/textures/browser surfaces estimated; transient parser/VM/driver/process overhead not fully covered'};}
}
