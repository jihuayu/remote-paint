import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

const transient=error=>/Cannot find context|Execution context was destroyed|Inspected target navigated|Cannot find default execution context/.test(error.message);
const inactive=error=>error.message==='Native subscription inactive';
const failed=(message,code='NATIVE_SUBSCRIPTION_FAILED')=>Object.assign(new Error(message),{code});
const suspensionBit=reason=>{if(reason==='manual')return 1;if(reason==='resize')return 2;if(reason==='reset')return 4;throw new RangeError('Invalid native suspension reason');};
const viewportOf=({width,height})=>{
 if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw new RangeError('Invalid native viewport');
 return {width,height};
};

// This adapter carries lifecycle controls and fixed scalar receipts only.
// Chromium/Broker own capture scheduling, resource data, mapping and publication.
export class NativeSubscription extends EventEmitter {
 constructor(page,{token,broker,frameDriver,viewport,interval=1000/60,inputSeq=()=>0,captureOnInput=true}={}){
  super();
  if(!broker||typeof token!=='string'||token.length<32||typeof inputSeq!=='function')throw new TypeError('Invalid native subscription configuration');
  if(!Number.isFinite(interval)||interval<0||interval>1000)throw new RangeError('Invalid native capture interval');
  Object.assign(this,{page,token,broker,frameDriver,interval,inputSeq,captureOnInput,viewport:viewportOf(viewport),pageEpoch:1,viewportVersion:1,
   viewers:0,stopped:false,suspended:false,transitioning:true,forceResources:true,generation:0,registrationRetries:0,lastStarted:0,
   nextOrdinalBase:0,world:null,binding:null,documentToken:null,enabled:false});
  this.revision=0;this.needsDocument=true;this.dirty=false;this.requestVersion=0;this.sentRequestVersion=0;
  this.suspensions=0;
  this.onNavigation=({frame})=>{if(!frame.parentId)this.refresh();};
  this.onContextDestroyed=({executionContextId})=>{if(this.world===executionContextId)this.refresh();};
  this.onContextsCleared=()=>this.refresh();
  this.onBrokerEvent=event=>this.accept(event);
 }
 async initialize(){
  this.cdp=await this.page.context().newCDPSession(this.page);
  this.cdp.on('Page.frameNavigated',this.onNavigation);
  this.cdp.on('Runtime.executionContextDestroyed',this.onContextDestroyed);
  this.cdp.on('Runtime.executionContextsCleared',this.onContextsCleared);
  this.broker.on('event',this.onBrokerEvent);
  await this.send('Page.enable');await this.send('Runtime.enable');
  await this.schedule();return this;
 }
 get running(){return !!this.work;}
 get captureOrdinal(){return this.lastStarted;}
 setTransitioning(value){if(this.transitioning===value)return;this.transitioning=value;this.emit('transition',value);}
 refresh(){
  if(this.stopped)return;
  this.revision++;this.generation++;this.world=null;this.needsDocument=true;this.setTransitioning(true);this.schedule();
 }
 setDemand(count){
  if(!Number.isSafeInteger(count)||count<0||count>1024)throw new RangeError('Invalid native capture demand');
  if(this.stopped||count===this.viewers)return;
  if(count>this.viewers){this.requestVersion++;if(!this.viewers)this.prime=true;}
  this.viewers=count;this.schedule();
 }
 requestCapture(){
  if(this.stopped||!this.viewers)return;
  // Disabling urgent capture must not leave ordinary future frames tagged
  // with a watermark from before an acknowledged input injection.
  if(this.captureOnInput)this.requestVersion++;
  this.schedule();
 }
 requestFreshFrame(){
  if(this.stopped||!this.viewers)return;
  this.requestVersion++;this.schedule();
 }
 schedule(){
  if(this.failure){
   if(!this.failedWork){this.failedWork=Promise.reject(this.failure);this.failedWork.catch(()=>{});}
   return this.failedWork;
  }
  this.dirty=true;
  if(!this.work){
   this.work=Promise.resolve().then(()=>this.pump()).catch(error=>{
    this.dirty=false;if(error.code==='NATIVE_CONTROL_TIMEOUT')this.failure=error;
    if(!this.stopped)this.emit('captureError',error);throw error;
   }).finally(()=>{this.work=null;if(this.dirty&&!this.stopped)this.schedule();});
   // Events coalesce into this one operation, rather than a promise per frame
   // or queued input. Callers that need a barrier await the same work promise.
   this.work.catch(()=>{});
  }
  return this.work;
 }
 async command(operation,id,...args){return this.commandIn(this.world,operation,id,...args);}
 async send(method,params){
  // A timed-out CDP command cannot be canceled independently. Do not issue
  // another command behind it; closing the owner detaches the one session.
  if(this.failure)throw this.failure;
  let timer;
  try{
   return await Promise.race([
    this.cdp.send(method,params),
    new Promise((_,reject)=>{timer=setTimeout(()=>reject(failed('Native control deadline exceeded','NATIVE_CONTROL_TIMEOUT')),6000);}),
   ]);
  }catch(error){if(error.code==='NATIVE_CONTROL_TIMEOUT')this.failure=error;error.message=error.message.replaceAll(this.token,'[redacted]');throw error;}
  finally{clearTimeout(timer);}
 }
 async commandIn(world,operation,id,...args){
  if(!world)throw failed('Native isolated world is unavailable','NATIVE_WORLD_CHANGED');
  const response=await this.send('Runtime.evaluate',{contextId:world,expression:`chrome.gpuBenchmarking.remotePaintSubscription(${[this.token,operation,id,...args].map(JSON.stringify).join(',')})`,returnByValue:true});
  if(response.exceptionDetails)throw failed((response.exceptionDetails.exception?.description??response.exceptionDetails.text).replaceAll(this.token,'[redacted]'));
  return response.result.value;
 }
 async ensureWorld(){
  if(this.world)return;
  const revision=this.revision,{frameTree}=await this.send('Page.getFrameTree');
  const {executionContextId}=await this.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-broker'});
  if(revision!==this.revision)return;
  this.world=executionContextId;
 }
 currentInput(){
  const value=this.inputSeq();
  if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Invalid native input watermark');
  return value;
 }
 async drainBinding(binding){
  const deadline=performance.now()+6000;
  for(;;){
   let state;
   try{state=await this.commandIn(binding.world,'inspect',binding.config.id);}
   catch(error){if(transient(error))return;throw error;}
   if(!state.ok||!state.inflight)return;
   this.lastStarted=Math.max(this.lastStarted,state.lastStarted);
   if(performance.now()>=deadline)throw failed('Native credit drain deadline exceeded','NATIVE_DRAIN_TIMEOUT');
   // Credit is delivered before the compact Broker event; only inspecting
   // Chromium proves its input/resource owners have actually been released.
   this.frameDriver?.start();await delay(5);
  }
 }
 async disable(){
  const binding=this.binding;if(!binding||!this.enabled&&!this.mustDrain)return;
  this.enabled=false;
  if(binding.registered){
   try{await this.broker.request('nativePolicy',{scopeId:binding.config.id,inputSeq:this.currentInput(),enabled:false});}
   catch(error){if(!inactive(error))throw error;binding.registered=false;}
  }
  try{await this.commandIn(binding.world,'enable',binding.config.id,false);}catch(error){if(!transient(error))throw error;}
  await this.drainBinding(binding);this.mustDrain=false;this.forceResources=true;
 }
 async retire(){
  const binding=this.binding;if(!binding)return;
  this.binding=null;this.enabled=false;
  if(binding.registered)await this.broker.request('cancelNative',{scopeId:binding.config.id});
  try{await this.commandIn(binding.world,'cancel',binding.config.id);}catch(error){if(!transient(error))throw error;}
  await this.drainBinding(binding);this.mustDrain=false;
 }
 async bindDocument(){
  await this.retire();const deadline=performance.now()+6000;
  while(!this.stopped&&!this.suspended){
   if(performance.now()>=deadline)throw failed('Native document readiness deadline exceeded','NATIVE_NOT_READY');
   const revision=this.revision,id=randomBytes(16).toString('hex');
   try{
    await this.ensureWorld();if(!this.world||revision!==this.revision)continue;
    const description=await this.command('describe',id);
    if(description?.subscriptionVersion!==2||description.cadenceVersion!==1)throw failed('Native document/cadence subscription API is required','NATIVE_API_REQUIRED');
    if(revision!==this.revision)continue;
    if(this.documentToken!==description.documentToken){
     if(this.documentToken!==null)this.pageEpoch++;
     this.documentToken=description.documentToken;
     this.emit('document',{documentToken:this.documentToken,pageEpoch:this.pageEpoch});
    }
    const config=await this.command('bindDocument',id,this.documentToken,this.pageEpoch,this.viewportVersion,this.currentInput(),this.viewport.width,this.viewport.height,this.nextOrdinalBase);
    if(!config.ok){
     if(!['NATIVE_NOT_READY','NATIVE_DOCUMENT_CHANGED'].includes(config.code)&&![3,4].includes(config.bindStatus))throw failed('Native document binding refused',config.code);
     if(config.code==='NATIVE_DOCUMENT_CHANGED'){this.world=null;this.revision++;}
     this.registrationRetries++;
    }else{
     // Reserve the whole range even if navigation or registration fails while
     // awaiting the Broker. Already encoding work may have used its tail.
     this.nextOrdinalBase=config.ordinalLimit+1;this.lastStarted=Math.max(this.lastStarted,config.lastStarted);
     const binding=this.binding={config,world:this.world,revision,registered:false};
     if(revision!==this.revision){await this.retire();continue;}
     const cadence=await this.commandIn(binding.world,'cadence',id,this.interval,1000);
     if(!cadence.ok){await this.retire();continue;}
     await this.broker.request('registerNative',{config});binding.registered=true;
     if(revision!==this.revision){await this.retire();continue;}
     this.needsDocument=false;this.forceResources=true;return;
    }
   }catch(error){
    if(!transient(error))throw error;
    await this.retire();
    this.world=null;this.revision++;
   }
   if(performance.now()>=deadline)throw failed('Native document readiness deadline exceeded','NATIVE_NOT_READY');
   await this.frameDriver?.requestNow();await delay(10);
  }
 }
 async updateEnabled(binding){
   const revision=this.revision,input=this.currentInput(),request=this.requestVersion,full=this.forceResources;
   const fresh=request!==this.sentRequestVersion;
   if(!this.enabled||binding.config.inputSeq!==input||full||fresh){
    // This changes only the allowed watermark, never the immutable Broker
    // SourceFrame floor of an older job already being encoded or mapped.
    try{await this.broker.request('nativePolicy',{scopeId:binding.config.id,inputSeq:input,enabled:true});}
    catch(error){
     if(!inactive(error))throw error;
     binding.registered=false;this.needsDocument=true;this.dirty=true;return;
    }
    if(revision!==this.revision){this.dirty=true;return;}
    const updated=await this.commandIn(binding.world,'update',binding.config.id,input,full,fresh);
    if(!updated.ok){this.needsDocument=true;this.dirty=true;return;}
    binding.config.inputSeq=input;
    if(revision!==this.revision||this.suspended||!this.viewers||input!==this.currentInput()){
     this.dirty=true;return;
    }
    if(!this.enabled){
     const enabled=await this.commandIn(binding.world,'enable',binding.config.id,true);
     if(!enabled.ok){this.needsDocument=true;this.dirty=true;return;}
     this.enabled=true;
    }
    this.forceResources=false;this.sentRequestVersion=request;
    // A control wake is ordered after the actual native update/enable ACK.
    // Autonomous ordinary frames never return through this control pump.
    if(fresh)await this.frameDriver?.requestNow();
   }
 }
 async pump(){
  const deadline=performance.now()+6000;
  while(this.dirty){
   if(performance.now()>=deadline)throw failed('Native reconciliation deadline exceeded','NATIVE_CONTROL_TIMEOUT');
   this.dirty=false;
   try{
    if(this.stopped){await this.retire();return;}
    if(this.suspended){await this.disable();this.needsDrain=false;return;}
    if(this.prime){this.prime=false;this.frameDriver?.start();await this.frameDriver?.requestNow();}
    if(this.viewers&&!this.binding?.registered)this.needsDocument=true;
    if(this.needsDocument)await this.bindDocument();
    if(this.stopped||this.suspended||this.needsDocument){this.dirty=true;continue;}
    const binding=this.binding;if(!binding){this.dirty=true;continue;}
    if(!this.viewers)await this.disable();
    else{if(this.mustDrain)await this.disable();await this.updateEnabled(binding);}
    if(this.suspended||this.needsDocument||binding.revision!==this.revision){this.dirty=true;continue;}
    if(this.needsDrain){await this.drainBinding(binding);this.needsDrain=false;}
    if(this.needsFence){
     const revision=this.revision,state=await this.commandIn(binding.world,'inspect',binding.config.id);
     if(!state.ok||revision!==this.revision){this.refresh();continue;}
     this.lastStarted=Math.max(this.lastStarted,state.lastStarted);this.needsFence=false;
     this.fenceSnapshot={captureOrdinal:state.lastStarted,pageEpoch:this.pageEpoch,viewportVersion:this.viewportVersion,inputSeq:this.currentInput()};
    }
    this.setTransitioning(false);
   }catch(error){if(!transient(error))throw error;this.refresh();}
  }
 }
 accept(event){
  const binding=this.binding;if(this.stopped||!binding?.registered)return;
  if(event.event==='NativeFrame'&&binding.revision===this.revision&&event.scopeId===binding.config.id&&event.generation===binding.config.generation&&event.pageEpoch===this.pageEpoch&&event.viewportVersion===this.viewportVersion){
   this.lastStarted=Math.max(this.lastStarted,event.captureOrdinal);this.emit('frame',event);
  }else if(event.event==='NativeFrameRejected'&&event.captureId?.startsWith(binding.config.id+':')){
   if(event.outcome==='pause')this.mustDrain=true;
   const error=failed(event.reason,event.code);error.outcome=event.outcome;
   this.emit(event.code==='VIZ_CAPTURE_SUPERSEDED'?'superseded':'captureError',error);
  }
 }
 async drain(){
  if(this.draining)return this.draining;
  this.draining=(async()=>{this.needsDrain=true;await this.schedule();})();
  try{return await this.draining;}finally{this.draining=null;this.needsDrain=false;}
 }
 async suspend(reason='manual'){if(this.stopped)throw new Error('Native subscription is closed');this.suspensions|=suspensionBit(reason);this.suspended=true;this.setTransitioning(true);await this.schedule();}
 setViewport(viewport){
  if(!this.suspended||this.enabled||this.work)throw new Error('Native viewport requires a completed suspension');
  this.viewport=viewportOf(viewport);this.viewportVersion++;this.needsDocument=true;this.setTransitioning(true);
 }
 resume(reason='manual'){if(this.stopped)return;this.suspensions&=~suspensionBit(reason);this.suspended=this.suspensions!==0;this.prime=!this.suspended&&this.viewers>0;this.schedule();}
 async fence(){
  if(this.stopped)throw new Error('Native subscription is closed');
  if(this.fencing)return this.fencing;
  this.fencing=(async()=>{
   this.needsFence=true;await this.schedule();
   if(this.needsFence)throw failed('Native source is transitioning','NATIVE_SOURCE_TRANSITION');
   return this.fenceSnapshot;
  })();
  try{return await this.fencing;}finally{this.fencing=null;this.needsFence=false;}
 }
 close({detach=true}={}){
  if(this.closing)return this.closing;
  this.stopped=true;this.viewers=0;
  this.cdp?.off('Page.frameNavigated',this.onNavigation);this.cdp?.off('Runtime.executionContextDestroyed',this.onContextDestroyed);this.cdp?.off('Runtime.executionContextsCleared',this.onContextsCleared);this.broker.off('event',this.onBrokerEvent);
  return this.closing=(async()=>{try{await this.work;}catch(error){if(detach)throw error;}finally{try{if(detach)await this.retire();else if(this.binding?.registered)await this.broker.request('cancelNative',{scopeId:this.binding.config.id});}finally{this.binding=null;if(detach)await this.cdp?.detach();}}})();
 }
}
