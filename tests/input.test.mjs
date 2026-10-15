import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ControlLease,validateInput} from '../live/input.mjs';
function setup(options){const source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640},latest:{},inputSeq:0});const calls=[];const cdp={send:async(method,params)=>{calls.push({method,params});},detach:async()=>{}};const control=new ControlLease(source,cdp,options);return {source,calls,cdp,control};}
const text={kind:'text',text:'中文😀'};
const tags=c=>({sessionId:c.sessionId,pageEpoch:1,viewportVersion:1});
test('strict session/page/viewport/lease/sequence checks prevent any CDP dispatch',async()=>{
 const {control:c,calls}=setup();const grant=await c.acquire('a',tags(c));const input={...grant,seq:grant.nextSeq,event:text};calls.length=0;
 for(const [field,value,code] of [['sessionId','old','STALE_SESSION'],['pageEpoch',0,'STALE_EPOCH'],['viewportVersion',0,'STALE_VIEWPORT'],['lease','old','STALE_LEASE'],['seq',3,'STALE_SEQUENCE']])assert.throws(()=>c.input('a',{...input,[field]:value}),{code});
 assert.equal(calls.length,0);await c.input('a',input);assert.equal(calls.at(-1).params.text,'中文😀');assert.throws(()=>c.input('a',input),{code:'STALE_SEQUENCE'});await c.close();
});
test('fresh capture is requested only after accepted CDP input and its sequence watermark',async()=>{
 const {source,control:c,cdp}=setup(),requests=[];
 source.requestCapture=()=>requests.push(source.inputSeq);
 const grant=await c.acquire('a',tags(c));let finish,entered;
 const started=new Promise(r=>entered=r);
 cdp.send=async()=>{entered();await new Promise(r=>finish=r);};
 const input=c.input('a',{...grant,seq:1,event:text});await started;
 assert.deepEqual(requests,[]);assert.equal(source.inputSeq,0);
 finish();assert.equal((await input).accepted,true);assert.deepEqual(requests,[1]);
 assert.throws(()=>c.input('a',{...grant,seq:1,event:text}),{code:'STALE_SEQUENCE'});assert.deepEqual(requests,[1]);
 cdp.send=async()=>{throw new Error('CDP failed');};
 await assert.rejects(c.input('a',{...grant,seq:2,event:text}),/CDP failed/);assert.deepEqual(requests,[1]);
 await c.close();
});
test('handoff fences accepted Agent work, blocks new Agent work and releases held state',async()=>{
 const {control:c,cdp,calls}=setup();let release,entered;const ready=new Promise(r=>entered=r);const original=cdp.send;
 cdp.send=async(method,params)=>{if(params.code==='KeyA'&&params.type==='keyDown'){entered();await new Promise(r=>release=r);}await original(method,params);};
 const agent=c.agent({kind:'key',type:'keyDown',key:'a',code:'KeyA'});await ready;
 let granted=false;const acquisition=c.acquire('a',tags(c)).then(value=>{granted=true;return value;});
 assert.throws(()=>c.agent(text),{code:'AGENT_PAUSED'});await Promise.resolve();assert.equal(granted,false);release();await agent;await acquisition;
 assert.ok(calls.some(call=>call.params.type==='keyUp'&&call.params.code==='KeyA'));assert.equal(c.mode,'human');await c.close();
});
test('revocation invalidates queued input, fences inflight input and resumes Agent after cleanup',async()=>{
 const {control:c,cdp,source,calls}=setup();const grant=await c.acquire('a',tags(c));let release,entered;const ready=new Promise(r=>entered=r);const original=cdp.send;
 cdp.send=async(method,params)=>{if(method==='Input.insertText'&&params.text==='first'){entered();await new Promise(r=>release=r);}await original(method,params);};
 const first=c.input('a',{...grant,seq:1,event:{kind:'text',text:'first'}});await ready;
 const queued=c.input('a',{...grant,seq:2,event:text});const rejected=assert.rejects(queued,{code:'STALE_LEASE'});const revocation=c.revoke();assert.equal(c.mode,'handoff');release();await first;await rejected;await revocation;
 assert.equal(source.inputSeq,1);assert.ok(!calls.some(call=>call.params.text==='中文😀'));assert.equal(c.mode,'agent');await c.agent(text);await c.close();
});
test('expiry and disconnect revoke authority; cleanup is allowed even when queue is full',async()=>{
 const {control:c}=setup({ttl:20});await c.acquire('a',tags(c));await new Promise(r=>setTimeout(r,40));assert.equal(c.mode,'agent');await c.acquire('a',tags(c));c.queued=64;c.detach('a');await c.tail;assert.equal(c.mode,'agent');c.queued=0;await c.close();
});
test('input schema bounds coordinates and maps text, composition and editor shortcut to CDP',()=>{
 const v={cssWidth:960,cssHeight:640};assert.throws(()=>validateInput({kind:'wheel',x:960,y:0,deltaX:0,deltaY:1},v),{code:'INVALID_COORDINATES'});
 assert.equal(validateInput({kind:'composition',phase:'update',text:'你好'},v).method,'Input.imeSetComposition');
 assert.equal(validateInput({kind:'composition',phase:'commit',text:'你好'},v).method,'Input.insertText');
 assert.deepEqual(validateInput({kind:'key',type:'keyDown',key:'a',code:'KeyA',modifiers:4},v).params.commands,['selectAll']);
});
