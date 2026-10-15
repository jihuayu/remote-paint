import {nativeLaunchArgs} from '../native/launch.mjs';
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
const browser=await chromium.launch({executablePath,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint},args:nativeLaunchArgs(token)});
let capture;
try{
 const page=await browser.newPage({viewport:{width:960,height:640}});await page.goto(new URL('/glyphs',fixture.url).href);
 await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
 assert.equal(await page.evaluate(()=>typeof globalThis.chrome?.gpuBenchmarking),'undefined','Source JS must not receive capture or legacy disk export APIs');
 await page.screenshot();
 capture=new NativeCapture(page,{token,viz});await capture.initialize();
 await new Promise(r=>setTimeout(r,150));assert.equal(capture.count,0);
 const bad=await capture.cdp.send('Runtime.evaluate',{contextId:capture.world,expression:'chrome.gpuBenchmarking.captureRemotePaint("wrong","denied-test",()=>{})',returnByValue:true});
 assert.ok(bad.exceptionDetails,'Native component must reject an incorrect secret');
 await page.evaluate(()=>{globalThis.pulses=0;setInterval(()=>pulses++,5);});
 const first=await captureOnDemand(capture);
 assert.notEqual(first.recordingThread,first.encodingThread);
 assert.ok(first.resources.length>0);assert.match(first.producer,/^\d+:\d+$/);
 assert.equal(first.viz.captureId,first.captureId);assert.ok(first.viz.passes.length);
 assert.ok(first.resources.every(r=>Buffer.from(r.skp,'base64').subarray(0,8).toString()==='skiapict'));
 const pulses=await page.evaluate(()=>pulses);assert.ok(pulses>0,'Source event loop should run during asynchronous font/image encoding');
 const count=capture.count;await new Promise(r=>setTimeout(r,150));assert.equal(capture.count,count);
 await page.locator('#advance').click();const second=await captureOnDemand(capture);
 assert.notEqual(first.resources[0].skp,second.resources[0].skp);
 const report={verifiedAt:new Date().toISOString(),browser:browser.version(),gpuMode:'in-process',nativeBrowserCapture:true,noViewerCaptures:0,
   captures:capture.count,sourceBenchmarkingApiExposed:false,isolatedCaptureApi:true,incorrectSecretRejected:true,sourcePulsesDuringCapture:pulses,
   recordingThread:first.recordingThread,encodingThread:first.encodingThread,
   namespace:first.viz.namespace,frameToken:first.frameToken,vizIpc:viz.stats,
   layerIds:first.resources.map(r=>r.localId),resourceBytes:second.resources.map(r=>Buffer.from(r.skp,'base64').length)};
 await mkdir('artifacts/native',{recursive:true});await writeFile('artifacts/native/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await capture?.close();await browser.close();await viz.close();await fixture.close();}
