import {EventEmitter} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
export const nativeToken=()=>randomBytes(32).toString('hex');

// One broker owns one page target. The secret is evaluated only in a CDP
// isolated world; source JavaScript never receives it. No disk-path API.
export class NativeCapture extends EventEmitter {
  constructor(page,{token,interval=120,viz,frameDriver,captureOnInput=true}={}) {
    super();this.page=page;this.token=token;this.interval=interval;this.viz=viz;
    this.frameDriver=frameDriver;this.nextCaptureAt=0;this.captureOnInput=captureOnInput;this.urgent=false;
    this.onFrame=()=>{if(this.urgent||performance.now()>=this.nextCaptureAt)void this.tick();};
    this.viewers=0;this.running=false;this.stopped=false;this.count=0;this.generation=0;
  }
  async initialize() {
    this.cdp=await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Page.enable');
    this.cdp.on('Page.frameNavigated',({frame})=>{if(!frame.parentId){this.world=null;this.generation++;this.emit('navigation');}});
    await this.ensureWorld();
    const result=await this.cdp.send('Runtime.evaluate',{contextId:this.world,expression:'typeof chrome?.gpuBenchmarking?.captureRemotePaint',returnByValue:true});
    if(result.result.value!=='function')throw new Error('Custom native Chromium captureRemotePaint is required; stock Chrome cannot stream this protocol');
    this.frameDriver?.on('frame',this.onFrame);
  }
  async ensureWorld() {
    if(this.world)return;
    const {frameTree}=await this.cdp.send('Page.getFrameTree');
    const {executionContextId}=await this.cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-broker'});
    this.world=executionContextId;
  }
  setDemand(count) {
    this.viewers=Math.max(0,count);
    if(!this.viewers){this.urgent=false;clearTimeout(this.timer);}
    if(this.viewers&&!this.running&&!this.stopped)void this.tick();
  }
  requestCapture() {
    if(!this.captureOnInput||!this.viewers||this.stopped)return;
    this.urgent=true;
    // Ask the external clock for a frame immediately. If one is already in
    // flight, requestNow() coalesces with it; the fallback coalesces a burst
    // into one task and an in-flight encoding always completes first.
    if(this.frameDriver)void this.frameDriver.requestNow().catch(()=>{});
    if(!this.frameDriver&&!this.running){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.tick(),0);}
  }
  async capture() {
    const generation=this.generation;
    await this.ensureWorld();
    if(!this.viz)throw new Error('A private Viz IPC receiver is required');
    const captureId=randomUUID();
    const scene=this.viz.waitFor(captureId);scene.catch(()=>{});
    try {
    const {result,exceptionDetails}=await this.cdp.send('Runtime.evaluate',{
      contextId:this.world,awaitPromise:true,returnByValue:true,
      expression:`new Promise((resolve,reject)=>{if(!chrome.gpuBenchmarking.captureRemotePaint(${JSON.stringify(this.token)},${JSON.stringify(captureId)},resolve))reject(new Error('Native capture refused'));})`,
    });
    if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
    if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
    if(result.value?.error)throw new Error(result.value.error);
    if(result.value?.captureId!==captureId)throw new Error('Native capture pairing mismatch');
    if(!Array.isArray(result.value?.resources))throw new Error('Incomplete native capture');
    const viz=await scene;
    if(generation!==this.generation)throw new Error('Navigation invalidated the Viz frame');
    this.count++;return {...result.value,viz};
    }catch(error){this.viz.cancel(captureId);throw error;}
  }
  async tick() {
    if(this.running||!this.viewers||this.stopped)return;
    clearTimeout(this.timer);this.timer=undefined;this.urgent=false;
    this.running=true;const start=performance.now(),context=this.sampleContext?.();
    try {const value=await this.capture();if(this.viewers&&!this.stopped)this.emit('capture',value,context);}
    catch(error){if(!this.stopped)this.emit('captureError',error);}
    finally {this.running=false;this.nextCaptureAt=Math.max(start+this.interval,performance.now());if(!this.frameDriver&&this.viewers&&!this.stopped)this.timer=setTimeout(()=>void this.tick(),this.urgent?0:Math.max(0,this.interval-(performance.now()-start)));}
  }
  async close() {this.stopped=true;this.frameDriver?.off('frame',this.onFrame);clearTimeout(this.timer);await this.cdp?.detach();}
}
