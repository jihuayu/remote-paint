// Cross-host adapter proof. Strict windows deliberately exclude transitions;
// this is not continuous long-run age coverage or physical display latency.
import assert from 'node:assert/strict';
import {readFile,writeFile,rename,unlink,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {installFrameAgeObserver,beginFrameAge,finishFrameAge} from './frame-age-observer.mjs';
import {atomicJson} from './memory-soak-diagnostics.mjs';
assert.equal(process.platform,'darwin');
const directory=resolve(process.env.REMOTE_PAINT_SESSION_LONG_DIR??'artifacts/session-frame-age-remote'),delay=ms=>new Promise(r=>setTimeout(r,ms));await mkdir(directory,{recursive:true});
let ready;for(let n=0;n<300&&!ready;n++){try{ready=JSON.parse(await readFile(join(directory,'ready.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;await delay(100);}}
assert.ok(ready?.observerProvenance&&!ready.observerProvenance.diagnosticFaults);
let tail=Promise.resolve();function command(op,fields={}){const next=tail.then(async()=>{
 const id=randomUUID(),path=join(directory,'requests',id+'.json'),reply=join(directory,'responses',id+'.json');await writeFile(path+'.tmp',JSON.stringify({runId:ready.runId,id,op,...fields}));await rename(path+'.tmp',path);
 const start=Date.now();while(Date.now()-start<30000){const r=await readFile(reply,'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});if(r){assert.equal(r.id,id);await Promise.all([unlink(path),unlink(reply)]);if(r.error)throw new Error(r.error);return r;}await delay(25);}throw new Error('File-channel command timeout:'+op);
 });tail=next.catch(()=>{});return next;}
const options={nativeProbe:async()=>(await command('clock-probe')).nativeProbe};
async function pixels(page,n){const h=await page.waitForFunction(({n,number})=>{
 const source=document.querySelector('#viewport');if(!window.remotePaintResult||source.width<600)return false;const canvas=document.createElement('canvas');canvas.width=3;canvas.height=1;const ctx=canvas.getContext('2d');for(const[i,[x,y]]of [[20,80],[400,30],[450,30]].entries())ctx.drawImage(source,x,y,1,1,i,0,1,1);const d=ctx.getImageData(0,0,3,1).data;return d[0]===(n&255)&&d[1]===(n>>8)&&d[2]===199&&d[4]===(n&255)&&d[5]===(n>>8)&&d[6]===199&&d[8]===(number&255)&&d[9]===(number>>8)&&d[10]===211;
 },{n,number:ready.primary.number},{timeout:15000});await h.dispose();}
let browser,page,root,initialWorker,nonce=randomUUID(),cycle=0,failure,cleanup,typed=0;const windows=[],transitions=[],cleanupErrors=[];
const started=performance.now();
try{
 browser=await launchCaptureBrowser();page=await browser.newPage();root=await browser.newBrowserCDPSession();const provenance=structuredClone(ready.observerProvenance);await installFrameAgeObserver(page,provenance);const url=new URL(ready.primary.url);url.search='cpu&memory=compact';await page.goto(url.href);await pixels(page,0);await page.evaluate(n=>window.__remoteAgeLifetime=n,nonce);
 initialWorker=(await root.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId);assert.equal(initialWorker.length,1);
 for(let segment=0;segment<3;segment++){
  const begin=performance.now(),startCycle=cycle,window=await beginFrameAge(null,page,options),producers=new Set();
  for(let n=0;n<40;n++){
   await command('update',{target:'primary',sessionId:ready.primary.id,cycle:++cycle});await pixels(page,cycle);
   if(n%10===0){
    if(await page.locator('#controlState').textContent()!=='你正在操作'){await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');}
    const box=await page.locator('#viewport').boundingBox(),width=await page.locator('#viewport').evaluate(c=>c.width);await page.mouse.click(box.x+100*box.width/width,box.y+38*box.width/width);await page.locator('#inputProxy').evaluate(e=>e.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true})));typed++;
    await page.waitForFunction(n=>{const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(document.querySelector('#viewport'),340,30,1,1,0,0,1,1);const d=ctx.getImageData(0,0,1,1).data;return d[0]*256+d[1]===n&&d[2]===42;},typed);
   }
  }
  const result=await finishFrameAge(null,page,window,provenance,options);await atomicJson(directory,`raw-frame-age-segment-${segment}.json`,result);assert.ok(result.samples.length>=40);assert.equal(result.coverage.fraction,1);assert.equal(result.protocol.counts.diagnosticFaults,0);assert.equal(result.protocol.counts.recoverAttempts,0);assert.equal(result.protocol.counts.keyframeRequests,0);
  // img.decode and the DOM marker are separate valid page transitions.
  // Every final update was checked with pixels(); intermediate successful
  // commits may contain different known cycles at the two observed points.
  let intermediateMarkerDifferences=0;for(const sample of result.samples){producers.add(sample.producer.split(':')[0]);const [image,dom,tag]=sample.pixels;for(const point of [image,dom]){assert.deepEqual(point.slice(2),[199,255]);const n=point[0]+256*point[1];assert.ok(n>=startCycle&&n<=cycle,'Pixel marker outside the actual issued cycle range');}if(image[0]!==dom[0]||image[1]!==dom[1])intermediateMarkerDifferences++;assert.deepEqual(tag,[ready.primary.number&255,ready.primary.number>>8,211,255]);}
  assert.equal(producers.size,1);const record={segment,startCycle,endCycle:cycle,intermediateMarkerDifferences,wallBeginMs:begin,wallEndMs:performance.now(),result};windows.push(record);await atomicJson(directory,'frame-age-windows.json',{at:new Date().toISOString(),runId:ready.runId,status:'windows-so-far',windows});
  assert.equal(await page.evaluate(()=>window.__remoteAgeLifetime),nonce);assert.deepEqual((await root.send('Target.getTargets')).targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId),initialWorker);
  if(segment<2){
   const before=await command('snapshot'),at=performance.now();
   if(segment===0){await command('resize',{target:'primary',sessionId:ready.primary.id,viewport:{width:720,height:480}});await page.waitForFunction(()=>document.querySelector('#viewport').width===720);}
   else{await command('navigate',{target:'primary',sessionId:ready.primary.id,cycle:++cycle});typed=0;}
   await pixels(page,cycle);const after=await command('snapshot');if(segment===0)assert.ok(after.primary.viewportVersion>before.primary.viewportVersion);else{assert.ok(after.primary.pageEpoch>before.primary.pageEpoch);assert.notEqual(after.primary.nativeDocumentToken,before.primary.nativeDocumentToken);assert.notEqual(after.primary.producer.split(':')[0],before.primary.producer.split(':')[0]);}
   transitions.push({kind:segment===0?'resize':'crosssite',atHostMs:at,doneHostMs:performance.now(),before:{epoch:before.primary.pageEpoch,viewportVersion:before.primary.viewportVersion,producer:before.primary.producer},after:{epoch:after.primary.pageEpoch,viewportVersion:after.primary.viewportVersion,producer:after.primary.producer}});
  }
 }
 assert.notEqual(windows[1].result.calibration.before.native.best.pid,windows[2].result.calibration.before.native.best.pid);
}catch(error){failure=error;await atomicJson(directory,'frame-age-failure.json',{at:new Date().toISOString(),error:error.stack,cycle,completedWindows:windows.length});}
finally{
 try{await browser?.close();}catch(e){cleanupErrors.push(e.stack);}
 try{await command('stop');for(let n=0;n<600&&!cleanup;n++){cleanup=await readFile(join(directory,'source-stopped.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});if(!cleanup)await delay(25);}assert.equal(cleanup?.status,'closed');assert.equal(cleanup.activeSessions,0);assert.equal(cleanup.stats.created,cleanup.stats.closed);assert.ok(cleanup.remainingProcesses.every(p=>p.kind==='node'));assert.deepEqual(cleanup.primary.nodeCalls,{map:0,publish:0,awaitPromise:0});}catch(e){cleanupErrors.push(e.stack);}
}
const report={at:new Date().toISOString(),runId:ready.runId,status:failure||cleanupErrors.length?'failed':'passed',scope:'Actual Linux Native Source to persistent Mac CPUWorker exact-commit pixel observer;real file-channel scheduler replies calibrated by complete Mac host request/response intervals,unchanged strict renderer/epoch/viewport checks. Three distinct windows exclude calibration and resize/crosssite transition gaps;not continuous all-frame longload/N1/8h/physical display latency.',elapsedSeconds:(performance.now()-started)/1000,cycles:cycle,windows,transitions,pageNonce:nonce,workerTargets:initialWorker,cleanup,cleanupErrors,error:failure?.stack};await atomicJson(directory,'frame-age-remote-report.json',report);console.log(JSON.stringify({status:report.status,windows:windows.length,samples:windows.reduce((n,w)=>n+w.result.samples.length,0),cleanupErrors:cleanupErrors.length}));if(report.status!=='passed')throw failure??new Error('Remote frame-age cleanup failed');
