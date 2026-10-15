import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {BeginFrameDriver} from '../capture/begin-frame.mjs';
import {NativeCapture} from '../capture/live.mjs';

test('BeginFrame clock coalesces concurrent requests and waits for ACK without screenshot readback',async()=>{
 let calls=0,finish;const cdp={send:async(method,params)=>{
  assert.equal(method,'HeadlessExperimental.beginFrame');assert.equal(params.screenshot,undefined);calls++;
  return new Promise(resolve=>finish=resolve);
 },detach:async()=>{}};
 const driver=new BeginFrameDriver(cdp);const a=driver.step(),b=driver.step();assert.equal(calls,1);
 finish({hasDamage:true});assert.deepEqual(await a,await b);assert.equal(driver.stats.acked,1);
 const c=driver.step();assert.equal(calls,2);finish({hasDamage:false});await c;
 assert.equal(driver.stats.damaged,1);await driver.close();
});

test('BeginFrame missing ACK fails closed instead of issuing overlapping frames',async()=>{
 let calls=0;const driver=new BeginFrameDriver({send:()=>{calls++;return new Promise(()=>{});},detach:async()=>{}},{timeout:15});
 await assert.rejects(driver.step(),/ACK timeout/);await assert.rejects(driver.step(),/ACK timeout/);
 assert.equal(calls,1);assert.equal(driver.stats.errors,1);await driver.close();
});

test('frame-clock capture waits for frame notifications, serializes encoding and stops with demand',async()=>{
 const frameDriver=new EventEmitter(),capture=new NativeCapture(null,{interval:0,frameDriver});
 // initialize() normally attaches this listener after checking the native API.
 frameDriver.on('frame',capture.onFrame);
 let calls=0,resolve;capture.capture=()=>{calls++;return new Promise(r=>resolve=r);};
 capture.setDemand(1);frameDriver.emit('frame');assert.equal(calls,1);
 resolve({resources:[]});await new Promise(setImmediate);assert.equal(capture.timer,undefined);
 frameDriver.emit('frame');assert.equal(calls,2);
 capture.setDemand(0);resolve({resources:[]});await new Promise(setImmediate);
 frameDriver.emit('frame');assert.equal(calls,2);await capture.close();
 assert.equal(frameDriver.listenerCount('frame'),0);
});

test('input-driven capture uses the next BeginFrame and retains input arriving during encoding',async()=>{
 const frameDriver=new EventEmitter(),capture=new NativeCapture(null,{interval:10000,frameDriver});
 frameDriver.on('frame',capture.onFrame);
 let calls=0,finish;capture.capture=()=>{calls++;return new Promise(r=>finish=r);};
 capture.setDemand(1);finish({});await new Promise(setImmediate);
 frameDriver.emit('frame');assert.equal(calls,1,'Idle interval still throttles animation captures');
 for(let i=0;i<20;i++)capture.requestCapture();assert.equal(calls,1,'Input does not bypass the external frame clock');
 frameDriver.emit('frame');assert.equal(calls,2);
 capture.requestCapture();frameDriver.emit('frame');assert.equal(calls,2,'Encoding stays serialized');
 finish({});await new Promise(setImmediate);frameDriver.emit('frame');assert.equal(calls,3);
 capture.setDemand(0);finish({});await new Promise(setImmediate);frameDriver.emit('frame');assert.equal(calls,3);
 await capture.close();
});
