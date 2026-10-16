import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes,timingSafeEqual,createHash} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {LivePeer} from './peer.mjs';
import {encodeResource} from '../protocol/wire.mjs';
const root=new URL('../',import.meta.url);
export async function startLiveTransport(source,{port=4175,host='127.0.0.1',ackTimeout=5000}={}){
 const wasm=await readFile(new URL('node_modules/canvaskit-wasm/bin/full/canvaskit.wasm',root));
 const renderer={canvaskit:'0.42.0',wasmSha256:createHash('sha256').update(wasm).digest('hex')};
 const producer={chromium:source.browser?.version()??'test',skiaRevision:'29ed1e87a0a50f3d8347e988842d9d59e7573efa',skpVersion:110};
 const key=randomBytes(24).toString('hex'),peers=new Set();let origin,closed=false;
 const sceneCache=new WeakMap(),deltaCache=new WeakMap(),resourceCache=new Map();
 const cachedScene=scene=>{let value=sceneCache.get(scene);if(!value){value=JSON.stringify(scene);sceneCache.set(scene,value);}return value;};
 const cachedDelta=(previous,next,delta)=>{let row=deltaCache.get(previous);if(!row){row=new WeakMap();deltaCache.set(previous,row);}let value=row.get(next);if(!value){value=JSON.stringify(delta);row.set(next,value);}return value;};
 const codec={scene(frame,current,previous){const header={...frame};delete header.scene;delete header.delta;const prefix=JSON.stringify({type:'SceneUpdate',frame:header}).slice(0,-2);let value;if(frame.scene)value=cachedScene(frame.scene);else{let row=deltaCache.get(previous?.scene);if(!row){row=new WeakMap();if(previous?.scene)deltaCache.set(previous.scene,row);}value=previous?.scene&&current?.scene?row.get(current.scene):undefined;if(!value){value=JSON.stringify(frame.delta);if(previous?.scene&&current?.scene)row.set(current.scene,value);}}const field=frame.scene?`,"scene":${value}`:`,"delta":${value}`;return `${prefix}${field}}}`;},resource(id,payload){let value=resourceCache.get(id);if(!value){value=encodeResource(id,payload);resourceCache.set(id,value);}return value;},stats:{sceneHits:0,resourceHits:0}};
 const files=new Map([
  ['/', ['viewer/live.html','text/html; charset=utf-8']],['/live.mjs',['viewer/live.mjs','text/javascript']],
  ['/input.mjs',['viewer/input.mjs','text/javascript']],
  ['/live.css',['viewer/live.css','text/css']],['/scene-renderer.mjs',['viewer/scene-renderer.mjs','text/javascript']],
  ['/protocol/live-wire.mjs',['protocol/live-wire.mjs','text/javascript']],['/protocol/wire.mjs',['protocol/wire.mjs','text/javascript']],
  ['/render-worker.mjs',['viewer/render-worker.mjs','text/javascript']],
  ['/vendor/canvaskit.js',['node_modules/canvaskit-wasm/bin/full/canvaskit.js','text/javascript']],
  ['/vendor/canvaskit.wasm',['node_modules/canvaskit-wasm/bin/full/canvaskit.wasm','application/wasm']],
 ]);
 const server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url,'http://localhost').pathname;const file=files.get(path);
   res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws://127.0.0.1:*; style-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
   if(req.method!=='GET'||(!file&&path!=='/canvaskit-worker.mjs')){res.writeHead(404);res.end();return;}
   if(path==='/canvaskit-worker.mjs'){
    const source=await readFile(new URL('node_modules/canvaskit-wasm/bin/full/canvaskit.js',root),'utf8');res.writeHead(200,{'Content-Type':'text/javascript'});res.end(`${source}\nexport default CanvasKitInit;`);return;
   }
   const bytes=path==='/vendor/canvaskit.wasm'?wasm:await readFile(new URL(file[0],root));res.writeHead(200,{'Content-Type':file[1]});res.end(bytes);
  }catch{if(!res.headersSent)res.writeHead(500);res.end('Internal error');}
 });
 const wss=new WebSocketServer({noServer:true,maxPayload:32*1024,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url,'http://localhost'),supplied=Buffer.from(url.searchParams.get('key')??'');
  if(url.pathname!=='/stream'||req.headers.origin!==origin||supplied.length!==key.length||!timingSafeEqual(supplied,Buffer.from(key))||peers.size>=4||closed){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
 });
 const updateDemand=()=>source.setDemand(closed?0:[...peers].filter(p=>p.ready&&!p.closed).length);
 wss.on('connection',ws=>{
  const peer=new LivePeer(ws,source,{renderer,producer,ackTimeout,codec,onReady:updateDemand});peers.add(peer);
  ws.on('message',(bytes,binary)=>{try{if(binary)throw new Error('Client binary unsupported');Promise.resolve(peer.message(JSON.parse(bytes.toString()))).catch(()=>peer.close(1008,'Message processing failed'));}catch(error){peer.close(1008,error.message.slice(0,100));}});
  const detach=()=>{peer.dispose();peers.delete(peer);updateDemand();};ws.on('close',detach);ws.on('error',detach);
 });
 const frame=()=>{for(const peer of peers){try{peer.onFrame();}catch{peer.close(1008,'Frame delivery failed');}}};
 const failure=()=>{for(const peer of peers)if(peer.ready&&!peer.closed)peer.send({type:'CaptureError',message:'原生采集暂时失败，正在重试'});};
 source.on('frame',frame);source.on('captureError',failure);
 try{await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,host,ok);});}
 catch(error){source.off('frame',frame);source.off('captureError',failure);await new Promise(r=>wss.close(r));throw error;}
 origin=`http://127.0.0.1:${server.address().port}`;
 return {origin,key,url:`${origin}/#key=${key}`,renderer,peers,
  async close(){closed=true;source.off('frame',frame);source.off('captureError',failure);source.setDemand(0);for(const peer of peers){peer.dispose();peer.ws.terminate();}await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));},
 };
}
