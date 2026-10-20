import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sessionStoreSupported,SessionStoreError} from '../service/session-store.mjs';
import {ViewerAccess} from '../service/viewer-access.mjs';
import {createServer} from 'node:http';
import {WebSocket} from 'ws';
import {fixture,wait,pending} from './fixtures/docker-provider-resolver.mjs';
const enabled={skip:!sessionStoreSupported,timeout:10000},fixed=e=>e?.name==='DockerSessionProviderError'&&/^PROVIDER_SOURCE_/.test(e.code)&&e.message==='Owned Session runtime is unavailable';
test('current owned Native Ready resolves seven private primitive fields and never publishes owner/stream key in status or ledger',enabled,async t=>{
 const h=await fixture(t),args=await h.ready(),target=await h.resolve(args);assert.deepEqual(target,{...args,origin:'http://127.0.0.1:4175',streamOrigin:'http://198.19.192.5:4176',key:h.starts[0].expectedKey});assert.ok(Object.isFrozen(target));assert.equal(Object.keys(target).length,7);assert.notEqual(target.key,h.starts[0].ownerKey);const publicBytes=JSON.stringify([h.events,h.provider.status(),h.provider.sessionStatus(args),(await readFile(join(h.directory,'state.sqlite'))).toString('latin1')]);for(const secret of [target.key,h.starts[0].ownerKey])assert.ok(!publicBytes.includes(secret));assert.deepEqual(h.calls.slice(-3).map(x=>x.kind),['container','network','container']);
});
test('resolver rejects unknown/foreign/version/region and malformed/getter/extra address input before any metadata lookup',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();assert.equal(typeof h.provider.resolveSource,'function');const before=h.calls.length;let touched=false;const getter={...args};Object.defineProperty(getter,'version',{get(){touched=true;return args.version;}});for(const value of [{...args,sessionId:'ses_unknown'},{...args,tenantId:'other'},{...args,version:'old'},{...args,region:'other'},{...args,url:'https://unowned.test'},{...args,signal:{}},getter])await assert.rejects(h.resolve(value),fixed);assert.equal(touched,false);assert.equal(h.calls.length,before);
});
test('valid generic worker Ready has no Native resolver capability',enabled,async t=>{const h=await fixture(t,{generic:true}),args=await h.ready(),before=h.calls.length;await assert.rejects(h.resolve(args),fixed);assert.equal(h.calls.length,before);});
test('same Session admits two lookups; actual noncooperative work keeps its global slot after caller abort until it settles',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();assert.equal(typeof h.provider.resolveSource,'function');const gate=pending(),entered=pending();let calls=0;h.hooks.container=async()=>{if(++calls<=2){if(calls===2)entered.resolve();await gate.promise;}};h.cleanup.push(gate.resolve);const controller=new AbortController(),one=h.resolve({...args,signal:controller.signal}),two=h.resolve(args);void one.catch(()=>{});await wait(entered.promise);assert.equal(h.provider.status().activeSourceLookups,2);controller.abort(Error('private-abort'));await assert.rejects(h.resolve(args),e=>fixed(e)&&e.code==='PROVIDER_SOURCE_BUSY');assert.equal(h.provider.status().activeSourceLookups,2);gate.resolve();await assert.rejects(one,fixed);assert.equal((await two).key,h.starts[0].expectedKey);assert.equal(h.provider.status().activeSourceLookups,0);
});
test('cooperative metadata sees the shared overall deadline and returns a fixed error without leaking its private reason',enabled,async t=>{
 const h=await fixture(t,{sourceLookupTimeoutMs:40}),args=await h.ready();h.hooks.network=({signal})=>new Promise((_,reject)=>{const fail=()=>reject(Error('private-network-timeout'));if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});});const started=performance.now();await assert.rejects(h.resolve(args),fixed);assert.ok(performance.now()-started<1000);assert.equal(h.provider.status().activeSourceLookups,0);
});
test('caller cancellation during network lookup cannot return a late private key',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();assert.equal(typeof h.provider.resolveSource,'function');const held=h.hold('network'),controller=new AbortController(),lookup=h.resolve({...args,signal:controller.signal});void lookup.catch(()=>{});await wait(held.entered.promise);controller.abort(Error('private-cancel'));held.gate.resolve();await assert.rejects(lookup,fixed);assert.equal(h.provider.status().activeSourceLookups,0);
});
test('close immediately denies new resolutions and fences an inspection that completes after namespace retirement',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();assert.equal(typeof h.provider.resolveSource,'function');const held=h.hold('container'),lookup=h.resolve(args);void lookup.catch(()=>{});await wait(held.entered.promise);const closing=h.provider.close({...args,reason:'released'}),before=h.calls.length;await assert.rejects(h.resolve(args),fixed);assert.equal(h.calls.length,before);assert.equal((await closing).status,'closed');held.gate.resolve();await assert.rejects(lookup,fixed);
});
test('a restarted Engine generation during the network await is rejected by the final container observation',enabled,async t=>{
 const h=await fixture(t),args=await h.ready(),doc=[...h.docs.values()][0],old=doc.State.StartedAt;h.hooks.network=()=>{doc.State.StartedAt='2026-10-18T00:01:00.123456789Z';};try{await assert.rejects(h.resolve(args),fixed);}finally{doc.State.StartedAt=old;}assert.deepEqual(h.calls.slice(-3).map(x=>x.kind),['container','network','container']);
});
test('witness file bytes are read after asynchronous metadata, so a valid JSON rewrite cannot use the earlier durable hash',enabled,async t=>{
 const h=await fixture(t),args=await h.ready(),cid=[...h.docs.keys()][0],file=join(h.directory,'witness',args.sessionId+'-'+cid+'.namespace.json'),original=await readFile(file);h.hooks.network=()=>appendFile(file,'\n');try{await assert.rejects(h.resolve(args),fixed);}finally{await writeFile(file,original);}
});
test('fresh durable Ready disagreement and reentrant close during synchronous witness read both fence the private result',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();h.durablePatch=s=>{s.allocations[0].version='changed-version';return s;};try{await assert.rejects(h.resolve(args),fixed);}finally{h.durablePatch=null;}let close;h.hooks.witness=()=>{delete h.hooks.witness;close=h.provider.close({...args,reason:'released'});};await assert.rejects(h.resolve(args),fixed);assert.equal((await close).status,'closed');
});
test('worker unavailability denies private lookup in the same trusted notification before cleanup finishes',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();assert.equal(typeof h.provider.resolveSource,'function');let blocked;h.provider.subscribeUnavailable(()=>{blocked=h.resolve(args);void blocked.catch(()=>{});});h.proxies.get(args.sessionId).lose();assert.ok(blocked);await assert.rejects(blocked,fixed);assert.equal(h.provider.sessionStatus(args).available,false);
});
test('shutdown fences delayed lookup and never restores its capability when metadata returns',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();assert.equal(typeof h.provider.resolveSource,'function');const held=h.hold('network'),lookup=h.resolve(args);void lookup.catch(()=>{});await wait(held.entered.promise);const shutdown=h.provider.shutdown();await assert.rejects(h.resolve(args),fixed);held.gate.resolve();await assert.rejects(lookup,fixed);assert.equal((await shutdown).status,'closed');assert.equal(h.provider.status().activeSourceLookups,0);
});
test('actual persisted recovered Ready/witness row is close-only and cannot reconstruct a private stream key',enabled,async t=>{
 const h=await fixture(t,{recovered:true}),before=h.calls.length;await assert.rejects(h.resolve(h.recoveredArgs),fixed);assert.equal(h.calls.length,before);assert.equal(h.provider.sessionStatus(h.recoveredArgs).available,false);
});
test('a synchronous witness read that crosses the overall budget is fenced before timer callbacks run',enabled,async t=>{
 const h=await fixture(t,{sourceLookupTimeoutMs:30}),args=await h.ready();h.hooks.witness=()=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,45);await assert.rejects(h.resolve(args),fixed);assert.equal(h.provider.status().activeSourceLookups,0);
});
test('storage fault makes the provider unavailable and future resolver calls cannot reuse the old capability',enabled,async t=>{
 const h=await fixture(t),args=await h.ready();await h.resolve(args);h.durablePatch=()=>{throw new SessionStoreError('STATE_CLOSED','private-storage-detail');};try{await assert.rejects(h.resolve(args),fixed);}finally{h.durablePatch=null;}assert.equal(h.provider.status().failure,'PROVIDER_STORAGE');const before=h.calls.length;await assert.rejects(h.resolve(args),fixed);assert.equal(h.calls.length,before);
});
test('unrelated unconfirmed cleanup does not revoke an independently current Ready endpoint',enabled,async t=>{
 const h=await fixture(t),one=await h.ready(),two=await h.ready(),cid=[...h.docs.keys()][0],file=join(h.directory,'witness',one.sessionId+'-'+cid+'.namespace.json'),original=await readFile(file);await appendFile(file,'\n');try{assert.equal((await h.provider.close({...one,reason:'released'})).status,'unconfirmed');assert.equal(h.provider.status().phase,'recovery-required');assert.equal((await h.resolve(two)).key,h.starts.find(x=>x.sessionId===two.sessionId).expectedKey);}finally{await writeFile(file,original);assert.equal((await h.provider.retryClose({...one,reason:'released'})).status,'closed');}
});
test('source lookup capacity and overall deadline must have finite configured bounds',enabled,async t=>{
 for(const options of [{maxSourceLookups:0},{maxSourceLookups:5},{sourceLookupTimeoutMs:19},{sourceLookupTimeoutMs:30001}])await assert.rejects(fixture(t,options),TypeError);
});
test('actual Viewer ticket upgrade passes exact identity/signal and revocation cancels the provider lookup before a private target is returned',enabled,async t=>{
 const h=await fixture(t),args=await h.ready(),held=h.hold('network'),audience='https://embed.example';let captured,client;
 const access=new ViewerAccess({registry:h.registry,resolveSource:value=>{captured=value;return h.resolve(value);},connectTimeoutMs:1000}),sockets=new Set(),server=createServer((_req,res)=>res.end());server.on('connection',s=>{sockets.add(s);s.once('close',()=>sockets.delete(s));});server.on('upgrade',(req,socket,head)=>access.handleUpgrade(req,socket,head));
 try{await new Promise(r=>server.listen(0,'127.0.0.1',r));const grant=access.issue({tenantId:args.tenantId,sessionId:args.sessionId,role:'readonly',audience});assert.ok(!JSON.stringify(grant).includes(h.starts[0].expectedKey));client=new WebSocket('ws://127.0.0.1:'+server.address().port+grant.streamPath,{origin:audience});const closed=new Promise(r=>{client.on('error',r);client.once('close',r);client.once('unexpected-response',(_req,res)=>{res.resume();r();});});await wait(held.entered.promise);assert.ok(Object.isFrozen(captured));assert.deepEqual(Object.keys(captured).sort(),['region','sessionId','signal','tenantId','version']);assert.deepEqual({...captured,signal:undefined},{...args,signal:undefined});access.revoke({tenantId:args.tenantId,sessionId:args.sessionId,grantId:grant.grantId});assert.equal(captured.signal.aborted,true);held.gate.resolve();await wait(closed);const end=performance.now()+2000;while(h.provider.status().activeSourceLookups){assert.ok(performance.now()<end);await new Promise(setImmediate);}assert.equal(h.provider.status().activeSourceLookups,0);}finally{held.gate.resolve();client?.terminate();access.close();for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));}
});
test('completed lookup cancels its operation signal without aborting the caller or the live worker capability',enabled,async t=>{
 const h=await fixture(t),args=await h.ready(),caller=new AbortController(),before=h.calls.length,first=await h.resolve({...args,signal:caller.signal}),signals=h.calls.slice(before).map(x=>x.signal);assert.equal(new Set(signals).size,1);assert.ok(signals.every(s=>s.aborted));assert.equal(caller.signal.aborted,false);assert.equal(h.provider.sessionStatus(args).available,true);assert.equal((await h.resolve(args)).key,first.key);
});
