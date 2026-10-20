import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

assert.equal(process.platform,'linux');
const image=n=>{const png=new PNG({width:256,height:256});let state=n+1;for(let i=0;i<png.data.length;i+=4){state^=state<<13;state^=state>>>17;state^=state<<5;png.data[i]=state&255;png.data[i+1]=(state>>>8)&255;png.data[i+2]=(state>>>16)&255;png.data[i+3]=255;}png.data.set([n&255,(n>>8)&255,199,255]);return PNG.sync.write(png,{deflateLevel:1,filterType:0});};
const fixture=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost'),n=Number(url.searchParams.get('n')??0);
 if(url.pathname==='/image'){response.setHeader('Content-Type','image/png');response.end(image(n));return;}
 response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font:24px sans-serif}img{position:absolute;left:0;top:60px;width:256px;height:256px}</style>Host lifecycle ${n}<img src="/image?n=${n}"><script>window.loaded=document.querySelector('img').decode();</script>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${fixture.address().port}`,samples=[],errors=[],invalidations=[],perProcess=new Map();let live,browser,phase='startup',loopEndSample,settled,retirementWaitMs=0;
const displayed=async(page,n)=>page.waitForFunction(n=>{const source=document.querySelector('#viewport');if(!window.remotePaintResult)return false;const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(source,0,60,1,1,0,0,1,1);const data=ctx.getImageData(0,0,1,1).data;return data[0]===(n&255)&&data[1]===((n>>8)&255)&&data[2]===199;},n,{timeout:15000});
try{
 live=await startLive({url:origin,port:0});
 live.source.on('captureError',error=>{const item={phase,message:error.message,code:error.code??null};if(phase==='navigation'&&/Navigation invalidated|Execution context was destroyed|Cannot find context|Inspected target navigated or closed/.test(error.message))invalidations.push(item);else errors.push(item);});
 live.source.capture.on('capture',native=>{
  const state=native.timing?.captureHosts;if(!state)return;
  const sample={producer:native.producer,frameToken:native.frameToken,...state};samples.push(sample);perProcess.set(native.producer.split(':')[0],sample);
 });
 await live.source.page.waitForFunction(()=>typeof window.loaded?.then==='function');await live.source.page.evaluate(()=>window.loaded);
 browser=await launchCaptureBrowser();const page=await browser.newPage();page.on('pageerror',error=>errors.push({phase,message:error.message}));
 const url=new URL(live.url);url.search='cpu';await page.goto(url.href);await displayed(page,0);
 for(let n=1;n<=200;n++){
  phase='navigation';await live.source.page.goto(`${origin}/?n=${n}`,{waitUntil:'domcontentloaded'});await live.source.page.evaluate(()=>window.loaded);live.source.requestCapture();await displayed(page,n);phase='stable';
 }
 loopEndSample=samples.at(-1);const retirementStarted=Date.now(),settleDeadline=retirementStarted+5000;
 while(samples.at(-1)?.hosts>1&&Date.now()<settleDeadline){
  await new Promise((resolve,reject)=>{const captured=()=>{clearTimeout(timer);resolve();},timer=setTimeout(()=>{live.source.capture.off('capture',captured);reject(new Error('Host retirement observation timed out'));},1000);live.source.capture.once('capture',captured);live.source.requestCapture();});
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 settled=samples.at(-1);
 retirementWaitMs=Date.now()-retirementStarted;
 assert.deepEqual(errors,[]);assert.ok(samples.length>=200,'Capture ownership telemetry must accompany native frames');
 // A displayed new document does not mean Chrome has destroyed the old
 // compositor yet. Require exactly the current owner after those callbacks;
 // retain the transient peak rather than mislabeling live hosts as leaked.
 assert.equal(settled.hosts,1,'Destroyed compositor hosts retained cache ownership');
 assert.equal(settled.ownersAlive,1,'Retired snapshot identities failed to drain');
 assert.equal(settled.markerHosts,1,'Destroyed hosts retained capture markers');
 assert.ok(samples.every(s=>s.markerHosts<=4));
 assert.ok(samples.every(s=>s.created-s.released===s.hosts));
 const source=live.source;await page.close();
 const detachedDeadline=Date.now()+5000;while(source.demand&&Date.now()<detachedDeadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(source.demand,0);
 await source.capture.drain();await source.frameDriver.stop();
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual custom Linux Chromium/Rust → CPU CanvasKit Worker: 200 navigations with noisy image pixel confirmation, exact single-owner state after real deferred compositor destruction. Compositor destruction calls are independently verified from opt-in native trace. The transient peak is reported, not treated as already-destroyed ownership. This checkpoint does not certify complete byte budgets, allocator/driver RSS return or BFCache.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),navigations:200,captureSamples:samples.length,rendererProcesses:perProcess.size,maximum:{hosts:Math.max(...samples.map(s=>s.hosts)),encodings:Math.max(...samples.map(s=>s.encodings)),ownersAlive:Math.max(...samples.map(s=>s.ownersAlive)),damageEntries:Math.max(...samples.map(s=>s.damageEntries))},deferredDestruction:{loopEndSample,settled,retirementWaitMs},observedReleasedInSurvivingRenderers:[...perProcess.values()].reduce((sum,s)=>sum+s.released,0),last:samples.at(-1),expectedNavigationInvalidations:invalidations,errors};
 await mkdir('artifacts/host-lifecycle',{recursive:true});await writeFile('artifacts/host-lifecycle/navigation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 await mkdir('artifacts/host-lifecycle',{recursive:true});await writeFile('artifacts/host-lifecycle/navigation-failure.json',JSON.stringify({at:new Date().toISOString(),error:error.stack,phase,loopEndSample,settled,samples,invalidations,errors,stats:live?.source.stats},null,2));throw error;
}finally{await browser?.close();await live?.close();await new Promise(resolve=>fixture.close(resolve));}
