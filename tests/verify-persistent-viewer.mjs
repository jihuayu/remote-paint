import {cacheBrowserOptions} from './fixtures/cache-browser.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {WebSocket,WebSocketServer} from 'ws';
import {fixture,KEY} from './fixtures/viewer-access-harness.mjs';
import {snapshot,hash} from './live-helpers.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {createPublicViewerServer} from '../service/viewer-assets-http.mjs';

// Real saved main/Worker entry points, real CanvasKit, public HTTP/SQLite grant
// authority and WebSockets. The named Node Source fixture supplies an existing
// SKP. A test-owned private relay omits one SKP on warm connections; production
// offer/miss negotiation and Native performance are deliberately not claimed.
const output=resolve(process.argv[2]??'outputs/persistent-viewer-proof');await mkdir(output,{recursive:true});
const cleanups=[],sockets=new Set(),relayReceipts=[];let context,viewer,relay,wss,dropNext=false,relayOrigin;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const assets=await prepareViewerAssets({mode:'public'});
 const h=await fixture({after:fn=>cleanups.push(fn)},{ttlSeconds:120,wasmSha256:assets.wasmSha256,viewerBuild:assets.build,resolveSource:(args,{transport})=>({tenantId:args.tenantId,sessionId:args.sessionId,region:args.region,version:args.version,key:transport.key,origin:transport.origin,streamOrigin:relayOrigin})});
 const frame=snapshot();h.source.latest=frame;h.source.viewport=frame.viewport;
 frame.scene.passes[0].quads.unshift({kind:'placeholder',reason:'webgl',rect:[700,500,950,620],visible:[700,500,950,620],matrix:[1,0,0,0,1,0,0,0,1],opacity:1,clip:null});
 relay=createServer();wss=new WebSocketServer({server:relay,perMessageDeflate:false,maxPayload:32*1024*1024});
 wss.on('connection',(client,request)=>{
  const upstream=new WebSocket(h.transport.streamOrigin.replace('http:','ws:')+request.url,{origin:h.transport.origin,perMessageDeflate:false,maxPayload:32*1024*1024});sockets.add(client);sockets.add(upstream);
  let omit=dropNext;dropNext=false;const receipt={omissionEnabled:omit,omittedPackets:0,omittedBytes:0,keyframeRequests:0};relayReceipts.push(receipt);const queue=[];
  const finish=()=>{client.terminate();upstream.terminate();sockets.delete(client);sockets.delete(upstream);};client.on('error',finish);upstream.on('error',finish);client.on('close',finish);upstream.on('close',finish);
  client.on('message',(bytes,binary)=>{if(!binary&&JSON.parse(bytes).type==='RequestKeyframe'){receipt.keyframeRequests++;omit=false;}if(upstream.readyState===1)upstream.send(bytes,{binary});else if(queue.length<32)queue.push([bytes,binary]);else finish();});
  upstream.on('open',()=>{for(const [bytes,binary]of queue.splice(0))upstream.send(bytes,{binary});});
  upstream.on('message',(bytes,binary)=>{if(omit&&binary){receipt.omittedPackets++;receipt.omittedBytes+=bytes.length;return;}if(client.readyState===1)client.send(bytes,{binary});});
 });relay.listen(0,'127.0.0.1');await once(relay,'listening');relayOrigin='http://127.0.0.1:'+relay.address().port;
 viewer=await createPublicViewerServer({gatewayOrigin:h.base,allowedParentOrigins:[],preparedAssets:assets});viewer.listen(0,'127.0.0.1');await once(viewer,'listening');const origin='http://127.0.0.1:'+viewer.address().port;
 context=await chromium.launchPersistentContext(output+'/owned-chrome-profile',cacheBrowserOptions());
 const results=[];
 for(const mainThread of [false,true]){
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(15000);
  if(mainThread)await page.addInitScript(()=>Object.defineProperty(HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:undefined}));
  await page.exposeFunction('fixtureViewerTicket',async()=>{const response=await h.api(h.tickets,{method:'POST',key:KEY,body:{role:'readonly',audience:origin,ttlSeconds:30}});assert.equal(response.status,200);return response.data;});
  await page.goto(origin);await page.evaluate(async({base,sessionId})=>{await window.remotePaintViewer.ready;window.remotePaintViewer.connect({gatewayOrigin:base,sessionId,role:'readonly',getTicket:()=>window.fixtureViewerTicket()});},{base:h.base,sessionId:h.sessionId});
  await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);const cold=await page.evaluate(()=>({result:window.remotePaintResult,startup:window.remotePaintStartup}));assert.equal(!!cold.startup.worker,!mainThread);
  const counts=()=>page.evaluate(async()=>{const request=indexedDB.open('remote-paint-private-resources-v1',1);await new Promise(r=>request.onsuccess=r);const db=request.result;try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','bodies'],'readonly'),a=tx.objectStore('meta').getAll(),b=tx.objectStore('bodies').count();tx.oncomplete=()=>resolve({rows:a.result,bodies:b.result});tx.onabort=()=>reject(new Error('Owned count transaction aborted'));});}finally{db.close();}});
  const until=async fn=>{const end=performance.now()+2500;while(!await fn()){assert.ok(performance.now()<end,'Owned physical cache transaction deadline');await new Promise(r=>setTimeout(r,10));}};
  try{await until(async()=>{const c=await counts();return c.rows.some(row=>row.kind==='skp'&&row.id===hash)&&c.bodies>0;});}catch(error){await writeFile(output+'/cold-storage-diagnostic.json',JSON.stringify({mainThread,cold,counts:await counts(),runtime:await page.evaluate(()=>window.remotePaintPersistentCache??null)},null,2)+'\n');throw error;}
  const coldPng=await page.locator('#viewport').screenshot();await writeFile(output+'/'+(mainThread?'main':'worker')+'-cold.png',coldPng);
  dropNext=true;const before=cold.result.connectionGeneration;await page.locator('#reconnect').click();await page.waitForFunction(old=>window.remotePaintResult?.connectionGeneration>old,before);
  const warm=await page.evaluate(()=>window.remotePaintResult);assert.ok(warm.persistentCache.hits>0);assert.ok(relayReceipts.at(-1).omittedBytes>0);assert.equal(relayReceipts.at(-1).keyframeRequests,0);const warmPng=await page.locator('#viewport').screenshot();assert.equal(sha(warmPng),sha(coldPng),'same actual canvas after cache-only resource restore');
  // Keep the same content hash and byte length while physically corrupting the
  // Blob. The original missing-resource barrier must request a full keyframe.
  await page.evaluate(async()=>{const request=indexedDB.open('remote-paint-private-resources-v1',1);await new Promise(r=>request.onsuccess=r);const db=request.result;try{await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','bodies'],'readwrite'),meta=tx.objectStore('meta').getAll();meta.onsuccess=()=>{for(const row of meta.result)tx.objectStore('bodies').put(new Blob([new Uint8Array(row.bytes)]),row.key);};tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('Corruption transaction aborted'));});}finally{db.close();}});
  dropNext=true;await page.locator('#reconnect').click();await page.waitForFunction(old=>window.remotePaintResult?.connectionGeneration>old,warm.connectionGeneration);
  const recovered=await page.evaluate(()=>window.remotePaintResult);assert.ok(recovered.persistentCache.corruptions>0);assert.equal(relayReceipts.at(-1).keyframeRequests,1);const recoveredPng=await page.locator('#viewport').screenshot();assert.equal(sha(recoveredPng),sha(coldPng),'corrupt storage recovers to the exact actual canvas');
  await page.evaluate(()=>window.remotePaintViewer.disconnect());const afterLogout=await counts();assert.equal(afterLogout.rows.length,0);assert.equal(afterLogout.bodies,0);assert.equal(page.workers().length,0);assert.deepEqual(errors,[]);
  results.push({mainThread,cold,warm,recovered,canvasPngSha256:sha(coldPng),physicalCacheAfterAwaitedLogout:{meta:0,bodies:0},realRenderer:true,webglPlaceholderIncluded:true});await page.close();
 }
 const result={status:'passed',results,relayReceipts,browserVersion:context.browser()?.version()??'persistent-context',viewerBuild:assets.build,actualMainAndWorker:true,actualIndexedDb:true,actualCanvasKit:true,source:'existing SKP and virtual Node Source fixture',testRelayOmittedWarmResources:true,productionOfferMissNegotiationImplemented:false,reconnectFirstFrameOrBandwidthQualified:false,nativeSourceOrOriginalBrowserOrSamplerStarted:false,wholeGoalQualified:false};
 await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,mainAndWorker:results.length,relayConnections:relayReceipts.length,actualCacheRestoreAndCorruptionRecovery:true,physicalLogoutPurge:true,performanceQualified:false}));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',name:error.name,message:error.message,stack:error.stack,relayReceipts},null,2)+'\n');throw error;}
finally{await context?.close();for(const socket of sockets)socket.terminate();if(wss)await new Promise(r=>wss.close(r));for(const server of [viewer,relay])if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}for(const cleanup of cleanups.reverse())await cleanup();}
