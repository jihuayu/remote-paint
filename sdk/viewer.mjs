import {ViewerTicketSource} from './viewer-connection.mjs';
import {ViewerFrameConnection} from './viewer-frame.mjs';
import {emptyViewerControl,viewerViewportSize,viewerControlOptions} from './viewer-control.mjs';
import {emptyViewerPerformance} from './viewer-telemetry.mjs';
import {ViewerChannelError,ViewerViewportError,viewerOrigin} from './viewer-channel.mjs';
export {ViewerChannelError,ViewerViewportError} from './viewer-channel.mjs';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=code=>{throw new ViewerChannelError(code);};
function options(value){
 const names=['viewerOrigin','gatewayOrigin','sessionId','role','version','getTicket','requestTimeoutMs','loadTimeoutMs','connectTimeoutMs','disconnectTimeoutMs','destroyTimeoutMs','title','onState','onError','onControl','onResize','onPerformance','onFirstFrame'];
 if(!value||typeof value!=='object'||Reflect.ownKeys(value).some(k=>!names.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))fail('VIEWER_INVALID_CONFIG');return Object.fromEntries(Reflect.ownKeys(value).map(k=>[k,value[k]]));
}
function deferred(){let resolve,reject;const record={done:false,promise:new Promise((yes,no)=>{resolve=yes;reject=no;})};void record.promise.catch(()=>{});record.resolve=value=>{if(!record.done){record.done=true;resolve(value);}};record.reject=error=>{if(!record.done){record.done=true;reject(error);}};return record;}
function wait(promise,signal){if(signal.aborted)return Promise.reject(new ViewerChannelError('CHANNEL_ABORTED'));return new Promise((resolve,reject)=>{const abort=()=>reject(new ViewerChannelError('CHANNEL_ABORTED'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
function settle(promise,ms){return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);},timer=setTimeout(()=>finish(false),ms);timer.unref?.();Promise.resolve(promise).then(()=>finish(true),()=>finish(false));});}
function roleSignal(value={}){if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==null&&Object.getPrototypeOf(Object.getPrototypeOf(value))!==null||!Object.hasOwn(value,'signal')&&Object.getPrototypeOf(value)!==null&&Object.hasOwn(Object.getPrototypeOf(value),'signal')||Reflect.ownKeys(value).some(k=>k!=='signal'||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'))||value.signal!==undefined&&!(value.signal instanceof AbortSignal))fail('VIEWER_INVALID_CONFIG');return value.signal;}

// Owns one iframe browsing context. Rendering, resources and input remain in
// the existing child Viewer. The application callback owner outlives reloads.
class Viewer {
 #performance=emptyViewerPerformance();#firstFrame=null;
 #displaySize=Object.freeze({scope:'display',mode:'container',width:null,height:null});
 #roleChange=null;#roleAbort=null;
 #control=emptyViewerControl();
 #config;#tickets;#document;#owner;#host;#root;#iframe=null;#frame=null;#frameDead=false;#generation=0;#ready=deferred();#loadTimer;#frameListeners;#pagehide;#observer;#wasConnected=false;#events={state:new Set(),error:new Set()};#desired=false;#paused=false;#failure=null;#operation=null;#connecting=null;#disconnecting=null;#destroying=null;#destroyed=false;#state;
 constructor(container,value){
  const config=options(value),document=container?.ownerDocument,owner=document?.defaultView;
  if(!container||typeof container.appendChild!=='function'||!document||typeof document.createElement!=='function'||!owner||typeof owner.addEventListener!=='function'||typeof owner.removeEventListener!=='function'||!integer(config.loadTimeoutMs??20000,50,60000)||!integer(config.connectTimeoutMs??45000,50,120000)||!integer(config.disconnectTimeoutMs??1000,50,10000)||!integer(config.destroyTimeoutMs??250,0,1000)||config.title!==undefined&&(typeof config.title!=='string'||config.title.length<1||config.title.length>256)||config.onState!==undefined&&typeof config.onState!=='function'||config.onError!==undefined&&typeof config.onError!=='function')fail('VIEWER_INVALID_CONFIG');
  const viewer=viewerOrigin(config.viewerOrigin);
  if(config.onControl!==undefined&&typeof config.onControl!=='function')fail('VIEWER_INVALID_CONFIG');
  if(config.onResize!==undefined&&typeof config.onResize!=='function')fail('VIEWER_INVALID_CONFIG');
  for(const key of ['onPerformance','onFirstFrame'])if(config[key]!==undefined&&typeof config[key]!=='function')fail('VIEWER_INVALID_CONFIG');
  this.#tickets=new ViewerTicketSource({gatewayOrigin:config.gatewayOrigin,audience:viewer,sessionId:config.sessionId,role:config.role??'readonly',getTicket:config.getTicket,...(config.version===undefined?{}:{version:config.version}),...(config.requestTimeoutMs===undefined?{}:{requestTimeoutMs:config.requestTimeoutMs})});
  this.#config={viewerOrigin:viewer,loadTimeoutMs:config.loadTimeoutMs??20000,connectTimeoutMs:config.connectTimeoutMs??45000,disconnectTimeoutMs:config.disconnectTimeoutMs??1000,destroyTimeoutMs:config.destroyTimeoutMs??250,title:config.title??'远程网页'};this.#document=document;this.#owner=owner;
  const host=document.createElement('div');if(typeof host.attachShadow!=='function')fail('VIEWER_INVALID_CONFIG');this.#host=host;this.#root=host.attachShadow({mode:'closed'});
  Object.assign(host.style,{display:'block',position:'relative',width:'100%',height:'100%',minWidth:'0',minHeight:'0',overflow:'hidden'});host.setAttribute('data-remote-paint-viewer','');
  this.#events.control=new Set();this.#events.resize=new Set();if(config.onResize)this.#events.resize.add(config.onResize);if(config.onControl)this.#events.control.add(config.onControl);if(config.onState)this.#events.state.add(config.onState);if(config.onError)this.#events.error.add(config.onError);
  this.#events.performance=new Set();this.#events['first-frame']=new Set();if(config.onPerformance)this.#events.performance.add(config.onPerformance);if(config.onFirstFrame)this.#events['first-frame'].add(config.onFirstFrame);
  this.#pagehide=event=>{if(event.persisted)void this.disconnect();else void this.destroy();};owner.addEventListener('pagehide',this.#pagehide);
  this.#state=this.#snapshot('loading');
  try{
   this.#newIframe();container.appendChild(host);this.#wasConnected=host.isConnected===true;
   if(typeof owner.MutationObserver==='function'&&document.documentElement){this.#observer=new owner.MutationObserver(()=>{if(this.#destroyed)return;if(this.#host.isConnected)this.#wasConnected=true;else if(this.#wasConnected)void this.destroy();});this.#observer.observe(document.documentElement,{childList:true,subtree:true});}
  }catch(error){this.#tickets.destroy();this.#removeFrame();owner.removeEventListener('pagehide',this.#pagehide);host.remove();throw error;}
 }
 get element(){return this.#host;}
 get ready(){return this.#ready.promise;}
 get state(){return this.#state;}
 get control(){return this.#control;}
 get performance(){return this.#performance;}
 get firstFrame(){return this.#firstFrame;}
 #publishPerformance(value){if(JSON.stringify(value)===JSON.stringify(this.#performance))return;this.#performance=value;for(const listener of [...this.#events.performance]){if(this.#performance!==value)break;try{listener(value);}catch{}}}
 #publishFirstFrame(value){this.#firstFrame=value;for(const listener of [...this.#events['first-frame']]){if(this.#firstFrame!==value)break;try{listener(value);}catch{}}}
 #resetTelemetry(){this.#firstFrame=null;this.#publishPerformance(emptyViewerPerformance());}
 get displaySize(){return this.#displaySize;}
 resize(value){
  if(this.#destroyed)fail('VIEWER_CLOSED');let next;
  if(value===undefined)next=Object.freeze({scope:'display',mode:'container',width:null,height:null});
  else{
   if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==null&&Object.getPrototypeOf(Object.getPrototypeOf(value))!==null||Reflect.ownKeys(value).length!==2||!['width','height'].every(k=>Object.hasOwn(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'))||!['width','height'].every(k=>Number.isFinite(value[k])&&value[k]>=1&&value[k]<=16384))fail('VIEWER_INVALID_CONFIG');
   next=Object.freeze({scope:'display',mode:'fixed',width:value.width,height:value.height});
  }
  if(JSON.stringify(next)===JSON.stringify(this.#displaySize))return this.#displaySize;
  Object.assign(this.#host.style,{width:next.mode==='fixed'?next.width+'px':'100%',height:next.mode==='fixed'?next.height+'px':'100%'});this.#displaySize=next;
  for(const listener of [...this.#events.resize])try{listener(next);}catch{}return next;
 }
 #publishControl(value){if(JSON.stringify(value)===JSON.stringify(this.#control))return;this.#control=value;for(const listener of [...this.#events.control])try{listener(value);}catch{}}
 #snapshot(state,code){const settings=this.#tickets.settings;return Object.freeze({state,sessionId:settings.sessionId,role:settings.role,version:settings.version??null,generation:this.#generation,...(code?{code}:{})});}
 #publish(state,code){const value=this.#snapshot(state,code),changed=JSON.stringify(value)!==JSON.stringify(this.#state);this.#state=value;if(state!=='connected')this.#resetTelemetry();if(this.#state!==value||!changed)return;for(const listener of [...this.#events.state]){if(this.#state!==value)break;try{listener(value);}catch{}}}
 on(name,listener){if(this.#destroyed)fail('VIEWER_CLOSED');if(!Object.hasOwn(this.#events,name)||typeof listener!=='function')fail('VIEWER_INVALID_CONFIG');const group=this.#events[name];if(group.size>=64)fail('CHANNEL_BUSY');group.add(listener);const current=name==='state'?this.#state:name==='control'?this.#control:name==='resize'?this.#displaySize:name==='performance'?this.#performance:name==='first-frame'?this.#firstFrame:null;if(current)try{listener(current);}catch{}return ()=>group.delete(listener);}
 #removeFrame(){
  const old=this.#frame;this.#frame=null;old?.close();this.#resetTelemetry();this.#publishControl(emptyViewerControl());
  if(this.#iframe){for(const [name,handler]of Object.entries(this.#frameListeners??{}))this.#iframe.removeEventListener(name,handler);this.#iframe.remove();this.#iframe=null;}
  this.#frameListeners=null;clearTimeout(this.#loadTimer);this.#loadTimer=null;
 }
 #armLoad(iframe){if(this.#loadTimer)return;this.#loadTimer=setTimeout(()=>{this.#loadTimer=null;if(!this.#destroyed&&iframe===this.#iframe)this.#failed(new ViewerChannelError('CHANNEL_TIMEOUT'));},this.#config.loadTimeoutMs);this.#loadTimer.unref?.();}
 #newIframe(){
  const generation=++this.#generation;this.#removeFrame();if(this.#destroyed||generation!==this.#generation)return;this.#frameDead=false;if(this.#ready.done)this.#ready=deferred();
  const iframe=this.#document.createElement('iframe');this.#iframe=iframe;
  iframe.title=this.#config.title;iframe.referrerPolicy='no-referrer';iframe.loading='eager';iframe.setAttribute('sandbox','allow-scripts allow-same-origin');Object.assign(iframe.style,{display:'block',width:'100%',height:'100%',border:'0'});
  this.#frameListeners={load:()=>this.#loaded(iframe),error:()=>{if(iframe===this.#iframe&&!this.#destroyed)this.#failed(new ViewerChannelError('CHANNEL_CLOSED'));}};
  for(const [name,handler]of Object.entries(this.#frameListeners))iframe.addEventListener(name,handler);
  iframe.src=this.#config.viewerOrigin+'/';this.#root.appendChild(iframe);this.#armLoad(iframe);
 }
 #loaded(iframe){
  if(this.#destroyed||iframe!==this.#iframe)return;const generation=++this.#generation,old=this.#frame;this.#frame=null;old?.close();this.#resetTelemetry();if(this.#destroyed||generation!==this.#generation||iframe!==this.#iframe)return;this.#frameDead=false;if(this.#ready.done)this.#ready=deferred();this.#armLoad(iframe);
  if(!this.#failure)this.#publish(this.#paused?'paused':'loading');
  try{
   const settings=this.#tickets.settings;let frame;
   frame=new ViewerFrameConnection({frameWindow:iframe.contentWindow,frameOrigin:this.#config.viewerOrigin,gatewayOrigin:settings.gatewayOrigin,sessionId:settings.sessionId,role:settings.role,...(settings.version===undefined?{}:{version:settings.version}),requestTimeoutMs:settings.requestTimeoutMs,readyTimeoutMs:Math.min(30000,this.#config.loadTimeoutMs),connectTimeoutMs:Math.min(60000,this.#config.connectTimeoutMs),getTicket:request=>this.#tickets.getTicket(request),onState:value=>{
    if(generation!==this.#generation||this.#destroyed||this.#failure)return;
    if(value.state==='failed'){this.#failed(new ViewerChannelError(value.code));return;}
    if(value.state==='closed'&&value.code){this.#frameDead=true;return;}
    const mapped=value.state==='waiting'?(this.#desired?'connecting':this.#paused?'paused':'ready'):value.state==='closed'?'paused':value.state;
    this.#publish(mapped);
   },onControl:value=>{if(generation===this.#generation&&!this.#destroyed&&!this.#failure)this.#publishControl(value);},onPerformance:value=>{if(generation===this.#generation&&!this.#destroyed&&!this.#failure)this.#publishPerformance(value);},onFirstFrame:value=>{if(generation===this.#generation&&!this.#destroyed&&!this.#failure)this.#publishFirstFrame(value);},onError:error=>{if(generation===this.#generation&&!this.#destroyed)this.#failed(error);}});
   this.#frame=frame;
   void frame.ready.then(value=>{if(generation!==this.#generation||this.#destroyed)return;clearTimeout(this.#loadTimer);this.#loadTimer=null;this.#ready.resolve(value);if(!this.#desired&&!this.#failure)this.#publish(this.#paused?'paused':'ready');},error=>{if(generation===this.#generation&&!this.#destroyed)this.#failed(error);});
   if(this.#desired&&!this.#connecting)void this.connect().catch(()=>{});
  }catch(error){this.#failed(error);}
 }
 #failed(error){
  if(this.#destroyed||this.#failure)return;const failure=error instanceof ViewerChannelError?error:new ViewerChannelError(error?.code);this.#failure=failure;this.#desired=false;this.#operation?.abort();this.#ready.reject(failure);this.#generation++;this.#removeFrame();this.#frameDead=true;this.#publish('failed',failure.code);for(const listener of [...this.#events.error])try{listener(failure);}catch{}
 }
 connect(options){if(this.#roleChange)return Promise.reject(new ViewerChannelError('CHANNEL_BUSY'));return this.#connect(options);}
 #connect({signal}={}){
  if(this.#destroyed)return Promise.reject(new ViewerChannelError('VIEWER_CLOSED'));if(signal!==undefined&&!(signal instanceof AbortSignal))return Promise.reject(new ViewerChannelError('VIEWER_INVALID_CONFIG'));if(signal?.aborted)return Promise.reject(new ViewerChannelError('CHANNEL_ABORTED'));
  if(this.#connecting&&this.#desired)return signal?wait(this.#connecting,signal):this.#connecting;
  const previous=this.#connecting,disconnecting=this.#disconnecting,controller=this.#operation=new AbortController();this.#desired=true;this.#paused=false;this.#failure=null;
  if(!this.#iframe||this.#frameDead)this.#newIframe();
  const abort=()=>{if(this.#operation===controller)void this.disconnect();};signal?.addEventListener('abort',abort,{once:true});
  const work=(async()=>{
   const timer=setTimeout(()=>{if(this.#operation===controller)this.#failed(new ViewerChannelError('CHANNEL_TIMEOUT'));},this.#config.connectTimeoutMs);timer.unref?.();
   try{
    if(previous)await previous.catch(()=>{});if(disconnecting)await disconnecting.catch(()=>{});
    for(;;){
     if(controller.signal.aborted||this.#destroyed||!this.#desired)fail('CHANNEL_ABORTED');const generation=this.#generation,ready=this.#ready.promise;
     try{await wait(ready,controller.signal);if(generation!==this.#generation)continue;const frame=this.#frame;if(!frame)continue;await wait(frame.connect({signal:controller.signal}),controller.signal);if(generation!==this.#generation||frame!==this.#frame)continue;this.#publish('connected');return this.#state;}
     catch(error){if(generation!==this.#generation&&!controller.signal.aborted&&this.#desired&&!this.#destroyed)continue;throw error;}
    }
   }catch(error){if(this.#failure)throw this.#failure;if(controller.signal.aborted||!this.#desired||this.#destroyed)throw new ViewerChannelError('CHANNEL_ABORTED');this.#failed(error);throw this.#failure;}
   finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  })();this.#connecting=work;void work.finally(()=>{if(this.#connecting===work)this.#connecting=null;}).catch(()=>{});return work;
 }
 disconnect(){this.#roleAbort?.abort();return this.#disconnect();}
 #disconnect(){
  if(this.#destroyed)return this.#destroying??Promise.resolve();this.#desired=false;this.#paused=true;this.#failure=null;this.#operation?.abort();this.#resetTelemetry();this.#publishControl(emptyViewerControl());if(this.#disconnecting)return this.#disconnecting;const frame=this.#frame;
  const work=(async()=>{const complete=await settle(frame?.disconnect(),this.#config.disconnectTimeoutMs);if(this.#destroyed)return;if(!complete&&frame===this.#frame){this.#generation++;this.#removeFrame();this.#frameDead=true;}if(!this.#desired)this.#publish('paused');})();
  this.#disconnecting=work;void work.finally(()=>{if(this.#disconnecting===work)this.#disconnecting=null;}).catch(()=>{});return work;
 }
 destroy(){
  if(this.#destroying)return this.#destroying;const done=deferred();this.#destroying=done.promise;this.#destroyed=true;this.#desired=false;this.#roleAbort?.abort();this.#operation?.abort();this.#tickets.destroy();this.#ready.reject(new ViewerChannelError('VIEWER_CLOSED'));clearTimeout(this.#loadTimer);this.#owner.removeEventListener('pagehide',this.#pagehide);this.#observer?.disconnect();this.#generation++;
  const frame=this.#frame;this.#frame=null;this.#publishControl(emptyViewerControl());this.#publish('destroyed');
  void(async()=>{try{await settle(frame?.disconnect(),this.#config.destroyTimeoutMs);}finally{frame?.close();this.#removeFrame();this.#host.remove();for(const group of Object.values(this.#events))group.clear();done.resolve();}})();return this.#destroying;
 }
 setRole(role,options){
  let signal;try{if(this.#destroyed)fail('VIEWER_CLOSED');if(!['readonly','controller'].includes(role))fail('VIEWER_INVALID_CONFIG');signal=roleSignal(options);if(signal?.aborted)fail('CHANNEL_ABORTED');if(this.#roleChange)fail('CHANNEL_BUSY');}catch(error){return Promise.reject(error);}
  if(role===this.#tickets.settings.role)return Promise.resolve(this.#state);
  const done=deferred(),controller=new AbortController(),resume=this.#desired,previous=this.#connecting;this.#roleChange=done.promise;this.#roleAbort=controller;this.#generation++;
  const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
  const work=(async()=>{
   try{
    await this.#disconnect();if(this.#destroyed)fail('CHANNEL_ABORTED');this.#generation++;this.#removeFrame();this.#frameDead=true;if(this.#destroyed)fail('CHANNEL_ABORTED');this.#ready.reject(new ViewerChannelError('CHANNEL_ABORTED'));this.#ready=deferred();if(previous)await previous.catch(()=>{});
    if(controller.signal.aborted||this.#destroyed)fail('CHANNEL_ABORTED');this.#tickets.setRole(role);
    if(!resume){this.#publish('paused');return this.#state;}
    return await this.#connect({signal:controller.signal});
   }catch(error){
    if(this.#destroyed)throw new ViewerChannelError('CHANNEL_ABORTED');this.#desired=false;this.#operation?.abort();this.#ready.reject(error);this.#generation++;this.#removeFrame();this.#frameDead=true;
    if(controller.signal.aborted){this.#paused=true;if(!this.#failure)this.#publish('paused');throw new ViewerChannelError('CHANNEL_ABORTED');}if(!this.#failure)this.#failed(error);throw this.#failure;
   }finally{signal?.removeEventListener('abort',abort);if(this.#roleAbort===controller)this.#roleAbort=null;}
  })();const clear=()=>{if(this.#roleChange===done.promise)this.#roleChange=null;};void work.then(value=>{clear();done.resolve(value);},error=>{clear();done.reject(error);});return done.promise;
 }
 setReadonly(value,options){if(typeof value!=='boolean')return Promise.reject(new ViewerChannelError('VIEWER_INVALID_CONFIG'));return this.setRole(value?'readonly':'controller',options);}
 async #controlRequest(method,options){if(this.#destroyed)fail('VIEWER_CLOSED');if(this.#roleChange)fail('CHANNEL_BUSY');const frame=this.#frame,generation=this.#generation;if(!frame||!this.#desired||this.#state.state!=='connected')fail('VIEWER_CONTROL_UNAVAILABLE');const value=await frame[method](options);if(generation!==this.#generation||frame!==this.#frame)fail('CHANNEL_ABORTED');return value;}
 takeControl(options){return this.#controlRequest('takeControl',options);}
 releaseControl(options){return this.#controlRequest('releaseControl',options);}
 async resizeViewport(size,options){
  if(this.#destroyed)throw new ViewerViewportError('VIEWER_CLOSED','not-applied');
  let settings;try{size=viewerViewportSize(size);settings=viewerControlOptions(options);}catch{throw new ViewerViewportError('VIEWER_INVALID_CONFIG','not-applied');}
  if(settings.signal?.aborted)throw new ViewerViewportError('CHANNEL_ABORTED','not-applied');if(this.#roleChange)throw new ViewerViewportError('CHANNEL_BUSY','not-applied');
  const frame=this.#frame,generation=this.#generation;if(!frame||!this.#desired||this.#state.state!=='connected')throw new ViewerViewportError('VIEWER_CONTROL_UNAVAILABLE','not-applied');
  const value=await frame.resizeViewport(size,settings);if(generation!==this.#generation||frame!==this.#frame)throw new ViewerViewportError('CHANNEL_ABORTED','unknown');return value;
 }
}

export function createViewer(container,config){return new Viewer(container,config);}
