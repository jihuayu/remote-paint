import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {startSessionMemoryFixture} from './session-memory-fixture.mjs';
import {createSessionMemoryOwner} from './session-memory-owner.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {installSessionInputObserver,measureSessionTextAck,sessionInputObserverStats} from './session-input-ack.mjs';
assert.equal(process.platform,'linux');
const directory=resolve(process.env.REMOTE_PAINT_SESSION_INPUT_OUTPUT??'artifacts/session-input-observer');await mkdir(directory,{recursive:true});const started=performance.now();
let fixture,owner,browser,page,failure,closed;const acks=[],transitions=[],cleanupErrors=[];let expected=0,cycle=0,nonce;
async function waitPixels(n){await page.waitForFunction(({n,number})=>{const v=document.querySelector('#viewport');if(!window.remotePaintResult)return false;let p=window.__inputProbeCanvas;if(!p){const c=document.createElement('canvas');c.width=3;c.height=1;p=window.__inputProbeCanvas={ctx:c.getContext('2d',{willReadFrequently:true})};}for(const[i,[x,y]]of [[20,80],[400,30],[450,30]].entries())p.ctx.drawImage(v,x,y,1,1,i,0,1,1);const d=p.ctx.getImageData(0,0,3,1).data;return d[0]===n&&d[1]===0&&d[2]===199&&d[4]===n&&d[5]===0&&d[6]===199&&d[8]===number&&d[9]===0&&d[10]===211;},{n,number:owner.number});}
async function text(){
 if(await page.locator('#controlState').textContent()!=='你正在操作'){await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');}
 const box=await page.locator('#viewport').boundingBox(),width=await page.locator('#viewport').evaluate(c=>c.width);await page.mouse.click(box.x+100*box.width/width,box.y+38*box.width/width);const ack=await measureSessionTextAck(page);expected++;
 await page.waitForFunction(({n,ack})=>{const result=window.remotePaintResult;if(result.pageEpoch!==ack.pageEpoch||result.viewportVersion!==ack.viewportVersion||result.lastProcessedInputSeq<ack.seq)return false;const ctx=window.__inputProbeCanvas.ctx;ctx.drawImage(document.querySelector('#viewport'),340,30,1,1,0,0,1,1);const d=ctx.getImageData(0,0,1,1).data;if(d[0]*256+d[1]!==n||d[2]!==42)return false;window.__inputPixelObservedAt=performance.now();return true;},{n:expected,ack});
 const observedAt=await page.evaluate(()=>window.__inputPixelObservedAt);assert.ok(observedAt>=ack.at);acks.push({...ack,textCount:expected,pixelObservedAt:observedAt,inputToPixelReadMs:observedAt-ack.dispatchAt});
}
try{
 fixture=await startSessionMemoryFixture();owner=await createSessionMemoryOwner(fixture);browser=await launchCaptureBrowser();page=await browser.newPage();await installSessionInputObserver(page);const url=new URL(owner.url);url.search='cpu&mainThread&memory=compact';await page.goto(url.href);await waitPixels(0);nonce=(await sessionInputObserverStats(page)).nonce;
 for(let i=1;i<=130;i++){
  if(i===61){await owner.resize({width:720,height:480});await page.waitForFunction(()=>window.remotePaintResult.viewportVersion===2&&document.querySelector('#viewport').width===720);transitions.push({kind:'resize',beforeText:i});}
  if(i===91){const before=await owner.navigate(++cycle,'localhost');expected=0;await waitPixels(cycle);transitions.push({kind:'crosssite',beforeText:i,before});}
  await text();
 }
 await page.waitForFunction(()=>window.__sessionInputObserver.pending.size===0);const stats=await sessionInputObserverStats(page);assert.equal(stats.nonce,nonce);assert.deepEqual(stats.errors,[]);assert.equal(stats.rejected,0);assert.equal(stats.active,false);assert.equal(stats.texts,130);assert.equal(stats.sent,stats.acked);assert.equal(stats.retained,128);assert.ok(stats.acked>128&&stats.peakPending<=64);assert.equal(await owner.source.page.locator('input').inputValue(),'x'.repeat(expected));await writeFile(join(directory,'input-observer-stats.json'),JSON.stringify(stats,null,2)+'\n');
}catch(error){failure=error;}
finally{
 try{await browser?.close();}catch(e){cleanupErrors.push(e.stack);}
 try{closed=await owner?.close();assert.equal(closed?.status,'closed');assert.deepEqual(closed.errors,[]);assert.deepEqual(closed.nodeCalls,{map:0,publish:0,awaitPromise:0});}catch(e){cleanupErrors.push(e.stack);}
 try{await fixture?.close();}catch(e){cleanupErrors.push(e.stack);}
}
const report={at:new Date().toISOString(),status:failure||cleanupErrors.length?'failed':'passed',scope:'Actual Linux Source/CPUmain Viewer;130 real Viewer textdispatch→successfulWSsend(seq)→InputAck pairs under3s,actual finalpixels+Native inputwatermark perinput;ring128 crossing/64pendingbound/onepagelifetime,resize/crosssite.Source inputIME/physicaldisplay/Mac/8h/N1long notaccepted.',elapsedSeconds:(performance.now()-started)/1000,acks,transitions,nonce,closed,cleanupErrors,error:failure?.stack};await writeFile(join(directory,'input-observer.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,textInputs:acks.length,maxAckMs:Math.max(...acks.map(a=>a.ms)),cleanupErrors:cleanupErrors.length}));if(report.status!=='passed')throw failure??new Error('Input observer cleanup failed');
