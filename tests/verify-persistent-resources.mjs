import {cacheBrowserOptions} from './fixtures/cache-browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {fixture,KEY,OTHER,flush,renderer} from './fixtures/viewer-access-harness.mjs';
import {payload as skpPayload} from './live-helpers.mjs';

// Explicit real-browser component verification. The Source remains the named
// Node fixture; this neither starts a Native browser nor qualifies frame speed.
const output=resolve(process.argv[2]??'outputs/persistent-resources-proof');await mkdir(output,{recursive:true});
const cleanups=[];let context,server,result;
try{
 const h=await fixture({after:fn=>cleanups.push(fn)},{ttlSeconds:120});
 const second=h.registry.create('b',{ttlSeconds:120},{idempotencyKey:'cache-other-account'});await flush();h.registry.requireReady('b',second.sessionId);
 const routes=new Set(['/viewer/persistent-resources.mjs','/protocol/wire.mjs','/protocol/asset-wire.mjs','/protocol/resource-cache.mjs','/protocol/client-memory.mjs','/sdk/viewer-connection.mjs']);
 server=createServer(async(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Owned private cache verification</title>');return;}
  if(req.url==='/fixture.skp'){res.writeHead(200,{'content-type':'application/octet-stream'});res.end(skpPayload);return;}
  if(!routes.has(req.url)){res.writeHead(404);res.end();return;}
  try{const bytes=await readFile(new URL('..'+req.url,import.meta.url));res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(bytes);}catch{res.writeHead(500);res.end();}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 context=await chromium.launchPersistentContext(output+'/owned-chrome-profile',cacheBrowserOptions());
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.exposeFunction('fixtureTicket',async(which,role,ttl)=>{
  assert.ok(['a','b'].includes(which));assert.ok(['readonly','controller'].includes(role));assert.ok([1,30].includes(ttl));
  const sessionId=which==='a'?h.sessionId:second.sessionId;
  const response=await h.api('/v1/sessions/'+sessionId+'/viewer-tickets',{method:'POST',key:which==='a'?KEY:OTHER,body:{role,audience:origin,ttlSeconds:ttl}});assert.equal(response.status,200);
  return response.data;
 });
 await page.exposeFunction('fixtureRevoke',async(which,grantId)=>{
  assert.ok(['a','b'].includes(which));assert.match(grantId,/^vgr_[a-f0-9-]{36}$/);
  const sessionId=which==='a'?h.sessionId:second.sessionId;
  assert.equal((await h.api('/v1/sessions/'+sessionId+'/viewer-tickets/'+grantId,{method:'DELETE',key:which==='a'?KEY:OTHER})).status,200);
 });
 await page.goto(origin);
 result=await page.evaluate(async({base,ids,renderer})=>{
  const {PersistentResources,restoreManifestResources}=await import('/viewer/persistent-resources.mjs'),{AssetCache}=await import('/protocol/asset-wire.mjs'),{ViewerConnection}=await import('/sdk/viewer-connection.mjs'),{ClientMemory,memoryPolicy}=await import('/protocol/client-memory.mjs');
  const checks=[],check=(value,name)=>{if(!value)throw new Error(name);checks.push(name);};
  const until=async fn=>{const end=performance.now()+2500;while(!fn()){if(performance.now()>end)throw new Error('Owned cache condition timeout');await new Promise(r=>setTimeout(r,5));}};
  const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
  const memory=new ClientMemory(memoryPolicy({profile:'compact'}));let connection,held,hold=false;const states=[],socketCloses=[];
  let cache=new PersistentResources({getPermission:()=>connection?.resourceCachePermission??null,maxBytes:256,maxEntries:3,maxEntryBytes:256,timeoutMs:300});const retired=[];
  const snapshot=async()=>{const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('remote-paint-private-resources-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Snapshot open failed'));});try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','bodies'],'readonly'),a=tx.objectStore('meta').getAll(),b=tx.objectStore('bodies').count();tx.oncomplete=()=>resolve({rows:a.result,bodies:b.result});tx.onabort=()=>reject(new Error('Snapshot failed'));});}finally{db.close();}};
  const change=async fn=>{const request=indexedDB.open('remote-paint-private-resources-v1',1);await new Promise(r=>request.onsuccess=r);const db=request.result;try{await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','bodies'],'readwrite');fn(tx);tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('Mutation failed'));});}finally{db.close();}};
  const connect=async(which='a',role='readonly',ttl=30)=>{
   connection?.destroy();held=null;
   connection=new ViewerConnection({gatewayOrigin:base,audience:location.origin,sessionId:ids[which],role,getTicket:()=>window.fixtureTicket(which,role,ttl),onState:state=>states.push({state:state.state,code:state.code}),onCacheState:event=>{void cache.state(event);},onSocket:(ws,grant,auth)=>{
    ws.addEventListener('close',event=>socketCloses.push({code:event.code}));
    ws.onopen=()=>ws.send(JSON.stringify({type:'Hello',protocol:4,renderer,viewerBuild:'fixture',capabilities:['asset-chunks-v1','frame-window-v1'],frameWindow:6}));
    ws.onmessage=event=>{if(typeof event.data!=='string')return;const message=JSON.parse(event.data);if(message.type==='Welcome'){if(hold)held={message,auth};else auth.acceptWelcome(message);}else if(message.type==='FrameCommit')ws.send(JSON.stringify({type:'FrameAck',pageEpoch:message.pageEpoch,frameId:message.frameId,stage:'scene-submitted'}));};
   }});await connection.start();try{await until(()=>hold?held:connection.resourceCachePermission);}catch{throw new Error('Actual cache handshake failed: '+JSON.stringify({states,socketCloses}));}if(!hold)await cache.purged;
  };
  const bytes=new Uint8Array(128).fill(1),id=await hash(bytes);
  check(await cache.read('skp',id,{memory})===null&&!await cache.write('skp',id,bytes,{memory}),'no cache I/O before an actual grant/Welcome');
  check(!(await indexedDB.databases()).some(db=>db.name==='remote-paint-private-resources-v1'),'unauthorized calls did not even open private IndexedDB');
  hold=true;await connect();check(connection.resourceCachePermission===null&&await cache.read('skp',id,{memory})===null,'issued ticket alone cannot read persisted bytes');held.auth.acceptWelcome(held.message);hold=false;await cache.purged;
  check(await cache.write('skp',id,bytes,{memory}),'verified immutable resource physically committed');
  let found=await cache.read('skp',id,{memory});check(found?.payload.every(n=>n===1)&&found.permission===connection.resourceCachePermission,'same live authority reads SHA-verified IndexedDB body');found.release();
  check(!await cache.write('skp','0'.repeat(64),bytes,{memory})&&!await cache.write('skp',id,new Uint8Array(257),{memory}),'bad content hash and oversized resource rejected');
  const first=connection.resourceCachePermission;connection.stop();check(await cache.read('skp',id,{memory})===null,'pause immediately removes cache read authority');await connection.start();await until(()=>connection.resourceCachePermission);await cache.purged;
  check(first.grantId!==connection.resourceCachePermission.grantId&&first.namespace===connection.resourceCachePermission.namespace,'fresh real grant reconnect retains the same authorized cache realm');found=await cache.read('skp',id,{memory});check(!!found,'reconnect reuses an actual persisted resource');found.release();
  const previous=cache;previous.state({state:'suspended'});retired.push(previous);cache=new PersistentResources({getPermission:()=>connection?.resourceCachePermission??null,maxBytes:256,maxEntries:3,maxEntryBytes:256,timeoutMs:300});await cache.state({state:'authorized',permission:connection.resourceCachePermission});
  found=await cache.read('skp',id,{memory});check(!!found,'a new cache owner reopens the IndexedDB body without a JS body map');found.release();
  const offered=await cache.offer({memory});check(offered?.offer.resources.some(row=>row.kind==='skp'&&row.id===id)&&offered.permission===connection.resourceCachePermission,'fresh authority enumerates bounded metadata for a scoped offer');offered.release();
  const abortOffer=new AbortController();let cancelOffer=false,cancelRead=false;
  const cancelCache=new PersistentResources({name:'remote-paint-offer-cancel-v1',getPermission:()=>connection.resourceCachePermission,onStats:stats=>{if(!stats.busy&&cancelOffer)abortOffer.abort();if(!stats.busy&&cancelRead)void cancelCache.state({state:'suspended'});}});
  await cancelCache.state({state:'authorized',permission:connection.resourceCachePermission});await cancelCache.write('skp',id,bytes,{memory});cancelOffer=true;const canceledOffer=await cancelCache.offer({memory,signal:abortOffer.signal});cancelOffer=false;
  check(canceledOffer===null&&memory.totals().owners===0,'reentrant offer cancellation releases metadata never delivered to its caller');
  cancelRead=true;const canceledRead=await cancelCache.read('skp',id,{memory});cancelRead=false;check(canceledRead===null&&memory.totals().owners===0,'reentrant read suspension releases a verified body never delivered to its caller');await cancelCache.close();
  const chunkCache=new PersistentResources({name:'remote-paint-manifest-chunks-v1',getPermission:()=>connection.resourceCachePermission}),assetCache=new AssetCache({memory}),skp=new Uint8Array(await(await fetch('/fixture.skp')).arrayBuffer()),chunks=[];
  await chunkCache.state({state:'authorized',permission:connection.resourceCachePermission});
  for(let offset=0;offset<skp.length;offset+=16384){const part=skp.slice(offset,offset+16384),partId=await hash(part);await chunkCache.write('chunk',partId,part,{memory});chunks.push({kind:'skp',id:partId});}
  const manifest={id:await hash(skp),bytes:skp.length,chunks};check(assetCache.assemble(manifest)===null,'fresh manifest initially lacks its actual content blocks');
  const fullCached=await restoreManifestResources(chunkCache,assetCache,manifest,{memory,current:()=>true,permission:()=>connection.resourceCachePermission}),assembled=assetCache.assemble(manifest);
  check(fullCached===null&&assembled&&await hash(assembled)===manifest.id,'missing full SKP is reassembled from SHA-verified persisted chunks');assetCache.releaseAssembly(assembled);assetCache.dispose();await chunkCache.close();
  const idsByValue=new Map([[1,id]]);
  for(const n of [2,3]){const payload=new Uint8Array(128).fill(n),key=await hash(payload);idsByValue.set(n,key);check(await cache.write('skp',key,payload,{memory}),'quota fixture resource '+n+' committed');}
  let stored=await snapshot();check(stored.rows.length===2&&stored.bodies===2&&stored.rows.reduce((n,row)=>n+row.bytes,0)<=256&&cache.stats.evictions===1,'atomic global byte quota evicts the oldest entry and its body');
  check(await cache.read('skp',id,{memory})===null,'evicted resource returns a recoverable miss');
  await change(tx=>{const request=tx.objectStore('meta').getAll();request.onsuccess=()=>{const row=request.result.find(row=>row.id===idsByValue.get(2));tx.objectStore('bodies').put(new Blob([new Uint8Array(128).fill(9)]),row.key);};});
  check(await cache.read('skp',idsByValue.get(2),{memory})===null&&cache.stats.corruptions===1,'same-size persisted corruption fails SHA and deletes the entry');
  await change(tx=>{const request=tx.objectStore('meta').getAll();request.onsuccess=()=>{const row=request.result[0];row.bytes=1;tx.objectStore('meta').put(row);};});
  check(await cache.read('skp',idsByValue.get(3),{memory})===null&&cache.stats.corruptions===2,'corrupt size metadata is rejected before allocating the body buffer');
  check((await snapshot()).bodies===0,'both corruption paths physically removed their bodies');
  check(await cache.write('chunk',id,bytes,{memory}),'immutable chunk uses a separate typed cache entry');
  // Do not call destroy here: changing to another tenant must itself remove
  // stale storage, including after losing the previous cache-owner object.
  connection.stop();retired.push(cache);cache=new PersistentResources({getPermission:()=>connection?.resourceCachePermission??null,maxBytes:256,maxEntries:3,maxEntryBytes:256,timeoutMs:300});
  check((await snapshot()).bodies===1,'private body remains physically persisted after losing the suspended cache owner');
  await connect('b');check(await cache.read('chunk',id,{memory})===null&&(await snapshot()).bodies===0,'actual other-tenant Welcome cannot read the same hash and purges the old realm');
  check(await cache.write('chunk',id,bytes,{memory}),'other-tenant private body committed under its own authority');
  const grant=connection.resourceCachePermission;await window.fixtureRevoke('b',grant.grantId);await until(()=>connection.state.state==='failed');check(await cache.purged&&(await snapshot()).bodies===0&&await cache.read('chunk',id,{memory})===null,'actual HTTP grant revocation awaits physical private-body purge');
  await connect('a','readonly',1);check(await cache.write('skp',id,bytes,{memory}),'short-lived actual grant body committed');const purgesBeforeExpiry=cache.stats.purges;connection.stop();await until(()=>cache.stats.purges>purgesBeforeExpiry);await cache.purged;
  check((await snapshot()).bodies===0,'paused permission expiry physically purges the persisted realm');
  // A real queued IndexedDB write must not outlive actual server revocation.
  await connect();const open=indexedDB.open('remote-paint-private-resources-v1',1);await new Promise(r=>open.onsuccess=r);const blockerDb=open.result,tx=blockerDb.transaction(['meta','bodies'],'readwrite');let spin=true;
  const pump=()=>{const request=tx.objectStore('meta').get('keepalive');request.onsuccess=()=>{if(spin)pump();};};pump();
  const original=IDBDatabase.prototype.transaction;let queuedWrites=0;IDBDatabase.prototype.transaction=function(...args){const value=original.apply(this,args);if(this.name==='remote-paint-private-resources-v1'&&args[1]==='readwrite')queuedWrites++;return value;};
  const writing=cache.write('skp',id,bytes,{memory});await until(()=>queuedWrites>0);await window.fixtureRevoke('a',connection.resourceCachePermission.grantId);await until(()=>connection.state.state==='failed');spin=false;await new Promise(r=>tx.oncomplete=r);blockerDb.close();IDBDatabase.prototype.transaction=original;
  check(!await writing&&await cache.purged&&(await snapshot()).bodies===0,'revocation fences an actual queued write; late completion cannot restore private bytes');
  check(memory.totals().owners===0&&cache.stats.pendingBytes===0,'all write/read/digest metadata and buffer reservations are released');
  connection.destroy();check(await cache.purgePrivate(),'explicit full private-cache purge committed');for(const old of retired)await old.close();await cache.close();
  return {checks,cacheStats:cache.stats,actualIndexedDb:true,actualPublicHttpSqliteAndWebSocketAuthority:true,source:'virtual Node Source fixture',nativeBrowserStarted:false,originalBrowserOrSamplerExecuted:false,productionViewerIntegrationQualified:false,reconnectFirstFrameOrBandwidthQualified:false};
 },{base:h.base,ids:{a:h.sessionId,b:second.sessionId},renderer});
 assert.deepEqual(errors,[]);result.browserVersion=context.browser()?.version()??'persistent-context';result.status='passed';await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,checks:result.checks.length,actualIndexedDb:true,productionViewerIntegrationQualified:false}));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',name:error.name,message:error.message,stack:error.stack},null,2)+'\n');throw error;}
finally{await context?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}for(const cleanup of cleanups.reverse())await cleanup();}
