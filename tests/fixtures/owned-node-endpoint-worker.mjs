// Test-only endpoint ABI adapter. It runs Node, never Chromium or the broker.
// A separately fingerprinted fixture shim imports this file from the canonical
// worker path only inside its isolated execution project. Production is intact.
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {runSessionWorker} from '../../service/session-worker.mjs';
import {collectLinuxRuntimeWitness} from '../../service/linux-runtime-witness.mjs';
import {deriveNativeTransportKey} from '../../service/native-transport-key.mjs';
const fixture='owned-node-endpoint-fixture-v1',origin='http://127.0.0.1:4175',renderer={canvaskit:'0.42.0',wasmSha256:'a'.repeat(64)};
let exitCode=1;
try{
 if(process.platform!=='linux'||process.env.REMOTE_PAINT_WORKER_BOUNDARY!=='owned-container-v1')throw Error('Fixture runtime');
 const identity={sessionId:process.env.REMOTE_PAINT_WORKER_SESSION,tenantId:process.env.REMOTE_PAINT_WORKER_TENANT,region:process.env.REMOTE_PAINT_WORKER_REGION,ownerKeyHash:process.env.REMOTE_PAINT_WORKER_OWNER_HASH};
 const worker=runSessionWorker({identity,runtimeWitness:collectLinuxRuntimeWitness,deriveResourceSecret:deriveNativeTransportKey,createResource:context=>{
  let key=context.resourceSecret,starting,closing,closed=false;const sockets=new Set(),peers=new Set(),servers=[];
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw Error('Fixture private bootstrap');
  const watch=server=>{servers.push(server);server.on('connection',s=>{sockets.add(s);s.on('error',()=>{});s.once('close',()=>sockets.delete(s));});return server;};
  return {
   initialize:()=>starting??=(async()=>{
    const http=watch(createServer((req,res)=>{res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');if(req.method!=='GET'||!['/session-config','/probe'].includes(req.url)){res.writeHead(404);res.end('{}');return;}res.end(JSON.stringify(req.url==='/session-config'?{nativePort:4176,viewerBuild:fixture,scope:'Node-only endpoint fixture'}:{fixture,sessionId:identity.sessionId,pid:process.pid,brokerStarted:false,browserStarted:false}));}));
    const gateway=watch(createServer((_req,res)=>{res.writeHead(404);res.end();})),wss=new WebSocketServer({noServer:true,maxPayload:32768,perMessageDeflate:false});
    gateway.on('upgrade',(req,socket,head)=>{try{const url=new URL(req.url,origin),supplied=Buffer.from(url.searchParams.get('key')??'');if(closed||url.pathname!=='/stream'||req.headers.origin!==origin||supplied.length!==key.length||!timingSafeEqual(supplied,Buffer.from(key))||peers.size>=4){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}wss.handleUpgrade(req,socket,head,ws=>{peers.add(ws);let hello=false,sequence=0,capabilities=[];const probe=()=>ws.send(JSON.stringify({type:'NodeEndpointProbe',fixture,sessionId:identity.sessionId,pid:process.pid,sequence:++sequence,capabilities,brokerStarted:false,browserStarted:false}));ws.on('error',()=>{});ws.once('close',()=>peers.delete(ws));ws.on('message',(bytes,binary)=>{try{if(binary||++sequence>32)throw Error();const message=JSON.parse(bytes.toString());if(!hello){if(message.type!=='Hello'||message.protocol!==4||message.renderer?.wasmSha256!==renderer.wasmSha256||message.renderer?.canvaskit!==renderer.canvaskit)throw Error();hello=true;capabilities=Array.isArray(message.capabilities)?message.capabilities:[];ws.send(JSON.stringify({type:'Welcome',protocol:4,renderer,producer:{chromium:fixture,scope:'actual Node only'},mode:'fixture',sessionId:identity.sessionId,peerId:'fixture-peer',frameWindow:1,ackStage:'scene-submitted',input:false,inputFeedback:false,viewportControl:false}));probe();}else if(message.type==='RequestKeyframe')probe();else if(message.type!=='FrameAck')throw Error();}catch{ws.close(1008,'Node fixture protocol');}});});}catch{socket.destroy();}});
    for(const [server,port]of [[http,4175],[gateway,4176]])await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
    return {version:fixture};
   })(),
   close:()=>closing??=(async()=>{closed=true;try{await starting;}catch{}for(const peer of peers)peer.terminate();peers.clear();for(const socket of sockets)socket.destroy();const results=await Promise.all(servers.map(server=>server.listening?new Promise(resolve=>server.close(error=>resolve(!error))):true));key='';return {status:results.every(Boolean)?'closed':'unconfirmed'};})()
  };
 }});
 exitCode=(await worker.done).exitCode;
}catch{process.stdout.write(JSON.stringify({type:'WorkerConfigurationFailed',protocol:'session-worker-v1',code:'WORKER_CONFIGURATION_FAILED'})+'\n');}
await new Promise(resolve=>{const timer=setTimeout(resolve,100);process.stdout.write('',()=>{clearTimeout(timer);resolve();});});
process.exit(exitCode);
