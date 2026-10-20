import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ControlLease} from '../live/input.mjs';
const text=value=>({kind:'text',text:value});
function setup(){const source=Object.assign(new EventEmitter(),{pageEpoch:1,viewportVersion:1,viewport:{cssWidth:960,cssHeight:640},latest:{},inputSeq:0}),calls=[],control=new ControlLease(source,{send:async(method,params)=>{calls.push({method,params});},detach:async()=>{}});return {source,calls,control};}
const stamp=c=>({controlSessionId:c.sessionId,controlVersion:c.version,pageEpoch:c.source.pageEpoch,viewportVersion:c.source.viewportVersion});
const tags=c=>({sessionId:c.sessionId,pageEpoch:c.source.pageEpoch,viewportVersion:c.source.viewportVersion});
async function outcome(fn){try{await fn();return {ok:true};}catch(error){return {ok:false,code:error.code};}}
test('an old explicit Agent request cannot regain authority after human control is released',async t=>{
 const {control:c,calls}=setup();t.after(()=>c.close());const old=stamp(c);await c.acquire('human',tags(c));await c.revoke('released');calls.length=0;assert.equal(c.mode,'agent');assert.equal(c.source.pageEpoch,old.pageEpoch);assert.equal(c.source.viewportVersion,old.viewportVersion);
 assert.deepEqual(await outcome(()=>c.agent(text('late-command'),{fence:old})),{ok:false,code:'STALE_AGENT_FENCE'});assert.equal(calls.length,0);await c.agent(text('fresh-command'),{fence:stamp(c)});assert.equal(calls.at(-1).params.text,'fresh-command');
});
test('Agent fence snapshots are immutable data and survive JSON transport',async t=>{
 const {control:c,calls}=setup();t.after(()=>c.close());const value=c.agentFence();assert.deepEqual(value,stamp(c));assert.ok(Object.isFrozen(value));assert.deepEqual(Object.keys(value).sort(),['controlSessionId','controlVersion','pageEpoch','viewportVersion']);assert.equal(value.controlVersion,0);await c.agent(text('json-fence'),{fence:JSON.parse(JSON.stringify(value))});assert.equal(calls.at(-1).params.text,'json-fence');assert.doesNotMatch(JSON.stringify(value),/lease|owner|key|tenant|run/i);
});
test('explicit Agent fence rejects another controller, page or viewport before CDP dispatch',async t=>{
 const {control:c,source,calls}=setup(),other=setup();t.after(()=>c.close());t.after(()=>other.control.close());const current=stamp(c);
 for(const fence of [{...current,controlSessionId:other.control.sessionId},{...current,controlVersion:1},{...current,pageEpoch:2},{...current,viewportVersion:2}])assert.deepEqual(await outcome(()=>c.agent(text('stale'),{fence})),{ok:false,code:'STALE_AGENT_FENCE'});
 source.pageEpoch++;assert.deepEqual(await outcome(()=>c.agent(text('old-page'),{fence:current})),{ok:false,code:'STALE_AGENT_FENCE'});source.pageEpoch--;source.viewportVersion++;assert.deepEqual(await outcome(()=>c.agent(text('old-size'),{fence:current})),{ok:false,code:'STALE_AGENT_FENCE'});assert.equal(calls.length,0);
});
test('explicit Agent fence schema never reads accessors or accepts inherited and unknown fields',async t=>{
 const {control:c,calls}=setup();t.after(()=>c.close());const current=stamp(c);let reads=0;const getter=Object.defineProperty({...current},'controlVersion',{enumerable:true,get(){reads++;return 0;}}),outerGetter=Object.defineProperty({},'fence',{enumerable:true,get(){reads++;return current;}}),symbol={...current,[Symbol('extra')]:1};
 const cases=[{},null,{fence:undefined},{fence:null},{fence:{...current,extra:true}},{fence:{...current,controlVersion:-1}},{fence:{...current,controlVersion:.5}},{fence:{...current,pageEpoch:0}},{fence:{...current,viewportVersion:Infinity}},{fence:{...current,controlSessionId:{toString(){reads++;return current.controlSessionId;}}}},{fence:getter},outerGetter,{fence:Object.create(current)},{fence:symbol},{fence:current,apiKey:'must-not-read'}];
 for(const options of cases)assert.deepEqual(await outcome(()=>c.agent(text('invalid'),options)),{ok:false,code:'INVALID_AGENT_FENCE'});assert.equal(reads,0);assert.equal(calls.length,0);
});
test('a stale explicit fence is rejected before reading the requested input',async t=>{
 const {control:c,calls}=setup();t.after(()=>c.close());const old=stamp(c);await c.revoke('released');calls.length=0;let reads=0;const event={get kind(){reads++;return 'text';},text:'must-not-dispatch'};
 assert.deepEqual(await outcome(()=>c.agent(event,{fence:old})),{ok:false,code:'STALE_AGENT_FENCE'});assert.equal(reads,0);assert.equal(calls.length,0);
});
test('queued explicit input owns the admitted fence snapshot and is still revoked by handoff',async t=>{
 const {control:c,calls}=setup();let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r),send=c.cdp.send;t.after(async()=>{release();await c.close();});c.cdp.send=async(method,params)=>{await send(method,params);if(params.text==='first'){entered();await gate;}};
 const first=c.agent(text('first'));await started;const mutable=stamp(c),queued=c.agent(text('captured'),{fence:mutable});mutable.controlVersion=999;mutable.controlSessionId='00000000-0000-0000-0000-000000000000';release();await first;await queued;assert.equal(calls.at(-1).params.text,'captured');
 let unblock,begin;const waiting=new Promise(r=>unblock=r),seen=new Promise(r=>begin=r);t.after(()=>unblock());c.cdp.send=async(method,params)=>{await send(method,params);if(params.text==='active'){begin();await waiting;}};const active=c.agent(text('active'));await seen;const stale=outcome(()=>c.agent(text('queued-old'),{fence:stamp(c)})),acquiring=c.acquire('human',tags(c));unblock();await active;await acquiring;assert.deepEqual(await stale,{ok:false,code:'AGENT_PAUSED'});assert.ok(!calls.some(x=>x.params.text==='queued-old'));
});
test('fence snapshots are unavailable during transition, human control and after close',async()=>{
 const {control:c,source}=setup();source.transitioning=true;assert.throws(()=>c.agentFence(),{code:'STALE_AGENT_PAGE'});source.transitioning=false;await c.acquire('human',tags(c));assert.throws(()=>c.agentFence(),{code:'AGENT_PAUSED'});await c.revoke('released');await c.agent(text('trusted-legacy'));await c.close();assert.throws(()=>c.agentFence(),{code:'SESSION_CLOSED'});
});
