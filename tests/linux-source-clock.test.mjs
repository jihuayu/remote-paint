import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {verifyLinuxClockInterval,linuxSourceClockContext,acquireLinuxSourceClockContext,LINUX_SOURCE_CLOCK_DEADLINE_MS} from './linux-source-clock.mjs';
test('Linux native clock proof uses actual monotonic interval with only integer-stamp allowance',()=>{
 const reply={clock:'chromium-time-ticks-v1',nowMicros:123456789};
 const r=verifyLinuxClockInterval(reply,123456789100n,123456790000n);assert.equal(r.integerStampAllowanceNs,1000);
 for(const args of [[123456790001n,123456790002n],[123456780000n,123456787999n],[20n,10n]])assert.throws(()=>verifyLinuxClockInterval(reply,...args));
 assert.throws(()=>verifyLinuxClockInterval({...reply,clock:'wall'},0n,123456790000n));assert.throws(()=>verifyLinuxClockInterval({...reply,nowMicros:NaN},0n,123456790000n));
});
function readySource(){return {pageEpoch:1,viewportVersion:2,nativeDocumentToken:'document-1',producer:'9:2',transitioning:false,capture:{pageEpoch:1,viewportVersion:2,documentToken:'document-1',revision:3,world:7,transitioning:false,needsDocument:false,binding:{revision:3,world:7,registered:true,config:{id:'binding-1',pageEpoch:1,viewportVersion:2,documentToken:'document-1'}}}};}
test('clock readiness requires one coherent current registered document/viewport/producer and rejects terminal owners',()=>{
 assert.equal(LINUX_SOURCE_CLOCK_DEADLINE_MS,5000);assert.equal(linuxSourceClockContext(readySource()).ready,true);assert.equal(linuxSourceClockContext(null).ready,false);
 for(const change of [s=>s.capture.binding=null,s=>s.producer=null,s=>s.producer='9:invalid',s=>s.producer='2147483648:2',s=>s.transitioning=true,s=>s.capture.transitioning=true,s=>s.capture.needsDocument=true,s=>s.capture.binding.registered=false,s=>s.capture.binding.revision++,s=>s.capture.world++,s=>s.capture.binding.config.pageEpoch++,s=>s.capture.pageEpoch++,s=>s.capture.binding.config.viewportVersion++,s=>s.capture.viewportVersion++,s=>s.capture.binding.config.documentToken='old',s=>s.capture.documentToken='old']){const source=readySource();change(source);assert.equal(linuxSourceClockContext(source).ready,false);}
 for(const change of [s=>s.closed=true,s=>s.targetCrashed=true,s=>s.capture.stopped=true,s=>s.capture.failure=new Error('failed'),s=>s.broker={closed:true},s=>s.broker={exited:true},s=>s.browser={isConnected:()=>false}]){const source=readySource();change(source);const context=linuxSourceClockContext(source);assert.equal(context.ready,false);assert.equal(context.terminal,true);}
});
test('readiness acquisition waits without issuing a scheduler call and retains bounded first/last diagnostics',async()=>{
 let source=readySource();source.capture.binding=null;source.producer=null;let settled=false;
 const pending=acquireLinuxSourceClockContext(()=>source).then(value=>{settled=true;return value;});await delay(20);assert.equal(settled,false);source=readySource();const acquired=await pending;assert.equal(acquired.source,source);assert.equal(acquired.context.ready,true);assert.ok(acquired.acquisition.attempts>=2);assert.equal(acquired.acquisition.initial.bindingId,null);assert.equal(acquired.acquisition.last.bindingId,'binding-1');
 const controller=new AbortController();controller.abort(new Error('original total deadline'));await assert.rejects(acquireLinuxSourceClockContext(()=>null,{signal:controller.signal}),error=>error.clockProbe.stage==='acquiring-context'&&error.clockProbe.acquisition.attempts===0&&error.cause.message==='original total deadline');
 const terminal=readySource();terminal.closed=true;await assert.rejects(acquireLinuxSourceClockContext(()=>terminal),error=>error.clockProbe.acquisition.attempts===1&&error.clockProbe.acquisition.last.terminal===true);
 const unavailable=readySource();unavailable.capture.binding=null;await assert.rejects(acquireLinuxSourceClockContext(()=>unavailable,{signal:AbortSignal.timeout(20)}),error=>error.clockProbe.acquisition.attempts>=1&&error.clockProbe.acquisition.last.bindingId===null&&error.cause.name==='AbortError');
});
