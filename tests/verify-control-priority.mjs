import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {fakeSource,snapshot,payload} from './live-helpers.mjs';

const browser=await launchCaptureBrowser(),results=[];
try{
 for(const mainThread of [false,true]){
  const source=fakeSource();source.control={sessionId:'priority',attach(){},detach(){}};
  const live=await startLiveTransport(source,{port:0}),context=await browser.newContext();
  try{
   const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(mainThread?live.url.replace('/#','/?mainThread#'):live.url);
   try{await page.waitForFunction(()=>window.remotePaintResult?.frameId===1);}
   catch(error){throw new Error(JSON.stringify({mainThread,errors,body:await page.locator('body').innerText()}),{cause:error});}
   const delayChecks=()=>{const original=crypto.subtle.digest.bind(crypto.subtle);crypto.subtle.digest=async(...args)=>{await new Promise(resolve=>setTimeout(resolve,1200));return original(...args);};};
   if(mainThread)await page.evaluate(delayChecks);else await page.workers()[0].evaluate(delayChecks);
   source.publish(snapshot({captureId:'slow-checksum',resource:Buffer.concat([payload,Buffer.from('changed-valid-trailing-data')])}));
   await page.waitForTimeout(50);const started=performance.now();
   [...live.peers][0].send({type:'ControlState',mode:'handoff'});
   await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='正在交接',null,{timeout:600});
   const elapsed=performance.now()-started;assert.equal(await page.evaluate(()=>window.remotePaintResult.frameId),1,'Authority changes bypass unfinished resource validation');
   await page.waitForFunction(()=>window.remotePaintResult.frameId===2);assert.equal(await page.locator('#error').isHidden(),true);
   [...live.peers][0].send(null);await page.waitForFunction(()=>document.querySelector('#error').textContent==='Invalid metadata JSON object');
   results.push({mainThread,checksumDelayMs:1200,authorityDeliveryMs:elapsed,resourceFrameCompleted:true,invalidMetadataRejected:true});
  }finally{await context.close();await live.close();}
 }
 await mkdir('artifacts/network',{recursive:true});await writeFile('artifacts/network/control-priority.json',JSON.stringify({at:new Date().toISOString(),scope:'Real Viewer sockets and CanvasKit; test-injected asynchronous SHA delay, no packet loss; synchronous Wasm replay can still block its thread',results},null,2));console.log(results);
}finally{await browser.close();}
