import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {SessionRegistry} from '../../service/session-registry.mjs';
import {SqliteSessionStore} from '../../service/session-store.mjs';
import {createSessionControlServer,createApiKeyAuthenticator} from '../../service/session-http.mjs';
import {ViewerAccess} from '../../service/viewer-access.mjs';
import {startLiveTransport} from '../../live/transport.mjs';
import {ControlLease} from '../../live/input.mjs';
export const KEY='viewer_fixture_backend_key_owner_000000',READ='viewer_fixture_backend_key_read_0000000',OTHER='viewer_fixture_backend_key_other_000000';
export const audience='https://embed.example',renderer={canvaskit:'0.42.0',wasmSha256:'a'.repeat(64)};
export const flush=()=>new Promise(setImmediate),pending=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function inbox(ws){
 const messages=[],waiters=[];let closed=false;
 ws.on('message',(bytes,binary)=>{const value=binary?{binary:true}:JSON.parse(bytes.toString());messages.push(value);for(const item of [...waiters])if(item.predicate(value)){waiters.splice(waiters.indexOf(item),1);clearTimeout(item.timer);item.resolve(value);}});
 ws.on('close',()=>{closed=true;for(const item of waiters.splice(0)){clearTimeout(item.timer);item.reject(new Error('Socket closed'));}});
 return {messages,wait(predicate,after=0){const found=messages.slice(after).find(predicate);if(found)return Promise.resolve(found);if(closed)return Promise.reject(new Error('Socket closed'));return new Promise((resolve,reject)=>{const item={predicate,resolve,reject};item.timer=setTimeout(()=>{waiters.splice(waiters.indexOf(item),1);reject(new Error('Message deadline'));},2000);waiters.push(item);});}};
}
export async function fixture(t,{accessOptions={},resolveSource,ttlSeconds=30,wasmSha256=renderer.wasmSha256,viewerBuild='fixture'}={}){
 const directory=await mkdtemp(join(tmpdir(),'remote-paint-viewer-access-'));let access,registry,server,transport,store;const clients=new Set(),calls=[],resolutions=[];
 t.after(async()=>{for(const ws of clients)ws.terminate();access?.close();if(server){server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));}try{await registry?.shutdown();await transport?.close();await source.control?.close();}finally{store?.close();await rm(directory,{recursive:true,force:true});}});
 const source=new EventEmitter();source.viewport={cssWidth:100,cssHeight:100,deviceScaleFactor:1};source.pageEpoch=1;source.viewportVersion=1;source.inputSeq=0;source.setDemand=()=>{};source.requestCapture=()=>{};source.page={evaluate:async()=>null};
 source.latest={pageEpoch:1,viewportVersion:1,viewport:source.viewport,lastProcessedInputSeq:0,native:{},payloads:new Map(),scene:{rootPass:'root',passes:[{id:'root',output:[0,0,100,100],quads:[]}]}};
 source.control=new ControlLease(source,{send:async(method,params)=>{calls.push({method,params});}});
 transport=await startLiveTransport(source,{port:0,preparedAssets:{wasmSha256,build:viewerBuild,get:()=>null}});
 store=new SqliteSessionStore({path:join(directory,'session.sqlite')});registry=new SessionRegistry({providers:new Map([['test',{create:async()=>({version:'viewer-source-v1'}),close:async()=>({status:'closed'})}]]),defaultRegion:'test',store});
 access=new ViewerAccess({registry,resolveSource:async args=>{resolutions.push(args);if(resolveSource)return resolveSource(args,{transport,source});return {tenantId:args.tenantId,sessionId:args.sessionId,region:args.region,version:args.version,...transport};},...accessOptions});
 const auth=createApiKeyAuthenticator([{apiKey:KEY,tenantId:'a',scopes:['sessions:create','sessions:read','sessions:release','viewers:read','viewers:control']},{apiKey:READ,tenantId:'a',scopes:['sessions:read','viewers:read']},{apiKey:OTHER,tenantId:'b',scopes:['viewers:read','viewers:control']}]);
 server=createSessionControlServer({registry,authenticate:auth,viewerAccess:access});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const api=async(path,{method='GET',body,key=KEY,headers={}}={})=>{const response=await fetch(base+path,{method,headers:{authorization:'Bearer '+key,...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return {status:response.status,text,...JSON.parse(text)};};
 const created=registry.create('a',{ttlSeconds},{idempotencyKey:'viewer-access'});await flush();const sessionId=created.sessionId;assert.equal(registry.requireReady('a',sessionId).state,'ready');const tickets='/v1/sessions/'+sessionId+'/viewer-tickets';
 const issue=async(role='readonly',extra={},options={})=>{const response=await api(tickets,{method:'POST',body:{role,audience,...extra},...options});assert.equal(response.status,200,response.text);return response.data;};
 const connect=async(grant,{origin=audience,hello={},sendHello=true}={})=>{
  const ws=new WebSocket(base.replace('http:','ws:')+grant.streamPath,{origin});clients.add(ws);ws.on('error',()=>{});const received=inbox(ws);await once(ws,'open');
  if(sendHello)ws.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:['control-channel-v1','input-feedback-v1'],...hello}));return {ws,...received};
 };
 const denied=(path,origin=audience)=>new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+path,{origin});clients.add(ws);ws.on('error',reject);ws.on('open',()=>{ws.terminate();reject(new Error('Unauthorized Viewer connected'));});ws.on('unexpected-response',(_req,res)=>{const status=res.statusCode;res.resume();ws.terminate();resolve(status);});});
 return {access,registry,source,transport,calls,resolutions,api,issue,connect,denied,sessionId,tickets,base};
}
