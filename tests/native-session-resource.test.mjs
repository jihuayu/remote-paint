import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeSessionResource} from '../service/native-session-resource.mjs';
const flush=()=>new Promise(setImmediate),defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function live(){let closes=0;const source={nativeAutopublish:true,broker:{exited:false,pending:new Map()},browser:{isConnected:()=>true,version:()=> 'fixture-native-v1'},control:{},capture:{binding:{}},closed:false,latest:{},producer:'fixture',demand:1,encodeDemand:1,activityDemand:1};return {source,renderer:{wasmSha256:'a'.repeat(64)},peers:new Set(),get closes(){return closes;},async close(){closes++;Object.assign(source,{closed:true,latest:null,producer:null,demand:0,encodeDemand:0,activityDemand:0});source.browser.isConnected=()=>false;source.broker.exited=true;source.capture.binding=null;}};}
const setup=startLive=>{const controller=new AbortController();return {controller,resource:new NativeSessionResource({request:{url:'about:blank',region:'test',ttlSeconds:60},signal:controller.signal,startLive})};};

test('resource owner exists before async startup and exposes only a verified Native/renderer version',async()=>{
 const source=live();let calls=0;const {resource}=setup(async args=>{calls++;assert.deepEqual(args,{url:'about:blank'});return source;});
 const first=resource.initialize();assert.equal(resource.initialize(),first);const ready=await first;assert.equal(ready.version,'chromium:fixture-native-v1;wasm:'+'a'.repeat(64));assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(ready),/about:blank|key|url/);
 const close=resource.close();assert.equal(resource.close(),close);assert.deepEqual(await close,{status:'closed'});assert.equal(source.closes,1);
});

test('closing before initialization prevents all later allocation',async()=>{
 let calls=0;const {resource}=setup(async()=>{calls++;return live();});assert.deepEqual(await resource.close(),{status:'closed'});await assert.rejects(resource.initialize(),/cancelled/);assert.equal(calls,0);
});

test('aborting and closing during startup wait for a late resource and actually close it before acknowledgement',async()=>{
 const pending=defer(),source=live(),{resource,controller}=setup(()=>pending.promise);const initialized=resource.initialize(),rejected=assert.rejects(initialized,/cancelled/);await flush();controller.abort();let closed=false;const close=resource.close().then(value=>{closed=true;return value;});await flush();assert.equal(closed,false);pending.resolve(source);await rejected;assert.deepEqual(await close,{status:'closed'});assert.equal(source.closes,1);
});

test('startup rejection without a returned owner remains unconfirmed until outer runtime retirement',async()=>{
 const {resource}=setup(async()=>{throw new Error('private-start-token');});await assert.rejects(resource.initialize(),/private-start-token/);assert.deepEqual(await resource.close(),{status:'unconfirmed'});
});

test('invalid Native readiness or renderer version never becomes a successful ready result and the late owner is cleaned',async()=>{
 for(const alter of [source=>{source.source.nativeAutopublish=false;},source=>{source.renderer.wasmSha256='invalid';},source=>{source.source.browser.version=()=>'x'.repeat(300);}]){
  const source=live();alter(source);const {resource}=setup(async()=>source);await assert.rejects(resource.initialize());assert.deepEqual(await resource.close(),{status:'closed'});assert.equal(source.closes,1);
 }
});

test('failed close or unretired logical resources do not produce closed attestations',async()=>{
 for(const alter of [source=>{source.close=async()=>{throw new Error('private-close');};},source=>{source.close=async()=>{};},source=>{source.source.broker.pending.set(1,{});}]){
  const source=live();alter(source);const {resource}=setup(async()=>source);await resource.initialize();assert.deepEqual(await resource.close(),{status:'unconfirmed'});
 }
});


test('cancellation before the asynchronous start invocation is known not to allocate',async()=>{
 let calls=0;const {resource,controller}=setup(async()=>{calls++;return live();});const start=resource.initialize();controller.abort();await assert.rejects(start,/cancelled/);assert.deepEqual(await resource.close(),{status:'closed'});assert.equal(calls,0);
});
