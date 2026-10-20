import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

const side=3072,png=new PNG({width:side,height:side});png.data.fill(Buffer.from([51,102,153,255]));const encoded=PNG.sync.write(png);
const html='<!doctype html><style>body{margin:0;background:white;font:16px sans-serif}#safe{position:absolute;left:200px;top:20px;width:32px;height:32px;background:#00aa55}#large{position:absolute;left:12px;top:60px;width:96px;height:96px;display:none}</style><p>Safe previous frame</p><div id="safe"></div><img id="large">';
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/large.png'?'image/png':'text/html');res.end(req.url==='/large.png'?encoded:html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
let live,browser;const report={at:new Date().toISOString(),scope:'Actual staged Chromium PNG capture + native memory descriptor + CPU CanvasKit Worker/main;3072² highly compressed image, compact admission rejection and standard transient replay; not GPU driver peak or physical display measurement',image:{width:side,height:side,encodedBytes:encoded.length,rgbaF16Estimate:side*side*8},variants:[]};
const pixel=async(page,x,y)=>page.evaluate(({x,y})=>{const c=document.createElement('canvas');c.width=c.height=1;const context=c.getContext('2d');context.drawImage(document.querySelector('#viewport'),x,y,1,1,0,0,1,1);return [...context.getImageData(0,0,1,1).data];},{x,y});
try{
 browser=await launchCaptureBrowser();for(const main of [false,true]){
  live=await startLive({url:`http://127.0.0.1:${server.address().port}`,port:0});const context=await browser.newContext({viewport:{width:1100,height:900}}),compact=await context.newPage(),errors=[];compact.on('pageerror',e=>errors.push(e.message));const url=new URL(live.url);url.search=`cpu&memory=compact${main?'&mainThread':''}`;await compact.goto(url.href);await compact.waitForFunction(()=>window.remotePaintResult?.frameId>0);
  assert.deepEqual(await pixel(compact,210,30),[0,170,85,255]);const previous=await compact.evaluate(()=>window.remotePaintResult.frameId);
  await live.source.page.evaluate(()=>{const image=document.querySelector('#large');image.src='/large.png';image.style.display='block';});
  await compact.waitForFunction(()=>!document.querySelector('#error').hidden&&document.querySelector('#error').textContent.includes('picture decode headroom'),null,{timeout:30000});
  const contract=live.source.latest.resourceMemory;assert.ok(contract);assert.ok(Object.values(contract.resources).some(r=>r.imageBytes>=3072*3072*8));
  assert.deepEqual(await pixel(compact,210,30),[0,170,85,255],'Rejected frame must preserve the previously visible safe region');
  const compactMemory=await compact.evaluate(()=>window.remotePaintMemory);assert.equal(compactMemory.decodeAdmission,'complete-resource-index-v1');assert.ok(compactMemory.observed.wasmHeapBytes<=compactMemory.limits.wasm);await compact.close();
  const standard=await context.newPage();standard.on('pageerror',e=>errors.push(e.message));url.search=`cpu&memory=standard${main?'&mainThread':''}`;await standard.goto(url.href);await standard.waitForFunction(()=>window.remotePaintResult?.frameId>0,null,{timeout:30000});assert.deepEqual(await pixel(standard,30,80),[51,102,153,255]);assert.deepEqual(await pixel(standard,210,30),[0,170,85,255]);
  const standardMemory=await standard.evaluate(()=>window.remotePaintMemory);assert.equal(standardMemory.decodeAdmission,'complete-resource-index-v1');assert.ok(standardMemory.observed.wasmHeapBytes<=standardMemory.limits.wasm);assert.equal(standardMemory.categories.pictureTransient??0,0);assert.equal(standardMemory.categories.pictureDecode??0,0);assert.deepEqual(errors,[]);assert.equal(live.source.stats.errors,0);
  report.variants.push({worker:!main,compactRejectedBeforeVisibleCommit:true,previousFrame:previous,previousPixelsPreserved:true,compactWasmBytes:compactMemory.observed.wasmHeapBytes,standardReplayedLargeImage:true,standardWasmBytes:standardMemory.observed.wasmHeapBytes,transientOwnersReleased:true,sourceErrors:live.source.stats.errors});await context.close();await live.close();live=null;
 }
 report.status='passed';await mkdir('artifacts/memory',{recursive:true});await writeFile('artifacts/memory/decode-admission.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await browser?.close();await live?.close();await new Promise(r=>server.close(r));}
