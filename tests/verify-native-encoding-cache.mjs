import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

assert.equal(process.platform,'linux');
const side=512,image=n=>{const png=new PNG({width:side,height:side});let state=n+1;for(let i=0;i<png.data.length;i+=4){state^=state<<13;state^=state>>>17;state^=state<<5;png.data[i]=state&255;png.data[i+1]=(state>>>8)&255;png.data[i+2]=(state>>>16)&255;png.data[i+3]=255;}png.data.set([n&255,(n>>8)&255,199,255]);return PNG.sync.write(png,{deflateLevel:1,filterType:0});};
const fixture=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 if(url.pathname==='/image'){response.setHeader('Content-Type','image/png');response.end(image(Number(url.searchParams.get('n'))));return;}
 response.end(`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white;font:24px sans-serif}img{position:absolute;left:0;top:60px;width:${side}px;height:${side}px}</style>Stable encoding cache glyphs<img><script>window.update=async n=>{const img=document.querySelector('img');img.src='/image?n='+n;await img.decode();};window.loaded=update(0);</script>`);
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const original=process.env.REMOTE_PAINT_DATA_PLANE,variants=[];let live,browser,progress;
const displayed=(page,n)=>page.waitForFunction(n=>{const source=document.querySelector('#viewport');if(!window.remotePaintResult)return false;const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.drawImage(source,0,60,1,1,0,0,1,1);const data=ctx.getImageData(0,0,1,1).data;return data[0]===(n&255)&&data[1]===((n>>8)&255)&&data[2]===199;},n,{timeout:15000});
try{
 for(const dataPlane of ['rust','node']){
  if(dataPlane==='node')process.env.REMOTE_PAINT_DATA_PLANE='node';else delete process.env.REMOTE_PAINT_DATA_PLANE;
  const samples=[],errors=[];
  progress={dataPlane,samples,errors};
  live=await startLive({url:`http://127.0.0.1:${fixture.address().port}`,port:0});
  live.source.on('captureError',error=>errors.push(error.message));
  live.source.capture.on('capture',native=>{const cache=native.timing?.captureHosts;if(cache)samples.push({...cache,frameBytes:native.resources.reduce((n,r)=>n+(r.skp?Buffer.byteLength(r.skp,'base64'):0),0)});});
  await live.source.page.waitForFunction(()=>typeof window.update==='function');await live.source.page.evaluate(()=>window.loaded);
  browser=await launchCaptureBrowser();const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
  const url=new URL(live.url);url.search='cpu';await page.goto(url.href);await displayed(page,0);
  for(let n=1;n<=80;n++){await live.source.page.evaluate(n=>window.update(n),n);live.source.requestCapture();await displayed(page,n);}
  assert.deepEqual(errors,[]);assert.ok(samples.length>=80);
  for(const sample of samples){
   assert.equal(sample.scope,'renderer-process');assert.equal(sample.byteLimit,64*1024*1024);
   assert.ok(sample.cacheBytes<=sample.residentBytes&&sample.residentBytes<=sample.byteLimit);
   assert.equal(sample.retiredPinBytes,sample.residentBytes-sample.cacheBytes);
   assert.ok(sample.cachedPinBytes<=sample.cacheBytes&&sample.peakResidentBytes<=sample.byteLimit);
   assert.ok(sample.encodings<=sample.entryLimit);assert.equal(sample.sharedInputBypasses,0);
  }
  const last=samples.at(-1);assert.ok(last.admissions>80);assert.ok(last.evictions>0,'Workload must cause real native byte eviction');
  // With this working set, byte pressure precedes the old per-host count cap.
  assert.ok(Math.max(...samples.map(s=>s.encodings))<256);
  variants.push({dataPlane,updates:80,samples:samples.length,first:samples[0],last,maximum:{cacheBytes:Math.max(...samples.map(s=>s.cacheBytes)),residentBytes:Math.max(...samples.map(s=>s.residentBytes)),retiredPinBytes:Math.max(...samples.map(s=>s.retiredPinBytes)),cachedPinBytes:Math.max(...samples.map(s=>s.cachedPinBytes)),encodings:Math.max(...samples.map(s=>s.encodings))},errors,sourceResourceRecoveries:live.source.stats.resourceRecoveries});
  await browser.close();browser=null;await live.close();live=null;
 }
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux native Chromium → Rust tiled data plane and Node full-layer/Base64 data plane → CPU CanvasKit Worker. 80 noisy 512² image replacements per path with actual pixels; global per-renderer encoding admission and returned-alias charges stay within64MiB and byte eviction happens before256 entries. Does not bound uncached encoding/IPC work, recording/RasterSource memory, host namespace metadata or total Session/process memory.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),variants};
 await mkdir('artifacts/encoding-cache',{recursive:true});await writeFile('artifacts/encoding-cache/byte-budget.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){
 await mkdir('artifacts/encoding-cache',{recursive:true});await writeFile('artifacts/encoding-cache/byte-budget-failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),variants,progress},null,2));throw error;
}finally{if(original===undefined)delete process.env.REMOTE_PAINT_DATA_PLANE;else process.env.REMOTE_PAINT_DATA_PLANE=original;await browser?.close();await live?.close();await new Promise(resolve=>fixture.close(resolve));}
