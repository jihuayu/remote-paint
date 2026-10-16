import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {once} from 'node:events';
import {NativeBroker} from '../native/broker.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {fakeSource,payload} from './live-helpers.mjs';
import {recoverDroppedResource} from './fault-viewer.mjs';
const broker=new NativeBroker(),source=fakeSource();source.broker=broker;
let serial=0;
const publish=async(translation=0,epoch=1)=>{
 const captureId=`native-gateway-${++serial}`,rect=[0,0,960,640];
 const capture={captureId,producer:'contract-native-broker',frameToken:serial,sourceFrame:serial,resources:[{localId:1,quadScale:1,width:960,height:640,skp:payload.toString('base64')}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,translation,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1,vizResource:1}]}]}};
 source.latest=await broker.map(capture,{epoch,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640,deviceScaleFactor:1}});source.emit('frame');
};
await publish();const transport=await startLiveTransport(source,{port:0,ackTimeout:800});const browser=await launchCaptureBrowser();
try{
 const errors=[],pages=await Promise.all([browser.newPage(),browser.newPage()]);for(const page of pages)page.on('pageerror',e=>errors.push(e.message));
 await Promise.all(pages.map(p=>p.goto(transport.url)));await Promise.all(pages.map(p=>p.waitForFunction(()=>window.remotePaintResult?.frameId===1)));
 const first=await pages[0].evaluate(()=>window.remotePaintResult);await publish(-50);await Promise.all(pages.map(p=>p.waitForFunction(()=>window.remotePaintResult?.native.captureId==='native-gateway-2')));
 const second=await pages[0].evaluate(()=>window.remotePaintResult);assert.equal(second.resourcesReceived,first.resourcesReceived);assert.equal(second.deltaFrames,1);
 const wsUrl=`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`;
 console.log('native viewers rendered delta', [...transport.peers].map(p=>({id:p.id,stats:p.stats})),broker.stderr);
 const slow=new WebSocket(wsUrl,{origin:transport.origin});await once(slow,'open');slow.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer}));assert.equal((await once(slow,'close'))[0],1013);
 console.log('slow closed');
 const mismatch=new WebSocket(wsUrl,{origin:transport.origin});await once(mismatch,'open');mismatch.send(JSON.stringify({type:'Hello',protocol:4,renderer:{}}));assert.equal((await once(mismatch,'close'))[0],1008);
 console.log('mismatch closed');
 const missingResourceRecovery=await recoverDroppedResource(browser,transport);
 await publish(0,2);await Promise.all(pages.map(p=>p.waitForFunction(()=>window.remotePaintResult?.pageEpoch===2)));
 assert.deepEqual(errors,[]);const peers=[...transport.peers].map(peer=>({id:peer.id,stats:peer.stats}));assert.ok(peers.every(p=>p.id.startsWith('native-')));
 const report={verifiedAt:new Date().toISOString(),scope:'Native Rust SceneMapper + native WebSocket data plane, fixture capture and real CanvasKit Worker',first,second,multipleViewers:true,slowClientClose:1013,rendererMismatchClose:1008,missingResourceRecovery,peers};
 await mkdir('artifacts/broker',{recursive:true});await writeFile('artifacts/broker/report.json',JSON.stringify(report,null,2));console.log(report);
}catch(error){console.log('broker failure',broker.stderr,[...transport.peers].map(p=>({id:p.id,stats:p.stats})));throw error;}finally{await browser.close();await transport.close();await broker.close();}
