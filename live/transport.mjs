import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {LivePeer} from './peer.mjs';
import {makeDelta} from '../protocol/live-wire.mjs';
import {encodeResource} from '../protocol/wire.mjs';
import {startNativePeers} from './native-peers.mjs';
import {acceptsGzip} from './static-assets.mjs';
import {prepareViewerAssets} from './viewer-assets.mjs';
export async function startLiveTransport(source,{port=4175,host='127.0.0.1',ackTimeout=5000,preparedAssets}={}){
 const assets=await(preparedAssets??prepareViewerAssets());
 const renderer={canvaskit:'0.42.0',wasmSha256:assets.wasmSha256};
 const producer={chromium:source.browser?.version()??'test',skiaRevision:'29ed1e87a0a50f3d8347e988842d9d59e7573efa',skpVersion:110};
 const key=randomBytes(24).toString('hex'),peers=new Set();let origin,closed=false,nativePeers;
 const sceneCache=new WeakMap(),deltaCache=new WeakMap(),resourceCache=new WeakMap();
 const cachedScene=scene=>{let value=sceneCache.get(scene);if(!value){value=JSON.stringify(scene);sceneCache.set(scene,value);}return value;};
 const codec={
  delta(previous,next){let row=deltaCache.get(previous);if(!row){row=new WeakMap();deltaCache.set(previous,row);}let value=row.get(next);if(!value){value=makeDelta(previous,next);row.set(next,value);}return value;},
  scene(frame,snapshot){const header={...frame,resourceMemory:snapshot?.resourceMemory??null};delete header.scene;delete header.delta;const prefix=JSON.stringify({type:'SceneUpdate',frame:header}).slice(0,-2);const value=cachedScene(frame.scene??frame.delta);return `${prefix},"${frame.scene?'scene':'delta'}":${value}}}`;},
  resource(id,payload){let value=resourceCache.get(payload);if(!value||value.id!==id){value={id,wire:encodeResource(id,payload)};resourceCache.set(payload,value);}return value.wire;},
 };
 const server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url,'http://localhost').pathname;
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws://127.0.0.1:*; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
   if(req.method==='GET'&&path==='/session-config'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({nativePort:nativePeers?.port??null,viewerBuild:assets.build}));return;}
   if(!['GET','HEAD'].includes(req.method)){res.writeHead(404);res.end();return;}
   const asset=assets.get(path);if(!asset){res.writeHead(404);res.end();return;}
   if(asset.expired){res.writeHead(410);res.end('Viewer asset version expired; reload the Viewer');return;}
   const compressed=asset.gzip&&acceptsGzip(req.headers['accept-encoding']),bytes=compressed?asset.gzip:asset.bytes,etag=compressed?asset.gzipEtag:asset.etag;
   if(path!=='/')res.setHeader('Cache-Control',asset.immutable?'public, max-age=31536000, immutable':'no-cache');
   res.setHeader('ETag',etag);res.setHeader('Vary','Accept-Encoding');res.setHeader('Content-Type',asset.type);
   if(path!=='/'&&String(req.headers['if-none-match']??'').split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag)){res.writeHead(304);res.end();return;}
   if(compressed)res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',bytes.length);res.writeHead(200);res.end(req.method==='HEAD'?undefined:bytes);
  }catch{if(!res.headersSent)res.writeHead(500);res.end('Internal error');}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:32*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url,'http://localhost'),supplied=Buffer.from(url.searchParams.get('key')??'');
  if(source.broker||url.pathname!=='/stream'||req.headers.origin!==origin||supplied.length!==key.length||!timingSafeEqual(supplied,Buffer.from(key))||peers.size>=4||closed){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
 });
 const updateDemand=()=>{
  const counts={display:0,observation:0,recording:0};
  if(!closed)for(const peer of peers)if(peer.ready&&!peer.closed)counts[peer.kind??'display']++;
  if(source.setConsumerDemand)source.setConsumerDemand(counts);else source.setDemand(counts.display);
 };
 wss.on('connection',ws=>{
  const peer=new LivePeer(ws,source,{renderer,producer,ackTimeout,codec,onReady:updateDemand});peers.add(peer);
  const send=peer.send.bind(peer);peer.send=message=>send(message?.type==='Welcome'?{...message,inputFeedback:peer.feedback===true,resourceMemory:peer.memory===true,viewportControl:!!source.control&&typeof source.resize==='function'}:message);
  ws.on('message',(bytes,binary)=>{try{if(binary)throw new Error('Client binary unsupported');const message=JSON.parse(bytes.toString());if(message.type==='Hello'){if(message.viewerBuild!=null&&message.viewerBuild!==assets.build)throw new Error('Incompatible Viewer build');if(!peer.ready){peer.feedback=!!source.control&&Array.isArray(message.capabilities)&&message.capabilities.includes('input-feedback-v1');peer.memory=source.resourceMemoryVersion===1&&Array.isArray(message.capabilities)&&message.capabilities.includes('resource-memory-v1');}}Promise.resolve(peer.message(message)).catch(()=>peer.close(1008,'Message processing failed'));}catch(error){peer.close(1008,error.message.slice(0,100));}});
  const detach=()=>{peer.dispose();peers.delete(peer);updateDemand();};ws.on('close',detach);ws.on('error',detach);
 });
 const frame=()=>{if(source.nativeAutopublish)return;if(source.broker){void source.broker.request('publish',{serial:source.latest.brokerSerial}).catch(()=>failure());return;}for(const peer of peers){try{peer.onFrame();}catch{peer.close(1008,'Frame delivery failed');}}};
 const failure=error=>{for(const peer of peers)if(peer.ready&&!peer.closed)peer.send({type:'CaptureError',message:error?.code==='RESOURCE_BUDGET_PRESSURE'?'绘制资源正在回收，正在重试':'原生采集暂时失败，正在重试'});};
 source.on('frame',frame);source.on('captureError',failure);
 try{await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);});}
 catch(error){source.off('frame',frame);source.off('captureError',failure);await new Promise(r=>wss.close(r));throw error;}
 origin=`http://127.0.0.1:${server.address().port}`;
 try{if(source.broker)nativePeers=await startNativePeers(source,{renderer,producer,key,origin,host,port:port?Number(process.env.REMOTE_PAINT_GATEWAY_PORT??port+1):0,ackTimeout,viewerBuild:assets.build,peers,onDemand:updateDemand});}
 catch(error){source.off('frame',frame);source.off('captureError',failure);await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));throw error;}
 let closing;
 return {origin,key,streamOrigin:nativePeers?`http://127.0.0.1:${nativePeers.port}`:origin,url:`${origin}/#key=${key}`,renderer,peers,
  async createConsumerTicket(kind){
   if(closed||source.closed)throw new Error('Transport is closed');
   if(!nativePeers)throw new Error('Scene consumers require the native data plane');
   const grant=await nativePeers.createConsumerTicket(kind);
   if(closed||source.closed)throw new Error('Transport is closed');
   return Object.freeze({url:`ws://127.0.0.1:${nativePeers.port}/consume?ticket=${grant.ticket}`,origin,renderer,consumerKind:grant.kind,capability:grant.capability,ackStage:grant.ackStage,expiresInMs:grant.expiresInMs});
  },
  close(){
   if(closing)return closing;
   closed=true;source.off('frame',frame);source.off('captureError',failure);updateDemand();
   return closing=(async()=>{
    const errors=[];try{await nativePeers?.close();}catch(error){errors.push(error);}
    for(const peer of peers){try{peer.dispose();}catch(error){errors.push(error);}try{peer.ws.terminate();}catch(error){errors.push(error);}}
    peers.clear();
    try{await new Promise((resolve,reject)=>wss.close(error=>error?reject(error):resolve()));}catch(error){errors.push(error);}
    try{await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Transport close failed');
   })();
  },
 };
}
