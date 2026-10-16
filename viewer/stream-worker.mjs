import CanvasKitInit from '/canvaskit-worker.mjs';
import {SceneRenderer} from '/scene-renderer.mjs';
import {isHash} from '/protocol/wire.mjs';
import {decodeAsset,AssetCache} from '/protocol/asset-wire.mjs';
import {LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired} from '/protocol/live-wire.mjs';
let ck,renderer,sceneRenderer,canvas,context,socket,generation=0,retryTimer,retryDelay=250,stopped=false;
const ui=(type,data={})=>postMessage({type,...data});
const status=text=>ui('status',{text});
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const send=message=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
function draw(frame,resources){
 const output=sceneRenderer.render(frame.scene,resources,ck.WHITE);
 try{
  const {cssWidth:width,cssHeight:height}=frame.viewport;
  const pixels=output.image.readPixels(0,0,{width,height,colorType:ck.ColorType.RGBA_8888,alphaType:ck.AlphaType.Unpremul,colorSpace:ck.ColorSpace.SRGB});
  if(!pixels||pixels.byteLength!==width*height*4)throw new Error('Cannot read completed Viewer pixels');
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer,pixels.byteOffset,pixels.byteLength),width,height),0,0);
 }finally{if(output.release)output.release();else{output.image.delete();output.surface.dispose();}}
}
async function connect(key){
 clearTimeout(retryTimer);const current=++generation;socket?.close();sceneRenderer.clear();ui('reset');status('连接绘制通道');
 if(!key)throw new Error('请使用服务端输出的完整 Viewer 链接');
 const config=await fetch('/session-config').then(response=>response.json());if(current!==generation)return;
 const host=config.nativePort?`${location.hostname}:${config.nativePort}`:location.host;
 const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${host}/stream?key=${encodeURIComponent(key)}`);socket=ws;ws.binaryType='arraybuffer';
 const gate=new LiveFrameGate(),assets=new AssetCache();let welcome=false,receivedBytes=0,resourcesReceived=0,full=0,delta=0,recovering=false,queue=Promise.resolve(),queuedBytes=0;
 const recover=()=>{gate.recover();assets.clear();sceneRenderer.retain(new Set(gate.resources.keys()));if(!recovering){recovering=true;status('重新同步完整场景');send({type:'RequestKeyframe'});}};
 ws.onopen=()=>send({type:'Hello',protocol:LIVE_VERSION,renderer,capabilities:['asset-chunks-v1']});
 ws.onmessage=event=>{
  const size=typeof event.data==='string'?new TextEncoder().encode(event.data).byteLength:event.data.byteLength;
  if((queuedBytes+=size)>LIVE_LIMITS.cacheBytes+LIVE_LIMITS.sceneBytes){ui('error',{message:'Receive queue budget exceeded'});ws.close(4013,'Receive queue limit');return;}
  // Start independent SHA checks as packets arrive, while the commit queue
  // preserves the server's ordering and limits memory before any decode.
  const verified=event.data instanceof ArrayBuffer?(async()=>{const asset=decodeAsset(event.data);if(await digest(asset.payload)!==asset.id)throw new Error('Resource checksum mismatch');return asset;})():null;verified?.catch(()=>{});
  queue=queue.then(async()=>{try{
   if(current!==generation)return;receivedBytes+=size;
   if(event.data instanceof ArrayBuffer){if(!welcome)throw new Error('Resource before handshake');const {kind,id,payload}=await verified;if(kind==='chunk')assets.put(id,payload);else{gate.put(id,payload);resourcesReceived++;}return;}
   if(size>LIVE_LIMITS.sceneBytes)throw new Error('Metadata budget exceeded');const message=JSON.parse(event.data);
   if(message.type==='Welcome'){
    if(welcome||message.protocol!==LIVE_VERSION||message.renderer?.wasmSha256!==renderer.wasmSha256||message.renderer?.canvaskit!==renderer.canvaskit||message.mode!=='live-skia-viz'||typeof message.input!=='boolean')throw new Error('Incompatible live handshake');welcome=true;retryDelay=250;ui('welcome',{message});return;
   }
   if(!welcome)throw new Error('Message before handshake');
   if(['ControlState','ControlGranted','ControlDenied','InputAck'].includes(message.type)){ui('control',{message});return;}
   if(message.type==='ResourceManifest'){const payload=assets.assemble(message);if(payload){if(await digest(payload)!==message.id)throw new Error('Assembled resource checksum mismatch');gate.put(message.id,payload);resourcesReceived++;}return;}
   if(message.type==='ChunkCacheReset'){assets.clear();return;}
   if(message.type==='SceneUpdate'){try{gate.stage(message.frame);}catch(error){if(error instanceof RecoveryRequired){recover();return;}throw error;}}
   else if(message.type==='FrameCommit'){
    if(recovering&&!gate.pending)return;
    const started=performance.now(),frame=gate.commit(message.pageEpoch,message.frameId,draw);if(!frame){recover();return;}
    gate.collect();sceneRenderer.retain(new Set(gate.resources.keys()));if(frame.baseFrameId===null)full++;else delta++;recovering=false;
    const renderMs=performance.now()-started,result={protocol:LIVE_VERSION,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,frameId:frame.frameId,native:frame.native,lastProcessedInputSeq:frame.lastProcessedInputSeq,resourceBytes:gate.bytes,resources:gate.resources.size,resourcesReceived,receivedBytes,fullFrames:full,deltaFrames:delta,renderMs,requiredResources:frame.requiredResources,rendererStats:{...sceneRenderer.stats},assetStats:{...assets.stats,cacheBytes:assets.bytes},worker:true};
    ui('frame',{result,frame:{pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,viewport:frame.viewport,lastProcessedInputSeq:frame.lastProcessedInputSeq,frameId:frame.frameId,baseFrameId:frame.baseFrameId}});send({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId});
   }else if(message.type==='ResourceRelease'){
    if(!Array.isArray(message.ids)||message.ids.length>512||!message.ids.every(isHash))throw new Error('Invalid resource release');for(const id of message.ids)gate.release(id);sceneRenderer.retain(new Set(gate.resources.keys()));
   }else if(message.type==='CaptureError')status(message.message);
   else throw new Error('Unknown message');
  }catch(error){if(current===generation){ui('error',{message:error.message});ws.close(4008,'Viewer rejected frame');}}finally{queuedBytes-=size;}});
 };
 ws.onclose=event=>{if(current!==generation||stopped)return;ui('reset');if(event.code===1008||event.code===4008){status('连接被拒绝，请检查错误后重新连接');return;}status('连接中断，正在重新同步');retryTimer=setTimeout(()=>connect(key).catch(error=>ui('error',{message:error.message})),retryDelay);retryDelay=Math.min(2000,retryDelay*2);};
 ws.onerror=()=>{if(current===generation)status('连接暂时不可用，等待重连');};
}
self.onmessage=async event=>{try{
 const message=event.data;
 if(message.type==='init'){
  canvas=message.canvas;context=canvas.getContext('2d');if(!context)throw new Error('Cannot allocate OffscreenCanvas context');
  const wasm=await fetch('/vendor/canvaskit.wasm').then(response=>response.arrayBuffer());renderer={canvaskit:'0.42.0',wasmSha256:await digest(wasm)};ck=await CanvasKitInit({wasmBinary:wasm,locateFile:file=>new URL(`/vendor/${file}`,location.href).href});sceneRenderer=new SceneRenderer(ck,{incremental:true});ui('ready',{renderer});
 }else if(message.type==='connect')await connect(message.key);
 else if(message.type==='send')send(message.message);
 else if(message.type==='stop'){stopped=true;clearTimeout(retryTimer);generation++;socket?.close();sceneRenderer?.clear();close();}
 }catch(error){ui('error',{message:error.message});}};
