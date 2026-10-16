import {LIVE_VERSION} from '../protocol/live-wire.mjs';
import {nativeRuntimeInfo} from '../native/launch.mjs';
import {assertPrivateImagePixels} from './image-pixels.mjs';
import {assertTextInk} from './text-pixels.mjs';
import {recoverDroppedResource} from './fault-viewer.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
const live=await startLive({port:0}),browser=await launchCaptureBrowser(),source=live.source;
const captureFailures=[];let phase='startup';
source.on('captureError',error=>captureFailures.push({phase,message:error.message}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async predicate=>{const start=Date.now();while(!predicate()){if(Date.now()-start>30000)throw new Error(`Native live timeout: ${source.stats.lastError}`);await delay(100);}};
try{
 await mkdir('artifacts/live',{recursive:true});await delay(300);assert.equal(source.stats.captures,0);
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).origin));await page.goto(live.url);
 await page.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:60000});const first=await page.evaluate(()=>window.remotePaintResult);
 await page.waitForFunction(first=>window.remotePaintResult?.resourcesReceived>first.resourcesReceived,first,{timeout:30000});
 const dynamic=await page.evaluate(()=>window.remotePaintResult);assert.notEqual(dynamic.native.captureId,first.native.captureId);
 // Stop content updates and the compositor animation for an aligned comparison.
 await source.page.locator('#stop-clock').click();await source.page.evaluate(()=>document.getAnimations().forEach(a=>a.pause()));
 let n=source.stats.captures;await wait(()=>source.stats.captures>n+1);const stable=source.latest.native;
 // A slow Viewer can coalesce this exact capture before its next ACK. Any
 // newer frame from the same producer is equally stable while paint is paused.
 await page.waitForFunction(native=>{const shown=window.remotePaintResult?.native;return shown?.producer===native.producer&&JSON.stringify(shown.namespace)===JSON.stringify(native.namespace)&&shown.frameToken>=native.frameToken;},stable);
 const sourceBytes=await source.page.screenshot({path:'artifacts/live/source.png'}),viewerBytes=await page.locator('canvas').evaluate(c=>c.toDataURL());
 const replay=Buffer.from(viewerBytes.split(',')[1],'base64');await writeFile('artifacts/live/replay.png',replay);
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
 await page.waitForFunction(native=>{const shown=window.remotePaintResult?.native;return shown?.producer===native.producer&&JSON.stringify(shown.namespace)===JSON.stringify(native.namespace)&&shown.frameToken>=native.frameToken;},completedStream);
 const streamSource=PNG.sync.read(await source.page.screenshot({path:'artifacts/live/stream-source.png'}));
 const streamReplay=PNG.sync.read(Buffer.from((await page.locator('canvas').evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
 await writeFile('artifacts/live/stream-replay.png',PNG.sync.write(streamReplay));
 const streamText=await source.page.locator('#stream').innerText();
 const streamTextInk=await assertTextInk(source.page,streamSource,streamReplay,[{selector:'#stream',background:[255,255,255]}]);
 const erased={...streamReplay,data:Buffer.alloc(streamReplay.data.length,255)};
 await assert.rejects(()=>assertTextInk(source.page,streamSource,erased,[{selector:'#stream',background:[255,255,255]}]),/lost 100.00%/);
 const streamed=await page.evaluate(()=>window.remotePaintResult);assert.ok(streamed.lastProcessedInputSeq>0);
 const slow=new WebSocket(`${(live.streamOrigin??live.origin).replace('http','ws')}/stream?key=${live.key}`,{origin:live.origin});await once(slow,'open');slow.send(JSON.stringify({type:'Hello',protocol:LIVE_VERSION,renderer:live.renderer}));assert.equal((await once(slow,'close'))[0],1013);
 const beforeReconnect=await page.evaluate(()=>window.remotePaintResult);assert.ok(beforeReconnect.frameId>streamed.frameId,'Slow peer must not stall the normal Viewer');await page.locator('#reconnect').click();await page.waitForFunction(()=>window.remotePaintResult?.frameId===1);const recovered=await page.evaluate(()=>window.remotePaintResult);assert.equal(recovered.fullFrames,1);assert.notEqual(recovered.native.captureId,first.native.captureId);
 await wait(()=>source.control.mode==='agent');
 phase='navigation';const oldEpoch=source.pageEpoch;await source.page.reload();await page.waitForFunction(epoch=>window.remotePaintResult?.pageEpoch>epoch,oldEpoch);const navigated=await page.evaluate(()=>window.remotePaintResult);
 phase='resize';await source.resize({width:800,height:600});await page.waitForFunction(()=>window.remotePaintResult?.viewportVersion===2);assert.equal(await page.locator('canvas').getAttribute('width'),'800');
 const resized=await page.evaluate(()=>window.remotePaintResult);
 phase='recovery';const missingResourceRecovery=await recoverDroppedResource(browser,live);
 for(const result of [first,dynamic,frozen,animated,streamed,recovered,navigated,resized])assert.equal(result.resources,result.requiredResources.length,'Retired resources must be collected after commit');
 assert.ok(streamed.resourcesReceived>streamed.resources,'Changed native resources must retire from the client cache');assert.equal(resized.lastProcessedInputSeq,source.inputSeq);
 assert.ok(requests.every(origin=>origin===live.origin));assert.deepEqual(errors,[]);assert.equal(await page.locator('iframe').count(),0);
 await page.screenshot({path:'artifacts/live/viewer.png'});await page.close();await wait(()=>source.demand===0);n=source.stats.captures;await delay(600);assert.equal(source.stats.captures,n);
 // Reload may invalidate Runtime.evaluate before the local epoch check runs.
 // A closed target outside navigation is still an error; the successful new
 // producer/epoch and subsequent recovery above prove this target survived.
 assert.ok(captureFailures.every(f=>
  (['navigation','resize'].includes(f.phase)&&/Navigation invalidated|Execution context was destroyed|Cannot find context with specified id/.test(f.message))||
  (f.phase==='navigation'&&f.message==='cdpSession.send: Protocol error (Runtime.evaluate): Inspected target navigated or closed')
 ),JSON.stringify(captureFailures));
 if(process.platform==='linux'){assert.ok(source.frameDriver.stats.acked>0);assert.equal(source.frameDriver.stats.errors,0);}
 const report={...nativeRuntimeInfo(source.frameDriver),streamText,streamTextInk,missingStreamTextRejected:true,captureFailures,verifiedAt:new Date().toISOString(),nativeDrawing:true,missingResourceRecovery,sourceBrowser:source.browser.version(),viewerBrowser:browser.version(),first,dynamic,frozen,animated,streamed,beforeReconnect,recovered,navigated,resized,imagePixels,textInk,pixelFractionOver24,slowClientClose:1013,noViewerCapturesInitially:0,noViewerCapturesAfterDisconnect:0,viewerSourceRequests:0,errors,stats:source.stats};
 await writeFile('artifacts/live/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser.close();await live.close();}
