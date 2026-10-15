// Viewer and all user input run in a macOS browser. Source observations come
// from the real ARM64 Linux browser through the private mounted file channel.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PNG} from 'pngjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {assertPrivateImagePixels} from './image-pixels.mjs';
import {assertTextInk} from './text-pixels.mjs';
import {recoverDroppedResource} from './fault-viewer.mjs';
assert.equal(process.platform,'darwin','The Viewer acceptance must run on the Mac host');
const directory=resolve(process.env.REMOTE_PAINT_LINUX_PROOF??'artifacts/linux-mac');
const ready=JSON.parse(await readFile(join(directory,'ready.json'),'utf8'));
assert.equal(ready.source.platform,'linux');assert.equal(ready.source.architecture,'arm64');
assert.equal(ready.source.captures,0,'No Viewer must mean zero native captures');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function command(op){
 const id=randomUUID(),path=join(directory,'request.json');
 await writeFile(`${path}.tmp`,JSON.stringify({runId:ready.runId,id,op}));await rename(`${path}.tmp`,path);
 const start=Date.now();
 while(Date.now()-start<45000){
  const response=await readFile(join(directory,'response.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(response?.id===id){if(response.error)throw new Error(response.error);return response;}
  await delay(80);
 }
 throw new Error(`Linux source observation timed out: ${op}`);
}
async function waitSource(predicate){
 const start=Date.now();
 while(Date.now()-start<45000){const {state}=await command('snapshot');if(predicate(state))return state;await delay(100);}
 throw new Error('Linux source state did not reach expected value');
}
const browser=await launchCaptureBrowser();let page;
try{
 await mkdir(directory,{recursive:true});
 page=await browser.newPage({viewport:{width:1100,height:1000}});const errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).origin));
 await page.goto(ready.url);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:60000});
 const first=await page.evaluate(()=>window.remotePaintResult);
 await page.waitForFunction(first=>window.remotePaintResult?.resourcesReceived>first.resourcesReceived,first);
 const dynamic=await page.evaluate(()=>window.remotePaintResult);assert.notEqual(dynamic.native.captureId,first.native.captureId);
 await command('freeze');
 const initial=await command('snapshot');
 await waitSource(s=>s.captures>initial.state.captures+2);
 const sample=await command('screenshot');
 await page.waitForFunction(native=>{const shown=window.remotePaintResult?.native;return shown?.producer===native.producer&&shown.frameToken>=native.frameToken;},sample.state.native);
 const original=PNG.sync.read(await readFile(join(directory,sample.screenshot)));
 const replay=PNG.sync.read(Buffer.from((await page.locator('canvas').evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
 await writeFile(join(directory,'replay.png'),PNG.sync.write(replay));
 assert.equal(original.width,replay.width);assert.equal(original.height,replay.height);let changed=0;
 for(let i=0;i<original.data.length;i+=4)if([0,1,2,3].some(c=>Math.abs(original.data[i+c]-replay.data[i+c])>24))changed++;
 const pixelFractionOver24=changed/(original.width*original.height);assert.ok(pixelFractionOver24<0.06,`Linux to Mac replay mismatch: ${pixelFractionOver24}`);
 // Only geometry and computed colors are adapted here; both pixel buffers
 // above are produced by the actual Linux screenshot and Mac CanvasKit.
 const geometry={locator:selector=>({boundingBox:async()=>sample.state.document.elements[selector].box,evaluate:async()=>sample.state.document.elements[selector].foreground})};
 const imagePixels=await assertPrivateImagePixels(geometry,original,replay);
 const textInk=await assertTextInk(geometry,original,replay,[{selector:'header h1',background:[20,34,59]},{selector:'header p',background:[20,34,59]}]);
 const frozen=await page.evaluate(()=>window.remotePaintResult);await command('animate');
 await page.waitForFunction(n=>window.remotePaintResult?.deltaFrames>n+2,frozen.deltaFrames);
 const animated=await page.evaluate(()=>window.remotePaintResult);assert.equal(animated.resourcesReceived,frozen.resourcesReceived);
 await command('freeze');await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
 async function click(selector){const {state}=await command('snapshot'),r=state.document.elements[selector].box,c=await page.locator('canvas').boundingBox();await page.mouse.click(c.x+(r.x+r.width/2)*c.width/state.viewport.cssWidth,c.y+(r.y+r.height/2)*c.height/state.viewport.cssHeight);}
 await click('#name');await page.keyboard.press('Meta+A');await page.keyboard.type('Mac');
 await waitSource(s=>s.document.name==='Mac');
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.imeSetComposition',{text:'中文',selectionStart:2,selectionEnd:2});await cdp.send('Input.insertText',{text:'中文'});
 await waitSource(s=>s.document.name==='Mac中文');
 await page.keyboard.press('Meta+A');
 await page.locator('#inputProxy').evaluate(el=>{const data=new DataTransfer();data.setData('text/plain','Mac 控制 Linux 🌈');el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));});
 await waitSource(s=>s.document.name==='Mac 控制 Linux 🌈');await click('#save');
 const saved=await waitSource(s=>s.document.saved==='已保存：Mac 控制 Linux 🌈');
 await page.waitForFunction(n=>window.remotePaintResult?.lastProcessedInputSeq>=n,saved.inputSeq);
 await click('#start-stream');const streamed=await waitSource(s=>s.document.stream.endsWith('都由原始网页处理。'));
 await page.waitForFunction(n=>window.remotePaintResult?.lastProcessedInputSeq>=n,streamed.inputSeq);
 const canvas=await page.locator('canvas').boundingBox();await page.mouse.move(canvas.x+canvas.width/2,canvas.y+canvas.height/2);await page.mouse.wheel(0,500);
 const scrolled=await waitSource(s=>s.document.scrollY>200);assert.equal(scrolled.document.elements.header.box.y,0);
 await page.locator('#reconnect').click();await page.waitForFunction(()=>document.body.dataset.ready==='true'&&document.querySelector('#controlState').textContent==='Agent 控制');
 const reconnected=await waitSource(s=>s.controlMode==='agent');
 await command('reload');await page.waitForFunction(epoch=>window.remotePaintResult?.pageEpoch>epoch,reconnected.pageEpoch);
 await command('resize');await page.waitForFunction(()=>window.remotePaintResult?.viewportVersion===2);assert.equal(await page.locator('canvas').getAttribute('width'),'800');
 const missingResourceRecovery=await recoverDroppedResource(browser,ready);
 await page.screenshot({path:join(directory,'mac-viewer.png')});await cdp.detach();await page.close();page=null;
 const disconnected=await waitSource(s=>s.demand===0);await delay(500);const final=(await command('snapshot')).state;
 assert.equal(final.captures,disconnected.captures);assert.ok(final.beginFrame.acked>0);assert.equal(final.beginFrame.errors,0);
 assert.ok(requests.every(origin=>origin===ready.origin));assert.deepEqual(errors,[]);
 const report={verifiedAt:new Date().toISOString(),nativeDrawing:true,drawingFixtureOnly:false,viewerPlatform:process.platform,viewerArchitecture:process.arch,viewerBrowser:browser.version(),sourcePlatform:final.platform,sourceArchitecture:final.architecture,sourceBrowser:final.browser,gpuMode:final.gpuMode,beginFrame:final.beginFrame,first,dynamic,animated,imagePixels,textInk,pixelFractionOver24,saved:saved.document.saved,streamText:streamed.document.stream,scrollY:scrolled.document.scrollY,reconnectedControlMode:reconnected.controlMode,missingResourceRecovery,source:final,macInputToLinux:true,imeViaActualLocalAndRemoteCDP:true,physicalOsImeCandidateWindowTested:false,viewerSourceRequests:0,noViewerCapturesInitially:0,noViewerCapturesAfterDisconnect:0,errors};
 await writeFile(join(directory,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 await command('reset');
}finally{await page?.close();await browser.close();}
