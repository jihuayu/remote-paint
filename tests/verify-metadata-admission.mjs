import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {startLiveTransport} from '../live/transport.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {fakeSource} from './live-helpers.mjs';

const source=fakeSource();
let live,browser;
const variants=[];
try{
 live=await startLiveTransport(source,{port:0});browser=await launchCaptureBrowser();
 for(const mainThread of [false,true])for(const kind of ['scene-depth','control-depth','utf8-bytes','invalid-json']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(mainThread?live.url.replace('/#','/?mainThread#'):live.url);await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);
  const pixels=()=>page.evaluate(()=>{const c=document.createElement('canvas');c.width=c.height=1;const context=c.getContext('2d');context.drawImage(document.querySelector('#viewport'),10,10,1,1,0,0,1,1);return [...context.getImageData(0,0,1,1).data];});
  const before=await pixels(),peer=[...live.peers][0],closed=once(peer.ws,'close');
  const packet=kind==='invalid-json'?'{"privateFixture":"do-not-copy-to-error",}':kind==='utf8-bytes'?JSON.stringify({type:'SceneUpdate',unused:'中'.repeat(90000)}):`{"type":"${kind==='control-depth'?'FeedbackState':'SceneUpdate'}","unused":${'['.repeat(65)}0${']'.repeat(65)}}`;
  peer.ws.send(packet);const [code]=await closed;assert.equal(code,4008);
  await page.waitForFunction(()=>/metadata (nesting|wire bytes|JSON)/.test(document.querySelector('#error').textContent));
  await page.waitForFunction(()=>(window.remotePaintMemory?.categories.receive??0)===0);
  assert.deepEqual(await pixels(),before);assert.deepEqual(errors,[]);assert.ok(!(await page.locator('#error').textContent()).includes('do-not-copy-to-error'));
  variants.push({worker:!mainThread,kind,closeCode:code,previousPixelsPreserved:true,receiveReleased:true});await page.close();
 }
 const report={at:new Date().toISOString(),scope:'Actual Chrome Worker/main sockets with valid CanvasKit fixture baseline and adversarial SceneUpdate/control metadata; structural/UTF8 pre-parse refusal, close and receive cleanup. Node fixture transport, not source capture/performance.',variants,status:'passed'};
 await mkdir('artifacts/memory',{recursive:true});await writeFile('artifacts/memory/metadata-admission.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser?.close();await live?.close();}
