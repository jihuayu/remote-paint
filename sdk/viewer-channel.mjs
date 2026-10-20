const integer=(v,min=1,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const codes=new Set(['CHANNEL_CLOSED','CHANNEL_PROTOCOL','CHANNEL_TIMEOUT','CHANNEL_ABORTED','CHANNEL_BUSY','CHANNEL_HANDLER_FAILED','VIEWER_INVALID_CONFIG','VIEWER_INVALID_TICKET','VIEWER_CLOSED','VIEWER_ABORTED','VIEWER_ACCESS_ENDED','VIEWER_PROTOCOL_ERROR','VIEWER_STREAM_CLOSED','VIEWER_TICKET_BUSY','VIEWER_TICKET_TIMEOUT','VIEWER_TICKET_UNAVAILABLE','VIEWER_HANDSHAKE_TIMEOUT','VIEWER_TRANSPORT_UNAVAILABLE','VIEWER_CONFIG_INVALID','VIEWER_CONFIG_TIMEOUT','VIEWER_CONFIG_ABORTED','VIEWER_CONTROL_UNAVAILABLE','VIEWER_CONTROL_BUSY','VIEWER_CONTROL_DENIED','VIEWER_CONTROL_STALE','VIEWER_VIEWPORT_UNSUPPORTED','VIEWER_VIEWPORT_DENIED','VIEWER_VIEWPORT_FAILED']);
export class ViewerChannelError extends Error {constructor(code){super('Viewer channel unavailable');this.name='ViewerChannelError';this.code=codes.has(code)?code:'CHANNEL_HANDLER_FAILED';}}
const fail=code=>{throw new ViewerChannelError(code);};
export const channelCode=value=>typeof value==='string'&&codes.has(value)?value:'CHANNEL_HANDLER_FAILED';
export function viewerOrigin(value){
 if(typeof value!=='string'||value.length>2048)fail('VIEWER_INVALID_CONFIG');let url;try{url=new URL(value);}catch{fail('VIEWER_INVALID_CONFIG');}
 if(url.origin!==value||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))fail('VIEWER_INVALID_CONFIG');return value;
}
export function viewerNonce(){const bytes=new Uint8Array(32);globalThis.crypto.getRandomValues(bytes);return [...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');}
export const validNonce=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,names)=>plain(value)&&Object.keys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k));
const methods=new Set(['connect','disconnect','state','ticket','take-control','release-control']),events=new Set(['ready','state','control']);
const bytes=text=>new TextEncoder().encode(text).byteLength;
function encode(value){let text;try{text=JSON.stringify(value);}catch{fail('CHANNEL_PROTOCOL');}if(typeof text!=='string'||text.length>16384||bytes(text)>16384)fail('CHANNEL_PROTOCOL');return text;}
function parse(text){if(typeof text!=='string'||text.length>16384||bytes(text)>16384)fail('CHANNEL_PROTOCOL');try{return JSON.parse(text);}catch{fail('CHANNEL_PROTOCOL');}}
export function viewerHello(channel){if(!validNonce(channel))fail('VIEWER_INVALID_CONFIG');return encode({protocol:1,type:'remote-paint-hello',channel});}
export function readViewerHello(text){try{const v=parse(text);return exact(v,['protocol','type','channel'])&&v.protocol===1&&v.type==='remote-paint-hello'&&validNonce(v.channel)?v.channel:null;}catch{return null;}}
export function viewerPort(port){return port&&['postMessage','addEventListener','removeEventListener','start','close'].every(k=>typeof port[k]==='function');}

// Capability transport: the port is obtained only after exact Window/Origin
// bootstrap. Directional request counters and channel nonce prevent reuse.
export class ViewerPort {
 #port;#channel;#handler;#notify;#closedCallback;#closed=false;#out=new Map();#in=new Map();#sent=0;#received=0;#limit;#timeout;#timer;#last=performance.now();#rateAt=performance.now();#rate=0;#ping=0;#peerPing=0;#listeners;
 constructor({port,channel,handle,notify,onClose,maxPending=8,requestTimeoutMs=10000,heartbeatMs=1000,idleTimeoutMs=15000}={}){
  if(!viewerPort(port)||!validNonce(channel)||typeof handle!=='function'||notify!==undefined&&typeof notify!=='function'||onClose!==undefined&&typeof onClose!=='function'||!integer(maxPending,1,16)||!integer(requestTimeoutMs,50,20000)||!integer(heartbeatMs,50,5000)||!integer(idleTimeoutMs,heartbeatMs*2,60000))fail('VIEWER_INVALID_CONFIG');
  this.#port=port;this.#channel=channel;this.#handler=handle;this.#notify=notify;this.#closedCallback=onClose;this.#limit=maxPending;this.#timeout=requestTimeoutMs;
  this.#listeners={message:event=>{try{this.#receive(event.data);}catch(error){this.close(error instanceof ViewerChannelError?error.code:'CHANNEL_PROTOCOL');}},messageerror:()=>this.close('CHANNEL_PROTOCOL'),close:()=>this.#finish('CHANNEL_CLOSED',false)};
  for(const [type,handler]of Object.entries(this.#listeners))port.addEventListener(type,handler);port.start();
  this.#timer=setInterval(()=>{if(performance.now()-this.#last>idleTimeoutMs){this.close('CHANNEL_TIMEOUT');return;}try{this.#post({type:'ping',id:++this.#ping});}catch{this.close('CHANNEL_CLOSED');}},heartbeatMs);this.#timer.unref?.();
 }
 get closed(){return this.#closed;}
 get pending(){return Object.freeze({outgoing:this.#out.size,incoming:this.#in.size});}
 #post(value){if(this.#closed)fail('CHANNEL_CLOSED');const text=encode({protocol:1,channel:this.#channel,...value});try{this.#port.postMessage(text);}catch{this.#finish('CHANNEL_CLOSED',false);fail('CHANNEL_CLOSED');}}
 request(method,data=null,{signal,timeoutMs=this.#timeout}={}){
  if(this.#closed)return Promise.reject(new ViewerChannelError('CHANNEL_CLOSED'));
  if(!methods.has(method)||!integer(timeoutMs,50,20000)||signal!==undefined&&!(signal instanceof AbortSignal))return Promise.reject(new ViewerChannelError('VIEWER_INVALID_CONFIG'));
  if(signal?.aborted)return Promise.reject(new ViewerChannelError('CHANNEL_ABORTED'));if(this.#out.size>=this.#limit)return Promise.reject(new ViewerChannelError('CHANNEL_BUSY'));
  const id=++this.#sent;if(!integer(id)){this.close('CHANNEL_PROTOCOL');return Promise.reject(new ViewerChannelError('CHANNEL_PROTOCOL'));}
  return new Promise((resolve,reject)=>{
   const finish=(error,value)=>{if(!this.#out.has(id))return;this.#out.delete(id);clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(value);};
   const cancel=code=>{try{this.#post({type:'cancel',id});}catch{}finish(new ViewerChannelError(code));};
   const abort=()=>cancel('CHANNEL_ABORTED'),timer=setTimeout(()=>cancel('CHANNEL_TIMEOUT'),timeoutMs);timer.unref?.();
   this.#out.set(id,{finish});signal?.addEventListener('abort',abort,{once:true});
   try{this.#post({type:'request',id,method,data});}catch(error){finish(error);}
  });
 }
 notify(name,data){if(!events.has(name))fail('VIEWER_INVALID_CONFIG');this.#post({type:'event',name,data});}
 #receive(text){
  const message=parse(text);if(!plain(message)||message.protocol!==1||message.channel!==this.#channel)fail('CHANNEL_PROTOCOL');
  if(performance.now()-this.#rateAt>=1000){this.#rateAt=performance.now();this.#rate=0;}if(++this.#rate>128)fail('CHANNEL_PROTOCOL');this.#last=performance.now();
  if(message.type==='request'){
   if(!exact(message,['protocol','channel','type','id','method','data'])||!integer(message.id)||message.id<=this.#received||!methods.has(message.method))fail('CHANNEL_PROTOCOL');this.#received=message.id;
   if(this.#in.size>=this.#limit){this.#post({type:'reply',id:message.id,ok:false,code:'CHANNEL_BUSY'});return;}
   const controller=new AbortController(),record={controller,replied:false,timer:null};this.#in.set(message.id,record);
   const reply=(ok,value)=>{if(record.replied||this.#closed)return;record.replied=true;try{this.#post(ok?{type:'reply',id:message.id,ok:true,value:value??null}:{type:'reply',id:message.id,ok:false,code:channelCode(value)});}catch{this.close('CHANNEL_PROTOCOL');}};
   record.timer=setTimeout(()=>{controller.abort();reply(false,'CHANNEL_TIMEOUT');},this.#timeout);record.timer.unref?.();
   const work=Promise.resolve().then(()=>{if(controller.signal.aborted)fail('CHANNEL_ABORTED');return this.#handler(message.method,message.data,{signal:controller.signal});});
   void work.then(value=>{if(!controller.signal.aborted)reply(true,value);},error=>{if(!controller.signal.aborted)reply(false,Object.getOwnPropertyDescriptor(error??{},'code')?.value);}).finally(()=>{clearTimeout(record.timer);this.#in.delete(message.id);});return;
  }
  if(message.type==='reply'){
   if(typeof message.ok!=='boolean'||!exact(message,message.ok?['protocol','channel','type','id','ok','value']:['protocol','channel','type','id','ok','code'])||!integer(message.id)||message.id>this.#sent||!message.ok&&channelCode(message.code)!==message.code)fail('CHANNEL_PROTOCOL');
   this.#out.get(message.id)?.finish(message.ok?null:new ViewerChannelError(message.code),message.value);return;
  }
  if(message.type==='cancel'){
   if(!exact(message,['protocol','channel','type','id'])||!integer(message.id)||message.id>this.#received)fail('CHANNEL_PROTOCOL');const record=this.#in.get(message.id);if(record){record.replied=true;record.controller.abort();}return;
  }
  if(message.type==='event'){
   if(!exact(message,['protocol','channel','type','name','data'])||!events.has(message.name))fail('CHANNEL_PROTOCOL');this.#notify?.(message.name,message.data);return;
  }
  if(message.type==='ping'||message.type==='pong'){
   if(!exact(message,['protocol','channel','type','id'])||!integer(message.id))fail('CHANNEL_PROTOCOL');
   if(message.type==='ping'){if(message.id<=this.#peerPing)fail('CHANNEL_PROTOCOL');this.#peerPing=message.id;this.#post({type:'pong',id:message.id});}else if(message.id>this.#ping)fail('CHANNEL_PROTOCOL');return;
  }
  if(message.type==='close'){
   if(!exact(message,['protocol','channel','type','code'])||channelCode(message.code)!==message.code)fail('CHANNEL_PROTOCOL');this.#finish(message.code,false);return;
  }
  fail('CHANNEL_PROTOCOL');
 }
 #finish(code,send){
  if(this.#closed)return;if(send){try{this.#port.postMessage(encode({protocol:1,channel:this.#channel,type:'close',code:channelCode(code)}));}catch{}}
  this.#closed=true;clearInterval(this.#timer);
  for(const [type,handler]of Object.entries(this.#listeners))this.#port.removeEventListener(type,handler);
  for(const record of [...this.#out.values()])record.finish(new ViewerChannelError(code));
  for(const record of this.#in.values()){record.replied=true;clearTimeout(record.timer);record.controller.abort();}
  this.#in.clear();this.#port.close();try{this.#closedCallback?.(new ViewerChannelError(code));}catch{}
 }
 close(code='CHANNEL_CLOSED'){this.#finish(channelCode(code),true);}
}
