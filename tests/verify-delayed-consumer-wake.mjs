import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import CanvasKitInit from 'canvaskit-wasm/full';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
assert.equal(process.platform,'linux');
const output='artifacts/delayed-consumer-wake',fixture=createServer((req,res)=>res.end('<!doctype html><style>body{margin:0;background:rgb(31,79,191)}</style><script>window.ticks=0;requestAnimationFrame(function step(){ticks++;requestAnimationFrame(step)});</script>'));await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')}),cases=[],hash=b=>createHash('sha256').update(b).digest('hex');let source,transport,socket,render;
const until=async predicate=>{const end=Date.now()+10000;while(!predicate()){assert.ok(Date.now()<end,'Delayed consumer wake deadline');await delay(5);}};
try{
 for(const kind of ['display','observation','recording']){
  const errors=[],gate=new LiveFrameGate(),frames=[];render=new SceneRenderer(ck);source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:160,height:100}});source.on('captureError',e=>errors.push(e.message));transport=await startLiveTransport(source,{port:0});await delay(2200);assert.ok(performance.now()>source.capture.registrationWarmupUntil);assert.equal(source.frameDriver.running,false);assert.equal(source.stats.captures,0);const idleAcks=source.frameDriver.stats.acked,attempt=source.capture.captureAttempt.bind(source.capture);let firstRegistrationAcks;
  source.capture.captureAttempt=deadline=>{firstRegistrationAcks??=source.frameDriver.stats.acked;assert.ok(firstRegistrationAcks>idleAcks,'Native registration raced the first clock ACK');return attempt(deadline);};const grant=kind==='display'?null:await transport.createConsumerTicket(kind);socket=new WebSocket(grant?.url??`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});socket.on('error',e=>errors.push(e.message));
  socket.on('message',(data,binary)=>{try{if(binary){const r=decodeResource(data);assert.equal(hash(r.payload),r.id);gate.put(r.id,r.payload);return;}const m=JSON.parse(data);if(m.type==='ResourceRelease'){for(const id of m.ids)gate.release(id);return;}if(m.type==='SceneUpdate')gate.stage(m.frame);if(m.type==='FrameCommit'){const f=gate.commit(m.pageEpoch,m.frameId);assert.ok(f);const out=render.render(f.scene,gate.resources,ck.WHITE);let pixel;try{pixel=[...out.image.readPixels(10,10,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];}finally{out.image.delete();out.surface?.dispose();}frames.push({pixel,ordinal:f.native.captureOrdinal});socket.send(JSON.stringify({type:'FrameAck',pageEpoch:f.pageEpoch,frameId:f.frameId,stage:kind==='display'?'scene-submitted':'consumer-released'}));}}catch(e){errors.push(e.stack);}});
  await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,consumerKind:kind,frameWindow:1,capabilities:['frame-window-v1',...(kind==='display'?[]:['scene-consumer-v1'])]}));await until(()=>frames.length||errors.length);assert.deepEqual(errors,[]);assert.deepEqual(frames[0].pixel,[31,79,191,255]);assert.equal(source.capture.registrationRetries,0);assert.equal(source.stats.errors,0);socket.close();await once(socket,'close');await until(()=>source.encodeDemand===0&&!source.frameDriver.running);const ticks=await source.page.evaluate(()=>window.ticks);await delay(150);assert.equal(await source.page.evaluate(()=>window.ticks),ticks);cases.push({kind,delayedFirstConsumerMs:2200,idleAcks,firstRegistrationAcks,pixel:frames[0].pixel,ordinal:frames[0].ordinal,registrationRetries:source.capture.registrationRetries,captureErrors:errors});await transport.close();await source.close();render.clear();source=null;transport=null;socket=null;render=null;
 }
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Chromium and Rust raw WS pixels for three independent Sources,first display/observation/recording consumer after the fixed2sstartup refusal window expires. A real BeginFrame ACK precedes first native registration;no refusal is swallowed orretried. Last consumer stops encoding/externalclock. Source first-encoding wake only; per-capture registration ACK remains unchanged.',brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),cases};await mkdir(output,{recursive:true});await writeFile(`${output}/report.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir(output,{recursive:true});await writeFile(`${output}/failed.json`,JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,cases,stats:source?.stats},null,2));throw error;}
finally{socket?.terminate();render?.clear();await transport?.close();await source?.close();await new Promise(resolve=>fixture.close(resolve));}
