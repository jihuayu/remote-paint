import {startBeginFrames} from '../capture/begin-frame.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {SceneMapper} from '../capture/scene.mjs';
import {NativeBroker} from '../native/broker.mjs';
import {ResourcePressure} from './resource-pressure.mjs';
import {SourceDemand} from './source-demand.mjs';
import {createNativeSource} from './native-source.mjs';
export async function startLiveSource({url,executablePath=process.env.REMOTE_PAINT_CHROMIUM,viewport={width:960,height:640},interval=1000/60,beginFrames=process.platform==='linux',captureOnInput=true,navigationTimeout=30000}={}){
 const startup=performance.now();
 if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM to the custom compiled headless_shell (npm run native:chromium)');
 let browser,capture,frameDriver,broker,viz,source,targetCrashed=false;
 const closeParts=async()=>{
  const errors=[];
  // A crashed renderer can leave target-session detach/queued input pending.
  // Closing its owning browser first resolves those calls; no target detach
  // remains necessary once that process has exited.
  const parts=targetCrashed?[()=>browser?.close(),()=>capture?.close({detach:false}),()=>frameDriver?.close({detach:false})]:[()=>capture?.close(),()=>frameDriver?.close(),()=>browser?.close()];
  for(const close of [...parts,()=>viz?.close(),()=>broker?.close()]){
   try{await close();}catch(error){errors.push(error);}
  }
  if(errors.length)throw new AggregateError(errors,'Source close failed');
 };
 if(process.env.REMOTE_PAINT_DATA_PLANE!=='node')broker=new NativeBroker();
 try{
  viz=await startVizIPC({broker,nativeResources:!!broker});const token=nativeToken();
  // The token switch installs capture in the Broker's isolated world. Do not
  // enable legacy GPU benchmarking APIs (including disk export) in source JS.
  browser=await chromium.launch({executablePath,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint,...(broker?{REMOTE_PAINT_NATIVE_RESOURCES:'1',REMOTE_PAINT_TILED_CAPTURE:process.env.REMOTE_PAINT_TILED_CAPTURE??'1'}:{})},args:nativeLaunchArgs(token,{beginFrames})});
  const page=await browser.newPage({viewport,deviceScaleFactor:1});
  page.on('crash',()=>{targetCrashed=true;if(source)source.targetCrashed=true;});
  // Keep the page clock alive during bootstrap: Steel/acceptance setup may
  // still interact with the source before the first Viewer demand arrives.
  // After bootstrap, display consumers and explicit Agent activity own the
  // clock independently. Only display consumers request captured scenes.
  if(beginFrames)frameDriver=await startBeginFrames(page);
  // A streaming response, long poll or slow image must not hold the Session
  // open forever. Navigation commit, capture readiness and first scene are
  // separate milestones; none implies that a business workflow is ready.
  await page.goto(url,{waitUntil:'commit',timeout:navigationTimeout});
  const navigationCommittedMs=performance.now()-startup;
  if(broker){
   const native=createNativeSource({page,browser,broker,viz,frameDriver,token,viewport,interval,captureOnInput,startup,navigationCommittedMs,closeParts});
   source=native.source;capture=native.capture;source.targetCrashed=targetCrashed;
   await native.initialize();return source;
  }
  capture=new NativeCapture(page,{token,viz,interval,frameDriver,captureOnInput});await capture.initialize();
  capture.forceResources=!!broker;
  source=new EventEmitter();Object.assign(source,{page,browser,capture,viz,frameDriver,targetCrashed,resourceMemoryVersion:1,pageEpoch:1,viewportVersion:1,latest:null,demand:0,inputSeq:0,mapper:broker?null:new SceneMapper(),broker,producer:null,
   readiness:{navigation:'committed',capture:'ready',firstScene:false,navigationCommittedMs,captureReadyMs:performance.now()-startup,firstSceneMs:null},
   viewport:{cssWidth:viewport.width,cssHeight:viewport.height,deviceScaleFactor:1},stats:{captures:0,errors:0,captureSupersessions:0,resourceRecoveries:0,resourcePressureEvents:0,resourcePressureResumes:0,lastError:null,recentErrors:[]}});
  let captureOrdinal=0;
  const demand=new SourceDemand({onChange:()=>applyDemand()});
  Object.defineProperties(source,{
   demand:{get:()=>demand.display},
   captureOrdinal:{get:()=>captureOrdinal},
   encodeDemand:{get:()=>demand.encoding},
   activityDemand:{get:()=>demand.pageRuns},
   demandState:{get:()=>demand.snapshot()},
  });
  let clockDrain;
  const updateClock=()=>{
   if(!frameDriver||source.transitioning||frameDriver.closed)return;
   if(!source.closed&&demand.clock>0)frameDriver.start();
   else if(!source.closed&&capture.running){
    // A retiring consumer cannot stop the clock under an in-flight capture.
    frameDriver.start();clockDrain??=capture.drain().catch(()=>{}).finally(()=>{clockDrain=null;updateClock();});
   }
   else void frameDriver.stop();
  };
  const applyDemand=()=>{
   const active=!source.closed&&demand.encoding>0;
   if(pressure&&pressure.active!==active)pressure.setActive(active);
   if(source.transitioning)return;
   const next=source.closed||source.resourcePaused?0:demand.encoding;
   if(capture.viewers!==next)capture.setDemand(next);
   updateClock();
  };
  // Legacy display counts remain display-only. Typed backend consumers can
  // request encoded frames without inventing a visible Viewer.
  source.setDemand=count=>demand.setDisplay(count);
  source.setConsumerDemand=counts=>demand.setStreams(counts);
  source.acquirePageRun=options=>demand.acquirePageRun(options);
  source.acquirePageActivity=source.acquirePageRun;
  source.requestCapture=()=>{if(!source.closed)capture.requestCapture();};
  source.invalidate=reason=>{if(source.closed)return;source.pageEpoch++;source.latest=null;source.readiness.firstScene=false;capture.forceResources=!!broker;source.mapper?.reset();void broker?.resetScene().catch(error=>{if(!source.closed)source.emit('captureError',error);});source.emit('invalidate',reason);};
  capture.on('navigation',()=>source.invalidate('navigation'));
  const failure=error=>{if(source.closed)return;source.stats.errors++;source.stats.registrationRetries=capture.registrationRetries;source.stats.lastError=error.message;source.stats.recentErrors.push({message:error.message,...(error.code?{code:error.code}:{}),...(error.captureDiagnostics?{capture:error.captureDiagnostics}:{}),pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,captures:source.stats.captures});if(source.stats.recentErrors.length>32)source.stats.recentErrors.shift();source.emit('captureError',error);};
  const pressure=broker?new ResourcePressure({broker,onError:failure,onStats:stats=>source.stats.resourcePool=stats,onChange:paused=>{
   if(source.closed)return;source.resourcePaused=paused;capture.forceResources=true;
   source.stats[paused?'resourcePressureEvents':'resourcePressureResumes']++;
   applyDemand();
   if(paused)source.emit('captureError',Object.assign(new Error('Resource allocation budget exceeded'),{code:'RESOURCE_BUDGET_PRESSURE'}));
  }}):null;
  capture.on('superseded',()=>source.stats.captureSupersessions++);
  const captureFailure=error=>{if(pressure&&['RESOURCE_BUDGET_PRESSURE','INPUT_BUDGET_PRESSURE'].includes(error.code)){source.stats.lastPressureCode=error.code;pressure.enter();}else failure(error);};
  capture.on('captureError',captureFailure);frameDriver?.on('frameError',failure);
  capture.sampleContext=()=>({inputSeq:source.inputSeq,captureOrdinal:++captureOrdinal});
  broker?.on('failure',failure);
  capture.on('capture',async(native,{inputSeq,captureOrdinal})=>{
   if(source.closed)return;
   try{
    if(source.producer&&source.producer!==native.producer)source.invalidate('producer');source.producer=native.producer;
    const epoch=source.pageEpoch,version=source.viewportVersion;
    const mapStarted=performance.now();
    const mapped=broker?await broker.map(native,{epoch,viewport:source.viewport,viewportVersion:version,inputSeq,metadataOnly:true,captureOrdinal}):source.mapper.map(native,epoch,source.viewport);
    if(source.closed||!source.encodeDemand||source.pageEpoch!==epoch||source.viewportVersion!==version)return;
    pressure?.recovered();
    if(native.resourcesComplete)capture.forceResources=false;
    source.stats.lastCaptureMs=native.timing?.captureRoundTripMs;source.stats.lastMapMs=performance.now()-mapStarted;
    source.latest={...mapped,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:{...source.viewport},lastProcessedInputSeq:inputSeq};
    source.readiness.firstScene=true;source.readiness.firstSceneMs??=performance.now()-startup;
    source.stats.captures++;source.stats.registrationRetries=capture.registrationRetries;source.stats.lastError=null;source.emit('frame',source.latest);
   }catch(error){
    if(source.closed)return;
    if(broker&&error.message==='Incremental native resource cache miss'){
     source.stats.resourceRecoveries++;capture.forceResources=true;capture.requestCapture();
    }else captureFailure(error);
   }
  });
  let resizeQueue=Promise.resolve();
  source.resize=({width,height})=>{
   if(source.closed)throw new Error('Source is closed');
   if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw new Error('Invalid source viewport');
   const resize=resizeQueue.then(async()=>{
   if(source.closed)throw new Error('Source is closed');
   source.transitioning=true;capture.setDemand(0);
   // Changing LocalSurfaceId under an outstanding external BeginFrame can
   // discard its ACK. The native capture callback must drain first as well:
   // invalidating its CDP registration can leave the renderer request busy.
   try{if(capture.running)frameDriver?.start();await capture.drain();capture.generation++;capture.forceResources=!!broker;await frameDriver?.stop();await page.setViewportSize({width,height});source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};source.viewportVersion++;source.latest=null;source.readiness.firstScene=false;source.emit('invalidate','viewport');}
   finally{source.transitioning=false;applyDemand();}
   });resizeQueue=resize.catch(()=>{});return resize;
  };
  let closePromise;
  source.close=()=>{
   if(closePromise)return closePromise;
   source.closed=true;pressure?.close();demand.close();capture.setDemand(0);
   source.latest=null;source.mapper?.reset();source.producer=null;source.readiness.firstScene=false;
   return closePromise=closeParts();
  };
  // Bootstrap is complete. Unowned external frames must not run indefinitely.
  applyDemand();await frameDriver?.stop();
  return source;
 }catch(error){try{await closeParts();}catch(cleanup){throw new AggregateError([error,cleanup],'Source startup and cleanup failed');}throw error;}
}
