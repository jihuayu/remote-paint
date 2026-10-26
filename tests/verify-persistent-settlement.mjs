import {cacheBrowserOptions} from './fixtures/cache-browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {fixture,KEY,renderer} from './fixtures/viewer-access-harness.mjs';

// Actual IndexedDB request/transaction events, not a mocked persistence API.
// Public grant authority uses the existing explicit virtual Node Source.
const output=resolve(process.argv[2]??'outputs/persistent-settlement-proof');await mkdir(output,{recursive:true});
const cleanups=[];let context,server;
try{
 const h=await fixture({after:fn=>cleanups.push(fn)},{ttlSeconds:120});
 const routes=new Set(['/viewer/persistent-resources.mjs','/protocol/wire.mjs','/protocol/resource-cache.mjs','/protocol/client-memory.mjs','/sdk/viewer-connection.mjs']);
 server=createServer(async(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Owned IndexedDB settlement verification</title>');return;}
  if(!routes.has(req.url)){res.writeHead(404);res.end();return;}
  try{const bytes=await readFile(new URL('..'+req.url,import.meta.url));res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(bytes);}catch{res.writeHead(500);res.end();}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
 context=await chromium.launchPersistentContext(output+'/owned-chrome-profile',cacheBrowserOptions());
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.exposeFunction('fixtureTicket',async()=>{const reply=await h.api(h.tickets,{method:'POST',key:KEY,body:{role:'readonly',audience:origin,ttlSeconds:30}});assert.equal(reply.status,200);return reply.data;});
 await page.goto(origin);
 const result=await page.evaluate(async({base,sessionId,renderer})=>{
  const {PersistentResources}=await import('/viewer/persistent-resources.mjs'),{ViewerConnection}=await import('/sdk/viewer-connection.mjs'),{ClientMemory,memoryPolicy}=await import('/protocol/client-memory.mjs');
  const until=async fn=>{const end=performance.now()+2500;while(!fn()){if(performance.now()>end)throw new Error('Actual IndexedDB settlement condition timeout');await new Promise(r=>setTimeout(r,5));}};
  const connection=new ViewerConnection({gatewayOrigin:base,audience:location.origin,sessionId,role:'readonly',getTicket:()=>window.fixtureTicket(),onSocket:(ws,grant,auth)=>{
   ws.onopen=()=>ws.send(JSON.stringify({type:'Hello',protocol:4,renderer,viewerBuild:'fixture',capabilities:['frame-window-v1'],frameWindow:6}));
   ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.type==='Welcome')auth.acceptWelcome(m);else if(m.type==='FrameCommit')ws.send(JSON.stringify({type:'FrameAck',pageEpoch:m.pageEpoch,frameId:m.frameId,stage:'scene-submitted'}));};
  }});await connection.start();await until(()=>connection.resourceCachePermission);
  const permission=connection.resourceCachePermission,memory=new ClientMemory(memoryPolicy({profile:'compact'})),payload=new Uint8Array(64).fill(7),id=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',payload)),n=>n.toString(16).padStart(2,'0')).join('');
  const remove=name=>new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(name);request.onsuccess=resolve;request.onerror=()=>reject(new Error('Owned database deletion failed'));});
  const blockedName='remote-paint-settlement-blocked-v1',initial=indexedDB.open(blockedName,1);initial.onupgradeneeded=()=>{initial.result.createObjectStore('meta',{keyPath:'key'});initial.result.createObjectStore('bodies');};await new Promise(r=>initial.onsuccess=r);const blocker=initial.result;blocker.onversionchange=()=>{};
  const upgrade=indexedDB.open(blockedName,2),upgraded=new Promise((resolve,reject)=>{upgrade.onsuccess=()=>{upgrade.result.close();resolve();};upgrade.onerror=()=>reject(new Error('Owned upgrade failed'));});await new Promise(r=>upgrade.onblocked=r);
  let opens=0,terminals=0;
  const blockedCache=new PersistentResources({getPermission:()=>connection.resourceCachePermission,indexedDB:{open(...args){opens++;const request=indexedDB.open(...args);request.addEventListener('success',()=>terminals++);request.addEventListener('error',()=>terminals++);return request;}},name:blockedName,timeoutMs:50});
  const attempts=[];for(let n=0;n<3;n++)attempts.push(await blockedCache.state({state:'authorized',permission}));
  const openReceipt={observersFailedWithoutOpeningBodies:attempts.every(v=>v===false),openRequestsBeforeActualSettlement:opens,terminalEventsBeforeRelease:terminals,originalRequestAdmissionRetained:opens===1&&terminals===0};
  blocker.close();await upgraded;await until(()=>terminals===opens);openReceipt.originalRequestsEventuallySettled=true;await blockedCache.close();await remove(blockedName);
  const name='remote-paint-settlement-transaction-v1';let armed=false,aborted=false,errorSeen=false,releasedBeforeAbort=false;const events=[];
  const cache=new PersistentResources({getPermission:()=>connection.resourceCachePermission,name,maxBytes:256,maxEntries:3,maxEntryBytes:256,timeoutMs:300,onStats:stats=>{
   if(armed&&!stats.busy){events.push({event:'owner-release',aborted,owners:memory.totals().owners});if(!aborted)releasedBeforeAbort=true;}
  }});await cache.state({state:'authorized',permission});if(!await cache.write('skp',id,payload,{memory}))throw new Error('Actual transaction fixture did not commit its initial body');
  const transaction=IDBDatabase.prototype.transaction,put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;
  IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(armed&&this.name===name){tx.addEventListener('error',()=>{errorSeen=true;events.push({event:'request-error',owners:memory.totals().owners});});tx.addEventListener('abort',()=>{aborted=true;events.push({event:'actual-abort',owners:memory.totals().owners});});}return tx;};
  IDBObjectStore.prototype.put=function(value,key){if(armed&&this.name==='bodies'&&this.transaction.db.name===name)return add.call(this,value,key);return put.apply(this,arguments);};
  let written,returnedBeforeAbort;
  try{armed=true;written=await cache.write('skp',id,payload,{memory});returnedBeforeAbort=!aborted;await until(()=>aborted);}finally{armed=false;IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.put=put;}
  const txReceipt={actualConstraintErrorObserved:errorSeen,writeRejected:written===false,returnedBeforeActualAbort:returnedBeforeAbort,releasedBeforeActualAbort:releasedBeforeAbort,events,waitedForActualAbort:!returnedBeforeAbort&&!releasedBeforeAbort&&aborted};
  const restored=await cache.read('skp',id,{memory});txReceipt.originalBodyPreservedByRollback=!!restored&&restored.payload.every(n=>n===7);restored?.release();txReceipt.allChargesReleasedAfterSettlement=memory.totals().owners===0;txReceipt.physicalPurgePassed=await cache.close();await remove(name);
  // Preserve real transaction/error/abort events, but gate delivery of the
  // terminal callback to its owner. This explicitly tests delayed observation,
  // not a claim that the browser engine's completed transaction is still live.
  const delayedName='remote-paint-settlement-delayed-v1',cursor=IDBObjectStore.prototype.openCursor,abortDescriptor=Object.getOwnPropertyDescriptor(IDBTransaction.prototype,'onabort');let deliverAbort,abortCaptured=false,purgeTransactions=0;
  IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);if(this.name===delayedName){purgeTransactions++;Object.defineProperty(tx,'onabort',{configurable:true,set(fn){abortDescriptor.set.call(this,event=>{abortCaptured=true;deliverAbort=()=>fn.call(tx,event);});}});}return tx;};
  IDBObjectStore.prototype.openCursor=function(...args){if(this.name==='meta'&&this.transaction.db.name===delayedName){this.add({key:'duplicate'});this.add({key:'duplicate'});}return cursor.apply(this,args);};
  const delayed=new PersistentResources({getPermission:()=>connection.resourceCachePermission,name:delayedName,timeoutMs:50});let delayedReceipt;
  try{
   const start=performance.now(),observed=await delayed.state({state:'authorized',permission});await until(()=>abortCaptured);
   const before=purgeTransactions,repeat=await delayed.state({state:'authorized',permission}),read=await delayed.read('skp',id,{memory});
   delayedReceipt={observerReturnedFailure:observed===false,observerMs:performance.now()-start,actualAbortCaptured:true,terminalCallbackDeliveryHeld:true,purgeAdmissionRetained:delayed.stats.pendingPurges===1,duplicatePurgeNotAdmitted:before===1&&purgeTransactions===before,cacheReadDeniedWhileCleanupUnconfirmed:read===null&&repeat===false};
  }finally{IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.openCursor=cursor;deliverAbort?.();}
  await until(()=>delayed.stats.pendingPurges===0);delayedReceipt.lateTerminalCallbackReleasedAdmission=true;delayedReceipt.freshConfirmedPurgeRecovered=await delayed.state({state:'authorized',permission});delayedReceipt.physicalFinalPurgePassed=await delayed.close();await remove(delayedName);connection.destroy();
  const passed=openReceipt.originalRequestAdmissionRetained&&txReceipt.waitedForActualAbort&&txReceipt.originalBodyPreservedByRollback&&txReceipt.allChargesReleasedAfterSettlement&&txReceipt.physicalPurgePassed&&delayedReceipt.observerReturnedFailure&&delayedReceipt.purgeAdmissionRetained&&delayedReceipt.duplicatePurgeNotAdmitted&&delayedReceipt.cacheReadDeniedWhileCleanupUnconfirmed&&delayedReceipt.freshConfirmedPurgeRecovered&&delayedReceipt.physicalFinalPurgePassed;
  return {status:passed?'passed':'failed',open:openReceipt,transaction:txReceipt,delayedTerminalObservation:delayedReceipt,actualIndexedDb:true,actualPublicHttpSqliteWebSocketAuthority:true,virtualNodeSource:true,nativeOrOriginalBrowserOrSamplerStarted:false,wholeGoalQualified:false};
 },{base:h.base,sessionId:h.sessionId,renderer});
 result.pageErrors=errors;result.browserVersion=context.browser()?.version()??'persistent-context';await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,open:result.open,transaction:result.transaction,delayedTerminalObservation:result.delayedTerminalObservation}));assert.deepEqual(errors,[]);assert.equal(result.status,'passed');
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',name:error.name,message:error.message,stack:error.stack},null,2)+'\n');throw error;}
finally{await context?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}for(const cleanup of cleanups.reverse())await cleanup();}
