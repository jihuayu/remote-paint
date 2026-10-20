import {ViewerChannelError} from './viewer-channel.mjs';
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const fail=code=>{throw new ViewerChannelError(code);};
const empty=Object.freeze({mode:'unavailable',holder:'none',held:false,lease:null,fencingToken:null,expiresAt:null,pageEpoch:null,viewportVersion:null});
const dataRecord=(value,names)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===null||Object.getPrototypeOf(Object.getPrototypeOf(value))===null)&&Reflect.ownKeys(value).length===names.length&&names.every(k=>Object.hasOwn(value,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value'));
const viewportInputCodes=new Set(['INVALID_VIEWPORT_REQUEST','UNSUPPORTED_VIEWPORT','VIEWPORT_BUSY','STALE_VIEWPORT_REQUEST','STALE_SESSION','PAGE_TRANSITION','STALE_EPOCH','STALE_VIEWPORT','STALE_LEASE','INPUT_QUEUE_FULL','SESSION_CLOSED','VIEWPORT_INPUT_RESET_FAILED','VIEWPORT_RESIZE_FAILED','VIEWPORT_SUPERSEDED','VIEWPORT_CONTROL_UNAVAILABLE','VIEWPORT_PROTOCOL','VIEWPORT_CONNECTION_LOST']);
export class ViewerViewportError extends ViewerChannelError {
 constructor(code,outcome='unknown'){super(code);this.name='ViewerViewportError';this.outcome=outcome==='not-applied'?'not-applied':'unknown';}
}
export function viewerViewportSize(value){
 if(!dataRecord(value,['width','height'])||![value.width,value.height].every(v=>integer(v,1)&&v<=4096))fail('VIEWER_INVALID_CONFIG');return Object.freeze({width:value.width,height:value.height});
}
export function viewerViewportResult(value){
 const names=['scope','changed','width','height','pageEpoch','viewportVersion'];if(!dataRecord(value,names)||value.scope!=='viewport'||typeof value.changed!=='boolean'||![value.width,value.height].every(v=>integer(v,1)&&v<=4096)||!integer(value.pageEpoch,1)||!integer(value.viewportVersion,1))fail('CHANNEL_PROTOCOL');return Object.freeze(Object.fromEntries(names.map(k=>[k,value[k]])));
}
export const emptyViewerControl=()=>empty;
export function viewerControlOptions(value={}){
 const names=['signal','timeoutMs'];if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==null&&Object.getPrototypeOf(Object.getPrototypeOf(value))!==null||names.some(k=>!Object.hasOwn(value,k)&&Object.getPrototypeOf(value)!==null&&Object.hasOwn(Object.getPrototypeOf(value),k))||Reflect.ownKeys(value).some(k=>!names.includes(k)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,k),'value')))fail('VIEWER_INVALID_CONFIG');
 const signal=value.signal,timeoutMs=value.timeoutMs??5000;if(signal!==undefined&&!(signal instanceof AbortSignal)||!integer(timeoutMs,50)||timeoutMs>10000)fail('VIEWER_INVALID_CONFIG');return {signal,timeoutMs};
}
export function viewerControlState(value){
 const names=['mode','holder','held','lease','fencingToken','expiresAt','pageEpoch','viewportVersion'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||!names.every(k=>Object.hasOwn(value,k))||!['unavailable','agent','handoff','human'].includes(value.mode)||!['none','self','other'].includes(value.holder)||typeof value.held!=='boolean'||value.expiresAt!==null&&!integer(value.expiresAt,1)||value.pageEpoch!==null&&!integer(value.pageEpoch,1)||value.viewportVersion!==null&&!integer(value.viewportVersion,1))fail('CHANNEL_PROTOCOL');
 if(value.held){if(value.mode!=='human'||value.holder!=='self'||typeof value.lease!=='string'||!/^[a-f0-9]{48}$/.test(value.lease)||!integer(value.fencingToken,1)||value.expiresAt===null||value.pageEpoch===null||value.viewportVersion===null)fail('CHANNEL_PROTOCOL');}
 else if(value.lease!==null||value.fencingToken!==null)fail('CHANNEL_PROTOCOL');
 if(value.mode==='unavailable'&&!names.every(k=>value[k]===emptyViewerControl()[k])||value.mode==='agent'&&(value.holder!=='none'||value.expiresAt!==null)||value.mode!=='unavailable'&&(value.pageEpoch===null||value.viewportVersion===null))fail('CHANNEL_PROTOCOL');
 return Object.freeze(Object.fromEntries(names.map(k=>[k,value[k]])));
}

// Child-side operations share the existing ViewerInput/Source lease pipeline.
// A dispatched action interrupted by cancellation/deadline ends the connection:
// its old peer cannot later become a human holder in an abandoned iframe.
export class ViewerControlActions {
 #input;#available;#notify;#interrupt;#pending=null;#state=emptyViewerControl();#closed=false;
 constructor({input,available,notify,interrupt}){this.#input=input;this.#available=available;this.#notify=notify;this.#interrupt=interrupt;}
 get state(){return this.#state;}
 #read(){
  const input=this.#input,frame=input.frame;if(this.#closed||!this.#available()||!input.enabled||!frame||!['agent','handoff','human'].includes(input.mode))return emptyViewerControl();
  const pageEpoch=input.controlPageEpoch??frame.pageEpoch,viewportVersion=input.controlViewportVersion??frame.viewportVersion;
  const held=input.active===true&&input.mode==='human'&&input.controlHolder===input.peerId&&typeof input.lease==='string'&&/^[a-f0-9]{48}$/.test(input.lease)&&integer(input.feedbackEpoch,1)&&integer(input.controlExpiresAt,1)&&pageEpoch===frame.pageEpoch&&viewportVersion===frame.viewportVersion;
  return viewerControlState({mode:input.mode,holder:input.controlHolder===null||input.controlHolder===undefined?'none':input.controlHolder===input.peerId?'self':'other',held,lease:held?input.lease:null,fencingToken:held?input.feedbackEpoch:null,expiresAt:integer(input.controlExpiresAt,1)?input.controlExpiresAt:null,pageEpoch,viewportVersion});
 }
 #publish(value){if(JSON.stringify(value)===JSON.stringify(this.#state))return;this.#state=value;try{this.#notify(value);}catch{}}
 update(reason){
  const value=this.#read();this.#publish(value);const pending=this.#pending;if(!pending)return;
  if(pending.action==='viewport'){
   // Source can publish handoff/new epochs before its resize barrier has
   // returned. Only the correlated reply determines that operation's result.
   if(reason==='viewport-protocol'){pending.finish(new ViewerViewportError('CHANNEL_PROTOCOL','unknown'));this.#interrupt('CHANNEL_PROTOCOL');}
   else if(value.mode==='unavailable')pending.finish(new ViewerViewportError('VIEWER_CONTROL_UNAVAILABLE','unknown'));
   else if(reason==='denied'){pending.finish(new ViewerViewportError('VIEWER_CONTROL_DENIED','unknown'));this.#interrupt('VIEWER_CONTROL_DENIED');}
   return;
  }
  if(value.mode==='unavailable'){pending.finish(new ViewerChannelError('VIEWER_CONTROL_UNAVAILABLE'));return;}
  if(value.pageEpoch!==pending.pageEpoch||value.viewportVersion!==pending.viewportVersion){pending.finish(new ViewerChannelError('VIEWER_CONTROL_STALE'));this.#interrupt('VIEWER_CONTROL_STALE');return;}
  if(reason==='denied'){const code=this.#input.controlDenied==='CONTROL_BUSY'?'VIEWER_CONTROL_BUSY':'VIEWER_CONTROL_DENIED';pending.finish(new ViewerChannelError(code));if(pending.action==='release')this.#interrupt(code);return;}
  if(pending.action==='take'&&value.held||pending.action==='release'&&value.mode==='agent')pending.finish(null,value);
 }
 reset(){const pending=this.#pending;pending?.finish(pending.action==='viewport'?new ViewerViewportError('CHANNEL_ABORTED','unknown'):new ViewerChannelError('CHANNEL_ABORTED'));this.#publish(emptyViewerControl());}
 close(){this.#closed=true;this.reset();}
 #run(action,options){
  let signal,timeoutMs;try{({signal,timeoutMs}=viewerControlOptions(options));}catch(error){return Promise.reject(error);}
  if(signal?.aborted)return Promise.reject(new ViewerChannelError('CHANNEL_ABORTED'));if(this.#pending)return Promise.reject(new ViewerChannelError('VIEWER_CONTROL_BUSY'));
  const value=this.#read(),input=this.#input;
  if(value.mode==='unavailable')return Promise.reject(new ViewerChannelError('VIEWER_CONTROL_UNAVAILABLE'));
  if(value.pageEpoch!==input.frame.pageEpoch||value.viewportVersion!==input.frame.viewportVersion)return Promise.reject(new ViewerChannelError('VIEWER_CONTROL_STALE'));
  if(action==='take'&&value.held||action==='release'&&value.mode==='agent')return Promise.resolve(value);
  if(action==='take'&&value.mode!=='agent'||action==='release'&&!value.held)return Promise.reject(new ViewerChannelError('VIEWER_CONTROL_BUSY'));
  return new Promise((resolve,reject)=>{
   const finish=(error,state)=>{if(this.#pending!==record)return;this.#pending=null;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(state);};
   const interrupt=code=>{finish(new ViewerChannelError(code));this.#interrupt(code);},abort=()=>interrupt('CHANNEL_ABORTED'),timer=setTimeout(()=>interrupt('CHANNEL_TIMEOUT'),timeoutMs);timer.unref?.();
   const record={action,pageEpoch:value.pageEpoch,viewportVersion:value.viewportVersion,finish};this.#pending=record;signal?.addEventListener('abort',abort,{once:true});
   try{if(action==='take')input.requestControl();else input.releaseControl();}catch{finish(new ViewerChannelError('VIEWER_CONTROL_UNAVAILABLE'));this.#interrupt('VIEWER_CONTROL_UNAVAILABLE');}
  });
 }
 take(options){return this.#run('take',options);}
 release(options){return this.#run('release',options);}
 resizeViewport(size,options){
  let signal,timeoutMs;try{size=viewerViewportSize(size);({signal,timeoutMs}=viewerControlOptions(options));}catch{ return Promise.reject(new ViewerViewportError('VIEWER_INVALID_CONFIG','not-applied')); }
  const reject=code=>Promise.reject(new ViewerViewportError(code,'not-applied'));
  if(signal?.aborted)return reject('CHANNEL_ABORTED');if(this.#pending)return reject('VIEWER_CONTROL_BUSY');
  const value=this.#read(),input=this.#input;if(value.mode==='unavailable')return reject('VIEWER_CONTROL_UNAVAILABLE');if(!input.viewportEnabled)return reject('VIEWER_VIEWPORT_UNSUPPORTED');
  if(value.pageEpoch!==input.frame.pageEpoch||value.viewportVersion!==input.frame.viewportVersion)return reject('VIEWER_CONTROL_STALE');if(!value.held)return reject('VIEWER_CONTROL_BUSY');
  return new Promise((resolve,reject)=>{
   const finish=(error,result)=>{if(this.#pending!==record)return;this.#pending=null;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve(result);};
   const interrupt=code=>{if(this.#pending!==record)return;finish(new ViewerViewportError(code,'unknown'));this.#interrupt(code);};
   const abort=()=>interrupt('CHANNEL_ABORTED'),timer=setTimeout(()=>interrupt('CHANNEL_TIMEOUT'),timeoutMs);timer.unref?.();
   const record={action:'viewport',pageEpoch:value.pageEpoch,viewportVersion:value.viewportVersion,finish};this.#pending=record;signal?.addEventListener('abort',abort,{once:true});
   const failed=error=>{
    if(this.#pending!==record)return;
    const sourceCode=Object.getOwnPropertyDescriptor(error??{},'code')?.value,outcome=viewportInputCodes.has(sourceCode)&&Object.getOwnPropertyDescriptor(error??{},'outcome')?.value==='not-applied'?'not-applied':'unknown';
    const code=sourceCode==='UNSUPPORTED_VIEWPORT'?'VIEWER_VIEWPORT_UNSUPPORTED':sourceCode==='INVALID_VIEWPORT_REQUEST'?'VIEWER_INVALID_CONFIG':['VIEWPORT_BUSY','INPUT_QUEUE_FULL'].includes(sourceCode)?'VIEWER_CONTROL_BUSY':['STALE_VIEWPORT_REQUEST','STALE_SESSION','PAGE_TRANSITION','STALE_EPOCH','STALE_VIEWPORT','STALE_LEASE'].includes(sourceCode)?'VIEWER_CONTROL_STALE':['SESSION_CLOSED','VIEWPORT_CONNECTION_LOST','VIEWPORT_CONTROL_UNAVAILABLE'].includes(sourceCode)?'VIEWER_CONTROL_UNAVAILABLE':sourceCode==='VIEWPORT_PROTOCOL'||sourceCode==='CHANNEL_PROTOCOL'?'CHANNEL_PROTOCOL':outcome==='unknown'?'VIEWER_VIEWPORT_FAILED':'VIEWER_VIEWPORT_DENIED';
    finish(new ViewerViewportError(code,outcome));if(outcome==='unknown')this.#interrupt(code);
   };
   try{Promise.resolve(input.resizeViewport(size)).then(reply=>{
    if(this.#pending!==record)return;
    try{
     if(!dataRecord(reply,['type','requestId','changed','pageEpoch','viewportVersion','viewport'])||reply.type!=='ViewportResized'||!integer(reply.requestId,1)||typeof reply.changed!=='boolean'||!dataRecord(reply.viewport,['cssWidth','cssHeight','deviceScaleFactor'])||reply.viewport.cssWidth!==size.width||reply.viewport.cssHeight!==size.height||reply.viewport.deviceScaleFactor!==1||reply.changed&&(reply.pageEpoch<record.pageEpoch||reply.viewportVersion<=record.viewportVersion)||!reply.changed&&(reply.pageEpoch!==record.pageEpoch||reply.viewportVersion!==record.viewportVersion))fail('CHANNEL_PROTOCOL');
     const result=viewerViewportResult({scope:'viewport',changed:reply.changed,width:size.width,height:size.height,pageEpoch:reply.pageEpoch,viewportVersion:reply.viewportVersion});finish(null,result);
    }catch(error){failed(error);}
   },failed);}catch(error){failed(error);}
  });
 }
}
