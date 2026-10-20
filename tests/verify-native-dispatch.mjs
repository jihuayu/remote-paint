// Actual Broker process and Gateway. Synthetic authenticated native packets
// exercise autonomous dispatch/credit; real Chromium is checked separately.
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createRequire} from 'node:module';
import CanvasKitInit from 'canvaskit-wasm/full';
import {WebSocket} from 'ws';
import {NativeBroker} from '../native/broker.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';
const output=process.env.REMOTE_PAINT_DISPATCH_OUTPUT??'artifacts/native-dispatch';await mkdir(output,{recursive:true});
const directory=await mkdtemp('/tmp/rp-dispatch-'),path=directory+'/viz.sock',broker=new NativeBroker();
const events=[],errors=[],checks=[],control=[],sockets=[],requests={};let socket,rendered,renderer,failure,progress;
const original=broker.request.bind(broker);broker.request=(op,args)=>{requests[op]=(requests[op]??0)+1;return original(op,args);};
broker.on('event',e=>{events.push(e);assert.ok(events.length<128);});broker.on('failure',e=>errors.push(e.message));
const until=async(fn,label)=>{const end=Date.now()+5000;while(!await fn()){assert.deepEqual(errors,[]);assert.ok(Date.now()<end,`Timed out: ${label}`);await delay(5);}};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const str=s=>{const b=Buffer.from(s);return Buffer.concat([u32(b.length),b]);};
const f64=n=>{const b=Buffer.alloc(8);b.writeDoubleBE(n);return b;};
function rvb(id,picture=false){
 const p=[Buffer.from('RVB2\x01\x01'),str(id),u32(1),u32(2),u32(1),str('root'),...[0,0,100,100].map(f64),u32(1),Buffer.from([picture?3:1]),u32(picture?1:0),u32(1),u32(2),...[1,0,0,0,1,0,0,0,1,0,0,100,100,0,0,100,100,0,0,1].map(f64),Buffer.from([0,0]),u32(0)];
 if(!picture)p.push(...[.2,.4,.6,1].map(f64));p.push(Buffer.from([0]));return Buffer.concat(p);
}
const config=base=>({id:randomBytes(16).toString('hex'),generation:1,ordinalBase:base,ordinalLimit:base+31,pageEpoch:1,viewportVersion:1,inputSeq:0,cssWidth:100,cssHeight:100,host:2,minimumSourceFrame:0});
const metadata=(c,n,picture=false)=>({captureId:`${c.id}:${n}`,producer:'7:2',frameToken:n,sourceFrame:n,resources:picture?[{localId:1,resourceId:'1'.repeat(64),width:100,height:100,quadScale:1}]:[],resourcesComplete:true,nativeResources:true,subscription:{version:1,id:c.id,generation:1,captureOrdinal:n,pageEpoch:1,viewportVersion:1,inputSeq:0,cssWidth:100,cssHeight:100},timing:{encodeMs:0},ignoredExtension:'x'.repeat(16*1024)});
const rpa=m=>Buffer.concat([Buffer.from('RPA2\x01\x01'),str(m.captureId),str(JSON.stringify(m)),u32(0)]);
async function connection(){const socket=net.createConnection(path);sockets.push(socket);socket.on('error',()=>{});await once(socket,'connect');let bytes=Buffer.alloc(0);socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);assert.ok(bytes.length<=56*4);});return{socket,async send(body){await new Promise((resolve,reject)=>socket.write(Buffer.concat([u32(body.length),body]),e=>e?reject(e):resolve()));},async credit(c,n,status){await until(()=>bytes.length>=56,'exact credit');const b=bytes.subarray(0,56);assert.equal(b.toString('ascii',0,4),'RPC3');assert.equal(b[4],1);assert.equal(b[5],status);assert.equal(b.toString('ascii',8,40),c.id);assert.equal(Number(b.readBigUInt64BE(40)),n);assert.equal(Number(b.readBigUInt64BE(48)),1);bytes=bytes.subarray(56);}};}
try{
 await broker.request('listenViz',{path});const raw=await connection(),scene=await connection();
 const origin='http://127.0.0.1',key=randomBytes(16).toString('hex'),rendererInfo={};const {port}=await broker.request('listen',{config:{host:'127.0.0.1',port:0,origin,key,renderer:rendererInfo,producer:'native-dispatch-test',sessionId:'native-dispatch-test'}});
 const gate=new LiveFrameGate(),frames=[];socket=new WebSocket(`ws://127.0.0.1:${port}/stream?key=${key}`,{origin});socket.on('error',e=>errors.push(e.message));
 socket.on('message',(bytes,binary)=>{try{assert.equal(binary,false,'Solid fixture has no resource payload');const m=JSON.parse(bytes);if(m.type==='SceneUpdate')gate.stage(m.frame);if(m.type==='FrameCommit'){const frame=gate.commit(m.pageEpoch,m.frameId);assert.ok(frame);frames.push(frame);socket.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'}));}}catch(e){errors.push(e.stack);}});
 await once(socket,'open');socket.send(JSON.stringify({type:'Hello',protocol:4,renderer:rendererInfo}));
 const c=config(0);await broker.request('registerNative',{config:c});
 for(let n=1;n<=12;n++){
  const m=metadata(c,n),count=frames.length;
  if(n%2){await raw.send(rpa(m));await scene.send(rvb(m.captureId));}else{await scene.send(rvb(m.captureId));await raw.send(rpa(m));}
  await raw.credit(c,n,1);await until(()=>events.some(e=>e.event==='NativeFrame'&&e.captureOrdinal===n)&&frames.length>count,'autonomous publication and Gateway scene');
 }
 const native=events.filter(e=>e.event==='NativeFrame');assert.deepEqual(native.map(e=>e.serial),Array.from({length:12},(_,n)=>n+1));assert.equal(requests.map??0,0);assert.equal(requests.publish??0,0);
 for(const e of native){assert.ok(Buffer.byteLength(JSON.stringify(e))<1024);assert.equal(e.scopeId,c.id);assert.equal(e.inputSeq,0);for(const k of ['scene','resources','requiredResources','metadata','timing','ignoredExtension'])assert.equal(e[k],undefined);}
 const ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});renderer=new SceneRenderer(ck);rendered=renderer.render(frames.at(-1).scene,gate.resources,ck.WHITE);
 const pixel=[...rendered.image.readPixels(10,10,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];assert.deepEqual(pixel,[51,102,153,255]);
 checks.push('12 autonomous publications in both packet orders, exactConsumed credits,12 Gateway frames andactualCanvasKitpixel;zero map/publish RPC');
 for(let n=13;n<=15;n++){
  const missing=metadata(c,n,true),status=n===15?3:2,outcome=n===15?'pause':'retry';await raw.send(rpa(missing));await scene.send(rvb(missing.captureId,true));await raw.credit(c,n,status);
  await until(()=>events.some(e=>e.event==='NativeFrameRejected'&&e.captureId===missing.captureId&&e.outcome===outcome),'event must match exact effective credit');assert.equal((await broker.request('mapperStats')).serial,12);
 }
 assert.equal((await broker.request('nativeState')).subscriptions[0].enabled,false);await broker.request('nativePolicy',{scopeId:c.id,inputSeq:0,enabled:true});
 const recovery=metadata(c,16);await raw.send(rpa(recovery));await scene.send(rvb(recovery.captureId));await raw.credit(c,16,1);await until(()=>events.some(e=>e.event==='NativeFrame'&&e.captureOrdinal===16),'recovery');checks.push('three cache misses preserve serial andreturnRetry/Retry/Pause withmatchingevents; explicitresume publishes');
 // Hold the actual Mapper in the existing diagnostic raw-resource wait.
 await broker.request('expectViz',{captureId:'legacy-block',resources:true});await scene.send(rvb('legacy-block'));
 await until(()=>events.some(e=>e.event==='VizReady'&&e.captureId==='legacy-block'),'diagnostic scene ready');
 const blocked=broker.request('map',{capture:{captureId:'legacy-block',nativeResources:true,viz:{native:true}},epoch:1,viewportVersion:1,viewport:{cssWidth:100,cssHeight:100}}).then(()=>({ok:true}),e=>({error:e.message}));
 await delay(40);
 const settled=[],flood=Array.from({length:6},(_,n)=>(n===3?broker.request('listen',{config:{host:'127.0.0.1',port:0,origin,key,renderer:rendererInfo}}):broker.request('map',{capture:{},epoch:1})).then(v=>{settled.push({n,v});},e=>{settled.push({n,error:e.message,code:e.code});}));
 await until(()=>settled.filter(e=>e.error==='Broker request dispatch limit').length>=2,'bounded dispatch queue denial');
 for(const [op,args]of [['inputBudget',{}],['nativeState',{}],['send',{peerId:'unknown',message:{type:'InputAck',seq:1}}],['consumerTicket',{kind:'observation',captureOrdinal:16,pageEpoch:1,viewportVersion:1,inputSeq:0}]]){
  const start=performance.now();await broker.request(op,args);const elapsed=performance.now()-start;assert.ok(elapsed<1500,`${op} waited behind Mapper`);control.push({op,ms:elapsed});
 }
 const held=metadata(c,17);await raw.send(rpa(held));await scene.send(rvb(held.captureId));await until(async()=>(await broker.request('nativeState')).inflight===1,'native queued behind diagnostic Mapper');
 const canceled=performance.now();await broker.request('cancelNative',{scopeId:c.id});await raw.credit(c,17,3);assert.ok(performance.now()-canceled<1500);assert.ok(!events.some(e=>e.event==='NativeFrame'&&e.captureOrdinal===17));
 await broker.request('stop');await scene.send(Buffer.from('RVE2\x01\x01\x02'));assert.match((await blocked).error,/transport failed/);await Promise.all(flood);
 assert.equal(settled.find(e=>e.n===3).error,'Gateway start canceled','Queued listener must not resurrect a stopped Gateway');
 assert.equal(settled.filter(e=>e.error==='Broker request dispatch limit').length,2);assert.equal((await broker.request('mapperStats')).serial,13);
 checks.push('fixed four-slot queue denies excess; input/send/ticket/cancel complete under1.5s while actual Mapper waits; canceled native work never publishes');
 const d=config(32);await broker.request('registerNative',{config:d});const half=metadata(d,33);await raw.send(rpa(half));
 const stop=performance.now();await broker.request('stop');await raw.credit(d,33,3);assert.ok(performance.now()-stop<1500);assert.equal((await broker.request('nativeState')).inflight,0);checks.push('Gateway stop synchronously revokes half-paired native work with exactPause');
 progress={nativeFrames:events.filter(e=>e.event==='NativeFrame').length,displayFrames:frames.length,pixel,control,queueDenied:2,maximumEventBytes:Math.max(...native.map(e=>Buffer.byteLength(JSON.stringify(e)))),requests};assert.deepEqual(errors,[]);
}catch(e){failure=e.stack;}
finally{rendered?.image.delete();rendered?.surface?.dispose();renderer?.clear();socket?.terminate();for(const s of sockets)s.destroy();await broker.close();await rm(directory,{recursive:true,force:true});}
const cleanup={exited:broker.exited,pending:broker.pending.size,requests:broker.requestMemory.stats(),responses:broker.responses.stats()};
assert.equal(cleanup.pending,0);assert.equal(cleanup.requests.owners,0);assert.equal(cleanup.responses.owners,0);
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual Broker process/private native binary IPC/single Mapper/Gateway/CanvasKit. Synthetic authenticated native input; no Chromium/defaultSource,document-token orfullSession/pressure/close acceptance claimed.',brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),checks,progress,cleanup,...(failure?{error:failure}:{})};await writeFile(output+'/dispatch.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,progress,error:failure}));if(failure)throw new Error(failure);
