import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {EventEmitter,once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {runSessionWorker} from '../service/session-worker.mjs';
import {NativeSessionResource} from '../service/native-session-resource.mjs';
import {startLiveTransport} from '../live/transport.mjs';
let derive;try{({deriveNativeTransportKey:derive}=await import('../service/native-transport-key.mjs'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const ownerKey='a'.repeat(64),context={ownerKey,sessionId:'ses_fixture',tenantId:'a',region:'test'},transportKey='2a395cfe440399a197af01fea9bf2e2be3cd31d96c762e8fb5d64c9449ea6047';
const identity={sessionId:context.sessionId,tenantId:context.tenantId,region:context.region,ownerKeyHash:createHash('sha256').update(ownerKey).digest('hex')};
const request={url:'https://example.test/private-bootstrap-fixture',region:'test',ttlSeconds:60};
async function until(check){for(let n=0;n<300;n++){if(check())return;await delay(5);}assert.fail('Private bootstrap deadline');}
function worker(t,{deriveResourceSecret,createResource}={}){
 const input=new PassThrough(),output=new PassThrough(),owner=new EventEmitter(),messages=[],contexts=[];let text='';output.on('data',bytes=>{text+=bytes;for(let i;(i=text.indexOf('\n'))>=0;){messages.push(JSON.parse(text.slice(0,i)));text=text.slice(i+1);}});
 const value=runSessionWorker({identity,input,output,owner,deriveResourceSecret,ownerLeaseMs:500,createResource:createResource??(value=>{contexts.push(value);return {initialize:async()=>({version:'bootstrap-fixture',ignoredPrivate:transportKey}),close:async()=>({status:'closed'})};})});
 t.after(async()=>{await value.stop();input.destroy();output.destroy();});return {value,messages,contexts,send(value){input.write(JSON.stringify({sessionId:identity.sessionId,ownerKey,...value})+'\n');}};
}
test('private Native transport derivation matches an independent Python HMAC vector and separates every authority component',()=>{
 assert.equal(typeof derive,'function');assert.equal(derive(context),transportKey);assert.notEqual(transportKey,ownerKey);for(const extra of [{ownerKey:'b'.repeat(64)},{sessionId:'ses_other'},{tenantId:'b'},{region:'other'}])assert.notEqual(derive({...context,...extra}),transportKey);
});
test('private key derivation rejects extra fields and accessors before evaluating a private getter',()=>{
 assert.equal(typeof derive,'function');let touched=false;const accessor=Object.defineProperty({...context},'ownerKey',{get(){touched=true;throw Error('private-key-getter');}});for(const value of [null,{...context,url:request.url},{...context,ownerKey:'short'},{...context,sessionId:'bad'},{...context,tenantId:''},{...context,region:''},accessor])assert.throws(()=>derive(value),TypeError);assert.equal(touched,false);
});
test('worker derives a secret only after validated owner Start and keeps Ready strictly version-only',async t=>{
 const seen=[],h=worker(t,{deriveResourceSecret:value=>{seen.push(value);assert.deepEqual(value,context);return transportKey;}});assert.equal(seen.length,0);h.send({type:'Start',request});await until(()=>h.messages.some(x=>x.type==='Ready'));assert.equal(seen.length,1);assert.equal(h.contexts[0].resourceSecret,transportKey);assert.ok(!Object.hasOwn(h.contexts[0],'ownerKey'));assert.deepEqual(h.messages.find(x=>x.type==='Ready'),{protocol:'session-worker-v1',sessionId:identity.sessionId,type:'Ready',version:'bootstrap-fixture'});assert.ok(!JSON.stringify(h.messages).includes(transportKey));assert.ok(!JSON.stringify(h.messages).includes(ownerKey));assert.ok(!JSON.stringify(h.messages).includes(request.url));h.send({type:'Close'});assert.equal((await h.value.done).exitCode,0);
});
test('wrong owner and extra Start request fields cannot invoke the private derivation hook',async t=>{
 for(const extra of [{ownerKey:'b'.repeat(64)},{request:{...request,transportKey}}]){let calls=0;const h=worker(t,{deriveResourceSecret:()=>{calls++;return transportKey;}});h.send({type:'Start',request,...extra});assert.equal((await h.value.done).exitCode,1);assert.equal(calls,0);assert.equal(h.contexts.length,0);}
});
test('throwing, invalid and asynchronous derivations cannot allocate or leak a secret',async t=>{
 for(const hook of [()=>{throw Error(transportKey);},()=>null,()=>Promise.reject(Error(transportKey)),()=>({key:transportKey})]){const h=worker(t,{deriveResourceSecret:hook});h.send({type:'Start',request});assert.equal((await h.value.done).exitCode,1);assert.equal(h.contexts.length,0);assert.ok(!JSON.stringify(h.messages).includes(transportKey));assert.equal(h.messages.at(-1).code,'WORKER_RESOURCE_FACTORY_FAILED');}
});
test('generic worker factories receive no Native secret without an explicit trusted hook',async t=>{
 const h=worker(t);h.send({type:'Start',request});await until(()=>h.messages.some(x=>x.type==='Ready'));assert.ok(!Object.hasOwn(h.contexts[0],'resourceSecret'));h.send({type:'Close'});assert.equal((await h.value.done).exitCode,0);
});
function nativeLive(){const source={nativeAutopublish:true,broker:{exited:false,pending:new Map()},control:{},browser:{version:()=> 'bootstrap-native-fixture',isConnected:()=>!source.closed},capture:{binding:{}},latest:{},producer:'fixture',demand:1,encodeDemand:1,activityDemand:1,closed:false};return {key:transportKey,source,renderer:{wasmSha256:'a'.repeat(64)},peers:new Set(),async close(){Object.assign(source,{closed:true,latest:null,producer:null,demand:0,encodeDemand:0,activityDemand:0});source.capture.binding=null;source.broker.exited=true;}};}
test('Native resource passes a validated private transport key to its owner factory without returning it in Ready',async()=>{
 const live=nativeLive(),seen=[],resource=new NativeSessionResource({request,signal:new AbortController().signal,transportKey,startLive:async value=>{seen.push(value);return live;}});try{const ready=await resource.initialize();assert.deepEqual(seen,[{url:request.url,transportKey}]);assert.deepEqual(Object.keys(ready),['version']);assert.ok(!JSON.stringify(ready).includes(transportKey));}finally{assert.deepEqual(await resource.close(),{status:'closed'});}
});
test('Native resource rejects invalid private key configuration before allocation',()=>{
 for(const value of ['bad',null,7])assert.throws(()=>new NativeSessionResource({request,signal:new AbortController().signal,transportKey:value,startLive:async()=>nativeLive()}),TypeError);
});
test('Native resource cannot acknowledge Ready when its started transport omits or changes the private key',async()=>{
 for(const key of [undefined,'b'.repeat(64)]){const live=nativeLive();live.key=key;const resource=new NativeSessionResource({request,signal:new AbortController().signal,transportKey,startLive:async()=>live});try{await assert.rejects(resource.initialize());}finally{assert.deepEqual(await resource.close(),{status:'closed'});assert.equal(live.source.closed,true);}}
});
const assets={wasmSha256:'a'.repeat(64),build:'bootstrap-fixture',get:()=>null};
function source(){const s=new EventEmitter();s.setDemand=()=>{};s.closed=false;return s;}
test('actual private WebSocket accepts only the injected stream key and required Origin; HTTP config omits it',async t=>{
 const transport=await startLiveTransport(source(),{port:0,transportKey,preparedAssets:assets});t.after(()=>transport.close());assert.equal(transport.key,transportKey);assert.ok(!(await(await fetch(transport.origin+'/session-config')).text()).includes(transportKey));
 for(const [key,origin]of [['b'.repeat(64),transport.origin],[transportKey,'http://other.test']])await new Promise((resolve,reject)=>{const ws=new WebSocket(transport.origin.replace('http:','ws:')+'/stream?key='+key,{origin});ws.on('error',()=>{});ws.on('open',()=>{ws.terminate();reject(Error('Unauthorized socket opened'));});ws.on('unexpected-response',(_req,res)=>{assert.equal(res.statusCode,403);res.resume();ws.terminate();resolve();});});
 const ws=new WebSocket(transport.origin.replace('http:','ws:')+'/stream?key='+transportKey,{origin:transport.origin});t.after(()=>ws.terminate());await once(ws,'open');const closed=once(ws,'close');ws.close();await closed;
});
test('Native broker adapter receives the explicit internal port and private key rather than ambient defaults',async t=>{
 const s=source(),calls=[];s.broker=new EventEmitter();s.broker.request=async(method,value)=>{calls.push({method,value});return method==='listen'?{port:4176}:{};};const transport=await startLiveTransport(s,{port:0,nativePort:4176,transportKey,preparedAssets:assets});t.after(()=>transport.close());const listen=calls.find(x=>x.method==='listen');assert.equal(listen.value.config.port,4176);assert.equal(listen.value.config.key,transportKey);assert.equal(listen.value.config.origin,transport.origin);assert.equal(transport.streamOrigin,'http://127.0.0.1:4176');
});
test('invalid internal port and transport key reject before accessing Source or assets',async()=>{
 let touched=false;const s={get browser(){touched=true;throw Error('Source touched');}},preparedAssets={get wasmSha256(){touched=true;throw Error('Asset touched');}};for(const options of [{transportKey:'bad'},{transportKey:null},{nativePort:-1},{nativePort:65536},{nativePort:'4176'},{nativePort:NaN}])await assert.rejects(startLiveTransport(s,{port:0,...options,preparedAssets}),TypeError);assert.equal(touched,false);
});
