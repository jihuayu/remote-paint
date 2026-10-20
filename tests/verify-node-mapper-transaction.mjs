import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

assert.equal(process.platform,'linux');
const original=process.env.REMOTE_PAINT_DATA_PLANE;process.env.REMOTE_PAINT_DATA_PLANE='node';
const image=n=>{const png=new PNG({width:512,height:512});let value=17;for(let i=0;i<png.data.length;i+=4){value^=value<<13;value^=value>>>17;value^=value<<5;png.data.set([value&255,(value>>>8)&255,(value>>>16)&255,255],i);}png.data.set([n,37,199,255]);return PNG.sync.write(png);};
const fixture=createServer((request,response)=>{
 if(request.url.startsWith('/image')){response.setHeader('Content-Type','image/png');response.end(image(Number(new URL(request.url,'http://localhost').searchParams.get('n'))));return;}
 response.end('<!doctype html><meta charset="utf-8"><style>body{margin:0;font:24px sans-serif}img{position:absolute;top:60px;left:0}</style>Mapper transaction glyphs<img><script>window.update=async n=>{const img=document.querySelector("img");img.src="/image?n="+n;await img.decode();};window.loaded=update(0);</script>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let live,browser,progress;const errors=[],pageErrors=[];
const stats=mapper=>({bytes:mapper.resourceBytes,resources:mapper.resources.size,descriptors:mapper.resourceMemory.size,entries:[...mapper.entries],revision:mapper.revision,epoch:mapper.epoch});
const displayed=(page,n)=>page.waitForFunction(n=>{if(!window.remotePaintResult)return false;const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const context=canvas.getContext('2d');context.drawImage(document.querySelector('#viewport'),0,60,1,1,0,0,1,1);const bytes=context.getImageData(0,0,1,1).data;return bytes[0]===n&&bytes[1]===37&&bytes[2]===199;},n,{timeout:15000});
try{
 live=await startLive({url:`http://127.0.0.1:${fixture.address().port}`,port:0});const source=live.source;source.on('captureError',error=>errors.push(error.message));
 let complete;const sample=native=>{if(native.resources.length&&native.resources.every(r=>typeof r.skp==='string'))complete=native;};source.capture.on('capture',sample);
 browser=await launchCaptureBrowser();const page=await browser.newPage();page.on('pageerror',error=>pageErrors.push(error.message));const viewer=new URL(live.url);viewer.search='cpu';await page.goto(viewer.href);await displayed(page,0);assert.ok(complete);
 // Pause only the capture producer, keeping the genuine Source/transport and
 // Viewer alive. Faults enter the actual Source mapping listener explicitly.
 source.capture.setDemand(0);await source.capture.drain();source.capture.off('capture',sample);
 const before=stats(source.mapper),latest=source.latest,oldResources=new Map(source.mapper.resources);
 const picture=complete.viz.passes.flatMap(p=>p.quads).find(q=>q.kind==='picture'),record=complete.resources.find(r=>r.localId===picture.localId),raw=Buffer.from(record.skp,'base64');
 let rejectedBytes=0;
 for(let n=0;n<180;n++){
  const bytes=Buffer.concat([raw,Buffer.from([n&255,n>>8,23,41])]);rejectedBytes+=bytes.length;
  const resource={...record,skp:bytes.toString('base64'),resourceId:createHash('sha256').update(bytes).digest('hex')},quad=structuredClone(picture);
  const native={...complete,resources:[resource],viz:{...complete.viz,passes:[{id:'fault-root',output:[0,0,source.viewport.cssWidth,source.viewport.cssHeight],quads:[quad,{...quad,kind:'invalid'}]}]}};
  source.capture.emit('capture',native,0);assert.equal(errors.length,n+1);assert.equal(errors.at(-1),'Unknown Viz quad');assert.equal(source.latest,latest);assert.deepEqual(stats(source.mapper),before);
 }
 assert.ok(rejectedBytes>128*1024*1024,'Rejected native payload workload must exceed cache budget');
 const rootFault={...complete,viz:structuredClone(complete.viz)};rootFault.viz.passes.at(-1).output[2]--;
 source.capture.emit('capture',rootFault,0);assert.equal(errors.at(-1),'Root viewport mismatch');assert.equal(errors.length,181);assert.equal(source.latest,latest);assert.deepEqual(stats(source.mapper),before);
 for(const [id,bytes]of oldResources)assert.equal(source.mapper.resources.get(id),bytes);
 progress={before,rejectedCaptures:181,rejectedBytes,afterRejected:stats(source.mapper)};
 source.capture.setDemand(source.demand);await source.page.evaluate(()=>window.update(1));source.requestCapture();await displayed(page,1);
 assert.deepEqual(pageErrors,[]);assert.equal(errors.length,181);assert.equal(source.stats.lastError,null);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux native Node-data-plane Source → CPU CanvasKit Worker. A paused producer lets181 explicit invalid captures enter the real Source listener, using actual native SKP bytes with unique trailing nonces. More than128MiB cumulative rejected payloads leave the committed cache/entries/epoch/revisions and exact Buffer identities unchanged. Wrong viewport rejects before commit; genuine native capture resumes and image pixels recover. Injected failure events are counted exactly, not removed from Source diagnostics. This does not exercise Rust native resource ingestion or prove full physical memory budgets.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),...progress,recovered:stats(source.mapper),expectedCaptureErrors:errors.length,unexpectedCaptureErrors:errors.slice(181),pageErrors};
 await mkdir('artifacts/node-mapper-transaction',{recursive:true});await writeFile('artifacts/node-mapper-transaction/rollback.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/node-mapper-transaction',{recursive:true});await writeFile('artifacts/node-mapper-transaction/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,errors,pageErrors},null,2));throw error;}
finally{if(original===undefined)delete process.env.REMOTE_PAINT_DATA_PLANE;else process.env.REMOTE_PAINT_DATA_PLANE=original;await browser?.close();await live?.close();await new Promise(resolve=>fixture.close(resolve));}
