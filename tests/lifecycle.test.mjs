import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewerLifecycle} from '../viewer/lifecycle.mjs';
const flush=()=>new Promise(setImmediate);

test('hidden/frozen lifecycle releases immediately and restarts only when both are visible',async()=>{
 let starts=0,stops=0;const lifecycle=new ViewerLifecycle({hidden:true,start:async()=>starts++,stop:()=>stops++});
 await lifecycle.run();assert.equal(starts,0);lifecycle.visibility(false);await flush();assert.equal(starts,1);assert.equal(lifecycle.state,'running');
 lifecycle.freeze();assert.equal(stops,1);lifecycle.visibility(true);lifecycle.resume();await flush();assert.equal(starts,1);
 lifecycle.visibility(false);await flush();assert.equal(starts,2);lifecycle.close();assert.equal(stops,2);lifecycle.visibility(false);lifecycle.resume();lifecycle.restart();await flush();assert.equal(starts,2);
});

test('repeated restarts coalesce behind canceled initialization without overlapping starts',async()=>{
 let finish,active=0,peak=0;const versions=[];
 const lifecycle=new ViewerLifecycle({start:async version=>{active++;peak=Math.max(peak,active);versions.push(version);if(versions.length===1)await new Promise(resolve=>finish=resolve);active--;},stop:()=>{}});
 const first=lifecycle.run();for(let n=0;n<30;n++)lifecycle.restart('probe');assert.equal(versions.length,1);assert.equal(lifecycle.current(0),false);
 finish();await first;await flush();assert.deepEqual(versions,[0,30]);assert.equal(peak,1);assert.equal(lifecycle.state,'running');lifecycle.close();
});

test('closing or hiding during initialization prevents the late start from becoming active',async()=>{
 for(const close of [false,true]){
  let finish;const states=[],lifecycle=new ViewerLifecycle({start:()=>new Promise(resolve=>finish=resolve),stop:()=>{},onState:state=>states.push(state.state)});
  const pending=lifecycle.run();if(close)lifecycle.close();else lifecycle.visibility(true);finish();await pending;
  assert.ok(!states.includes('running'));assert.equal(lifecycle.state,close?'closed':'suspended');
 }
});

test('failed initialization is reported once and requires a fresh resume or reconnect',async()=>{
 let starts=0,stops=0;const errors=[],lifecycle=new ViewerLifecycle({start:async()=>{starts++;throw new Error('fixture failure');},stop:()=>stops++,onError:error=>errors.push(error.message)});
 await lifecycle.run();await flush();assert.equal(starts,1);assert.equal(stops,1);assert.deepEqual(errors,['fixture failure']);assert.equal(lifecycle.state,'failed');lifecycle.close();
});

test('wake gaps invalidate the old generation; hidden intervals never trigger a recovery loop',async()=>{
 let starts=0;const lifecycle=new ViewerLifecycle({start:async()=>starts++,stop:()=>{},gapMs:15000});await lifecycle.run();
 assert.equal(lifecycle.tick(1000),false);assert.equal(lifecycle.tick(2000),false);assert.equal(lifecycle.tick(20000),true);await flush();assert.equal(starts,2);
 lifecycle.visibility(true);assert.equal(lifecycle.tick(200000),false);lifecycle.visibility(false);await flush();assert.equal(lifecycle.tick(300000),false);assert.equal(lifecycle.tick(299000),true);await flush();assert.equal(starts,4);lifecycle.close();
});
