import assert from 'node:assert/strict';
import net from 'node:net';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {PNG} from 'pngjs';
import {startLive} from '../live.mjs';

assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_SOURCE_CRASH_OUTPUT??'artifacts/native-source-crash';await mkdir(output,{recursive:true});
const png=new PNG({width:256,height:256});let random=19;
for(let i=0;i<png.data.length;i+=4){random^=random<<13;random^=random>>>17;random^=random<<5;png.data.set([random&255,(random>>>8)&255,(random>>>16)&255,255],i);}
const image=PNG.sync.write(png),fixture=createServer((req,res)=>{if(req.url==='/image'){res.setHeader('Content-Type','image/png');res.end(image);}else res.end('<!doctype html><style>body{margin:0;background:white}img{width:256px;height:256px}</style><img src=/image><input>');});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const original=process.env.REMOTE_PAINT_DATA_PLANE,variants=[],retained=[];let live,held,progress,failure;
async function until(fn,label,timeout=5000){const end=Date.now()+timeout;while(!await fn()){assert.ok(Date.now()<end,label);await delay(5);}}
async function timed(promise,label,ms=15000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function identity(pid){try{const value=await readFile(`/proc/${pid}/stat`,'utf8');return value.slice(value.lastIndexOf(')')+2).split(' ')[19];}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function processes(browser){const cdp=await browser.newBrowserCDPSession();try{const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');const values=[];for(const p of processInfo){const pid=Number(p.id),start=await identity(pid);if(start)values.push({pid,start});}assert.ok(values.length>=2);return values;}finally{await cdp.detach();}}
async function holdMapper(source){
 const id='source-crash-diagnostic',socket=net.createConnection(source.viz.endpoint);socket.on('error',()=>{});await once(socket,'connect');let ready=false;
 const event=e=>{if(e.event==='VizReady'&&e.captureId===id&&!e.error)ready=true;};source.broker.on('event',event);
 await source.broker.request('expectViz',{captureId:id,resources:true});const body=Buffer.from(JSON.stringify({type:'VizScene',captureId:id,namespace:[1,2],passes:[{id:'root',output:[0,0,source.viewport.cssWidth,source.viewport.cssHeight],quads:[]}]})),prefix=Buffer.alloc(4);prefix.writeUInt32BE(body.length);await new Promise((resolve,reject)=>socket.write(Buffer.concat([prefix,body]),e=>e?reject(e):resolve()));await until(()=>ready,'diagnostic Viz scene');source.broker.off('event',event);
 let settled=false;const finished=source.broker.request('map',{capture:{captureId:id,nativeResources:true,viz:{native:true}},epoch:source.pageEpoch,viewportVersion:source.viewportVersion,inputSeq:source.inputSeq,viewport:{...source.viewport}}).then(()=>{settled=true;return {ok:true};},e=>{settled=true;return {ok:false,message:e.message};});
 source.requestFreshFrame();let native;await until(async()=>{native=await source.capture.command('inspect',source.capture.binding.config.id);return native.awaitingCredit;},'actual native producer awaiting Mapper credit');assert.equal(settled,false);return {socket,finished,native};
}
function empty(source){
 assert.equal(source.closed,true);assert.equal(source.latest,null);assert.equal(source.producer,null);assert.equal(source.encodeDemand,0);assert.equal(source.activityDemand,0);assert.equal(source.browser.isConnected(),false);assert.equal(source.control.closed,true);assert.equal(source.control.peers.size,0);
 if(source.broker){assert.equal(source.broker.exited,true);assert.equal(source.broker.pending.size,0);assert.equal(source.broker.requestMemory.stats().owners,0);assert.equal(source.broker.responses.stats().owners,0);assert.equal(source.capture.binding,null);assert.equal(source.resetState.pending,0);assert.equal(source.broker.listenerCount('resetStart'),0);assert.equal(source.broker.listenerCount('resetEnd'),0);}
 else{assert.equal(source.mapper.entries.size,0);assert.equal(source.mapper.resources.size,0);assert.equal(source.mapper.resourceBytes,0);}
}
try{
 for(const variant of [{dataPlane:'rust',held:false},{dataPlane:'rust',held:true},{dataPlane:'node',held:false}]){
  if(variant.dataPlane==='node')process.env.REMOTE_PAINT_DATA_PLANE='node';else delete process.env.REMOTE_PAINT_DATA_PLANE;
  const errors=[];live=await startLive({url:`http://127.0.0.1:${fixture.address().port}`,port:0});const source=live.source;source.on('captureError',e=>{errors.push({message:e.message,code:e.code});assert.ok(errors.length<32);});
  const loading=source.acquirePageRun();try{await source.page.waitForFunction(()=>document.images[0].complete&&document.images[0].naturalWidth===256);}finally{loading();}
  const frame=once(source,'frame');source.setDemand(1);await timed(frame,'active frame before crash');assert.equal(source.nativeAutopublish===true,variant.dataPlane==='rust');assert.ok(source.nativeAutopublish?source.latest.rawResourceBytes>1024:[...source.latest.payloads.values()].reduce((n,p)=>n+p.length,0)>1024);
  const identities=await processes(source.browser);held=variant.held?await holdMapper(source):null;
  progress={...variant,processes:identities,firstFrameOrdinal:source.captureOrdinal,actualAwaitingCredit:held?.native.awaitingCredit??false};
  let crashed=false;source.page.once('crash',()=>crashed=true);const crash=source.capture.cdp.send('Page.crash').then(()=>({ok:true}),e=>({ok:false,message:e.message}));
  await until(()=>crashed&&source.targetCrashed,'real Page.crash signal');assert.equal(source.browser.isConnected(),true);
  let inputSettled=false;const input=source.control.agent({kind:'text',text:'crashed'}).then(()=>{inputSettled=true;return {ok:true};},e=>{inputSettled=true;return {ok:false,message:e.message};});
  await delay(5);const inputPendingBeforeClose=!inputSettled,start=performance.now(),closing=live.close();assert.equal(closing,live.close());await timed(closing,'Live close after real renderer crash');
  const inputResult=await timed(input,'crashed-target input must reject through close');assert.equal(inputResult.ok,false);await timed(crash,'Page.crash RPC retires when its owner closes');
  if(held){assert.equal((await held.finished).ok,false);held.socket.destroy();held=null;}
  empty(source);await until(async()=>{for(const row of identities)if(await identity(row.pid)===row.start)return false;return true;},'owned PID/start identities reaped');await assert.rejects(fetch(live.origin));assert.equal(live.peers.size,0);
  const beforeErrors=errors.length,epoch=source.pageEpoch;source.capture.emit(source.nativeAutopublish?'frame':'capture',{}, {inputSeq:source.inputSeq,captureOrdinal:source.captureOrdinal});source.capture.emit('captureError',new Error('late crash cleanup event'));source.invalidate();source.requestCapture();source.setDemand(1);if(source.broker){source.broker.emit('resetStart',{id:999,op:'reset'});source.broker.emit('resetEnd',{id:999,op:'reset',ok:true,closed:true});}
  await delay(5);empty(source);assert.equal(source.pageEpoch,epoch);assert.equal(errors.length,beforeErrors);assert.ok(errors.every(e=>/crash|closed|Cannot find context|Execution context was destroyed|Native subscription inactive/i.test(e.message)),JSON.stringify(errors));
  variants.push({...progress,realPageCrash:true,inputPendingBeforeClose,inputRejected:true,inputError:inputResult.message,closeMs:performance.now()-start,reapedProcesses:identities.length,viewerServerClosed:true,retainedSourceEmpty:true,errors});retained.push(source);live=null;progress=null;
 }
 for(const source of retained)empty(source);
}catch(e){failure=e.stack;}
finally{held?.socket.destroy();await live?.close().catch(()=>{});await new Promise(resolve=>fixture.close(resolve));if(original===undefined)delete process.env.REMOTE_PAINT_DATA_PLANE;else process.env.REMOTE_PAINT_DATA_PLANE=original;}
const hash=b=>createHash('sha256').update(b).digest('hex'),report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Three actual Chromium Page.crash cases: active default autonomous native Source, real Mapper diagnostic resource wait with actual native C++ awaiting credit, and active explicit Node fallback. Post-crash real CDP control rejects through idempotent Live close; retained Sources stay empty, all browser PID/start identities and Broker/request/response/control owners retire. One explicit diagnostic map induces the held case; no synthetic native credit. Process/fault cleanup only, not rendered pixels,200ms bulk/network close,RSS/PSS growth,8h or full B1 acceptance.',browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),variants,progress,retainedSources:retained.length,...(failure?{error:failure}:{})};
await writeFile(output+'/crash.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,variants:variants.map(({dataPlane,held,reapedProcesses,closeMs,inputPendingBeforeClose})=>({dataPlane,held,reapedProcesses,closeMs,inputPendingBeforeClose})),error:failure}));if(failure)throw new Error(failure);
