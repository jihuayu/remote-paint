import {isHash} from '../protocol/wire.mjs';
import {CACHE_NEGOTIATION,makeCacheOffer,validateCacheNegotiation} from '../protocol/resource-cache.mjs';

const MiB=1024*1024,integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
const realmOf=p=>JSON.stringify(['private-v1',p.namespace,p.renderer.canvaskit,p.renderer.wasmSha256]);
const offerSenders=new WeakMap();
function validPermission(p){
 return p&&Object.isFrozen(p)&&p.schema==='viewer-resource-cache-v1'&&/^vrc1_[a-f0-9]{64}$/.test(p.namespace)&&p.renderer&&Object.isFrozen(p.renderer)&&typeof p.renderer.canvaskit==='string'&&p.renderer.canvaskit.length>0&&p.renderer.canvaskit.length<=64&&isHash(p.renderer.wasmSha256)&&Number.isFinite(Date.parse(p.expiresAt));
}

export async function negotiateResourceCache(cache,message,socket,{memory,current,permission}){
 if(message.cacheNegotiation===undefined)return;
 validateCacheNegotiation(message.cacheNegotiation);
 if(offerSenders.has(cache))return;
 const sender={};offerSenders.set(cache,sender);let record,timer;
 const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),150);
 const release=()=>{clearTimeout(timer);socket.removeEventListener('close',release);record?.release();record=null;if(offerSenders.get(cache)===sender)offerSenders.delete(cache);};
 try{
  record=await cache.offer({memory,signal:controller.signal});
  if(!current()||!cache.isAuthorized(permission())){release();return;}
  if(!record){const p=permission();record={permission:p,offer:makeCacheOffer(p),release:memory.reserve('persistentOffer',128*1024)};}
  if(record.permission!==permission()||!cache.isAuthorized(record.permission)||socket.readyState!==1){release();return;}
  socket.addEventListener('close',release,{once:true});socket.send(JSON.stringify(record.offer));
  // Retain one sender and its metadata through actual browser-buffer drain or
  // close; a later connection falls back rather than piling up send owners.
  const drained=()=>{if(socket.bufferedAmount===0||socket.readyState===3)release();else timer=setTimeout(drained,10);};drained();
 }catch{release();}
 finally{clearTimeout(deadline);controller.abort();}
}

export async function restoreManifestResources(cache,assets,manifest,{memory,current,permission}){
 const full=await cache.read('skp',manifest.id,{memory});
 if(full){if(current()&&full.permission===permission()&&cache.isAuthorized(full.permission))return full;full.release();return null;}
 let release;try{release=memory.reserve('persistentManifestMetadata',manifest.chunks.length*256);}catch{return null;}
 const deadline=performance.now()+200,seen=new Set();
 try{
  for(const part of manifest.chunks){
   if(!current()||performance.now()>=deadline)return null;
   if(seen.has(part.id)||assets.chunks.has(part.id))continue;seen.add(part.id);
   const cached=await cache.read('chunk',part.id,{memory});
   try{if(!current())return null;if(cached&&cached.permission===permission()&&cache.isAuthorized(cached.permission))assets.put(part.id,cached.payload);}finally{cached?.release();}
  }
  return null;
 }finally{release();}
}

// stage() has already checked the complete scene, dependency membership,
// epoch and resource-memory descriptors. Cache hits join that same barrier;
// missing/corrupt/slow entries retain the existing full-keyframe recovery.
export async function restoreFrameResources(cache,gate,{memory,current,permission}){
 const frame=gate.pending,deadline=performance.now()+200;if(!frame)return;
 for(const id of frame.requiredResources){
  if(!current()||gate.pending!==frame||performance.now()>=deadline)return;
  if(gate.resources.has(id))continue;
  const cached=await cache.read('skp',id,{memory});
  try{if(!current()||gate.pending!==frame)return;if(cached&&cached.permission===permission()&&cache.isAuthorized(cached.permission))gate.put(id,cached.payload);}finally{cached?.release();}
 }
}

const persistenceJobs=new WeakMap();
// Start persistence after presentation, when cold CanvasKit work no longer
// blocks the realm's IndexedDB callbacks. Keep one bounded metadata queue;
// acquire each body from its live owner just before charged cache admission.
export function persistFrameResources(cache,gate,assets,frame,{memory,current,permission}){
 if(persistenceJobs.has(cache)||!cache.stats.available||!cache.isAuthorized(permission()))return;
 let release;try{release=memory.reserve('persistentQueueMetadata',512*512);}catch{return;}
 const references=[];for(const id of frame.requiredResources)references.push(['skp',id]);
 for(const id of assets.chunks.keys()){if(references.length>=512)break;references.push(['chunk',id]);}
 const job={};persistenceJobs.set(cache,job);
 void(async()=>{
  try{
   await new Promise(resolve=>setTimeout(resolve,0));
   for(const [kind,id]of references){
    if(!current()||!cache.isAuthorized(permission()))return;
    const payload=(kind==='skp'?gate.resources:assets.chunks).get(id);if(payload)await cache.write(kind,id,payload,{memory});
   }
  }finally{release();if(persistenceJobs.get(cache)===job)persistenceJobs.delete(cache);}
 })().catch(()=>{});
}

// Private bodies never share the static HTTP cache. Only the exact live
// ViewerConnection permission can admit I/O; knowing a content hash is not a
// cache authority. Callers must additionally select reads from fresh Source
// manifests/requiredResources, before entering the existing frame barrier.
export class PersistentResources {
 #permission=null;#realm=null;#expiry;#deadline=0;#epoch=0;#db=null;#opening=null;#operation=null;#barrier=Promise.resolve(true);#purges=new Set();#closed=false;
 #getPermission;#indexedDB;#name;#bytes;#entries;#entryBytes;#timeout;#onStats;
 #stats={hits:0,misses:0,writes:0,evictions:0,corruptions:0,errors:0,timeouts:0,busyDrops:0,purges:0,purgeFailures:0,pendingBytes:0};
 constructor({getPermission,indexedDB=globalThis.indexedDB,name='remote-paint-private-resources-v1',maxBytes=64*MiB,maxEntries=512,maxEntryBytes=16*MiB,timeoutMs=1000,onStats}={}){
  if(typeof getPermission!=='function'||typeof name!=='string'||!/^[a-z0-9-]{1,80}$/.test(name)||!integer(maxBytes,64,64*MiB)||!integer(maxEntries,1,512)||!integer(maxEntryBytes,1,16*MiB)||!integer(timeoutMs,50,2000))throw new TypeError('Invalid persistent resource cache limits');
  if(onStats!==undefined&&typeof onStats!=='function')throw new TypeError('Invalid persistent resource observer');
  this.#getPermission=getPermission;this.#indexedDB=indexedDB;this.#name=name;this.#bytes=maxBytes;this.#entries=maxEntries;this.#entryBytes=Math.min(maxEntryBytes,maxBytes);this.#timeout=timeoutMs;this.#onStats=onStats;
 }
 get stats(){return Object.freeze({...this.#stats,busy:this.#operation!==null,openPending:this.#opening!==null,pendingPurges:this.#purges.size,offerSending:offerSenders.has(this),available:typeof this.#indexedDB?.open==='function'});}
 get purged(){return this.#barrier;}
 isAuthorized(permission){return this.#active(permission);}
 #publish(){try{this.#onStats?.(this.stats);}catch{}}
 #active(permission=this.#permission){
  try{return !this.#closed&&permission!==null&&permission===this.#permission&&permission===this.#getPermission()&&Date.now()<Date.parse(permission.expiresAt)&&performance.now()<this.#deadline;}catch{return false;}
 }
 state(event){
  if(event?.state==='authorized'){
   const p=event.permission;
   if(this.#closed||!validPermission(p)||p!==this.#getPermission()||Date.parse(p.expiresAt)<=Date.now())return this.revoke();
   const realm=realmOf(p);this.#epoch++;this.#permission=p;this.#realm=realm;this.#operation?.cancel();clearTimeout(this.#expiry);
   this.#deadline=performance.now()+Math.min(120000,Date.parse(p.expiresAt)-Date.now());
   this.#queuePurge(realm,true);
   this.#expiry=setTimeout(()=>{if(this.#permission===p||this.#realm===realm&&!this.#permission)void this.revoke();},Math.max(1,this.#deadline-performance.now()));this.#expiry.unref?.();
   return this.#barrier;
  }
  if(event?.state==='suspended'){this.#epoch++;this.#permission=null;this.#operation?.cancel();return this.#barrier;}
  if(event?.state==='revoked')return this.revoke();
  throw new TypeError('Invalid cache permission state');
 }
 revoke(){
  this.#epoch++;this.#permission=null;clearTimeout(this.#expiry);this.#operation?.cancel();const realm=this.#realm;this.#realm=null;
  if(realm)this.#queuePurge(realm);return this.#barrier;
 }
 purgePrivate(){this.revoke();this.#queuePurge('',true);return this.#barrier;}
 async close(){if(this.#closed)return this.#barrier;const purged=this.revoke();this.#closed=true;await purged;this.#db?.close();this.#db=null;return purged;}
 #open(){
  if(!this.#indexedDB)return Promise.reject(new Error('IndexedDB unavailable'));
  if(this.#db)return Promise.resolve(this.#db);if(this.#opening)return this.#opening;
  let request;try{request=this.#indexedDB.open(this.#name,1);}catch{return Promise.reject(new Error('IndexedDB open failed'));}
  const opening=new Promise((resolve,reject)=>{
   let ended=false;const timer=setTimeout(()=>{ended=true;reject(new Error('IndexedDB open timeout'));},this.#timeout);
   // IDBOpenDBRequest has no cancellation API. Observer timeout must retain
   // the one original request until success/error, including blocked upgrades.
   const settled=()=>{clearTimeout(timer);if(this.#opening===opening)this.#opening=null;};
   request.onupgradeneeded=()=>{if(ended){request.transaction.abort();return;}const db=request.result;db.createObjectStore('meta',{keyPath:'key'});db.createObjectStore('bodies');};
   request.onerror=()=>{settled();if(!ended){ended=true;reject(new Error('IndexedDB open failed'));}this.#publish();};
   request.onsuccess=()=>{settled();const db=request.result;if(ended||this.#closed&&!this.#purges.size){db.close();if(!ended){ended=true;reject(new Error('Cache closed'));}this.#publish();return;}ended=true;db.onversionchange=()=>{db.close();if(this.#db===db)this.#db=null;};this.#db=db;resolve(db);this.#publish();};
  });
  this.#opening=opening;return opening;
 }
 #transaction(db,mode,run,context){
  return new Promise((resolve,reject)=>{
   const tx=db.transaction(['meta','bodies'],mode);let value,failure;const timer=setTimeout(()=>{try{tx.abort();}catch{}},this.#timeout);
   if(context){context.transaction=tx;if(context.canceled){try{tx.abort();}catch{}}}
   tx.oncomplete=()=>{clearTimeout(timer);if(context)context.transaction=null;if(failure)reject(failure);else resolve(value);};
   tx.onabort=()=>{clearTimeout(timer);if(context)context.transaction=null;reject(failure??new Error('IndexedDB transaction failed'));};
   tx.onerror=()=>{failure??=new Error('IndexedDB transaction failed');try{tx.abort();}catch{}};
   try{run(tx,result=>{value=result;});}catch(error){failure=error;try{tx.abort();}catch{}}
  });
 }
 #queuePurge(realm,keep=false){
  // Repeated suspend/revoke cannot build an unbounded queue. A physical purge
  // failure remains observable and denies the next authorization's I/O.
  const purgeKey=(keep?'keep:':'drop:')+realm;if(this.#purges.has(purgeKey))return;
  if(this.#purges.size>=8){this.#stats.purgeFailures++;this.#barrier=Promise.resolve(false);return;}
  this.#purges.add(purgeKey);const before=this.#barrier;
  const context={transaction:null,canceled:false,cancel(){this.canceled=true;try{this.transaction?.abort();}catch{}}};
  let expired=false,timer;
  const work=(async()=>{
   try{
    await before;if(context.canceled)return false;const db=await this.#open();if(context.canceled)return false;await this.#transaction(db,'readwrite',tx=>{
     const meta=tx.objectStore('meta'),bodies=tx.objectStore('bodies'),request=meta.openCursor();
     request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(keep?cursor.value.realm!==realm:cursor.value.realm===realm){bodies.delete(cursor.key);cursor.delete();}cursor.continue();};
    },context);if(context.canceled)return false;this.#stats.purges++;return true;
   }catch{if(!expired)this.#stats.purgeFailures++;return false;}
   finally{clearTimeout(timer);this.#purges.delete(purgeKey);this.#publish();}
  })();
  // Bound the wait for open+transaction without retiring the actual purge.
  // A missing terminal event keeps its admission; subsequent cache I/O stays
  // denied, while full Source frames may continue without cache assistance.
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{expired=true;context.cancel();this.#stats.purgeFailures++;this.#publish();resolve(false);},this.#timeout*2);});
  this.#barrier=Promise.race([work,deadline]);
 }
 #validMeta(row,key,realm,kind,id){return row&&row.key===key&&row.realm===realm&&row.kind===kind&&row.id===id&&integer(row.bytes,1,this.#entryBytes)&&Number.isFinite(row.writtenAt);}
 #admit(kind,id,memory,run,prepare,{metadataOnly=false,signal}={}){
  if((metadataOnly?kind!==null||id!==null:!['chunk','skp'].includes(kind)||!isHash(id))||!memory||typeof memory.reserve!=='function'||typeof memory.buffer!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Invalid persistent resource operation');
  const permission=this.#permission,realm=this.#realm,epoch=this.#epoch;
  if(!this.#active(permission)||signal?.aborted)return Promise.resolve(null);
  if(this.#operation){this.#stats.busyDrops++;return Promise.resolve(null);}
  let abort;const context={canceled:false,transaction:null,valid:()=>!context.canceled&&epoch===this.#epoch&&this.#active(permission),cancel(){context.canceled=true;try{context.transaction?.abort();}catch{}abort?.();}};
  const releases=[];context.charge=release=>{releases.push(release);return release;};
  this.#operation=context;
  try{prepare?.(context);}catch{for(const release of releases)release();this.#stats.pendingBytes=0;this.#operation=null;this.#stats.errors++;this.#publish();return Promise.resolve(null);}
  const full=(async()=>{
   try{if(!await this.#barrier||!context.valid())return null;const db=await this.#open();if(!context.valid())return null;return await run({db,key:kind===null?null:realm+'/'+kind+'/'+id,realm,kind,id,memory,context});}
   catch{this.#stats.errors++;return null;}
   finally{for(const release of releases)release();this.#stats.pendingBytes=0;if(this.#operation===context)this.#operation=null;this.#publish();}
  })();
  // A timed-out non-cooperative Blob/digest keeps its one admission and charges
  // until it really settles. Late completion cannot publish or commit bytes.
  let timer;const canceled=new Promise(resolve=>{abort=()=>resolve(null);timer=setTimeout(()=>{this.#stats.timeouts++;context.cancel();},this.#timeout);});
  const cancel=()=>context.cancel();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted||context.canceled)context.cancel();
  return Promise.race([full,canceled]).then(value=>{
   if(value!==null&&context.valid()){context.resultRelease=null;return value;}
   context.resultRelease?.();context.resultRelease=null;return null;
  }).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);});
 }
 offer({memory,signal}={}){
  return this.#admit(null,null,memory,async({db,realm,context})=>{
   context.charge(memory.reserve('persistentOfferIndex',this.#entries*4096));
   const rows=[];let count=0;
   await this.#transaction(db,'readonly',tx=>{
    const request=tx.objectStore('meta').openCursor();request.onsuccess=()=>{
     if(!context.valid()){tx.abort();return;}const cursor=request.result;if(!cursor)return;
     if(++count>this.#entries){tx.abort();return;}const row=cursor.value;
     if(['skp','chunk'].includes(row.kind)&&isHash(row.id)&&this.#validMeta(row,realm+'/'+row.kind+'/'+row.id,realm,row.kind,row.id))rows.push({kind:row.kind,id:row.id,bytes:row.bytes,writtenAt:row.writtenAt});cursor.continue();
    };
   },context);
   if(!context.valid())return null;
   // A previously chunked Source benefits from block reuse; raw peers have
   // only SKPs. Selection is metadata-only and never reads private bodies.
   rows.sort((a,b)=>(a.kind==='chunk'?0:1)-(b.kind==='chunk'?0:1)||b.writtenAt-a.writtenAt||b.bytes-a.bytes||a.id.localeCompare(b.id));
   const permission=this.#permission,offer=makeCacheOffer(permission,rows.slice(0,CACHE_NEGOTIATION.maxEntries)),release=memory.reserve('persistentOffer',128*1024);context.resultRelease=release;
   return Object.freeze({offer,permission,release});
  },undefined,{metadataOnly:true,signal});
 }
 async write(kind,id,payload,{memory}={}){
  if(!(payload instanceof Uint8Array)||!payload.byteLength||payload.byteLength>this.#entryBytes)return false;
  return !!await this.#admit(kind,id,memory,async({db,key,realm,context})=>{
   context.charge(memory.reserve('persistentBlob',payload.byteLength,'browser'));context.charge(memory.reserve('persistentIndex',this.#entries*4096));
   const allocation=memory.reserve('persistentWriteCopy',payload.byteLength);context.charge(allocation);const stable=new Uint8Array(payload);
   allocation();context.charge(memory.buffer('persistentWriteCopy',stable));
   const release=memory.reserve('shaWork',stable.byteLength,'browser');let hash;try{hash=await digest(stable);}finally{release();}if(!context.valid()||hash!==id)return null;
   const body=new Blob([stable]);
   const evicted=await this.#transaction(db,'readwrite',(tx,done)=>{
    const meta=tx.objectStore('meta'),bodies=tx.objectStore('bodies'),rows=[],request=meta.openCursor();let bytes=0,count=0;
    request.onsuccess=()=>{
     if(!context.valid()){tx.abort();return;}const cursor=request.result;
     if(cursor){
      const row=cursor.value;
      if(++count>this.#entries){meta.clear();bodies.clear();rows.length=0;bytes=0;finish();return;}
      if(typeof row.key!=='string'||row.key.length>1024||!integer(row.bytes,1,16*MiB)||!Number.isFinite(row.writtenAt)){bodies.delete(cursor.key);cursor.delete();}
      else if(row.key!==key){rows.push(row);bytes+=row.bytes;}
      cursor.continue();return;
     }finish();
    };
    const finish=()=>{
     rows.sort((a,b)=>a.writtenAt-b.writtenAt||a.key.localeCompare(b.key));let removed=0;
     while(rows.length>=this.#entries||bytes+payload.byteLength>this.#bytes){const row=rows.shift();if(!row){tx.abort();return;}bytes-=row.bytes;meta.delete(row.key);bodies.delete(row.key);removed++;}
     if(!context.valid()){tx.abort();return;}
     meta.put({key,realm,kind,id,bytes:payload.byteLength,writtenAt:Date.now()});bodies.put(body,key);done(removed);
    };
   },context);
   if(!context.valid())return null;this.#stats.evictions+=evicted;this.#stats.writes++;return true;
  },context=>{this.#stats.pendingBytes=payload.byteLength;context.charge(memory.buffer('persistentWriteInput',payload));});
 }
 read(kind,id,{memory}={}){
  return this.#admit(kind,id,memory,async({db,key,realm,context})=>{
   let row,body;
   await this.#transaction(db,'readonly',tx=>{
    const meta=tx.objectStore('meta').get(key);meta.onsuccess=()=>{row=meta.result;if(this.#validMeta(row,key,realm,kind,id)){const request=tx.objectStore('bodies').get(key);request.onsuccess=()=>{body=request.result;};}};
   },context);
   if(!context.valid())return null;
   if(!row){this.#stats.misses++;return null;}
   if(!this.#validMeta(row,key,realm,kind,id)||!(body instanceof Blob)||body.size!==row.bytes){await this.#corrupt(db,key,context);return null;}
   this.#stats.pendingBytes=row.bytes;const temporary=memory.reserve('persistentRead',row.bytes);context.charge(temporary);
   const bytes=new Uint8Array(await body.arrayBuffer());if(!context.valid())return null;
   const releaseSha=memory.reserve('shaWork',bytes.byteLength,'browser');let hash;try{hash=await digest(bytes);}finally{releaseSha();}
   if(!context.valid())return null;if(hash!==id){await this.#corrupt(db,key,context);return null;}
   temporary();const release=memory.buffer('persistentRead',bytes);context.resultRelease=release;this.#stats.hits++;
   return Object.freeze({payload:bytes,release,permission:this.#permission});
  });
 }
 async #corrupt(db,key,context){
  this.#stats.corruptions++;this.#stats.misses++;
  if(context.valid())await this.#transaction(db,'readwrite',tx=>{tx.objectStore('meta').delete(key);tx.objectStore('bodies').delete(key);},context);
 }
}
