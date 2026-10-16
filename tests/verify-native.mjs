import {nativeLaunchArgs,nativeRuntimeInfo} from '../native/launch.mjs';
import {startBeginFrames} from '../capture/begin-frame.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startDynamicFixture} from './dynamic-fixture.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
const executablePath=process.env.REMOTE_PAINT_CHROMIUM;
if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM to the compiled custom headless_shell');
// Capture errors have their own event; events.once('capture') would leave this
// acceptance waiting forever after a native rejection or Viz pairing timeout.
async function captureOnDemand(capture){
 let cleanup;
 const result=new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(new Error('Native capture acceptance timed out after 15 seconds'));},15000);
  const captured=value=>{cleanup();resolve(value);};
  const failed=error=>{cleanup();reject(error);};
  cleanup=()=>{clearTimeout(timer);capture.off('capture',captured);capture.off('captureError',failed);};
  capture.once('capture',captured);capture.once('captureError',failed);
 });
 try{capture.setDemand(1);return await result;}
 finally{capture.setDemand(0);cleanup();}
}
const token=nativeToken();const fixture=await startDynamicFixture();const viz=await startVizIPC();
const beginFrames=process.platform==='linux';
const browser=await chromium.launch({executablePath,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint},args:nativeLaunchArgs(token,{beginFrames})});
let capture,frameDriver;
try{
 const page=await browser.newPage({viewport:{width:960,height:640}});
 if(beginFrames)frameDriver=await startBeginFrames(page);
 await page.goto(new URL('/glyphs',fixture.url).href);
 await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
 assert.equal(await page.evaluate(()=>typeof globalThis.chrome?.gpuBenchmarking),'undefined','Source JS must not receive capture or legacy disk export APIs');
 await page.screenshot();
 capture=new NativeCapture(page,{token,viz,frameDriver});await capture.initialize();
 await new Promise(r=>setTimeout(r,150));assert.equal(capture.count,0);
 const bad=await capture.cdp.send('Runtime.evaluate',{contextId:capture.world,expression:'chrome.gpuBenchmarking.captureRemotePaint("wrong","denied-test",()=>{})',returnByValue:true});
 assert.ok(bad.exceptionDetails,'Native component must reject an incorrect secret');
 await page.evaluate(()=>{globalThis.pulses=0;setInterval(()=>pulses++,5);});
 const first=await captureOnDemand(capture);
 assert.notEqual(first.recordingThread,first.encodingThread);
 assert.ok(first.resources.length>0);assert.match(first.producer,/^\d+:\d+$/);
 assert.equal(first.viz.captureId,first.captureId);assert.ok(first.viz.passes.length);
 assert.ok(first.resources.every(r=>Buffer.from(r.skp,'base64').subarray(0,8).toString()==='skiapict'));
 assert.ok(first.resources.every(r=>/^[0-9a-f]{64}$/.test(r.resourceId)));
 const pulses=await page.evaluate(()=>pulses);assert.ok(pulses>0,'Source event loop should run during asynchronous font/image encoding');
 const count=capture.count;await new Promise(r=>setTimeout(r,150));assert.equal(capture.count,count);
 await page.locator('#advance').click();const second=await captureOnDemand(capture);
 assert.ok(second.resources.some(r=>r.skp),'The changed layer must carry a fresh incremental resource');
 assert.ok(second.resources.every(r=>r.skp||/^[0-9a-f]{64}$/.test(r.resourceId)));
 const stable=await captureOnDemand(capture);
 assert.equal(stable.timing.recordingCacheMisses,0,'Unchanged layers must reuse their recording cache');
 assert.equal(stable.timing.cachedLayers,stable.resources.length,'Unchanged layers must reuse serialized encodings');
 assert.equal(stable.timing.serializeMs,0,'Cached layers must not report repeated serialization work');
 assert.equal(stable.timing.fontMs,0,'Cached layers must not report repeated font work');
 assert.equal(stable.timing.imageMs,0,'Cached layers must not report repeated image work');
 assert.equal(stable.timing.base64Ms,0,'Cached layers must not report repeated Base64 work');
 assert.ok(stable.resources.every(r=>!r.skp&&/^[0-9a-f]{64}$/.test(r.resourceId)));
 capture.forceResources=true;
 const resent=await captureOnDemand(capture);capture.forceResources=false;
 assert.equal(resent.resourcesComplete,true);
 assert.equal(resent.timing.cachedLayers,resent.resources.length,'Resource repair must reuse encoded bytes');
 assert.equal(resent.timing.serializeMs,0,'Resource repair must not serialize unchanged pictures again');
 assert.ok(resent.resources.every(r=>r.skp),'A complete resource request must resend even cached layers');
 const bitmapGlyphs=second.resources.reduce((n,r)=>n+r.bitmapGlyphs,0);assert.ok(bitmapGlyphs>0,'Native color glyph pixels must be preserved');
 if(beginFrames){assert.ok(frameDriver.stats.acked>0);assert.equal(frameDriver.stats.errors,0);}
 const report={verifiedAt:new Date().toISOString(),browser:browser.version(),...nativeRuntimeInfo(frameDriver),nativeBrowserCapture:true,noViewerCaptures:0,
   captures:capture.count,bitmapGlyphs,sourceBenchmarkingApiExposed:false,isolatedCaptureApi:true,incorrectSecretRejected:true,sourcePulsesDuringCapture:pulses,
   recordingThread:first.recordingThread,encodingThread:first.encodingThread,
   namespace:first.viz.namespace,frameToken:first.frameToken,vizIpc:viz.stats,
   layerIds:first.resources.map(r=>r.localId),resourceBytes:second.resources.map(r=>r.skp?Buffer.from(r.skp,'base64').length:0),
   stableTiming:stable.timing,stableResources:stable.resources.length,resourceResendWithoutSerialization:true};
 await mkdir('artifacts/native',{recursive:true});await writeFile('artifacts/native/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await capture?.close();await frameDriver?.close();await browser.close();await viz.close();await fixture.close();}
