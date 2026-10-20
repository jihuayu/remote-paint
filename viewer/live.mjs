import {ViewerInput} from '/input.mjs';
import {isHash} from '/protocol/wire.mjs';
import {decodeAsset,AssetCache} from '/protocol/asset-wire.mjs';
import {LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired} from '/protocol/live-wire.mjs';
import {RendererRuntime} from '/renderer-runtime.mjs';
import {ClientMemory,memoryPolicy} from '/protocol/client-memory.mjs';
import {parseMetadataJson} from '/protocol/metadata-json.mjs';
import {ControlLink} from '/control-channel.mjs';
import {ViewerLifecycle} from '/lifecycle.mjs';
import {ViewerConnection,ViewerTicketSource,ViewerConnectionError} from '/connection.mjs';
const VIEWER_BUILD='__REMOTE_PAINT_VIEWER_BUILD__',EXPECTED_WASM_SHA='__REMOTE_PAINT_WASM_SHA__';
const $=id=>document.getElementById(id),status=text=>$('status').textContent=text;
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const input=new ViewerInput({canvas:$('viewport'),proxy:$('inputProxy'),button:$('control'),label:$('controlState'),feedbackLabel:$('feedbackState'),overlay:$('optimisticOverlay'),pointerOverlay:$('pointerOverlay'),send:message=>{if(controlLink.send(message))return;if(streamWorker)streamWorker.postMessage({type:'send',message});else if(socket?.readyState===1)socket.send(JSON.stringify(message));}});
let ticketSource=null,publicSettings=null,publicConnection=null;const workerTickets=new Map();
let streamWorker,renderer,presenter,socket,cleanupSession,cancelInitialization,heartbeat,lastPong,forceMainThread=false,generation=0,retryTimer,stopped=false,retryDelay=250;
const controlLink=new ControlLink({onMessage:message=>{if(message.type==='CaptureError')status(message.message);else input.message(message);},onError:fail,onClose:peerId=>{input.reset();if(stopped)return;if(streamWorker)streamWorker.postMessage({type:'control-lost',peerId});else socket?.close(1012,'Control connection closed');}});
function fail(error){$('error').hidden=false;$('error').textContent=error.message;status('绘制通道中断');document.body.dataset.ready='false';}
function connectionState(state){window.remotePaintConnection=state;window.dispatchEvent(new CustomEvent('remote-paint-connection',{detail:state}));}
function abortWorkerTickets(){for(const request of workerTickets.values())request.controller.abort();workerTickets.clear();}
function workerMessage({data}){
 if(data.type==='connection-cancel'){const request=workerTickets.get(data.requestId);if(request?.worker===streamWorker){request.controller.abort();workerTickets.delete(data.requestId);}return;}
 if(data.type==='connection-request'){
  const worker=streamWorker,id=data.requestId;
  if(!Number.isSafeInteger(id)||id<1||!['connect','reconnect','refresh'].includes(data.reason)||!ticketSource||!publicSettings||workerTickets.size){worker?.postMessage({type:'connection-ticket',requestId:id,error:'VIEWER_TICKET_BUSY'});return;}
  const request={worker,controller:new AbortController()};workerTickets.set(id,request);
  void ticketSource.getTicket({signal:request.controller.signal,reason:data.reason}).then(grant=>{if(!request.controller.signal.aborted&&worker===streamWorker)worker.postMessage({type:'connection-ticket',requestId:id,grant});},error=>{if(!request.controller.signal.aborted&&worker===streamWorker)worker.postMessage({type:'connection-ticket',requestId:id,error:new ViewerConnectionError(error.code).code});}).finally(()=>{if(workerTickets.get(id)===request)workerTickets.delete(id);});return;
 }
 if(data.type==='connection-state'){connectionState(data.state);return;}
 if(data.type==='pong'){lastPong=Date.now();return;}
 if(data.type==='ready')window.remotePaintStartup=data.startup;
 else if(data.type==='welcome'){input.welcome(data.message);controlLink.open(data.streamUrl,data.message);$('build').textContent=`${data.message.producer.chromium} · Skia ${data.message.producer.skiaRevision.slice(0,12)} · CanvasKit ${data.message.renderer.canvaskit}`;}
 else if(data.type==='control')input.message(data.message);
 else if(data.type==='reset'){controlLink.reset();input.reset();document.body.dataset.ready='false';}
 else if(data.type==='status')status(data.text);
 else if(data.type==='error')fail(new Error(data.message));
 else if(data.type==='memory')window.remotePaintMemory=data.memory;
 else if(data.type==='cache'){window.remotePaintMemory=data.memory;if(window.remotePaintResult){window.remotePaintResult.resources=data.resources;window.remotePaintResult.resourceBytes=data.resourceBytes;window.remotePaintResult.memory=data.memory;}}
 else if(data.type==='frame'){
  const {frame,result}=data;generation=Math.max(generation,result.connectionGeneration);result.viewerGeneration=lifecycle.version;input.display(frame);window.remotePaintMemory=result.memory;$('error').hidden=true;
  $('frame').textContent=`第 ${frame.frameId} 帧`;$('mode').textContent=frame.baseFrameId===null?'完整场景':'增量更新';$('dimensions').textContent=`${frame.viewport.cssWidth} × ${frame.viewport.cssHeight}`;$('renderTime').textContent=`重放 ${result.renderMs.toFixed(1)} ms`;$('bytes').textContent=`缓存 ${(result.resourceBytes/1024).toFixed(0)} KiB`;document.body.dataset.ready='true';status('实时绘制中');window.remotePaintResult=result;
 }
}
function workerFailed(worker,error){
 if(worker!==streamWorker||!lifecycle.runnable)return;
 forceMainThread=true;lifecycle.restart('worker-failure');status('绘制线程中断，正在恢复兼容模式');
}
async function initialize(version){
 const canvas=$('viewport'),current=()=>lifecycle.current(version);
 if(typeof Worker==='function'&&typeof canvas.transferControlToOffscreen==='function'&&!forceMainThread&&!new URLSearchParams(location.search).has('mainThread')){
  const worker=new Worker('/stream-worker.mjs',{type:'module'});streamWorker=worker;
  worker.addEventListener('message',event=>{if(worker===streamWorker&&current())workerMessage(event);});
  worker.addEventListener('error',event=>{event.preventDefault();workerFailed(worker,event);});
  worker.addEventListener('messageerror',event=>workerFailed(worker,event));
  let cancel,timer;
  try{await new Promise((resolve,reject)=>{
   cancel=()=>reject(new Error('Viewer initialization canceled'));cancelInitialization=cancel;
   const listener=({data})=>{if(data.type==='ready'||data.type==='error'){worker.removeEventListener('message',listener);data.type==='ready'?resolve():reject(new Error(data.message));}};worker.addEventListener('message',listener);
   timer=setTimeout(()=>workerFailed(worker,new Error('Worker startup timeout')),20000);
   const offscreen=canvas.transferControlToOffscreen();worker.postMessage({type:'init',canvas:offscreen,connectionGenerationBase:generation,memoryProfile:new URLSearchParams(location.search).get('memory')??undefined,gpu:new URLSearchParams(location.search).has('cpu')?false:new URLSearchParams(location.search).has('gpu')?true:'auto'},[offscreen]);
  });}finally{clearTimeout(timer);if(cancelInitialization===cancel)cancelInitialization=null;}
 }else{
  const memory=new ClientMemory(memoryPolicy({profile:new URLSearchParams(location.search).get('memory')??undefined})),controller=new AbortController(),cancel=()=>controller.abort();cancelInitialization=cancel;
  let releaseWasm;
  try{
   const started=performance.now(),wasmBinary=await(await fetch('/vendor/canvaskit.wasm',{cache:'force-cache',signal:controller.signal})).arrayBuffer(),fetched=performance.now();if(!current())return false;
   releaseWasm=memory.buffer('wasmDownload',wasmBinary);const wasmSha256=await digest(wasmBinary);if(!current())return false;if(wasmSha256!==EXPECTED_WASM_SHA)throw new Error('Viewer Wasm integrity mismatch');
   const verified=performance.now(),ck=await CanvasKitInit({wasmBinary,locateFile:file=>`/vendor/${file}`});if(!current()){memory.retire(ck);return false;}
   const initialized=performance.now();renderer={canvaskit:'0.42.0',wasmSha256};presenter=new RendererRuntime(ck,canvas,{memory,factory:CanvasKitInit,wasmBinary,locateFile:file=>`/vendor/${file}`,gpu:new URLSearchParams(location.search).has('cpu')?false:new URLSearchParams(location.search).has('gpu')?true:'auto'});window.remotePaintStartup={wasmFetchMs:fetched-started,wasmVerifyMs:verified-fetched,wasmInitMs:initialized-verified,wasmBytes:wasmBinary.byteLength,presentation:presenter.presentation.mode,worker:false};
  }finally{releaseWasm?.();if(cancelInitialization===cancel)cancelInitialization=null;}
 }
 return current();
}
const draw=(frame,resources)=>presenter.draw(frame,resources);
async function connect(){
 if(stopped)return;clearTimeout(retryTimer);cleanupSession?.();const current=++generation;controlLink.reset();socket?.close();input.reset();presenter?.clear();
 document.body.dataset.ready='false';$('error').hidden=true;status('连接绘制通道');
 if(publicSettings){
  publicConnection?.destroy();publicConnection=null;
  if(streamWorker){streamWorker.postMessage({type:'connect',connection:publicSettings});return;}
  publicConnection=new ViewerConnection({...publicSettings,getTicket:request=>ticketSource.getTicket(request),onSocket:(ws,grant,auth)=>attachStream(ws,++generation,auth),onState:connectionState,onError:error=>fail(error)});
  await publicConnection.start();return;
 }
 if(streamWorker){streamWorker.postMessage({type:'connect',key:new URLSearchParams(location.hash.slice(1)).get('key')});return;}
 const key=new URLSearchParams(location.hash.slice(1)).get('key');if(!key)throw new Error('请使用服务端输出的完整 Viewer 链接');
 const config=await fetch('/session-config').then(response=>response.json());if(current!==generation||stopped||!lifecycle.runnable)return;
 const streamHost=config.nativePort?`${location.hostname}:${config.nativePort}`:location.host;
 const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${streamHost}/stream?key=${encodeURIComponent(key)}`);attachStream(ws,current);
}
function attachStream(ws,current,authorization=null){
 cleanupSession?.();controlLink.reset();socket?.close();input.reset();presenter?.clear();socket=ws;ws.binaryType='arraybuffer';document.body.dataset.ready='false';$('error').hidden=true;

 const memory=presenter.memory,gate=new LiveFrameGate({memory}),assets=new AssetCache({memory});let rejection,closed=false,welcome=false,receivedBytes=0,resourcesReceived=0,full=0,delta=0,recovering=false;
 const cleanup=()=>{if(closed)return;closed=true;gate.clear();assets.dispose();if(current===generation){presenter.clear();window.remotePaintMemory=memory.snapshot();}};cleanupSession=cleanup;
 const send=message=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));};
 const recover=()=>{gate.recover();assets.clear();presenter.retain(new Set(gate.resources.keys()));if(!recovering){recovering=true;status('重新同步完整场景');send({type:'RequestKeyframe'});}};
 ws.onopen=()=>send({type:'Hello',protocol:LIVE_VERSION,renderer,viewerBuild:VIEWER_BUILD,capabilities:['asset-chunks-v1','frame-window-v1','control-channel-v1','input-feedback-v1','resource-memory-v1'],frameWindow:6});
 let queue=Promise.resolve(),queuedBytes=0;
 ws.onmessage=event=>{
  if(closed)return;
  let size,parsed,releaseQueue;
  try{
   if(typeof event.data==='string'){const metadata=parseMetadataJson(event.data,{memory,maxBytes:LIVE_LIMITS.sceneBytes});size=metadata.byteLength;parsed=metadata.value;releaseQueue=metadata.release;}
   else if(event.data instanceof ArrayBuffer){size=event.data.byteLength;releaseQueue=memory.buffer('receive',event.data);}
   else throw new Error('Unsupported socket payload');
   // Control metadata keeps socket order and bypasses expensive scene work,
   // but passes the same bounded parser and pre-allocation admission first.
   if(welcome&&parsed&&['ControlState','ControlGranted','ControlDenied','InputAck','FeedbackState'].includes(parsed.type)){
    try{if(current===generation){receivedBytes+=size;input.message(parsed);}}finally{releaseQueue();}return;
   }
   if(queuedBytes+size>memory.policy.receive)throw Object.assign(new Error('Receive queue budget exceeded'),{closeCode:1013});
   queuedBytes+=size;
  }catch(error){releaseQueue?.();rejection=error.message;fail(error);ws.close(error.closeCode??4008,'Viewer metadata/memory limit');return;}
  queue=queue.then(async()=>{
   try{
    if(closed||current!==generation)return;receivedBytes+=size;
    if(event.data instanceof ArrayBuffer){
     if(!welcome)throw new Error('Resource before handshake');const {kind,id,payload}=decodeAsset(event.data);
     const release=memory.reserve('shaWork',payload.byteLength,'browser');try{if(await digest(payload)!==id)throw new Error('Resource checksum mismatch');}finally{release();}if(closed||current!==generation)return;if(kind==='chunk')assets.put(id,payload);else{gate.put(id,payload);resourcesReceived++;}return;
    }
    if(size>LIVE_LIMITS.sceneBytes)throw new Error('Metadata budget exceeded');const message=parsed;
    if(message.type==='Welcome'){
     if(welcome||message.protocol!==LIVE_VERSION||message.renderer?.wasmSha256!==renderer.wasmSha256||message.renderer?.canvaskit!==renderer.canvaskit||message.mode!=='live-skia-viz'||typeof message.input!=='boolean'||typeof message.resourceMemory!=='boolean')throw new Error('Incompatible live handshake');
     authorization?.acceptWelcome(message);welcome=true;gate.requireResourceMemory=message.resourceMemory;memory.decodeAdmission=message.resourceMemory?'complete-resource-index-v1':'explicit-legacy-source';input.welcome(message);controlLink.open(ws.url,message);retryDelay=250;$('build').textContent=`${message.producer.chromium} · Skia ${message.producer.skiaRevision.slice(0,12)} · CanvasKit ${renderer.canvaskit}`;return;
    }
    if(!welcome)throw new Error('Message before handshake');
    if(input.message(message))return;
    if(message.type==='ResourceManifest'){const payload=assets.assemble(message);if(payload)try{const release=memory.reserve('shaWork',payload.byteLength,'browser');try{if(await digest(payload)!==message.id)throw new Error('Assembled resource checksum mismatch');}finally{release();}if(closed||current!==generation)return;gate.put(message.id,payload);resourcesReceived++;}finally{assets.releaseAssembly(payload);}return;}
    if(message.type==='ChunkCacheReset'){assets.clear();return;}
    if(message.type==='SceneUpdate'){
     try{gate.stage(message.frame);}catch(error){if(error instanceof RecoveryRequired){recover();return;}throw error;}
    }else if(message.type==='FrameCommit'){
     if(recovering&&!gate.pending)return;
     const started=performance.now();const frame=await gate.commitAsync(message.pageEpoch,message.frameId,draw);
     if(closed||current!==generation)return;
     if(!frame){recover();return;}
     input.display(frame);presenter.retain(new Set(gate.resources.keys()));
     if(frame.baseFrameId===null)full++;else delta++;recovering=false;
     const renderMs=performance.now()-started;$('error').hidden=true;
     $('frame').textContent=`第 ${frame.frameId} 帧`;$('mode').textContent=frame.baseFrameId===null?'完整场景':'增量更新';
     $('dimensions').textContent=`${frame.viewport.cssWidth} × ${frame.viewport.cssHeight}`;$('renderTime').textContent=`重放 ${renderMs.toFixed(1)} ms`;$('bytes').textContent=`缓存 ${(gate.bytes/1024).toFixed(0)} KiB`;
     document.body.dataset.ready='true';status('实时绘制中');
     window.remotePaintResult={protocol:LIVE_VERSION,viewerGeneration:lifecycle.version,connectionGeneration:current,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,frameId:frame.frameId,
      native:frame.native,lastProcessedInputSeq:frame.lastProcessedInputSeq,resourceBytes:gate.bytes,resources:gate.resources.size,
      resourcesReceived,receivedBytes,fullFrames:full,deltaFrames:delta,renderMs,requiredResources:frame.requiredResources,rendererStats:{...presenter.stats},presentation:{...presenter.presentation}};
     window.remotePaintMemory=window.remotePaintResult.memory=memory.observe(presenter.ck,presenter.gr);send({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'});
    }else if(message.type==='ResourceRelease'){
     if(!Array.isArray(message.ids)||message.ids.length>512||!message.ids.every(isHash))throw new Error('Invalid resource release');for(const id of message.ids)gate.release(id);presenter.retain(new Set(gate.resources.keys()));
     window.remotePaintMemory=memory.snapshot();if(window.remotePaintResult){window.remotePaintResult.resources=gate.resources.size;window.remotePaintResult.resourceBytes=gate.bytes;window.remotePaintResult.memory=window.remotePaintMemory;}
    }else if(message.type==='CaptureError'){status(message.message);}
    else throw new Error('Unknown message');
   }catch(error){if(!closed&&current===generation){rejection=error.message;fail(error);ws.close(4008,'Viewer rejected frame');}}
   finally{queuedBytes-=size;releaseQueue();}
  });
 };
 ws.onclose=event=>{
  cleanup();if(current!==generation||stopped)return;controlLink.reset();input.reset();document.body.dataset.ready='false';
  if(authorization)return;
  if(event.code===1008||event.code===4008){fail(new Error(rejection||event.reason||'连接与当前 Viewer 版本不兼容'));status('连接被拒绝，请检查错误后重新连接');return;}
  status('连接中断，正在重新同步');retryTimer=setTimeout(()=>connect().catch(fail),retryDelay);retryDelay=Math.min(2000,retryDelay*2);
 };
 ws.onerror=()=>{if(current===generation)status('连接暂时不可用，等待重连');};
}
function teardownViewer(){
 publicConnection?.destroy();publicConnection=null;abortWorkerTickets();
 clearInterval(heartbeat);heartbeat=null;clearTimeout(retryTimer);cancelInitialization?.();cancelInitialization=null;
 cleanupSession?.();cleanupSession=null;generation++;controlLink.reset();input.reset();input.frame=null;socket?.close();socket=null;
 streamWorker?.terminate();streamWorker=null;presenter?.dispose();presenter=null;renderer=null;
 const previous=$('viewport'),canvas=previous.cloneNode(false);canvas.width=0;canvas.height=0;previous.replaceWith(canvas);input.bindCanvas(canvas);
 document.body.dataset.ready='false';window.remotePaintResult=null;window.remotePaintMemory=null;
}
function watchViewer(){
 clearInterval(heartbeat);lastPong=Date.now();
 heartbeat=setInterval(()=>{
  const now=Date.now();if(lifecycle.tick(now))return;
  if(streamWorker){if(now-lastPong>10000){workerFailed(streamWorker,new Error('Worker heartbeat timeout'));return;}streamWorker.postMessage({type:'ping',nonce:now});}
 },1000);
}
const lifecycle=new ViewerLifecycle({hidden:document.hidden,start:async version=>{if(await initialize(version)&&lifecycle.current(version)){watchViewer();await connect();}},stop:teardownViewer,onError:fail,onState:state=>{
 window.remotePaintLifecycle={...state,backend:forceMainThread?'main-fallback':streamWorker?'worker':'main'};
 if(state.state==='suspended')status('显示已暂停');
}});
$('reconnect').onclick=()=>lifecycle.restart('manual');
document.addEventListener('visibilitychange',()=>lifecycle.visibility(document.hidden));
document.addEventListener('freeze',()=>lifecycle.freeze());
document.addEventListener('resume',()=>{if(stopped)return;lifecycle.hidden=document.hidden;lifecycle.resume();});
window.addEventListener('pagehide',event=>{if(event.persisted)lifecycle.freeze();else{stopped=true;lifecycle.close();ticketSource?.destroy();}});
window.addEventListener('pageshow',()=>{if(stopped)return;lifecycle.hidden=document.hidden;lifecycle.resume();});
window.addEventListener('online',()=>{if(lifecycle.runnable)lifecycle.restart('online');});
window.remotePaintViewer=Object.freeze({
 connect(options){
  if(ticketSource?.busy)throw new ViewerConnectionError('VIEWER_TICKET_BUSY');
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.getPrototypeOf(options)!==null&&Object.getPrototypeOf(Object.getPrototypeOf(options))!==null||Reflect.ownKeys(options).some(k=>!Object.hasOwn(Object.getOwnPropertyDescriptor(options,k),'value')))throw new ViewerConnectionError('VIEWER_INVALID_CONFIG');
  const next=new ViewerTicketSource({...options,audience:location.origin});
  ticketSource?.destroy();ticketSource=next;publicSettings=next.settings;stopped=false;lifecycle.frozen=false;lifecycle.restart('public-ticket');
 },
 disconnect(){const state=window.remotePaintConnection??{...publicSettings};stopped=true;ticketSource?.destroy();lifecycle.freeze();connectionState({...state,state:'paused'});},
 get state(){return window.remotePaintConnection??{state:'paused'};}
});
if(document.hidden)lifecycle.suspend('hidden');else void lifecycle.run();
