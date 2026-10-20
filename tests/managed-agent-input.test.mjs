import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ControlLease,InputError,AgentInputError} from '../live/input.mjs';
import {createManagedAgentInput} from '../live/managed-agent-input.mjs';
function setup(t){const source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:640,cssHeight:480},latest:{},inputSeq:0}),calls=[],control=new ControlLease(source,{send:async(method,params)=>{calls.push({method,params});},detach:async()=>{}});t.after(()=>control.close());return {source,calls,control,tools:createManagedAgentInput(control)};}
const options=tools=>({fence:tools.fence()}),tags=c=>({sessionId:c.sessionId,pageEpoch:c.source.pageEpoch,viewportVersion:c.source.viewportVersion});
const rejects=(promise,code,outcome='not-dispatched')=>assert.rejects(promise,error=>error instanceof AgentInputError&&error.code===code&&error.outcome===outcome);
test('managed input has only frozen fence/send functions and never returns a raw controller',async t=>{
 const {tools}=setup(t);assert.deepEqual(Object.keys(tools),['fence','send']);assert.ok(Object.isFrozen(tools));for(const name of ['page','source','cdp','control','evaluate','context','newCDPSession'])assert.equal(tools[name],undefined);const fence=tools.fence(),result=await tools.send('Input.insertText',{text:'safe'},{fence});assert.deepEqual(result,{stage:'input-injected',fence});assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.fence));assert.notEqual(result.fence,fence);
});
test('managed input requires explicit exact fence options and never uses the trusted legacy fallback',async t=>{
 const {tools,calls}=setup(t);for(const value of [undefined,null,{}, {fence:null},{fence:tools.fence(),signal:new AbortController().signal}])await rejects(tools.send('Input.insertText',{text:'no'},value),value&&Object.hasOwn(value,'fence')&&value.fence===null?'INVALID_AGENT_FENCE':'AGENT_INVALID_REQUEST');assert.equal(calls.length,0);
});
test('managed input forbids arbitrary CDP methods without reading their parameters',async t=>{
 const {tools,calls}=setup(t);let reads=0;const params=Object.defineProperty({},'expression',{enumerable:true,get(){reads++;return 'private';}});for(const method of ['Runtime.evaluate','Page.navigate','Target.attachToTarget','Browser.close','Input.synthesizeScrollGesture',{},null])await rejects(tools.send(method,params,options(tools)),'AGENT_METHOD_FORBIDDEN');assert.equal(reads,0);assert.equal(calls.length,0);
});
test('managed input rejects accessors, prototypes, symbols, nested data and extra CDP parameters',async t=>{
 const {tools,calls}=setup(t);let reads=0;const getter=Object.defineProperty({},'text',{enumerable:true,get(){reads++;return 'private';}});const cases=[getter,Object.create({text:'inherited'}),{text:'x',extra:true},{text:{toString(){reads++;return 'private';}}},{text:'x',[Symbol('extra')]:1},{text:'x'.repeat(8193)}];for(const params of cases)await rejects(tools.send('Input.insertText',params,options(tools)),'AGENT_INVALID_REQUEST');await rejects(tools.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',commands:['deleteForward']},options(tools)),'AGENT_INVALID_REQUEST');assert.equal(reads,0);assert.equal(calls.length,0);
});
test('managed input copies admitted text, key parameters and fence before caller mutation',async t=>{
 const {control:c,tools,calls}=setup(t);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),send=c.cdp.send;t.after(()=>release());c.cdp.send=async(method,params)=>{await send(method,params);if(params.text==='active'){entered();await gate;}};const active=tools.send('Input.insertText',{text:'active'},options(tools));await started;
 const params={text:'planned'},request=options(tools),key={type:'keyDown',key:'a',code:'KeyA',text:'A'},queued=tools.send('Input.insertText',params,request),pressed=tools.send('Input.dispatchKeyEvent',key,options(tools));params.text='mutated';request.fence={...request.fence,controlVersion:999};key.type='keyUp';key.code='KeyZ';key.text='Z';release();await active;await queued;await pressed;assert.equal(calls.find(x=>x.params.text==='planned').method,'Input.insertText');assert.ok(!calls.some(x=>['mutated','Z'].includes(x.params.text)));assert.equal(c.keys.has('KeyA'),true);assert.equal(c.keys.has('KeyZ'),false);
});
test('managed input maps the bounded supported CDP subset through the actual ControlLease',async t=>{
 const {tools,calls}=setup(t);const cases=[['Input.dispatchMouseEvent',{type:'mouseMoved',x:10,y:20,button:'none',buttons:0,clickCount:0}],['Input.dispatchMouseEvent',{type:'mousePressed',x:10,y:20,button:'left',buttons:1,clickCount:1}],['Input.dispatchMouseEvent',{type:'mouseReleased',x:10,y:20,button:'left',buttons:0,clickCount:1}],['Input.dispatchMouseEvent',{type:'mouseWheel',x:10,y:20,deltaX:0,deltaY:40}],['Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:4}],['Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA'}],['Input.imeSetComposition',{text:'ab',selectionStart:1,selectionEnd:2}]];for(const [method,params]of cases)await tools.send(method,params,options(tools));assert.equal(calls.length,cases.length);assert.equal(calls[3].params.type,'mouseWheel');assert.deepEqual(calls[4].params.commands,['selectAll']);assert.equal(calls[6].method,'Input.imeSetComposition');assert.equal(calls[6].params.text,'ab');
});
test('mouse branching uses one captured parameter record even with a changing proxy',async t=>{
 const {tools,calls}=setup(t),reads=new Map(),params=new Proxy({type:'mouseMoved',x:10,y:20,button:'none',buttons:0,clickCount:0},{getOwnPropertyDescriptor(target,key){const count=(reads.get(key)??0)+1;reads.set(key,count);const descriptor=Reflect.getOwnPropertyDescriptor(target,key);return key==='x'?{...descriptor,value:count===1?10:639}:descriptor;}});await tools.send('Input.dispatchMouseEvent',params,options(tools));assert.equal(calls[0].params.x,10);assert.equal(reads.get('x'),1);
});
test('managed input semantic errors and queue saturation are not dispatched',async t=>{
 const {tools,control:c,calls}=setup(t);for(const [method,params,code]of [['Input.insertText',{text:1},'INVALID_TEXT'],['Input.dispatchMouseEvent',{type:'mouseMoved',x:640,y:0,button:'none',buttons:0,clickCount:0},'INVALID_COORDINATES'],['Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:16},'INVALID_MODIFIERS'],['Input.imeSetComposition',{text:'x',selectionStart:2,selectionEnd:2},'INVALID_COMPOSITION_RANGE']])await rejects(tools.send(method,params,options(tools)),code);c.queued=64;await rejects(tools.send('Input.insertText',{text:'full'},options(tools)),'INPUT_QUEUE_FULL');c.queued=0;assert.equal(calls.length,0);
});
test('managed input rejects old fences after human release before touching parameters',async t=>{
 const {tools,control:c,calls}=setup(t),old=options(tools);await c.acquire('human',tags(c));await c.revoke('released');calls.length=0;let reads=0;const params=new Proxy({text:'no'},{ownKeys(){reads++;return ['text'];}});await rejects(tools.send('Input.insertText',params,old),'STALE_AGENT_FENCE');assert.equal(reads,0);assert.equal(calls.length,0);await tools.send('Input.insertText',{text:'fresh'},options(tools));assert.equal(calls.at(-1).params.text,'fresh');
});
test('queued managed input revoked by handoff reports not-dispatched',async t=>{
 const {tools,control:c,calls}=setup(t);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),send=c.cdp.send;t.after(()=>release());c.cdp.send=async(method,params)=>{await send(method,params);if(params.text==='first'){entered();await gate;}};const active=tools.send('Input.insertText',{text:'first'},options(tools));await started;const queued=tools.send('Input.insertText',{text:'old'},options(tools)),rejected=rejects(queued,'AGENT_PAUSED'),human=c.acquire('human',tags(c));release();await active;await rejected;await human;assert.ok(!calls.some(x=>x.params.text==='old'));
});
test('a CDP failure after dispatch is unknown, redacted and never automatically retried',async t=>{
 const {tools,control:c}=setup(t);let calls=0;c.cdp.send=async()=>{calls++;throw new InputError('AGENT_PAUSED');};await rejects(tools.send('Input.insertText',{text:'private-body'},options(tools)),'AGENT_INPUT_FAILED','unknown');assert.equal(calls,1);await new Promise(r=>setTimeout(r,20));assert.equal(calls,1);
});
test('resource acquisition failure before CDP is redacted and not-dispatched',async t=>{
 const {tools,source,calls}=setup(t);source.acquirePageRun=()=>{throw Error('private-url?key=secret');};await assert.rejects(tools.send('Input.insertText',{text:'private'},options(tools)),error=>{assert.equal(error.code,'AGENT_INPUT_FAILED');assert.equal(error.outcome,'not-dispatched');assert.doesNotMatch(String(error)+JSON.stringify(error),/private-url|secret/);return true;});assert.equal(calls.length,0);
});
test('the adapter binds the fenced core and refuses calls after Source close',async t=>{
 const {control:c,tools,calls}=setup(t);c.agent=()=>{throw Error('must not use a replaced compatibility entry');};await tools.send('Input.insertText',{text:'bound'},options(tools));assert.equal(calls.at(-1).params.text,'bound');const request=options(tools);await c.close();await rejects(tools.send('Input.insertText',{text:'closed'},request),'SESSION_CLOSED');assert.throws(()=>createManagedAgentInput({agent(){}}),TypeError);
});
