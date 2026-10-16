import {EventEmitter} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
export const nativeToken=()=>randomBytes(32).toString('hex');

// One broker owns one page target. The secret is evaluated only in a CDP
// isolated world; source JavaScript never receives it. No disk-path API.
export class NativeCapture extends EventEmitter {
  constructor(page,{token,interval=1000/60,viz,frameDriver,captureOnInput=true,registrationAck=process.env.REMOTE_PAINT_CAPTURE_REGISTRATION_ACK!=='0'}={}) {
    super();this.page=page;this.token=token;this.interval=interval;this.viz=viz;
    this.frameDriver=frameDriver;this.registrationAck=registrationAck;this.nextCaptureAt=0;this.captureOnInput=captureOnInput;this.urgent=false;
    this.lastCaptureAt=0;
    this.onFrame=result=>{const now=performance.now();if(this.urgent||((result?.hasDamage!==false||now-this.lastCaptureAt>=1000)&&now>=this.nextCaptureAt))void this.tick();};
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
    const generation=this.generation;
    const {frameTree}=await this.cdp.send('Page.getFrameTree');
    const {executionContextId}=await this.cdp.send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:'remote-paint-broker'});
    if(generation!==this.generation)throw new Error('Navigation invalidated the isolated capture world');
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
    // Register capture first, then drive its compositor frame. The renderer
    // ACK in capture() orders registration across the two CDP sessions.
    if(this.frameDriver&&!this.running)void this.tick();
    if(!this.frameDriver&&!this.running){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.tick(),0);}
  }
  async capture() {
    const started=performance.now();
    const generation=this.generation;
    await this.ensureWorld();
    if(!this.viz)throw new Error('A private Viz IPC receiver is required');
    const captureId=randomUUID();
    const scene=this.viz.waitFor(captureId);scene.catch(()=>{});
    let timer,finished=false;
    const registrationAck=this.registrationAck&&this.frameDriver,objectGroup=`remote-paint-${captureId}`;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Native capture deadline exceeded')),6000);});
    deadline.catch(()=>{});
    try {
    await Promise.race([scene.registered,deadline]);
    if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
    const requestStarted=performance.now();
    const requested=this.cdp.send('Runtime.evaluate',{
      contextId:this.world,awaitPromise:!registrationAck,returnByValue:!registrationAck,
      ...(registrationAck?{objectGroup}:{}),
      expression:`new Promise((resolve,reject)=>{if(!chrome.gpuBenchmarking.captureRemotePaint(${JSON.stringify(this.token)},${JSON.stringify(captureId)},resolve,${this.forceResources===true}))reject(new Error('Native capture refused'));})`,
    });
    // An unawaited Promise handle acknowledges that the renderer ran the
    // registration. Merely sending evaluate before BeginFrame does not do so.
    const evaluated=registrationAck?requested.then(response=>{
      if(response.exceptionDetails)return response;
      if(finished||generation!==this.generation)throw new Error('Capture registration was invalidated');
      const promiseObjectId=response.result?.objectId;
      if(!promiseObjectId)throw new Error('Native capture registration did not return a Promise handle');
      const reply=this.cdp.send('Runtime.awaitPromise',{promiseObjectId,returnByValue:true});
      void this.frameDriver.requestNow().catch(()=>{});
      return reply;
    }):requested;
    if(this.frameDriver&&!registrationAck)void this.frameDriver.requestNow().catch(()=>{});
    // Navigation/resize can discard a native callback after its request has
    // left the compositor queue. Observe IPC failure concurrently and bound
    // the entire transaction, including a ready Viz frame with no CDP reply.
    let replyAt;
    const [value,viz]=await Promise.race([
      Promise.all([evaluated.then(({result,exceptionDetails})=>{
        replyAt=performance.now();
        if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
        if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
        if(result.value?.error)throw new Error(result.value.error);
        if(result.value?.captureId!==captureId)throw new Error('Native capture pairing mismatch');
        if(!Array.isArray(result.value?.resources))throw new Error('Incomplete native capture');
        return result.value;
      }),scene]),deadline,
    ]);
    if(generation!==this.generation)throw new Error('Navigation invalidated the Viz frame');
    this.count++;return {...value,viz,timing:{...value.timing,captureRoundTripMs:performance.now()-started,cdpReplyMs:replyAt-requestStarted,vizWaitMs:performance.now()-replyAt}};
    }catch(error){this.viz.cancel(captureId);if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');throw error;}
    finally{finished=true;clearTimeout(timer);if(registrationAck)void this.cdp.send('Runtime.releaseObjectGroup',{objectGroup}).catch(()=>{});}
  }
  async tick() {
    if(this.running||!this.viewers||this.stopped)return;
    clearTimeout(this.timer);this.timer=undefined;this.urgent=false;
    this.running=true;const start=performance.now(),context=this.sampleContext?.();this.lastCaptureAt=start;
    try {const value=await this.capture();if(this.viewers&&!this.stopped)this.emit('capture',value,context);else if(value.captureId)this.viz?.cancel(value.captureId);}
    catch(error){if(!this.stopped)this.emit('captureError',error);}
    finally {this.running=false;this.nextCaptureAt=Math.max(start+this.interval,performance.now());if(this.viewers&&!this.stopped){if(this.frameDriver&&this.urgent)queueMicrotask(()=>void this.tick());else if(!this.frameDriver)this.timer=setTimeout(()=>void this.tick(),this.urgent?0:Math.max(0,this.interval-(performance.now()-start)));}}
  }
  async close() {this.stopped=true;this.frameDriver?.off('frame',this.onFrame);clearTimeout(this.timer);await this.cdp?.detach();}
}
