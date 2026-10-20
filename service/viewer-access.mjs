import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {WebSocket,WebSocketServer} from 'ws';
import {SessionRegistry,SessionApiError} from './session-registry.mjs';
import {LIVE_LIMITS} from '../protocol/live-wire.mjs';

const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const data=(v,k)=>v&&typeof v==='object'?Object.getOwnPropertyDescriptor(v,k)?.value:undefined;
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=(code,status=400)=>{throw new SessionApiError(code,'Viewer access request failed',status);};
const controls=new Set(['AcquireControl','RenewControl','ReleaseControl','Input']);
function fields(value,allowed){
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>!allowed.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))fail('INVALID_VIEWER_GRANT');
}
function origin(value){
 if(typeof value!=='string'||value.length>2048)fail('INVALID_VIEWER_GRANT');
 let url;try{url=new URL(value);}catch{fail('INVALID_VIEWER_GRANT');}
 if(url.origin!==value||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))fail('INVALID_VIEWER_GRANT');
 return value;
}
function publicGrant(row){return Object.freeze({grantId:row.id,sessionId:row.sessionId,version:row.version,role:row.role,audience:row.audience,expiresAt:new Date(row.expires).toISOString()});}

// One process owns these short grants and the public proxy. Restart revokes all
// grants. The trusted resolver is backend-only and never returns data to HTTP.
// Private Source ports/keys must remain unreachable to untrusted clients.
export class ViewerAccess {
 #registry;#resolve;#grants=new Map();#tokens=new Map();#links=new Set();#resolving=0;#wss;#closed=false;#limit;#connections;#deadline;#buffer;
 constructor({registry,resolveSource,maxGrants=1024,maxConnections=16,connectTimeoutMs=5000,maxBufferedBytes=32*1024*1024}={}){
  if(!(registry instanceof SessionRegistry)||typeof resolveSource!=='function'||!integer(maxGrants,1,10000)||!integer(maxConnections,1,64)||!integer(connectTimeoutMs,50,10000)||!integer(maxBufferedBytes,1024,64*1024*1024))throw new TypeError('Configure bounded Viewer access and an explicit private Source resolver');
  this.#registry=registry;this.#resolve=resolveSource;this.#limit=maxGrants;this.#connections=maxConnections;this.#deadline=connectTimeoutMs;this.#buffer=maxBufferedBytes;
  this.#wss=new WebSocketServer({noServer:true,maxPayload:32*1024,perMessageDeflate:false,handleProtocols:()=>false});
 }
 usesRegistry(registry){return this.#registry===registry;}
 #confirmed(){const state=this.#registry.persistence();if(this.#closed||state.mode!=='durable'||state.confirmation!=='confirmed')fail('REGISTRY_STORAGE_UNAVAILABLE',503);}
 #ready(row){
  this.#confirmed();const session=this.#registry.requireReady(row.tenantId,row.sessionId);
  if(row.version!==undefined&&(row.version!==session.version||row.readyAt!==session.readyAt))fail('SESSION_NOT_READY',409);
  return session;
 }
 #alive(row){try{return !row.revoked&&this.#grants.get(row.id)===row&&Date.now()<row.expires&&performance.now()<row.deadline&&!!this.#ready(row);}catch{return false;}}
 #drop(row){row.revoked=true;this.#tokens.delete(row.tokenHash);this.#grants.delete(row.id);for(const link of [...row.links])link.close(1008,'Viewer access ended');}
 #prune(){for(const row of this.#grants.values())if(Date.now()>=row.expires||performance.now()>=row.deadline)this.#drop(row);}
 issue(value){
  fields(value,['tenantId','sessionId','role','audience','ttlSeconds']);
  const {tenantId,sessionId,role}=value,audience=origin(value.audience),ttlSeconds=value.ttlSeconds??60;
  if(!['readonly','controller'].includes(role)||!integer(ttlSeconds,1,120))fail('INVALID_VIEWER_GRANT');
  const session=this.#ready({tenantId,sessionId});this.#prune();if(this.#grants.size>=this.#limit)fail('VIEWER_CAPACITY',429);
  const now=Date.now(),expires=Math.min(now+ttlSeconds*1000,Date.parse(session.expiresAt));if(expires<=now)fail('SESSION_EXPIRED',410);
  const token='vwt1.'+randomBytes(32).toString('base64url'),row={id:'vgr_'+randomUUID(),tenantId,sessionId,region:session.region,version:session.version,readyAt:session.readyAt,role,audience,expires,deadline:performance.now()+expires-now,tokenHash:hash(token),links:new Set(),revoked:false};
  this.#grants.set(row.id,row);this.#tokens.set(row.tokenHash,row);
  return Object.freeze({...publicGrant(row),ticket:token,streamPath:'/v1/viewer/stream?ticket='+token});
 }
 #find({tenantId,sessionId,grantId}){
  this.#confirmed();const row=this.#grants.get(grantId);if(!row||row.revoked||row.tenantId!==tenantId||row.sessionId!==sessionId)fail('VIEWER_GRANT_NOT_FOUND',404);return row;
 }
 get(value){return publicGrant(this.#find(value));}
 refresh(value){
  fields(value,['tenantId','sessionId','grantId','ttlSeconds']);const row=this.#find(value);this.#ready(row);
  // Explicit refresh may renew an expired ticket while its Session is Ready.
  // Issue first so capacity/validation failure does not silently revoke access.
  this.#grants.delete(row.id);
  let grant;try{grant=this.issue({tenantId:row.tenantId,sessionId:row.sessionId,role:row.role,audience:row.audience,ttlSeconds:value.ttlSeconds});}catch(error){this.#grants.set(row.id,row);throw error;}
  this.#drop(row);return grant;
 }
 revoke(value){const row=this.#find(value);this.#drop(row);return Object.freeze({grantId:row.id,revoked:true});}
 handleUpgrade(req,socket,head){void this.#upgrade(req,socket,head);}
 async #upgrade(req,socket,head){
  let link;
  const reject=status=>{if(!socket.destroyed)socket.end(`HTTP/1.1 ${status} ${status===403?'Forbidden':'Service Unavailable'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
  try{
   const match=typeof req.url==='string'&&/^\/v1\/viewer\/stream\?ticket=(vwt1\.[A-Za-z0-9_-]{43})$/.exec(req.url);
   const origins=[];for(let i=0;i<req.rawHeaders.length;i+=2)if(req.rawHeaders[i].toLowerCase()==='origin')origins.push(req.rawHeaders[i+1]);
   if(!match||req.method!=='GET'||origins.length!==1||req.rawHeaders.length>128||head.length>32*1024)return reject(403);
   const row=this.#tokens.get(hash(match[1]));if(!row||origins[0]!==row.audience||!this.#alive(row))return reject(403);
   // One connection per grant. Each tab receives its own revocable grant.
   if(row.links.size||this.#links.size>=this.#connections||this.#resolving>=this.#connections)return reject(503);
   const controller=new AbortController();let upstream,downstream,timer,watchdog,kill,disposed=false,hello=false;
   const close=(code=1008,reason='Viewer access ended')=>{
    if(disposed)return;disposed=true;clearTimeout(timer);clearInterval(watchdog);controller.abort();upstream?.terminate();
    if(downstream&&downstream.readyState!==WebSocket.CLOSED){if(downstream.readyState===WebSocket.OPEN)downstream.close(code,reason);kill=setTimeout(()=>downstream.terminate(),250);kill.unref();}else if(!downstream&&!socket.writableEnded)socket.destroy();
    row.links.delete(link);this.#links.delete(link);
   };
   link={close,get buffered(){return (upstream?.bufferedAmount??0)+(downstream?.bufferedAmount??0);}};
   row.links.add(link);this.#links.add(link);socket.once('close',()=>close());socket.once('error',()=>close());
   const deadline=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('Connect ended')),{once:true});timer=setTimeout(()=>controller.abort(),this.#deadline);timer.unref();});
   const work=(async()=>{
    // A non-cooperative resolver retains its admission even after timeout or
    // revoke. Late success is fenced before any private socket is allocated.
    this.#resolving++;
    const resolving=Promise.resolve().then(()=>this.#resolve(Object.freeze({tenantId:row.tenantId,sessionId:row.sessionId,region:row.region,version:row.version,signal:controller.signal})));
    void resolving.then(()=>{this.#resolving--;},()=>{this.#resolving--;});
    const target=await resolving;
    if(disposed||controller.signal.aborted||!this.#alive(row))throw new Error('Access ended');
    if(data(target,'tenantId')!==row.tenantId||data(target,'sessionId')!==row.sessionId||data(target,'region')!==row.region||data(target,'version')!==row.version)throw new Error('Private binding mismatch');
    const key=data(target,'key'),privateOrigin=data(target,'origin'),streamOrigin=data(target,'streamOrigin');
    if(typeof key!=='string'||!/^[A-Za-z0-9_-]{32,256}$/.test(key)||typeof privateOrigin!=='string'||typeof streamOrigin!=='string')throw new Error('Invalid private transport');
    const url=new URL(streamOrigin),sourceOrigin=new URL(privateOrigin);
    if(url.origin!==streamOrigin||!['http:','https:'].includes(url.protocol)||!['http:','https:'].includes(sourceOrigin.protocol)||sourceOrigin.origin!==privateOrigin)throw new Error('Invalid private transport');
    url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/stream';url.searchParams.set('key',key);
    upstream=new WebSocket(url,{origin:privateOrigin,perMessageDeflate:false,maxPayload:LIVE_LIMITS.resourceBytes+LIVE_LIMITS.sceneBytes,handshakeTimeout:this.#deadline});
    upstream.on('error',()=>{if(downstream)close(1011,'Viewer transport unavailable');});
    upstream.on('close',code=>close([1000,1001,1008,1012,1013].includes(code)?code:1011,'Viewer transport ended'));
    await new Promise((resolve,reject)=>{upstream.once('open',resolve);upstream.once('error',reject);upstream.once('unexpected-response',(_req,res)=>{res.resume();reject(new Error('Private transport rejected'));});});
   })();
   try{await Promise.race([work,deadline]);}catch{reject(503);close(1011,'Viewer transport unavailable');return;}
   clearTimeout(timer);if(disposed||socket.destroyed||!this.#alive(row)){close();return;}
   const bounded=(ws,bytes)=>ws.readyState===WebSocket.OPEN&&ws.bufferedAmount+bytes<=this.#buffer&&[...this.#links].reduce((n,l)=>n+l.buffered,0)+bytes<=this.#buffer*2;
   this.#wss.handleUpgrade(req,socket,head,ws=>{
    downstream=ws;ws.on('error',()=>close());ws.on('close',()=>{clearTimeout(kill);close();});
    const connected=performance.now();let rateAt=connected,messages=0;
    watchdog=setInterval(()=>{if(!this.#alive(row)||!hello&&performance.now()-connected>=10000)close();},250);watchdog.unref();
    ws.on('message',(bytes,binary)=>{
     if(disposed)return;
     try{
      if(performance.now()-rateAt>=1000){rateAt=performance.now();messages=0;}
      if(!this.#alive(row)||binary||++messages>512)throw new Error('Forbidden');let message=JSON.parse(bytes.toString());
      if(!message||typeof message!=='object'||Array.isArray(message))throw new Error('Invalid message');
      if(!hello){
       if(message.type!=='Hello'||message.consumerKind!==undefined&&message.consumerKind!=='display'||message.capabilities!==undefined&&(!Array.isArray(message.capabilities)||message.capabilities.length>32||message.capabilities.some(v=>typeof v!=='string'||v.length>64)))throw new Error('Invalid handshake');
       hello=true;message={type:'Hello',protocol:message.protocol,renderer:message.renderer,viewerBuild:message.viewerBuild,frameWindow:message.frameWindow,capabilities:(message.capabilities??[]).filter(v=>v!=='control-channel-v1'&&(row.role==='controller'||v!=='input-feedback-v1'))};
      }else if(!['FrameAck','RequestKeyframe'].includes(message.type)&&!(row.role==='controller'&&controls.has(message.type)))throw new Error('Forbidden');
      const packet=JSON.stringify(message);if(!bounded(upstream,Buffer.byteLength(packet)))throw new Error('Queue limit');upstream.send(packet);
     }catch{close(1008,'Viewer message forbidden');}
    });
    upstream.on('message',(bytes,binary)=>{
     if(disposed)return;
     try{
      if(!this.#alive(row))return close();let packet=bytes;
      if(!binary){
       if(bytes.length>LIVE_LIMITS.sceneBytes)throw new Error('Metadata limit');const message=JSON.parse(bytes.toString());
       if(message.type==='Welcome'){
        // Inline upstream control avoids exposing private pairing credentials.
        packet=JSON.stringify({type:'Welcome',protocol:message.protocol,renderer:message.renderer,producer:message.producer,mode:message.mode,peerId:message.peerId,sessionId:message.sessionId,frameWindow:message.frameWindow,ackStage:message.ackStage,resourceMemory:message.resourceMemory,input:row.role==='controller'&&message.input===true,inputFeedback:row.role==='controller'&&message.inputFeedback===true,control:null,viewerRole:row.role,viewerSessionId:row.sessionId,viewerVersion:row.version,viewerGrantId:row.id});
       }else if(row.role==='readonly'&&['ControlGranted','ControlState','ControlDenied','InputAck','FeedbackState'].includes(message.type))return;
      }
      if(!bounded(ws,Buffer.byteLength(packet)))throw new Error('Queue limit');ws.send(packet,{binary});
     }catch{close(1011,'Viewer transport unavailable');}
    });
   });
  }catch{reject(503);link?.close(1011,'Viewer transport unavailable');}
 }
 close(){if(this.#closed)return;this.#closed=true;for(const row of [...this.#grants.values()])this.#drop(row);this.#wss.close();}
}
