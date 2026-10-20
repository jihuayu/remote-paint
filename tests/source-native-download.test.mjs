import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID,createHash} from 'node:crypto';
import {observationFixture,sessionId,version} from './fixtures/agent-observation-fixture.mjs';
import {createManagedAgentRun} from '../live/managed-agent-run.mjs';
import {createSourceNativeDownloadRoot,createSourceNativeAgentDownloadOwner} from '../live/source-download-native.mjs';
import {closeLiveSourceParts,startLiveSource} from '../live/source.mjs';
import {startLive} from '../live.mjs';
import {nativeLaunchArgs} from '../native/launch.mjs';
const error=code=>e=>e.code===code;
const turn=()=>new Promise(setImmediate);
const gate=()=>{let resolve,reject;return {promise:new Promise((a,b)=>{resolve=a;reject=b;}),resolve,reject};};
async function until(fn){for(let n=0;n<1000;n++){if(fn())return;await new Promise(r=>setTimeout(r,2));}assert.fail('fixture deadline');}
function fixture(t,{unbound=false,failedClose=false}={}){
 const gates=[];t.after(()=>gates.forEach(g=>g.resolve()));
 const h=observationFixture(t,{closeErrorCode:failedClose?'AGENT_OBSERVATION_FAILED':null}),page=h.source.page,events=new EventEmitter();page.on=events.on.bind(events);page.off=events.off.bind(events);
 const capture=h.source.capture,root=createSourceNativeDownloadRoot(page),f={h,page,capture,events,root,handler:null,phase:'pending',ready:true,ticket:'dl_'+randomUUID(),bytes:Buffer.from([0,255,128,1,2,3])};
 if(!unbound)root.bindCapture(capture);
 const envelope=(fields={})=>({descriptorVersion:1,currentDocumentToken:'native-document',...fields});f.envelope=envelope;
 h.handler=async(method,p)=>{
  if(f.handler){const r=await f.handler(method,p);if(r!==undefined)return r;}
  if(method==='Runtime.callFunctionOn'&&p.functionDeclaration.includes('screenshotMetadata'))return {result:{value:{ok:true,url:'https://fixture.test/',title:'Native',truncated:false}}};
  if(method==='Page.getRemotePaintDownloadBridge')return envelope({transfersReady:f.ready,maxItems:4,maxFileBytes:4194304});
  if(method==='Page.armRemotePaintDownload')return envelope({ticket:f.ticket});
  if(method==='Page.getRemotePaintDownloadInfo')return envelope({ticket:f.ticket,phase:f.phase,error:'',byteLength:f.phase==='ready'?f.bytes.length:0,sha256:f.phase==='ready'?createHash('sha256').update(f.bytes).digest('hex'):'',suggestedFilename:'report.bin'});
  if(method==='Page.readRemotePaintDownload'){const next=Math.min(f.bytes.length,p.offset+p.maxBytes);return envelope({ticket:f.ticket,offset:p.offset,nextOffset:next,eof:next===f.bytes.length,data:f.bytes.subarray(p.offset,next).toString('base64')});}
  if(method==='Page.releaseRemotePaintDownload')return envelope({ticket:f.ticket,released:true});
 };
 f.context=()=>h.run.observationContext();f.arm=(limits={})=>h.run.armDownload(f.context(),limits);f.info=ctx=>h.run.downloadInfo(f.ticket,ctx??f.context());f.read=ctx=>h.run.readDownload(f.ticket,0,ctx??f.context());f.gate=()=>{const g=gate();gates.push(g);return g;};
 f.selection=()=>({page,capture,transport:capture.cdp,binding:{tenantId:'tenant',sessionId,targetId:'target_'+randomUUID(),runId:'run_'+randomUUID()},version,closeObserver:async()=>{}});
 t.after(async()=>{if(failedClose)await assert.rejects(root.close());else await root.close();assert.equal(events.listenerCount('download'),0);});return f;
}

test('Source Native mode is explicit boolean opt-in and Agent limits cannot select it',async t=>{
 const flag='--remote-paint-download-budget-v1';assert.equal(nativeLaunchArgs('c'.repeat(64)).includes(flag),false);assert.equal(nativeLaunchArgs('c'.repeat(64),{nativeDownloadBudget:true}).filter(x=>x===flag).length,1);
 for(const v of [null,1,'true',{},[]]){assert.throws(()=>nativeLaunchArgs('c'.repeat(64),{nativeDownloadBudget:v}),TypeError);await assert.rejects(startLiveSource({nativeDownloadBudget:v}),TypeError);await assert.rejects(startLive({nativeDownloadBudget:v}),TypeError);}
 const f=fixture(t);await assert.rejects(f.arm({nativeDownloadBudget:true}),error('INVALID_AGENT_OBSERVATION'));assert.equal(f.h.calls.filter(c=>c.method==='Page.armRemotePaintDownload').length,0);
});
test('an unregistered original Page selects legacy while a pending Native root cannot fall back',async t=>{
 const f=fixture(t,{unbound:true});assert.equal(createSourceNativeAgentDownloadOwner({page:{}}),null);assert.throws(()=>f.context(),error('AGENT_OBSERVATION_UNAVAILABLE'));assert.equal(f.events.listenerCount('download'),0);assert.equal(f.h.calls.length,0);f.root.bindCapture(f.capture);await f.arm();assert.equal(f.h.calls.filter(c=>c.method==='Page.armRemotePaintDownload').length,1);
});
test('Source Native root binds only once to its original Page and cannot be replaced',async t=>{
 const f=fixture(t,{unbound:true});assert.throws(()=>f.root.bindCapture({...f.capture,page:{}}),error('AGENT_OBSERVATION_UNAVAILABLE'));assert.equal(f.root.status().bound,false);f.root.bindCapture(f.capture);assert.throws(()=>f.root.bindCapture(f.capture),error('AGENT_OBSERVATION_UNAVAILABLE'));assert.throws(()=>createSourceNativeDownloadRoot(f.page),error('AGENT_OBSERVATION_UNAVAILABLE'));
});
test('the real managed observer uses only original capture CDP Native commands and existing SDK receipts',async t=>{
 const f=fixture(t),ctx=f.context(),a=await f.h.run.armDownload(ctx);assert.equal(a.downloadId,f.ticket);assert.equal((await f.info(ctx)).stage,'download-pending');f.phase='ready';const info=await f.info(ctx),chunk=await f.read(ctx);assert.equal(info.byteLength,f.bytes.length);assert.deepEqual(Buffer.from(chunk.data,'base64'),f.bytes);assert.equal(chunk.complete,true);assert.equal(f.events.listenerCount('download'),0);assert.equal(f.root.status().owners,1);
 const native=f.h.calls.filter(c=>c.method.startsWith('Page.'));assert.ok(native.length>=5);for(const c of native){assert.equal(c.params.token,f.capture.token);assert.equal(c.params.documentToken,'native-document');}assert.ok(f.h.calls.findIndex(c=>c.method==='Runtime.evaluate')<f.h.calls.findIndex(c=>c.method==='Page.armRemotePaintDownload'));
 await f.h.run.releaseDownload(f.ticket,ctx);await f.h.run.close();assert.equal(f.root.status().owners,0);
});
test('Native readiness false or missing command stays unavailable without a legacy download listener',async t=>{
 for(const mode of ['not-ready','missing']){const f=fixture(t);f.ready=false;if(mode==='missing')f.handler=method=>{if(method==='Page.armRemotePaintDownload')throw Error('unknown');if(method==='Page.getRemotePaintDownloadBridge')throw Error('method unavailable');};await assert.rejects(f.arm());assert.equal(f.h.calls.filter(c=>c.method==='Page.armRemotePaintDownload').length,0);assert.equal(f.events.listenerCount('download'),0);
  // A failed discovery dispatch cannot have created a ticket. It is safe to
  // close this observer even when the descriptor itself was unavailable.
  if(mode==='missing'){f.handler=null;f.h.readAllowed=true;}
 }
});
test('Native selection rejects replaced capture CDP method or token before any observation dispatch',async t=>{
 for(const mode of ['capture','transport','method','token']){const f=fixture(t);if(mode==='capture')f.h.source.capture={...f.capture};if(mode==='transport')f.capture.cdp={send:async()=>({})};if(mode==='method')f.capture.cdp.send=async()=>({});if(mode==='token')f.capture.token='d'.repeat(64);assert.throws(()=>f.context(),error('AGENT_OBSERVATION_UNAVAILABLE'));assert.equal(f.h.calls.length,0);assert.equal(f.events.listenerCount('download'),0);}
});
test('late Native arm after real observer document change cleans the original slot without adopting the new document',async t=>{
 const f=fixture(t),hold=f.gate(),ctx=f.context();f.handler=async method=>{if(method==='Page.armRemotePaintDownload')await hold.promise;};const arm=assert.rejects(f.h.run.armDownload(ctx),error('STALE_AGENT_PAGE'));await until(()=>f.h.calls.some(c=>c.method==='Page.armRemotePaintDownload'));f.capture.documentToken='new-document';f.capture.binding.config.documentToken='new-document';f.h.source.pageEpoch=2;hold.resolve();await arm;await until(()=>f.h.calls.some(c=>c.method==='Page.releaseRemotePaintDownload'));const cleanup=f.h.calls.find(c=>c.method==='Page.releaseRemotePaintDownload').params;assert.equal(cleanup.documentToken,'native-document');assert.equal(cleanup.ticket,f.ticket);await f.h.run.close();assert.equal(f.root.status().owners,0);
});
test('Run end retires Native independently of actual read and holds Source ownership through group cleanup',async t=>{
 const f=fixture(t),ctx=f.context();await f.arm();f.phase='ready';await f.info(ctx);const read=f.gate(),group=f.gate();f.handler=async method=>{if(method==='Page.readRemotePaintDownload')await read.promise;if(method==='Runtime.releaseObjectGroup')await group.promise;};const pending=assert.rejects(f.read(ctx),error('AGENT_RUN_CLOSED'));await until(()=>f.h.calls.some(c=>c.method==='Page.readRemotePaintDownload'));let ended=false;const end=f.h.run.close().then(()=>ended=true);await until(()=>f.h.calls.some(c=>c.method==='Page.releaseRemotePaintDownload'));assert.equal(ended,false);assert.equal(f.root.status().owners,1);read.resolve();await pending;await until(()=>f.h.calls.some(c=>c.method==='Runtime.releaseObjectGroup'));assert.equal(f.root.status().owners,1);assert.throws(()=>createSourceNativeAgentDownloadOwner(f.selection()),error('AGENT_DOWNLOAD_BUSY'));group.resolve();await end;assert.equal(f.root.status().owners,0);
 const next=createManagedAgentRun(f.h.control,{tenantId:'tenant',sessionId,version,authorize:()=>true});const nextContext=next.observationContext();await next.armDownload(nextContext);await next.close();assert.equal(f.root.status().owners,0);
});
test('normal Source close uses whole observer retirement before capture detach and attempts original owned parts',async t=>{
 const f=fixture(t),ctx=f.context();await f.arm();f.phase='ready';await f.info(ctx);const hold=f.gate(),order=[];f.handler=async method=>{if(method==='Page.readRemotePaintDownload')await hold.promise;if(method==='Page.releaseRemotePaintDownload')order.push('native-release');};const pending=assert.rejects(f.read(ctx),error('AGENT_RUN_CLOSED'));await until(()=>f.h.calls.some(c=>c.method==='Page.readRemotePaintDownload'));
 const close=closeLiveSourceParts({nativeDownloads:f.root,capture:{close:async()=>order.push('capture')},frameDriver:{close:async()=>order.push('frame')},downloads:{closeBrowser:async()=>order.push('browser'),retire:async()=>order.push('spool')},viz:{close:async()=>order.push('viz')},broker:{close:async()=>order.push('broker')}});await until(()=>order.includes('native-release'));assert.deepEqual(order,['native-release']);hold.resolve();await pending;await close;assert.deepEqual(order,['native-release','capture','frame','browser','viz','broker','spool']);assert.equal(f.root.status().owners,0);assert.equal(f.root.status().bound,false);
});
test('crashed Source closes browser first and continues detach-free cleanup after Native retirement fails',async t=>{
 const f=fixture(t,{failedClose:true}),ctx=f.context();await f.arm();f.phase='ready';await f.info(ctx);const hold=f.gate(),order=[];let dead=false;f.handler=async method=>{if(method==='Page.readRemotePaintDownload')await hold.promise;if(method==='Page.releaseRemotePaintDownload'&&dead)throw Error('original transport gone');};const read=assert.rejects(f.read(ctx),error('AGENT_RUN_CLOSED'));await until(()=>f.h.calls.some(c=>c.method==='Page.readRemotePaintDownload'));
 await assert.rejects(closeLiveSourceParts({targetCrashed:true,nativeDownloads:f.root,downloads:{closeBrowser:async()=>{order.push('browser');dead=true;hold.reject(Error('browser exited'));},retire:async()=>order.push('spool')},capture:{close:async options=>{assert.equal(options.detach,false);order.push('capture');}},frameDriver:{close:async options=>{assert.equal(options.detach,false);order.push('frame');}},viz:{close:async()=>order.push('viz')},broker:{close:async()=>order.push('broker')}}),AggregateError);await read;assert.deepEqual(order,['browser','capture','frame','viz','broker','spool']);assert.equal(f.root.status().owners,1);assert.equal(f.root.status().cleanupFailed,true);
});
test('unknown Native arm keeps the Source Run slot after failed end and every Source close part is still attempted',async t=>{
 const f=fixture(t,{failedClose:true});f.handler=method=>{if(method==='Page.armRemotePaintDownload')throw Error('arm dispatch outcome unknown');};await assert.rejects(f.arm());await assert.rejects(f.h.run.close(),error('AGENT_OBSERVATION_FAILED'));assert.equal(f.root.status().owners,1);assert.throws(()=>createSourceNativeAgentDownloadOwner(f.selection()),error('AGENT_DOWNLOAD_BUSY'));const order=[];
 await assert.rejects(closeLiveSourceParts({nativeDownloads:f.root,capture:{close:async()=>{order.push('capture');throw Error('capture failed');}},frameDriver:{close:async()=>order.push('frame')},downloads:{closeBrowser:async()=>order.push('browser'),retire:async()=>order.push('spool')},viz:{close:async()=>order.push('viz')},broker:{close:async()=>order.push('broker')}}),e=>e instanceof AggregateError&&e.errors.length===2);assert.deepEqual(order,['capture','frame','browser','viz','broker','spool']);assert.equal(f.root.status().owners,1);
});
test('Native Source end deadline retains actual pending realm and rejects late admission without clearing its slot',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{failedClose:true}),hold=f.gate(),ctx=f.context();f.handler=async method=>{if(method==='Runtime.evaluate')await hold.promise;};const arm=assert.rejects(f.h.run.armDownload(ctx),error('AGENT_RUN_CLOSED'));await turn();assert.equal(f.h.calls.filter(c=>c.method==='Runtime.evaluate').length,1);const end=assert.rejects(f.h.run.close(),error('AGENT_OBSERVATION_FAILED'));await turn();t.mock.timers.tick(30000);await end;assert.equal(f.root.status().owners,1);assert.equal(f.h.calls.some(c=>c.method==='Page.armRemotePaintDownload'),false);hold.resolve();await arm;await turn();assert.equal(f.root.status().owners,1);
});
test('Native Source end deadline keeps a real pending arm and its late original ticket cannot release the Run slot',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{failedClose:true}),hold=f.gate(),ctx=f.context();f.handler=async method=>{if(method==='Page.armRemotePaintDownload')await hold.promise;};const arm=assert.rejects(f.h.run.armDownload(ctx),error('AGENT_RUN_CLOSED'));for(let i=0;i<10;i++)await turn();assert.equal(f.h.calls.filter(c=>c.method==='Page.armRemotePaintDownload').length,1);const end=assert.rejects(f.h.run.close(),error('AGENT_OBSERVATION_FAILED'));t.mock.timers.tick(30000);await end;assert.equal(f.root.status().owners,1);hold.resolve();await arm;await turn();await turn();assert.equal(f.h.calls.filter(c=>c.method==='Page.releaseRemotePaintDownload').length,1);assert.equal(f.root.status().owners,1);
});
test('Native Source end deadline includes actual object-group cleanup and its late reply never frees ownership',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=fixture(t,{failedClose:true}),hold=f.gate();await f.arm();f.handler=async method=>{if(method==='Runtime.releaseObjectGroup')await hold.promise;};const end=assert.rejects(f.h.run.close(),error('AGENT_OBSERVATION_FAILED'));for(let i=0;i<10;i++)await turn();assert.equal(f.h.calls.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);t.mock.timers.tick(30000);await end;assert.equal(f.root.status().owners,1);hold.resolve();await turn();await turn();assert.equal(f.root.status().owners,1);assert.equal(f.root.status().cleanupFailed,true);
});
test('Native stale mutable CDP method cannot redirect cleanup away from the original bound method',async t=>{
 const f=fixture(t),ctx=f.context();await f.arm();let replacementCalls=0;f.capture.cdp.send=async()=>{replacementCalls++;return {};};await assert.rejects(f.info(ctx),error('AGENT_OBSERVATION_UNAVAILABLE'));await f.h.run.close();assert.equal(replacementCalls,0);assert.equal(f.h.calls.filter(c=>c.method==='Page.releaseRemotePaintDownload').length,1);assert.equal(f.root.status().owners,0);
});
test('Native root close is idempotent and its closed registration never becomes legacy mode',async t=>{
 const f=fixture(t,{unbound:true}),close=f.root.close();assert.equal(f.root.close(),close);await close;assert.equal(f.root.status().bound,false);assert.throws(()=>f.root.bindCapture(f.capture),error('AGENT_OBSERVATION_UNAVAILABLE'));assert.throws(()=>createSourceNativeAgentDownloadOwner(f.selection()),error('AGENT_RUN_CLOSED'));assert.equal(f.events.listenerCount('download'),0);
});
test('legacy Source close retains its original part ordering and crash detach policy with no Native root',async()=>{
 for(const targetCrashed of [false,true]){const order=[];await closeLiveSourceParts({targetCrashed,capture:{close:async options=>{assert.equal(options?.detach,targetCrashed?false:undefined);order.push('capture');}},frameDriver:{close:async()=>order.push('frame')},downloads:{closeBrowser:async()=>order.push('browser'),retire:async()=>order.push('spool')},viz:{close:async()=>order.push('viz')},broker:{close:async()=>order.push('broker')}});assert.deepEqual(order,targetCrashed?['browser','capture','frame','viz','broker','spool']:['capture','frame','browser','viz','broker','spool']);}
});
