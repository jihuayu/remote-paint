import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {NativeBroker} from '../native/broker.mjs';
import {ControlLease} from '../live/input.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {fakeSource,payload} from './live-helpers.mjs';

const broker=new NativeBroker(),source=fakeSource();
Object.assign(source,{broker,pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640,deviceScaleFactor:1},inputSeq:0,page:{evaluate:async()=>null}});
source.control=new ControlLease(source,{send:async()=>{}});
const rect=[0,0,960,640],captureId='worker-control';
source.latest=await broker.map({captureId,producer:'worker-control-contract',resources:[{localId:1,width:960,height:640,quadScale:1,skp:payload.toString('base64')}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}},{epoch:1,viewportVersion:1,viewport:source.viewport});
let live,browser;
try{
 live=await startLiveTransport(source,{port:0});browser=await launchCaptureBrowser();const page=await browser.newPage();
 await page.addInitScript(()=>{const Original=Worker;window.Worker=class extends Original {constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.type==='test-busy')window.paintWorkerBusy=true;});}};const Socket=WebSocket;window.WebSocket=class extends Socket {constructor(...args){super(...args);this.addEventListener('message',({data})=>{const message=JSON.parse(data);if(message.type==='InputAck'&&message.accepted)window.ackedInput=message.seq;});}};});
 await page.goto(live.url);await page.waitForFunction(()=>window.remotePaintResult?.worker&&window.remotePaintResult.frameId===1);
 await page.locator('#control').click();await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='你正在操作');
 const busy=page.workers()[0].evaluate(()=>{postMessage({type:'test-busy'});const started=performance.now();while(performance.now()-started<1200){};});
 await page.waitForFunction(()=>window.paintWorkerBusy===true);const inputStarted=performance.now();
 await page.locator('#inputProxy').evaluate(proxy=>proxy.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'x',bubbles:true,cancelable:true})));
 await page.waitForFunction(()=>window.ackedInput===1,null,{timeout:500});const inputAckMs=performance.now()-inputStarted;
 assert.equal(source.inputSeq,1);const started=performance.now();
 await source.control.revoke('worker-stall-probe');await page.waitForFunction(()=>document.querySelector('#controlState').textContent==='Agent 控制',null,{timeout:500});
 const revokedMs=performance.now()-started;assert.equal(source.control.mode,'agent');await busy;
 const report={at:new Date().toISOString(),scope:'Native Rust paired control/data WebSockets and real CanvasKit Worker, fixture capture/fake CDP; injected synchronous Worker stall represents its event-loop blockage, not measured Wasm execution',workerStallMs:1200,inputAckMs,revokedMs,controlOnUiThread:true,leaseRevokedBeforeWorkerResumed:revokedMs<500&&inputAckMs<500};
 await mkdir('artifacts/network',{recursive:true});await writeFile('artifacts/network/worker-control.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser?.close();await live?.close();await source.control.close();await broker.close();}
