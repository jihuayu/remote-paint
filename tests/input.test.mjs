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
test('slow semantic feedback cannot block injection acknowledgements or lease revocation',async()=>{
 const {source,control:c}=setup();const messages=[],requests=[];source.requestCapture=()=>requests.push(source.inputSeq);
 let finishRead;source.page={evaluate:async fn=>fn.name==='readPublicEditor'?new Promise(resolve=>{finishRead=resolve;}):null};
 const peer={id:'a',ready:true,feedback:true,send:m=>messages.push(m)};c.attach(peer);const grant=await c.acquire('a',tags(c));
 const feedback=c.readFeedback();await new Promise(setImmediate);assert.equal(typeof finishRead,'function');
 const result=await c.input('a',{...grant,seq:1,event:text});assert.equal(result.accepted,true);assert.equal(result.optimistic,undefined);assert.deepEqual(requests,[1]);
 await c.revoke();assert.equal(c.mode,'agent');finishRead({text:'stale'});await feedback;
 assert.equal(messages.filter(m=>m.type==='FeedbackState').length,0);await c.close();
});
test('public editor corrections use an independent versioned message and no input text in DOM probes',async()=>{
 const {source,control:c}=setup();const messages=[],descriptors=[];
 source.page={evaluate:async(fn,args)=>{descriptors.push(args);return fn.name==='readPublicEditor'?{preview:'plain-text',editorId:'public',kind:'input',x:12,y:34,width:200,height:42,text:'FORMATTED',selectionStart:9,selectionEnd:9,style:{}}:null;}};
 const peer={id:'a',ready:true,feedback:true,send:m=>messages.push(m)};c.attach(peer);const grant=await c.acquire('a',tags(c));
 const result=await c.input('a',{...grant,seq:1,event:{kind:'text',text:'private input'}});assert.equal(result.optimistic,undefined);
 source.latest.lastProcessedInputSeq=1;await c.readFeedback();const update=messages.find(m=>m.type==='FeedbackState');
 assert.equal(update.editor.text,'FORMATTED');assert.equal(update.afterInputSeq,1);assert.equal(update.feedbackEpoch,grant.feedbackEpoch);assert.equal(update.sessionId,c.sessionId);assert.equal(descriptors.length,2);
 assert.ok(!JSON.stringify(descriptors).includes('private input'));await c.readFeedback();assert.equal(messages.filter(m=>m.type==='FeedbackState').length,1);await c.close();
});
test('legacy viewers receive no semantic editor data',async()=>{
 const {source,control:c}=setup();let reads=0;source.page={evaluate:async()=>{reads++;return {text:'private'};}};
 c.attach({id:'a',ready:true,send(){}});const grant=await c.acquire('a',tags(c));await c.input('a',{...grant,seq:1,event:text});c.scheduleFeedback();await new Promise(r=>setTimeout(r,120));assert.equal(reads,0);await c.close();
});
test('handoff fences accepted Agent work, blocks new Agent work and releases held state',async()=>{
 const {control:c,cdp,calls}=setup();let release,entered;const ready=new Promise(r=>entered=r);const original=cdp.send;
 cdp.send=async(method,params)=>{if(params.code==='KeyA'&&params.type==='keyDown'){entered();await new Promise(r=>release=r);}await original(method,params);};
 const agent=c.agent({kind:'key',type:'keyDown',key:'a',code:'KeyA'});await ready;
 let granted=false;const acquisition=c.acquire('a',tags(c)).then(value=>{granted=true;return value;});
 assert.throws(()=>c.agent(text),{code:'AGENT_PAUSED'});await Promise.resolve();assert.equal(granted,false);release();await agent;await acquisition;
 assert.ok(calls.some(call=>call.params.type==='keyUp'&&call.params.code==='KeyA'));assert.equal(c.mode,'human');await c.close();
});
test('human handoff rejects queued Agent input that has not reached CDP',async t=>{
 const {control:c,cdp,calls}=setup();let release,entered;const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>release=r),send=cdp.send;
 t.after(async()=>{release();await c.close();});cdp.send=async(method,params)=>{await send(method,params);if(params.code==='KeyA'&&params.type==='keyDown'){entered();await gate;}};
 const active=c.agent({kind:'key',type:'keyDown',key:'a',code:'KeyA'});await enteredPromise;const queued=c.agent({kind:'text',text:'stale-agent-command'}).then(()=>({ok:true}),error=>({ok:false,code:error.code}));let granted=false;const acquiring=c.acquire('a',tags(c)).then(value=>{granted=true;return value;});assert.equal(c.mode,'handoff');assert.equal(granted,false);assert.throws(()=>c.agent(text),{code:'AGENT_PAUSED'});release();await active;await acquiring;
 assert.deepEqual(await queued,{ok:false,code:'AGENT_PAUSED'});assert.ok(!calls.some(call=>call.params.text==='stale-agent-command'));assert.ok(calls.some(call=>call.params.code==='KeyA'&&call.params.type==='keyUp'));assert.equal(c.mode,'human');
});
test('revocation discards queued Agent input before resuming fresh Agent work',async t=>{
 const {control:c,cdp,calls}=setup();let release,entered;const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>release=r),send=cdp.send;
 t.after(async()=>{release();await c.close();});cdp.send=async(method,params)=>{await send(method,params);if(params.text==='active-agent-command'){entered();await gate;}};
 const active=c.agent({kind:'text',text:'active-agent-command'});await enteredPromise;const queued=c.agent({kind:'text',text:'revoked-agent-command'}).then(()=>({ok:true}),error=>({ok:false,code:error.code})),revoking=c.revoke('released');assert.equal(c.mode,'handoff');release();await active;await revoking;
 assert.deepEqual(await queued,{ok:false,code:'AGENT_PAUSED'});assert.ok(!calls.some(call=>call.params.text==='revoked-agent-command'));assert.equal(c.mode,'agent');await c.agent({kind:'text',text:'fresh-agent-command'});assert.ok(calls.some(call=>call.params.text==='fresh-agent-command'));
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
test('document reconciliation blocks matching-tag new and queued human input before injection',async()=>{
 const {source,control:c,cdp,calls}=setup();const grant=await c.acquire('a',tags(c));let release,entered;const ready=new Promise(resolve=>entered=resolve),send=cdp.send;
 cdp.send=async(method,params)=>{if(method==='Input.insertText'&&params.text==='first'){entered();await new Promise(resolve=>release=resolve);}return send(method,params);};
 const first=c.input('a',{...grant,seq:1,event:{kind:'text',text:'first'}});await ready;
 const queued=c.input('a',{...grant,seq:2,event:text}),rejected=assert.rejects(queued,{code:'PAGE_TRANSITION'});
 source.transitioning=true;assert.throws(()=>c.input('a',{...grant,seq:3,event:text}),{code:'PAGE_TRANSITION'});
 release();assert.equal((await first).accepted,true);await rejected;assert.equal(source.inputSeq,1);assert.ok(!calls.some(call=>call.params.text==='中文😀'));source.transitioning=false;await c.close();
});
test('Agent input queued before a document transition does not inject into the unsettled target',async()=>{
 const {source,control:c,cdp,calls}=setup();let release,entered;const ready=new Promise(resolve=>entered=resolve),send=cdp.send;
 cdp.send=async(method,params)=>{if(method==='Input.insertText'&&params.text==='first'){entered();await new Promise(resolve=>release=resolve);}return send(method,params);};
 const first=c.agent({kind:'text',text:'first'});await ready;const queued=c.agent(text),rejected=assert.rejects(queued,{code:'STALE_AGENT_PAGE'});
 source.transitioning=true;release();await first;await rejected;assert.ok(!calls.some(call=>call.params.text==='中文😀'));source.transitioning=false;await c.close();
});
test('an acknowledged input that changes the document still receives its injection ACK',async()=>{
 const {source,control:c,cdp}=setup();const grant=await c.acquire('a',tags(c));const send=cdp.send;
 cdp.send=async(method,params)=>{await send(method,params);if(method==='Input.insertText'){source.transitioning=true;source.pageEpoch++;}};
 const ack=await c.input('a',{...grant,seq:1,event:text});assert.equal(ack.accepted,true);assert.equal(ack.stage,'input-injected');assert.equal(source.inputSeq,1);source.transitioning=false;await c.close();
});
test('crashed target close releases queued CDP work through Source and never waits on target detach',async()=>{
 const {source,cdp,control:c}=setup();let rejectInput,entered,disconnected=false;const ready=new Promise(resolve=>entered=resolve);let sourceCloses=0,detaches=0;
 cdp.send=()=>{if(disconnected)return Promise.reject(new Error('Target closed'));entered();return new Promise((_,reject)=>rejectInput=reject);};cdp.detach=()=>{detaches++;return new Promise(()=>{});};
 const input=c.agent(text),rejected=assert.rejects(input,/Target crashed/);await ready;
 source.targetCrashed=true;source.close=async()=>{sourceCloses++;disconnected=true;rejectInput(new Error('Target crashed'));};
 const closing=c.close();assert.equal(closing,c.close());await closing;await rejected;
 assert.equal(sourceCloses,1);assert.equal(detaches,0);assert.equal(c.peers.size,0);assert.equal(c.closed,true);assert.equal(c.queued,0);assert.equal(source.listenerCount('invalidate'),0);assert.equal(source.listenerCount('frame'),0);
});
