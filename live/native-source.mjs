import {EventEmitter} from 'node:events';
import {NativeSubscription} from '../capture/subscription.mjs';
import {SourceDemand} from './source-demand.mjs';
import {ResourcePressure} from './resource-pressure.mjs';

// Construct before initialization so startup failures and renderer crashes keep
// the same outer Source/browser cleanup owner as the diagnostic Node path.
export function createNativeSource({page,browser,broker,viz,frameDriver,token,viewport,interval,captureOnInput,startup,navigationCommittedMs,closeParts}){
 const source=new EventEmitter();
 Object.assign(source,{page,browser,broker,viz,frameDriver,mapper:null,nativeAutopublish:true,resourceMemoryVersion:1,
  pageEpoch:1,viewportVersion:1,inputSeq:0,latest:null,producer:null,transitioning:true,
  viewport:{cssWidth:viewport.width,cssHeight:viewport.height,deviceScaleFactor:1},
  readiness:{navigation:'committed',capture:'initializing',firstScene:false,navigationCommittedMs,captureReadyMs:null,firstSceneMs:null},
  stats:{captures:0,errors:0,captureSupersessions:0,resourceRecoveries:0,resourcePressureEvents:0,resourcePressureResumes:0,resetRequests:0,completedResets:0,failedResets:0,lastError:null,recentErrors:[]}});
 const capture=source.capture=new NativeSubscription(page,{token,broker,frameDriver,viewport,interval,captureOnInput,inputSeq:()=>source.inputSeq});
 let pressure,clockDrain,resizing=false,resizeTarget,resizeWork,closePromise;
 const pendingResets=new Set();let resetDrain,resetGeneration=0;
 const failure=error=>{
  if(source.closed)return;
  source.stats.errors++;source.stats.registrationRetries=capture.registrationRetries;source.stats.lastError=error.message;
  source.stats.recentErrors.push({message:error.message,...(error.code?{code:error.code}:{}),...(error.outcome?{outcome:error.outcome}:{}),pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,captures:source.stats.captures});
  if(source.stats.recentErrors.length>32)source.stats.recentErrors.shift();source.emit('captureError',error);
 };
 const demand=new SourceDemand({onChange:()=>applyDemand()});
 Object.defineProperties(source,{
  demand:{get:()=>demand.display},encodeDemand:{get:()=>demand.encoding},activityDemand:{get:()=>demand.pageRuns},
  demandState:{get:()=>demand.snapshot()},captureOrdinal:{get:()=>capture.captureOrdinal},
  resetState:{get:()=>Object.freeze({pending:pendingResets.size,suspended:!!(capture.suspensions&4)})},
 });
 const updateClock=()=>{
  if(!frameDriver||source.closed||resizing||frameDriver.closed)return;
  if(demand.clock>0)frameDriver.start();
  else if(capture.running||capture.enabled||capture.mustDrain){
   frameDriver.start();
   clockDrain??=capture.drain().catch(failure).finally(()=>{clockDrain=null;updateClock();});
  }else void frameDriver.stop();
 };
 const applyDemand=()=>{
  const active=!source.closed&&demand.encoding>0;
  if(pressure&&pressure.active!==active)pressure.setActive(active);
  capture.setDemand(source.closed||source.resourcePaused?0:demand.encoding);
  updateClock();
 };
 const syncTransition=()=>{source.transitioning=resizing||pendingResets.size>0||capture.transitioning;updateClock();};
 const invalidate=reason=>{source.latest=null;source.producer=null;source.readiness.firstScene=false;source.emit('invalidate',reason);};
 source.setDemand=count=>demand.setDisplay(count);
 source.setConsumerDemand=counts=>demand.setStreams(counts);
 source.acquirePageRun=options=>demand.acquirePageRun(options);source.acquirePageActivity=source.acquirePageRun;
 source.requestCapture=()=>{if(!source.closed)capture.requestCapture();};
 source.requestFreshFrame=()=>{if(!source.closed)capture.requestFreshFrame();};
 source.getConsumerFence=()=>capture.fence();
 // A signal cannot assign a new document identity or increment its epoch.
 source.invalidate=()=>{if(!source.closed)capture.refresh();};
 capture.on('transition',syncTransition);
 capture.on('document',({documentToken,pageEpoch})=>{
  if(source.closed)return;
  const changed=source.nativeDocumentToken!==undefined&&source.nativeDocumentToken!==documentToken;
  source.nativeDocumentToken=documentToken;source.pageEpoch=pageEpoch;if(changed)invalidate('navigation');
 });
 const resetStart=({id})=>{
  if(source.closed)return;
  pendingResets.add(id);resetGeneration++;source.stats.resetRequests++;
  source.latest=null;source.producer=null;source.readiness.firstScene=false;
  // Rust revokes before queueing reset, including requests later denied by
  // its queue. Hold new bindings from the write through every terminal reply.
  if(!resetDrain){resetDrain=capture.suspend('reset');resetDrain.catch(failure);}
  syncTransition();
 };
 const resetEnd=({id,ok,closed,message,code})=>{
  if(!pendingResets.delete(id)||source.closed)return;
  source.stats[ok?'completedResets':'failedResets']++;
  if(!ok)source.stats.lastResetError={message,...(code?{code}:{})};
  if(closed||broker.closed||pendingResets.size){syncTransition();return;}
  const generation=resetGeneration,drained=resetDrain;resetDrain=null;
  // Rebinding reads the actual document token, carries the reserved ordinal
  // tail and sends full resources. A reset alone never increments pageEpoch.
  capture.refresh();
  void Promise.resolve(drained).then(()=>{
   if(source.closed||broker.closed||pendingResets.size||generation!==resetGeneration)return;
   capture.resume('reset');syncTransition();applyDemand();
  },()=>{});
 };
 broker.on('resetStart',resetStart);broker.on('resetEnd',resetEnd);
 pressure=new ResourcePressure({broker,onError:failure,onStats:stats=>source.stats.resourcePool=stats,onChange:paused=>{
  if(source.closed)return;
  source.resourcePaused=paused;capture.forceResources=true;
  source.stats[paused?'resourcePressureEvents':'resourcePressureResumes']++;applyDemand();
  if(paused)source.emit('captureError',Object.assign(new Error('Resource allocation budget exceeded'),{code:'RESOURCE_BUDGET_PRESSURE'}));
 }});
 capture.on('superseded',error=>{if(source.closed)return;source.stats.captureSupersessions++;if(error.outcome==='pause')failure(error);});
 capture.on('captureError',error=>{
  if(source.closed)return;
  if(error.outcome==='retry'){source.stats.resourceRecoveries++;source.stats.lastRetryCode=error.code;return;}
  if(['RESOURCE_BUDGET_PRESSURE','INPUT_BUDGET_PRESSURE'].includes(error.code)){source.stats.lastPressureCode=error.code;pressure.enter();}
  else failure(error);
 });
 frameDriver?.on('frameError',failure);broker.on('failure',failure);
 capture.on('frame',event=>{
  if(source.closed||pendingResets.size||capture.suspensions&4||!source.encodeDemand||source.resourcePaused||event.pageEpoch!==source.pageEpoch||event.viewportVersion!==source.viewportVersion)return;
  pressure.recovered();source.producer=event.producer;
  source.latest={brokerSerial:event.serial,pageEpoch:event.pageEpoch,viewportVersion:event.viewportVersion,viewport:{...source.viewport},lastProcessedInputSeq:event.inputSeq,
   native:{captureId:event.captureId,captureOrdinal:event.captureOrdinal,producer:event.producer,frameToken:event.frameToken,sourceFrame:event.sourceFrame},
   rawResourceBytes:event.rawResourceBytes,rawResourceCount:event.rawResourceCount,sceneResourceCount:event.sceneResources,resourcesComplete:event.resourcesComplete};
  source.readiness.firstScene=true;source.readiness.firstSceneMs??=performance.now()-startup;
  source.stats.captures++;source.stats.registrationRetries=capture.registrationRetries;source.stats.lastMapMs=event.mapMicros/1000;source.stats.lastError=null;source.emit('frame',source.latest);
 });
 source.resize=({width,height})=>{
  if(source.closed)throw new Error('Source is closed');
  if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw new Error('Invalid source viewport');
  // Keep one latest requested size and one shared completion barrier. Rapid
  // calls may supersede intermediate sizes without retaining a promise chain.
  resizeTarget={width,height};
  if(!resizeWork)resizeWork=Promise.resolve().then(async()=>{
   if(source.closed)throw new Error('Source is closed');
   while(resizeTarget){
    const next=resizeTarget;resizeTarget=null;
    if(source.closed)throw new Error('Source is closed');
    resizing=true;syncTransition();
    try{
     await capture.suspend('resize');if(source.closed)throw new Error('Source is closed');
     await frameDriver?.stop();await page.setViewportSize(next);if(source.closed)throw new Error('Source is closed');
     // Context signals from the viewport command may have queued a disabled
     // reconciliation. Join that control operation before changing its target.
     await capture.suspend('resize');capture.setViewport(next);
     source.viewport={cssWidth:next.width,cssHeight:next.height,deviceScaleFactor:1};source.viewportVersion=capture.viewportVersion;invalidate('viewport');
    }finally{resizing=false;if(!source.closed){capture.resume('resize');syncTransition();applyDemand();}}
   }
  }).finally(()=>{resizeWork=null;});
  return resizeWork;
 };
 source.close=()=>{
  if(closePromise)return closePromise;
  source.closed=true;resetGeneration++;pendingResets.clear();broker.off('resetStart',resetStart);broker.off('resetEnd',resetEnd);broker.off('failure',failure);frameDriver?.off('frameError',failure);
  pressure.close();demand.close();capture.setDemand(0);resizeTarget=null;
  source.latest=null;source.producer=null;source.readiness.firstScene=false;
  return closePromise=closeParts();
 };
 return {source,capture,async initialize(){
  await capture.initialize();source.readiness.capture='ready';source.readiness.captureReadyMs=performance.now()-startup;
  syncTransition();applyDemand();await capture.drain();await frameDriver?.stop();
 }};
}
