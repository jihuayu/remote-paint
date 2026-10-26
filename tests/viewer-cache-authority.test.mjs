import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {ViewerAccess} from '../service/viewer-access.mjs';
import {ViewerConnection} from '../sdk/viewer-connection.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {fixture,audience,renderer,OTHER,flush} from './fixtures/viewer-access-harness.mjs';
const enabled={skip:!sessionStoreSupported},isWelcome=m=>m.type==='Welcome';
async function until(predicate){const deadline=performance.now()+2000;while(!predicate()){assert.ok(performance.now()<deadline,'Cache authority observation deadline');await delay(5);}}
async function namespace(h,grant,hello={}){const client=await h.connect(grant,{origin:grant.audience,hello}),welcome=await client.wait(isWelcome);const closed=once(client.ws,'close');client.ws.close();await closed;return welcome.resourceCache.namespace;}
function client(t,h,{accept,onCacheState,...options}={}){
 const states=[],cache=[],messages=[],requests=[],sockets=[],authorizations=[];
 class PublicSocket extends WebSocket{constructor(url){super(url,{origin:audience});sockets.push(this);}}
 const connection=new ViewerConnection({gatewayOrigin:h.base,audience,sessionId:h.sessionId,role:'readonly',WebSocket:PublicSocket,
  getTicket:async request=>{requests.push(request);if(request.previousGrantId){const r=await h.api(h.tickets+'/'+request.previousGrantId+'/refresh',{method:'POST',body:{}});assert.equal(r.status,200);return r.data;}return h.issue();},
  onCacheState:event=>{cache.push(event);onCacheState?.(event);},onState:state=>states.push(state),
  onSocket:(socket,grant,control)=>{authorizations.push({grant,control});socket.onopen=()=>socket.send(JSON.stringify({type:'Hello',protocol:4,renderer}));socket.onmessage=event=>{const message=JSON.parse(event.data);try{if(isWelcome(message)){if(accept)accept(message,control);else control.acceptWelcome(message);}if(message.type==='FrameCommit')socket.send(JSON.stringify({type:'FrameAck',frameId:message.frameId,pageEpoch:message.pageEpoch}));messages.push(message);}catch{socket.close(4008,'Rejected Viewer metadata');}};},...options});
 t.after(()=>{connection.destroy();for(const ws of sockets)ws.terminate();});return {connection,states,cache,messages,requests,authorizations};
}

test('the public proxy selects opaque cache scope across tenants sessions roles and origins without trusting caller cache fields',enabled,async t=>{
 const h=await fixture(t),first=await h.issue(),scope=await namespace(h,first,{resourceCache:{namespace:'vrc1_'+'0'.repeat(64)}});assert.match(scope,/^vrc1_[a-f0-9]{64}$/);assert.notEqual(scope,'vrc1_'+'0'.repeat(64));
 assert.equal(await namespace(h,await h.issue()),scope);assert.notEqual(await namespace(h,await h.issue('controller')),scope);assert.notEqual(await namespace(h,await h.issue('readonly',{audience:'https://other.example'})),scope);
 assert.equal((await h.api(h.tickets,{method:'POST',key:OTHER,body:{role:'readonly',audience}})).status,404);
 assert.equal((await h.api(h.tickets,{method:'POST',body:{role:'readonly',audience,resourceCache:{namespace:scope}}})).status,400);
 const other=h.registry.create('b',{ttlSeconds:30},{idempotencyKey:'cache-other-tenant'});await flush();const reply=await h.api('/v1/sessions/'+other.sessionId+'/viewer-tickets',{method:'POST',key:OTHER,body:{role:'readonly',audience}});assert.equal(reply.status,200);assert.notEqual(await namespace(h,reply.data),scope);
 assert.equal(Object.hasOwn(first,'resourceCache'),false);assert.equal(JSON.stringify(first).includes(scope),false);
});

test('replacing the grant authority changes the cache scope for the same current Session and role',enabled,async t=>{
 const h=await fixture(t),scope=await namespace(h,await h.issue()),replacement=new ViewerAccess({registry:h.registry,resolveSource:args=>({tenantId:args.tenantId,sessionId:args.sessionId,region:args.region,version:args.version,...h.transport})}),server=createServer();let ws;
 t.after(async()=>{ws?.terminate();replacement.close();server.closeAllConnections();if(server.listening)await new Promise(resolve=>server.close(resolve));});server.on('upgrade',(req,socket,head)=>replacement.handleUpgrade(req,socket,head));server.listen(0,'127.0.0.1');await once(server,'listening');
 const grant=replacement.issue({tenantId:'a',sessionId:h.sessionId,role:'readonly',audience});ws=new WebSocket('ws://127.0.0.1:'+server.address().port+grant.streamPath,{origin:audience});const message=once(ws,'message',{signal:AbortSignal.timeout(2000)});await once(ws,'open');ws.send(JSON.stringify({type:'Hello',protocol:4,renderer}));const welcome=JSON.parse((await message)[0].toString());assert.equal(welcome.viewerSessionId,h.sessionId);assert.notEqual(welcome.resourceCache.namespace,scope);
});

test('cache scope changes when the trusted Ready snapshot version or incarnation changes',enabled,async t=>{
 const h=await fixture(t),before=await namespace(h,await h.issue()),ready=h.registry.requireReady.bind(h.registry);let version='viewer-source-v2',readyAt=ready('a',h.sessionId).readyAt;
 h.registry.requireReady=(...args)=>({...ready(...args),version,readyAt});try{const changed=await namespace(h,await h.issue());assert.notEqual(changed,before);readyAt=new Date(Date.parse(readyAt)+1).toISOString();assert.notEqual(await namespace(h,await h.issue()),changed);}finally{h.registry.requireReady=ready;}
});

test('cache permission requires the fresh matching Welcome and is deeply immutable without exposing ticket credentials',enabled,async t=>{
 const h=await fixture(t);let held;const n=client(t,h,{accept:(message,control)=>{held={message,control};}});await n.connection.start();await until(()=>held);assert.equal(n.connection.resourceCachePermission,null);assert.equal(n.cache.some(e=>e.state==='authorized'),false);
 held.control.acceptWelcome(held.message);const permission=n.connection.resourceCachePermission;assert.equal(permission.namespace,held.message.resourceCache.namespace);assert.equal(permission.grantId,held.message.viewerGrantId);assert.equal(permission.sessionId,h.sessionId);assert.deepEqual(permission.renderer,renderer);assert.ok(Object.isFrozen(permission));assert.ok(Object.isFrozen(permission.renderer));assert.ok(Object.isFrozen(n.cache.at(-1)));assert.throws(()=>{permission.renderer.wasmSha256='0'.repeat(64);},TypeError);assert.equal(JSON.stringify(permission).includes(n.authorizations[0].grant.ticket),false);
});

test('transient disconnect suspends cache access until a fresh grant while explicit revoke purges the current scope',enabled,async t=>{
 const h=await fixture(t),n=client(t,h);await n.connection.start();await until(()=>n.connection.resourceCachePermission);const first=n.connection.resourceCachePermission;[...h.transport.peers][0].close(1013,'temporary');await until(()=>n.cache.filter(e=>e.state==='authorized').length===2);const current=n.connection.resourceCachePermission;
 assert.notEqual(current.grantId,first.grantId);assert.equal(current.namespace,first.namespace);assert.ok(n.cache.some(e=>e.state==='suspended'&&e.permission===first));assert.equal(n.cache.some(e=>e.state==='revoked'),false);
 assert.equal((await h.api(h.tickets+'/'+current.grantId,{method:'DELETE'})).status,200);await until(()=>n.connection.state.state==='failed');assert.equal(n.connection.resourceCachePermission,null);assert.equal(n.cache.at(-1).state,'revoked');assert.equal(n.cache.at(-1).permission,current);assert.equal(n.requests.length,2);
});

test('a paused cache permission still expires and destroy revokes before any callback can restart access',enabled,async t=>{
 const h=await fixture(t),grant=await h.issue('readonly',{ttlSeconds:1});let calls=0;const n=client(t,h,{getTicket:()=>{calls++;return grant;}});await n.connection.start();await until(()=>n.connection.resourceCachePermission);n.connection.stop();assert.equal(n.connection.resourceCachePermission,null);assert.equal(n.cache.at(-1).state,'suspended');await until(()=>n.cache.at(-1).state==='revoked');assert.equal(n.cache.at(-1).permission.grantId,grant.grantId);assert.equal(calls,1);assert.equal(n.connection.state.state,'paused');n.connection.destroy();assert.equal(n.connection.state.state,'closed');
});

test('malformed cache metadata never authorizes storage and a legacy Welcome continues without cache permission',enabled,async t=>{
 const h=await fixture(t);
 for(const mutate of [m=>({...m,resourceCache:null}),m=>({...m,resourceCache:{...m.resourceCache,namespace:'vrc1_bad'}}),m=>({...m,resourceCache:{...m.resourceCache,extra:true}}),m=>({...m,renderer:{...m.renderer,extra:true}})]){
  const n=client(t,h,{accept:(message,control)=>control.acceptWelcome(mutate(message))});await n.connection.start();await until(()=>n.connection.state.state==='failed');assert.equal(n.connection.resourceCachePermission,null);assert.equal(n.cache.some(e=>e.state==='authorized'),false);n.connection.destroy();
 }
 const legacy=client(t,h,{accept:(message,control)=>{const {resourceCache,...original}=message;control.acceptWelcome(original);}});await legacy.connection.start();await until(()=>legacy.connection.state.state==='connected');assert.equal(legacy.connection.resourceCachePermission,null);assert.equal(legacy.cache.some(e=>e.state==='authorized'),false);
});

test('cache callbacks may stop or destroy reentrantly without admitting late Welcome or requesting more grants',enabled,async t=>{
 const h=await fixture(t);let n=client(t,h,{onCacheState:event=>{if(event.state==='authorized'||event.state==='revoked')n.connection.destroy();}});await n.connection.start();await until(()=>n.connection.state.state==='closed');assert.equal(n.connection.resourceCachePermission,null);assert.equal(n.states.some(s=>s.state==='connected'),false);assert.throws(()=>n.authorizations[0].control.acceptWelcome(n.messages.find(isWelcome)??{}),e=>e.code==='VIEWER_ABORTED');
 let paused=client(t,h,{onCacheState:event=>{if(event.state==='suspended')paused.connection.stop();}});await paused.connection.start();assert.equal(paused.connection.state.state,'paused');assert.equal(paused.requests.length,0);assert.equal(paused.connection.resourceCachePermission,null);
});
