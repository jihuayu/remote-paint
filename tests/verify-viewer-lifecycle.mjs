import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {startLive} from '../live.mjs';
import {browserExecutable} from '../capture/browser.mjs';

// Playwright's default focus emulation holds a visible capture reference,
// preventing real document.hidden even for minimized windows. Use its public
// noDefaults CDP option on a dedicated browser's default context instead.
async function lifecycleBrowser(){
 const profile=await mkdtemp(join(tmpdir(),'remote-paint-lifecycle-')),child=spawn(browserExecutable(),['--headless=new','--no-sandbox','--disable-gpu-rasterization','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1100,900','about:blank'],{stdio:['ignore','ignore','pipe']});
 const stopChild=async()=>{if(child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});};
 let browser;
 try{
  const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(new Error('Lifecycle browser startup timeout')),20000);child.stderr.on('data',chunk=>{log=(log+chunk).slice(-4096);const match=log.match(/DevTools listening on (ws:\/\/\S+)/);if(match){clearTimeout(timer);resolve(match[1]);}});child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Lifecycle browser exited: ${code}`));});});
  browser=await chromium.connectOverCDP(endpoint,{noDefaults:true});
  return {browser,async close(){await browser.close();await stopChild();await rm(profile,{recursive:true,force:true});}};
 }catch(error){await browser?.close();await stopChild();await rm(profile,{recursive:true,force:true});throw error;}
}

const fixture=createServer((request,response)=>{const version=Number(request.url.slice(2))||1;response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:${version%2?'#1464c8':'#c86414'}}input{position:absolute;left:20px;top:20px;width:250px;height:40px}</style><input id="public" data-remote-paint-preview="plain-text"><script>window.ticks=0;requestAnimationFrame(function tick(){window.ticks++;requestAnimationFrame(tick);});</script>`);});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${fixture.address().port}`;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),wait=async predicate=>{const deadline=Date.now()+10000;while(!(await predicate())){if(Date.now()>deadline)throw new Error('Lifecycle source wait timed out');await delay(20);}};
let live,browser,viewerRuntime,releaseActivity;const variants=[];
try{
 live=await startLive({port:0,url:`${origin}/v1`});releaseActivity=live.source.acquirePageActivity();viewerRuntime=await lifecycleBrowser();browser=viewerRuntime.browser;
 for(const mainThread of [false,true]){
  await live.source.page.goto(`${origin}/v1`);const page=await browser.contexts()[0].newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{let result;window.displayEpochs=[];Object.defineProperty(window,'remotePaintResult',{get:()=>result,set:value=>{result=value;if(value)window.displayEpochs.push({epoch:value.pageEpoch,generation:value.viewerGeneration});}});});
  const url=new URL(live.url);url.search=mainThread?'mainThread&cpu':'cpu';await page.goto(url.href);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);
  const cdp=await page.context().newCDPSession(page),{windowId}=await cdp.send('Browser.getWindowForTarget');
  const first=await page.evaluate(()=>({epoch:window.remotePaintResult.pageEpoch,generation:window.remotePaintLifecycle.version,worker:!!window.remotePaintResult.worker}));assert.equal(first.worker,!mainThread);
  await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
  await page.evaluate(()=>{window.oldCanvas=document.querySelector('#viewport');});await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});
  await page.waitForFunction(()=>document.hidden&&window.remotePaintLifecycle.state==='suspended',null,{polling:50});await wait(()=>live.source.demand===0&&live.source.control.mode==='agent');
  assert.equal(await page.evaluate(()=>window.remotePaintResult),null);assert.equal(page.workers().length,0);const captures=live.source.stats.captures,ticks=await live.source.page.evaluate(()=>window.ticks);await delay(200);assert.equal(live.source.stats.captures,captures);assert.ok(await live.source.page.evaluate(()=>window.ticks)>ticks);
  await live.source.page.goto(`${origin}/v2`);const hiddenEpoch=live.source.pageEpoch;
  await page.evaluate(()=>{window.epochMark=window.displayEpochs.length;});await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
  await page.waitForFunction(epoch=>window.remotePaintResult?.pageEpoch>=epoch&&window.remotePaintResult.fullFrames===1,hiddenEpoch);
  assert.equal(await page.evaluate(()=>document.querySelector('#controlState').textContent),'Agent 控制');
  assert.ok(await page.evaluate(epoch=>window.displayEpochs.slice(window.epochMark).every(frame=>frame.epoch>=epoch),hiddenEpoch));
  const pixel=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(document.querySelector('#viewport'),300,200,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];});assert.deepEqual(pixel,[200,100,20,255]);
  await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'minimized'}});await wait(()=>live.source.demand===0);await page.evaluate(()=>{window.epochMark=window.displayEpochs.length;});await cdp.send('Page.setWebLifecycleState',{state:'frozen'});await live.source.page.goto(`${origin}/v3`);const frozenEpoch=live.source.pageEpoch;await cdp.send('Page.setWebLifecycleState',{state:'active'});await cdp.send('Browser.setWindowBounds',{windowId,bounds:{windowState:'normal'}});
  await page.waitForFunction(epoch=>window.remotePaintResult?.pageEpoch>=epoch&&window.remotePaintResult.fullFrames===1,frozenEpoch);
  assert.ok(await page.evaluate(epoch=>window.displayEpochs.slice(window.epochMark).every(frame=>frame.epoch>=epoch),frozenEpoch));
  if(!mainThread){const worker=page.workers()[0];await worker.evaluate(()=>setTimeout(()=>{throw new Error('fixture Worker lifecycle failure');},0));await page.waitForFunction(()=>window.remotePaintLifecycle.backend==='main-fallback'&&window.remotePaintResult?.frameId>0&&!window.remotePaintResult.worker);assert.equal(page.workers().length,0);}
  await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
  await page.evaluate(()=>window.oldCanvas.dispatchEvent(new PointerEvent('pointercancel')));assert.equal(live.source.control.mode,'human');
  const bounds=await page.locator('#viewport').boundingBox();await page.mouse.click(bounds.x+100*bounds.width/960,bounds.y+40*bounds.height/640);await live.source.page.waitForFunction(()=>document.activeElement.id==='public');
  await page.locator('#inputProxy').evaluate(proxy=>proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true})));await live.source.page.waitForFunction(()=>document.querySelector('#public').value==='x');
  if(!mainThread){await page.reload();await page.waitForFunction(()=>window.remotePaintResult?.worker&&window.remotePaintResult.frameId>0);await page.workers()[0].evaluate(()=>close());await page.waitForFunction(()=>window.remotePaintLifecycle.backend==='main-fallback'&&window.remotePaintResult?.frameId>0&&!window.remotePaintResult.worker,null,{timeout:20000});}
  const beforeWake=await page.evaluate(()=>window.remotePaintLifecycle.version);await delay(1100);await page.evaluate(()=>{const now=Date.now.bind(Date);Date.now=()=>now()+20000;});await page.waitForFunction(version=>window.remotePaintLifecycle.version>version&&window.remotePaintLifecycle.reason==='wake'&&window.remotePaintResult?.frameId>0,beforeWake);
  assert.ok(errors.every(error=>/fixture Worker lifecycle failure/.test(error)),errors.join('\n'));
  variants.push({workerInitially:!mainThread,hiddenVisibility:'actual Chrome Browser.setWindowBounds minimized/normal; document.hidden verified',chromeNativeFreezeResume:true,agentRafContinued:true,hiddenDisplayCapturesStopped:true,noOldEpochAfterResume:true,restoredPixels:pixel,oldControlLeaseRevoked:true,workerExceptionFallback:mainThread?null:true,silentWorkerExitHeartbeatFallback:mainThread?null:true,syntheticClockGapRecovery:true,oldCanvasEventsIgnored:true,newCanvasInputOnce:true});await page.close();await wait(()=>live.source.demand===0);
 }
 const report={at:new Date().toISOString(),scope:'Actual custom Linux source → Rust → CanvasKit main/Worker; actual Chrome minimized/normal visibility, valid hidden→frozen→active events and actual uncaught Worker exception. Independent Agent activity, hidden navigation and fresh baseline, new canvas pixels/input. Does not claim physical OS sleep or mobile lifecycle acceptance.',variants,status:'passed'};
 await mkdir('artifacts/lifecycle',{recursive:true});await writeFile('artifacts/lifecycle/viewer.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{releaseActivity?.();await viewerRuntime?.close();await live?.close();await new Promise(resolve=>fixture.close(resolve));}
