import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {ResourcePressure} from '../live/resource-pressure.mjs';

test('Resource pressure pauses once, polls one request at a time, and resumes after peer credit returns',async()=>{
 const changes=[],stats=[],errors=[];let resolve,calls=0;
 const pressure=new ResourcePressure({broker:{request(op){assert.equal(op,'resourceBudget');calls++;return new Promise(done=>resolve=done);}},onChange:value=>changes.push(value),onStats:value=>stats.push(value),onError:error=>errors.push(error),pollMs:5,retryMs:10000});
 try{
  pressure.setActive(true);pressure.enter();pressure.enter();await delay(15);assert.equal(calls,1);assert.deepEqual(changes,[true]);
  resolve({ready:false,bytes:63});await delay(15);assert.equal(calls,2);assert.deepEqual(changes,[true]);
  resolve({ready:true,bytes:12});await delay(15);assert.deepEqual(changes,[true,false]);assert.equal(calls,2);assert.equal(stats.length,2);assert.deepEqual(errors,[]);
 }finally{pressure.close();}
});

test('Idle demand stops pressure polling and close fences a delayed response',async()=>{
 const changes=[];let resolve,calls=0;
 const pressure=new ResourcePressure({broker:{request(){calls++;return new Promise(done=>resolve=done);}},onChange:value=>changes.push(value),onError:error=>{throw error;},pollMs:5});
 pressure.enter();await delay(15);assert.equal(calls,0);pressure.setActive(true);await delay(15);assert.equal(calls,1);
 pressure.setActive(false);resolve({ready:false});await delay(15);assert.equal(calls,1);pressure.setActive(true);await delay(15);assert.equal(calls,2);
 pressure.close();resolve({ready:true});await delay(15);assert.deepEqual(changes,[true]);assert.equal(calls,2);assert.equal(pressure.timer,null);
});

test('Conservative headroom allows only a bounded admitted trial and genuine RPC failures remain errors',async()=>{
 const changes=[],errors=[];let calls=0;
 const pressure=new ResourcePressure({broker:{async request(){calls++;return {ready:false};}},onChange:value=>changes.push(value),onError:error=>errors.push(error),pollMs:5,retryMs:20});
 try{
  pressure.setActive(true);pressure.enter();await delay(45);assert.deepEqual(changes,[true,false]);assert.ok(calls<=5);const settled=calls;await delay(15);assert.equal(calls,settled);
  pressure.broker.request=async()=>{throw new Error('Broker pipe failed');};pressure.enter();await delay(15);assert.equal(errors.length,1);assert.equal(errors[0].message,'Broker pipe failed');assert.equal(pressure.active,false);
 }finally{pressure.close();}
});

test('Transient pressure on the status request keeps polling until control admission returns',async()=>{
 const changes=[],errors=[];let calls=0;
 const pressure=new ResourcePressure({broker:{async request(){if(++calls===1)throw Object.assign(new Error('Request queue pressured'),{code:'INPUT_BUDGET_PRESSURE'});return {ready:true};}},onChange:value=>changes.push(value),onError:error=>errors.push(error),pollMs:5});
 try{pressure.setActive(true);pressure.enter();await delay(30);assert.deepEqual(changes,[true,false]);assert.ok(calls>=2);assert.deepEqual(errors,[]);assert.equal(pressure.active,true);}finally{pressure.close();}
});
