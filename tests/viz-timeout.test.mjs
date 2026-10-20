import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {once} from 'node:events';
import {startVizIPC} from '../capture/viz-ipc.mjs';

class Broker extends EventEmitter{
 constructor(){super();this.requests=[];}
 async request(type,args){this.requests.push({type,args});return true;}
}
test('native Viz timeout stays distinct from explicit cancellation and cancels its broker expectation',async()=>{
 const broker=new Broker(),viz=await startVizIPC({broker});
 try{
  const pending=viz.waitFor('timeout-fixture',{timeout:5});await pending.registered;
  await assert.rejects(pending,{code:'VIZ_CAPTURE_TIMEOUT',message:'Viz capture deadline exceeded'});
  assert.deepEqual(broker.requests.filter(r=>r.type==='cancelViz'),[{type:'cancelViz',args:{captureId:'timeout-fixture'}}]);
  const canceled=viz.waitFor('explicit-cancel',{timeout:1000});await canceled.registered;viz.cancel('explicit-cancel');await assert.rejects(canceled,{code:'VIZ_CAPTURE_CANCELED',message:'Capture canceled'});
 }finally{await viz.close();}
});

test('a ready Viz frame retires its deadline without a late cancellation',async()=>{
 const broker=new Broker(),viz=await startVizIPC({broker});
 try{
  const pending=viz.waitFor('ready-fixture',{timeout:5});await pending.registered;broker.emit('event',{event:'VizReady',captureId:'ready-fixture'});
  assert.deepEqual(await pending,{captureId:'ready-fixture',native:true});await new Promise(resolve=>setTimeout(resolve,15));assert.equal(broker.requests.filter(r=>r.type==='cancelViz').length,0);
 }finally{await viz.close();}
});

test('Node Viz overload receipt rejects unfinished IDs immediately and permits a fresh request',async()=>{
 const viz=await startVizIPC({});let socket;
 try{
  const one=viz.waitFor('one',{timeout:1000}),two=viz.waitFor('two',{timeout:1000});one.catch(()=>{});two.catch(()=>{});
  socket=net.createConnection(viz.endpoint);await once(socket,'connect');const bytes=Buffer.from('RVE2\x01\x01\x01'),head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);socket.write(Buffer.concat([head,bytes]));
  await assert.rejects(one,{code:'VIZ_OUTPUT_OVERLOAD'});await assert.rejects(two,{code:'VIZ_OUTPUT_OVERLOAD'});
  const retry=viz.waitFor('retry',{timeout:1000});viz.cancel('retry');await assert.rejects(retry,{code:'VIZ_CAPTURE_CANCELED'});
 }finally{socket?.destroy();await viz.close();}
});
