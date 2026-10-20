import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {SessionRegistry} from '../service/session-registry.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {createSessionControlServer} from '../service/session-http.mjs';
import {ViewerAccess} from '../service/viewer-access.mjs';
import {fixture,KEY,READ,OTHER,audience,renderer,flush,pending} from './fixtures/viewer-access-harness.mjs';
const enabled={skip:!sessionStoreSupported};
const is=type=>message=>message.type===type;
const tags=welcome=>({sessionId:welcome.sessionId,pageEpoch:1,viewportVersion:1});
async function controller(h){const grant=await h.issue('controller'),client=await h.connect(grant),welcome=await client.wait(is('Welcome'));await client.wait(is('FrameCommit'));client.ws.send(JSON.stringify({type:'AcquireControl',...tags(welcome)}));const control=await client.wait(is('ControlGranted'));return {grant,client,welcome,control};}
function input(welcome,control,text='visible'){return {type:'Input',...tags(welcome),lease:control.lease,seq:control.nextSeq,event:{kind:'text',text}};}

test('Viewer authorization requires a durable Ready Session and an explicit matching Registry',enabled,async t=>{
 const memory=new SessionRegistry({providers:new Map([['test',{create:async()=>({version:'v1'}),close:async()=>({status:'closed'})}]]),defaultRegion:'test'}),access=new ViewerAccess({registry:memory,resolveSource:()=>null});
 assert.throws(()=>access.issue({tenantId:'a',sessionId:'ses_missing',role:'readonly',audience}),e=>e.code==='REGISTRY_STORAGE_UNAVAILABLE');access.close();await memory.shutdown();
 const h=await fixture(t);assert.throws(()=>createSessionControlServer({registry:h.registry,authenticate:()=>null,viewerAccess:{}}),TypeError);
 for(const body of [{role:'agent',audience},{role:'readonly',audience:'*'},{role:'readonly',audience:'https://embed.example/path'},{role:'readonly',audience:'http://public.example'},{role:'readonly',audience,ttlSeconds:121},{role:'readonly',audience,tenantId:'b'}])assert.equal((await h.api(h.tickets,{method:'POST',body})).status,400);
 assert.equal(h.resolutions.length,0);h.registry.release('a',h.sessionId);assert.equal((await h.api(h.tickets,{method:'POST',body:{role:'readonly',audience}})).error.code,'SESSION_NOT_READY');
});

test('real backend HTTP isolates tenants, read/control scopes and browser Origin from Viewer credentials',enabled,async t=>{
 const h=await fixture(t),grant=await h.issue('readonly',{}, {key:READ});
 assert.equal((await h.api(h.tickets,{method:'POST',key:READ,body:{role:'controller',audience}})).status,403);
 assert.equal((await h.api(h.tickets,{method:'POST',key:OTHER,body:{role:'readonly',audience}})).status,404);
 assert.equal((await h.api(h.tickets,{method:'POST',headers:{origin:audience},body:{role:'readonly',audience}})).status,403);
 assert.equal((await h.api('/v1/sessions/'+h.sessionId,{key:grant.ticket})).status,401);
 assert.equal(await h.denied('/v1/viewer/stream?ticket='+KEY),403);assert.equal(await h.denied('/v1/viewer/stream?ticket='+grant.grantId),403);
 for(const path of [grant.streamPath+'&role=controller',grant.streamPath+'&ticket=duplicate',grant.streamPath.replace('vwt1.','vwt1%2e')])assert.equal(await h.denied(path),403);
 assert.equal(await h.denied(grant.streamPath,'https://other.example'),403);assert.equal(h.resolutions.length,0);
 assert.doesNotMatch(JSON.stringify(grant),new RegExp(h.transport.key+'|'+KEY));
});

test('readonly grants display real Node Source frames but forged write/Agent/control messages never reach ControlLease',enabled,async t=>{
 const h=await fixture(t),grant=await h.issue();
 const client=await h.connect(grant,{hello:{role:'controller',input:true}}),welcome=await client.wait(is('Welcome'));assert.equal(welcome.input,false);assert.equal(welcome.inputFeedback,false);assert.equal(welcome.control,null);assert.equal(welcome.viewerRole,'readonly');
 const frame=await client.wait(is('FrameCommit'));client.ws.send(JSON.stringify({type:'FrameAck',frameId:frame.frameId,pageEpoch:frame.pageEpoch}));client.ws.send(JSON.stringify({type:'RequestKeyframe'}));await client.wait(message=>message.type==='FrameCommit'&&message.frameId>frame.frameId);
 client.ws.close();await once(client.ws,'close');
 for(const type of ['AcquireControl','RenewControl','ReleaseControl','Input','ControlHello','AgentAction','Runtime.evaluate']){
  const attack=await h.connect(grant);await attack.wait(is('Welcome'));const closed=once(attack.ws,'close');attack.ws.send(JSON.stringify({type,...tags(welcome),event:{kind:'text',text:'forbidden'}}));assert.equal((await closed)[0],1008);assert.equal(h.source.control.mode,'agent');
 }
 assert.equal(h.calls.length,0);assert.ok(h.resolutions.length>=8);
});

test('controller grants use real Node ControlLease acquire, fenced input, renew and release without exposing Source key',enabled,async t=>{
 const h=await fixture(t),{client,welcome,control}=await controller(h);assert.equal(welcome.input,true);assert.equal(welcome.control,null);assert.equal(welcome.viewerRole,'controller');
 client.ws.send(JSON.stringify(input(welcome,control)));const ack=await client.wait(is('InputAck'));assert.equal(ack.accepted,true);assert.equal(h.calls.filter(v=>v.method==='Input.insertText').length,1);
 client.ws.send(JSON.stringify({type:'RenewControl',...tags(welcome),lease:control.lease}));await flush();
 const after=client.messages.length;client.ws.send(JSON.stringify({type:'ReleaseControl',...tags(welcome),lease:control.lease}));await client.wait(message=>message.type==='ControlState'&&message.mode==='agent',after);assert.equal(h.source.control.mode,'agent');
 assert.ok(!JSON.stringify(client.messages).includes(h.transport.key));assert.ok(!JSON.stringify(client.messages).includes(KEY));
});

test('explicit revoke closes active control, prevents reconnection and preserves cross-tenant isolation',enabled,async t=>{
 const h=await fixture(t),{grant,client,welcome,control}=await controller(h),path=h.tickets+'/'+grant.grantId;
 assert.equal((await h.api(path,{method:'DELETE',key:OTHER})).status,404);assert.equal((await h.api(path,{method:'DELETE',key:READ})).status,403);
 const closed=once(client.ws,'close');assert.equal((await h.api(path,{method:'DELETE'})).status,200);if(client.ws.readyState===1)client.ws.send(JSON.stringify(input(welcome,control,'after-revoke')));await closed;
 assert.equal(await h.denied(grant.streamPath),403);assert.equal(h.calls.filter(v=>v.method==='Input.insertText').length,0);
 for(let i=0;i<100&&(h.transport.peers.size||h.source.control.mode!=='agent');i++)await delay(10);
 assert.equal(h.transport.peers.size,0);assert.equal(h.source.control.mode,'agent');
});

test('refresh retains server-selected role/audience, closes the old grant and works at the configured capacity',enabled,async t=>{
 const h=await fixture(t,{accessOptions:{maxGrants:1}}),grant=await h.issue(),client=await h.connect(grant);await client.wait(is('Welcome'));const path=h.tickets+'/'+grant.grantId+'/refresh';
 assert.equal((await h.api(path,{method:'POST',body:{role:'controller'}})).status,400);const closed=once(client.ws,'close'),response=await h.api(path,{method:'POST',key:READ,body:{ttlSeconds:30}});assert.equal(response.status,200,response.text);await closed;
 const fresh=response.data;assert.notEqual(fresh.ticket,grant.ticket);assert.notEqual(fresh.grantId,grant.grantId);assert.equal(fresh.role,'readonly');assert.equal(fresh.audience,audience);assert.equal(await h.denied(grant.streamPath),403);
 const next=await h.connect(fresh);assert.equal((await next.wait(is('Welcome'))).input,false);assert.equal((await h.api(h.tickets,{method:'POST',body:{role:'readonly',audience}})).error.code,'VIEWER_CAPACITY');
});

test('ticket expiration closes active sockets independently of a longer-lived Session',enabled,async t=>{
 const h=await fixture(t),grant=await h.issue('readonly',{ttlSeconds:1}),client=await h.connect(grant);await client.wait(is('Welcome'));const closed=once(client.ws,'close');await closed;
 assert.equal(h.registry.requireReady('a',h.sessionId).state,'ready');assert.ok(Date.now()>=Date.parse(grant.expiresAt));assert.equal(await h.denied(grant.streamPath),403);
 const renewed=await h.api(h.tickets+'/'+grant.grantId+'/refresh',{method:'POST',body:{}});assert.equal(renewed.status,200);assert.equal(renewed.data.role,'readonly');
});

test('Session TTL bounds a longer Viewer grant and release fences a live connection before another input',enabled,async t=>{
 const h=await fixture(t,{ttlSeconds:2}),grant=await h.issue('controller',{ttlSeconds:120}),session=h.registry.requireReady('a',h.sessionId);assert.equal(grant.expiresAt,session.expiresAt);
 const client=await h.connect(grant),welcome=await client.wait(is('Welcome'));await client.wait(is('FrameCommit'));const closed=once(client.ws,'close');h.registry.release('a',h.sessionId);client.ws.send(JSON.stringify({type:'AcquireControl',...tags(welcome)}));await closed;assert.equal(h.calls.filter(v=>v.method==='Input.insertText').length,0);assert.equal(await h.denied(grant.streamPath),403);
});

test('revocation/deadline during an asynchronous private resolver cannot start a late upstream connection',enabled,async t=>{
 const gate=pending(),started=pending(),h=await fixture(t,{accessOptions:{maxConnections:1,connectTimeoutMs:100},resolveSource:async(args,{transport})=>{started.resolve();await gate.promise;return {tenantId:args.tenantId,sessionId:args.sessionId,region:args.region,version:args.version,...transport};}}),grant=await h.issue();
 const rejected=h.denied(grant.streamPath);await started.promise;assert.equal(await rejected,503);assert.equal(await h.denied(grant.streamPath),503);assert.equal(h.resolutions.length,1);gate.resolve();await delay(25);assert.equal(h.transport.peers.size,0);const retry=await h.connect(grant);await retry.wait(is('Welcome'));assert.equal(h.resolutions.length,2);
 const revokeGate=pending(),revokeStarted=pending(),r=await fixture(t,{resolveSource:async(args,{transport})=>{revokeStarted.resolve();await revokeGate.promise;return {tenantId:args.tenantId,sessionId:args.sessionId,region:args.region,version:args.version,...transport};}}),other=await r.issue();
 const denied=r.denied(other.streamPath);await revokeStarted.promise;const outcome=denied.catch(()=>null);r.access.revoke({tenantId:'a',sessionId:r.sessionId,grantId:other.grantId});revokeGate.resolve();await outcome;await flush();assert.equal(r.transport.peers.size,0);
});

test('a wrong private Session binding fails before upstream allocation and active grants have bounded connection slots',enabled,async t=>{
 const wrong=await fixture(t,{resolveSource:async(args,{transport})=>({tenantId:args.tenantId,sessionId:'ses_other',region:args.region,version:args.version,...transport})}),bad=await wrong.issue();assert.equal(await wrong.denied(bad.streamPath),503);assert.equal(wrong.transport.peers.size,0);
 const h=await fixture(t,{accessOptions:{maxConnections:1}}),grant=await h.issue(),client=await h.connect(grant);await client.wait(is('Welcome'));assert.equal(await h.denied(grant.streamPath),503);const another=await h.issue();assert.equal(await h.denied(another.streamPath),503);client.ws.close();await once(client.ws,'close');const next=await h.connect(another);await next.wait(is('Welcome'));
});

test('client binary, repeated Hello and oversized messages close the actual proxy without control effects',enabled,async t=>{
 const h=await fixture(t),grant=await h.issue('controller');
 for(const packet of [Buffer.from('forged-input'),JSON.stringify({type:'Hello',protocol:4,renderer}),JSON.stringify({type:'Input',padding:'x'.repeat(33*1024)})]){
  const client=await h.connect(grant);await client.wait(is('Welcome'));const closed=once(client.ws,'close');client.ws.send(packet);assert.ok([1008,1009].includes((await closed)[0]));
 }
 assert.equal(h.calls.filter(v=>v.method==='Input.insertText').length,0);assert.equal(h.source.control.mode,'agent');
});

test('closing or replacing the in-memory grant authority revokes active and previously issued tickets',enabled,async t=>{
 const h=await fixture(t),grant=await h.issue(),client=await h.connect(grant);await client.wait(is('Welcome'));const closed=once(client.ws,'close');h.access.close();h.access.close();await closed;assert.equal(await h.denied(grant.streamPath),403);
 const replacement=new ViewerAccess({registry:h.registry,resolveSource:()=>{throw new Error('must not resolve');}});t.after(()=>replacement.close());assert.throws(()=>replacement.get({tenantId:'a',sessionId:h.sessionId,grantId:grant.grantId}),e=>e.code==='VIEWER_GRANT_NOT_FOUND');
});

test('a slow public Viewer exceeds the configured forwarding budget and closes with no unbounded retry',enabled,async t=>{
 const h=await fixture(t,{accessOptions:{maxBufferedBytes:1024}}),grant=await h.issue(),client=await h.connect(grant);await client.wait(is('Welcome'));await client.wait(is('FrameCommit'));const closed=once(client.ws,'close');
 // The real Source transport emits an admitted control notification; the
 // public gateway must apply its independent output bound before forwarding.
 [...h.transport.peers][0].send({type:'CaptureError',message:'x'.repeat(2048)});assert.equal((await closed)[0],1011);assert.equal(h.resolutions.length,1);
});
