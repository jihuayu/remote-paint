import {ViewerChannelError} from './viewer-channel.mjs';
const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const finite=(v,max=86400000)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max;
const own=(v,k)=>v&&typeof v==='object'?Object.getOwnPropertyDescriptor(v,k)?.value:undefined;
const exact=(v,keys)=>!!v&&typeof v==='object'&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===null||Object.getPrototypeOf(Object.getPrototypeOf(v))===null)&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const modes=['cpu-2d','cpu-bitmap','webgl2-bitmap'],coreKeys=['connectionGeneration','frameId','pageEpoch','viewportVersion','width','height','worker','presentation'];
const performanceKeys=['scope','stage','clock',...coreKeys,'framesSubmitted','submittedFramesPerSecond','lastFrameAgoMs','renderMs','receivedBytes','resourceBytes','resourceCount','wasmHeapBytes','gpuEstimateBytes','residentEstimateBytes','memoryScope'];
const firstKeys=['scope','stage','clock',...coreKeys,'startPhase','connectToReceiptMs'];
const byteKeys=['receivedBytes','resourceBytes','resourceCount','wasmHeapBytes','gpuEstimateBytes','residentEstimateBytes'];
const validCore=v=>['connectionGeneration','frameId','pageEpoch','viewportVersion'].every(k=>integer(v[k],1))&&integer(v.width,1,4096)&&integer(v.height,1,4096)&&typeof v.worker==='boolean'&&modes.includes(v.presentation);
const base={scope:'viewer',stage:'unavailable',clock:'viewer-ui-receipt',connectionGeneration:0,frameId:null,pageEpoch:null,viewportVersion:null,width:null,height:null,worker:null,presentation:null,framesSubmitted:0,submittedFramesPerSecond:null,lastFrameAgoMs:null,renderMs:null,receivedBytes:null,resourceBytes:null,resourceCount:null,wasmHeapBytes:null,gpuEstimateBytes:null,residentEstimateBytes:null,memoryScope:'client-estimate'};
const empty=Object.freeze(base),fail=()=>{throw new ViewerChannelError('CHANNEL_PROTOCOL');};
export const emptyViewerPerformance=()=>empty;
export function viewerPerformanceSnapshot(value){
 if(!exact(value,performanceKeys)||value.scope!=='viewer'||value.clock!=='viewer-ui-receipt'||value.memoryScope!=='client-estimate')fail();
 if(value.stage==='unavailable'){if(!performanceKeys.every(k=>value[k]===empty[k]))fail();return empty;}
 if(value.stage!=='scene-submitted'||!validCore(value)||!integer(value.framesSubmitted,1)||value.submittedFramesPerSecond!==null&&!finite(value.submittedFramesPerSecond,1000)||!finite(value.lastFrameAgoMs)||value.renderMs!==null&&!finite(value.renderMs)||!byteKeys.every(k=>value[k]===null||integer(value[k],0,2**40)))fail();
 return Object.freeze(Object.fromEntries(performanceKeys.map(k=>[k,value[k]])));
}
export function viewerFirstFrame(value){
 if(!exact(value,firstKeys)||value.scope!=='viewer'||value.stage!=='scene-submitted'||value.clock!=='viewer-ui-receipt'||!validCore(value)||!['renderer-init','connection-attempt'].includes(value.startPhase)||!finite(value.connectToReceiptMs))fail();return Object.freeze(Object.fromEntries(firstKeys.map(k=>[k,value[k]])));
}
const bytes=v=>integer(v,0,2**40)?v:null,ms=v=>finite(v)?v:null;
function measurements(value){
 const memory=own(value,'memory'),observed=own(memory,'observed'),domains=own(memory,'domains'),gpu=bytes(own(domains,'gpu')),cache=bytes(own(observed,'gpuCacheBytes'));
 return {renderMs:ms(own(value,'renderMs')),receivedBytes:bytes(own(value,'receivedBytes')),resourceBytes:bytes(own(value,'resourceBytes')),resourceCount:bytes(own(value,'resources')),wasmHeapBytes:bytes(own(observed,'wasmHeapBytes')),gpuEstimateBytes:gpu===null&&cache===null?null:Math.max(gpu??0,cache??0),residentEstimateBytes:bytes(own(memory,'residentEstimate'))};
}

// One private grant binding, one finite projection and one timer. Raw frames,
// renderer/memory objects, Source identities and editor content are never kept.
export class ViewerTelemetry {
 #notify;#now;#set;#clear;#timer=null;#binding=null;#latest=null;#first=null;#performance=empty;#closed=false;#highest=0;#started=null;#phase='connection-attempt';#count=0;#lastPublish=-Infinity;#windowAt=0;#windowCount=0;
 constructor({notify=()=>{},now=()=>performance.now(),setTimeout:setTimer=globalThis.setTimeout,clearTimeout:clearTimer=globalThis.clearTimeout}={}){if([notify,now,setTimer,clearTimer].some(v=>typeof v!=='function'))throw new TypeError('Invalid Viewer telemetry scheduler');this.#notify=notify;this.#now=now;this.#set=setTimer;this.#clear=clearTimer;}
 get performance(){return this.#performance;}
 get firstFrame(){return this.#first;}
 envelope(name){const snapshot=name==='performance'?this.#performance:name==='first-frame'?this.#first:null;return this.#binding&&snapshot&&snapshot.stage==='scene-submitted'?Object.freeze({grantId:this.#binding.grantId,snapshot}):null;}
 #stopTimer(){if(this.#timer)this.#clear(this.#timer.id);this.#timer=null;}
 reset(){this.#stopTimer();this.#binding=null;this.#latest=null;this.#first=null;this.#performance=empty;this.#started=null;this.#count=0;}
 begin(phase='connection-attempt'){if(this.#closed)return;this.reset();this.#started=this.#now();this.#phase=phase==='renderer-init'?'renderer-init':'connection-attempt';}
 connecting(){if(!this.#closed&&(this.#binding||this.#started===null))this.begin('connection-attempt');}
 bind(value){
  if(this.#closed||!exact(value,['connectionGeneration','grantId'])||!integer(value.connectionGeneration,1)||value.connectionGeneration<=this.#highest||typeof value.grantId!=='string'||!/^vgr_[a-f0-9-]{36}$/.test(value.grantId))return false;
  const now=this.#now(),started=this.#binding?now:this.#started??now,phase=this.#binding?'connection-attempt':this.#phase;this.reset();this.#started=started;this.#phase=phase;this.#binding=Object.freeze({connectionGeneration:value.connectionGeneration,grantId:value.grantId});this.#highest=value.connectionGeneration;this.#windowAt=now;this.#windowCount=0;return true;
 }
 #emit(name,snapshot,binding){if(this.#binding!==binding||this.#closed)return;try{this.#notify(name,Object.freeze({grantId:binding.grantId,snapshot}));}catch{}}
 record(value){
  const binding=this.#binding;if(this.#closed||!binding||own(value,'connectionGeneration')!==binding.connectionGeneration)return false;
  const frame=own(value,'frame'),viewport=own(frame,'viewport'),result=own(value,'result');
  const core={connectionGeneration:binding.connectionGeneration,frameId:own(frame,'frameId'),pageEpoch:own(frame,'pageEpoch'),viewportVersion:own(frame,'viewportVersion'),width:own(viewport,'cssWidth'),height:own(viewport,'cssHeight'),worker:own(value,'worker'),presentation:own(own(result,'presentation'),'mode')};if(!validCore(core))return false;
  const prior=this.#latest?.core;if(prior&&(core.pageEpoch<prior.pageEpoch||core.pageEpoch===prior.pageEpoch&&(core.viewportVersion<prior.viewportVersion||core.viewportVersion===prior.viewportVersion&&core.frameId<=prior.frameId)))return false;
  const now=this.#now();this.#latest={core:Object.freeze(core),metrics:measurements(result),receivedAt:now};this.#count++;
  if(!this.#first){this.#first=viewerFirstFrame({scope:'viewer',stage:'scene-submitted',clock:'viewer-ui-receipt',...core,startPhase:this.#phase,connectToReceiptMs:Math.min(86400000,Math.max(0,now-this.#started))});this.#emit('first-frame',this.#first,binding);}
  if(this.#binding===binding&&!this.#closed)this.#requestPublish();return true;
 }
 update(connectionGeneration,value){
  if(this.#closed||!this.#latest||!this.#binding||connectionGeneration!==this.#binding.connectionGeneration)return false;
  const projected=measurements(value),metrics=this.#latest.metrics;
  for(const [raw,key] of [['renderMs','renderMs'],['receivedBytes','receivedBytes'],['resourceBytes','resourceBytes'],['resources','resourceCount']])if(Object.hasOwn(value,raw))metrics[key]=projected[key];
  if(Object.hasOwn(value,'memory'))for(const key of ['wasmHeapBytes','gpuEstimateBytes','residentEstimateBytes'])metrics[key]=projected[key];return true;
 }
 #requestPublish(){if(this.#now()-this.#lastPublish>=250){this.#stopTimer();this.#publish();}else this.#schedule();}
 #schedule(){
  if(this.#timer||!this.#binding||!this.#latest||this.#closed)return;
  const record={binding:this.#binding,id:null};this.#timer=record;record.id=this.#set(()=>{if(this.#timer!==record)return;this.#timer=null;if(this.#binding===record.binding&&!this.#closed)this.#publish();},Math.max(0,250-(this.#now()-this.#lastPublish)));record.id?.unref?.();
 }
 #publish(){
  const binding=this.#binding,latest=this.#latest;if(!binding||!latest||this.#closed)return;const now=this.#now(),elapsed=now-this.#windowAt;
  const snapshot=viewerPerformanceSnapshot({scope:'viewer',stage:'scene-submitted',clock:'viewer-ui-receipt',...latest.core,framesSubmitted:this.#count,submittedFramesPerSecond:elapsed>0?Math.min(1000,Math.max(0,(this.#count-this.#windowCount)*1000/elapsed)):null,lastFrameAgoMs:Math.min(86400000,Math.max(0,now-latest.receivedAt)),...latest.metrics,memoryScope:'client-estimate'});
  this.#lastPublish=now;this.#windowAt=now;this.#windowCount=this.#count;this.#performance=snapshot;this.#emit('performance',snapshot,binding);if(this.#binding===binding&&!this.#closed)this.#schedule();
 }
 close(){this.reset();this.#closed=true;}
}
