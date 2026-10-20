import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';

const fixture=`#!/usr/bin/env node
let input=Buffer.alloc(0),held=[];
const send=value=>{const body=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32BE(body.length);process.stdout.write(Buffer.concat([head,body]));};
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);while(input.length>=4){const n=input.readUInt32BE();if(input.length<n+4)return;const r=JSON.parse(input.subarray(4,n+4));input=input.subarray(n+4);
 if(r.op==='reset'||r.op==='resetScene')held.push(r);
 else if(r.op==='release'){for(const item of held.splice(0))send(item.fail?{id:item.id,error:'Native subscription admission limit',code:'INPUT_BUDGET_PRESSURE'}:{id:item.id,result:true});send({id:r.id,result:true});}
 else if(r.op==='echo')send({id:r.id,result:true});
}});process.stdin.on('end',()=>process.exit(0));
`;
async function withBroker(fn,options={}){const directory=await mkdtemp(join(tmpdir(),'broker-reset-')),binary=join(directory,'fixture.mjs');await writeFile(binary,fixture);await chmod(binary,0o700);const broker=new NativeBroker({binary,...options});try{await fn(broker);}finally{await broker.close();await rm(directory,{recursive:true,force:true});}}
async function until(fn){const end=Date.now()+5000;while(!fn()){assert.ok(Date.now()<end);await delay(5);}}
function observe(broker){const events=[];for(const event of ['resetStart','resetEnd'])broker.on(event,value=>{assert.ok(Object.isFrozen(value));assert.ok(Object.values(value).every(v=>['number','string','boolean'].includes(typeof v)));events.push({event,...value});});return events;}

test('admitted reset controls signal before their reply and every terminal result pairs by request ID',async()=>withBroker(async broker=>{
 const events=observe(broker),a=broker.reset(),b=broker.request('resetScene',{fail:true});const denied=assert.rejects(b,{code:'INPUT_BUDGET_PRESSURE'});
 assert.deepEqual(events.map(e=>e.event),['resetStart','resetStart']);assert.equal(broker.pending.size,2);
 await broker.request('release');await a;await denied;assert.equal(events.length,4);
 for(const start of events.slice(0,2)){const end=events.find(e=>e.event==='resetEnd'&&e.id===start.id);assert.equal(end.op,start.op);assert.equal(end.closed,false);assert.equal(end.ok,start.op==='reset');}
 const count=events.length;await broker.request('echo');assert.equal(events.length,count);await until(()=>broker.requestMemory.stats().owners===0);
}));
test('Node request denial before reset encoding sends no lifecycle signal and retains no new owner',async()=>withBroker(async broker=>{
 const events=observe(broker),held=broker.reset();const closed=assert.rejects(held,/closed/);
 await assert.rejects(broker.resetScene(),{code:'INPUT_BUDGET_PRESSURE'});assert.equal(events.length,1);assert.equal(broker.pending.size,1);
 await broker.close();await closed;assert.deepEqual(events.map(e=>e.event),['resetStart','resetEnd']);assert.equal(events[1].closed,true);assert.equal(events[1].ok,false);assert.equal(broker.requestMemory.stats().owners,0);
},{requestLimits:{owners:1,dataOwners:1}}));
test('forced close completes all in-flight reset notifications exactly once and reaps pipe owners',async()=>withBroker(async broker=>{
 const events=observe(broker),requests=[broker.reset(),broker.resetScene(),broker.request('reset')],settled=requests.map(p=>assert.rejects(p,/forced reset teardown/));
 broker.fail(new Error('forced reset teardown'));await Promise.all(settled);await broker.close();assert.equal(events.filter(e=>e.event==='resetStart').length,3);assert.equal(events.filter(e=>e.event==='resetEnd').length,3);
 for(const e of events.filter(e=>e.event==='resetEnd')){assert.equal(e.closed,true);assert.equal(e.ok,false);}
 assert.equal(broker.pending.size,0);assert.equal(broker.requestMemory.stats().owners,0);assert.equal(broker.responses.stats().owners,0);assert.equal(broker.exited,true);
}));
