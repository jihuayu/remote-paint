import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';
import {once} from 'node:events';
// A real TCP/WebSocket proxy works for both Worker and main-thread clients;
// Playwright's page.routeWebSocket does not intercept Worker-owned sockets.
export async function recoverDroppedResource(browser,transport){
 const server=createServer(),wss=new WebSocketServer({server}),connections=new Set();let dropped=0,keyframeRequests=0;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 wss.on('connection',client=>{
  connections.add(client);
  const upstream=new WebSocket(`${(transport.streamOrigin??transport.origin).replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});connections.add(upstream);
  const queued=[];client.on('message',(bytes,binary)=>{if(!binary&&JSON.parse(bytes).type==='RequestKeyframe')keyframeRequests++;if(upstream.readyState===1)upstream.send(bytes,{binary});else queued.push([bytes,binary]);});
  upstream.on('open',()=>{for(const [bytes,binary]of queued)upstream.send(bytes,{binary});queued.length=0;});
  upstream.on('message',(bytes,binary)=>{if(binary&&!dropped){dropped++;return;}if(client.readyState===1)client.send(bytes,{binary});});
  upstream.on('close',(code,reason)=>{if(client.readyState===1)client.close(code===1006?1011:code,reason);});client.on('close',()=>{upstream.terminate();connections.delete(client);connections.delete(upstream);});upstream.on('error',()=>client.terminate());client.on('error',()=>upstream.terminate());
 });
 const context=await browser.newContext(),page=await context.newPage(),errors=[],requests=[];
 await context.route('**/session-config',route=>route.fulfill({json:{nativePort:server.address().port}}));
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(new URL(request.url()).origin));
 try{
  await page.goto(transport.url);await page.waitForFunction(()=>document.body.dataset.ready==='true'&&window.remotePaintResult?.frameId>=2,null,{timeout:30000});
  const recovered=await page.evaluate(()=>window.remotePaintResult);assert.equal(dropped,1);assert.equal(keyframeRequests,1);assert.equal(recovered.fullFrames,1);assert.equal(recovered.resources,recovered.requiredResources.length);assert.ok(requests.every(origin=>origin===transport.origin));assert.deepEqual(errors,[]);
  return {droppedResources:dropped,keyframeRequests,recovered,viewerSourceRequests:0,errors};
 }finally{await context.close();for(const socket of connections)socket.terminate();await new Promise(resolve=>wss.close(resolve));await new Promise(resolve=>server.close(resolve));}
}
