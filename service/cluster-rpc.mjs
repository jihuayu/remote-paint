import {createServer,request,Agent} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {LIVE_LIMITS} from '../protocol/live-wire.mjs';

export class ClusterRpcError extends Error {
 constructor(code='CLUSTER_RPC_UNAVAILABLE',outcome='unknown'){super('Private Worker RPC is unavailable');this.name='ClusterRpcError';this.code=code;this.outcome=outcome==='not-dispatched'?'not-dispatched':'unknown';}
}
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const hash=v=>createHash('sha256').update(v).digest('hex'),fingerprint=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const methods=new Set(['lease-begin','lease-accept','create','resolve','agent','close','status']);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const material=v=>(typeof v==='string'||Buffer.isBuffer(v))&&Buffer.byteLength(v)>0&&Buffer.byteLength(v)<=65536;
const bounded=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const maxPayload=LIVE_LIMITS.resourceBytes+LIVE_LIMITS.sceneBytes;
const maxStreamBuffer=32*1024*1024;
function tlsInput(tls){if(!exact(tls,['key','cert','ca'])||!['key','cert','ca'].every(k=>material(tls[k])))throw new TypeError('Supply explicit caller-owned TLS identity and trust material');return {...tls,minVersion:'TLSv1.2',rejectUnauthorized:true};}
function validatePeers(clientSha256){
 if(!Array.isArray(clientSha256)||clientSha256.length<1||clientSha256.length>32||!clientSha256.every(fingerprint)||new Set(clientSha256).size!==clientSha256.length)throw new TypeError('Configure 1..32 unique SHA-256 mTLS peer certificate pins');
 return new Set(clientSha256);
}
function envelope(bytes){const value=JSON.parse(bytes.toString('utf8'));if(!exact(value,['schema','id','method','payload'])||value.schema!=='cluster-rpc-v1'||!uuid(value.id)||!methods.has(value.method))throw new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched');return value;}
function streamEnvelope(header){
 const value=JSON.parse(Buffer.from(header,'base64url').toString('utf8'));
 if(!exact(value,['schema','placement','request','key'])||value.schema!=='cluster-stream-v1'||typeof value.key!=='string'||!/^[a-f0-9]{64}$/.test(value.key))throw new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched');
 return value;
}
function safeError(error){return {code:typeof error?.code==='string'&&/^(CLUSTER_|AGENT_)[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'CLUSTER_RPC_HANDLER',outcome:error?.outcome==='not-dispatched'?'not-dispatched':'unknown'};}

// No credential generation, DNS discovery, public listener or retry policy.
// One client pins one statically configured private worker identity.
export class ClusterRpcClient {
 #endpoint;#serverName;#serverSha256;#agent;#timeout;#max;#active=0;#limit;#closed=false;
 constructor({endpoint,serverName,serverSha256,tls,timeoutMs=10000,maxBytes=2*1024*1024,maxConcurrent=8}={}){
  let url;try{url=new URL(endpoint);}catch{throw new TypeError('Configure an exact private HTTPS origin');}
  if(url.origin!==endpoint||url.protocol!=='https:'||!isIP(url.hostname.replace(/^\[|\]$/g,''))||typeof serverName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(serverName)||!fingerprint(serverSha256)||!bounded(timeoutMs,50,120000)||!bounded(maxBytes,1024,4*1024*1024)||!bounded(maxConcurrent,1,64))throw new TypeError('Configure a fixed Worker address, TLS name, pin and finite bounds');
  this.#endpoint=url.origin;this.#serverName=serverName;this.#serverSha256=serverSha256;this.#timeout=timeoutMs;this.#max=maxBytes;this.#limit=maxConcurrent;
  this.#agent=new Agent({...tlsInput(tls),servername:serverName,keepAlive:true,maxSockets:maxConcurrent,maxTotalSockets:maxConcurrent,maxFreeSockets:1,maxCachedSessions:0,checkServerIdentity:(_name,certificate)=>checkServerIdentity(serverName,certificate)??(certificate.raw&&hash(certificate.raw)===serverSha256?undefined:new Error('Worker certificate identity mismatch'))});
 }
 get endpoint(){return this.#endpoint;}
 get serverName(){return this.#serverName;}
 get serverSha256(){return this.#serverSha256;}
 call(method,payload,{signal,timeoutMs=this.#timeout}={}){
  if(!bounded(timeoutMs,50,120000))return Promise.reject(new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched'));
  if(this.#closed||!methods.has(method)||this.#active>=this.#limit||signal?.aborted)return Promise.reject(new ClusterRpcError('CLUSTER_RPC_NOT_DISPATCHED','not-dispatched'));
  let bytes;try{bytes=Buffer.from(JSON.stringify({schema:'cluster-rpc-v1',id:randomUUID(),method,payload}));}catch{return Promise.reject(new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched'));}
  if(bytes.length>this.#max)return Promise.reject(new ClusterRpcError('CLUSTER_RPC_LIMIT','not-dispatched'));
  const expected=JSON.parse(bytes).id;this.#active++;
  return new Promise((resolve,reject)=>{
   let ended=false,req;const finish=(error,value)=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.#active--;error?reject(error):resolve(value);};
   const abort=()=>req?.destroy(new ClusterRpcError());const timer=setTimeout(abort,timeoutMs);signal?.addEventListener('abort',abort,{once:true});
   try{req=request(this.#endpoint+'/v1/cluster/rpc',{agent:this.#agent,method:'POST',headers:{'content-type':'application/json','content-length':bytes.length,accept:'application/json'}},res=>{
    const chunks=[];let used=0;
    if(res.statusCode!==200||res.headers['content-type']!=='application/json'||res.headers['content-encoding']!==undefined){res.destroy();finish(new ClusterRpcError());return;}
    res.on('data',chunk=>{used+=chunk.length;if(used>this.#max){res.destroy();finish(new ClusterRpcError('CLUSTER_RPC_LIMIT'));}else chunks.push(chunk);});
    res.on('error',()=>finish(new ClusterRpcError()));res.on('end',()=>{try{
     const reply=JSON.parse(Buffer.concat(chunks).toString('utf8'));
     if(reply.id!==expected||typeof reply.ok!=='boolean'||!exact(reply,reply.ok?['id','ok','data']:['id','ok','error']))throw new Error('RPC envelope');
     if(reply.ok)finish(null,reply.data);else{if(!exact(reply.error,['code','outcome'])||JSON.stringify(safeError(reply.error))!==JSON.stringify(reply.error))throw new Error('RPC failure');finish(new ClusterRpcError(reply.error.code,reply.error.outcome));}
    }catch{finish(new ClusterRpcError('CLUSTER_RPC_REPLY'));}});
   });
   req.on('error',()=>finish(new ClusterRpcError()));req.end(bytes);}catch{finish(new ClusterRpcError('CLUSTER_RPC_NOT_DISPATCHED','not-dispatched'));}
  });
 }
 openStream({placement,request:reqIdentity,key,signal,timeoutMs=this.#timeout}={}){
  if(!bounded(timeoutMs,50,120000))return Promise.reject(new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched'));
  if(this.#closed||signal?.aborted)return Promise.reject(new ClusterRpcError('CLUSTER_RPC_NOT_DISPATCHED','not-dispatched'));
  let encoded;
  try{encoded=Buffer.from(JSON.stringify({schema:'cluster-stream-v1',placement,request:reqIdentity,key}),'utf8').toString('base64url');}
  catch{return Promise.reject(new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched'));}
  if(!encoded||encoded.length>8192)return Promise.reject(new ClusterRpcError('CLUSTER_RPC_LIMIT','not-dispatched'));
  const wsUrl=this.#endpoint.replace(/^https:/,'wss:')+'/v1/cluster/stream';
  return new Promise((resolve,reject)=>{
   let settled=false,ws;
   const finish=(error,socket)=>{
    if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
    if(error){try{ws?.terminate();}catch{}reject(error);}else resolve(socket);
   };
   const abort=()=>finish(new ClusterRpcError('CLUSTER_STREAM_UNAVAILABLE','not-dispatched'));
   const timer=setTimeout(abort,timeoutMs);timer.unref?.();
   signal?.addEventListener('abort',abort,{once:true});
   try{
    ws=new WebSocket(wsUrl,{agent:this.#agent,headers:{'x-cluster-stream':encoded},perMessageDeflate:false,maxPayload,handshakeTimeout:timeoutMs});
    ws.once('open',()=>finish(null,ws));
    ws.once('error',()=>finish(new ClusterRpcError('CLUSTER_STREAM_UNAVAILABLE','not-dispatched')));
    ws.once('unexpected-response',(_req,res)=>{res.resume();finish(new ClusterRpcError('CLUSTER_STREAM_UNAVAILABLE','not-dispatched'));});
   }catch{
    finish(new ClusterRpcError('CLUSTER_RPC_NOT_DISPATCHED','not-dispatched'));
   }
  });
 }
 close(){this.#closed=true;this.#agent.destroy();}
}

export function createClusterRpcServer({tls,clientSha256,handle,handleStream=null,maxBytes=2*1024*1024,maxConcurrent=8,maxStreams=16,timeoutMs=75000}={}){
 let peers=validatePeers(clientSha256);
 if(typeof handle!=='function'||(handleStream!==null&&typeof handleStream!=='function')||!bounded(maxBytes,1024,4*1024*1024)||!bounded(maxConcurrent,1,64)||!bounded(maxStreams,1,64)||!bounded(timeoutMs,50,120000))throw new TypeError('Configure explicit mTLS peers, handler and finite bounds');
 let active=0,activeStreams=0,closing=false;
 const activeSockets=new Map();
 const wss=new WebSocketServer({noServer:true,maxPayload,perMessageDeflate:false,handleProtocols:()=>false});
 const server=createServer({...tlsInput(tls),requestCert:true,rejectUnauthorized:true,handshakeTimeout:5000,maxHeaderSize:8192,headersTimeout:timeoutMs,requestTimeout:timeoutMs},async(req,res)=>{
  const send=(status,value)=>{if(res.destroyed)return;const body=Buffer.from(JSON.stringify(value));if(body.length>maxBytes){res.destroy();return;}res.writeHead(status,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);};
  const certificate=req.socket.getPeerCertificate();
  const certSha=certificate?.raw?hash(certificate.raw):null;
  if(closing||req.socket.authorized!==true||!certSha||!peers.has(certSha)){send(403,{});return;}
  activeSockets.set(req.socket,certSha);
  req.socket.once('close',()=>activeSockets.delete(req.socket));
  if(active>=maxConcurrent){send(503,{});return;}
  const length=req.headers['content-length'];if(req.method!=='POST'||req.url!=='/v1/cluster/rpc'||req.headers.origin!==undefined||req.headers['content-type']!=='application/json'||req.headers['transfer-encoding']!==undefined||req.headers['content-encoding']!==undefined||typeof length!=='string'||!/^([1-9][0-9]{0,7})$/.test(length)||Number(length)>maxBytes){send(400,{});return;}
  active++;const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();res.destroy();},timeoutMs);let command;
  req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort();});
  try{
   const chunks=[];let used=0;for await(const chunk of req){used+=chunk.length;if(used>maxBytes)throw new Error('Request bound');chunks.push(chunk);}if(used!==Number(length))throw new Error('Incomplete request');
   command=envelope(Buffer.concat(chunks));if(controller.signal.aborted)throw new ClusterRpcError();
   const data=await handle(command.method,command.payload,{signal:controller.signal});send(200,{id:command.id,ok:true,data});
  }catch(error){if(command)send(200,{id:command.id,ok:false,error:safeError(error)});else send(400,{});}
  finally{clearTimeout(timer);active--;}
 });
 server.on('upgrade',async(req,socket,head)=>{
  const reject=status=>{if(!socket.destroyed)socket.end(`HTTP/1.1 ${status} ${status===403?'Forbidden':status===503?'Service Unavailable':'Bad Request'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);socket.destroy();};
  const certificate=socket.getPeerCertificate?.();
  const certSha=certificate?.raw?hash(certificate.raw):null;
  if(closing||socket.authorized!==true||!certSha||!peers.has(certSha))return reject(403);
  if(typeof handleStream!=='function'||req.method!=='GET'||req.url!=='/v1/cluster/stream'||req.headers.origin!==undefined||typeof req.headers['x-cluster-stream']!=='string'||req.headers['x-cluster-stream'].length>8192||head.length>32*1024)return reject(400);
  if(activeStreams>=maxStreams)return reject(503);
  let env;try{env=streamEnvelope(req.headers['x-cluster-stream']);}catch{return reject(400);}
  activeStreams++;
  activeSockets.set(socket,certSha);
  const controller=new AbortController();
  let upstream=null,downstream=null,disposed=false;
  const pendingUpstream=[];
  const cleanup=(code=1008,reason='Cluster stream ended')=>{
   if(disposed)return;disposed=true;
   activeStreams--;activeSockets.delete(socket);
   pendingUpstream.length=0;controller.abort();
   try{upstream?.terminate();}catch{}
   if(downstream&&downstream.readyState!==WebSocket.CLOSED){
    try{if(downstream.readyState===WebSocket.OPEN)downstream.close(code,reason);else downstream.terminate();}catch{}
   }else if(!socket.destroyed){
    socket.destroy();
   }
  };
  socket.once('close',()=>cleanup());
  socket.once('error',()=>cleanup());
  try{
   upstream=await handleStream({placement:env.placement,request:env.request,key:env.key,signal:controller.signal});
   if(disposed||controller.signal.aborted||!peers.has(certSha)){cleanup();return;}
   const onEarlyMessage=(bytes,binary)=>{
    if(downstream){
     if(downstream.readyState===WebSocket.OPEN&&downstream.bufferedAmount+Buffer.byteLength(bytes)<=maxStreamBuffer)downstream.send(bytes,{binary});
     else cleanup(1011,'Cluster stream backpressure');
    }else{
     pendingUpstream.push({bytes,binary});
    }
   };
   upstream.on('message',onEarlyMessage);
   upstream.on('error',()=>cleanup(1011,'Worker stream error'));
   upstream.on('close',code=>cleanup([1000,1001,1008,1012,1013].includes(code)?code:1011,'Worker stream ended'));
   wss.handleUpgrade(req,socket,head,ws=>{
    if(disposed||!peers.has(certSha)){try{ws.terminate();}catch{}cleanup();return;}
    downstream=ws;
    ws.on('error',()=>cleanup());
    ws.on('close',()=>cleanup());
    while(pendingUpstream.length){
     const item=pendingUpstream.shift();
     if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount+Buffer.byteLength(item.bytes)<=maxStreamBuffer)ws.send(item.bytes,{binary:item.binary});
     else{cleanup(1011,'Cluster stream backpressure');return;}
    }
    ws.on('message',(bytes,binary)=>{
     if(disposed||!peers.has(certSha)){cleanup();return;}
     if(upstream.readyState===WebSocket.OPEN&&upstream.bufferedAmount+Buffer.byteLength(bytes)<=maxStreamBuffer)upstream.send(bytes,{binary});
     else cleanup(1011,'Cluster stream backpressure');
    });
   });
  }catch{
   if(!disposed){
    disposed=true;activeStreams--;activeSockets.delete(socket);controller.abort();
    try{upstream?.terminate();}catch{}
    reject(503);
   }
  }
 });
 server.maxConnections=64;server.keepAliveTimeout=1000;server.on('connection',socket=>socket.setTimeout(timeoutMs,()=>socket.destroy()));server.on('tlsClientError',()=>{});
 server.on('close',()=>{closing=true;wss.close();});
 server.rotatePeers=nextClientSha256=>{
  const next=validatePeers(nextClientSha256);
  peers=next;
  let revokedSockets=0;
  for(const [sock,certSha]of [...activeSockets.entries()]){
   if(!peers.has(certSha)){
    revokedSockets++;activeSockets.delete(sock);
    try{sock.destroy();}catch{}
   }
  }
  return Object.freeze({peers:Object.freeze([...peers]),revokedSockets});
 };
 server.clusterStatus=()=>Object.freeze({active,activeStreams,closing,peers:Object.freeze([...peers])});
 return server;
}
