import {ViewerInput} from '/input.mjs';
import {decodeResource,isHash} from '/protocol/wire.mjs';
import {LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired} from '/protocol/live-wire.mjs';
import {SceneRenderer} from '/scene-renderer.mjs';
const $=id=>document.getElementById(id),status=text=>$('status').textContent=text;
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const input=new ViewerInput({canvas:$('viewport'),proxy:$('inputProxy'),button:$('control'),label:$('controlState'),overlay:$('optimisticOverlay'),send:message=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));}});
let ck,renderer,sceneRenderer,renderWorker,workerSeq=0,workerReady,socket,generation=0,retryTimer,stopped=false,retryDelay=250;
function fail(error){$('error').hidden=false;$('error').textContent=error.message;status('绘制通道中断');document.body.dataset.ready='false';}
const clearRenderer=()=>{if(renderWorker)renderWorker.postMessage({type:'clear',id:++workerSeq});else sceneRenderer?.clear();};
const retainRenderer=ids=>{if(renderWorker)renderWorker.postMessage({type:'retain',id:++workerSeq,ids:[...ids]});else sceneRenderer?.retain(ids);};
async function initialize(){
 const wasmBinary=await(await fetch('/vendor/canvaskit.wasm')).arrayBuffer();renderer={canvaskit:'0.42.0',wasmSha256:await digest(wasmBinary)};
 const canvas=$('viewport');
 if(typeof Worker==='function'&&typeof canvas.transferControlToOffscreen==='function'){
  const offscreen=canvas.transferControlToOffscreen();renderWorker=new Worker('/render-worker.mjs',{type:'module'});
  workerReady=new Promise((resolve,reject)=>{const id=++workerSeq;const onMessage=event=>{if(event.data.id!==id)return;renderWorker.removeEventListener('message',onMessage);event.data.type==='ready'?resolve():reject(new Error(event.data.message??'Render worker initialization failed'));};renderWorker.addEventListener('message',onMessage);renderWorker.postMessage({type:'init',id,canvas:offscreen,scriptUrl:'/vendor/canvaskit.js',wasmUrl:'/vendor/canvaskit.wasm'},[offscreen]);});
  await workerReady;
 }else{ck=await CanvasKitInit({wasmBinary,locateFile:file=>`/vendor/${file}`});sceneRenderer=new SceneRenderer(ck,{incremental:true});}
}
function draw(frame,resources){
 if(renderWorker){
  const id=++workerSeq,needed=frame.requiredResources.map(resourceId=>({id:resourceId,buffer:resources.get(resourceId).slice().buffer}));
  return new Promise((resolve,reject)=>{const onMessage=event=>{if(event.data.id!==id)return;renderWorker.removeEventListener('message',onMessage);event.data.type==='rendered'?resolve(event.data.renderMs):reject(new Error(event.data.message??'Render worker failed'));};renderWorker.addEventListener('message',onMessage);renderWorker.postMessage({type:'render',id,frame,resources:needed},needed.map(item=>item.buffer));});
 }
 const output=sceneRenderer.render(frame.scene,resources,ck.WHITE);
 try{
  const canvas=$('viewport'),{cssWidth:width,cssHeight:height}=frame.viewport;
  const pixels=output.image.readPixels(0,0,{width,height,colorType:ck.ColorType.RGBA_8888,
   alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB});
  if(!pixels||pixels.byteLength!==width*height*4)throw new Error('Cannot read completed Viewer pixels');
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  const context=canvas.getContext('2d');if(!context)throw new Error('Cannot allocate Viewer canvas');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),width,height),0,0);
 }finally{if(output.release)output.release();else{output.image.delete();output.surface.dispose();}}
}
async function connect(){
 if(stopped)return;clearTimeout(retryTimer);const current=++generation;socket?.close();input.reset();clearRenderer();
 document.body.dataset.ready='false';$('error').hidden=true;status('连接绘制通道');if(renderWorker)renderWorker.postMessage({type:'clear',id:++workerSeq});
 const key=new URLSearchParams(location.hash.slice(1)).get('key');if(!key)throw new Error('请使用服务端输出的完整 Viewer 链接');
 const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/stream?key=${encodeURIComponent(key)}`);socket=ws;ws.binaryType='arraybuffer';
 const gate=new LiveFrameGate();let welcome=false,receivedBytes=0,resourcesReceived=0,full=0,delta=0,recovering=false;
 const send=message=>{if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));};
 const recover=()=>{gate.recover();retainRenderer(new Set(gate.resources.keys()));if(!recovering){recovering=true;status('重新同步完整场景');send({type:'RequestKeyframe'});}};
 ws.onopen=()=>send({type:'Hello',protocol:LIVE_VERSION,renderer});
 let queue=Promise.resolve(),queuedBytes=0;
 ws.onmessage=event=>{
  const size=typeof event.data==='string'?new TextEncoder().encode(event.data).byteLength:event.data.byteLength;
  if((queuedBytes+=size)>LIVE_LIMITS.cacheBytes+LIVE_LIMITS.sceneBytes){fail(new Error('Receive queue budget exceeded'));ws.close(1013,'Receive queue limit');return;}
  queue=queue.then(async()=>{
   try{
    if(current!==generation)return;receivedBytes+=size;
    if(event.data instanceof ArrayBuffer){
     if(!welcome)throw new Error('Resource before handshake');const {id,payload}=decodeResource(event.data);
     if(await digest(payload)!==id)throw new Error('Resource checksum mismatch');gate.put(id,payload);resourcesReceived++;return;
    }
    if(size>LIVE_LIMITS.sceneBytes)throw new Error('Metadata budget exceeded');const message=JSON.parse(event.data);
    if(message.type==='Welcome'){
     if(welcome||message.protocol!==LIVE_VERSION||message.renderer?.wasmSha256!==renderer.wasmSha256||message.renderer?.canvaskit!==renderer.canvaskit||message.mode!=='live-skia-viz'||typeof message.input!=='boolean')throw new Error('Incompatible live handshake');
     welcome=true;input.welcome(message);retryDelay=250;$('build').textContent=`${message.producer.chromium} · Skia ${message.producer.skiaRevision.slice(0,12)} · CanvasKit ${renderer.canvaskit}`;return;
    }
    if(!welcome)throw new Error('Message before handshake');
    if(input.message(message))return;
    if(message.type==='SceneUpdate'){
     try{gate.stage(message.frame);}catch(error){if(error instanceof RecoveryRequired){recover();return;}throw error;}
    }else if(message.type==='FrameCommit'){
     if(recovering&&!gate.pending)return;
     const started=performance.now();const frame=await gate.commitAsync(message.pageEpoch,message.frameId,draw);
     if(!frame){recover();return;}
     input.display(frame);gate.collect();retainRenderer(new Set(gate.resources.keys()));
     if(frame.baseFrameId===null)full++;else delta++;recovering=false;
     const renderMs=performance.now()-started;$('error').hidden=true;
     $('frame').textContent=`第 ${frame.frameId} 帧`;$('mode').textContent=frame.baseFrameId===null?'完整场景':'增量更新';
     $('dimensions').textContent=`${frame.viewport.cssWidth} × ${frame.viewport.cssHeight}`;$('renderTime').textContent=`重放 ${renderMs.toFixed(1)} ms`;$('bytes').textContent=`缓存 ${(gate.bytes/1024).toFixed(0)} KiB`;
     document.body.dataset.ready='true';status('实时绘制中');
     window.remotePaintResult={protocol:LIVE_VERSION,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,frameId:frame.frameId,
      native:frame.native,lastProcessedInputSeq:frame.lastProcessedInputSeq,resourceBytes:gate.bytes,resources:gate.resources.size,
      resourcesReceived,receivedBytes,fullFrames:full,deltaFrames:delta,renderMs,requiredResources:frame.requiredResources};
     send({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId});
    }else if(message.type==='ResourceRelease'){
     if(!Array.isArray(message.ids)||message.ids.length>512||!message.ids.every(isHash))throw new Error('Invalid resource release');for(const id of message.ids)gate.release(id);retainRenderer(new Set(gate.resources.keys()));
    }else if(message.type==='CaptureError'){status(message.message);}
    else throw new Error('Unknown message');
   }catch(error){if(current===generation){fail(error);ws.close(1000,'Viewer rejected frame');}}
   finally{queuedBytes-=size;}
  });
 };
 ws.onclose=event=>{
  if(current!==generation||stopped)return;input.reset();document.body.dataset.ready='false';
  if(event.code===1008){status('连接被拒绝，请检查错误后重新连接');return;}
  status('连接中断，正在重新同步');retryTimer=setTimeout(()=>connect().catch(fail),retryDelay);retryDelay=Math.min(2000,retryDelay*2);
 };
 ws.onerror=()=>{if(current===generation)status('连接暂时不可用，等待重连');};
}
$('reconnect').onclick=()=>connect().catch(fail);
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(retryTimer);socket?.close();sceneRenderer?.clear();renderWorker?.terminate();});
await initialize().then(connect).catch(fail);
