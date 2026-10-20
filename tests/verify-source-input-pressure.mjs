import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import {WebSocket} from 'ws';
import {PNG} from 'pngjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_INPUT_PRESSURE_OUTPUT??'artifacts/source-input-pressure';
const saved=Object.fromEntries(['REMOTE_PAINT_INPUT_POOL_BYTES','REMOTE_PAINT_TILED_CAPTURE','REMOTE_PAINT_DATA_PLANE'].map(key=>[key,process.env[key]]));
process.env.REMOTE_PAINT_INPUT_POOL_BYTES=String(2*1024*1024);process.env.REMOTE_PAINT_TILED_CAPTURE='0';delete process.env.REMOTE_PAINT_DATA_PLANE;
const side=1536,color=[29,83,197,255],png=new PNG({width:side,height:side});let state=37;
for(let i=0;i<png.data.length;i+=4){state^=state<<13;state^=state>>>17;state^=state<<5;png.data.set([state&255,(state>>>8)&255,(state>>>16)&255,255],i);}
const image=PNG.sync.write(png,{deflateLevel:1,filterType:0});assert.ok(image.length>2*1024*1024);
const small=new PNG({width:64,height:64});for(let i=0;i<small.data.length;i+=4)small.data.set([(i/4)%256,83,197,255],i);for(let y=0;y<4;y++)for(let x=0;x<4;x++)small.data.set(color,(y*64+x)*4);const smallImage=PNG.sync.write(small);
const fixture=createServer((request,response)=>{if(['/image','/small'].includes(request.url)){response.setHeader('Content-Type','image/png');response.end(request.url==='/image'?image:smallImage);}else response.end(`<!doctype html><style>html,body{margin:0;width:${side}px;height:${side}px;overflow:hidden}img{width:${side}px;height:${side}px;will-change:transform;transform:translateZ(0);contain:paint}</style><img src="/image"><script>window.ticks=0;function step(){ticks++;requestAnimationFrame(step)}requestAnimationFrame(step)</script>`);});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let source,transport,socket,renderer,out,progress;const errors=[],pressureEvents=[],statuses=[],frames=[],gate=new LiveFrameGate(),hash=bytes=>createHash('sha256').update(bytes).digest('hex'),nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0};
async function until(predicate){const end=Date.now()+15000;while(!predicate()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,'Native input pressure deadline');await delay(5);}}
try{
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:side,height:side}});
 assert.equal(source.nativeAutopublish,true);const request=source.broker.request.bind(source.broker);source.broker.request=(op,args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,args);};const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,args);};
 source.on('captureError',error=>{if(['INPUT_BUDGET_PRESSURE','RESOURCE_BUDGET_PRESSURE'].includes(error.code))pressureEvents.push(error.code);else errors.push(error.message);});
 const loading=source.acquirePageRun();try{await source.page.waitForFunction(()=>document.images[0].complete&&document.images[0].naturalWidth===1536);}finally{loading();}
 const before={epoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,latest:source.latest};transport=await startLiveTransport(source,{port:0,ackTimeout:15000});
 socket=new WebSocket(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',error=>errors.push(error.message));
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);assert.equal(hash(item.payload),item.id);gate.put(item.id,item.payload);return;}
  const message=JSON.parse(bytes);if(message.type==='CaptureError')statuses.push(message.message);if(message.type==='SceneUpdate')gate.stage(message.frame);if(message.type==='FrameCommit'){const frame=gate.commit(message.pageEpoch,message.frameId);assert.ok(frame);frames.push(frame);}
 }catch(error){errors.push(error.stack);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer}));
 await until(()=>source.resourcePaused===true&&source.stats.lastPressureCode==='INPUT_BUDGET_PRESSURE');
 assert.equal(source.capture.viewers,0);assert.equal(source.demand,1);assert.equal(source.frameDriver.running,true);assert.equal(source.latest,before.latest);assert.equal(frames.length,0);
 const inputBefore=await source.broker.request('inputBudget');assert.ok(inputBefore.denied>0&&inputBefore.peak<=inputBefore.limit);
 const ticks=await source.page.evaluate(()=>window.ticks);await delay(125);const afterTicks=await source.page.evaluate(()=>window.ticks);assert.ok(afterTicks>ticks,'Input backpressure stopped the page clock');
 // The small explicit quota cannot admit the original noisy image. Replace
 // it with an actual smaller page scene; default-quota large-image support is
 // tested separately. No fake success or partial original frame is accepted.
 const releaseActivity=source.acquirePageActivity();source.setDemand(0);await source.capture.drain();
 const drained=await source.capture.command('inspect',source.capture.binding.config.id);assert.equal(drained.inflight,false);assert.equal(drained.enabled,false);
 try{await source.page.evaluate(()=>document.querySelector('img').src='/small');await source.page.waitForFunction(()=>document.images[0].complete&&document.images[0].naturalWidth===64);}
 finally{source.setDemand(1);releaseActivity();}
 await until(()=>source.stats.captures>0&&frames.length>0&&source.stats.resourcePressureResumes>0);
 assert.equal(source.pageEpoch,before.epoch);assert.equal(source.viewportVersion,before.viewportVersion);assert.equal(source.inputSeq,before.inputSeq);assert.equal(source.stats.errors,0);
 const received=frames[0];assert.ok(received.requiredResources.length>0,'Recovery did not deliver an actual SKP resource');const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);out=renderer.render(received.scene,gate.resources,ck.WHITE);
 const pixel=[...out.image.readPixels(2,2,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];assert.deepEqual(pixel,color);socket.send(JSON.stringify({type:'FrameAck',pageEpoch:received.pageEpoch,frameId:received.frameId,stage:'scene-submitted'}));
 const inputAfter=await source.broker.request('inputBudget');assert.ok(inputAfter.bytes<=inputAfter.limit&&inputAfter.peak<=inputAfter.limit);assert.deepEqual(errors,[]);
 assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});assert.ok(source.latest.resourcesComplete&&source.latest.rawResourceBytes>0);assert.equal(Object.hasOwn(source.latest,'scene'),false);assert.equal(Object.hasOwn(source.latest,'payloads'),false);
 progress={imageBytes:image.length,smallImageBytes:smallImage.length,inputBefore,inputAfter,ticks,afterTicks,pixel,pressureEvents,statuses,nodeCalls,nativeAutopublish:true,nativeDrained:!drained.inflight,sourceStats:source.stats,recoveredFrame:{captureId:received.native.captureId,frameId:received.frameId,resources:received.requiredResources.length}};
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux non-tiled1536² noisy PNG native RPA packet rejected before full allocation under explicit2MiB input quota. Typed input pressure reaches Source,display capture pauses without stopping page clock or publishing a partial frame. A smaller actual page scene then recovers on the private connection,forces resources and matches CPU CanvasKit pixel. This does not claim the original noisy scene fits2MiB; default-quota57.8MB native support is a separate regression. Packet capacity/metadata estimates only,no full process-memory or GPU claim.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),...progress,errors};
 await mkdir(output,{recursive:true});await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir(output,{recursive:true});await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,errors,pressureEvents,nodeCalls,sourceStats:source?.stats,frames:frames.length},null,2));throw error;}
finally{out?.image.delete();out?.surface?.dispose();renderer?.clear();socket?.terminate();await transport?.close();await source?.close();await new Promise(resolve=>fixture.close(resolve));for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
