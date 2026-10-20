import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setImmediate as immediate,setTimeout as delay} from 'node:timers/promises';
import vm from 'node:vm';
import {NativeBroker} from '../native/broker.mjs';
import {RequestMemory} from '../native/request-memory.mjs';
import {encodeRequest} from '../native/request-json.mjs';

async function encoded(args,run){const memory=new RequestMemory(),owner=memory.begin('fixture');try{const packet=encodeRequest(17,'fixture',args,memory,owner);await run(packet,memory,owner);}finally{memory.abort(owner);await immediate();}}
test('Broker request encoding uses one exact backing and matches JSON values,UTF-8,escaping and numeric rules',async()=>{
 const nullObject=Object.create(null);nullObject['__proto__']='data';nullObject['日本語😀']='text';
 const cases=[{text:'hello\0\b\t\n\f\r"\\\u2028\u2029😀é中\ud800x\udfff',numbers:[-0,NaN,Infinity,-Infinity,1e21,1e-7],omit:undefined,holes:[,undefined,null]},nullObject,vm.runInNewContext('({nested:[1,"two",{three:true}]})'),{'10':'integer key','2':'two',empty:{},list:[]}];
 for(const args of cases)await encoded(args,async(packet,memory)=>{assert.equal(packet.buffer.byteLength,packet.length);assert.equal(packet.readUInt32BE(),packet.length-4);assert.equal(packet.length-4,Buffer.byteLength(JSON.stringify({id:17,op:'fixture',...args})));assert.deepEqual(JSON.parse(packet.subarray(4)),JSON.parse(JSON.stringify({id:17,op:'fixture',...args})));assert.equal(memory.stats().packetBackingBytes,packet.length);});
});

test('Broker preflight rejects side-effecting objects and reserved envelope fields without invoking hooks',async()=>{
 let calls=0;const getter={get secret(){calls++;return 'bad';}},hook={toJSON(){calls++;return {};}},proxy=new Proxy({},{ownKeys(){calls++;return [];}}),nullHook=Object.create(null);Object.defineProperty(nullHook,'toJSON',{get(){calls++;return ()=>({});}});
 const cycle={};cycle.self=cycle;
 for(const args of [getter,hook,{nested:proxy},nullHook,{value:1n},{id:99},{op:'reset'},{cycle}]){
  const memory=new RequestMemory(),owner=memory.begin('fixture');assert.throws(()=>encodeRequest(1,'fixture',args,memory,owner));assert.equal(memory.stats().packetBackingBytes,0);memory.abort(owner);await immediate();assert.equal(memory.stats().owners,0);
 }
 assert.equal(calls,0);
});

test('Seeded request corpus matches native JSON across nested structures and UTF-16 edge cases',async()=>{
 let state=731;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;};
 const text=()=>Array.from({length:random()%24},()=>String.fromCharCode(random()%65536)).join('');
 const value=depth=>{const kind=random()%(depth>3?4:6);if(kind===0)return null;if(kind===1)return text();if(kind===2)return (random()%2?-1:1)*random()/17;if(kind===3)return Boolean(random()%2);if(kind===4)return Array.from({length:random()%6},()=>value(depth+1));const object=Object.create(null);for(let i=0,n=random()%6;i<n;i++)object[text()]=value(depth+1);return object;};
 for(let n=0;n<300;n++){const args={value:value(0)};await encoded(args,async packet=>{const expected=JSON.stringify({id:17,op:'fixture',...args});assert.equal(packet.subarray(4).toString(),expected);assert.equal(packet.length-4,Buffer.byteLength(expected));});}
});

test('Broker request strings reserve serialization headroom before an outbound Buffer is created',async()=>{
 const memory=new RequestMemory({dataBytes:128*1024}),owner=memory.begin('fixture');
 assert.throws(()=>encodeRequest(1,'fixture',{text:'x'.repeat(64*1024)},memory,owner),error=>error.code==='INPUT_BUDGET_PRESSURE'&&error.budget==='node-request');assert.equal(memory.stats().packetBackingBytes,0);assert.ok(memory.stats().peakDataBytes<=128*1024);
 memory.abort(owner);await immediate();assert.equal(memory.stats().dataBytes,0);
});

const fixture=mode=>`#!/usr/bin/env node
let input=Buffer.alloc(0),stalled=[];
const send=value=>{const bytes=Buffer.from(JSON.stringify(value)),head=Buffer.alloc(4);head.writeUInt32BE(bytes.length);process.stdout.write(Buffer.concat([head,bytes]));};
setInterval(()=>{},1000);send({event:'FixtureReady'});
${mode==='hold'?'':`process.stdin.on('data',chunk=>{
 input=Buffer.concat([input,chunk]);
 ${mode==='early'?`if(input.length>32){const match=input.subarray(4,256).toString().match(/^\\{"id":(\\d+),/);if(match){send({id:Number(match[1]),result:'early'});process.stdin.pause();}}`:`while(input.length>=4){const size=input.readUInt32BE();if(input.length<size+4)return;const request=JSON.parse(input.subarray(4,size+4));input=input.subarray(size+4);
  if(request.op==='stall')stalled.push(request.id);
  else if(request.op==='resourceBudget')send({id:request.id,result:{ready:true,fixture:true}});
  else if(request.op==='reset'){for(const id of stalled.splice(0))send({id,result:true});send({id:request.id,result:true});}
  else send({id:request.id,result:request.value??true});
 }`}
});`}
`;
async function withBroker(mode,limits,run){const directory=await mkdtemp(join(tmpdir(),'remote-paint-request-budget-')),binary=join(directory,'broker.mjs');await writeFile(binary,fixture(mode));await chmod(binary,0o700);const broker=new NativeBroker({binary,requestLimits:limits});try{await once(broker,'event');await run(broker);}finally{await broker.close();await rm(directory,{recursive:true,force:true});}assert.equal(broker.requestMemory.stats().owners,0);assert.equal(broker.requestMemory.stats().packetBackingBytes,0);}

test('Full data slots retain pending arguments but reserved control can reply and release them',{timeout:10000},async()=>withBroker('normal',{owners:4,dataOwners:2},async broker=>{
 const first=broker.request('stall',{value:'one'}),second=broker.request('stall',{value:'two'});first.catch(()=>{});second.catch(()=>{});await delay(20);
 assert.equal(broker.requestMemory.stats().dataOwners,2);assert.ok(broker.requestMemory.stats().retainedEstimate>0);assert.equal(broker.requestMemory.stats().packetBackingBytes,0);
 await assert.rejects(broker.request('stall'),error=>error.code==='INPUT_BUDGET_PRESSURE'&&error.phase==='slots');
 const status=await broker.request('resourceBudget');assert.equal(status.fixture,true);assert.equal(status.ready,false);assert.equal(status.nodeRequests.dataOwners,2);
 await broker.reset();await Promise.all([first,second]);await immediate();assert.equal(broker.requestMemory.stats().dataOwners,0);assert.equal(await broker.request('echo',{value:'resumed'}),'resumed');
}));

test('A real non-reading child keeps pipe packet credits,denies growth and still reserves control admission',{timeout:10000},async()=>withBroker('hold',{dataBytes:8*1024*1024},async broker=>{
 const requests=[];let pressure=0,closed=0;const text='x'.repeat(1024*1024);
 for(let n=0;n<8;n++)requests.push(broker.request('stall',{text}).catch(error=>{if(error.code==='INPUT_BUDGET_PRESSURE')pressure++;else if(/closed/.test(error.message))closed++;else throw error;}));
 await delay(30);const before=broker.requestMemory.stats();assert.ok(pressure>0);assert.ok(before.packetBackingBytes>=1024*1024);assert.ok(before.peakDataBytes<=before.dataLimit);assert.ok(broker.child.stdin.writableLength>0);
 const control=broker.request('resourceBudget').catch(error=>{assert.match(error.message,/closed/);});await delay(10);assert.ok(broker.requestMemory.stats().controlBytes>0,'Control admission was consumed by data');
 await broker.close();await Promise.all([...requests,control]);assert.ok(closed>0);assert.equal(broker.requestMemory.stats().dataBytes,0);assert.equal(broker.requestMemory.stats().controlBytes,0);
}));

test('An early response cannot return packet credit while its real pipe write is still blocked',{timeout:10000},async()=>withBroker('early',{},async broker=>{
 assert.equal(await broker.request('early',{text:'x'.repeat(2*1024*1024)}),'early');await immediate();assert.equal(broker.pending.size,0);
 const stats=broker.requestMemory.stats();assert.ok(stats.packetBackingBytes>=2*1024*1024);assert.ok(stats.owners>0);assert.ok(broker.child.stdin.writableLength>0);
 await broker.close();assert.equal(broker.requestMemory.stats().packetBackingBytes,0);
}));

test('Invalid request arguments leave the child alive and do not change its request sequence',async()=>withBroker('normal',{},async broker=>{
 await assert.rejects(broker.request('echo',{id:55}),/reserved/);assert.equal(broker.seq,0);assert.equal(broker.pending.size,0);assert.equal(broker.closed,false);await immediate();assert.equal(await broker.request('echo',{value:'valid'}),'valid');assert.equal(broker.seq,1);
}));

test('Real GC confirms write/reply/close packet lifetimes in an isolated process',{timeout:15000},async()=>{
 const child=spawn(process.execPath,['--expose-gc',fileURLToPath(new URL('./verify-node-request-lifetime.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe']});let output='',errors='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>errors+=bytes);const [code]=await once(child,'close');assert.equal(code,0,errors);const report=JSON.parse(output);assert.equal(report.status,'passed');assert.equal(report.writtenPending.backingAlive,false);assert.equal(report.blockedAfterReply.backingAlive,true);assert.equal(report.closed.backingAlive,false);
});
