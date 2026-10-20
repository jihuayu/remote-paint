import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {PNG} from 'pngjs';
import CanvasKitInit from 'canvaskit-wasm/full';
import {WebSocket} from 'ws';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {createControl} from '../live/input.mjs';
import {LiveFrameGate} from '../protocol/live-wire.mjs';
import {decodeResource} from '../protocol/wire.mjs';
import {SceneRenderer} from '../viewer/scene-renderer.mjs';

assert.equal(process.platform,'linux');
const output=process.env.REMOTE_PAINT_SOURCE_SIX_CONSUMERS_OUTPUT??'artifacts/native-source-six-consumers';await mkdir(output,{recursive:true});
const colors=[[31,79,191,255],[43,161,89,255],[191,61,107,255]],images=colors.map(color=>{const png=new PNG({width:32,height:32});for(let i=0;i<png.data.length;i+=4)png.data.set(color,i);return PNG.sync.write(png);});
const html='<!doctype html><style>html,body{margin:0;background:white;overflow:hidden}img,#match{position:absolute;top:0;width:32px;height:32px}#match{left:64px;will-change:background-color}</style><img src=/image/0><div id=match></div><script>const colors=["rgb(31,79,191)","rgb(43,161,89)","rgb(191,61,107)"];const images=colors.map((_,n)=>{const img=new Image();img.src="/image/"+n;return img;});window.select=n=>{document.querySelector("img").replaceWith(images[n]);document.querySelector("#match").style.backgroundColor=colors[n];window.selected=n;};window.ready=Promise.all(images.map(img=>img.decode())).then(()=>select(0));window.addEventListener("keydown",()=>{window.ready=select(2);});window.ticks=0;requestAnimationFrame(function step(){ticks++;requestAnimationFrame(step);});</script>';
const fixture=createServer((req,res)=>{if(req.url.startsWith('/image/')){res.setHeader('Content-Type','image/png');res.end(images[Number(req.url.slice(7))]);}else res.end(html);});await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const hash=b=>createHash('sha256').update(b).digest('hex'),clients=[],errors=[],checks=[],attached=[],diagnostics={},nodeCalls={evaluate:0,awaitPromise:0,map:0,publish:0};
let source,transport,ck,phase='startup',failure,cleanupErrors=[];
async function until(fn,label,timeout=12000){
 const deadline=Date.now()+timeout;
 while(!await fn()){for(const client of clients)if(client.error)throw client.error;assert.deepEqual(errors,[]);assert.ok(Date.now()<deadline,`Six consumer deadline: ${label}`);await delay(5);}
}
async function connect({kind='display',grant,label=kind,ack=true}={}){
 const c={kind,label,ack,frames:[],messages:[],gate:new LiveFrameGate({requireResourceMemory:true}),renderer:new SceneRenderer(ck)};clients.push(c);
 const ws=c.ws=new WebSocket(grant?.url??`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`,{origin:transport.origin});
 ws.on('error',e=>c.error=e);ws.on('close',(code,reason)=>c.closed={code,reason:reason.toString()});
 ws.on('message',(bytes,binary)=>{try{
  if(binary){const resource=decodeResource(bytes);assert.equal(hash(resource.payload),resource.id);c.gate.put(resource.id,resource.payload);return;}
  const m=JSON.parse(bytes);if(m.type!=='SceneUpdate'&&m.type!=='FrameCommit'&&m.type!=='ResourceManifest'){c.messages.push(m.type);assert.ok(c.messages.length<256);}
  if(m.type==='Welcome'){c.welcome=m;return;}
  if(m.type==='ResourceRelease'){for(const id of m.ids)c.gate.release(id);c.renderer.retain(new Set(c.gate.resources.keys()));return;}
  if(m.type==='SceneUpdate'){c.gate.stage(m.frame);return;}
  if(m.type==='FrameCommit'){
   const frame=c.gate.commit(m.pageEpoch,m.frameId);assert.ok(frame);const out=c.renderer.render(frame.scene,c.gate.resources,ck.WHITE,frame.resourceMemory?.resources);
   let image,dom;try{const pixel=x=>[...out.image.readPixels(x,8,{width:1,height:1,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB})];image=pixel(8);dom=pixel(72);}finally{out.image.delete();out.surface?.dispose();}
   assert.deepEqual(image,dom);const color=colors.findIndex(value=>value.every((n,i)=>n===image[i]));assert.ok(color>=0);
   c.frames.push({phase,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,width:frame.viewport.cssWidth,frameId:frame.frameId,captureOrdinal:frame.native.captureOrdinal,sourceFrame:frame.native.sourceFrame,inputSeq:frame.lastProcessedInputSeq,color,image,dom,resources:frame.requiredResources.length});assert.ok(c.frames.length<256);
   if(c.ack)ws.send(JSON.stringify({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:kind==='display'?'scene-submitted':'consumer-released'}));
  }
 }catch(e){c.error=e;ws.terminate();}});
 await once(ws,'open');ws.send(JSON.stringify({type:'Hello',protocol:4,renderer:transport.renderer,consumerKind:kind,capabilities:['frame-window-v1','resource-memory-v1',...(kind==='display'?[]:['scene-consumer-v1'])],frameWindow:1}));await until(()=>c.welcome,'welcome '+label);return c;
}
async function close(c){if(!c.closed){c.ws.close();await until(()=>c.closed,'close '+c.label);}c.renderer.clear();c.gate.clear();}
async function color(c,n,fields={}){await until(()=>c.frames.some(frame=>frame.color===n&&Object.entries(fields).every(([key,value])=>frame[key]===value)),'pixels '+c.label);return c.frames.find(frame=>frame.color===n&&Object.entries(fields).every(([key,value])=>frame[key]===value));}
async function denied(url){const ws=new WebSocket(url,{origin:transport.origin});ws.on('error',()=>{});const response=await Promise.race([once(ws,'unexpected-response').then(([,res])=>{res.resume();return res.statusCode;}),delay(3000).then(()=>{throw new Error('Admission rejection deadline');})]);ws.terminate();assert.equal(response,403);return response;}
try{
 ck=await CanvasKitInit({locateFile:()=>createRequire(import.meta.url).resolve('canvaskit-wasm/bin/full/canvaskit.wasm')});
 source=await startLiveSource({url:`http://127.0.0.1:${fixture.address().port}`,viewport:{width:320,height:180}});assert.equal(source.nativeAutopublish,true);source.on('captureError',e=>errors.push(e.message));
 const request=source.broker.request.bind(source.broker);source.broker.request=(op,args)=>{if(op==='map'||op==='publish')nodeCalls[op]++;return request(op,args);};
 const send=source.capture.cdp.send.bind(source.capture.cdp);source.capture.cdp.send=(op,args)=>{if(op==='Runtime.evaluate')nodeCalls.evaluate++;if(op==='Runtime.awaitPromise')nodeCalls.awaitPromise++;return send(op,args);};
 const load=source.acquirePageRun();try{await source.page.evaluate(()=>window.ready);}finally{load();}
 source.control=await createControl(source);const attach=source.control.attach.bind(source.control);source.control.attach=peer=>{assert.equal(peer.kind,'display');attached.push(peer.id);assert.ok(attached.length<=4);return attach(peer);};
 transport=await startLiveTransport(source,{port:0,ackTimeout:5000});
 const displays=[];for(let n=0;n<4;n++){const c=await connect({label:'display-'+n});await color(c,0);displays.push(c);}
 const observationFence=await source.getConsumerFence(),observation=await connect({kind:'observation',grant:await transport.createConsumerTicket('observation')});await color(observation,0);
 const recordingFence=await source.getConsumerFence(),recording=await connect({kind:'recording',grant:await transport.createConsumerTicket('recording')});await color(recording,0);
 await until(()=>source.encodeDemand===6&&source.control.peers.size===4,'all six native demands');
 assert.equal(source.demand,4);assert.equal(source.demandState.observation,1);assert.equal(source.demandState.recording,1);assert.equal(attached.length,4);
 for(const [client,fence]of [[observation,observationFence],[recording,recordingFence]]){assert.ok(client.frames[0].captureOrdinal>fence.captureOrdinal);assert.equal(client.welcome.input,false);assert.equal(client.welcome.control,null);assert.equal(client.welcome.ackStage,'consumer-released');}
 diagnostics.sixPeer=await source.broker.request('resourceBudget');assert.equal(diagnostics.sixPeer.gatewayState.peer.owners,6);assert.ok(diagnostics.sixPeer.gatewayState.bytes<=diagnostics.sixPeer.gatewayState.limit);
 await denied(`${transport.streamOrigin.replace('http','ws')}/stream?key=${transport.key}`);await denied((await transport.createConsumerTicket('recording')).url);
 checks.push('four actual displays plus two separately fenced read-only observation/recording clients receive real PNG+DOM CanvasKit pixels; fifth display and third automation are denied while all six owners and demand counts stay bounded');

 phase='six-pixels';await source.page.evaluate(()=>select(1));for(const client of [...displays,observation,recording])await color(client,1);checks.push('all six real clients advance to the same changed green PNG and DOM pixels using role-specific ACK stages');
 phase='input';await until(()=>!source.transitioning,'human lease readiness');const humanFence=await source.getConsumerFence(),human=await source.control.acquire(displays[0].welcome.peerId,{sessionId:source.control.sessionId,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion});
 for(const type of ['keyDown','keyUp']){const seq=source.control.nextSeq;assert.equal((await source.control.input(displays[0].welcome.peerId,{...human,seq,event:{kind:'key',type,key:'1',code:'Digit1',windowsVirtualKeyCode:49}})).accepted,true);}
 await source.capture.work;const nativeInput=await source.capture.command('inspect',source.capture.binding.config.id);
 for(const client of [...displays,observation,recording]){const frame=await color(client,2,{inputSeq:2});assert.ok(frame.captureOrdinal>humanFence.captureOrdinal);assert.ok(frame.sourceFrame>=nativeInput.minimumSourceFrame);}
 const seq=source.inputSeq;observation.ws.send(JSON.stringify({type:'AcquireControl'}));await until(()=>observation.closed,'read-only control rejection');assert.equal(observation.closed.code,1008);assert.equal(source.inputSeq,seq);assert.equal(source.control.mode,'human');assert.equal(source.control.holder,displays[0].welcome.peerId);
 assert.ok(!observation.messages.some(type=>['ControlGranted','InputAck','FeedbackState','ControlWelcome','ControlState'].includes(type)));checks.push('real human key ACKs propagate input2 and native SourceFrame floor to all six clients; read-only control attempt closes only that observer with1008 and preserves the human lease/input sequence');

 phase='navigation';const oldEpoch=source.pageEpoch,observer=await connect({kind:'observation',grant:await transport.createConsumerTicket('observation')});await color(observer,2,{inputSeq:2});await source.page.goto(`http://127.0.0.1:${fixture.address().port}/new-document`);await until(()=>source.pageEpoch===oldEpoch+1&&observer.closed,'observation document fence');assert.equal(observer.closed.code,1012);
 for(const client of [...displays,recording])await color(client,0,{pageEpoch:source.pageEpoch,inputSeq:2});assert.equal(source.control.mode,'agent');
 phase='resize';const resizingObserver=await connect({kind:'observation',grant:await transport.createConsumerTicket('observation')});await color(resizingObserver,0,{pageEpoch:source.pageEpoch});await source.resize({width:384,height:240});await until(()=>resizingObserver.closed,'observation viewport fence');assert.equal(resizingObserver.closed.code,1012);
 for(const client of [...displays,recording])await color(client,0,{pageEpoch:source.pageEpoch,viewportVersion:2,width:384,inputSeq:2});checks.push('four actual displays and continuous recording survive new real document epoch and viewport2/384px; each observation target fence closes with1012 rather than accepting another target');

 phase='slow-recording';const slow=await connect({kind:'recording',label:'slow-recording',grant:await transport.createConsumerTicket('recording'),ack:false});await color(slow,0,{viewportVersion:2});const counts=displays.map(c=>c.frames.length),start=performance.now();let updates=0;
 while(!slow.closed){await source.page.evaluate(n=>select(n),updates++%2);await delay(40);assert.ok(performance.now()-start<8000,'Default5s slow recorder eviction deadline');for(const client of clients)if(client.error)throw client.error;}
 assert.equal(slow.closed.code,1013);assert.ok(displays.every((client,n)=>client.frames.length>counts[n]+3));await until(()=>source.demandState.recording===1,'slow recording demand released');diagnostics.slow={ackTimeoutMs:5000,closeCode:slow.closed.code,elapsedMs:performance.now()-start,displayFrames:displays.map((c,n)=>c.frames.length-counts[n]),updates};checks.push('second actual recorder withholds ACK under the unchanged5s deadline and is evicted1013; all four displays and the first recorder continue, with no global capture stall');

 phase='recording-only';for(const c of displays)await close(c);await until(()=>source.demand===0&&source.encodeDemand===1&&source.control.peers.size===0,'only recorder remains');await source.page.evaluate(()=>select(2));await color(recording,2,{pageEpoch:source.pageEpoch,viewportVersion:2});assert.equal(source.frameDriver.running,true);checks.push('after all four displays disconnect, the remaining actual recorder keeps native encoding and the independent page clock running');
 await close(recording);await until(()=>source.encodeDemand===0,'last encoding demand released');await source.capture.drain();await until(()=>!source.capture.work&&!source.frameDriver.running,'actual native drain and idle clock');
 await transport.close();diagnostics.finalBudget=await source.broker.request('resourceBudget');assert.equal(diagnostics.finalBudget.gatewayState.peer.owners,0);assert.equal(diagnostics.finalBudget.gatewayState.route.owners,0);assert.equal(transport.peers.size,0);assert.equal(source.control.peers.size,0);assert.equal(source.demandState.clock,0);
 assert.equal(source.stats.errors,0);assert.equal(source.stats.resourceRecoveries,0);assert.deepEqual(errors,[]);assert.deepEqual({map:nodeCalls.map,publish:nodeCalls.publish,awaitPromise:nodeCalls.awaitPromise},{map:0,publish:0,awaitPromise:0});assert.equal(Object.hasOwn(source.latest,'scene'),false);assert.equal(Object.hasOwn(source.latest,'payloads'),false);diagnostics.finalStats={...source.stats};diagnostics.finalDemand=source.demandState;checks.push('last consumer close drains actual C++ credit, stops the clock and releases all Gateway peer/route and control owners; default Source has scalar metadata and no Node map/publish/awaitPromise');
}catch(error){failure=error.stack;}
finally{
 for(const client of clients){client.ws.terminate();client.renderer.clear();client.gate.clear();}
 for(const close of [()=>transport?.close(),()=>source?.control?.close(),()=>source?.close()])try{await close();}catch(error){cleanupErrors.push(error.message);}
 await new Promise(resolve=>fixture.close(resolve));
}
const cleanup={brokerExited:source?.broker.exited,pending:source?.broker.pending.size,requestOwners:source?.broker.requestMemory.stats().owners,responseOwners:source?.broker.responses.stats().owners,browserConnected:source?.browser.isConnected(),sourceLatest:source?.latest,cleanupErrors};
if(!failure)try{assert.deepEqual(cleanup,{brokerExited:true,pending:0,requestOwners:0,responseOwners:0,browserConnected:false,sourceLatest:null,cleanupErrors:[]});}catch(error){failure=error.stack;}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Actual default autonomous NativeSource/Chromium PNG+DOM/native Gateway/six real WebSocket+FrameGate+CanvasKit clients:4display+2read-onlyautomation slots,actual ordinal/input/target fences,real key input2,navigation/resize,default5s slow-recorder isolation and owner/clock drain. Clients run in this verifier process;not six full browser processes,physical GPU,network impairment/full B1 or SDK tenant-auth acceptance.',browserSha256:hash(await readFile(process.env.REMOTE_PAINT_CHROMIUM)),brokerSha256:hash(await readFile(process.env.REMOTE_PAINT_BROKER)),phase,checks,nodeCalls,diagnostics,errors,clients:clients.map(c=>({label:c.label,kind:c.kind,frames:c.frames,closed:c.closed,error:c.error?.message,messageTypes:c.messages})),cleanup,...(failure?{error:failure}:{})};
await writeFile(output+'/six.json',JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,checks:checks.length,nodeCalls,slow:diagnostics.slow,cleanup,error:failure}));if(failure)throw new Error(failure);
