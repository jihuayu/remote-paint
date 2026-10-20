import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setImmediate as turn} from 'node:timers/promises';
import {NativeBroker} from '../native/broker.mjs';
import {ResponseEnvelope} from '../native/response-envelope.mjs';
import {responseFixture} from './response-child-fixture.mjs';

async function withBroker(limits,run){
 const directory=await mkdtemp(join(tmpdir(),'response-budget-')),binary=join(directory,'fixture.mjs');await writeFile(binary,responseFixture);await chmod(binary,0o700);
 const broker=new NativeBroker({binary,responseLimits:limits});
 try{await once(broker,'event');await turn();await run(broker);}finally{await broker.close();await rm(directory,{recursive:true,force:true});}
 const stats=broker.responses.stats();assert.equal(stats.owners,0);assert.equal(stats.dataBytes,0);assert.equal(stats.controlBytes,0);assert.equal(stats.receivedBackingBytes,0);
}

test('A fragmented real8MiB response copies once into one exact private backing without concat',{timeout:10000},async()=>withBroker({},async broker=>{
 const before=broker.responses.stats(),concat=Buffer.concat,allocate=Buffer.allocUnsafeSlow;let calls=0,large=[];
 Buffer.concat=(...args)=>{calls++;return concat(...args);};Buffer.allocUnsafeSlow=bytes=>{const buffer=allocate(bytes);if(bytes>1024*1024)large.push({bytes,backing:buffer.buffer.byteLength});return buffer;};
 try{const result=await broker.request('echo',{bytes:8*1024*1024});assert.equal(result.length,8*1024*1024);}finally{Buffer.concat=concat;Buffer.allocUnsafeSlow=allocate;}
 assert.equal(calls,0);assert.equal(large.length,1);assert.equal(large[0].bytes,large[0].backing);assert.equal(broker.responses.stats().copiedBodyBytes-before.copiedBodyBytes,large[0].bytes);
 await turn();assert.equal(broker.responses.stats().privatePacketBackingBytes,0);assert.equal(broker.responses.stats().dataBytes,0);
}));

test('Packet denial precedes large backing allocation and a following reserved control still replies',async()=>withBroker({dataBytes:1024*1024},async broker=>{
 const allocate=Buffer.allocUnsafeSlow;let big=0;Buffer.allocUnsafeSlow=bytes=>{if(bytes>1024*1024)big++;return allocate(bytes);};
 try{await assert.rejects(broker.request('echo',{bytes:2*1024*1024}),error=>error.code==='INPUT_BUDGET_PRESSURE'&&error.budget==='node-response');}finally{Buffer.allocUnsafeSlow=allocate;}
 assert.equal(big,0);const status=await broker.request('resourceBudget');assert.equal(status.ready,true);assert.ok(status.nodeResponses.denied>0);assert.equal(status.nodeResponses.dataBytes,0);assert.equal(broker.closed,false);assert.equal(await broker.request('echo',{value:'resumed'}),'resumed');
}));

test('Parser estimate rejects before text JSON.parse and preserves the same subprocess',async()=>withBroker({dataBytes:1024*1024},async broker=>{
 const parse=JSON.parse;let big=0;JSON.parse=(value,...args)=>{if(typeof value==='string'&&value.length>128*1024)big++;return parse(value,...args);};
 try{await assert.rejects(broker.request('echo',{bytes:200*1024}),error=>error.code==='INPUT_BUDGET_PRESSURE'&&error.budget==='node-response');}finally{JSON.parse=parse;}
 assert.equal(big,0);assert.equal(await broker.request('echo',{value:'valid'}),'valid');await turn();assert.equal(broker.responses.stats().dataBytes,0);
}));

test('Dense scalar graphs and excessive nesting are denied before parsing and permit the next frame',async()=>withBroker({dataBytes:1024*1024},async broker=>{
 const parse=JSON.parse;let large=0;JSON.parse=(value,...args)=>{if(typeof value==='string'&&value.length>10000)large++;return parse(value,...args);};
 try{await assert.rejects(broker.request('echo',{value:Array(10000).fill(0)}),{code:'INPUT_BUDGET_PRESSURE'});}finally{JSON.parse=parse;}
 assert.equal(large,0);await assert.rejects(broker.request('deep',{depth:130}),error=>error.code==='INPUT_BUDGET_PRESSURE'&&error.phase==='metadata nesting');assert.equal(await broker.request('echo',{value:'after-limits'}),'after-limits');
}));

test('A concatenated burst of control replies does not retain all delivery transients in one turn',async()=>withBroker({controlBytes:128*1024},async broker=>{
 const replies=await Promise.all(Array.from({length:24},()=>broker.request('resourceBudget',{batch:24})));assert.equal(replies.length,24);assert.ok(replies.every(value=>value.fixture));assert.ok(broker.responses.stats().peakControlBytes<=128*1024);await turn();assert.equal(broker.responses.stats().controlBytes,0);
}));

test('Default control headroom admits a valid maximum-gateway-size dense input message',async()=>withBroker({},async broker=>{
 const incoming=once(broker,'event'),response=broker.request('dense-event');const [[event],result]=await Promise.all([incoming,response]);
 assert.equal(event.event,'Control');assert.ok(Buffer.byteLength(JSON.stringify(event.message))<=32*1024);assert.equal(event.message.event.extra.length,16000);assert.equal(result,true);assert.equal(broker.closed,false);
}));

test('Late headers and nested/UTF16 JSON retain values and transfer small staging packets to data',async()=>withBroker({dataBytes:4*1024*1024,controlBytes:128*1024},async broker=>{
 const before=broker.responses.stats().denied,value={padding:'x'.repeat(160*1024),nested:[{id:999,event:'nested',text:'中文😀\\"[,:]{}\ud800'},[1,true,null]]};
 assert.deepEqual(await broker.request('late',{value}),value);const after=broker.responses.stats();assert.ok(after.denied>before);assert.equal(after.deniedPackets,0);await turn();assert.equal(broker.responses.stats().dataBytes,0);
}));

test('Closing a denied incomplete frame releases receive ownership without waiting for its body',async()=>withBroker({dataBytes:1024*1024},async broker=>{
 await assert.rejects(broker.request('partial-known'),{code:'INPUT_BUDGET_PRESSURE'});assert.equal(broker.responses.stats().draining,true);assert.ok(broker.responses.stats().frameBytesRemaining>1024*1024);await broker.close();assert.equal(broker.responses.stats().receivedBackingBytes,0);
}));

test('Invalid UTF8 and undeliverable oversized events fail the pipe rather than silently stranding work',async()=>{
 await withBroker({},async broker=>{await assert.rejects(broker.request('invalid-utf8'),SyntaxError);assert.equal(broker.closed,true);});
 await withBroker({},async broker=>{await assert.rejects(broker.request('wide-event'),{code:'INPUT_BUDGET_PRESSURE'});assert.equal(broker.closed,true);});
});

test('Byte preflight header location is chunk independent and does not confuse nested keys',()=>{
 const text=Buffer.from('{"nested":{"id":999,"event":"wrong","x":"[\\\"{}]"},"\\u0069d":17,"result":[1,true,null],"event":"FixtureReady"}');
 for(let size=1;size<=text.length;size++){const probe=new ResponseEnvelope();for(let n=0;n<text.length;n+=size)probe.feed(text.subarray(n,n+size));probe.finish();assert.equal(probe.id,17);assert.equal(probe.event,'FixtureReady');assert.equal(probe.duplicate,false);assert.ok(probe.nodes>5);}
});

test('Three hundred seeded real-pipe replies match JSON values with early or late headers',async()=>withBroker({},async broker=>{
 let state=733;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return state>>>0;},text=()=>Array.from({length:random()%24},()=>String.fromCharCode(random()%65536)).join('');
 const value=depth=>{const n=random()%(depth>4?4:6);if(n===0)return null;if(n===1)return text();if(n===2)return random()/17;if(n===3)return !!(random()%2);if(n===4)return Array.from({length:random()%5},()=>value(depth+1));const result=Object.create(null);for(let k=0,count=random()%5;k<count;k++)result[text()]=value(depth+1);return result;};
 for(let n=0;n<300;n++){const item=value(0),expected=JSON.parse(JSON.stringify(item)),actual=await broker.request(n%2?'late':'echo',{value:item});assert.deepEqual(actual,expected);}
}));

test('Real forced GC can collect private response backings while results and a closed Broker remain reachable',{timeout:15000},async()=>{
 const child=spawn(process.execPath,['--expose-gc',fileURLToPath(new URL('./verify-node-response-lifetime.mjs',import.meta.url))],{stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>error+=bytes);const [code]=await once(child,'close');assert.equal(code,0,error||output);assert.equal(JSON.parse(output).status,'passed');
});
