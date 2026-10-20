import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startLive} from '../live.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';

async function frameMemory(live,mode){
 const ws=new WebSocket(`${live.streamOrigin.replace('http','ws')}/stream?key=${live.key}`,{origin:live.origin}),manifests=new Map();let current;
 try{
  await once(ws,'open');return await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(new Error('No complete native memory contract with both image and font estimates')),15000);
   const fail=error=>{clearTimeout(timer);reject(error);};ws.on('error',fail);
   ws.on('message',(data,binary)=>{if(binary)return;try{
    const message=JSON.parse(data);if(message.type==='ResourceManifest')manifests.set(message.id,message.decodeMemory);
    if(message.type==='SceneUpdate')current=message.frame;
    if(message.type==='FrameCommit'){
     ws.send(JSON.stringify({type:'FrameAck',pageEpoch:message.pageEpoch,frameId:message.frameId}));
     const memory=current?.resourceMemory;assert.equal(memory?.version,1);assert.deepEqual(Object.keys(memory.resources).sort(),current.requiredResources.slice().sort());
     let images=0,fonts=0;for(const [id,bound]of Object.entries(memory.resources)){assert.ok(Number.isSafeInteger(bound.imageBytes)&&bound.imageBytes>=0);assert.ok(Number.isSafeInteger(bound.fontBytes)&&bound.fontBytes>=0);if(mode==='native')assert.deepEqual(manifests.get(id),bound);images+=bound.imageBytes;fonts+=bound.fontBytes;}
     if(images>0&&fonts>0){clearTimeout(timer);resolve({resources:current.requiredResources.length,imageEstimateBytes:images,fontEstimateBytes:fonts,manifestMatchesFrame:mode==='native'?true:null,complete:true});}
    }
   }catch(error){fail(error);}});
   ws.send(JSON.stringify({type:'Hello',protocol:4,renderer:live.renderer,capabilities:['asset-chunks-v1']}));
  });
 }finally{ws.terminate();}
}
let browser,live;const original=process.env.REMOTE_PAINT_DATA_PLANE,report={at:new Date().toISOString(),scope:'Actual staged custom Chromium capture → Rust/Node data plane → complete per-resource decode estimates and CanvasKit first frame; complete resource negotiation and protected Viewer first frame; oversized-allocation refusal covered by separate unit/large-image probes',variants:[]};
try{
 browser=await launchCaptureBrowser();for(const mode of ['native','node']){
  process.env.REMOTE_PAINT_DATA_PLANE=mode;live=await startLive({port:0});const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(live.url);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);
  await live.source.page.waitForFunction(()=>document.querySelector('#private-image').complete&&document.querySelector('#private-image').naturalWidth>0&&document.querySelector('#blob-image').naturalWidth>0);
  const memory=await frameMemory(live,mode);assert.deepEqual(errors,[]);assert.equal(live.source.stats.errors,0);assert.equal(await page.evaluate(()=>window.remotePaintMemory.decodeAdmission),'complete-resource-index-v1');report.variants.push({mode,...memory,sourceErrors:live.source.stats.errors,viewerFirstFrame:true,viewerAdmissionNegotiated:true});await page.close();await live.close();live=null;
 }
 report.status='passed';await mkdir('artifacts/memory',{recursive:true});await writeFile('artifacts/memory/resource-contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{if(original===undefined)delete process.env.REMOTE_PAINT_DATA_PLANE;else process.env.REMOTE_PAINT_DATA_PLANE=original;await browser?.close();await live?.close();}
