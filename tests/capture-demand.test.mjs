import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeCapture} from '../capture/live.mjs';

test('demand gates native encoding, permits only one in-flight capture and drops detached results',async()=>{
  const capture=new NativeCapture(null,{interval:1});
  let resolve,calls=0,delivered=0;
  capture.capture=()=>{calls++;return new Promise(r=>resolve=r);};
  capture.on('capture',()=>delivered++);
  await capture.tick();assert.equal(calls,0);
  capture.setDemand(1);capture.setDemand(3);await capture.tick();assert.equal(calls,1);
  capture.setDemand(0);resolve({resources:[]});
  await new Promise(setImmediate);assert.equal(delivered,0);assert.equal(calls,1);
  capture.setDemand(1);assert.equal(calls,2);
  resolve({resources:[]});await new Promise(setImmediate);assert.equal(delivered,1);
  await capture.close();await capture.tick();assert.equal(calls,2);
});
