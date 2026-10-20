import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';

const executablePath=process.env.REMOTE_PAINT_CHROMIUM;
assert.ok(executablePath,'Set REMOTE_PAINT_CHROMIUM to the compiled native browser');
const output=process.env.REMOTE_PAINT_WEBGL_OUTPUT??'artifacts/webgl',gpu=process.env.REMOTE_PAINT_FORCE_GPU==='1';
await mkdir(output,{recursive:true});
const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0;background:white}#webgl{display:block}#normal{position:absolute;left:400px;top:160px}#dom{position:absolute;left:400px;top:20px;width:150px;height:100px;background:#123456}</style><canvas id="webgl" width="320" height="240"></canvas><canvas id="normal" width="64" height="64"></canvas><div id="dom">普通 DOM</div><script>
window.mountWebGL=()=>{let c=document.querySelector('#webgl');if(!c){c=document.createElement('canvas');c.id='webgl';c.width=320;c.height=240;document.body.prepend(c);}const gl=c.getContext('webgl2',{preserveDrawingBuffer:true});window.hasWebGL=!!gl;if(gl){gl.clearColor(.1,.75,.25,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.finish();}};
window.paintNormal=color=>{const ctx=document.querySelector('#normal').getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,64,64);};mountWebGL();paintNormal('rgb(31,79,191)');
</script>`;
const fixture=createServer((req,res)=>res.end(html));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let live,browser,phase='startup',failure,sourceStats,result;
const errors=[],checks=[],labelChecks=[],nativeFrames=[],nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0};
const pixel=(png,x,y)=>[...png.data.subarray((y*png.width+x)*4,(y*png.width+x)*4+4)];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
 live=await startLive({url:`http://127.0.0.1:${fixture.address().port}`,port:0});
 assert.equal(live.source.nativeAutopublish,true);
 live.source.on('captureError',error=>errors.push(error.message));
 const request=live.source.broker.request.bind(live.source.broker);live.source.broker.request=(op,args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,args);};
 const send=live.source.capture.cdp.send.bind(live.source.capture.cdp);live.source.capture.cdp.send=(op,args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,args);};
 live.source.on('frame',frame=>{nativeFrames.push({phase,...frame});assert.ok(nativeFrames.length<128);});
 assert.equal(await live.source.page.evaluate(()=>window.hasWebGL),true);
 browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 const viewerUrl=new URL(live.url);viewerUrl.searchParams.set(gpu?'gpu':'cpu','');await page.goto(viewerUrl.href);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);
 const snapshot=async()=>PNG.sync.read(Buffer.from((await page.locator('canvas').evaluate(c=>c.toDataURL())).split(',')[1],'base64'));
 const waitPixels=async points=>page.waitForFunction(points=>{
  const canvas=document.querySelector('canvas'),sample=document.createElement('canvas');sample.width=sample.height=1;const ctx=sample.getContext('2d');
  return points.every(({x,y,rgba})=>{ctx.clearRect(0,0,1,1);ctx.drawImage(canvas,x,y,1,1,0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].every((n,i)=>n===rgba[i]);});
 },points).then(handle=>handle.dispose());
 // Independent expected text, rendered with the same client's system fonts.
 // Permit a one-pixel raster/filter edge difference in either direction.
 const reference=PNG.sync.read(Buffer.from((await page.evaluate(()=>{
  const label=new OffscreenCanvas(384,56),ctx=label.getContext('2d');ctx.font='32px sans-serif';ctx.fillStyle='white';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('WebGL 无法显示',192,28);
  const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;const out=canvas.getContext('2d');out.fillStyle='black';out.fillRect(0,0,320,240);out.drawImage(label,64,106,192,28);return canvas.toDataURL();
 })).split(',')[1],'base64'));
 const label=png=>{
  const bright=(image,x,y)=>{const p=pixel(image,x,y);return p[0]>150&&p[1]>150&&p[2]>150;};
  const nearby=(image,x,y)=>{for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(bright(image,x+dx,y+dy))return true;return false;};
  let expected=0,actual=0,expectedMatched=0,actualMatched=0;
  for(let y=104;y<136;y++)for(let x=50;x<270;x++){
   if(bright(reference,x,y)){expected++;if(nearby(png,x,y))expectedMatched++;}
   if(bright(png,x,y)){actual++;if(nearby(reference,x,y))actualMatched++;}
  }
  const result={text:'WebGL 无法显示',expected,actual,recall:expectedMatched/expected,precision:actualMatched/actual};
  assert.ok(actual>40&&expected>40);assert.ok(result.recall>.95&&result.precision>.95,`WebGL label pixel mismatch ${JSON.stringify(result)}`);labelChecks.push({phase,...result});return result;
 };
 phase='initial';const before=await snapshot();
 assert.deepEqual(pixel(before,20,20),[0,0,0,255]);assert.deepEqual(pixel(before,500,100),[18,52,86,255]);assert.deepEqual(pixel(before,420,180),[31,79,191,255]);label(before);
 const sourceImage=PNG.sync.read(await live.source.page.screenshot());assert.ok(pixel(sourceImage,20,20)[1]>150&&pixel(sourceImage,20,20)[0]<60,'Source WebGL must really draw its green surface');
 checks.push('real green source WebGL becomes a black Viewer rectangle with the exact expected WebGL 无法显示 glyph pixels; normal DOM and blue Canvas2D remain correct');
 await writeFile(output+'/placeholder.png',PNG.sync.write(before));
 phase='update';await live.source.page.evaluate(()=>{document.querySelector('#dom').style.background='#aa3333';document.querySelector('#dom').textContent='其他内容继续更新';paintNormal('rgb(43,161,89)');});live.source.requestCapture();
 await waitPixels([{x:500,y:100,rgba:[170,51,51,255]},{x:420,y:180,rgba:[43,161,89,255]}]);
 const updated=await snapshot();assert.deepEqual(pixel(updated,20,20),[0,0,0,255]);label(updated);checks.push('ordinary DOM and Canvas2D both update to real new pixels while the WebGL black label remains');await writeFile(output+'/updated.png',PNG.sync.write(updated));
 phase='removed';await live.source.page.locator('#webgl').evaluate(e=>e.remove());live.source.requestCapture();
 await waitPixels([{x:20,y:20,rgba:[255,255,255,255]},{x:500,y:100,rgba:[170,51,51,255]},{x:420,y:180,rgba:[43,161,89,255]}]);const removed=await snapshot();await writeFile(output+'/removed.png',PNG.sync.write(removed));checks.push('removing the WebGL canvas restores the white page at its old rectangle and preserves updated DOM/Canvas2D');
 phase='restored';assert.equal(await live.source.page.evaluate(()=>{mountWebGL();return hasWebGL;}),true);live.source.requestCapture();
 await waitPixels([{x:20,y:20,rgba:[0,0,0,255]},{x:500,y:100,rgba:[170,51,51,255]},{x:420,y:180,rgba:[43,161,89,255]}]);const restored=await snapshot();label(restored);await writeFile(output+'/restored.png',PNG.sync.write(restored));
 result=await page.evaluate(()=>window.remotePaintResult);assert.equal(result.worker,true);if(gpu){assert.equal(result.presentation.mode,'webgl2-bitmap');assert.ok(result.presentation.gpuFrames>0);}else{assert.ok(result.presentation.mode.startsWith('cpu-'));assert.equal(result.presentation.gpuFrames,0);assert.ok(result.presentation.cpuFrames>0);}
 assert.equal(live.source.pageEpoch,1);assert.equal(live.source.stats.resourceRecoveries,0);assert.equal(live.source.stats.errors,0);assert.deepEqual(errors,[]);assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});assert.equal(Object.hasOwn(live.source.latest,'scene'),false);assert.equal(Object.hasOwn(live.source.latest,'payloads'),false);
 sourceStats={...live.source.stats};checks.push('re-added real WebGL restores the black exact-text label; actual Worker presentation mode is verified and native Source uses no per-frame map/publish/awaitPromise');
}catch(error){failure=error.stack;sourceStats=live?.source.stats;}
finally{await browser?.close().catch(()=>{});await live?.close().catch(()=>{});await new Promise(resolve=>fixture.close(resolve));}
const cleanup={brokerExited:live?.source.broker.exited,pending:live?.source.broker.pending.size,requestOwners:live?.source.broker.requestMemory.stats().owners,responseOwners:live?.source.broker.responses.stats().owners};
if(!failure)try{assert.deepEqual(cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0});}catch(error){failure=error.stack;}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual default autonomous NativeSource/custom Linux Chromium/native Rust Gateway/CanvasKit Worker pixels. Real WebGL2 green source is rendered as black with expected WebGL 无法显示 glyph pixels; DOM and Canvas2D updates plus WebGL removal/re-addition. Viewer CPU or forced SwiftShader WebGL2 is stated from actual presentation; no physical GPU/full B1/process-memory claim.',browserSha256:hash(await readFile(executablePath)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),requestedViewerMode:gpu?'gpu':'cpu',phase,checks,labelChecks,nodeCalls,nativeFrames,sourceStats,result,errors,cleanup,...(failure?{error:failure}:{})};
await writeFile(output+'/placeholder-live.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,labelChecks,requestedViewerMode:report.requestedViewerMode,presentation:result?.presentation,nodeCalls,cleanup,error:failure}));if(failure)throw new Error(failure);
