import {startBeginFrames} from '../capture/begin-frame.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {SceneMapper} from '../capture/scene.mjs';
import {NativeBroker} from '../native/broker.mjs';
import {validateScene} from '../protocol/live-wire.mjs';
export async function startLiveSource({url,executablePath=process.env.REMOTE_PAINT_CHROMIUM,viewport={width:960,height:640},interval=1000/60,beginFrames=process.platform==='linux',captureOnInput=true}={}){
 if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM to the custom compiled headless_shell (npm run native:chromium)');
 let browser,capture,frameDriver,broker;
 if(process.env.REMOTE_PAINT_DATA_PLANE!=='node')broker=new NativeBroker();
 const viz=await startVizIPC({broker,nativeResources:!!broker}),token=nativeToken();
 try{
  // The token switch installs capture in the Broker's isolated world. Do not
  // enable legacy GPU benchmarking APIs (including disk export) in source JS.
  browser=await chromium.launch({executablePath,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint,...(broker?{REMOTE_PAINT_NATIVE_RESOURCES:'1',REMOTE_PAINT_TILED_CAPTURE:process.env.REMOTE_PAINT_TILED_CAPTURE??'1'}:{})},args:nativeLaunchArgs(token,{beginFrames})});
  const page=await browser.newPage({viewport,deviceScaleFactor:1});
  // Keep the page clock alive during bootstrap: Steel/acceptance setup may
  // still interact with the source before the first Viewer demand arrives.
  // Once transport demand is observed, source.setDemand owns the clock and
  // stops it after the last Viewer disconnects.
  if(beginFrames)frameDriver=await startBeginFrames(page);
  await page.goto(url,{waitUntil:'networkidle'});
  capture=new NativeCapture(page,{token,viz,interval,frameDriver,captureOnInput});await capture.initialize();
  const source=new EventEmitter();Object.assign(source,{page,browser,capture,viz,frameDriver,pageEpoch:1,viewportVersion:1,latest:null,demand:0,inputSeq:0,mapper:broker?null:new SceneMapper(),broker,producer:null,
   viewport:{cssWidth:viewport.width,cssHeight:viewport.height,deviceScaleFactor:1},stats:{captures:0,errors:0,lastError:null,recentErrors:[]}});
  source.setDemand=count=>{
   source.demand=count;capture.setDemand(count);
   if(frameDriver){
    if(count>0)frameDriver.start();
    else void frameDriver.stop();
   }
  };
  source.requestCapture=()=>capture.requestCapture();
  source.invalidate=reason=>{source.pageEpoch++;source.latest=null;source.mapper?.reset();void broker?.resetScene().catch(error=>source.emit('captureError',error));source.emit('invalidate',reason);};
  capture.on('navigation',()=>source.invalidate('navigation'));
  const failure=error=>{source.stats.errors++;source.stats.lastError=error.message;source.stats.recentErrors.push({message:error.message,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,captures:source.stats.captures});if(source.stats.recentErrors.length>32)source.stats.recentErrors.shift();source.emit('captureError',error);};
  capture.on('captureError',failure);frameDriver?.on('frameError',failure);
  capture.sampleContext=()=>source.inputSeq;
  broker?.on('failure',failure);
  capture.on('capture',async(native,inputSeq)=>{
   try{
    if(source.producer&&source.producer!==native.producer)source.invalidate('producer');source.producer=native.producer;
    const epoch=source.pageEpoch,version=source.viewportVersion;
    const mapStarted=performance.now();
    const mapped=broker?await broker.map(native,{epoch,viewport:source.viewport,viewportVersion:version,inputSeq,metadataOnly:true}):source.mapper.map(native,epoch);
    if(source.pageEpoch!==epoch||source.viewportVersion!==version)return;
    source.stats.lastCaptureMs=native.timing?.captureRoundTripMs;source.stats.lastMapMs=performance.now()-mapStarted;
    if(!broker)validateScene(mapped.scene,[...mapped.payloads.keys()],source.viewport);
    source.latest={...mapped,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:{...source.viewport},lastProcessedInputSeq:inputSeq};
    source.stats.captures++;source.stats.lastError=null;source.emit('frame',source.latest);
   }catch(error){failure(error);}
  });
  source.resize=async({width,height})=>{
   if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw new Error('Invalid source viewport');
   const demand=source.demand;capture.setDemand(0);capture.generation++;
   try{await page.setViewportSize({width,height});source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};source.viewportVersion++;source.latest=null;source.emit('invalidate','viewport');}
   finally{capture.setDemand(demand);}
  };
  source.close=async()=>{source.setDemand(0);await capture.close();await frameDriver?.close();await browser.close();await viz.close();await broker?.close();};
  return source;
 }catch(error){await capture?.close();await frameDriver?.close();await browser?.close();await viz.close();await broker?.close();throw error;}
}
