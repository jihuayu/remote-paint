import {cacheBrowserOptions} from './fixtures/cache-browser.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';
import {fixture,KEY} from './fixtures/viewer-access-harness.mjs';
import {snapshot,hash,payload} from './live-helpers.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {createPublicViewerServer} from '../service/viewer-assets-http.mjs';

// Real saved Viewer -> actual public proxy -> existing Node Source transport.
// No packet-omitting test relay. This is not a Native Source benchmark.
const output=resolve(process.argv[2]??'outputs/cache-offer-viewer-proof');await mkdir(output,{recursive:true});
const cleanups=[];let context,viewer;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 const assets=await prepareViewerAssets({mode:'public'}),h=await fixture({after:fn=>cleanups.push(fn)},{ttlSeconds:120,wasmSha256:assets.wasmSha256,viewerBuild:assets.build});
 const frame=snapshot();h.source.latest=frame;h.source.viewport=frame.viewport;frame.scene.passes[0].quads.unshift({kind:'placeholder',reason:'webgl',rect:[700,500,950,620],visible:[700,500,950,620],matrix:[1,0,0,0,1,0,0,0,1],opacity:1,clip:null});
 viewer=await createPublicViewerServer({gatewayOrigin:h.base,allowedParentOrigins:[],preparedAssets:assets});viewer.listen(0,'127.0.0.1');await once(viewer,'listening');const origin='http://127.0.0.1:'+viewer.address().port;
 context=await chromium.launchPersistentContext(output+'/owned-chrome-profile',cacheBrowserOptions());
 const results=[];
 for(const mainThread of [false,true]){
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  if(mainThread)await page.addInitScript(()=>Object.defineProperty(HTMLCanvasElement.prototype,'transferControlToOffscreen',{value:undefined}));
  await page.exposeFunction('fixtureViewerTicket',async()=>{const reply=await h.api(h.tickets,{method:'POST',key:KEY,body:{role:'readonly',audience:origin,ttlSeconds:30}});assert.equal(reply.status,200);return reply.data;});
  let started=performance.now();await page.goto(origin);await page.evaluate(async({base,sessionId})=>{await window.remotePaintViewer.ready;window.remotePaintViewer.connect({gatewayOrigin:base,sessionId,role:'readonly',getTicket:()=>window.fixtureViewerTicket()});},{base:h.base,sessionId:h.sessionId});
  await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);const coldObservedMs=performance.now()-started,cold=await page.evaluate(()=>({result:window.remotePaintResult,startup:window.remotePaintStartup}));assert.equal(!!cold.startup.worker,!mainThread);
  const sourceStats=()=>({...Array.from(h.transport.peers).at(-1).stats});const coldSource=sourceStats();assert.equal(coldSource.resources,1);
  const counts=()=>page.evaluate(async()=>{const r=indexedDB.open('remote-paint-private-resources-v1',1);await new Promise(resolve=>r.onsuccess=resolve);const db=r.result;try{return await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','bodies'],'readonly'),a=tx.objectStore('meta').getAll(),b=tx.objectStore('bodies').count();tx.oncomplete=()=>resolve({rows:a.result,bodies:b.result});tx.onabort=()=>reject(new Error('Owned cache snapshot failed'));});}finally{db.close();}});
  const end=performance.now()+2500;while(!(await counts()).rows.some(row=>row.kind==='skp'&&row.id===hash)){assert.ok(performance.now()<end,'Owned persistence deadline');await new Promise(r=>setTimeout(r,10));}
  const coldPng=await page.locator('#viewport').screenshot();await writeFile(output+'/'+(mainThread?'main':'worker')+'-cold.png',coldPng);
  started=performance.now();await page.locator('#reconnect').click();await page.waitForFunction(old=>window.remotePaintResult?.connectionGeneration>old,cold.result.connectionGeneration);const warmObservedMs=performance.now()-started,warm=await page.evaluate(()=>window.remotePaintResult),warmSource=sourceStats();
  assert.equal(warmSource.resources,1,'actual Source still sent the original SKP to the authenticated proxy');assert.ok(warm.persistentCache.hits>0);assert.equal(warm.resourcesReceived,0,'resource came from IndexedDB rather than a downstream binary packet');assert.equal(cold.result.receivedBytes-warm.receivedBytes,payload.length+44,'the actual public proxy omitted exactly the original SKP packet');assert.equal(warmSource.keyframeRequests,0);assert.equal(sha(await page.locator('#viewport').screenshot()),sha(coldPng));
  // Break the real existing Source/proxy WebSocket. Do not call the UI
  // reconnect button or discard data: the public client must retry itself.
  const brokenPeer=Array.from(h.transport.peers).at(-1),closed=once(brokenPeer.ws,'close');
  const dropStarted=performance.now();brokenPeer.ws.terminate();await closed;
  await page.waitForFunction(old=>window.remotePaintResult?.connectionGeneration>old,warm.connectionGeneration);
  const afterDrop=await page.evaluate(()=>window.remotePaintResult),dropSource=sourceStats();
  assert.ok(afterDrop.persistentCache.hits>0);assert.equal(afterDrop.resourcesReceived,0);
  assert.equal(dropSource.resources,1);assert.equal(dropSource.keyframeRequests,0);
  assert.equal(sha(await page.locator('#viewport').screenshot()),sha(coldPng));
  const actualDisconnect={serverSocketClosed:true,automaticReconnect:true,observedNodeClockMs:performance.now()-dropStarted,source:dropSource,result:afterDrop};
  await page.evaluate(async()=>{const r=indexedDB.open('remote-paint-private-resources-v1',1);await new Promise(resolve=>r.onsuccess=resolve);const db=r.result;try{await new Promise((resolve,reject)=>{const tx=db.transaction(['meta','bodies'],'readwrite'),request=tx.objectStore('meta').getAll();request.onsuccess=()=>{for(const row of request.result)tx.objectStore('bodies').put(new Blob([new Uint8Array(row.bytes)]),row.key);};tx.oncomplete=resolve;tx.onabort=()=>reject(new Error('Corruption fixture failed'));});}finally{db.close();}});
  await page.locator('#reconnect').click();await page.waitForFunction(old=>window.remotePaintResult?.connectionGeneration>old,afterDrop.connectionGeneration);const recovered=await page.evaluate(()=>window.remotePaintResult),recoveredSource=sourceStats();assert.ok(recovered.persistentCache.corruptions>0);assert.equal(recoveredSource.keyframeRequests,1);assert.equal(recoveredSource.resources,2,'omission cleared before the original Source keyframe resend');assert.ok(recovered.resourcesReceived>0);assert.equal(sha(await page.locator('#viewport').screenshot()),sha(coldPng));
  await page.evaluate(()=>window.remotePaintViewer.disconnect());const logout=await counts();assert.equal(logout.rows.length,0);assert.equal(logout.bodies,0);assert.equal(page.workers().length,0);assert.deepEqual(errors,[]);
  results.push({mainThread,cold,warm,actualDisconnect,recovered,coldSource,warmSource,recoveredSource,actualDownstreamBytesSaved:cold.result.receivedBytes-warm.receivedBytes,canvasPngSha256:sha(coldPng),physicalCacheAfterAwaitedLogout:{meta:0,bodies:0},observedNodeClockMs:{cold:coldObservedMs,warm:warmObservedMs,diagnosticOnly:true,includesDriverAndPresentationObservation:true}});await page.close();
 }
 const result={status:'passed',results,actualPublicProxyOfferOmissionAndMiss:true,actualTransportDisconnectAndAutomaticReconnect:true,testOmissionRelayUsed:false,actualIndexedDb:true,actualMainWorkerAndCanvasKit:true,viewerBuild:assets.build,browserVersion:context.browser()?.version()??'persistent-context',source:'existing SKP and virtual Node Source transport',nativeSourceChunkPathQualified:false,firstFramePerformanceQualified:false,generalProductionSavingsQualified:false,originalCanonicalBrowserOrFixedSamplerExecuted:false,wholeGoalQualified:false};await writeFile(output+'/result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:'passed',paths:results.length,bytesSavedEach:results.map(r=>r.actualDownstreamBytesSaved),actualPublicProxy:true,artificialOmission:false,performanceQualified:false}));
}catch(error){await writeFile(output+'/failure.json',JSON.stringify({status:'failed',name:error.name,message:error.message,stack:error.stack},null,2)+'\n');throw error;}
finally{await context?.close();if(viewer){viewer.closeAllConnections();await new Promise(r=>viewer.close(r));}for(const cleanup of cleanups.reverse())await cleanup();}
