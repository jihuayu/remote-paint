import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startDynamicFixture} from './dynamic-fixture.mjs';
const executablePath=process.env.REMOTE_PAINT_CHROMIUM;
if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM to the compiled custom headless_shell');
const token=nativeToken();const fixture=await startDynamicFixture();
const browser=await chromium.launch({executablePath,headless:true,args:['--enable-gpu-benchmarking',`--remote-paint-token=${token}`,'--disable-gpu-rasterization','--no-sandbox']});
let capture;
try{
 const page=await browser.newPage({viewport:{width:960,height:640}});await page.goto(new URL('/glyphs',fixture.url).href);
 await page.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth));
 await page.screenshot();
 capture=new NativeCapture(page,{token});await capture.initialize();
 await new Promise(r=>setTimeout(r,150));assert.equal(capture.count,0);
 const bad=await capture.cdp.send('Runtime.evaluate',{contextId:capture.world,expression:'chrome.gpuBenchmarking.captureRemotePaint("wrong",()=>{})',returnByValue:true});
 assert.ok(bad.exceptionDetails,'Native component must reject an incorrect secret');
 await page.evaluate(()=>{globalThis.pulses=0;setInterval(()=>pulses++,5);});
 const result=once(capture,'capture');capture.setDemand(1);const [first]=await result;capture.setDemand(0);
 assert.notEqual(first.recordingThread,first.encodingThread);
 assert.ok(first.resources.length>0);assert.equal(first.producer>0,true);
 assert.ok(first.resources.every(r=>Buffer.from(r.skp,'base64').subarray(0,8).toString()==='skiapict'));
 const pulses=await page.evaluate(()=>pulses);assert.ok(pulses>0,'Source event loop should run during asynchronous font/image encoding');
 const count=capture.count;await new Promise(r=>setTimeout(r,150));assert.equal(capture.count,count);
 await page.locator('#advance').click();const next=once(capture,'capture');capture.setDemand(1);const [second]=await next;capture.setDemand(0);
 assert.notEqual(first.resources[0].skp,second.resources[0].skp);
 const report={verifiedAt:new Date().toISOString(),browser:browser.version(),noViewerCaptures:0,
   captures:capture.count,incorrectSecretRejected:true,sourcePulsesDuringCapture:pulses,
   recordingThread:first.recordingThread,encodingThread:first.encodingThread,
   layerIds:first.resources.map(r=>r.localId),resourceBytes:second.resources.map(r=>Buffer.from(r.skp,'base64').length)};
 await mkdir('artifacts/native',{recursive:true});await writeFile('artifacts/native/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await capture?.close();await browser.close();await fixture.close();}
