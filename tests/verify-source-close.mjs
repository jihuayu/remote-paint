import assert from 'node:assert/strict';
import net from 'node:net';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay,setImmediate as turn} from 'node:timers/promises';
import {PNG} from 'pngjs';
import {WebSocket} from 'ws';
import {startLiveSource} from '../live/source.mjs';
import {startLive} from '../live.mjs';

assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_SOURCE_CLOSE_OUTPUT??'artifacts/source-close';
const png=new PNG({width:256,height:256});let noise=19;
for(let i=0;i<png.data.length;i+=4){noise^=noise<<13;noise^=noise>>>17;noise^=noise<<5;png.data.set([noise&255,(noise>>>8)&255,(noise>>>16)&255,255],i);}
const image=PNG.sync.write(png),fixture=createServer((request,response)=>{
 if(request.url==='/image'){response.setHeader('Content-Type','image/png');response.end(image);return;}
 response.end('<!doctype html><meta charset="utf-8"><body style="font:24px sans-serif">Session resource ownership<img src="/image">');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${fixture.address().port}`,original=process.env.REMOTE_PAINT_DATA_PLANE;
const retained=[],variants=[];let source,live,progress;
async function until(predicate,timeout=5000){const end=Date.now()+timeout;while(!await predicate()){assert.ok(Date.now()<end,'Process/ownership retirement deadline');await delay(10);}}
async function deadline(promise,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),15000);})]);}finally{clearTimeout(timer);}}
async function processStart(pid){try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function processes(browser){
 const cdp=await browser.newBrowserCDPSession();let processInfo;
 try{({processInfo}=await cdp.send('SystemInfo.getProcessInfo'));}finally{await cdp.detach();}
 const result=[];for(const process of processInfo){const pid=Number(process.id),start=await processStart(pid);if(start)result.push({pid,start});}
 assert.ok(result.length>=2);return result;
}
async function reaped(identities){await until(async()=>{for(const {pid,start}of identities)if(await processStart(pid)===start)return false;return true;});}
function empty(source){
 assert.equal(source.closed,true);assert.equal(source.latest,null);assert.equal(source.producer,null);assert.equal(source.demand,0);assert.equal(source.activityDemand,0);assert.equal(source.readiness.firstScene,false);assert.equal(source.browser.isConnected(),false);
 if(source.mapper){assert.equal(source.mapper.entries.size,0);assert.equal(source.mapper.resources.size,0);assert.equal(source.mapper.resourceMemory.size,0);assert.equal(source.mapper.resourceBytes,0);assert.equal(source.mapper.revision,0);}
 if(source.broker){assert.equal(source.broker.pending.size,0);assert.equal(source.broker.outputBuffer.buffer.byteLength,0);assert.equal(source.broker.exited,true);}
 if(source.nativeAutopublish){assert.equal(source.encodeDemand,0);assert.equal(source.capture.binding,null);assert.equal(source.resetState.pending,0);assert.equal(source.broker.listenerCount('resetStart'),0);assert.equal(source.broker.listenerCount('resetEnd'),0);assert.equal(source.broker.requestMemory.stats().owners,0);assert.equal(source.broker.responses.stats().owners,0);}
}
function includes(error,text){return error.message.includes(text)||error.errors?.some(error=>includes(error,text));}
async function firstFrame(source){const frame=once(source,'frame',{signal:AbortSignal.timeout(15000)});source.setDemand(1);await frame;if(source.nativeAutopublish){assert.ok(source.latest.rawResourceBytes>1024);assert.equal(Object.hasOwn(source.latest,'payloads'),false);assert.equal(Object.hasOwn(source.latest,'scene'),false);}else assert.ok([...source.latest.payloads.values()].reduce((n,r)=>n+r.length,0)>1024);}
// Hold the real Mapper while a real native producer awaits credit. This is
// one explicit diagnostic map, never a synthetic native receipt or promise
// inserted into the default Source's ordinary map/publication path.
async function holdNativeMapper(source){
 const id='source-close-mapper-hold',socket=net.createConnection(source.viz.endpoint);socket.on('error',()=>{});await once(socket,'connect');
 let ready=false;const event=e=>{if(e.event==='VizReady'&&e.captureId===id&&!e.error)ready=true;};source.broker.on('event',event);
 const scene={type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:[0,0,source.viewport.cssWidth,source.viewport.cssHeight],quads:[]}]};
 await source.broker.request('expectViz',{captureId:id,resources:true});const body=Buffer.from(JSON.stringify(scene)),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);await new Promise((resolve,reject)=>socket.write(Buffer.concat([prefix,body]),error=>error?reject(error):resolve()));await until(()=>ready);source.broker.off('event',event);
 let settled=false;const finished=source.broker.request('map',{capture:{captureId:id,nativeResources:true,viz:{native:true}},epoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,viewport:{...source.viewport}}).then(()=>{settled=true;return {ok:true};},error=>{settled=true;return {ok:false,message:error.message};});
 source.requestFreshFrame();let native;await until(async()=>{native=await source.capture.command('inspect',source.capture.binding.config.id);return native.awaitingCredit;});assert.equal(settled,false);
 return {socket,finished,native};
}
try{
 for(const dataPlane of ['rust','node']){
  if(dataPlane==='node')process.env.REMOTE_PAINT_DATA_PLANE='node';else delete process.env.REMOTE_PAINT_DATA_PLANE;
  for(let iteration=0;iteration<5;iteration++){
   const errors=[];source=await startLiveSource({url});source.on('captureError',error=>errors.push(error.message));
   const nativeEvent=source.nativeAutopublish?'frame':'capture';let native;const onNative=value=>native=value;source.capture.on(nativeEvent,onNative);await firstFrame(source);const identities=await processes(source.browser),release=source.acquirePageActivity();
   let held;
   if(dataPlane==='rust'&&iteration===1){
    held=await holdNativeMapper(source);
   }
   const injected=iteration===2;
   if(injected){const close=source.capture.close.bind(source.capture);source.capture.close=async()=>{await close();throw new Error('Injected capture cleanup failure');};}
   const queuedResize=iteration===3?assert.rejects(source.resize({width:640,height:480}),/Source is closed/):null;
   progress={dataPlane,iteration,injected,actualMapperWait:!!held,queuedResize:!!queuedResize,processes:identities};
   const started=performance.now(),closing=source.close();assert.equal(closing,source.close());assert.equal(source.latest,null);assert.equal(source.mapper?.resourceBytes??0,0);
   if(injected)await assert.rejects(closing,error=>includes(error,'Injected capture cleanup failure'));else await closing;
   await queuedResize;
   if(held){const result=await held.finished;assert.equal(result.ok,false,'Unfinished diagnostic map escaped close');held.socket.destroy();await turn();progress.heldNative={awaitingCredit:held.native.awaitingCredit,lastStarted:held.native.lastStarted,mapRejected:true};}
   progress.closeMs=performance.now()-started;
   release();empty(source);await reaped(identities);
   // Closed retained objects must not accept late frames or revive a namespace.
   let maps=0;if(source.mapper){const map=source.mapper.map.bind(source.mapper);source.mapper.map=(...args)=>{maps++;return map(...args);};}
   source.capture.emit(nativeEvent,native,0);source.capture.emit('captureError',new Error('Late closed capture error'));
   if(source.nativeAutopublish){source.broker.emit('resetStart',{id:999,op:'reset'});source.broker.emit('resetEnd',{id:999,op:'reset',ok:true,closed:true});}
   const epoch=source.pageEpoch;source.invalidate('late-navigation');source.setDemand(1);source.requestCapture();
   assert.throws(()=>source.resize({width:640,height:480}),/Source is closed/);assert.throws(()=>source.acquirePageActivity(),/Source is closed/);
   await turn();assert.equal(source.pageEpoch,epoch);assert.equal(maps,0);empty(source);assert.deepEqual(errors,[]);
   source.capture.off(nativeEvent,onNative);native=null;
   variants.push({...progress,reapedProcesses:identities.length,errors});retained.push(source);source=null;
  }
  // An outer control-cleanup failure must still close the Source and fixture.
  live=await startLive({port:0});source=live.source;const errors=[];source.on('captureError',error=>errors.push(error.message));await firstFrame(source);
  const identities=await processes(source.browser),fixtureUrl=source.page.url(),close=source.control.close.bind(source.control);
  const client=new WebSocket(`${live.streamOrigin.replace('http','ws')}/stream?key=${live.key}`,{origin:live.origin});client.on('error',error=>errors.push(error.message));
  await once(client,'open');const welcome=new Promise(resolve=>client.on('message',(bytes,binary)=>{if(!binary&&JSON.parse(bytes).type==='Welcome')resolve();}));
  client.send(JSON.stringify({type:'Hello',protocol:4,renderer:live.renderer}));await deadline(welcome,'Close probe Viewer handshake timeout');
  if(source.broker){const request=source.broker.request.bind(source.broker);source.broker.request=(op,...args)=>op==='stop'?Promise.reject(new Error('Injected Gateway stop failure')):request(op,...args);}
  source.control.close=async()=>{await close();throw new Error('Injected control cleanup failure');};
  const clientClosed=once(client,'close'),closing=live.close();assert.equal(closing,live.close());await assert.rejects(closing,error=>includes(error,'Injected control cleanup failure')&&(!source.broker||includes(error,'Injected Gateway stop failure')));
  await clientClosed;empty(source);await reaped(identities);await assert.rejects(fetch(fixtureUrl));await assert.rejects(fetch(live.origin));assert.equal(live.peers.size,0);assert.deepEqual(errors,[]);
  variants.push({dataPlane,outerControlFailure:true,gatewayStopFailure:!!source.broker,reapedProcesses:identities.length,ownedFixtureClosed:true,viewerServerClosed:true,viewerSocketClosed:true,errors});retained.push(source);source=null;live=null;
 }
 for(const source of retained)empty(source);
 const report={at:new Date().toISOString(),status:'passed',scope:'Actual Linux Chromium with default autonomous native Rust Source and explicit Node fallback: ten retained closed Sources plus two Live control-cleanup failures. Native Source keeps scalar receipts, Node Mapper caches/latest reset; one explicit diagnostic map holds the real Mapper while actual C++ awaits credit, then real close rejects/drains it. Late work/reset events cannot republish, idempotent close, queued resize and injected cleanup errors propagate while all owned browser processes/Broker/fixture still exit. /proc start identities avoid PID-reuse false positives. Ownership/process-exit evidence only, not native rendered-pixel/RSS/PSS/whole-Session/eight-hour or complete B1 acceptance.',browserSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_CHROMIUM)).digest('hex'),brokerSha256:createHash('sha256').update(await readFile(process.env.REMOTE_PAINT_BROKER)).digest('hex'),retainedSources:retained.length,variants};
 await mkdir(output,{recursive:true});await writeFile(output+'/ownership.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){await mkdir(output,{recursive:true});await writeFile(output+'/failed.json',JSON.stringify({at:new Date().toISOString(),status:'failed',error:error.stack,progress,variants},null,2));throw error;}
finally{
 if(original===undefined)delete process.env.REMOTE_PAINT_DATA_PLANE;else process.env.REMOTE_PAINT_DATA_PLANE=original;
 await live?.close().catch(()=>{});await source?.close().catch(()=>{});await new Promise(resolve=>fixture.close(resolve));
}
