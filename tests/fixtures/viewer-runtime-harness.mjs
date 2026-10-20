import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {WebSocket} from 'ws';
import {ViewerConnection,ViewerTicketSource,ViewerConnectionError} from '../../sdk/viewer-connection.mjs';
import {ViewerControlActions} from '../../sdk/viewer-control.mjs';
import {ViewerTelemetry} from '../../sdk/viewer-telemetry.mjs';
import {ViewerLifecycle} from '../../viewer/lifecycle.mjs';
import {loadPublicViewerConfig,PublicViewerConfigError} from '../../viewer/public-config.mjs';
import {attachViewerChild} from '../../viewer/embed-bridge.mjs';
import {LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired} from '../../protocol/live-wire.mjs';
import {audience} from './viewer-access-harness.mjs';
const wasm=Buffer.from('explicit-renderer-fixture-not-real-CanvasKit'),wasmSha256=createHash('sha256').update(wasm).digest('hex');
const [mainSource,workerSource,inputSource]=await Promise.all(['../../viewer/live.mjs','../../viewer/stream-worker.mjs','../../viewer/input.mjs'].map(name=>readFile(new URL(name,import.meta.url),'utf8')));
const executable=(source,viewerBuild='fixture')=>source.replace(/^import .*;\n/gm,'').replaceAll('__REMOTE_PAINT_WASM_SHA__',wasmSha256).replaceAll('__REMOTE_PAINT_VIEWER_BUILD__',viewerBuild);

// Execute the saved main/Worker entry points. Only DOM, CanvasKit/presentation
// and the Worker realm scheduler are fixtures. Socket, ticket authority, Source,
// SQLite and frame validation are real; this is not a rendered-browser test.
function runtime(workerMode,{publicMode=false,viewerBuild='fixture',configFetch,hash='',workerTemplate=workerSource,parentWindow,realInput=false,drawError,initError}={}){
 const stats={live:new Set(),peak:0,draws:0,sockets:[],workers:new Set(),events:[],fetches:[],socketSetupErrors:[]};
 class Memory {constructor(){this.policy={receive:64*1024*1024,js:64*1024*1024};}buffer(){return()=>{};}reserve(){return()=>{};}snapshot(){return{};}observe(){return{};}retire(){}}
 class Renderer {constructor(ck,canvas,{memory}){Object.assign(this,{ck,canvas,memory,stats:{},presentation:{mode:'cpu-2d'}});stats.live.add(this);stats.peak=Math.max(stats.peak,stats.live.size);}draw(){stats.draws++;if(drawError)throw new Error(drawError);}clear(){}retain(){}dispose(){stats.live.delete(this);}}
 class Input {constructor(){this.frame=null;}welcome(message){this.enabled=message.input;}display(frame){this.frame=frame;}reset(){}message(){return false;}bindCanvas(){}}
 class Assets {constructor(){this.bytes=0;this.stats={};}clear(){}dispose(){}}
 class Control {reset(){}open(){return false;}send(){return false;}}
 function target(){const listeners=new Map();return {addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},dispatchEvent(event){for(const fn of [...listeners.get(event.type)??[]])fn(event);return true;}};}
 const elements=new Map(),document={...target(),hidden:false,body:{dataset:{}},querySelector:()=>publicMode?{content:'public'}:null,getElementById:id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);}};
 function element(id){return {...target(),hidden:false,textContent:'',style:{},blur(){},focus(){},replaceChildren(){},append(){},getBoundingClientRect:()=>({left:0,top:0,width:100,height:100}),width:100,height:100,cloneNode(){return element(id);},replaceWith(next){elements.set(id,next);},...(workerMode?{transferControlToOffscreen:()=>({width:100,height:100})}:{})};}
 const window={...target()};window.addEventListener('remote-paint-connection',event=>stats.events.push(event.detail));
 class Socket extends WebSocket {constructor(url){super(url,{origin:audience});stats.sockets.push(this);}}
 // Imported SDK code runs in Node's realm during this harness. Bind the
 // browser realm's Socket explicitly, including its automatic Origin header.
 class RuntimeConnection extends ViewerConnection {constructor(options){super({...options,WebSocket:Socket,onSocket:(...args)=>{try{return options.onSocket(...args);}catch(error){stats.socketSetupErrors.push(error.message);throw error;}}});}}
 const common={console,URL,URLSearchParams,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,AbortSignal,AbortController,performance,crypto:webcrypto,setTimeout,clearTimeout,setInterval,clearInterval,
  location:new URL(audience+'/'+hash),WebSocket:Socket,ViewerConnection:RuntimeConnection,ViewerTicketSource,ViewerConnectionError,loadPublicViewerConfig,PublicViewerConfigError,attachViewerChild,ViewerControlActions,ViewerTelemetry,RendererRuntime:Renderer,ClientMemory:Memory,memoryPolicy:()=>({}),CanvasKitInit:async()=>{if(initError)throw new Error(initError);return{};},
  LIVE_VERSION,LIVE_LIMITS,LiveFrameGate,RecoveryRequired,AssetCache:Assets,isHash:v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),decodeAsset:()=>{throw new Error('Unexpected binary fixture');},parseMetadataJson:text=>({value:JSON.parse(text),byteLength:Buffer.byteLength(text),release(){}}),
  fetch:async(url,options)=>{stats.fetches.push(String(url));if(String(url).endsWith('/viewer-config'))return configFetch(url,options);return {arrayBuffer:async()=>wasm.buffer.slice(wasm.byteOffset,wasm.byteOffset+wasm.byteLength),json:async()=>({nativePort:null})};}};
 class Worker {
  constructor(){
   Object.assign(this,target());this.terminated=false;stats.workers.add(this);const owner=this;
   this.realm={...common,self:{},postMessage(data){if(!owner.terminated)queueMicrotask(()=>{if(!owner.terminated)owner.dispatchEvent({type:'message',data:structuredClone(data)});});},close(){owner.terminated=true;stats.workers.delete(owner);},CanvasKitInit:async()=>{if(owner.terminated)throw new Error('Worker terminated');if(initError)throw new Error(initError);return{};}};
   runInNewContext(executable(workerTemplate,viewerBuild),this.realm,{filename:'saved-viewer-stream-worker.mjs'});
  }
  postMessage(data){if(!this.terminated)queueMicrotask(()=>{if(!this.terminated)void this.realm.self.onmessage({data:structuredClone(data)});});}
  terminate(){if(this.terminated)return;this.terminated=true;stats.workers.delete(this);void this.realm.self.onmessage({data:{type:'stop'}});}
 }
 window.location=common.location;window.parent=parentWindow??window;
 const realm={...common,window,document,CustomEvent:class {constructor(type,{detail}){this.type=type;this.detail=detail;}},ViewerInput:Input,ControlLink:Control,ViewerLifecycle,...(workerMode?{Worker}:{})};
 if(realInput){runInNewContext('(()=>{'+inputSource.replace(/^export /gm,'')+'\nglobalThis.RealViewerInput=ViewerInput;})();',realm,{filename:'saved-viewer-input.mjs'});realm.ViewerInput=class extends realm.RealViewerInput {constructor(options){super(options);stats.input=this;}};}
 runInNewContext(executable(mainSource,viewerBuild),realm,{filename:'saved-viewer-live.mjs'});
 return {window,document,stats,disconnect:()=>window.remotePaintViewer.disconnect()};
}

export {runtime,workerSource,wasmSha256};
