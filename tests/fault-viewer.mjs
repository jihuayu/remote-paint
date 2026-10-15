import assert from 'node:assert/strict';
// A real WS proxy drops one SKP packet; it does not mock the broker or renderer.
export async function recoverDroppedResource(browser,transport){
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],requests=[];let dropped=0,keyframeRequests=0;
 page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>requests.push(new URL(request.url()).origin));
 try{
  await page.routeWebSocket('**/stream?*',route=>{
   const server=route.connectToServer();
   server.onMessage(message=>{if(typeof message!=='string'&&!dropped){dropped++;return;}route.send(message);});
   route.onMessage(message=>{if(typeof message==='string'&&JSON.parse(message).type==='RequestKeyframe')keyframeRequests++;server.send(message);});
  });
  await page.goto(transport.url);
  await page.waitForFunction(()=>document.body.dataset.ready==='true'&&window.remotePaintResult?.frameId>=2,null,{timeout:30000});
  const recovered=await page.evaluate(()=>window.remotePaintResult);
  assert.equal(dropped,1);assert.equal(keyframeRequests,1);assert.equal(recovered.fullFrames,1);
  assert.equal(recovered.resources,recovered.requiredResources.length);assert.ok(requests.every(origin=>origin===transport.origin));assert.deepEqual(errors,[]);
  return {droppedResources:dropped,keyframeRequests,recovered,viewerSourceRequests:0,errors};
 }finally{await page.close();}
}
