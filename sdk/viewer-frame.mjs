import {ViewerTicketSource} from './viewer-connection.mjs';
import {emptyViewerControl,viewerControlState,viewerControlOptions} from './viewer-control.mjs';
import {ViewerPort,ViewerChannelError,viewerOrigin,viewerNonce,viewerHello,channelCode} from './viewer-channel.mjs';
export {ViewerChannelError} from './viewer-channel.mjs';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const fail=code=>{throw new ViewerChannelError(code);};
const states=new Set(['waiting','paused','connecting','connected','refreshing','reconnecting','failed','closed']);
function options(value){
 const names=['frameWindow','frameOrigin','gatewayOrigin','sessionId','role','version','getTicket','requestTimeoutMs','readyTimeoutMs','connectTimeoutMs','onState','onError','onControl'];
 if(!value||typeof value!=='object'||Reflect.ownKeys(value).some(k=>!names.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))fail('VIEWER_INVALID_CONFIG');
 return Object.fromEntries(Reflect.ownKeys(value).map(k=>[k,value[k]]));
}
function wait(promise,signal){
 if(!signal)return promise;if(signal.aborted)return Promise.reject(new ViewerChannelError('CHANNEL_ABORTED'));
 return new Promise((resolve,reject)=>{const abort=()=>reject(new ViewerChannelError('CHANNEL_ABORTED'));signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function combined(first,second){
 const controller=new AbortController(),abort=()=>controller.abort();for(const signal of [first,second]){signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();}
 return {signal:controller.signal,dispose(){for(const signal of [first,second])signal?.removeEventListener('abort',abort);}};
}
function state(value,settings){
 if(!value||typeof value!=='object'||Array.isArray(value)||!states.has(value.state)||Object.keys(value).some(k=>!['state','sessionId','role','attempt','version','code'].includes(k))||value.sessionId!==undefined&&value.sessionId!==settings.sessionId||value.role!==undefined&&value.role!==settings.role||value.attempt!==undefined&&!integer(value.attempt,0,100)||value.version!==undefined&&value.version!==null&&(typeof value.version!=='string'||!value.version.length||value.version.length>256)||settings.version!==undefined&&value.version!==undefined&&value.version!==null&&value.version!==settings.version||value.code!==undefined&&channelCode(value.code)!==value.code||value.state==='connected'&&(value.sessionId!==settings.sessionId||value.role!==settings.role||typeof value.version!=='string'))fail('CHANNEL_PROTOCOL');return Object.freeze({...value});
}

// Host-side connection to an existing trusted iframe Window. The DOM component
// owns iframe creation/removal; this class owns only this authenticated port.
export class ViewerFrameConnection {
 #control=emptyViewerControl();#onControl;#terminalControlCode=null;
 #tickets;#settings;#port;#readyResolve;#readyReject;#readyTimer;#readyDone=false;#closed=false;#ownClose=false;#closedError=null;#active=false;#issued=false;#abort=null;#connectPromise=null;#connectWaiter=null;#onState;#onError;#timeout;#state=Object.freeze({state:'waiting'});
 constructor(value){
  const config=options(value),frameOrigin=viewerOrigin(config.frameOrigin);
  if(!config.frameWindow||typeof config.frameWindow.postMessage!=='function'||config.onState!==undefined&&typeof config.onState!=='function'||config.onError!==undefined&&typeof config.onError!=='function'||!integer(config.readyTimeoutMs??10000,50,30000)||!integer(config.connectTimeoutMs??30000,50,60000))fail('VIEWER_INVALID_CONFIG');
  this.#tickets=new ViewerTicketSource({gatewayOrigin:config.gatewayOrigin,audience:frameOrigin,sessionId:config.sessionId,role:config.role,getTicket:config.getTicket,...(config.version===undefined?{}:{version:config.version}),...(config.requestTimeoutMs===undefined?{}:{requestTimeoutMs:config.requestTimeoutMs})});
  if(config.onControl!==undefined&&typeof config.onControl!=='function')fail('VIEWER_INVALID_CONFIG');
  this.#settings=this.#tickets.settings;this.#onState=config.onState;this.#onError=config.onError;this.#onControl=config.onControl;this.#timeout=config.connectTimeoutMs??30000;
  this.ready=new Promise((resolve,reject)=>{this.#readyResolve=resolve;this.#readyReject=reject;});void this.ready.catch(()=>{});
  const channel=viewerNonce(),pair=new MessageChannel();
  this.#port=new ViewerPort({port:pair.port1,channel,handle:async(method,data,{signal})=>{
   if(method!=='ticket'||!this.#readyDone||!this.#active||!this.#abort||this.#abort.signal.aborted)fail('CHANNEL_ABORTED');
   if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==2||!Object.hasOwn(data,'reason')||!Object.hasOwn(data,'previousGrantId')||!['connect','reconnect','refresh'].includes(data.reason)||data.previousGrantId!==null&&(typeof data.previousGrantId!=='string'||!/^vgr_[a-f0-9-]{36}$/.test(data.previousGrantId)))fail('CHANNEL_PROTOCOL');
   // The host source owns previousGrantId/version history. A child cannot
   // select another grant; a response lost after cancellation can be refreshed.
   const joined=combined(signal,this.#abort.signal);try{const ticket=await this.#tickets.getTicket({signal:joined.signal,reason:data.reason});if(joined.signal.aborted||!this.#active)fail('CHANNEL_ABORTED');this.#issued=true;return ticket;}finally{joined.dispose();}
  },notify:(name,data)=>this.#notification(name,data),onClose:error=>this.#ended(error)});
  this.#readyTimer=setTimeout(()=>this.#port.close('CHANNEL_TIMEOUT'),config.readyTimeoutMs??10000);this.#readyTimer.unref?.();
  try{config.frameWindow.postMessage(viewerHello(channel),frameOrigin,[pair.port2]);}catch{pair.port2.close();this.#port.close('CHANNEL_CLOSED');}
 }
 get state(){return this.#state;}
 get control(){return this.#control;}
 #publishControl(value){if(JSON.stringify(value)===JSON.stringify(this.#control))return;this.#control=value;try{this.#onControl?.(value);}catch{}}
 #publish(value){this.#state=value;try{this.#onState?.(value);}catch{}}
 #notification(name,data){
  if(name==='ready'){
   if(this.#readyDone||!data||typeof data!=='object'||Object.keys(data).length!==2||data.gatewayOrigin!==this.#settings.gatewayOrigin||typeof data.viewerBuild!=='string'||!/^[a-f0-9]{64}$/.test(data.viewerBuild))fail('VIEWER_INVALID_CONFIG');
   this.#readyDone=true;clearTimeout(this.#readyTimer);this.#readyResolve(Object.freeze({...data}));return;
  }
  if(name==='control'){
   if(!this.#readyDone)fail('CHANNEL_PROTOCOL');const value=viewerControlState(data);
   if(this.#settings.role!=='controller'&&value.mode!=='unavailable')fail('CHANNEL_PROTOCOL');
   if(value.mode!=='unavailable'&&(!this.#active||!this.#issued||this.#state.state!=='connected'))return;
   this.#publishControl(value);return;
  }
  if(name!=='state'||!this.#readyDone)fail('CHANNEL_PROTOCOL');const value=state(data,this.#tickets.settings);if(value.state==='connected'&&(!this.#active||!this.#issued))return;if(value.state==='failed')this.#terminalControlCode=value.code;else if(value.state==='connected')this.#terminalControlCode=null;this.#publish(value);
  if(value.state==='connected')this.#connectWaiter?.resolve(value);
  if(value.state==='failed'){
   this.#active=false;const error=new ViewerChannelError(value.code??'CHANNEL_HANDLER_FAILED');if(this.#connectWaiter)this.#connectWaiter.reject(error);else this.#abort?.abort();try{this.#onError?.(error);}catch{}
  }
 }
 #ended(error){
  if(this.#closed)return;this.#closed=true;this.#closedError=error;clearTimeout(this.#readyTimer);this.#active=false;this.#abort?.abort();this.#tickets.destroy();
  this.#publishControl(emptyViewerControl());if(!this.#readyDone)this.#readyReject(error);this.#connectWaiter?.reject(error);this.#publish(Object.freeze({state:'closed',code:error.code}));if(!this.#ownClose)try{this.#onError?.(error);}catch{}
 }
 connect({signal}={}){
  if(signal!==undefined&&!(signal instanceof AbortSignal))return Promise.reject(new ViewerChannelError('VIEWER_INVALID_CONFIG'));
  if(this.#closed)return Promise.reject(new ViewerChannelError('CHANNEL_CLOSED'));if(this.#connectPromise)return wait(this.#connectPromise,signal);
  if(this.#active&&this.#state.state==='connected')return wait(Promise.resolve(this.#state),signal);
  const controller=this.#abort=new AbortController();this.#active=true;this.#issued=false;const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const work=(async()=>{
   let timer;
   try{
    await wait(this.ready,controller.signal);if(this.#closed||controller.signal.aborted)fail('CHANNEL_ABORTED');
    const connected=new Promise((resolve,reject)=>{this.#connectWaiter={resolve,reject};timer=setTimeout(()=>reject(new ViewerChannelError('CHANNEL_TIMEOUT')),this.#timeout);timer.unref?.();});void connected.catch(()=>{});
    await this.#port.request('connect',{...this.#settings},{signal:controller.signal});
    return await wait(connected,controller.signal);
   }catch(error){
    this.#active=false;controller.abort();if(!this.#port.closed&&this.#state.state!=='failed')void this.#port.request('disconnect',null).catch(()=>{});throw this.#closedError??(error instanceof ViewerChannelError?error:new ViewerChannelError('CHANNEL_HANDLER_FAILED'));
   }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.#connectWaiter=null;}
  })();
  this.#connectPromise=work;void work.finally(()=>{if(this.#connectPromise===work)this.#connectPromise=null;}).catch(()=>{});return work;
 }
 async disconnect(){
  this.#active=false;this.#abort?.abort();this.#publishControl(emptyViewerControl());if(this.#closed)return;
  await this.#port.request('disconnect',null);this.#publish(Object.freeze({...this.#state,state:'paused'}));
 }
 async getState(){if(this.#closed)fail('CHANNEL_CLOSED');const value=state(await this.#port.request('state',null),this.#tickets.settings);this.#publish(value);return value;}
 async #controlRequest(method,options){
  if(this.#closed)fail('CHANNEL_CLOSED');if(this.#settings.role!=='controller'||!this.#active||this.#state.state!=='connected')fail('VIEWER_CONTROL_UNAVAILABLE');
  const {signal,timeoutMs}=viewerControlOptions(options);if(signal?.aborted)fail('CHANNEL_ABORTED');
  try{
   const value=viewerControlState(await this.#port.request(method,{timeoutMs},{signal,timeoutMs:timeoutMs+1000}));
   if(!this.#active||this.#closed)fail('CHANNEL_ABORTED');if(method==='take-control'&&!value.held||method==='release-control'&&(value.mode!=='agent'||value.held))fail('CHANNEL_PROTOCOL');this.#publishControl(value);return value;
  }catch(error){if(['CHANNEL_PROTOCOL','CHANNEL_TIMEOUT','CHANNEL_ABORTED'].includes(error.code))this.#port.close(error.code);if(this.#terminalControlCode)throw new ViewerChannelError(this.#terminalControlCode);throw error;}
 }
 takeControl(options){return this.#controlRequest('take-control',options);}
 releaseControl(options){return this.#controlRequest('release-control',options);}
 close(){if(this.#closed)return;this.#ownClose=true;this.#port.close('CHANNEL_CLOSED');}
}
