import {recoverDroppedResource} from './fault-viewer.mjs';
// Protocol/Viewer acceptance using a declared capture fixture. This does not
// substitute for verify:scene / verify:live on the custom native browser.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {startLiveTransport} from '../live/transport.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {fakeSource,snapshot} from './live-helpers.mjs';
const source=fakeSource(),transport=await startLiveTransport(source,{port:0,ackTimeout:1500}),browser=await launchCaptureBrowser();
try{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),requests=[];
 page.on('request',request=>requests.push(new URL(request.url()).origin));
 const consoleErrors=[];page.on('pageerror',error=>consoleErrors.push(error.message));await page.goto(transport.url);
 await page.waitForFunction(()=>window.remotePaintResult?.frameId===1);
 const first=await page.evaluate(()=>window.remotePaintResult);const firstPixels=await page.locator('canvas').screenshot();
 source.publish(snapshot({captureId:'contract-2',translation:-75}));
 await page.waitForFunction(()=>window.remotePaintResult?.native.captureId==='contract-2');
 const second=await page.evaluate(()=>window.remotePaintResult);const secondPixels=await page.locator('canvas').screenshot();
 assert.equal(second.resourcesReceived,first.resourcesReceived);assert.ok(second.deltaFrames>=1);
 assert.notEqual(createHash('sha256').update(firstPixels).digest('hex'),createHash('sha256').update(secondPixels).digest('hex'));
 const slow=new WebSocket(`${transport.origin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});
 await once(slow,'open');slow.send(JSON.stringify({type:'Hello',protocol:2,renderer:transport.renderer}));
 const closed=once(slow,'close');source.publish(snapshot({captureId:'contract-3',translation:-100}));
 await page.waitForFunction(()=>window.remotePaintResult?.native.captureId==='contract-3');assert.equal((await closed)[0],1013);
 await page.locator('#reconnect').click();await page.waitForFunction(()=>window.remotePaintResult?.frameId===1&&window.remotePaintResult?.native.captureId==='contract-3');
 const recovered=await page.evaluate(()=>window.remotePaintResult);assert.equal(recovered.fullFrames,1);assert.equal(recovered.deltaFrames,0);
 assert.ok(requests.every(origin=>origin===transport.origin));assert.deepEqual(consoleErrors,[]);
 assert.equal(await page.locator('iframe').count(),0);
 const missingResourceRecovery=await recoverDroppedResource(browser,transport);
 await mkdir('artifacts/live-viewer',{recursive:true});await page.screenshot({path:'artifacts/live-viewer/viewer.png'});
 const report={verifiedAt:new Date().toISOString(),contractFixtureOnly:true,missingResourceRecovery,first,second,recovered,slowClientClose:1013,sourceDemand:source.demand,sourceNetworkRequests:0};
 await writeFile('artifacts/live-viewer/report.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser.close();await transport.close();}
