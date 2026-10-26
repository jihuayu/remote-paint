import {createServer,request,Agent} from 'node:https';
import {checkServerIdentity} from 'node:tls';
import {isIP} from 'node:net';
import {createHash,randomUUID} from 'node:crypto';

export class ClusterRpcError extends Error {
 constructor(code='CLUSTER_RPC_UNAVAILABLE',outcome='unknown'){super('Private Worker RPC is unavailable');this.name='ClusterRpcError';this.code=code;this.outcome=outcome==='not-dispatched'?'not-dispatched':'unknown';}
}
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const hash=v=>createHash('sha256').update(v).digest('hex'),fingerprint=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const methods=new Set(['lease-begin','lease-accept','create','resolve','agent','close','status']);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
const material=v=>(typeof v==='string'||Buffer.isBuffer(v))&&Buffer.byteLength(v)>0&&Buffer.byteLength(v)<=65536;
const bounded=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function tlsInput(tls){if(!exact(tls,['key','cert','ca'])||!['key','cert','ca'].every(k=>material(tls[k])))throw new TypeError('Supply explicit caller-owned TLS identity and trust material');return {...tls,minVersion:'TLSv1.2',rejectUnauthorized:true};}
function envelope(bytes){const value=JSON.parse(bytes.toString('utf8'));if(!exact(value,['schema','id','method','payload'])||value.schema!=='cluster-rpc-v1'||!uuid(value.id)||!methods.has(value.method))throw new ClusterRpcError('CLUSTER_RPC_REQUEST','not-dispatched');return value;}
function safeError(error){return {code:typeof error?.code==='string'&&/^(CLUSTER_|AGENT_)[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'CLUSTER_RPC_HANDLER',outcome:error?.outcome==='not-dispatched'?'not-dispatched':'unknown'};}

// No credential generation, DNS discovery, public listener or retry policy.
// One client pins one statically configured private worker identity.
export class ClusterRpcClient {
 #endpoint;#agent;#timeout;#max;#active=0;#limit;#closed=false;
 constructor({endpoint,serverName,serverSha256,tls,timeoutMs=10000,maxBytes=2*1024*1024,maxConcurrent=8}={}){
  let url;try{url=new URL(endpoint);}catch{throw new TypeError('Configure an exact private HTTPS origin');}
  if(url.origin!==endpoint||url.protocol!=='https:'||!isIP(url.hostname.replace(/^\[|\]$/g,''))||typeof serverName!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(serverName)||!fingerprint(serverSha256)||!bounded(timeoutMs,50,120000)||!bounded(maxBytes,1024,4*1024*1024)||!bounded(maxConcurrent,1,64))throw new TypeError('Configure a fixed Worker address, TLS name, pin and finite bounds');
  this.#endpoint=url.origin;this.#timeout=timeoutMs;this.#max=maxBytes;this.#limit=maxConcurrent;
  this.#agent=new Agent({...tlsInput(tls),servername:serverName,keepAlive:true,maxSockets:maxConcurrent,maxTotalSockets:maxConcurrent,maxFreeSockets:1,maxCachedSessions:0,checkServerIdentity:(_name,certificate)=>checkServerIdentity(serverName,certificate)??(certificate.raw&&hash(certificate.raw)===serverSha256?undefined:new Error('Worker certificate identity mismatch'))});
 }
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
 close(){this.#closed=true;this.#agent.destroy();}
}

export function createClusterRpcServer({tls,clientSha256,handle,maxBytes=2*1024*1024,maxConcurrent=8,timeoutMs=75000}={}){
 if(!Array.isArray(clientSha256)||clientSha256.length<1||clientSha256.length>32||!clientSha256.every(fingerprint)||new Set(clientSha256).size!==clientSha256.length||typeof handle!=='function'||!bounded(maxBytes,1024,4*1024*1024)||!bounded(maxConcurrent,1,64)||!bounded(timeoutMs,50,120000))throw new TypeError('Configure explicit mTLS peers, handler and finite bounds');
 const peers=new Set(clientSha256);let active=0,closing=false;
 const server=createServer({...tlsInput(tls),requestCert:true,rejectUnauthorized:true,handshakeTimeout:5000,maxHeaderSize:8192,headersTimeout:timeoutMs,requestTimeout:timeoutMs},async(req,res)=>{
  const send=(status,value)=>{if(res.destroyed)return;const body=Buffer.from(JSON.stringify(value));if(body.length>maxBytes){res.destroy();return;}res.writeHead(status,{'content-type':'application/json','content-length':body.length,'cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);};
  const certificate=req.socket.getPeerCertificate();
  if(closing||req.socket.authorized!==true||!certificate.raw||!peers.has(hash(certificate.raw))){send(403,{});return;}
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
 server.maxConnections=64;server.keepAliveTimeout=1000;server.on('connection',socket=>socket.setTimeout(timeoutMs,()=>socket.destroy()));server.on('tlsClientError',()=>{});
 server.on('close',()=>{closing=true;});server.clusterStatus=()=>Object.freeze({active,closing});return server;
}
