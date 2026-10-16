import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {nativeRuntimeInfo} from '../native/launch.mjs';
import {installInputLatencyProbe,measureInputLatency} from './input-latency.mjs';

const directory=resolve(process.env.REMOTE_PAINT_LATENCY_OUTPUT??'artifacts/latency');
const interval=Number(process.env.REMOTE_PAINT_CAPTURE_INTERVAL??(1000/60));
const captureOnInput=process.env.REMOTE_PAINT_INPUT_CAPTURE!=='0';
const live=await startLive({port:0,interval,captureOnInput}),source=live.source;
const browserHash=createHash('sha256');for await(const bytes of createReadStream(process.env.REMOTE_PAINT_CHROMIUM))browserHash.update(bytes);
const executableSha256=browserHash.digest('hex');
const captureTimes=[],capture=source.capture.capture.bind(source.capture);
source.capture.capture=async()=>{const started=performance.now();try{return await capture();}finally{captureTimes.push(performance.now()-started);}};
 let browser,page;
try{
 await source.page.locator('#stop-clock').click();await source.page.evaluate(()=>document.getAnimations().forEach(a=>a.pause()));
 const point=await installInputLatencyProbe(source.page);
 browser=await launchCaptureBrowser();page=await browser.newPage({viewport:{width:1100,height:1000}});const errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.goto(live.url);
 await page.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:60000});
 await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
 const input=await source.page.locator('#name').boundingBox(),canvas=await page.locator('canvas').boundingBox();
 await page.mouse.click(canvas.x+(input.x+input.width/2)*canvas.width/source.viewport.cssWidth,canvas.y+(input.y+input.height/2)*canvas.height/source.viewport.cssHeight);
 const latency=await measureInputLatency(page,point);
 assert.ok((await source.page.locator('#name').inputValue()).endsWith(latency.samples.map(r=>r.key).join('')));
 assert.deepEqual(errors,[]);
 assert.equal(source.stats.errors,0,source.stats.lastError);
 const times=[...captureTimes].sort((a,b)=>a-b),captureMs={samples:captureTimes,p50:times[Math.ceil(times.length*0.5)-1],p95:times[Math.ceil(times.length*0.95)-1]};
 const report={verifiedAt:new Date().toISOString(),...nativeRuntimeInfo(source.frameDriver),viewerPlatform:process.platform,sourceBrowser:source.browser.version(),viewerBrowser:browser.version(),nativeDrawing:true,executableSha256,captureIntervalMs:interval,captureOnInput,inputStyle:point.inputStyle,sourceStats:{...source.stats},captureMs,...latency,errors};
 await mkdir(directory,{recursive:true});
 await source.page.screenshot({path:resolve(directory,'source.png')});
 const replay=await page.locator('canvas').evaluate(c=>c.toDataURL());
 await writeFile(resolve(directory,'replay.png'),Buffer.from(replay.split(',')[1],'base64'));
 await writeFile(resolve(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 await mkdir(directory,{recursive:true});
 await source.page.screenshot({path:resolve(directory,'failure-source.png')}).catch(()=>{});
 if(page){await page.screenshot({path:resolve(directory,'failure-viewer.png')}).catch(()=>{});const image=await page.locator('canvas').evaluate(c=>c.toDataURL()).catch(()=>null);if(image)await writeFile(resolve(directory,'failure-replay.png'),Buffer.from(image.split(',')[1],'base64'));}
 await writeFile(resolve(directory,'failure.json'),JSON.stringify({error:error.stack,sourceStats:source.stats,native:source.latest?.native,input:await source.page.locator('#name').inputValue(),marker:await source.page.locator('#remote-paint-latency-probe').evaluate(el=>({color:getComputedStyle(el).backgroundColor,box:el.getBoundingClientRect().toJSON()}))},null,2));throw error;
}finally{await browser?.close();await live.close();}
