import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {withOwnedTestChild} from './owned-test-child.mjs';

test('owned IPC fixture is reaped even when asynchronous sampler setup rejects before entering its measurement scope',async()=>{
 for(const setupFails of [true,false]){
  const events=[],child=new EventEmitter(),failure=new Error('sampler setup failed');child.exitCode=child.signalCode=null;
  child.kill=signal=>{events.push(signal);queueMicrotask(()=>{child.signalCode=signal;events.push('closed');child.emit('close',null,signal);});};
  const work=withOwnedTestChild(()=>child,async()=>{await Promise.resolve();events.push('setup');if(setupFails)throw failure;return 7;});
  if(setupFails)await assert.rejects(work,error=>error===failure);else assert.equal(await work,7);
  assert.deepEqual(events,['setup','SIGKILL','closed']);
 }
});
