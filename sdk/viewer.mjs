import {ViewerTicketSource} from './viewer-connection.mjs';
import {ViewerFrameConnection} from './viewer-frame.mjs';
import {ViewerChannelError,viewerOrigin} from './viewer-channel.mjs';
export {ViewerChannelError} from './viewer-channel.mjs';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=code=>{throw new ViewerChannelError(code);};
function options(value){
 const names=['viewerOrigin','gatewayOrigin','sessionId','role','version','getTicket','requestTimeoutMs','loadTimeoutMs','connectTimeoutMs','disconnectTimeoutMs','destroyTimeoutMs','title','onState','onError'];
 if(!value||typeof value!=='object'||Reflect.ownKeys(value).some(k=>!names.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))fail('VIEWER_INVALID_CONFIG');return Object.fromEntries(Reflect.ownKeys(value).map(k=>[k,value[k]]));
}
function deferred(){let resolve,reject;const record={done:false,promise:new Promise((yes,no)=>{resolve=yes;reject=no;})};void record.promise.catch(()=>{});record.resolve=value=>{if(!record.done){record.done=true;resolve(value);}};record.reject=error=>{if(!record.done){record.done=true;reject(error);}};return record;}
function wait(promise,signal){if(signal.aborted)return Promise.reject(new ViewerChannelError('CHANNEL_ABORTED'));return new Promise((resolve,reject)=>{const abort=()=>reject(new ViewerChannelError('CHANNEL_ABORTED'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});}
function settle(promise,ms){return new Promise(resolve=>{let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);},timer=setTimeout(()=>finish(false),ms);timer.unref?.();Promise.resolve(promise).then(()=>finish(true),()=>finish(false));});}

// Owns one iframe browsing context. Rendering, resources and input remain in
// the existing child Viewer. The application callback owner outlives reloads.
class Viewer {
 #config;#tickets;#document;#owner;#host;#root;#iframe=null;#frame=null;#frameDead=false;#generation=0;#ready=deferred();#loadTimer;#frameListeners;#pagehide;#observer;#wasConnected=false;#events={state:new Set(),error:new Set()};#desired=false;#paused=false;#failure=null;#operation=null;#connecting=null;#disconnecting=null;#destroying=null;#destroyed=false;#state;
 constructor(container,value){
  const config=options(value),document=container?.ownerDocument,owner=document?.defaultView;
  if(!container||typeof container.appendChild!=='function'||!document||typeof document.createElement!=='function'||!owner||typeof owner.addEventListener!=='function'||typeof owner.removeEventListener!=='function'||!integer(config.loadTimeoutMs??20000,50,60000)||!integer(config.connectTimeoutMs??45000,50,120000)||!integer(config.disconnectTimeoutMs??1000,50,10000)||!integer(config.destroyTimeoutMs??250,0,1000)||config.title!==undefined&&(typeof config.title!=='string'||config.title.length<1||config.title.length>256)||config.onState!==undefined&&typeof config.onState!=='function'||config.onError!==undefined&&typeof config.onError!=='function')fail('VIEWER_INVALID_CONFIG');
  const viewer=viewerOrigin(config.viewerOrigin);
  this.#tickets=new ViewerTicketSource({gatewayOrigin:config.gatewayOrigin,audience:viewer,sessionId:config.sessionId,role:config.role??'readonly',getTicket:config.getTicket,...(config.version===undefined?{}:{version:config.version}),...(config.requestTimeoutMs===undefined?{}:{requestTimeoutMs:config.requestTimeoutMs})});
  this.#config={viewerOrigin:viewer,loadTimeoutMs:config.loadTimeoutMs??20000,connectTimeoutMs:config.connectTimeoutMs??45000,disconnectTimeoutMs:config.disconnectTimeoutMs??1000,destroyTimeoutMs:config.destroyTimeoutMs??250,title:config.title??'远程网页'};this.#document=document;this.#owner=owner;
  const host=document.createElement('div');if(typeof host.attachShadow!=='function')fail('VIEWER_INVALID_CONFIG');this.#host=host;this.#root=host.attachShadow({mode:'closed'});
  Object.assign(host.style,{display:'block',position:'relative',width:'100%',height:'100%',minWidth:'0',minHeight:'0',overflow:'hidden'});host.setAttribute('data-remote-paint-viewer','');
  if(config.onState)this.#events.state.add(config.onState);if(config.onError)this.#events.error.add(config.onError);
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
 #snapshot(state,code){const settings=this.#tickets.settings;return Object.freeze({state,sessionId:settings.sessionId,role:settings.role,version:settings.version??null,generation:this.#generation,...(code?{code}:{})});}
 #publish(state,code){const value=this.#snapshot(state,code);if(JSON.stringify(value)===JSON.stringify(this.#state))return;this.#state=value;for(const listener of [...this.#events.state])try{listener(value);}catch{}}
 on(name,listener){if(this.#destroyed)fail('VIEWER_CLOSED');if(!Object.hasOwn(this.#events,name)||typeof listener!=='function')fail('VIEWER_INVALID_CONFIG');const group=this.#events[name];if(group.size>=64)fail('CHANNEL_BUSY');group.add(listener);if(name==='state')try{listener(this.#state);}catch{}return ()=>group.delete(listener);}
 #removeFrame(){
  const old=this.#frame;this.#frame=null;old?.close();
  if(this.#iframe){for(const [name,handler]of Object.entries(this.#frameListeners??{}))this.#iframe.removeEventListener(name,handler);this.#iframe.remove();this.#iframe=null;}
  this.#frameListeners=null;clearTimeout(this.#loadTimer);this.#loadTimer=null;
 }
 #armLoad(iframe){if(this.#loadTimer)return;this.#loadTimer=setTimeout(()=>{this.#loadTimer=null;if(!this.#destroyed&&iframe===this.#iframe)this.#failed(new ViewerChannelError('CHANNEL_TIMEOUT'));},this.#config.loadTimeoutMs);this.#loadTimer.unref?.();}
 #newIframe(){
  this.#generation++;this.#removeFrame();this.#frameDead=false;if(this.#ready.done)this.#ready=deferred();
  const iframe=this.#document.createElement('iframe');this.#iframe=iframe;
  iframe.title=this.#config.title;iframe.referrerPolicy='no-referrer';iframe.loading='eager';iframe.setAttribute('sandbox','allow-scripts allow-same-origin');Object.assign(iframe.style,{display:'block',width:'100%',height:'100%',border:'0'});
  this.#frameListeners={load:()=>this.#loaded(iframe),error:()=>{if(iframe===this.#iframe&&!this.#destroyed)this.#failed(new ViewerChannelError('CHANNEL_CLOSED'));}};
  for(const [name,handler]of Object.entries(this.#frameListeners))iframe.addEventListener(name,handler);
  iframe.src=this.#config.viewerOrigin+'/';this.#root.appendChild(iframe);this.#armLoad(iframe);
 }
 #loaded(iframe){
  if(this.#destroyed||iframe!==this.#iframe)return;const generation=++this.#generation,old=this.#frame;this.#frame=null;old?.close();this.#frameDead=false;if(this.#ready.done)this.#ready=deferred();this.#armLoad(iframe);
  if(!this.#failure)this.#publish(this.#paused?'paused':'loading');
  try{
   const settings=this.#tickets.settings;let frame;
   frame=new ViewerFrameConnection({frameWindow:iframe.contentWindow,frameOrigin:this.#config.viewerOrigin,gatewayOrigin:settings.gatewayOrigin,sessionId:settings.sessionId,role:settings.role,...(settings.version===undefined?{}:{version:settings.version}),requestTimeoutMs:settings.requestTimeoutMs,readyTimeoutMs:Math.min(30000,this.#config.loadTimeoutMs),connectTimeoutMs:Math.min(60000,this.#config.connectTimeoutMs),getTicket:request=>this.#tickets.getTicket(request),onState:value=>{
    if(generation!==this.#generation||this.#destroyed||this.#failure)return;
    if(value.state==='failed'){this.#failed(new ViewerChannelError(value.code));return;}
    if(value.state==='closed'&&value.code){this.#frameDead=true;return;}
    const mapped=value.state==='waiting'?(this.#desired?'connecting':this.#paused?'paused':'ready'):value.state==='closed'?'paused':value.state;
    this.#publish(mapped);
   },onError:error=>{if(generation===this.#generation&&!this.#destroyed)this.#failed(error);}});
   this.#frame=frame;
   void frame.ready.then(value=>{if(generation!==this.#generation||this.#destroyed)return;clearTimeout(this.#loadTimer);this.#loadTimer=null;this.#ready.resolve(value);if(!this.#desired&&!this.#failure)this.#publish(this.#paused?'paused':'ready');},error=>{if(generation===this.#generation&&!this.#destroyed)this.#failed(error);});
   if(this.#desired&&!this.#connecting)void this.connect().catch(()=>{});
  }catch(error){this.#failed(error);}
 }
 #failed(error){
  if(this.#destroyed||this.#failure)return;const failure=error instanceof ViewerChannelError?error:new ViewerChannelError(error?.code);this.#failure=failure;this.#desired=false;this.#operation?.abort();this.#ready.reject(failure);this.#generation++;this.#removeFrame();this.#frameDead=true;this.#publish('failed',failure.code);for(const listener of [...this.#events.error])try{listener(failure);}catch{}
 }
 connect({signal}={}){
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
 disconnect(){
  if(this.#destroyed)return this.#destroying??Promise.resolve();this.#desired=false;this.#paused=true;this.#failure=null;this.#operation?.abort();if(this.#disconnecting)return this.#disconnecting;const frame=this.#frame;
  const work=(async()=>{const complete=await settle(frame?.disconnect(),this.#config.disconnectTimeoutMs);if(this.#destroyed)return;if(!complete&&frame===this.#frame){this.#generation++;this.#removeFrame();this.#frameDead=true;}if(!this.#desired)this.#publish('paused');})();
  this.#disconnecting=work;void work.finally(()=>{if(this.#disconnecting===work)this.#disconnecting=null;}).catch(()=>{});return work;
 }
 destroy(){
  if(this.#destroying)return this.#destroying;const done=deferred();this.#destroying=done.promise;this.#destroyed=true;this.#desired=false;this.#operation?.abort();this.#tickets.destroy();this.#ready.reject(new ViewerChannelError('VIEWER_CLOSED'));clearTimeout(this.#loadTimer);this.#owner.removeEventListener('pagehide',this.#pagehide);this.#observer?.disconnect();this.#generation++;
  const frame=this.#frame;this.#frame=null;this.#publish('destroyed');
  void(async()=>{try{await settle(frame?.disconnect(),this.#config.destroyTimeoutMs);}finally{frame?.close();this.#removeFrame();this.#host.remove();this.#events.state.clear();this.#events.error.clear();done.resolve();}})();return this.#destroying;
 }
}

export function createViewer(container,config){return new Viewer(container,config);}
