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
const saved=Object.fromEntries(['REMOTE_PAINT_RESOURCE_POOL_BYTES','REMOTE_PAINT_TILED_CAPTURE','REMOTE_PAINT_DATA_PLANE'].map(key=>[key,process.env[key]]));
process.env.REMOTE_PAINT_RESOURCE_POOL_BYTES=String(64*1024*1024);process.env.REMOTE_PAINT_TILED_CAPTURE='0';delete process.env.REMOTE_PAINT_DATA_PLANE;
const consumerKind=process.env.REMOTE_PAINT_PRESSURE_CONSUMER??'display';assert.ok(['display','recording'].includes(consumerKind));
const side=1536,color=[37,91,199,255],png=new PNG({width:side,height:side});let value=31;
for(let i=0;i<png.data.length;i+=4){value^=value<<13;value^=value>>>17;value^=value<<5;png.data.set([value&255,(value>>>8)&255,(value>>>16)&255,255],i);}
for(let y=0;y<4;y++)for(let x=0;x<4;x++)png.data.set(color,(y*side+x)*4);
const image=PNG.sync.write(png,{deflateLevel:1,filterType:0});
const fixture=createServer((request,response)=>{if(request.url==='/image'){response.setHeader('Content-Type','image/png');response.end(image);}else response.end(`<!doctype html><style>html,body{margin:0;width:${side}px;height:${side}px;overflow:hidden}img{width:${side}px;height:${side}px;will-change:transform;transform:translateZ(0);contain:paint}</style><img src="/image"><script>window.ticks=0;function step(){ticks++;requestAnimationFrame(step)}requestAnimationFrame(step)</script>`);});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
let source,transport,socket,renderer,out,progress;const errors=[],pressureEvents=[],frames=[],gate=new LiveFrameGate();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function until(predicate){const end=Date.now()+15000;while(!predicate()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,'Source resource pressure deadline');await delay(5);}}
const ack=frame=>socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:consumerKind==='display'?'scene-submitted':'consumer-released'}));
try{
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:side,height:side}});
 source.on('captureError',error=>{if(error.code==='RESOURCE_BUDGET_PRESSURE')pressureEvents.push(error.code);else errors.push(error.message);});
 await source.page.waitForFunction(()=>document.images[0].complete&&document.images[0].naturalWidth===1536);
 // Hold actual capture idle while two valid protocol fixtures occupy a peer
 // window. Only the frame that triggers pressure and its recovery are native.
 const setDemand=source.setDemand,setConsumerDemand=source.setConsumerDemand;source.setDemand=()=>setDemand(0);source.setConsumerDemand=()=>setConsumerDemand({});
 transport=await startLiveTransport(source,{port:0,ackTimeout:15000});
 const grant=consumerKind==='recording'?await transport.createConsumerTicket('recording'):null;
 socket=new WebSocket(grant?.url??`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',error=>errors.push(error.message));
 socket.on('message',(bytes,binary)=>{try{
  if(binary){const item=decodeResource(bytes);assert.equal(hash(item.payload),item.id);gate.put(item.id,item.payload);return;}
  const message=JSON.parse(bytes);if(message.type==='SceneUpdate')gate.stage(message.frame);if(message.type==='FrameCommit'){const frame=gate.commit(message.pageEpoch,message.frameId);assert.ok(frame);frames.push(frame);}
 }catch(error){errors.push(error.stack);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,consumerKind,capabilities:['frame-window-v1',...(consumerKind==='recording'?['scene-consumer-v1']:[])],frameWindow:2}));
 for(let n=1;n<=2;n++){
  const bytes=Buffer.alloc(7.5*1024*1024);let state=n;for(let i=0;i<bytes.length;i++){state^=state<<13;state^=state>>>17;state^=state<<5;bytes[i]=state&255;}bytes.write('skiapict');
  const captureId=`held-${n}`,rect=[0,0,side,side],native={captureId,producer:'pressure-held-fixture',resources:[{localId:1,quadScale:1,width:side,height:side,skp:bytes.toString('base64')}],viz:{captureId,namespace:[1,2],passes:[{id:'root',output:rect,quads:[{kind:'picture',localId:1,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],rect,visible:rect,contentOrigin:[0,0],opacity:1}]}]}};
  const mapped=await source.broker.map(native,{epoch:source.pageEpoch,viewport:source.viewport,viewportVersion:source.viewportVersion,captureOrdinal:n});await source.broker.request('publish',{serial:mapped.brokerSerial});await until(()=>frames.length===n);
 }
 const before={epoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,latest:source.latest};source.setDemand=setDemand;source.setConsumerDemand=setConsumerDemand;source.setConsumerDemand({[consumerKind]:1});
 await until(()=>source.resourcePaused===true);assert.equal(source.capture.viewers,0);assert.equal(source.demand,consumerKind==='display'?1:0);assert.equal(source.encodeDemand,1);assert.equal(source.frameDriver.running,true);
 const tickBefore=await source.page.evaluate(()=>window.ticks);let tickAfter=tickBefore;const clockEnd=Date.now()+500;
 while(tickAfter===tickBefore&&Date.now()<clockEnd){await delay(25);tickAfter=await source.page.evaluate(()=>window.ticks);}assert.ok(tickAfter>tickBefore,'Capture pressure stopped the page clock');
 assert.equal(source.pageEpoch,before.epoch);assert.equal(source.viewportVersion,before.viewportVersion);assert.equal(source.inputSeq,before.inputSeq);assert.equal(source.latest,before.latest);assert.equal(source.stats.errors,0);
 const pressured=await source.broker.request('resourceBudget');assert.ok(pressured.denied>0&&pressured.peak<=pressured.limit);ack(frames[0]);ack(frames[1]);
 await until(()=>source.stats.resourcePressureResumes>0&&source.stats.captures>0&&frames.length>=3);
 const received=frames[2];assert.ok(!received.native.captureId.startsWith('held-'));assert.equal(source.resourcePaused,false);
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);out=renderer.render(received.scene,gate.resources,ck.WHITE);
 const pixel=[...out.image.readPixels(2,2,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];assert.deepEqual(pixel,color);ack(received);
 const after=await source.broker.request('resourceBudget');assert.ok(after.peak<=after.limit);assert.deepEqual(errors,[]);assert.equal(source.stats.errors,0);
 progress={consumerKind,displayDemand:source.demand,imageBytes:image.length,tickBefore,tickAfter,pressured,after,pixel,pressureEvents,sourceStats:source.stats,latestBrokerSerialAtReport:source.latest.brokerSerial,recoveredFrame:{captureId:received.native.captureId,frameId:received.frameId,resources:received.requiredResources.length}};
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux non-tiled native capture of1536² noisy PNG while two7.5MiB synthetic protocol fixtures are held by an unacknowledged peer.64MiB resource admission triggers typed Source backpressure; display capture pauses, page clock advances, latest/epoch/viewport/input fences remain intact, ACK frees old owners, native force-resource retry resumes, and actual recovered CanvasKit CPU pixel matches. Not an all-native slow-peer workload, Viewer GPU test, parser/output-copy or process-memory budget.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),...progress,errors};
 await mkdir('artifacts/source-resource-pressure',{recursive:true});await writeFile(`artifacts/source-resource-pressure/${consumerKind==='recording'?'recording':'report'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir('artifacts/source-resource-pressure',{recursive:true});await writeFile(`artifacts/source-resource-pressure/${consumerKind==='recording'?'recording-failed':'failed'}.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,errors,pressureEvents,sourceStats:source?.stats,frames:frames.length},null,2));throw error;}
finally{out?.image.delete();out?.surface?.dispose();renderer?.clear();socket?.terminate();await transport?.close();await source?.close();await new Promise(resolve=>fixture.close(resolve));for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
