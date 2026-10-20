// Tests only: preserve the production queue/draw/ACK code and add a bounded
// synchronous pixel observer at the same successful Worker commit. The served
// module is explicitly instrumented; its hashes and read cost are reported.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {makeStaticAssets} from '../live/static-assets.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {startLiveSource} from '../live/source.mjs';
import {startLiveTransport} from '../live/transport.mjs';
import {createControl} from '../live/input.mjs';
import {verifyLinuxClockInterval} from './linux-source-clock.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const nativeClock='chromium-time-ticks-v1';
const workerClock='worker-performance-v1';
const limit=4096;
// Pinned Chromium: TimeClamper's coarse resolution is100us, and
// Performance::MonotonicTimeToDOMHighResTimeStamp clamps both now and origin.
// Conservatively allow200us per Worker stamp, plus1us per native integer stamp,
// at both the probes and the measured endpoints. This includes timer rounding
// separately from the request/response interval and the affine drift assumption.
const nativeStampAllowanceMs=.001,workerStampAllowanceMs=.2;
function replaceOnce(source,marker,replacement){assert.equal(source.split(marker).length,2,`Observer insertion is no longer unique: ${marker}`);return source.replace(marker,replacement);}

// This exact self-contained function is also embedded in the Worker observer.
// Count only validated current-frame dependencies, never the entire cache or
// a view's backing allocation. Protocol4 permits at most256 per frame; the
// independent multi-frame resource window remains512.
export function summarizeFrameResources(required,resources){
 if(!Array.isArray(required)||required.length>256||!(resources instanceof Map))throw new Error('Invalid observer resource dependencies');
 const seen=new Set();let bytes=0,largest=0;
 for(const id of required){
  if(typeof id!=='string'||seen.has(id))throw new Error('Duplicate or invalid observer dependency');seen.add(id);
  const payload=resources.get(id);
  if(!(ArrayBuffer.isView(payload)||payload instanceof ArrayBuffer)||!Number.isSafeInteger(payload.byteLength)||payload.byteLength<=0)throw new Error('Missing or invalid observer resource payload');
  bytes+=payload.byteLength;largest=Math.max(largest,payload.byteLength);
  if(!Number.isSafeInteger(bytes))throw new Error('Observer resource sum overflow');
 }
 return {requiredResourceCount:required.length,requiredResourceBytes:bytes,largestRequiredResourceBytes:largest};
}
export function instrumentFrameAgeWorker(template,points,{diagnosticFaults=false,streaming=false}={}){
  // These exact insertion points bracket neither network nor decode. They
  // run after this frame's real draw and before the next queued commit.
  let body=replaceOnce(template,'self.onmessage=async event=>{try{',`
const __rpAge={enabled:false,window:0,all:0,observed:0,points:${JSON.stringify(points)},limit:${limit},protocolOrdinal:0,fault:null${streaming?',protocolRetained:0':''}};
const __rpProtocol=(kind,fields)=>{if(${streaming?'__rpAge.protocolRetained++':'__rpAge.protocolOrdinal'}>=512)throw new Error('Protocol observer retention bound');ui('__rpAgeProtocol',{record:{kind,ordinal:++__rpAge.protocolOrdinal,window:__rpAge.window,enabled:__rpAge.enabled,workerMs:performance.now(),...fields}});};
const __rpAgeResources=${summarizeFrameResources.toString()};
self.onmessage=async event=>{try{`);
  body=replaceOnce(body," if(message.type==='ping'){ui('pong',{nonce:message.nonce});}",`
 if(message.type==='__rpAgeCommand'){
  if(message.operation==='enable'){if(__rpAge.enabled)throw new Error('Age observer already enabled');__rpAge.enabled=true;__rpAge.window++;__rpAge.observed=0;}
  else if(message.operation==='disable')__rpAge.enabled=false;
  ${streaming?`else if(message.operation==='rotate'){if(!__rpAge.enabled)throw new Error('Cannot rotate a disabled observer');const ended={window:__rpAge.window,all:__rpAge.all,observed:__rpAge.observed,protocolOrdinal:__rpAge.protocolOrdinal};__rpAge.window++;__rpAge.observed=0;__rpAge.protocolRetained=0;ui('__rpAgeReply',{nonce:message.nonce,operation:'rotate',...ended,nextWindow:__rpAge.window,clock:'${workerClock}',now:performance.now()});return;}`:''}
  ${diagnosticFaults?"else if(['fault:delta-base','fault:missing-resource'].includes(message.operation)){if(!__rpAge.enabled||__rpAge.fault)throw new Error('Diagnostic fault must be armed inside an idle enabled window');__rpAge.fault=message.operation;}":''}
  else if(message.operation!=='clock')throw new Error('Unknown age observer operation');
  ui('__rpAgeReply',{nonce:message.nonce,operation:message.operation,window:__rpAge.window,all:__rpAge.all,observed:__rpAge.observed,protocolOrdinal:__rpAge.protocolOrdinal,clock:'${workerClock}',now:performance.now()});
 }
 else if(message.type==='ping'){ui('pong',{nonce:message.nonce});}`);
  body=replaceOnce(body,"const send=message=>{if(socket?.readyState===1)socket.send(JSON.stringify(message));};","const send=message=>{if(socket?.readyState===1){socket.send(JSON.stringify(message));if(message.type==='RequestKeyframe')__rpProtocol('keyframe-requested',{connectionGeneration:generation});}};");
  body=replaceOnce(body,' const recover=()=>{'," const recover=__rpCause=>{__rpProtocol('recover',{cause:__rpCause,connectionGeneration:current,willRequestKeyframe:!recovering});");
  body=replaceOnce(body,'if(error instanceof RecoveryRequired){recover();return;}',"if(error instanceof RecoveryRequired){recover('missing-delta-base');return;}");
  body=replaceOnce(body,'if(!frame){recover();return;}',"if(!frame){recover('commit-resources-unavailable');return;}");
  body=replaceOnce(body,'if(recovering&&!gate.pending)return;',"if(recovering&&!gate.pending){__rpProtocol('commit-skipped',{cause:'awaiting-recovery-scene',connectionGeneration:current,frameId:message.frameId});return;}");
  if(diagnosticFaults){
   body=replaceOnce(body,"if(message.type==='SceneUpdate'){try{gate.stage(message.frame);}","if(message.type==='SceneUpdate'){if(__rpAge.fault==='fault:delta-base'&&message.frame.baseFrameId!==null){__rpAge.fault=null;__rpProtocol('fault',{cause:'diagnostic-delta-base',connectionGeneration:current,frameId:message.frame.frameId,originalBaseFrameId:message.frame.baseFrameId,injectedBaseFrameId:message.frame.frameId+1,captureOrdinal:message.frame.native.captureOrdinal});message.frame={...message.frame,baseFrameId:message.frame.frameId+1};}try{gate.stage(message.frame);}");
   body=replaceOnce(body,"if(message.type==='ResourceManifest'){const payload=assets.assemble(message);","if(message.type==='ResourceManifest'){if(__rpAge.fault==='fault:missing-resource'&&!gate.resources.has(message.id)){__rpAge.fault=null;__rpProtocol('fault',{cause:'diagnostic-missing-resource-manifest',connectionGeneration:current,resourceId:message.id});return;}const payload=assets.assemble(message);");
  }
  const marker='    // The sender may reuse an earlier resource in another inflight frame.';
  body=replaceOnce(body,marker,`
    __rpAge.all++;
    if(__rpAge.enabled){
     if(__rpAge.observed>=__rpAge.limit)throw new Error('Frame-age observer retention bound');
     const context=canvas.getContext('2d');if(!context||presenter.presentation.mode!=='cpu-2d')throw new Error('Pixel age observer requires explicit actual CPU2D Worker');
     const resourceSummary=__rpAgeResources(frame.requiredResources,gate.resources);
     const readStarted=performance.now(),pixels=__rpAge.points.map(([x,y])=>[...context.getImageData(x,y,1,1).data]),observed=performance.now();
     __rpAge.observed++;
     ui('__rpAgeSample',{sample:{window:__rpAge.window,windowOrdinal:__rpAge.observed,commitOrdinal:__rpAge.all,connectionGeneration:current,pageEpoch:frame.pageEpoch,viewportVersion:frame.viewportVersion,frameId:frame.frameId,captureOrdinal:frame.native.captureOrdinal,sourceFrame:frame.native.sourceFrame,producer:frame.native.producer,captureClock:frame.native.timing?.captureClock,captureStartedMicros:frame.native.timing?.captureStartedMicros,inputSeq:frame.lastProcessedInputSeq,workerClock:'${workerClock}',observedMs:observed,pixelReadMs:observed-readStarted,pixels,...resourceSummary}});
    }
${marker}`);
  body=replaceOnce(body,' ws.onclose=event=>{'," ws.onclose=event=>{ui('__rpAgeSocketClose',{code:event.code,reason:event.reason,connectionGeneration:current,window:__rpAge.window,enabled:__rpAge.enabled,workerMs:performance.now()});");
  body=replaceOnce(body,"socket=ws;ws.binaryType='arraybuffer';","socket=ws;ws.binaryType='arraybuffer';ui('__rpAgeSocketStart',{connectionGeneration:current,window:__rpAge.window,enabled:__rpAge.enabled,workerMs:performance.now(),host:new URL(ws.url).host,path:new URL(ws.url).pathname,keyChars:new URL(ws.url).searchParams.get('key')?.length,keyMatchesArgument:new URL(ws.url).searchParams.get('key')===key,origin:self.origin,locationOrigin:location.origin,nativePort:config.nativePort});");
 return body;
}
async function prepareFrameAgeAssets(points,diagnosticFaults,streaming){
 const root=new URL('../',import.meta.url),files=new Map([
  ['/', ['viewer/live.html','text/html; charset=utf-8']],['/live.mjs',['viewer/live.mjs','text/javascript']],
  ['/input.mjs',['viewer/input.mjs','text/javascript']],['/control-channel.mjs',['viewer/control-channel.mjs','text/javascript']],
  ['/lifecycle.mjs',['viewer/lifecycle.mjs','text/javascript']],['/frame-presenter.mjs',['viewer/frame-presenter.mjs','text/javascript']],
  ['/renderer-runtime.mjs',['viewer/renderer-runtime.mjs','text/javascript']],['/damage.mjs',['viewer/damage.mjs','text/javascript']],
  ['/live.css',['viewer/live.css','text/css']],['/scene-renderer.mjs',['viewer/scene-renderer.mjs','text/javascript']],
  ['/protocol/asset-wire.mjs',['protocol/asset-wire.mjs','text/javascript']],['/protocol/client-memory.mjs',['protocol/client-memory.mjs','text/javascript']],
  ['/protocol/resource-memory.mjs',['protocol/resource-memory.mjs','text/javascript']],['/protocol/metadata-json.mjs',['protocol/metadata-json.mjs','text/javascript']],
  ['/protocol/live-wire.mjs',['protocol/live-wire.mjs','text/javascript']],['/protocol/wire.mjs',['protocol/wire.mjs','text/javascript']],
  ['/stream-worker.mjs',['viewer/stream-worker.mjs','text/javascript']],
  ['/vendor/canvaskit.js',['node_modules/canvaskit-wasm/bin/full/canvaskit.js','text/javascript']],
  ['/vendor/canvaskit.wasm',['node_modules/canvaskit-wasm/bin/full/canvaskit.wasm','application/wasm']],
 ]);
 const inputs=new Map(await Promise.all([...files].map(async([path,[file,type]])=>[path,{type,bytes:await readFile(new URL(file,root))}])));
 inputs.set('/canvaskit-worker.mjs',{type:'text/javascript',bytes:Buffer.concat([inputs.get('/vendor/canvaskit.js').bytes,Buffer.from('\nexport default CanvasKitInit;')])});
 // The complete copied input map must reproduce the real production bundle
 // exactly. Changes to its file set or types fail instead of silently forking it.
 const production=await prepareViewerAssets(),baseline=await makeStaticAssets(inputs);assert.equal(baseline.build,production.build,'Observer assets no longer reproduce production asset inputs');
 const template=inputs.get('/stream-worker.mjs').bytes.toString('utf8'),instrumented=instrumentFrameAgeWorker(template,points,{diagnosticFaults,streaming});
 inputs.set('/stream-worker.mjs',{...inputs.get('/stream-worker.mjs'),bytes:Buffer.from(instrumented)});
 const assets=await makeStaticAssets(inputs),original=production.get('/stream-worker.mjs').bytes,observed=assets.get('/stream-worker.mjs').bytes;
 const provenance={diagnosticFaults,streaming,baseTemplateSha256:hash(template),instrumentedTemplateSha256:hash(instrumented),productionBuild:production.build,observerBuild:assets.build,mode:'test-instrumented-production-Worker/cpu-2d;normalproductionassetbuilder/transport,withoutbrowserrouting',points,limit,timerRounding:{nativeStampAllowanceMs,workerStampAllowanceMs,basis:'Pinned Chromium time_clamper.h coarse100us;performance.cc clamps now and time-origin. Conservative200us per Worker stamp and1us per native stamp,atprobes andendpoints.'},served:[{originalServedSha256:hash(original),instrumentedServedSha256:hash(observed),instrumentationBytes:Buffer.byteLength(instrumented)-Buffer.byteLength(template)}],actualServed:[]};
 return {assets,provenance};
}
export async function startFrameAgeLive({url,port=0,host='127.0.0.1',points=[[412,72],[610,190],[690,190]],diagnosticFaults=false,streaming=false}={}){
 assert.ok(points.length>0&&points.length<=8&&points.every(p=>p.length===2&&p.every(n=>Number.isSafeInteger(n)&&n>=0)));
 assert.equal(typeof diagnosticFaults,'boolean');assert.equal(typeof streaming,'boolean');assert.ok(!streaming||!diagnosticFaults);const prepared=prepareFrameAgeAssets(points,diagnosticFaults,streaming);prepared.catch(()=>{});let source,transport,closing;
 const close=()=>closing??=(async()=>{const errors=[];for(const dispose of [()=>transport?.close(),()=>source?.control?.close(),()=>source?.close()])try{await dispose();}catch(e){errors.push(e);}if(errors.length)throw new AggregateError(errors,'Observed Live cleanup failed');})();
 try{source=await startLiveSource({url});source.control=await createControl(source);const{assets,provenance}=await prepared;transport=await startLiveTransport(source,{port,host,preparedAssets:assets});return {...transport,source,observerProvenance:provenance,close};}
 catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Observed Live startup/cleanup failed');}throw error;}
}
export async function installFrameAgeObserver(page,provenance){
 assert.ok(provenance?.observerBuild&&provenance.served.length===1);
 page.on('response',response=>{if(new URL(response.url()).pathname.endsWith('/stream-worker.mjs')){
  assert.ok(provenance.actualServed.length<4);const record={status:response.status(),sha256:null};provenance.actualServed.push(record);
  void response.body().then(bytes=>{record.sha256=hash(bytes);},()=>{record.error='Cannot read actual observer module response';});
 }});
 await page.addInitScript(({limit,streaming})=>{
  const NativeWorker=Worker,key=m=>[m.connectionGeneration,m.pageEpoch,m.viewportVersion,m.frameId].join(':');
  const state=window.__rpAge={worker:null,workerCount:0,nonce:0,pending:new Map(),samples:[],errors:[],protocolEvents:[],socketCloses:[],socketStarts:[],active:false,productionFrames:0,paired:0,start:null,end:null,lastProtocolOrdinal:0};
  const fail=message=>{if(state.errors.length<32)state.errors.push(message);};
  window.Worker=class extends NativeWorker{
   constructor(url,options){
    super(url,options);if(!new URL(String(url),location.href).pathname.endsWith('/stream-worker.mjs'))return;
    if(++state.workerCount!==1)fail('Observed production Worker was replaced');state.worker=this;
    this.addEventListener('message',({data})=>{
     if(data.type==='__rpAgeProtocol'){const r=data.record;if(state.protocolEvents.length>=512){fail('Protocol event retention bound');return;}if(r.ordinal!==state.lastProtocolOrdinal+1){fail('Protocol event coverage gap');return;}state.lastProtocolOrdinal=r.ordinal;state.protocolEvents.push(r);return;}
     if(data.type==='__rpAgeSocketStart'){if(state.socketStarts.length>=32)fail('Socket start retention bound');else state.socketStarts.push({...data});return;}
     if(data.type==='__rpAgeSocketClose'){if(state.socketCloses.length>=32)fail('Socket close retention bound');else state.socketCloses.push({...data});return;}
     if(data.type==='__rpAgeReply'){
      let completed;
      if(streaming&&['rotate','disable'].includes(data.operation)){
       if(!state.active)fail('Closed an inactive streaming observer');
       completed={samples:state.samples,errors:state.errors.slice(),paired:state.paired,start:state.start,end:{...data,productionFrames:state.productionFrames},workerCount:state.workerCount,pending:state.pending.size-1,protocolEvents:state.protocolEvents,socketStarts:state.socketStarts,socketCloses:state.socketCloses};
       state.samples=[];state.paired=0;state.protocolEvents=[];state.socketStarts=[];state.socketCloses=[];
       if(data.operation==='rotate')state.start={...data,window:data.nextWindow,observed:0,productionFrames:state.productionFrames};
      }
      if(data.operation==='enable'){state.samples=[];state.paired=0;state.active=true;state.start={...data,productionFrames:state.productionFrames};}
      if(data.operation==='disable'){state.active=false;state.end={...data,productionFrames:state.productionFrames};}
      const pending=state.pending.get(data.nonce);if(!pending){fail('Unexpected observer response');return;}state.pending.delete(data.nonce);clearTimeout(pending.timer);pending.resolve(completed?{...data,completed}:data);return;
     }
     if(data.type==='__rpAgeSample'){
      if(!state.active){fail('Pixel sample outside enabled window');return;}if(state.samples.length>=limit){fail('Main observer sample bound');return;}
      state.samples.push(data.sample);return;
     }
     if(data.type==='frame'){
      state.productionFrames++;if(!state.active)return;const sample=state.samples[state.paired],r=data.result;
      if(!sample||key(sample)!==key(r)||sample.captureOrdinal!==r.native.captureOrdinal){fail('Actual production frame event is not paired to its own pixel read');return;}
      sample.productionFramePaired=true;state.paired++;
     }
    });
   }
  };
  state.request=operation=>new Promise((resolve,reject)=>{
   if(!state.worker){reject(new Error('Actual production Worker is not ready'));return;}
   if(state.pending.size>=32){reject(new Error('Observer probe queue bound'));return;}
   const nonce=++state.nonce,timer=setTimeout(()=>{state.pending.delete(nonce);reject(new Error('Observer clock/control response deadline'));},3000);
   state.pending.set(nonce,{resolve,reject,timer});state.worker.postMessage({type:'__rpAgeCommand',operation,nonce});
  });
 },{limit,streaming:provenance.streaming===true});
 return provenance;
}

async function workerRequest(page,operation){return page.evaluate(operation=>window.__rpAge.request(operation),operation);}
function best(samples){assert.ok(samples.length);return samples.reduce((a,b)=>a.roundTripMs<=b.roundTripMs?a:b);}
export async function calibrateFrameAge(source,page,{samples=12,nativeProbe,sharedLinuxClock=false}={}){
 assert.ok(Number.isSafeInteger(samples)&&samples>=2&&samples<=32);
 const native=[],worker=[];
 // A remote callback returns the real Source reply and its actual scope witness.
 // The caller's performance interval includes the complete file/RPC transport;
 // neither the remote host clock nor a fabricated capture binding is reused.
 assert.ok(nativeProbe===undefined||typeof nativeProbe==='function');
 if(nativeProbe)assert.equal(source,null,'Use an explicit remote probe, not a Source-shaped facade');
 if(sharedLinuxClock)assert.ok(nativeProbe,'Linux shared clock requires an explicit verified native probe');
 const probe=nativeProbe??(async()=>({reply:await source.capture.command('scheduler',source.capture.binding.config.id),pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion}));
 for(let i=0;i<samples;i++){
  const before=performance.now(),witness=await probe(),after=performance.now(),r=witness.reply;
  assert.ok(Number.isSafeInteger(witness.pageEpoch)&&witness.pageEpoch>0&&Number.isSafeInteger(witness.viewportVersion)&&witness.viewportVersion>0);
  if(native.length&&!sharedLinuxClock){assert.equal(witness.pageEpoch,native[0].pageEpoch);assert.equal(witness.viewportVersion,native[0].viewportVersion);}
  assert.equal(r.clock,nativeClock);assert.ok(Number.isSafeInteger(r.nowMicros)&&r.nowMicros>0);assert.ok(Number.isInteger(r.rendererProcessId)&&r.rendererProcessId>0);
  native.push({nativeMicros:r.nowMicros,pageEpoch:witness.pageEpoch,viewportVersion:witness.viewportVersion,...(witness.provenance?{provenance:witness.provenance}:{}),before,after,roundTripMs:after-before,domainMs:r.nowMicros/1000,pid:r.rendererProcessId,clock:r.clock,quantizationMs:nativeStampAllowanceMs,lower:before-r.nowMicros/1000-nativeStampAllowanceMs,upper:after-r.nowMicros/1000+nativeStampAllowanceMs});
 }
 if(sharedLinuxClock){const domains=native.map(s=>{const p=s.provenance?.linuxMonotonic;assert.equal(p?.schema,'linux-native-monotonic-probe-v1');assert.match(p.domainId,/^[a-f0-9]{64}$/);assert.equal(p.rendererIdentity.pid,s.pid);assert.equal(p.interval.nativeMicros,s.nativeMicros);verifyLinuxClockInterval({clock:s.clock,nowMicros:s.nativeMicros},BigInt(p.interval.beforeNs),BigInt(p.interval.afterNs));return p.domainId;});assert.equal(new Set(domains).size,1);}else assert.ok(native.every(s=>s.pid===native[0].pid));
 for(let i=0;i<samples;i++){
  const before=performance.now(),r=await workerRequest(page,'clock'),after=performance.now();assert.equal(r.clock,workerClock);assert.ok(Number.isFinite(r.now)&&r.now>=0);
  worker.push({before,after,roundTripMs:after-before,domainMs:r.now,clock:r.clock,quantizationMs:workerStampAllowanceMs,lower:before-r.now-workerStampAllowanceMs,upper:after-r.now+workerStampAllowanceMs});
 }
 return {native:{samples:native,best:best(native)},worker:{samples:worker,best:best(worker)},pageEpoch:sharedLinuxClock?null:native[0].pageEpoch,viewportVersion:sharedLinuxClock?null:native[0].viewportVersion};
}

export async function beginFrameAge(source,page,options){
 const before=await calibrateFrameAge(source,page,options);
 // This precedes any network impairment. Let pre-calibration in-flight
 // frames finish so every measured capture is inside the calibration bracket.
 await page.waitForTimeout(100);
 const enabled=await workerRequest(page,'enable');return {before,enabled};
}

// Offsets are bounded by request/response times without assuming symmetric
// delay. Between two probes we assume affine clock drift, explicitly reported.
export function interpolateClock(before,after,domainMs){
 for(const s of [before,after])assert.ok(Number.isFinite(s.domainMs)&&Number.isFinite(s.lower)&&Number.isFinite(s.upper)&&s.lower<=s.upper,'Invalid clock interval');
 assert.ok(after.domainMs>before.domainMs,'Clock calibration did not advance');
 assert.ok(Number.isFinite(domainMs)&&domainMs>=before.domainMs&&domainMs<=after.domainMs,'Frame timestamp outside clock calibration bracket');
 const fraction=(domainMs-before.domainMs)/(after.domainMs-before.domainMs);
 return {fraction,lower:before.lower*(1-fraction)+after.lower*fraction,upper:before.upper*(1-fraction)+after.upper*fraction};
}
export function calibratedFrameAge(sample,before,after){
 assert.equal(before.native.best.pid,after.native.best.pid,'Producer renderer changed inside measurement window');
 assert.equal(sample.producer.split(':')[0],String(before.native.best.pid),'Frame producer is outside calibrated renderer');
 return frameAgeIntervals(sample,before,after);
}
export function calibratedLinuxSharedFrameAge(sample,before,after,producerProof){
 const a=before.native.best.provenance?.linuxMonotonic,b=after.native.best.provenance?.linuxMonotonic;
 for(const p of [a,b,producerProof]){assert.equal(p?.schema,'linux-native-monotonic-probe-v1');assert.match(p.domainId,/^[a-f0-9]{64}$/);}
 assert.equal(a.domainId,b.domainId);assert.equal(a.domainId,producerProof.domainId);assert.equal(sample.producer.split(':')[0],String(producerProof.rendererIdentity.pid),'Unknown or unverified Source renderer');
 return frameAgeIntervals(sample,before,after);
}
function frameAgeIntervals(sample,before,after){
 assert.equal(sample.captureClock,nativeClock);assert.equal(sample.workerClock,workerClock);
 assert.ok(Number.isSafeInteger(sample.captureStartedMicros)&&sample.captureStartedMicros>0);
 const c=sample.captureStartedMicros/1000,v=sample.observedMs,producer=interpolateClock(before.native.best,after.native.best,c),viewer=interpolateClock(before.worker.best,after.worker.best,v);
 const endpointAllowanceMs=Math.max(before.native.best.quantizationMs??0,after.native.best.quantizationMs??0)+Math.max(before.worker.best.quantizationMs??0,after.worker.best.quantizationMs??0);
 assert.ok(Number.isFinite(endpointAllowanceMs)&&endpointAllowanceMs>=0);
 const lowerMs=v+viewer.lower-c-producer.upper-endpointAllowanceMs,upperMs=v+viewer.upper-c-producer.lower+endpointAllowanceMs;
 assert.ok(upperMs>=0,'Even the calibration upper bound gives impossible negative frame age');
 return {estimateMs:(lowerMs+upperMs)/2,lowerMs,upperMs,uncertaintyMs:(upperMs-lowerMs)/2,endpointAllowanceMs,producerOffset:producer,workerOffset:viewer};
}
function distribution(values){assert.ok(values.length&&values.every(Number.isFinite));const sorted=values.slice().sort((a,b)=>a-b),p=n=>sorted[Math.ceil(n*sorted.length)-1];return {count:values.length,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99),maxMs:sorted.at(-1),minMs:sorted[0]};}
export {distribution as frameAgeDistribution};
function drift(a,b){const duration=b.domainMs-a.domainMs;assert.ok(duration>0);return {domainDurationMs:duration,midpointOffsetChangeMs:(b.lower+b.upper-a.lower-a.upper)/2,estimatedPpm:(b.lower+b.upper-a.lower-a.upper)/2/duration*1e6,lowerPpm:(b.lower-a.upper)/duration*1e6,upperPpm:(b.upper-a.lower)/duration*1e6};}
export async function finishFrameAge(source,page,window,provenance,options){
 const disabled=await workerRequest(page,'disable'),after=await calibrateFrameAge(source,page,options);
 const raw=await page.evaluate(()=>{const s=window.__rpAge;return {samples:s.samples,errors:s.errors,paired:s.paired,start:s.start,end:s.end,workerCount:s.workerCount,pending:s.pending.size,protocolEvents:s.protocolEvents,socketStarts:s.socketStarts,socketCloses:s.socketCloses};});
 assert.deepEqual(raw.errors,[]);assert.equal(raw.workerCount,1);assert.equal(raw.pending,0);assert.ok(raw.samples.length>0&&raw.samples.length<=limit);
 const expected=disabled.all-window.enabled.all;
 assert.equal(raw.samples.length,expected);assert.equal(raw.paired,expected);assert.equal(disabled.observed,expected);assert.equal(raw.end.productionFrames-raw.start.productionFrames,expected);
 assert.equal(window.before.pageEpoch,after.pageEpoch);assert.equal(window.before.viewportVersion,after.viewportVersion);
 assert.equal(provenance.served.length,1);assert.equal(provenance.actualServed.length,1);assert.equal(provenance.actualServed[0].status,200);assert.equal(provenance.actualServed[0].sha256,provenance.served[0].instrumentedServedSha256);
 assert.ok(raw.protocolEvents.length>=disabled.protocolOrdinal,'All typed Worker protocol events through disable reply must arrive');
 const protocolEvents=raw.protocolEvents.filter(e=>e.enabled&&e.window===window.enabled.window);
 assert.equal(protocolEvents.length,disabled.protocolOrdinal-window.enabled.protocolOrdinal,'Protocol event window coverage');
 const counts={recoverAttempts:0,keyframeRequestDecisions:0,keyframeRequests:0,missingDeltaBase:0,commitResourcesUnavailable:0,commitsSkippedDuringRecovery:0,diagnosticFaults:0};
 for(const e of protocolEvents){
  assert.ok(Number.isFinite(e.workerMs)&&Number.isSafeInteger(e.connectionGeneration)&&e.connectionGeneration>0);
  if(e.kind==='recover'){counts.recoverAttempts++;assert.equal(typeof e.willRequestKeyframe,'boolean');if(e.willRequestKeyframe)counts.keyframeRequestDecisions++;if(e.cause==='missing-delta-base')counts.missingDeltaBase++;else{assert.equal(e.cause,'commit-resources-unavailable');counts.commitResourcesUnavailable++;}}
  else if(e.kind==='keyframe-requested')counts.keyframeRequests++;
  else if(e.kind==='commit-skipped'){assert.equal(e.cause,'awaiting-recovery-scene');counts.commitsSkippedDuringRecovery++;}
  else{assert.equal(e.kind,'fault');assert.equal(provenance.diagnosticFaults,true);counts.diagnosticFaults++;}
 }
 const protocol={scope:'Actual Worker recovery attempts,actualWebSocketqueuedkeyframerequestsandcommitsignoredwhileawaitingrecovery;differentunitsfromGatewaycoalescing/nativeoutcomes/kernelpacketdrops. Windoweventcoverageisexact;socketstart/closearraysareWorker-lifetimewitnesses. Explicitdiagnosticfaultslabelled,defaultobserverhasnofaultarmsorpayloadmutation.',counts,events:protocolEvents,socketStarts:raw.socketStarts,socketCloses:raw.socketCloses};
 const keys=new Set(),samples=raw.samples.map((s,i)=>{
  assert.equal(s.window,window.enabled.window);assert.equal(s.windowOrdinal,i+1);assert.equal(s.commitOrdinal,window.enabled.all+i+1);assert.equal(s.productionFramePaired,true);
  assert.equal(s.pageEpoch,after.pageEpoch);assert.equal(s.viewportVersion,after.viewportVersion);assert.ok(s.pixels.length===provenance.points.length&&s.pixels.every(p=>p.length===4));
  assert.ok([s.requiredResourceCount,s.requiredResourceBytes,s.largestRequiredResourceBytes].every(n=>Number.isSafeInteger(n)&&n>=0));
  assert.ok(s.requiredResourceCount<=256&&s.requiredResourceBytes>=s.largestRequiredResourceBytes);
  assert.equal(s.requiredResourceCount===0,s.requiredResourceBytes===0);assert.equal(s.requiredResourceBytes===0,s.largestRequiredResourceBytes===0);
  assert.ok(Number.isFinite(s.pixelReadMs)&&s.pixelReadMs>=0);const key=[s.connectionGeneration,s.pageEpoch,s.viewportVersion,s.frameId].join(':');assert.equal(keys.has(key),false);keys.add(key);
  return {...s,age:calibratedFrameAge(s,window.before,after)};
 });
 return {scope:'Each successful actual CPU2D Worker commit at the enabled pixel-read point,paired with its normal production frame event and native Take identity. Capture-start to synchronous actual OffscreenCanvas pixel read,not physical display scanout. Test-only instrumented module/observer cost explicitly reported;all successful commits at that point covered. Recoveryeventsaretypedpassiveobservations;faultinjectiononlyexistswhenseparatelyenabledanddeclaredinprovenance. Clock offsets use min-RTT request/response intervals and affine drift between before/after probes;this assumption does not prove arbitrary intervening nonlinear drift.',provenance,protocol,coverage:{successfulCommits:expected,pixelSamples:samples.length,normalFrameEvents:raw.end.productionFrames-raw.start.productionFrames,paired:samples.length,fraction:1,missing:0},age:distribution(samples.map(s=>s.age.estimateMs)),ageLower:distribution(samples.map(s=>s.age.lowerMs)),ageUpper:distribution(samples.map(s=>s.age.upperMs)),clockUncertainty:distribution(samples.map(s=>s.age.uncertaintyMs)),pixelObserverCost:distribution(samples.map(s=>s.pixelReadMs)),pixelObserverCostTimerAllowanceMs:2*workerStampAllowanceMs,observedDrift:{native:drift(window.before.native.best,after.native.best),worker:drift(window.before.worker.best,after.worker.best)},calibration:{before:window.before,after,enabled:window.enabled,disabled},samples};
}

// Node observations carry their own clock boundary. PeerStats is asynchronous;
// these witnesses cannot be treated as one atomic end-to-end frame-loss ledger.
export function observeFrameLoss(source,peers=new Set()){
 const rejections=[];
 const event=e=>{
  if(e.event!=='NativeFrameRejected')return;
  assert.ok(rejections.length<256,'Native rejection observation bound');
  const match=/^(.*):(\d+)$/.exec(e.captureId??'');assert.ok(match,'Native rejection identity');
  const captureOrdinal=Number(match[2]);assert.ok(Number.isSafeInteger(captureOrdinal)&&captureOrdinal>0);assert.ok(['retry','pause'].includes(e.outcome));
  assert.ok(typeof e.reason==='string'&&e.reason.length<=512&&typeof e.code==='string'&&e.code.length<=128);
  rejections.push({atNodeMs:performance.now(),captureId:e.captureId,captureOrdinal,code:e.code,outcome:e.outcome,reason:e.reason,matchedActiveScope:e.captureId.startsWith((source.capture.binding?.config.id??'unbound')+':')});
 };
 source.broker.on('event',event);
 return {rejections,snapshot(){return {atNodeMs:performance.now(),source:structuredClone(source.stats),rejectionCount:rejections.length,peers:[...peers].map(p=>({id:p.id,kind:p.kind,closed:p.closed,stats:structuredClone(p.stats)}))};},close(){source.broker.off('event',event);}};
}
export async function armFrameAgeFault(page,kind){
 assert.ok(['delta-base','missing-resource'].includes(kind));return workerRequest(page,'fault:'+kind);
}
