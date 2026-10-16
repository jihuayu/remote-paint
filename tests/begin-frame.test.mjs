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

test('BeginFrame startup can leave the external clock paused until a viewer arrives',async()=>{
 let calls=0,finish;const cdp={send:async(method)=>{
  assert.equal(method,'HeadlessExperimental.beginFrame');calls++;
  if(calls===1)return {hasDamage:false};
  return new Promise(resolve=>finish=resolve);
 },detach:async()=>{}};
 const {startBeginFrames}=await import('../capture/begin-frame.mjs');
 const page={context:()=>({newCDPSession:async()=>cdp})};
 const driver=await startBeginFrames(page,{autoStart:false});
 assert.equal(calls,1,'startup primes one frame for page initialization');
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
 driver.start();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(calls,2);
 finish({hasDamage:true});await driver.stop();assert.equal(driver.stats.issued,driver.stats.acked);await driver.close();
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

test('input-driven capture requests an immediate BeginFrame and retains input arriving during encoding',async()=>{
 const frameDriver=new EventEmitter();let requests=0;frameDriver.requestNow=()=>{requests++;return Promise.resolve();};
 const capture=new NativeCapture(null,{interval:10000,frameDriver});
 frameDriver.on('frame',capture.onFrame);
 let calls=0,finish;capture.capture=()=>{calls++;return new Promise(r=>finish=r);};
 capture.setDemand(1);finish({});await new Promise(setImmediate);
 frameDriver.emit('frame');assert.equal(calls,1,'Idle interval still throttles animation captures');
 for(let i=0;i<20;i++)capture.requestCapture();assert.equal(requests,20,'Input requests the external clock immediately');assert.equal(calls,1,'Input keeps capture serialized');
 frameDriver.emit('frame');assert.equal(calls,2);
 capture.requestCapture();frameDriver.emit('frame');assert.equal(calls,2,'Encoding stays serialized');
 finish({});await new Promise(setImmediate);frameDriver.emit('frame');assert.equal(calls,3);
 capture.setDemand(0);finish({});await new Promise(setImmediate);frameDriver.emit('frame');assert.equal(calls,3);
 await capture.close();
});

test('quiet frames reduce clock frequency and input wakes immediately without overlap',async()=>{
 let damage=false,calls=0,active=0,maxActive=0;
 const driver=new BeginFrameDriver({send:async()=>{calls++;active++;maxActive=Math.max(maxActive,active);await Promise.resolve();active--;return {hasDamage:damage};},detach:async()=>{}},{interval:10,idleInterval:100,quietFrames:2});
 await driver.step();await driver.step();assert.equal(driver.stats.cadence,'idle');
 damage=true;await driver.requestNow();assert.equal(calls,3);assert.equal(driver.stats.cadence,'active');assert.equal(maxActive,1);
 await driver.close();
});
test('undamaged frame ACKs skip encoding while an input still forces a capture',async()=>{
 const frameDriver=new EventEmitter();frameDriver.requestNow=async()=>{};
 const capture=new NativeCapture(null,{interval:0,frameDriver});frameDriver.on('frame',capture.onFrame);
 let calls=0;capture.capture=async()=>{calls++;return {};};capture.setDemand(1);await new Promise(setImmediate);
 for(let i=0;i<20;i++)frameDriver.emit('frame',{hasDamage:false});assert.equal(calls,1);
 capture.requestCapture();frameDriver.emit('frame',{hasDamage:false});await new Promise(setImmediate);assert.equal(calls,2);
 frameDriver.emit('frame',{hasDamage:true});await new Promise(setImmediate);assert.equal(calls,3);
 await capture.close();
});
