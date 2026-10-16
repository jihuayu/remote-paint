import {startBeginFrames} from '../capture/begin-frame.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
import {EventEmitter} from 'node:events';
import {chromium} from 'playwright';
import {NativeCapture,nativeToken} from '../capture/live.mjs';
import {startVizIPC} from '../capture/viz-ipc.mjs';
import {SceneMapper} from '../capture/scene.mjs';
import {validateScene} from '../protocol/live-wire.mjs';
export async function startLiveSource({url,executablePath=process.env.REMOTE_PAINT_CHROMIUM,viewport={width:960,height:640},interval=120,beginFrames=process.platform==='linux',captureOnInput=true}={}){
 if(!executablePath)throw new Error('Set REMOTE_PAINT_CHROMIUM to the custom compiled headless_shell (npm run native:chromium)');
 const viz=await startVizIPC(),token=nativeToken();let browser,capture,frameDriver;
 try{
  // The token switch installs capture in the Broker's isolated world. Do not
  // enable legacy GPU benchmarking APIs (including disk export) in source JS.
  browser=await chromium.launch({executablePath,headless:true,env:{...process.env,REMOTE_PAINT_SOCKET:viz.endpoint},args:nativeLaunchArgs(token,{beginFrames})});
  const page=await browser.newPage({viewport,deviceScaleFactor:1});
  // Keep the page clock alive during bootstrap: Steel/acceptance setup may
  // still interact with the source before the first Viewer demand arrives.
  // Once transport demand is observed, source.setDemand owns the clock and
  // stops it after the last Viewer disconnects.
  if(beginFrames)frameDriver=await startBeginFrames(page);
  await page.goto(url,{waitUntil:'networkidle'});
  capture=new NativeCapture(page,{token,viz,interval,frameDriver,captureOnInput});await capture.initialize();
  const source=new EventEmitter();Object.assign(source,{page,browser,capture,viz,frameDriver,pageEpoch:1,viewportVersion:1,latest:null,demand:0,inputSeq:0,mapper:new SceneMapper(),producer:null,
   viewport:{cssWidth:viewport.width,cssHeight:viewport.height,deviceScaleFactor:1},stats:{captures:0,errors:0,lastError:null}});
  source.setDemand=count=>{
   source.demand=count;capture.setDemand(count);
   if(frameDriver){
    if(count>0)frameDriver.start();
    else void frameDriver.stop();
   }
  };
  source.requestCapture=()=>capture.requestCapture();
  source.invalidate=reason=>{source.pageEpoch++;source.latest=null;source.mapper.reset();source.emit('invalidate',reason);};
  capture.on('navigation',()=>source.invalidate('navigation'));
  const failure=error=>{source.stats.errors++;source.stats.lastError=error.message;source.emit('captureError',error);};
  capture.on('captureError',failure);frameDriver?.on('frameError',failure);
  capture.sampleContext=()=>source.inputSeq;
  capture.on('capture',(native,inputSeq)=>{
   try{
    if(source.producer&&source.producer!==native.producer)source.invalidate('producer');source.producer=native.producer;
    const mapped=source.mapper.map(native,source.pageEpoch);validateScene(mapped.scene,[...mapped.payloads.keys()],source.viewport);
    source.latest={...mapped,pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:{...source.viewport},lastProcessedInputSeq:inputSeq};
    source.stats.captures++;source.stats.lastError=null;source.emit('frame',source.latest);
   }catch(error){source.stats.errors++;source.stats.lastError=error.message;source.emit('captureError',error);}
  });
  source.resize=async({width,height})=>{
   if(![width,height].every(n=>Number.isInteger(n)&&n>0&&n<=4096))throw new Error('Invalid source viewport');
   const demand=source.demand;capture.setDemand(0);capture.generation++;
   try{await page.setViewportSize({width,height});source.viewport={cssWidth:width,cssHeight:height,deviceScaleFactor:1};source.viewportVersion++;source.latest=null;source.emit('invalidate','viewport');}
   finally{capture.setDemand(demand);}
  };
  source.close=async()=>{source.setDemand(0);await capture.close();await frameDriver?.close();await browser.close();await viz.close();};
  return source;
 }catch(error){await capture?.close();await frameDriver?.close();await browser?.close();await viz.close();throw error;}
}
