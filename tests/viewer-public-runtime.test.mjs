import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {ViewerConnection,ViewerTicketSource,ViewerConnectionError} from '../sdk/viewer-connection.mjs';
import {ViewerLifecycle} from '../viewer/lifecycle.mjs';
import {instrumentFrameAgeWorker} from './frame-age-observer.mjs';
import {loadPublicViewerConfig,PublicViewerConfigError} from '../viewer/public-config.mjs';
import {LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired} from '../protocol/live-wire.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
const wasm=Buffer.from('explicit-renderer-fixture-not-real-CanvasKit'),wasmSha256=createHash('sha256').update(wasm).digest('hex');
const [mainSource,workerSource]=await Promise.all(['../viewer/live.mjs','../viewer/stream-worker.mjs'].map(name=>readFile(new URL(name,import.meta.url),'utf8')));
const executable=(source,viewerBuild='fixture')=>source.replace(/^import .*;\n/gm,'').replaceAll('__REMOTE_PAINT_WASM_SHA__',wasmSha256).replaceAll('__REMOTE_PAINT_VIEWER_BUILD__',viewerBuild);
async function until(check){for(let i=0;i<400;i++){if(check())return;await delay(5);}assert.fail('Runtime condition deadline');}

// Execute the saved main/Worker entry points. Only DOM, CanvasKit/presentation
// and the Worker realm scheduler are fixtures. Socket, ticket authority, Source,
// SQLite and frame validation are real; this is not a rendered-browser test.
function runtime(workerMode,{publicMode=false,viewerBuild='fixture',configFetch,hash='',workerTemplate=workerSource}={}){
 const stats={live:new Set(),peak:0,draws:0,sockets:[],workers:new Set(),events:[],fetches:[],socketSetupErrors:[]};
 class Memory {constructor(){this.policy={receive:64*1024*1024,js:64*1024*1024};}buffer(){return()=>{};}reserve(){return()=>{};}snapshot(){return{};}observe(){return{};}retire(){}}
 class Renderer {constructor(ck,canvas,{memory}){Object.assign(this,{ck,canvas,memory,stats:{},presentation:{mode:'fixture'}});stats.live.add(this);stats.peak=Math.max(stats.peak,stats.live.size);}draw(){stats.draws++;}clear(){}retain(){}dispose(){stats.live.delete(this);}}
 class Input {constructor(){this.frame=null;}welcome(message){this.enabled=message.input;}display(frame){this.frame=frame;}reset(){}message(){return false;}bindCanvas(){}}
 class Assets {constructor(){this.bytes=0;this.stats={};}clear(){}dispose(){}}
 class Control {reset(){}open(){return false;}send(){return false;}}
 function target(){const listeners=new Map();return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},dispatchEvent(event){for(const fn of [...listeners.get(event.type)??[]])fn(event);return true;}};}
 const elements=new Map(),document={...target(),hidden:false,body:{dataset:{}},querySelector:()=>publicMode?{content:'public'}:null,getElementById:id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);}};
 function element(id){return {...target(),hidden:false,textContent:'',style:{},width:100,height:100,cloneNode(){return element(id);},replaceWith(next){elements.set(id,next);},...(workerMode?{transferControlToOffscreen:()=>({width:100,height:100})}:{})};}
 const window={...target()};window.addEventListener('remote-paint-connection',event=>stats.events.push(event.detail));
 class Socket extends WebSocket {constructor(url){super(url,{origin:audience});stats.sockets.push(this);}}
 // Imported SDK code runs in Node's realm during this harness. Bind the
 // browser realm's Socket explicitly, including its automatic Origin header.
 class RuntimeConnection extends ViewerConnection {constructor(options){super({...options,WebSocket:Socket,onSocket:(...args)=>{try{return options.onSocket(...args);}catch(error){stats.socketSetupErrors.push(error.message);throw error;}}});}}
 const common={console,URL,URLSearchParams,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,AbortSignal,AbortController,performance,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
  location:new URL(audience+'/'+hash),WebSocket:Socket,ViewerConnection:RuntimeConnection,ViewerTicketSource,ViewerConnectionError,loadPublicViewerConfig,PublicViewerConfigError,RendererRuntime:Renderer,ClientMemory:Memory,memoryPolicy:()=>({}),CanvasKitInit:async()=>({}),
  LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired,AssetCache:Assets,isHash:v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),decodeAsset:()=>{throw new Error('Unexpected binary fixture');},parseMetadataJson:text=>({value:JSON.parse(text),byteLength:Buffer.byteLength(text),release(){}}),
  fetch:async(url,options)=>{stats.fetches.push(String(url));if(String(url).endsWith('/viewer-config'))return configFetch(url,options);return {arrayBuffer:async()=>wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength),json:async()=>({nativePort:null})};}};
 class Worker {
  constructor(){
   Object.assign(this,target());this.terminated=false;stats.workers.add(this);const owner=this;
   this.realm={...common,self:{},postMessage(data){if(!owner.terminated)queueMicrotask(()=>{if(!owner.terminated)owner.dispatchEvent({type:'message',data:structuredClone(data)});});},close(){owner.terminated=true;stats.workers.delete(owner);},CanvasKitInit:async()=>{if(owner.terminated)throw new Error('Worker terminated');return{};}};
   runInNewContext(executable(workerTemplate,viewerBuild),this.realm,{filename:'saved-viewer-stream-worker.mjs'});
  }
  postMessage(data){if(!this.terminated)queueMicrotask(()=>{if(!this.terminated)void this.realm.self.onmessage({data:structuredClone(data)});});}
  terminate(){if(this.terminated)return;this.terminated=true;stats.workers.delete(this);void this.realm.self.onmessage({data:{type:'stop'}});}
 }
 const realm={...common,window,document,CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},ViewerInput:Input,ControlLink:Control,ViewerLifecycle,...(workerMode?{Worker}:{})};
 runInNewContext(executable(mainSource,viewerBuild),realm,{filename:'saved-viewer-live.mjs'});
 return {window,document,stats,disconnect:()=>window.remotePaintViewer.disconnect()};
}

for(const workerMode of [false,true])test(`saved ${workerMode?'Worker':'main'} Viewer uses public tickets for frames, refresh, disconnect and resume fencing`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),r=runtime(workerMode);t.after(r.disconnect);let calls=0;
 let getterRead=false;assert.throws(()=>r.window.remotePaintViewer.connect(Object.defineProperty({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly'},'getTicket',{enumerable:true,get(){getterRead=true;return()=>h.issue();}})),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(getterRead,false);
 const options={gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async request=>{calls++;if(request.previousGrantId){const response=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{ttlSeconds:1}});assert.equal(response.status,200);return response.data;}return h.issue('readonly',{ttlSeconds:1});}};
 r.window.remotePaintViewer.connect(options);await until(()=>r.window.remotePaintResult?.frameId===1).catch(()=>assert.fail(JSON.stringify({error:r.document.getElementById('error').textContent,state:r.window.remotePaintConnection,lifecycle:r.window.remotePaintLifecycle})));assert.equal(r.window.remotePaintConnection.state,'connected');assert.equal(r.window.remotePaintConnection.role,'readonly');assert.ok(r.stats.draws>0);
 await until(()=>calls>=2&&r.stats.events.filter(e=>e.state==='connected').length>=2);assert.equal(r.window.remotePaintConnection.sessionId,h.sessionId);assert.ok(!JSON.stringify(r.stats.events).includes(h.transport.key));
 r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);const count=r.stats.sockets.length;
 r.document.dispatchEvent({type:'resume'});r.window.dispatchEvent({type:'pageshow'});r.window.dispatchEvent({type:'online'});await delay(30);assert.equal(r.stats.sockets.length,count);assert.equal(r.window.remotePaintViewer.state.state,'paused');
 r.window.remotePaintViewer.connect(options);await until(()=>r.stats.sockets.length>count&&r.window.remotePaintResult?.frameId===1);r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);assert.ok(r.stats.peak<=1,'one renderer per Viewer lifecycle');
});

for(const workerMode of [false,true])test(`saved ${workerMode?'Worker':'main'} Viewer discards late callback access after disconnect`,{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),r=runtime(workerMode),gate=pending(),started=pending();t.after(r.disconnect);
 r.window.remotePaintViewer.connect({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async()=>{started.resolve();await gate.promise;return h.issue();}});
 await started.promise;r.disconnect();gate.resolve();await delay(40);assert.equal(r.stats.sockets.length,0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);assert.equal(h.resolutions.length,0);
});

for(const workerMode of [false,true])test(`public ${workerMode?'Worker':'main'} boot waits for metadata and authorization without private key fallback`,{skip:!sessionStoreSupported},async t=>{
 const build='b'.repeat(64),h=await fixture(t,{wasmSha256,viewerBuild:build}),gate=pending(),r=runtime(workerMode,{publicMode:true,viewerBuild:build,hash:'#key=private-must-be-ignored',configFetch:async()=>gate.promise});t.after(r.disconnect);let tickets=0;
 const options={gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:async()=>{tickets++;return h.issue();}};
 assert.throws(()=>r.window.remotePaintViewer.connect(options),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(r.window.remotePaintViewer.state.state,'waiting');
 gate.resolve(new Response(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:h.base,allowedParentOrigins:[audience],viewerBuild:build}),{headers:{'content-type':'application/json'}}));
 const config=await r.window.remotePaintViewer.ready;assert.equal(config.gatewayOrigin,h.base);assert.ok(Object.isFrozen(config));
 for(const event of ['pageshow','online'])r.window.dispatchEvent({type:event});r.document.dispatchEvent({type:'resume'});await delay(20);
 assert.equal(tickets,0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);assert.equal(r.stats.sockets.length,0);assert.deepEqual(r.stats.fetches,[audience+'/viewer-config']);assert.equal(h.resolutions.length,0);
 assert.throws(()=>r.window.remotePaintViewer.connect({...options,gatewayOrigin:'https://wrong-gateway.example'}),e=>e.code==='VIEWER_INVALID_CONFIG');assert.equal(tickets,0);
 r.window.remotePaintViewer.connect(options);await until(()=>r.window.remotePaintResult?.frameId===1);assert.equal(r.window.remotePaintConnection.state,'connected');assert.equal(tickets,1);assert.ok(!r.stats.fetches.some(url=>url.includes('/session-config')));r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);assert.equal(r.stats.workers.size,0);
});

test('public metadata build mismatch leaves the saved entry frozen with no private connection attempt',async t=>{
 const r=runtime(false,{publicMode:true,viewerBuild:'b'.repeat(64),hash:'#key=private-must-be-ignored',configFetch:async()=>new Response(JSON.stringify({schema:'public-viewer-v1',gatewayOrigin:'https://gateway.example',allowedParentOrigins:[audience],viewerBuild:'c'.repeat(64)}),{headers:{'content-type':'application/json'}})});t.after(r.disconnect);
 await assert.rejects(r.window.remotePaintViewer.ready,e=>e.code==='VIEWER_CONFIG_INVALID');r.window.dispatchEvent({type:'online'});r.document.dispatchEvent({type:'resume'});await delay(20);assert.equal(r.stats.live.size,0);assert.equal(r.stats.sockets.length,0);assert.equal(r.window.remotePaintViewer.state.state,'failed');assert.equal(r.window.remotePaintViewer.state.code,'VIEWER_CONFIG_INVALID');assert.deepEqual(r.stats.fetches,[audience+'/viewer-config']);
});

test('current frame-age instrumented Worker reaches a real Node frame after the connection refactor',{skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256}),workerTemplate=instrumentFrameAgeWorker(workerSource,[[1,1]]),r=runtime(true,{workerTemplate});t.after(r.disconnect);
 r.window.remotePaintViewer.connect({gatewayOrigin:h.base,sessionId:h.sessionId,role:'readonly',getTicket:()=>h.issue()});await until(()=>r.window.remotePaintResult?.frameId===1).catch(()=>assert.fail(JSON.stringify({socketSetupErrors:r.stats.socketSetupErrors,state:r.window.remotePaintConnection})));
 assert.deepEqual(r.stats.socketSetupErrors,[]);r.disconnect();await until(()=>h.transport.peers.size===0);assert.equal(r.stats.live.size,0);
});
