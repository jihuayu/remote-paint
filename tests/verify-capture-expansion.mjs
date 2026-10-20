import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import CanvasKitInit from 'canvaskit-wasm/full';
import {NativeBroker} from '../native/broker.mjs';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

const output='artifacts/capture-expansion',hash=b=>createHash('sha256').update(b).digest('hex'),previous=process.env.REMOTE_PAINT_EXPANSION_BYTES;
process.env.REMOTE_PAINT_EXPANSION_BYTES=String(1024*1024);await mkdir(output,{recursive:true});
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});
const until=async(check,label)=>{const end=Date.now()+20000;for(;;){const value=await check();if(value)return value;assert.ok(Date.now()<end,'Expansion deadline: '+label);await delay(10);}};
const readPixel=(image,x,y)=>[...image.readPixels(x,y,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];
const make=color=>{const r=new ck.PictureRecorder(),c=r.beginRecording([0,0,256,256]),p=new ck.Paint();c.clear(ck.TRANSPARENT);p.setColor(color);c.drawRect([0,0,256,256],p);const picture=r.finishRecordingAsPicture(),bytes=Buffer.from(picture.serialize());picture.delete();p.delete();r.delete();return bytes;};
const payloads=[make(ck.RED),make(ck.BLUE)];
const capture=(id,count=2,extra=0)=>({captureId:id,producer:'capture-expansion-contract',resources:Array.from({length:count},(_,n)=>({localId:7,quadScale:1,width:256,height:256,tileOrigin:[n*256,0],resourceId:hash(payloads[n%2]),skp:payloads[n%2].toString('base64'),requiresIsolation:true})),viz:{captureId:id,namespace:[1,2],passes:[{id:'root',output:[0,0,count*256,256],quads:[{kind:'picture',localId:7,namespace:[1,2],matrix:[1,0,0,0,1,0,0,0,1],visible:[0,0,count*256,256],rect:[0,0,count*256,256],contentOrigin:[0,0],opacity:1,unused:'x'.repeat(extra)}]}]}});
const tags={epoch:1,viewportVersion:1,viewport:{cssWidth:512,cssHeight:256,deviceScaleFactor:1}};
async function rpc(){
 const broker=new NativeBroker(),renderer=new SceneRenderer(ck);let image;
 try{
  const first=await broker.map(capture('first'),tags),before=await broker.request('resourceBudget'),state=await broker.request('mapperStats');
  assert.equal(before.captureExpansion.bytes,0);assert.equal(before.captureExpansion.allocations,0);assert.equal(before.captureExpansion.limit,1024*1024);assert.ok(before.captureExpansion.peak>0);
  let denied;await assert.rejects(broker.map(capture('denied',32,256*1024),{...tags,epoch:2,viewportVersion:2}),e=>{denied={message:e.message,code:e.code};return e.code==='RESOURCE_BUDGET_PRESSURE'&&e.message==='Capture expansion allocation budget exceeded';});
  assert.deepEqual(await broker.request('mapperStats'),state,'Pre-map failure mutated committed Mapper');const after=await broker.request('resourceBudget');assert.equal(after.captureExpansion.bytes,0);assert.ok(after.captureExpansion.denied>before.captureExpansion.denied);assert.ok(after.captureExpansion.peak<=after.captureExpansion.limit);
  const recovered=await broker.map(capture('recovered'),tags);assert.equal(recovered.brokerSerial,first.brokerSerial+1);assert.deepEqual(new Set(recovered.payloads.keys()),new Set(payloads.map(hash)));image=renderer.render(recovered.scene,new Map(payloads.map(bytes=>[hash(bytes),bytes])),ck.WHITE);const pixels=[readPixel(image.image,100,10),readPixel(image.image,300,10),readPixel(image.image,256,10)];assert.deepEqual(pixels,[[255,0,0,255],[0,0,255,255],[0,0,255,255]]);assert.ok(recovered.scene.passes[0].quads.every(q=>!('unused'in q)));
  await broker.resetScene();const released=await broker.request('resourceBudget');assert.equal(released.captureExpansion.bytes,0);assert.equal(released.captureExpansion.allocations,0);
  return {before:before.captureExpansion,denied,after:after.captureExpansion,mapperUnchanged:true,recoveredSerial:recovered.brokerSerial,pixels,unusedProducerFieldsDiscardedByMapper:true,released:released.captureExpansion};
 }finally{image?.image.delete();image?.surface.dispose();renderer.clear();await broker.close();}
}
async function nativeSource(){
 const html='<!doctype html><style>html,body{margin:0;width:100vw;height:100vh;overflow:hidden;background:rgb(31,79,191)}#content{position:absolute;inset:0;display:grid;grid-template-columns:repeat(32,1fr);grid-template-rows:repeat(16,1fr);font:12px Arial;color:white}span{padding:8px}#moving{position:absolute;bottom:0;width:4px;height:4px;background:red}</style><div id="content"></div><div id="moving"></div><script>document.querySelector("#content").innerHTML=Array.from({length:512},(_,n)=>"<span>Tile "+n+"</span>").join("");window.fixtureReady=true;window.ticks=0;function step(){ticks++;document.querySelector("#moving").style.left=(ticks%100)+"px";requestAnimationFrame(step)}requestAnimationFrame(step)</script>';
 const fixture=createServer((req,res)=>res.end(html));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 let source,transport,socket,image,progress;const gate=new LiveFrameGate(),renderer=new SceneRenderer(ck),errors=[],pressure=[],frames=[];
 try{
  source=await startLiveSource({url:'http://127.0.0.1:'+fixture.address().port,viewport:{width:4096,height:2048}});
  source.on('captureError',e=>{if(e.code==='RESOURCE_BUDGET_PRESSURE')pressure.push(e.code);else errors.push(e.stack);});
  const activity=source.acquirePageActivity();await source.page.waitForFunction(()=>window.fixtureReady&&window.ticks>=5);const ticks=await source.page.evaluate(()=>window.ticks);
  transport=await startLiveTransport(source,{port:0});socket=new WebSocket(transport.streamOrigin.replace('http','ws')+'/stream?key='+transport.key,{origin:transport.origin});socket.on('error',e=>errors.push(e.stack));
  socket.on('message',(bytes,binary)=>{let rendered;try{
   if(binary){const r=decodeResource(bytes);assert.equal(hash(r.payload),r.id);gate.put(r.id,r.payload);return;}
   const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);
   if(m.type==='FrameCommit'){const frame=gate.commit(m.pageEpoch,m.frameId,(f,resources)=>{rendered=renderer.render(f.scene,resources,ck.WHITE);image={pixel:readPixel(rendered.image,2,2),width:rendered.image.width(),height:rendered.image.height()};});assert.ok(frame);frames.push({frameId:frame.frameId,viewportVersion:frame.viewportVersion,...image});renderer.retain(new Set(frame.requiredResources));gate.collect();socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));}
  }catch(e){errors.push(e.stack);}finally{rendered?.image.delete();rendered?.surface.dispose();}});
  await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer}));activity();
  const before=await until(async()=>{assert.deepEqual(errors,[]);const b=await source.broker.request('resourceBudget');return pressure.length>0&&b.captureExpansion.denied>0?b:false;},'actual native tile admission pressure');const pid=source.broker.child.pid;
  assert.equal(frames.length,0);assert.equal((await source.broker.request('mapperStats')).serial,0);assert.equal(before.captureExpansion.bytes,0);await delay(150);const afterTicks=await source.page.evaluate(()=>window.ticks);assert.ok(afterTicks>ticks,'Page clock froze under pre-map pressure');progress={before:before.captureExpansion,ticks,afterTicks};
  const version=source.viewportVersion;await source.resize({width:512,height:256});source.requestCapture();await until(()=>{assert.deepEqual(errors,[]);return frames.filter(f=>f.viewportVersion>version).length>=3;},'same-process small native scene recovery');
  assert.equal(source.broker.child.pid,pid);assert.deepEqual(frames.at(-1).pixel,[31,79,191,255]);assert.equal(frames.at(-1).width,512);assert.equal(frames.at(-1).height,256);assert.ok(source.stats.resourcePressureResumes>0);
  const after=await source.broker.request('resourceBudget');assert.equal(after.captureExpansion.bytes,0);assert.equal(after.captureExpansion.allocations,0);assert.ok(after.captureExpansion.peak<=after.captureExpansion.limit);assert.deepEqual(errors,[]);
  return {...progress,after:after.captureExpansion,pidUnchanged:true,pressureEvents:pressure.length,frames,sourceStats:source.stats};
 }catch(e){await writeFile(output+'/native-failed.json',JSON.stringify({at:new Date().toISOString(),error:e.stack,errors,pressure,frames,progress,sourceStats:source?.stats},null,2));throw e;}
 finally{socket?.terminate();gate.clear();renderer.clear();await transport?.close();await source?.close();await new Promise(resolve=>fixture.close(resolve));}
}
try{const report={at:new Date().toISOString(),status:'passed',scope:'Actual Rust RPC pre-map extra-field clone rejection before Mapper commit,release/recovery and CPU CanvasKit tile/seam pixels under1MiB expansion pool;actual native large tiled DOM Source gets same typed pressure,keeps page clock,and recovers exact pixels after smaller viewport in same process. Original RPC/native input and Snapshot/Mapper owners separate;not full VM/OS/Session or8h.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),rpc:await rpc(),native:await nativeSource()};await writeFile(output+'/contract.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,denied:report.rpc.denied,nativePressure:report.native.pressureEvents,pixel:report.native.frames.at(-1).pixel}));}
catch(e){await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),error:e.stack},null,2));throw e;}
finally{if(previous===undefined)delete process.env.REMOTE_PAINT_EXPANSION_BYTES;else process.env.REMOTE_PAINT_EXPANSION_BYTES=previous;}
