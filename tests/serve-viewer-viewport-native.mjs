// Test-owned actual Native Source/public gateway. The one-row provider below
// is a test adapter, not the pending production Docker Native provider.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdir,readFile,readdir,unlink,appendFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startSessionMemoryFixture} from './session-memory-fixture.mjs';
import {createSessionMemoryOwner} from './session-memory-owner.mjs';
import {SessionRegistry} from '../service/session-registry.mjs';
import {SqliteSessionStore} from '../service/session-store.mjs';
import {ViewerAccess} from '../service/viewer-access.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../service/session-http.mjs';
import {createPublicViewerServer} from '../service/viewer-assets-http.mjs';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {atomicJson,deadline} from './memory-soak-diagnostics.mjs';
assert.equal(process.platform,'linux');assert.notEqual(process.env.REMOTE_PAINT_DATA_PLANE,'node');
const directory=resolve(process.env.REMOTE_PAINT_VIEWPORT_NATIVE_DIR??'artifacts/viewer-viewport-native'),port=Number(process.env.REMOTE_PAINT_VIEWPORT_NATIVE_PORT??40960),runId=randomUUID();
assert.ok(Number.isSafeInteger(port)&&port>1024&&port<65530);await mkdir(directory,{recursive:true,mode:0o700});for(const name of ['requests','responses'])await mkdir(join(directory,name),{recursive:true});
const atomic=(name,value)=>atomicJson(directory,name,value),hash=value=>createHash('sha256').update(value).digest('hex');
const fixture=await startSessionMemoryFixture(),workload=fixture.create(),backendKey=randomBytes(32).toString('hex'),gatewayOrigin=`http://127.0.0.1:${port+2}`,viewerOrigin=`http://127.0.0.1:${port+3}`,hostOrigin=`http://127.0.0.1:${port+4}`;
let owner,source,registry,store,access,gateway,assetsServer,sessionId,closedReceipt,sourceProbe,stopping=false,stopPromise,timer;
const resizes=[],handled=new Set();let resizeCalls=0;
let holdNextResize=false,heldResize=null;
async function installProbe(){
 const lease=source.acquirePageRun();try{return await source.page.evaluate(()=>{
  const encoded=document.createElement('div');encoded.id='viewport-probe';Object.assign(encoded.style,{position:'absolute',left:'520px',top:'30px',width:'24px',height:'24px',zIndex:'30'});document.body.append(encoded);
  const edge=document.createElement('div');edge.id='viewport-edge';Object.assign(edge.style,{position:'fixed',right:'0',bottom:'0',width:'16px',height:'16px',background:'rgb(17,205,61)',zIndex:'30'});document.body.append(edge);
  const glCanvas=document.createElement('canvas');glCanvas.id='viewport-webgl';glCanvas.width=280;glCanvas.height=100;Object.assign(glCanvas.style,{position:'absolute',left:'320px',top:'200px',width:'280px',height:'100px',zIndex:'20'});document.body.append(glCanvas);
  const gl=glCanvas.getContext('webgl2',{preserveDrawingBuffer:true});if(gl){gl.clearColor(.1,.75,.25,1);gl.clear(gl.COLOR_BUFFER_BIT);gl.finish();}
  const normal=document.createElement('canvas');normal.width=64;normal.height=32;Object.assign(normal.style,{position:'absolute',left:'20px',top:'350px',zIndex:'20'});document.body.append(normal);const context=normal.getContext('2d');context.fillStyle='rgb(31,79,191)';context.fillRect(0,0,64,32);
  const resize=()=>{encoded.style.background=`rgb(${innerWidth&255},${innerHeight&255},77)`;};addEventListener('resize',resize);resize();
  const pixel=new Uint8Array(4);if(gl)gl.readPixels(1,1,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
  return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,hasWebGL:!!gl,hasCanvas2D:!!context,webglPixel:Array.from(pixel)};
 });}finally{lease();}
}
async function snapshot(){
 const control=source.control,dom=await source.page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,input:document.querySelector('input').value,cycle:window.cycle}));
 return {pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:source.viewport,inputSeq:source.inputSeq,dom,peers:owner.peers.size,demand:source.demand,control:{mode:control.mode,version:control.version,heldKeys:control.keys.size,heldButtons:control.buttons.size,nextSeq:control.nextSeq,leaseHash:control.lease?hash(control.lease):null},resizeCalls,resizePending:!!control.viewportPending,resizeHeld:!!heldResize,resizes:[...resizes],nativeAutopublish:source.nativeAutopublish,latest:source.latest?{pageEpoch:source.latest.pageEpoch,viewportVersion:source.latest.viewportVersion,viewport:source.latest.viewport,native:source.latest.native}:null};
}
const stop=()=>stopPromise??=(async()=>{
 stopping=true;clearTimeout(timer);heldResize?.();heldResize=null;const errors=[];
 try{access?.close();}catch(error){errors.push({step:'access',error:error.message});}
 for(const [name,server] of [['public-assets',assetsServer],['gateway',gateway]])try{if(server){server.closeAllConnections();if(server.listening)await new Promise((yes,no)=>server.close(error=>error?no(error):yes()));}}catch(error){errors.push({step:name,error:error.message});}
 try{await registry?.shutdown();}catch(error){errors.push({step:'registry',error:error.message});}
 try{if(owner&&!owner.closed)closedReceipt=await owner.close();}catch(error){errors.push({step:'source',error:error.message});}
 try{store?.close();}catch(error){errors.push({step:'store',error:error.message});}
 try{await fixture.close();}catch(error){errors.push({step:'fixture',error:error.message});}
 const value={at:new Date().toISOString(),runId,status:errors.length?'failed':'closed',errors,source:closedReceipt,fixtureListening:fixture.listening,activeFixtureSessions:fixture.activeSessions,gatewayListening:gateway?.listening??false,assetsListening:assetsServer?.listening??false,resizeCalls,resizes};await atomic('source-stopped.json',value);if(errors.length)process.exitCode=1;return value;
})();
try{
 const provider={async create(args){assert.equal(args.url,workload.url());assert.equal(owner,undefined);owner=await createSessionMemoryOwner({create:()=>workload},{port,host:'127.0.0.1'});source=owner.source;await owner.pin();sourceProbe=await installProbe();assert.equal(sourceProbe.hasWebGL,true);assert.equal(sourceProbe.hasCanvas2D,true);
   const resize=source.resize.bind(source);source.resize=async size=>{resizeCalls++;const hold=holdNextResize;holdNextResize=false;const before={pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion};await resize(size);resizes.push({requested:{...size},before,after:{pageEpoch:source.pageEpoch,viewportVersion:source.viewportVersion,viewport:{...source.viewport}},testHoldAfterActualNativeApplied:hold});assert.ok(resizes.length<=64);if(hold)await new Promise(resolve=>heldResize=resolve);};
   return {version:'native-viewport-contract-v1'};},async close(){if(owner)closedReceipt=await owner.close();assert.equal(closedReceipt?.status,'closed');return {status:'closed'};}};
 store=new SqliteSessionStore({path:join(directory,'session.sqlite')});registry=new SessionRegistry({providers:new Map([['native-contract',provider]]),defaultRegion:'native-contract',store});const created=registry.create('native-test',{url:workload.url(),ttlSeconds:900},{idempotencyKey:'native-viewport-contract'});sessionId=created.sessionId;
 const end=performance.now()+60000;while(registry.getSession('native-test',sessionId).state==='creating'){assert.ok(performance.now()<end,'Native Source startup deadline');await delay(20);}registry.requireReady('native-test',sessionId);
 const privateKey=new URLSearchParams(new URL(owner.url).hash.slice(1)).get('key');
 access=new ViewerAccess({registry,resolveSource:async binding=>({tenantId:binding.tenantId,sessionId:binding.sessionId,region:binding.region,version:binding.version,origin:owner.origin,streamOrigin:owner.streamOrigin,key:privateKey})});
 const auth=createApiKeyAuthenticator([{apiKey:backendKey,tenantId:'native-test',scopes:['sessions:read','viewers:read','viewers:control']}]);gateway=createSessionControlServer({registry,authenticate:auth,viewerAccess:access});gateway.listen(port+2,'0.0.0.0');await once(gateway,'listening');
 const assets=await prepareViewerAssets({mode:'public'});assetsServer=await createPublicViewerServer({gatewayOrigin,allowedParentOrigins:[hostOrigin],preparedAssets:assets});assetsServer.listen(port+3,'0.0.0.0');await once(assetsServer,'listening');
 const brokerSha256=hash(await readFile('/proc/'+source.broker.child.pid+'/exe'));assert.equal(brokerSha256,process.env.REMOTE_PAINT_EXPECTED_BROKER_SHA256);
 await atomic('ready.json',{at:new Date().toISOString(),runId,sessionId,backendKey,gatewayOrigin,viewerOrigin,hostOrigin,viewerBuild:assets.build,wasmSha256:assets.wasmSha256,sourceBrowser:source.browser.version(),brokerSha256,sourceProbe,number:owner.number,scope:'Actual NativeSource/capture/Rust/HTTP gateway/public assets; test-only one-row Session provider,not production Native endpoint integration'});console.log(JSON.stringify({event:'native-public-ready',runId}));
}catch(error){await atomic('source-failure.json',{at:new Date().toISOString(),error:error.stack});await stop();throw error;}
async function operation(command){
 if(command.op==='snapshot')return snapshot();
 if(command.op==='update'){assert.ok(Number.isSafeInteger(command.cycle)&&command.cycle>=0&&command.cycle<65536);await owner.update(command.cycle);return {cycle:command.cycle};}
 if(command.op==='metrics')return owner.measure();
 if(command.op==='hold-next-resize'){assert.equal(holdNextResize,false);assert.equal(heldResize,null);holdNextResize=true;return {armed:true,scope:'Explicit test gate after actual Native resize barrier,not a Native stall'};}
 if(command.op==='release-resize'){heldResize?.();heldResize=null;return {released:true};}
 if(command.op==='stop')return stop();
 throw new Error('Unknown Native viewport test command');
}
async function poll(){try{for(const name of await readdir(join(directory,'requests'))){if(stopping)break;if(!/^[a-f0-9-]{36}\.json$/.test(name)||handled.has(name))continue;const command=JSON.parse(await readFile(join(directory,'requests',name),'utf8'));assert.equal(command.runId,runId);assert.equal(command.id+'.json',name);assert.ok(handled.size<256);handled.add(name);
 try{const value=await deadline(operation(command),30000,'Native viewport command');await atomic('responses/'+name,{id:command.id,value});}catch(error){await appendFile(join(directory,'command-errors.jsonl'),JSON.stringify({id:command.id,op:command.op,error:error.stack})+'\n');await atomic('responses/'+name,{id:command.id,error:'NATIVE_VIEWPORT_CONTRACT_FAILED'});}
 }}catch(error){await atomic('poll-failure.json',{error:error.stack});await stop();process.exitCode=1;}finally{if(!stopping)timer=setTimeout(()=>void poll(),20);}}
void poll();process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
