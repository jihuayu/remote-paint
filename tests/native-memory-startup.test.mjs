import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeMemoryStartupTrace,NATIVE_STARTUP_LIMITS} from './native-memory-startup.mjs';
test('startup telemetry is bounded,detached,explicitly truncated and cannot accept a helper or copy credential fields',()=>{
 const t=new NativeMemoryStartupTrace();t.output(Buffer.alloc(0));t.event('unknown',{url:'https://private/#key=secret'});t.output(Buffer.from('RP'));t.output(Buffer.alloc(100000,1));for(let n=0;n<100;n++)t.event('spawn-event',{pid:10,url:'secret'});
 const v=t.snapshot({readyDone:false,provenance:{executable:'https://private/#key=secret',binarySha256:'x',ownerKey:'secret'},error:{code:'NATIVE_MEMORY_READY_TIMEOUT',owner:{pid:10,exited:false,token:'secret'}}});assert.equal(v.ready,false);assert.equal(v.captureStatus,'event-limit');assert.equal(v.events.length,NATIVE_STARTUP_LIMITS.events);assert.equal(v.stdoutPrefixHex.length,64);assert.equal(v.stdoutBytes,100002);assert.equal(v.firstStdoutMs,v.events[0].elapsedMs);assert.equal(v.provenance.executable,null);assert.equal(v.failure.owner.exited,false);assert.equal(v.closeObserved,false);assert.ok(Buffer.byteLength(JSON.stringify(v))<=8192);assert.ok(!JSON.stringify(v).includes('secret'));assert.ok(Object.isFrozen(v)&&Object.isFrozen(v.events)&&Object.isFrozen(v.events[0]));
});
test('startup observation window freezes at settlement while later close remains a separate actual event',async()=>{
 const t=new NativeMemoryStartupTrace();t.event('handshake',{pid:12});t.settle();const a=t.snapshot({readyDone:true});await delay(10);t.event('helper-close',{code:0,signal:null});const b=t.snapshot({helperPid:12,readyDone:true,childCreated:true,exit:{code:0,signal:null}});assert.equal(a.elapsedMs,b.elapsedMs);assert.deepEqual(a.eventLoop,b.eventLoop);assert.equal(a.closeObserved,false);assert.equal(b.closeObserved,true);assert.deepEqual(b.observedExit,{pid:12,exited:true,exitCode:0,signal:null});assert.equal(a.observedExit,null);
});
