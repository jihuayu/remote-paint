import {LIVE_VERSION} from '../protocol/live-wire.mjs';
import {nativeRuntimeInfo} from '../native/launch.mjs';
import {assertPrivateImagePixels} from './image-pixels.mjs';
import {assertTextInk} from './text-pixels.mjs';
import {recoverDroppedResource} from './fault-viewer.mjs';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser,browserExecutable} from '../capture/browser.mjs';
const output=process.env.REMOTE_PAINT_LIVE_OUTPUT??'artifacts/live';
const live=await startLive({port:0}),source=live.source;let browser;
const captureFailures=[];let phase='startup';
source.on('captureError',error=>captureFailures.push({phase,message:error.message,...(error.captureDiagnostics?{captureDiagnostics:error.captureDiagnostics}:{})}));
const nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0};
if(source.broker){const request=source.broker.request.bind(source.broker);source.broker.request=(op,...args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,...args);};}
const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,...args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,...args);};
// Compact Source receipts carry the actual producer/frame/ordinal identity.
// Legacy Node snapshots additionally expose a namespace, which stays checked
// when present rather than adding an invented namespace to native receipts.
const shownAtLeast=native=>{
 const shown=window.remotePaintResult?.native;
 return shown?.producer===native.producer&&shown.frameToken>=native.frameToken&&
  (!Array.isArray(native.namespace)||JSON.stringify(shown.namespace)===JSON.stringify(native.namespace))&&
  (!Number.isSafeInteger(native.sourceFrame)||shown.sourceFrame>=native.sourceFrame)&&
  (!Number.isSafeInteger(native.captureOrdinal)||shown.captureOrdinal>=native.captureOrdinal);
};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async predicate=>{const start=Date.now();while(!predicate()){if(Date.now()-start>30000)throw new Error(`Native live timeout: ${source.stats.lastError}`);await delay(100);}};
try{
 browser=await launchCaptureBrowser();
 await mkdir(output,{recursive:true});await delay(300);assert.equal(source.stats.captures,0);
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).origin));
 const viewerUrl=new URL(live.url);if(process.env.REMOTE_PAINT_FORCE_GPU==='1')viewerUrl.searchParams.set('gpu','');await page.goto(viewerUrl.href);
 await page.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:60000});const first=await page.evaluate(()=>window.remotePaintResult);
 await page.waitForFunction(first=>window.remotePaintResult?.resourcesReceived>first.resourcesReceived,first,{timeout:30000});
 const dynamic=await page.evaluate(()=>window.remotePaintResult);assert.notEqual(dynamic.native.captureId,first.native.captureId);
 // Stop content updates and the compositor animation for an aligned comparison.
 await source.page.locator('#stop-clock').click();await source.page.evaluate(()=>document.getAnimations().forEach(a=>a.pause()));
 let n=source.stats.captures;await wait(()=>source.stats.captures>n+1);const stable=source.latest.native;
 // A slow Viewer can coalesce this exact capture before its next ACK. Any
 // newer frame from the same producer is equally stable while paint is paused.
 if(source.nativeAutopublish){assert.ok(Number.isSafeInteger(stable.captureOrdinal));assert.ok(Number.isSafeInteger(stable.sourceFrame));}
 await page.waitForFunction(shownAtLeast,stable);
 const sourceBytes=await source.page.screenshot({path:output+'/source.png'}),viewerBytes=await page.locator('canvas').evaluate(c=>c.toDataURL());
 const replay=Buffer.from(viewerBytes.split(',')[1],'base64');await writeFile(output+'/replay.png',replay);
 const a=PNG.sync.read(sourceBytes),b=PNG.sync.read(replay);assert.equal(a.width,b.width);assert.equal(a.height,b.height);
 let changed=0;for(let i=0;i<a.data.length;i+=4)if([0,1,2,3].some(c=>Math.abs(a.data[i+c]-b.data[i+c])>24))changed++;
 const imagePixels=await assertPrivateImagePixels(source.page,a,b);
 const textInk=await assertTextInk(source.page,a,b,[{selector:'header h1',background:[20,34,59]},{selector:'header p',background:[20,34,59]}]);
 const pixelFractionOver24=changed/(a.width*a.height);assert.ok(pixelFractionOver24<0.06,`Native Viewer pixel difference ${pixelFractionOver24}`);
 const frozen=await page.evaluate(()=>window.remotePaintResult);await source.page.evaluate(()=>document.getAnimations().forEach(a=>a.play()));
 n=source.stats.captures;await wait(()=>source.stats.captures>n+2);await page.waitForFunction(n=>window.remotePaintResult?.deltaFrames>n,frozen.deltaFrames);
 const animated=await page.evaluate(()=>window.remotePaintResult);assert.equal(animated.resourcesReceived,frozen.resourcesReceived,'Compositor-only animation must reuse paint bytes');
 await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
 const click=async selector=>{const r=await source.page.locator(selector).boundingBox(),c=await page.locator('canvas').boundingBox();await page.mouse.click(c.x+(r.x+r.width/2)*c.width/960,c.y+(r.y+r.height/2)*c.height/640);};
 await click('#start-stream');await source.page.waitForFunction(()=>document.querySelector('#stream').textContent.endsWith('都由原始网页处理。'));await page.waitForFunction(n=>window.remotePaintResult?.resourcesReceived>n,animated.resourcesReceived);
 n=source.stats.captures;await wait(()=>source.stats.captures>n+1);const completedStream=source.latest.native;
 await page.waitForFunction(shownAtLeast,completedStream);
 const streamSource=PNG.sync.read(await source.page.screenshot({path:output+'/stream-source.png'}));
 const streamReplay=PNG.sync.read(Buffer.from((await page.locator('canvas').evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
 await writeFile(output+'/stream-replay.png',PNG.sync.write(streamReplay));
 const streamText=await source.page.locator('#stream').innerText();
 const streamTextInk=await assertTextInk(source.page,streamSource,streamReplay,[{selector:'#stream',background:[255,255,255]}]);
 const erased={...streamReplay,data:Buffer.alloc(streamReplay.data.length,255)};
 await assert.rejects(()=>assertTextInk(source.page,streamSource,erased,[{selector:'#stream',background:[255,255,255]}]),/lost 100.00%/);
 const streamed=await page.evaluate(()=>window.remotePaintResult);assert.ok(streamed.lastProcessedInputSeq>0);
 const slow=new WebSocket(`${(live.streamOrigin??live.origin).replace('http','ws')}/stream?key=${live.key}`,{origin:live.origin});await once(slow,'open');slow.send(JSON.stringify({type:'Hello',protocol:LIVE_VERSION,renderer:live.renderer}));assert.equal((await once(slow,'close'))[0],1013);
 const beforeReconnect=await page.evaluate(()=>window.remotePaintResult);assert.ok(beforeReconnect.frameId>streamed.frameId,'Slow peer must not stall the normal Viewer');await page.locator('#reconnect').click();
 // A fast producer may present several frames before Playwright polls. Prove
 // a new connection committed its keyframe without racing the transient #1.
 await page.waitForFunction(previous=>window.remotePaintResult?.connectionGeneration>previous&&window.remotePaintResult?.fullFrames===1,beforeReconnect.connectionGeneration);
 const recovered=await page.evaluate(()=>window.remotePaintResult);assert.equal(recovered.fullFrames,1);assert.notEqual(recovered.native.captureId,first.native.captureId);
 let nativeBrokerResetRecovery=null;
 if(source.broker){
  assert.equal(source.nativeAutopublish,true);
  const old={...source.capture.binding.config},recoveries=source.stats.resourceRecoveries,completed=source.stats.completedResets,epoch=source.pageEpoch,viewportVersion=source.viewportVersion,inputSeq=source.inputSeq;
  // Reset intentionally revokes native scopes. Its full rebind is distinct
  // from a real hash miss; verify-native-source-hash-retry.mjs retains that
  // separate actual Mapper miss/Retry/full-resend acceptance criterion.
  let listener,timer;
  const full=new Promise((resolve,reject)=>{
   listener=frame=>{if(frame.resourcesComplete&&frame.rawResourceBytes>0&&frame.native.captureOrdinal>old.ordinalLimit)resolve(frame);};source.on('frame',listener);
   timer=setTimeout(()=>reject(new Error('Controlled native reset full-resource deadline')),30000);
   source.broker.reset().catch(reject);
  });
  let resetFrame;try{resetFrame=await full;}finally{clearTimeout(timer);source.off('frame',listener);}
  await wait(()=>!source.transitioning&&!source.capture.forceResources);
  assert.notEqual(source.capture.binding.config.id,old.id);assert.ok(source.capture.binding.config.ordinalBase>=old.ordinalLimit+1);
  assert.equal(source.pageEpoch,epoch);assert.equal(source.viewportVersion,viewportVersion);assert.equal(resetFrame.lastProcessedInputSeq,inputSeq);assert.equal(source.stats.completedResets,completed+1);assert.equal(source.stats.resourceRecoveries,recoveries);
  await page.waitForFunction(shownAtLeast,resetFrame.native);
  nativeBrokerResetRecovery={completedResets:1,sameEpoch:true,inputSeq,fullResourceBytes:resetFrame.rawResourceBytes,captureOrdinal:resetFrame.native.captureOrdinal,previousOrdinalLimit:old.ordinalLimit,hashMissRetries:0,resumed:true};
 }
 await wait(()=>source.control.mode==='agent');
 phase='navigation';const oldEpoch=source.pageEpoch;await source.page.reload();await page.waitForFunction(epoch=>window.remotePaintResult?.pageEpoch>epoch,oldEpoch);const navigated=await page.evaluate(()=>window.remotePaintResult);
 assert.ok(navigated.pageEpoch>oldEpoch);assert.equal(source.browser.isConnected(),true);assert.equal(source.page.isClosed(),false);assert.equal(source.targetCrashed,false);
 await source.page.waitForFunction(()=>[...document.images].every(image=>image.complete&&image.naturalWidth>0));
 n=source.stats.captures;source.requestCapture();await wait(()=>source.stats.captures>n+1);const newDocument=source.latest.native;
 await page.waitForFunction(shownAtLeast,newDocument);
 const navigationSource=PNG.sync.read(await source.page.screenshot()),navigationReplay=PNG.sync.read(Buffer.from((await page.locator('canvas').evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
 const navigationImagePixels=await assertPrivateImagePixels(source.page,navigationSource,navigationReplay);
 phase='resize';const resizeRecovery=[];
 for(const width of [800,960,800]){
  await source.resize({width,height:600});
  // OffscreenCanvas updates its HTML placeholder during the browser's
  // rendering step, which can follow the Worker's frame metadata message.
  await page.waitForFunction(({version,width})=>window.remotePaintResult?.viewportVersion===version&&document.querySelector('canvas').width===width,{version:source.viewportVersion,width});
  assert.equal(await page.locator('canvas').getAttribute('width'),String(width));
  resizeRecovery.push({width,viewportVersion:source.viewportVersion,frameId:(await page.evaluate(()=>window.remotePaintResult)).frameId});
 }
 const resized=await page.evaluate(()=>window.remotePaintResult);
 phase='recovery';const missingResourceRecovery=await recoverDroppedResource(browser,live);
 // Frames in the transport window can still refer to older resources. Early
 // collection after each commit would break a later reuse without a resend.
 for(const result of [first,dynamic,frozen,animated,streamed,recovered,navigated,resized]){
  assert.ok(result.resources>=result.requiredResources.length,'Committed dependencies remain available');
  assert.ok(result.resources<=512,'Inflight resource working set stays bounded');
 }
 source.setDemand(0);
 await page.waitForFunction(()=>window.remotePaintResult.resources===window.remotePaintResult.requiredResources.length,null,{timeout:10000});
 const quiescent=await page.evaluate(()=>window.remotePaintResult);
 assert.equal(quiescent.resources,quiescent.requiredResources.length,'After the window drains, all retired resources must be released');
 assert.ok(streamed.resourcesReceived>streamed.resources,'Changed native resources must retire from the client cache');assert.equal(resized.lastProcessedInputSeq,source.inputSeq);
 assert.ok(requests.every(origin=>origin===live.origin));assert.deepEqual(errors,[]);assert.equal(await page.locator('iframe').count(),0);
 await page.screenshot({path:output+'/viewer.png'});await page.close();await wait(()=>source.demand===0);n=source.stats.captures;await delay(600);assert.equal(source.stats.captures,n);
 // Reload may invalidate Runtime.evaluate before the local epoch check runs.
 // A closed target outside navigation is still an error; the successful new
 // producer/epoch and subsequent recovery above prove this target survived.
 assert.ok(captureFailures.every(f=>
  (['navigation','resize'].includes(f.phase)&&/Navigation invalidated|Execution context was destroyed|Cannot find context with specified id/.test(f.message))||
  (f.phase==='navigation'&&/^cdpSession.send: Protocol error \(Runtime\.(?:evaluate|awaitPromise)\): Inspected target navigated or closed$/.test(f.message))
 ),JSON.stringify(captureFailures));
 assert.ok(captureFailures.filter(f=>f.phase==='navigation').length<=3);assert.ok(captureFailures.filter(f=>f.phase==='resize').length<=3);assert.equal(source.stats.errors,captureFailures.length);
 if(process.platform==='linux'){assert.ok(source.frameDriver.stats.acked>0);assert.equal(source.frameDriver.stats.errors,0);}
 if(source.nativeAutopublish){assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});assert.equal(Object.hasOwn(source.latest??{},'payloads'),false);assert.equal(Object.hasOwn(source.latest??{},'scene'),false);}
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const report={status:'passed',scope:source.nativeAutopublish?'Actual default autonomous native Source/real custom Chromium/native Gateway/CanvasKit Viewer complete dynamic fixture, pixels/private images/fonts/streaming/human input/animation reuse/slow peer/reconnect/controlled reset/navigation/3resize/dropped-resource recovery/cache drain/idle. Actual native hash-miss Retry is a separate required verifier. No weak-network/9MiB/full B1/physical-memory claim.':'Actual explicit Node fallback/custom Chromium/Node SceneMapper+transport/CanvasKit Viewer complete dynamic fixture with real pixels/private images/fonts/streaming/human input/animation reuse/slow peer/reconnect/navigation/3resize/dropped-resource recovery/cache drain/idle. No autonomous-native or weak-network/full B1/physical-memory claim.',dataPlane:source.nativeAutopublish?'native-autonomous':'node-fallback',browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),viewerBrowserSha256:hash(await readFile(browserExecutable())),brokerSha256:source.broker?hash(await readFile(process.env.REMOTE_PAINT_BROKER)):null,nodeCalls,nativeHashMissRecoveryTest:source.nativeAutopublish?'tests/verify-native-source-hash-retry.mjs':null,...nativeRuntimeInfo(source.frameDriver),navigationImagePixels,streamText,streamTextInk,missingStreamTextRejected:true,captureFailures,resizeRecovery,nativeBrokerResetRecovery,verifiedAt:new Date().toISOString(),nativeDrawing:true,missingResourceRecovery,sourceBrowser:source.browser.version(),viewerBrowser:browser.version(),first,dynamic,frozen,animated,streamed,beforeReconnect,recovered,navigated,resized,quiescent,imagePixels,textInk,pixelFractionOver24,slowClientClose:1013,noViewerCapturesInitially:0,noViewerCapturesAfterDisconnect:0,viewerSourceRequests:0,errors,stats:source.stats};
 await writeFile(output+'/report.json',JSON.stringify(report,null,2));console.log(report);
}catch(error){await mkdir(output,{recursive:true});await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',phase,error:error.stack,captureFailures,nodeCalls,sourceStats:source.stats},null,2));throw error;}
finally{await browser?.close();await live.close();}
