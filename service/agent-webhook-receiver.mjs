// Owned backend HTTPS receiver. ACK means durable inbox acceptance only.
import {createServer} from 'node:https';
import {isIP} from 'node:net';
import {types} from 'node:util';
import {createAgentWebhookInbox,AgentWebhookInboxError} from './agent-webhook-inbox.mjs';

export class AgentWebhookReceiverError extends Error {
 constructor(code){super('Agent Webhook receiver operation failed');this.name='AgentWebhookReceiverError';this.code='AGENT_WEBHOOK_RECEIVER_'+code;}
}
const fail=code=>{throw new AgentWebhookReceiverError(code);};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function record(v,required,optional=[]){
 if(!v||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('INVALID');
 const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(ds);
 if(required.some(k=>!Object.hasOwn(ds,k))||ks.some(k=>typeof k!=='string'||![...required,...optional].includes(k)||!Object.hasOwn(ds[k],'value')))fail('INVALID');
 return Object.fromEntries(ks.map(k=>[k,ds[k].value]));
}
const bytesPrototype=Object.getPrototypeOf(Uint8Array.prototype),byteLength=Object.getOwnPropertyDescriptor(bytesPrototype,'byteLength').get,backingBuffer=Object.getOwnPropertyDescriptor(bytesPrototype,'buffer').get;
function pem(v){
 if(typeof v==='string'){if(v.length<1||Buffer.byteLength(v)>32768)fail('INVALID');return Buffer.from(v);}
 if(types.isProxy(v)||!types.isUint8Array(v)||![Uint8Array.prototype,Buffer.prototype].includes(Object.getPrototypeOf(v))||types.isSharedArrayBuffer(backingBuffer.call(v)))fail('INVALID');
 const n=byteLength.call(v);if(!integer(n,1,32768))fail('INVALID');const b=Buffer.alloc(n);Uint8Array.prototype.set.call(b,v);return b;
}
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
function observation(options){const v=record(options,[],['signal']);if(!Object.hasOwn(v,'signal'))return null;try{if(types.isProxy(v.signal))throw Error();aborted.call(v.signal);}catch{fail('INVALID');}return v.signal;}
function observe(promise,signal){
 if(!signal)return promise;
 return new Promise((resolve,reject)=>{
  const cleanup=()=>EventTarget.prototype.removeEventListener.call(signal,'abort',abort),abort=()=>{cleanup();reject(new AgentWebhookReceiverError('ABORTED'));};
  EventTarget.prototype.addEventListener.call(signal,'abort',abort,{once:true});promise.then(v=>{cleanup();resolve(v);},e=>{cleanup();reject(e);});if(aborted.call(signal))abort();
 });
}
const tuple=s=>JSON.stringify([s.remoteAddress,s.remotePort,s.localAddress,s.localPort]);
const rejectedBody=JSON.stringify({error:{code:'AGENT_WEBHOOK_REJECTED'}});
export function createAgentWebhookReceiver(config){
 const v=record(config,['directory','tenantId','endpointId','keys','activeKeyId','cert','key'],['maxEvents','maxDatabaseBytes','host','port','path','maxConnections','connectionLifetimeMs']);
 const opt=(k,d)=>Object.hasOwn(v,k)?v[k]:d,host=opt('host','127.0.0.1'),port=opt('port',0),path=opt('path','/webhooks/'+v.endpointId),maxConnections=opt('maxConnections',8),connectionLifetimeMs=opt('connectionLifetimeMs',30000);
 if(typeof host!=='string'||!isIP(host)||!integer(port,0,65535)||typeof path!=='string'||path.length>512||!/^\/[A-Za-z0-9/_-]+$/.test(path)||!integer(maxConnections,1,32)||!integer(connectionLifetimeMs,50,60000))fail('INVALID');
 let key,cert,server,inbox;
 try{
  key=pem(v.key);cert=pem(v.cert);
  server=createServer({key,cert,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1'],maxHeaderSize:8192,highWaterMark:4096,requestTimeout:0,headersTimeout:0,keepAliveTimeout:1},request);
  const cfg=Object.fromEntries(['directory','tenantId','endpointId','keys','activeKeyId','maxEvents','maxDatabaseBytes'].filter(k=>Object.hasOwn(v,k)).map(k=>[k,v[k]]));inbox=createAgentWebhookInbox(cfg);
 }catch(error){if(error instanceof AgentWebhookReceiverError||error instanceof AgentWebhookInboxError)throw error;fail('INVALID');}finally{key?.fill(0);cert?.fill(0);}
 v.key=null;v.keys=null;config=null;
 const records=new Set(),tlsRecords=new Map();
 let closing=false,closed=false,listenStarted=false,listenPending=false,listenerClosed=true,listenPromise,closePromise,closeResolve,closeReject,serverCloseRequested=false,closeFailed=false;
 server.maxConnections=maxConnections;server.dropMaxConnection=true;server.maxHeadersCount=17;server.maxRequestsPerSocket=1;server.timeout=0;
 function updateAdmission(){
  const reserved=records.size,live=[...records].filter(r=>!r.rawClosed).length;
  // Node >=22.13 treats zero as drop-all, before a TLS wrapper is created.
  // Keep already closing streams reserved through their actual close receipt.
  server.maxConnections=closing||reserved>=maxConnections?0:live+maxConnections-reserved;
 }
 function finishClose(){
  if(!closing||closed||closeFailed||listenPending||!listenerClosed||records.size)return;
  try{inbox.close();closed=true;closeResolve();}catch{closeFailed=true;closeReject(new AgentWebhookReceiverError('CLOSE'));}
 }
 function retire(r){
  if(!r.rawClosed||!r.tlsClosed||r.entry&&(!r.entry.reqClosed||!r.entry.resClosed))return;
  clearTimeout(r.timer);records.delete(r);if(r.tls)tlsRecords.delete(r.tls);r.entry=null;updateAdmission();finishClose();
 }
 function destroy(r){r.entry?.res.destroy();r.entry?.req.destroy();r.tls?.destroy();r.raw.destroy();}
 function stopServer(){
  if(listenPending||listenerClosed||serverCloseRequested){finishClose();return;}
  serverCloseRequested=true;server.close(error=>{if(error){closeFailed=true;closeReject(new AgentWebhookReceiverError('CLOSE'));return;}listenerClosed=true;finishClose();});
 }
 server.on('connection',raw=>{
  raw.on('error',()=>{});
  if(closing||records.size>=maxConnections){raw.destroy();return;}
  const r={raw,tuple:tuple(raw),deadline:performance.now()+connectionLifetimeMs,rawClosed:false,tlsClosed:true,tls:null,entry:null,claimed:false,timer:null};records.add(r);updateAdmission();
  r.timer=setTimeout(()=>destroy(r),connectionLifetimeMs);r.timer.unref();raw.once('close',()=>{r.rawClosed=true;retire(r);});
 });
 server.on('secureConnection',tls=>{
  tls.on('error',()=>{});const r=[...records].find(r=>!r.rawClosed&&!r.tls&&r.tuple===tuple(tls));
  if(!r||closing){tls.destroy();return;}r.tls=tls;r.tlsClosed=false;tlsRecords.set(tls,r);tls.once('close',()=>{r.tlsClosed=true;retire(r);});
 });
 server.on('error',()=>{if(!listenPending&&listenStarted&&!closing)beginClose();});
 // The Node TLS server owns pre-handshake streams. A tlsClientError may be
 // emitted from its close callback, too late to register another close listener.
 // Do not create a new resource/wait from that notification. The original TCP
 // record remains reserved through its actual close; server.close also awaits
 // Node's connection retirement. Established TLS streams have their own receipts.
 server.on('tlsClientError',(_error,socket)=>socket.destroy());
 server.on('clientError',(_error,socket)=>socket.destroy());
 for(const event of ['upgrade','connect','dropRequest'])server.on(event,(req)=>req.socket.destroy());
 server.on('checkContinue',(req,res)=>request(req,res,417));server.on('checkExpectation',(req,res)=>request(req,res,417));
 function reply(r,status,body=rejectedBody){
  const e=r.entry;if(!e||e.responded)return;e.responded=true;e.body=null;
  if(closing||performance.now()>=r.deadline||r.rawClosed||r.tlsClosed){destroy(r);return;}
  e.res.shouldKeepAlive=false;const text=typeof body==='string'?body:JSON.stringify(body);
  e.res.writeHead(status,{'content-type':'application/json','content-length':String(Buffer.byteLength(text)),'cache-control':'no-store','x-content-type-options':'nosniff','connection':'close',...(status===405?{allow:'POST'}:{}),...(status===503?{'retry-after':'1'}:{})});e.res.end(text);
 }
 function request(req,res,rejectedStatus){
  req.on('error',()=>{});res.on('error',()=>{});const r=tlsRecords.get(req.socket);
  if(!r||r.claimed||closing){req.socket.destroy();return;}
  r.claimed=true;const e=r.entry={req,res,reqClosed:false,resClosed:false,responded:false,body:null,used:0};req.once('close',()=>{e.reqClosed=true;retire(r);});res.once('close',()=>{e.resClosed=true;retire(r);});
  const reject=status=>{req.pause();reply(r,status);};
  if(rejectedStatus){reject(rejectedStatus);return;}
  if(req.method!=='POST'){reject(405);return;}if(req.url!==path){reject(404);return;}
  if(req.httpVersion!=='1.1'||req.rawHeaders.length>32){reject(400);return;}
  const headers=Object.create(null);
  for(let i=0;i<req.rawHeaders.length;i+=2){const k=req.rawHeaders[i].toLowerCase();if(Object.hasOwn(headers,k)){reject(400);return;}headers[k]=req.rawHeaders[i+1];}
  if(['transfer-encoding','trailer','upgrade','expect','content-encoding'].some(k=>Object.hasOwn(headers,k))||typeof headers.host!=='string'||!headers.host){reject(400);return;}
  if(!/^application\/json(?:; charset=utf-8)?$/i.test(headers['content-type']??'')){reject(415);return;}
  const size=headers['content-length'];if(size===undefined){reject(411);return;}
  if(!/^[1-9][0-9]*$/.test(size)){reject(400);return;}if(size.length>4||Number(size)>4096){reject(413);return;}
  if(typeof headers['remote-paint-event-id']!=='string'||typeof headers['remote-paint-signature']!=='string'){reject(401);return;}
  e.body=Buffer.alloc(Number(size));
  req.on('data',part=>{
   if(e.responded||closing||performance.now()>=r.deadline){destroy(r);return;}
   if(e.used+part.length>e.body.length){e.body=null;destroy(r);return;}e.body.set(part,e.used);e.used+=part.length;
  });
  req.once('end',()=>{
   if(e.responded)return;
   if(closing||performance.now()>=r.deadline||!req.complete||req.aborted||req.rawTrailers.length||e.used!==e.body.length){e.body=null;destroy(r);return;}
   try{const result=inbox.accept({eventId:headers['remote-paint-event-id'],signature:headers['remote-paint-signature'],body:e.body});reply(r,result.status,result.ack);}
   catch(error){const code=error instanceof AgentWebhookInboxError?error.code:'';reply(r,code==='AGENT_WEBHOOK_INBOX_AUTH'?401:code==='AGENT_WEBHOOK_INBOX_BODY'?400:code==='AGENT_WEBHOOK_INBOX_CONFLICT'?409:503);}
  });
 }
 function beginClose(){
  if(!closePromise){closing=true;updateAdmission();closePromise=new Promise((resolve,reject)=>{closeResolve=resolve;closeReject=reject;});closePromise.catch(()=>{});for(const r of records)destroy(r);stopServer();finishClose();}return closePromise;
 }
 return Object.freeze({
  listen(options={}){
   const signal=observation(options);if(closing)return Promise.reject(new AgentWebhookReceiverError('CLOSED'));
   if(!listenStarted){
    listenStarted=true;listenPending=true;listenerClosed=false;
    listenPromise=new Promise((resolve,reject)=>{
     const error=()=>{server.off('listening',ready);listenPending=false;listenerClosed=true;reject(new AgentWebhookReceiverError('LISTEN'));finishClose();};
     const ready=()=>{server.off('error',error);listenPending=false;if(closing){reject(new AgentWebhookReceiverError('CLOSED'));stopServer();return;}const address=server.address();resolve(Object.freeze({host:address.address,port:address.port,path}));};
     server.once('error',error);server.once('listening',ready);try{server.listen({host,port,backlog:maxConnections,exclusive:true});}catch{error();}
    });listenPromise.catch(()=>{});
   }
   return observe(listenPromise,signal);
  },
  read(options={}){if(closing)fail('CLOSED');return inbox.read(options);},
  identity(){if(closing)fail('CLOSED');return inbox.identity();},
  status(){return Object.freeze({state:closed?'closed':closeFailed?'close-failed':closing?'closing':listenPending?'opening':server.listening?'listening':listenStarted?'listen-failed':'created',connections:records.size,requests:[...records].filter(r=>r.entry&&!r.entry.resClosed).length,maxConnections,connectionLifetimeMs});},
  close(options={}){const signal=observation(options);return observe(beginClose(),signal);}
 });
}
