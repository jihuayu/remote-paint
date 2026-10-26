const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const text=(v,max)=>typeof v==='string'&&v.length>0&&v.length<=max;
const roles=new Set(['readonly','controller']);
const transient=new Set(['VIEWER_TICKET_BUSY','VIEWER_TICKET_TIMEOUT','VIEWER_TICKET_UNAVAILABLE','VIEWER_HANDSHAKE_TIMEOUT','VIEWER_TRANSPORT_UNAVAILABLE']);
const codes=new Set([...transient,'VIEWER_INVALID_CONFIG','VIEWER_INVALID_TICKET','VIEWER_CLOSED','VIEWER_ABORTED','VIEWER_ACCESS_ENDED','VIEWER_PROTOCOL_ERROR','VIEWER_STREAM_CLOSED']);
export class ViewerConnectionError extends Error {
 constructor(code){super('Viewer connection failed');this.name='ViewerConnectionError';this.code=codes.has(code)?code:'VIEWER_TICKET_UNAVAILABLE';this.retryable=transient.has(this.code);}
}
const fail=code=>{throw new ViewerConnectionError(code);};
function fields(value,allowed,code='VIEWER_INVALID_CONFIG'){
 if(!value||typeof value!=='object')fail(code);const prototype=Object.getPrototypeOf(value);
 // Ordinary data objects can cross a same-origin iframe/realm boundary.
 // Reject class instances and inherited/accessor options before reading them.
 if(prototype!==null&&Object.getPrototypeOf(prototype)!==null||allowed.some(k=>!Object.hasOwn(value,k)&&prototype!==null&&Object.hasOwn(prototype,k))||Reflect.ownKeys(value).some(k=>!allowed.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))fail(code);
}
function origin(value){
 if(!text(value,2048))fail('VIEWER_INVALID_CONFIG');let url;try{url=new URL(value);}catch{fail('VIEWER_INVALID_CONFIG');}
 if(url.origin!==value||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail('VIEWER_INVALID_CONFIG');return value;
}
function config(value,extra=[]){
 fields(value,['gatewayOrigin','audience','sessionId','role','version','getTicket','requestTimeoutMs',...extra]);
 const {sessionId,role,version,getTicket}=value,requestTimeoutMs=value.requestTimeoutMs??5000;
 if(typeof sessionId!=='string'||!/^ses_[A-Za-z0-9_-]{1,124}$/.test(sessionId)||!roles.has(role)||version!==undefined&&!text(version,256)||typeof getTicket!=='function'||!integer(requestTimeoutMs,50,10000))fail('VIEWER_INVALID_CONFIG');
 return Object.freeze({gatewayOrigin:origin(value.gatewayOrigin),audience:origin(value.audience),sessionId,role,...(version===undefined?{}:{version}),requestTimeoutMs});
}
function grant(value,settings,version){
 const keys=['grantId','sessionId','version','role','audience','expiresAt','ticket','streamPath'];fields(value,keys,'VIEWER_INVALID_TICKET');
 if(Object.keys(value).length!==keys.length||typeof value.grantId!=='string'||!/^vgr_[a-f0-9-]{36}$/.test(value.grantId)||value.sessionId!==settings.sessionId||value.role!==settings.role||value.audience!==settings.audience||!text(value.version,256)||version!==null&&value.version!==version||typeof value.ticket!=='string'||!/^vwt1\.[A-Za-z0-9_-]{43}$/.test(value.ticket)||value.streamPath!=='/v1/viewer/stream?ticket='+value.ticket||!text(value.expiresAt,32))fail('VIEWER_INVALID_TICKET');
 const expires=Date.parse(value.expiresAt);if(!Number.isFinite(expires)||new Date(expires).toISOString()!==value.expiresAt||expires<=Date.now())fail('VIEWER_INVALID_TICKET');
 return Object.freeze(Object.fromEntries(keys.map(k=>[k,value[k]])));
}

function cachePermission(message,ticket){
 if(!Object.hasOwn(message,'resourceCache'))return null;
 const cache=message.resourceCache,renderer=message.renderer;
 fields(cache,['schema','namespace'],'VIEWER_PROTOCOL_ERROR');fields(renderer,['canvaskit','wasmSha256'],'VIEWER_PROTOCOL_ERROR');
 if(Object.keys(cache).length!==2||cache.schema!=='viewer-resource-cache-v1'||typeof cache.namespace!=='string'||!/^vrc1_[a-f0-9]{64}$/.test(cache.namespace)||Object.keys(renderer).length!==2||!text(renderer.canvaskit,64)||typeof renderer.wasmSha256!=='string'||!/^([a-f0-9]{64})$/.test(renderer.wasmSha256))fail('VIEWER_PROTOCOL_ERROR');
 return Object.freeze({schema:'viewer-resource-cache-v1',namespace:cache.namespace,sessionId:ticket.sessionId,version:ticket.version,role:ticket.role,grantId:ticket.grantId,expiresAt:ticket.expiresAt,renderer:Object.freeze({canvaskit:renderer.canvaskit,wasmSha256:renderer.wasmSha256})});
}

// Browser-safe callback boundary. No management credentials, imports or fetch.
// Cancellation ends this wait; a non-cooperative callback retains its slot.
export class ViewerTicketSource {
 #settings;#get;#version;#previous=null;#previousRole=null;#epoch=0;#pending=null;#abort=null;#closed=false;
 constructor(options){this.#settings=config(options);this.#get=options.getTicket;this.#version=options.version??null;}
 get settings(){return Object.freeze({...this.#settings,...(this.#version===null?{}:{version:this.#version})});}
 get busy(){return this.#pending!==null;}
 setRole(role){if(this.#closed)fail('VIEWER_CLOSED');if(!roles.has(role))fail('VIEWER_INVALID_CONFIG');if(role!==this.#settings.role){this.#settings=Object.freeze({...this.#settings,role});this.#epoch++;this.#abort?.abort();}return this.settings;}
 async getTicket({signal,reason='connect'}={}){
  if(this.#closed)fail('VIEWER_CLOSED');if(signal!==undefined&&!(signal instanceof AbortSignal)||!['connect','reconnect','refresh'].includes(reason))fail('VIEWER_INVALID_CONFIG');
  if(signal?.aborted)fail('VIEWER_ABORTED');if(this.#pending)fail('VIEWER_TICKET_BUSY');
  const settings=this.#settings,epoch=this.#epoch,controller=new AbortController();this.#abort=controller;let timedOut=false,timer;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const deadline=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new ViewerConnectionError(timedOut?'VIEWER_TICKET_TIMEOUT':'VIEWER_ABORTED')),{once:true});timer=setTimeout(()=>{timedOut=true;controller.abort();},this.#settings.requestTimeoutMs);});
  const request=Object.freeze({signal:controller.signal,reason,role:settings.role,previousGrantId:this.#previous,previousRole:this.#previousRole});
  const pending=this.#pending=Promise.resolve().then(()=>{if(controller.signal.aborted||epoch!==this.#epoch)fail('VIEWER_ABORTED');return this.#get(request);});
  void pending.then(()=>{if(this.#pending===pending)this.#pending=null;},()=>{if(this.#pending===pending)this.#pending=null;});
  try{
   const value=await Promise.race([pending,deadline]);if(controller.signal.aborted||this.#closed||epoch!==this.#epoch)fail('VIEWER_ABORTED');
   const ticket=grant(value,settings,this.#version);this.#version=ticket.version;this.#previous=ticket.grantId;this.#previousRole=ticket.role;return ticket;
  }catch(error){if(error instanceof ViewerConnectionError)throw error;fail('VIEWER_TICKET_UNAVAILABLE');}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(this.#abort===controller)this.#abort=null;}
 }
 destroy(){if(this.#closed)return;this.#closed=true;this.#abort?.abort();}
}

// Socket lifetime shared by main-thread and Worker renderers. Frame parsing,
// rendering, ACKs and input remain in the existing Viewer runtime.
export class ViewerConnection {
 #source;#settings;#WebSocket;#onSocket;#onState;#onError;#socket=null;#grant=null;#abort=null;#epoch=0;#stopped=true;#closed=false;#timer;#handshake;#failures=0;#maxRetries;#refreshBefore;#connectTimeout;#welcome=false;#state='paused';#onCacheState;#cachePermission=null;#cachePrevious=null;#cacheExpiry;#cacheMode='revoked';
 constructor(options){
  this.#settings=config(options,['WebSocket','onSocket','onState','onError','onCacheState','maxRetries','refreshBeforeMs','connectTimeoutMs']);
  const {getTicket}=options;this.#source=new ViewerTicketSource({...this.#settings,getTicket});this.#WebSocket=options.WebSocket??globalThis.WebSocket;this.#onSocket=options.onSocket;this.#onState=options.onState;this.#onError=options.onError;
  this.#onCacheState=options.onCacheState;
  this.#maxRetries=options.maxRetries??3;this.#refreshBefore=options.refreshBeforeMs??5000;this.#connectTimeout=options.connectTimeoutMs??10000;
  if(typeof this.#WebSocket!=='function'||typeof this.#onSocket!=='function'||this.#onState!==undefined&&typeof this.#onState!=='function'||this.#onError!==undefined&&typeof this.#onError!=='function'||this.#onCacheState!==undefined&&typeof this.#onCacheState!=='function'||!integer(this.#maxRetries,0,5)||!integer(this.#refreshBefore,50,30000)||!integer(this.#connectTimeout,50,20000))fail('VIEWER_INVALID_CONFIG');
 }
 get state(){return Object.freeze({state:this.#state,sessionId:this.#settings.sessionId,role:this.#settings.role,attempt:this.#failures,version:this.#grant?.version??this.#settings.version??null});}
 get resourceCachePermission(){return this.#cachePermission;}
 #cacheState(state){const permission=this.#cachePermission??this.#cachePrevious;if(state==='authorized')this.#cachePrevious=permission;else this.#cachePermission=null;if(state==='revoked'){clearTimeout(this.#cacheExpiry);this.#cachePrevious=null;}if(this.#cacheMode===state)return;this.#cacheMode=state;try{this.#onCacheState?.(Object.freeze({state,permission}));}catch{}}
 #publish(state,code){this.#state=state;try{this.#onState?.(Object.freeze({...this.state,...(code?{code}:{})}));}catch{}}
 #clear(purge=false){this.#cacheState(purge?'revoked':'suspended');clearTimeout(this.#timer);clearTimeout(this.#handshake);this.#abort?.abort();this.#abort=null;const socket=this.#socket;this.#socket=null;if(socket&&socket.readyState<2){try{socket.close(1000,'Viewer connection reset');}catch{}}}
 start(){if(this.#closed)fail('VIEWER_CLOSED');this.#stopped=false;this.#failures=0;return this.#open('connect');}
 async #open(reason){
  if(this.#closed||this.#stopped)return;const epoch=++this.#epoch;this.#clear();if(epoch!==this.#epoch||this.#stopped||this.#closed)return;this.#grant=null;this.#welcome=false;const controller=this.#abort=new AbortController();
  this.#publish(reason==='refresh'?'refreshing':reason==='reconnect'?'reconnecting':'connecting');
  if(epoch!==this.#epoch||this.#stopped||this.#closed)return;
  try{
   const ticket=await this.#source.getTicket({reason,signal:controller.signal});if(epoch!==this.#epoch||this.#stopped||this.#closed)return;
   const url=new URL(this.#settings.gatewayOrigin);url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/v1/viewer/stream';url.searchParams.set('ticket',ticket.ticket);
   const socket=this.#socket=new this.#WebSocket(url.href);this.#grant=ticket;socket.binaryType='arraybuffer';
   socket.addEventListener('error',()=>{});
   socket.addEventListener('close',event=>{
    if(epoch!==this.#epoch||this.#stopped||this.#closed)return;this.#socket=null;clearTimeout(this.#handshake);clearTimeout(this.#timer);
    const code=event.code===1008?'VIEWER_ACCESS_ENDED':event.code===4008?'VIEWER_PROTOCOL_ERROR':event.code===1000?'VIEWER_STREAM_CLOSED':'VIEWER_TRANSPORT_UNAVAILABLE';this.#retry(new ViewerConnectionError(code),epoch);
   });
   this.#handshake=setTimeout(()=>{if(epoch===this.#epoch&&!this.#welcome){this.#epoch++;this.#clear();this.#retry(new ViewerConnectionError('VIEWER_HANDSHAKE_TIMEOUT'),this.#epoch);}},this.#connectTimeout);
   this.#onSocket(socket,ticket,Object.freeze({acceptWelcome:message=>this.#accept(message,epoch)}));
  }catch(error){if(epoch===this.#epoch&&!this.#stopped&&!this.#closed)this.#retry(error instanceof ViewerConnectionError?error:new ViewerConnectionError('VIEWER_TRANSPORT_UNAVAILABLE'),epoch);}
 }
 #accept(message,epoch){
  if(epoch!==this.#epoch||this.#stopped||this.#closed)fail('VIEWER_ABORTED');
  const ticket=this.#grant;
  if(this.#welcome||!ticket||message.viewerSessionId!==ticket.sessionId||message.viewerVersion!==ticket.version||message.viewerGrantId!==ticket.grantId||message.viewerRole!==ticket.role||message.control!==null||ticket.role==='readonly'&&(message.input!==false||message.inputFeedback!==false))fail('VIEWER_PROTOCOL_ERROR');
  const remaining=Math.min(120000,Date.parse(ticket.expiresAt)-Date.now());if(remaining<=0)fail('VIEWER_INVALID_TICKET');
  this.#cachePermission=cachePermission(message,ticket);clearTimeout(this.#cacheExpiry);
  if(this.#cachePermission){const permission=this.#cachePermission;this.#cacheState('authorized');if(epoch!==this.#epoch||this.#stopped||this.#closed)fail('VIEWER_ABORTED');this.#cacheExpiry=setTimeout(()=>{if(this.#cachePrevious===permission)this.#cacheState('revoked');},remaining);this.#cacheExpiry.unref?.();}else this.#cacheState('revoked');
  if(epoch!==this.#epoch||this.#stopped||this.#closed)fail('VIEWER_ABORTED');
  this.#welcome=true;this.#failures=0;clearTimeout(this.#handshake);this.#publish('connected');
  if(epoch!==this.#epoch||this.#stopped||this.#closed)return;
  this.#timer=setTimeout(()=>{void this.#open('refresh');},Math.max(1,remaining-Math.min(this.#refreshBefore,remaining/2)));
 }
 #retry(error,epoch){
  if(epoch!==this.#epoch||this.#stopped||this.#closed)return;this.#failures++;
  const retryEpoch=++this.#epoch;this.#clear(!error.retryable);if(retryEpoch!==this.#epoch||this.#stopped||this.#closed)return;
  if(error.retryable&&this.#failures<=this.#maxRetries){this.#publish('reconnecting',error.code);this.#timer=setTimeout(()=>{void this.#open('reconnect');},Math.min(2000,250*2**(this.#failures-1)));return;}
  this.#stopped=true;this.#publish('failed',error.code);try{this.#onError?.(new ViewerConnectionError(error.code));}catch{}
 }
 stop(){if(this.#closed)return;this.#stopped=true;this.#epoch++;this.#clear();if(!this.#closed)this.#publish('paused');}
 destroy(){if(this.#closed)return;this.#closed=true;this.#stopped=true;this.#epoch++;this.#clear(true);this.#source.destroy();this.#publish('closed');}
}
