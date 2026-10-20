import {EventEmitter} from 'node:events';
import {randomBytes,randomUUID} from 'node:crypto';
export const nativeToken=()=>randomBytes(32).toString('hex');

// One broker owns one page target. The secret is evaluated only in a CDP
// isolated world; source JavaScript never receives it. No disk-path API.
export class NativeCapture extends EventEmitter {
  constructor(page,{token,interval=1000/60,viz,frameDriver,captureOnInput=true,registrationAck=process.env.REMOTE_PAINT_CAPTURE_REGISTRATION_ACK!=='0',maxCaptureAttempts=3}={}) {
    super();if(!Number.isSafeInteger(maxCaptureAttempts)||maxCaptureAttempts<1||maxCaptureAttempts>8)throw new Error('Invalid capture retry budget');this.maxCaptureAttempts=maxCaptureAttempts;this.supersededCaptures=0;this.page=page;this.token=token;this.interval=interval;this.viz=viz;
    this.frameDriver=frameDriver;this.registrationAck=registrationAck;this.nextCaptureAt=0;this.captureOnInput=captureOnInput;this.urgent=false;
    this.lastCaptureAt=0;
    this.onFrame=result=>{const now=performance.now();if(this.urgent||((result?.hasDamage!==false||now-this.lastCaptureAt>=1000)&&now>=this.nextCaptureAt))void this.tick();};
    this.viewers=0;this.running=false;this.stopped=false;this.count=0;this.generation=0;this.idleWaiters=new Set();this.registrationRetries=0;this.registrationWarmupUntil=0;
  }
  async initialize() {
    this.cdp=await this.page.context().newCDPSession(this.page);
    await this.cdp.send('Page.enable');
    this.cdp.on('Page.frameNavigated',({frame})=>{if(!frame.parentId){this.world=null;this.generation++;this.registrationWarmupUntil=performance.now()+2000;this.emit('navigation');}});
    await this.ensureWorld();
    const result=await this.cdp.send('Runtime.evaluate',{contextId:this.world,expression:'typeof chrome?.gpuBenchmarking?.captureRemotePaint',returnByValue:true});
    if(result.result.value!=='function')throw new Error('Custom native Chromium captureRemotePaint is required; stock Chrome cannot stream this protocol');
    this.registrationWarmupUntil=performance.now()+2000;
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
    if(!this.viewers&&count>0&&typeof this.frameDriver?.requestNow==='function')this.clockWake=true;
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
  async drain(){if(!this.running)return;await new Promise((resolve,reject)=>this.idleWaiters.add({resolve,reject}));}
  async capture() {
    const started=performance.now(),expires=started+6000,generation=this.generation,hadDemand=this.viewers>0;let superseded=0;
    for(let attempt=0;attempt<this.maxCaptureAttempts;attempt++){
      if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
      try{
        const value=await this.captureAttempt(expires);
        if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
        return {...value,timing:{...value.timing,captureRoundTripMs:performance.now()-started,supersededAttempts:superseded}};
      }catch(error){
        if(error.code!=='VIZ_CAPTURE_SUPERSEDED'||generation!==this.generation)throw error;
        // Canceled native bytes may have populated Chromium's encoding cache
        // without reaching the Broker's mapped resource cache.
        this.forceResources=true;
        superseded++;this.supersededCaptures++;this.emit('superseded',{attempt:attempt+1,diagnostics:error.captureDiagnostics});
        if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
        if(hadDemand&&!this.viewers)throw error;
        if(attempt+1===this.maxCaptureAttempts)throw Object.assign(new Error('Capture frame supersession retry budget exceeded'),{code:'VIZ_SUPERSESSION_LIMIT',captureDiagnostics:error.captureDiagnostics});
      }
    }
  }
  async captureAttempt(expires) {
    const started=performance.now();
    const generation=this.generation;
    let worldTimer;
    try{await Promise.race([this.ensureWorld(),new Promise((_,reject)=>{worldTimer=setTimeout(()=>reject(Object.assign(new Error('Native capture deadline exceeded'),{code:'NATIVE_CAPTURE_TIMEOUT'})),Math.max(1,expires-performance.now()));})]);}
    finally{clearTimeout(worldTimer);}
    if(!this.viz)throw new Error('A private Viz IPC receiver is required');
    const captureId=randomUUID();
    const remaining=expires-performance.now();if(remaining<=0)throw Object.assign(new Error('Native capture deadline exceeded'),{code:'NATIVE_CAPTURE_TIMEOUT'});
    const scene=this.viz.waitFor(captureId,{timeout:remaining});scene.catch(()=>{});
    const rejectedBefore=this.viz.stats?.rejected??0;
    let registeredAt,ackAt,replyAt,vizAt,nativeFrame;
    const observedScene=scene.then(value=>{vizAt=performance.now();return value;});observedScene.catch(()=>{});
    let timer,finished=false,valuePromise;
    const registrationAck=this.registrationAck&&this.frameDriver,objectGroup=`remote-paint-${captureId}`;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Native capture deadline exceeded'),{code:'NATIVE_CAPTURE_TIMEOUT'})),remaining);});
    deadline.catch(()=>{});
    try {
    await Promise.race([scene.registered,deadline]);
    registeredAt=performance.now();
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
      ackAt=performance.now();
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
    valuePromise=evaluated.then(({result,exceptionDetails})=>{
        replyAt=performance.now();
        if(generation!==this.generation)throw new Error('Navigation invalidated the in-flight capture');
        if(exceptionDetails)throw new Error(exceptionDetails.exception?.description??exceptionDetails.text);
        if(result.value?.error)throw Object.assign(new Error(result.value.error),['NATIVE_CAPTURE_HOST_CLOSED','RESOURCE_BUDGET_PRESSURE'].includes(result.value.code)?{code:result.value.code}:{});
        if(result.value?.captureId!==captureId)throw new Error('Native capture pairing mismatch');
        if(!Array.isArray(result.value?.resources))throw new Error('Incomplete native capture');
        nativeFrame={producer:typeof result.value.producer==='string'?result.value.producer.slice(0,160):null,frameToken:Number.isSafeInteger(result.value.frameToken)?result.value.frameToken:null,sourceFrame:Number.isSafeInteger(result.value.sourceFrame)?result.value.sourceFrame:null};
        return result.value;
      });valuePromise.catch(()=>{});
    const [value,viz]=await Promise.race([Promise.all([valuePromise,observedScene]),deadline]);
    if(generation!==this.generation)throw new Error('Navigation invalidated the Viz frame');
    this.registrationWarmupUntil=0;this.count++;return {...value,viz,timing:{...value.timing,captureRoundTripMs:performance.now()-started,cdpReplyMs:replyAt-requestStarted,vizWaitMs:performance.now()-replyAt}};
    }catch(error){
      // Supersession or input admission can arrive before asynchronous SKP/CDP finishes.
      // Drain that callback before another registration can reuse the host.
      if(['VIZ_CAPTURE_SUPERSEDED','RESOURCE_BUDGET_PRESSURE','INPUT_BUDGET_PRESSURE'].includes(error.code)&&generation===this.generation&&valuePromise){
        try{await Promise.race([valuePromise,deadline]);}catch(replyError){error=replyError;}
      }
      this.viz.cancel(captureId);const failure=generation!==this.generation?new Error('Navigation invalidated the in-flight capture'):error;
      const elapsed=at=>at===undefined?null:Math.round((at-started)*1000)/1000;
      failure.captureDiagnostics={captureId,generation,currentGeneration:this.generation,elapsedMs:elapsed(performance.now()),registeredMs:elapsed(registeredAt),registrationAckMs:elapsed(ackAt),cdpReplyMs:elapsed(replyAt),vizReadyMs:elapsed(vizAt),registrationAck:!!registrationAck,nativeFrame:nativeFrame??null,vizRejectedDelta:(this.viz.stats?.rejected??0)-rejectedBefore,vizRejections:this.viz.stats?.rejections?.slice(-4)??[]};
      throw failure;
    }
    finally{finished=true;clearTimeout(timer);if(registrationAck)void this.cdp.send('Runtime.releaseObjectGroup',{objectGroup}).catch(()=>{});}
  }
  async tick() {
    if(this.running||!this.viewers||this.stopped)return;
    clearTimeout(this.timer);this.timer=undefined;this.urgent=false;
    this.running=true;const start=performance.now();this.lastCaptureAt=start;let failure,context;
    try {
      // Bootstrap may have stopped before the renderer created its root layer.
      // A first consumer can arrive long after the startup retry window. Prime
      // one acknowledged clock frame before registration on each encoding wake;
      // this.running also blocks onFrame reentry and makes cancellation drain it.
      if(this.clockWake){this.clockWake=false;await this.frameDriver.requestNow();if(!this.viewers||this.stopped)return;}
      context=this.sampleContext?.();
      const value=await this.capture();if(this.viewers&&!this.stopped)this.emit('capture',value,context);else if(value.captureId)this.viz?.cancel(value.captureId);
    }
    catch(error){
      // A new document may expose the isolated API before its root layer is
      // ready. The false registration result has no frame to publish. Retry
      // only during a bounded trusted navigation/startup window; persistent
      // refusal and all other errors retain the normal failure path.
      if(error.code==='VIZ_CAPTURE_SUPERSEDED'&&!this.viewers){/* Obsolete display request drained. */}
      else if(performance.now()<this.registrationWarmupUntil&&/^(?:Error: )?Native capture refused(?:\n|$)/.test(error.message))this.registrationRetries++;
      else{failure=error;if(!this.stopped)this.emit('captureError',error);}
    }
    finally {this.running=false;for(const waiter of this.idleWaiters)failure?waiter.reject(failure):waiter.resolve();this.idleWaiters.clear();this.nextCaptureAt=Math.max(start+this.interval,performance.now());if(this.viewers&&!this.stopped){if(this.frameDriver&&this.urgent)queueMicrotask(()=>void this.tick());else if(!this.frameDriver)this.timer=setTimeout(()=>void this.tick(),this.urgent?0:Math.max(0,this.interval-(performance.now()-start)));}}
  }
  async close({detach=true}={}) {this.stopped=true;this.frameDriver?.off('frame',this.onFrame);clearTimeout(this.timer);if(detach)await this.cdp?.detach();}
}
