import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeCapture} from '../capture/live.mjs';

test('demand gates native encoding, permits only one in-flight capture and drops detached results',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const canceled=[];const capture=new NativeCapture(null,{interval:1,viz:{cancel:id=>canceled.push(id)}});
  let resolve,calls=0,delivered=0;
  capture.capture=()=>{calls++;return new Promise(r=>resolve=r);};
  capture.on('capture',()=>delivered++);
  await capture.tick();assert.equal(calls,0);
  capture.setDemand(1);capture.setDemand(3);await capture.tick();assert.equal(calls,1);
  capture.setDemand(0);resolve({captureId:"abandoned",resources:[]});
  await new Promise(setImmediate);assert.equal(delivered,0);assert.equal(calls,1);assert.deepEqual(canceled,["abandoned"]);
  capture.setDemand(1);assert.equal(calls,2);
  resolve({resources:[]});await new Promise(setImmediate);assert.equal(delivered,1);
  await capture.close();await capture.tick();assert.equal(calls,2);
});

test('frame input watermark samples capture start rather than later encoding completion',async()=>{
 const capture=new NativeCapture(null,{interval:10000});let inputSeq=7,resolve,delivered;
 capture.sampleContext=()=>inputSeq;capture.capture=()=>new Promise(r=>resolve=r);
 capture.on('capture',(_,context)=>delivered=context);capture.setDemand(1);inputSeq=8;resolve({resources:[]});
 await new Promise(setImmediate);assert.equal(delivered,7);await capture.close();
});

test('input bursts bypass the idle interval without overlapping captures or claiming late input',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const capture=new NativeCapture(null,{interval:10000}),delivered=[];
 let calls=0,finish,inputSeq=7;
 capture.sampleContext=()=>inputSeq;capture.capture=()=>{calls++;return new Promise(r=>finish=r);};
 capture.on('capture',(_,seq)=>delivered.push(seq));
 capture.requestCapture();t.mock.timers.tick(0);assert.equal(calls,0);
 capture.setDemand(1);assert.equal(calls,1);
 inputSeq=8;for(let i=0;i<20;i++)capture.requestCapture();
 t.mock.timers.tick(0);assert.equal(calls,1);
 finish({});await new Promise(setImmediate);assert.deepEqual(delivered,[7]);
 t.mock.timers.tick(0);assert.equal(calls,2);
 inputSeq=9;capture.requestCapture();capture.setDemand(0);finish({});await new Promise(setImmediate);
 t.mock.timers.tick(10000);assert.equal(calls,2);assert.deepEqual(delivered,[7]);
 capture.setDemand(1);finish({});await new Promise(setImmediate);
 capture.requestCapture();await capture.close();t.mock.timers.tick(10000);assert.equal(calls,3);
});

test('a lost CDP callback cannot hide Viz failure or permanently block capture',async()=>{
 let rejectScene,canceled=0;
 const capture=new NativeCapture(null,{token:'test',viz:{
  waitFor(){return new Promise((_,reject)=>rejectScene=reject);},cancel(){canceled++;}
 }});
 capture.world=1;capture.cdp={send:()=>new Promise(()=>{}),detach:async()=>{}};
 let failure;const attempt=capture.capture().catch(error=>failure=error);
 await new Promise(setImmediate);rejectScene(new Error('Viz request expired'));
 await new Promise(setImmediate);
 assert.equal(failure?.message,'Viz request expired');assert.equal(canceled,1);
 await attempt;await capture.close();
});

test('a completed Viz frame with a lost CDP callback expires and releases single-flight capture',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let canceled=0;
 const capture=new NativeCapture(null,{token:'test',frameDriver:{requestNow:async()=>{},off(){}},viz:{
  waitFor:()=>Promise.resolve({native:true}),cancel(){canceled++;}
 }});
 capture.world=1;capture.cdp={send:()=>new Promise(()=>{}),detach:async()=>{}};
 let failure;capture.on('captureError',error=>failure=error);
 capture.setDemand(1);await new Promise(setImmediate);assert.equal(capture.running,true);
 t.mock.timers.tick(6000);await new Promise(setImmediate);
 assert.match(failure?.message??'',/Native capture deadline/);assert.equal(capture.running,false);assert.equal(canceled,1);
 await capture.close();
});
