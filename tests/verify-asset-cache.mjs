import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {WebSocket,WebSocketServer} from 'ws';
import {createServer} from 'node:http';
import {NativeBroker} from '../native/broker.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {fakeSource,payload} from './live-helpers.mjs';

const broker=new NativeBroker(),source=fakeSource();source.broker=broker;
const rect=[0,0,960,640],captureId='cache-contract';
source.latest=await broker.map({captureId,producer:'cache-contract',resources:[{localId:1,width:960,height:640,quadScale:1,skp:payload.toString('base64')}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}},{epoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640,deviceScaleFactor:1}});
let live,browser;
try{
 live=await startLiveTransport(source,{port:0});browser=await launchCaptureBrowser();
 const configResponse=await fetch(`${live.origin}/session-config`),config=await configResponse.json();assert.equal(configResponse.headers.get('cache-control'),'no-store');
 const htmlResponse=await fetch(live.origin);assert.equal(htmlResponse.headers.get('cache-control'),'no-store');const html=await htmlResponse.text();assert.ok(html.includes(`/assets/${config.viewerBuild}/live.mjs`));
 const wasmUrl=`${live.origin}/assets/${config.viewerBuild}/vendor/canvaskit.wasm`;
 const wasm=await fetch(wasmUrl,{headers:{'accept-encoding':'identity'}});assert.match(wasm.headers.get('cache-control'),/immutable/);assert.equal(wasm.headers.get('content-type'),'application/wasm');
 const etag=wasm.headers.get('etag'),rawWasmBytes=Number(wasm.headers.get('content-length'));await wasm.arrayBuffer();const conditional=await fetch(wasmUrl,{headers:{'accept-encoding':'identity','if-none-match':etag}});assert.equal(conditional.status,304);
 const compressed=await fetch(wasmUrl,{headers:{'accept-encoding':'gzip'}});assert.equal(compressed.headers.get('content-encoding'),'gzip');const compressedBytes=Number(compressed.headers.get('content-length'));await compressed.arrayBuffer();
 assert.equal((await fetch(`${live.origin}/assets/${'0'.repeat(64)}/live.mjs`)).status,410);
 const mismatch=new WebSocket(`${live.streamOrigin.replace('http','ws')}/stream?key=${live.key}`,{origin:live.origin});await once(mismatch,'open');const closed=once(mismatch,'close');mismatch.send(JSON.stringify({type:'Hello',protocol:4,renderer:live.renderer,viewerBuild:'wrong-build'}));const mismatchClose=await closed;assert.equal(mismatchClose[0],1008);assert.match(mismatchClose[1].toString(),/Viewer build/i);
 const results=[];
 for(const mainThread of [false,true]){
  const context=await browser.newContext(),url=mainThread?live.url.replace('/#','/?mainThread#'):live.url;let page=await context.newPage();
  const measurements=[];
  for(let pass=0;pass<3;pass++){
   const previous=page,start=performance.now();if(pass===1)page=await context.newPage();if(pass<2)await page.goto(url);else await page.reload();await page.waitForFunction(()=>window.remotePaintResult?.frameId>0);if(pass===1)await previous.close();
   const resources=await page.evaluate(()=>performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,transferSize:e.transferSize,decodedBodySize:e.decodedBodySize})));
   const workerResources=page.workers().length?await page.workers()[0].evaluate(()=>performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,transferSize:e.transferSize,decodedBodySize:e.decodedBodySize}))):[];
   const startup=await page.evaluate(()=>window.remotePaintStartup);assert.ok(startup&&startup.wasmInitMs>=0&&startup.wasmVerifyMs>=0);
   measurements.push({pass,firstFrameMs:performance.now()-start,startup,resources,workerResources});
  }
  for(const measurement of measurements.slice(1)){
   const warm=[...measurement.resources,...measurement.workerResources].filter(e=>e.name.endsWith('canvaskit.wasm'));
   assert.ok(warm.length>0&&warm.every(e=>e.transferSize===0&&e.decodedBodySize>0),`Warm open/reload must reuse immutable Wasm: ${JSON.stringify({mainThread,measurement})}`);
  }
  const coldWasm=[...measurements[0].resources,...measurements[0].workerResources].filter(e=>e.name.endsWith('canvaskit.wasm'));
  assert.ok(coldWasm.reduce((bytes,e)=>bytes+e.transferSize,0)<compressedBytes*1.5+2000,'Preloading must not cause a second Wasm download');
  results.push({mainThread,measurements});await context.close();
 }
 for(const mainThread of [false,true]){
  const corrupt=await browser.newContext();await corrupt.route('**/canvaskit.wasm',route=>route.fulfill({body:Buffer.from('corrupt-cache'),contentType:'application/wasm'}));
  const page=await corrupt.newPage();await page.goto(mainThread?live.url.replace('/#','/?mainThread#'):live.url);await page.waitForFunction(()=>document.querySelector('#error').textContent==='Viewer Wasm integrity mismatch');assert.equal(await page.evaluate(()=>window.remotePaintResult??null),null);await corrupt.close();
 }
 const wrongBuild=await browser.newContext();await wrongBuild.addInitScript(()=>{const send=WebSocket.prototype.send;WebSocket.prototype.send=function(packet){const message=JSON.parse(packet);if(message.type==='Hello')message.viewerBuild='wrong-build';return send.call(this,JSON.stringify(message));};});const stale=await wrongBuild.newPage();await stale.goto(live.url.replace('/#','/?mainThread#'));await stale.waitForFunction(()=>/Viewer build/i.test(document.querySelector('#error').textContent));assert.equal(await stale.evaluate(()=>window.remotePaintResult??null),null);await wrongBuild.close();
 // Worker sockets need a real proxy: a Window WebSocket hook cannot reach
 // their realm. Keep the real handshake/close path for the stale-build probe.
 const proxy=createServer(),wss=new WebSocketServer({server:proxy}),sockets=new Set();await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 wss.on('connection',(client,request)=>{
  const upstream=new WebSocket(`${live.streamOrigin.replace('http','ws')}${request.url}`,{origin:live.origin});sockets.add(client);sockets.add(upstream);const queued=[];
  client.on('message',(bytes,binary)=>{let packet=bytes;if(!binary){const message=JSON.parse(bytes);if(message.type==='Hello'){message.viewerBuild='wrong-build';packet=JSON.stringify(message);}}if(upstream.readyState===1)upstream.send(packet,{binary});else queued.push([packet,binary]);});
  upstream.on('open',()=>{for(const [packet,binary]of queued)upstream.send(packet,{binary});queued.length=0;});
  upstream.on('message',(bytes,binary)=>{if(client.readyState===1)client.send(bytes,{binary});});
  upstream.on('close',(code,reason)=>{if(client.readyState===1)client.close(code===1006?1011:code,reason);});client.on('close',()=>upstream.terminate());upstream.on('error',()=>client.terminate());client.on('error',()=>upstream.terminate());
 });
 const workerWrong=await browser.newContext();
 try{await workerWrong.route('**/session-config',route=>route.fulfill({json:{nativePort:proxy.address().port}}));const page=await workerWrong.newPage();await page.goto(live.url);await page.waitForFunction(()=>/Viewer build/i.test(document.querySelector('#error').textContent));assert.equal(await page.evaluate(()=>window.remotePaintResult??null),null);}
 finally{await workerWrong.close();for(const socket of sockets)socket.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>proxy.close(resolve));}
 const report={at:new Date().toISOString(),scope:'Actual Chromium HTTP cache + CanvasKit Worker/main-thread fixture replay; native Rust build mismatch refusal; not source-browser performance or a repeated latency benchmark',viewerBuild:config.viewerBuild,immutableWasm:true,sessionConfigNoStore:true,entryHtmlNoStore:true,conditionalStatus:304,staleAssetStatus:410,buildMismatchClose:1008,buildMismatchVisibleInUi:true,corruptWasmRejectedBeforeExecution:true,rawWasmBytes,compressedWasmBytes:compressedBytes,results};
 await mkdir('artifacts/startup',{recursive:true});await writeFile('artifacts/startup/cache.json',JSON.stringify(report,null,2));console.log(report);
}finally{await browser?.close();await live?.close();await broker.close();}
