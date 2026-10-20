import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {NativeCapture} from '../capture/live.mjs';

const flush=()=>new Promise(setImmediate),superseded=()=>Object.assign(new Error('Captured compositor frame superseded before aggregation'),{code:'VIZ_CAPTURE_SUPERSEDED'});
function fixture(options={}){
 const scenes=new Map(),calls=[],canceled=[];
 const capture=new NativeCapture(null,{token:'fixture-token',maxCaptureAttempts:options.maxCaptureAttempts??3,viz:{waitFor(id){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});scenes.set(id,{resolve,reject});return promise;},cancel(id){canceled.push(id);}}});
 capture.world=1;capture.cdp={async send(method,params){assert.equal(method,'Runtime.evaluate');const value=await vm.runInNewContext(params.expression,{chrome:{gpuBenchmarking:{captureRemotePaint(token,id,resolve,forceResources){assert.equal(token,'fixture-token');calls.push({id,resolve,forceResources});return true;}}}});return {result:{value}};},detach:async()=>{}};
 const complete=index=>{const call=calls[index];call.resolve({captureId:call.id,resources:[],producer:'fixture:1',frameToken:index+1,sourceFrame:index});};
 return {capture,scenes,calls,canceled,complete};
}

test('supersession drains the original CDP callback then retries with a fresh ID and complete resources',async()=>{
 const f=fixture(),pending=f.capture.capture();await flush();assert.equal(f.calls.length,1);
 f.scenes.get(f.calls[0].id).reject(superseded());await flush();assert.equal(f.calls.length,1,'Second registration overlapped the old callback');
 f.complete(0);await flush();assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].id,f.calls[1].id);assert.equal(f.calls[1].forceResources,true);
 f.scenes.get(f.calls[1].id).resolve({captureId:f.calls[1].id,native:true});f.complete(1);
 const result=await pending;assert.equal(result.captureId,f.calls[1].id);assert.equal(result.viz.captureId,result.captureId);assert.equal(result.timing.supersededAttempts,1);assert.equal(f.capture.count,1);assert.equal(f.capture.supersededCaptures,1);assert.deepEqual(f.canceled,[f.calls[0].id]);await f.capture.close();
});

test('repeated supersession has a finite attempt budget and never creates a committed capture',async()=>{
 const f=fixture({maxCaptureAttempts:2}),pending=f.capture.capture();pending.catch(()=>{});
 for(let n=0;n<2;n++){await flush();assert.equal(f.calls.length,n+1);f.complete(n);f.scenes.get(f.calls[n].id).reject(superseded());}
 await assert.rejects(pending,{code:'VIZ_SUPERSESSION_LIMIT'});assert.equal(f.calls.length,2);assert.equal(f.capture.count,0);assert.equal(f.canceled.length,2);await f.capture.close();
});

test('resource and input pressure drain their native callback before surfacing backpressure without a hidden retry',async()=>{
 for(const code of ['RESOURCE_BUDGET_PRESSURE','INPUT_BUDGET_PRESSURE']){
  const f=fixture(),pending=f.capture.capture();let settled=false;pending.finally(()=>settled=true).catch(()=>{});await flush();f.scenes.get(f.calls[0].id).reject(Object.assign(new Error('Pool pressure'),{code}));await flush();assert.equal(settled,false);
  f.complete(0);await assert.rejects(pending,{code});assert.equal(f.calls.length,1);assert.equal(f.capture.count,0);assert.equal(f.capture.supersededCaptures,0);await f.capture.close();
 }
});

test('transport and native encoding failures cannot be hidden by supersession retry',async()=>{
 for(const nativeFailure of [false,true]){
  const f=fixture(),pending=f.capture.capture();pending.catch(()=>{});await flush();const call=f.calls[0];
  if(nativeFailure){f.scenes.get(call.id).reject(superseded());call.resolve({error:'Fixture encoding failed'});await assert.rejects(pending,/Fixture encoding failed/);}
  else{f.scenes.get(call.id).reject(Object.assign(new Error('Writer overloaded'),{code:'VIZ_OUTPUT_OVERLOAD'}));await assert.rejects(pending,{code:'VIZ_OUTPUT_OVERLOAD'});f.complete(0);}
  assert.equal(f.calls.length,1);assert.equal(f.capture.supersededCaptures,0);await f.capture.close();
 }
});

test('navigation during a superseded callback cannot retry an old context',async()=>{
 const f=fixture(),pending=f.capture.capture();pending.catch(()=>{});await flush();f.scenes.get(f.calls[0].id).reject(superseded());await flush();f.capture.generation++;f.complete(0);
 await assert.rejects(pending,/Navigation invalidated/);assert.equal(f.calls.length,1);assert.equal(f.capture.count,0);await f.capture.close();
});

test('destroyed native hosts retain their typed failure and cannot trigger supersession retries',async()=>{
 const f=fixture(),pending=f.capture.capture();pending.catch(()=>{});await flush();
 f.calls[0].resolve({error:'Capture host was destroyed',code:'NATIVE_CAPTURE_HOST_CLOSED'});
 await assert.rejects(pending,{code:'NATIVE_CAPTURE_HOST_CLOSED'});
 assert.equal(f.calls.length,1);assert.equal(f.capture.count,0);assert.equal(f.capture.supersededCaptures,0);
 await f.capture.close();
});

test('native Canvas pressure keeps its typed rejection without retrying or trusting arbitrary native codes',async()=>{
 for(const code of ['RESOURCE_BUDGET_PRESSURE','VIZ_CAPTURE_SUPERSEDED','UNTRUSTED_NATIVE_CODE']){
  const f=fixture(),pending=f.capture.capture();pending.catch(()=>{});await flush();
  f.calls[0].resolve({error:'Canvas allocation rejected',code});
  await assert.rejects(pending,error=>error.message==='Canvas allocation rejected'&&error.code===(code==='RESOURCE_BUDGET_PRESSURE'?code:undefined));
  assert.equal(f.calls.length,1);assert.equal(f.capture.count,0);assert.equal(f.capture.supersededCaptures,0);await f.capture.close();
 }
});

test('detaching display demand drains a superseded request without a new registration or capture error',async()=>{
 const f=fixture(),errors=[];f.capture.on('captureError',error=>errors.push(error));f.capture.setDemand(1);await flush();f.capture.setDemand(0);const drained=f.capture.drain();f.scenes.get(f.calls[0].id).reject(superseded());await flush();f.complete(0);await drained;
 assert.equal(f.calls.length,1);assert.equal(f.capture.running,false);assert.equal(f.capture.count,0);assert.deepEqual(errors,[]);await f.capture.close();
});

test('the total capture deadline also bounds isolated world setup before any registration',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let registrations=0;
 const capture=new NativeCapture(null,{viz:{waitFor(){registrations++;throw new Error('Unexpected registration');}}});capture.cdp={send:()=>new Promise(()=>{}),detach:async()=>{}};
 const pending=capture.capture();t.mock.timers.tick(6000);await assert.rejects(pending,{code:'NATIVE_CAPTURE_TIMEOUT'});assert.equal(registrations,0);await capture.close();
});
