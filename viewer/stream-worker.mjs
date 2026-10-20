import CanvasKitInit from '/canvaskit-worker.mjs';
import {RendererRuntime} from '/renderer-runtime.mjs';
import {ClientMemory,memoryPolicy} from '/protocol/client-memory.mjs';
import {parseMetadataJson} from '/protocol/metadata-json.mjs';
import {isHash} from '/protocol/wire.mjs';
import {decodeAsset,AssetCache} from '/protocol/asset-wire.mjs';
import {LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired} from '/protocol/live-wire.mjs';
const VIEWER_BUILD='__REMOTE_PAINT_VIEWER_BUILD__',EXPECTED_WASM_SHA='__REMOTE_PAINT_WASM_SHA__';
let renderer,presenter,canvas,socket,cleanupSession,generation=0,retryTimer,retryDelay=250,stopped=false,peerId;
const ui=(type,data={})=>postMessage({type,...data});
const status=text=>ui('status',{text});
const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
const send=message=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};
const draw=(frame,resources)=>presenter.draw(frame,resources);
async function connect(key){
 clearTimeout(retryTimer);cleanupSession?.();const current=++generation;socket?.close();presenter.clear();ui('reset');status('连接绘制通道');
 if(!key)throw new Error('请使用服务端输出的完整 Viewer 链接');
 const config=await fetch('/session-config').then(response=>response.json());if(current!==generation)return;
 const host=config.nativePort?`${location.hostname}:${config.nativePort}`:location.host;
 const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${host}/stream?key=${encodeURIComponent(key)}`);socket=ws;ws.binaryType='arraybuffer';
 const memory=presenter.memory,gate=new LiveFrameGate({memory}),assets=new AssetCache({memory});let rejection,closed=false,welcome=false,receivedBytes=0,resourcesReceived=0,full=0,delta=0,recovering=false,queue=Promise.resolve(),queuedBytes=0;
 const cleanup=()=>{if(closed)return;closed=true;gate.clear();assets.dispose();if(current===generation){presenter.clear();ui('memory',{memory:memory.snapshot()});}};cleanupSession=cleanup;
 const recover=()=>{gate.recover();assets.clear();presenter.retain(new Set(gate.resources.keys()));if(!recovering){recovering=true;status('重新同步完整场景');send({type:'RequestKeyframe'});}};
 ws.onopen=()=>send({type:'Hello',protocol:LIVE_VERSION,renderer,viewerBuild:VIEWER_BUILD,capabilities:['asset-chunks-v1','frame-window-v1','control-channel-v1','input-feedback-v1','resource-memory-v1'],frameWindow:6});
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
    try{if(current===generation){receivedBytes+=size;ui('control',{message:parsed});}}finally{releaseQueue();}return;
   }
   if(queuedBytes+size>memory.policy.receive)throw Object.assign(new Error('Receive queue budget exceeded'),{closeCode:4013});
   queuedBytes+=size;
  }catch(error){releaseQueue?.();rejection=error.message;ui('error',{message:rejection});ws.close(error.closeCode??4008,'Viewer metadata/memory limit');return;}
  // Start independent SHA checks as packets arrive, while the commit queue
  // preserves the server's ordering and limits memory before any decode.
  const verified=event.data instanceof ArrayBuffer?(async()=>{const asset=decodeAsset(event.data),release=memory.reserve('shaWork',asset.payload.byteLength,'browser');try{if(await digest(asset.payload)!==asset.id)throw new Error('Resource checksum mismatch');return asset;}finally{release();}})():null;verified?.catch(()=>{});
  queue=queue.then(async()=>{try{
   if(closed||current!==generation)return;receivedBytes+=size;
   if(event.data instanceof ArrayBuffer){if(!welcome)throw new Error('Resource before handshake');const {kind,id,payload}=await verified;if(closed||current!==generation)return;if(kind==='chunk')assets.put(id,payload);else{gate.put(id,payload);resourcesReceived++;}return;}
   if(size>LIVE_LIMITS.sceneBytes)throw new Error('Metadata budget exceeded');const message=parsed;
   if(message.type==='Welcome'){
    if(welcome||message.protocol!==LIVE_VERSION||message.renderer?.wasmSha256!==renderer.wasmSha256||message.renderer?.canvaskit!==renderer.canvaskit||message.mode!=='live-skia-viz'||typeof message.input!=='boolean'||typeof message.resourceMemory!=='boolean')throw new Error('Incompatible live handshake');welcome=true;gate.requireResourceMemory=message.resourceMemory;memory.decodeAdmission=message.resourceMemory?'complete-resource-index-v1':'explicit-legacy-source';peerId=message.peerId;retryDelay=250;ui('welcome',{message,streamUrl:ws.url});return;
   }
   if(!welcome)throw new Error('Message before handshake');
   if(['ControlState','ControlGranted','ControlDenied','InputAck','FeedbackState'].includes(message.type)){ui('control',{message});return;}
   if(message.type==='ResourceManifest'){const payload=assets.assemble(message);if(payload)try{const release=memory.reserve('shaWork',payload.byteLength,'browser');try{if(await digest(payload)!==message.id)throw new Error('Assembled resource checksum mismatch');}finally{release();}if(closed||current!==generation)return;gate.put(message.id,payload);resourcesReceived++;}finally{assets.releaseAssembly(payload);}return;}
   if(message.type==='ChunkCacheReset'){assets.clear();return;}
   if(message.type==='SceneUpdate'){try{gate.stage(message.frame);}catch(error){if(error instanceof RecoveryRequired){recover();return;}throw error;}}
   else if(message.type==='FrameCommit'){
    if(recovering&&!gate.pending)return;
    const started=performance.now(),frame=await gate.commitAsync(message.pageEpoch,message.frameId,draw);if(closed||current!==generation)return;if(!frame){recover();return;}
    // The sender may reuse an earlier resource in another inflight frame.
    // Only its explicit release (or recovery) retires the raw/decoded bytes.
    presenter.retain(new Set(gate.resources.keys()));if(frame.baseFrameId===null)full++;else delta++;recovering=false;
    const renderMs=performance.now()-started,result={protocol:LIVE_VERSION,connectionGeneration:current,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,frameId:frame.frameId,native:frame.native,lastProcessedInputSeq:frame.lastProcessedInputSeq,resourceBytes:gate.bytes,resources:gate.resources.size,resourcesReceived,receivedBytes,fullFrames:full,deltaFrames:delta,renderMs,requiredResources:frame.requiredResources,rendererStats:{...presenter.stats},presentation:{...presenter.presentation},assetStats:{...assets.stats,cacheBytes:assets.bytes},worker:true};
    result.memory=memory.observe(presenter.ck,presenter.gr);ui('frame',{result,frame:{pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,viewport:frame.viewport,native:frame.native,lastProcessedInputSeq:frame.lastProcessedInputSeq,frameId:frame.frameId,baseFrameId:frame.baseFrameId}});send({type:'FrameAck',pageEpoch:frame.pageEpoch,frameId:frame.frameId,stage:'scene-submitted'});
   }else if(message.type==='ResourceRelease'){
    if(!Array.isArray(message.ids)||message.ids.length>512||!message.ids.every(isHash))throw new Error('Invalid resource release');for(const id of message.ids)gate.release(id);presenter.retain(new Set(gate.resources.keys()));
    ui('cache',{resources:gate.resources.size,resourceBytes:gate.bytes,memory:memory.snapshot()});
   }else if(message.type==='CaptureError')status(message.message);
   else throw new Error('Unknown message');
  }catch(error){if(!closed&&current===generation){rejection=error.message;ui('error',{message:rejection});ws.close(4008,'Viewer rejected frame');}}finally{queuedBytes-=size;releaseQueue();}});
 };
 ws.onclose=event=>{cleanup();if(current!==generation||stopped)return;ui('reset');if(event.code===1008||event.code===4008){ui('error',{message:rejection||event.reason||'连接与当前 Viewer 版本不兼容'});status('连接被拒绝，请检查错误后重新连接');return;}status('连接中断，正在重新同步');retryTimer=setTimeout(()=>connect(key).catch(error=>ui('error',{message:error.message})),retryDelay);retryDelay=Math.min(2000,retryDelay*2);};
 ws.onerror=()=>{if(current===generation)status('连接暂时不可用，等待重连');};
}
self.onmessage=async event=>{try{
 const message=event.data;
 if(message.type==='ping'){ui('pong',{nonce:message.nonce});}
 else if(message.type==='init'){
  const initializationStarted=performance.now();
  generation=Number.isSafeInteger(message.connectionGenerationBase)&&message.connectionGenerationBase>=0?message.connectionGenerationBase:0;
  canvas=message.canvas;
  const memory=new ClientMemory(memoryPolicy({profile:message.memoryProfile}));
  const wasm=await fetch('/vendor/canvaskit.wasm',{cache:'force-cache'}).then(response=>response.arrayBuffer()),fetched=performance.now(),releaseWasm=memory.buffer('wasmDownload',wasm);
  try{renderer={canvaskit:'0.42.0',wasmSha256:await digest(wasm)};if(renderer.wasmSha256!==EXPECTED_WASM_SHA)throw new Error('Viewer Wasm integrity mismatch');const verified=performance.now();const ck=await CanvasKitInit({wasmBinary:wasm,locateFile:file=>new URL(`/vendor/${file}`,location.href).href});const initialized=performance.now();presenter=new RendererRuntime(ck,canvas,{gpu:message.gpu??'auto',memory,factory:CanvasKitInit,wasmBinary:wasm,locateFile:file=>new URL(`/vendor/${file}`,location.href).href});ui('ready',{renderer,startup:{wasmFetchMs:fetched-initializationStarted,wasmVerifyMs:verified-fetched,wasmInitMs:initialized-verified,wasmBytes:wasm.byteLength,presentation:presenter.presentation.mode,worker:true}});}finally{releaseWasm();}
 }else if(message.type==='connect')await connect(message.key);
 else if(message.type==='control-lost'&&message.peerId===peerId)socket?.close(1012,'Control connection closed');
 else if(message.type==='send')send(message.message);
 else if(message.type==='stop'){stopped=true;clearTimeout(retryTimer);cleanupSession?.();generation++;socket?.close();presenter?.dispose();close();}
 }catch(error){ui('error',{message:error.message});}};
