import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {sessionStoreSupported} from '../service/session-store.mjs';
import {CACHE_CAPABILITY,CACHE_NEGOTIATION,makeCacheOffer,parseCacheOffer,validateCacheNegotiation} from '../protocol/resource-cache.mjs';
import {decodeAsset} from '../protocol/asset-wire.mjs';
import {encodeResource} from '../protocol/wire.mjs';
import {fixture,renderer} from './fixtures/viewer-access-harness.mjs';
import {snapshot,hash,payload} from './live-helpers.mjs';
const enabled={skip:!sessionStoreSupported};
async function until(fn){const end=performance.now()+2000;while(!fn()){assert.ok(performance.now()<end,'Cache proxy condition deadline');await delay(5);}}
async function open(h,{cache=true,role='readonly'}={}){
 const grant=await h.issue(role),n=await h.connect(grant,{sendHello:false}),packets=[];
 n.ws.on('message',(bytes,binary)=>{packets.push(binary?{binary:true,bytes:bytes.length,...(({kind,id})=>({kind,id}))(decodeAsset(bytes))}:{...JSON.parse(bytes),wireBytes:bytes.length});if(!binary){const m=JSON.parse(bytes);if(m.type==='FrameCommit'&&n.ws.readyState===1)n.ws.send(JSON.stringify({type:'FrameAck',pageEpoch:m.pageEpoch,frameId:m.frameId,stage:'scene-submitted'}));}});
 n.ws.send(JSON.stringify({type:'Hello',protocol:4,renderer,capabilities:cache?[CACHE_CAPABILITY]:[]}));
 const welcome=await n.wait(m=>m.type==='Welcome');
 const offer=entries=>makeCacheOffer({namespace:welcome.resourceCache.namespace,renderer:welcome.renderer},entries);
 return {...n,grant,welcome,packets,offer,send(value){n.ws.send(JSON.stringify(value));}};
}

test('strict offers bind typed hashes to the exact server-selected scope and renderer',()=>{
 const permission={namespace:'vrc1_'+'a'.repeat(64),renderer},valid=makeCacheOffer(permission,[{kind:'skp',id:hash}]);assert.deepEqual([...parseCacheOffer(valid,permission.namespace,renderer)],['skp:'+hash]);assert.equal(validateCacheNegotiation({...CACHE_NEGOTIATION}),CACHE_NEGOTIATION);
 for(const value of [{...valid,namespace:'vrc1_'+'b'.repeat(64)},{...valid,renderer:{...renderer,wasmSha256:'b'.repeat(64)}},{...valid,extra:true},{...valid,resources:[...valid.resources,...valid.resources]},{...valid,resources:[{kind:'other',id:hash}]},{...valid,resources:[{kind:'chunk',id:hash,bytes:1}]},{...valid,resources:Array.from({length:129},(_,i)=>({kind:'skp',id:i.toString(16).padStart(64,'0')}))}])assert.throws(()=>parseCacheOffer(value,permission.namespace,renderer));
 assert.throws(()=>validateCacheNegotiation({...CACHE_NEGOTIATION,waitMs:10000}));
});

test('legacy clients keep full delivery while a fresh scoped offer omits the actual SKP packet',enabled,async t=>{
 const h=await fixture(t);h.source.latest=snapshot();const legacy=await open(h,{cache:false});await until(()=>legacy.packets.some(m=>m.type==='FrameCommit'));assert.equal(legacy.welcome.cacheNegotiation,undefined);assert.equal(legacy.packets.filter(m=>m.binary).length,1);legacy.ws.close();await once(legacy.ws,'close');
 const cached=await open(h);assert.deepEqual(cached.welcome.cacheNegotiation,CACHE_NEGOTIATION);assert.equal(cached.packets.some(m=>m.binary),false);cached.send(cached.offer([{kind:'skp',id:hash}]));await until(()=>cached.packets.some(m=>m.type==='FrameCommit'));assert.equal(cached.packets.some(m=>m.binary),false);assert.ok(cached.packets.some(m=>m.type==='SceneUpdate'));
});

test('a missing offer falls back to full data and a late offer cannot activate omission',enabled,async t=>{
 const h=await fixture(t);h.source.latest=snapshot();const n=await open(h);await until(()=>n.packets.some(m=>m.type==='FrameCommit'));assert.equal(n.packets.filter(m=>m.binary).length,1);n.send(n.offer([{kind:'skp',id:hash}]));
 await until(()=>[...h.transport.peers].some(p=>p.acked));
 const empty={...snapshot(),payloads:new Map(),scene:{rootPass:'root',passes:[{id:'root',output:[0,0,960,640],quads:[]}]}};h.source.latest=empty;h.source.emit('frame',empty);await until(()=>[...h.transport.peers].some(p=>p.acked&&p.known.size===0));
 h.source.latest=snapshot({translation:1});h.source.emit('frame',h.source.latest);await until(()=>n.packets.filter(m=>m.binary).length===2);assert.equal(n.ws.readyState,1);
});

test('foreign scope, wrong renderer and malformed offers close before held Source resources are released',enabled,async t=>{
 const h=await fixture(t);h.source.latest=snapshot();
 for(const mutate of [m=>({...m,namespace:'vrc1_'+'0'.repeat(64)}),m=>({...m,renderer:{...renderer,wasmSha256:'b'.repeat(64)}}),m=>({...m,resources:[...m.resources,...m.resources]}),m=>({...m,resources:[{kind:'skp',id:hash,tenantId:'a'}]})]){
  const n=await open(h),closed=once(n.ws,'close');n.send(mutate(n.offer([{kind:'skp',id:hash}])));assert.equal((await closed)[0],1008);assert.equal(n.packets.some(m=>m.binary),false);
 }
});

test('cache offers are one-shot and require the negotiated post-Welcome phase',enabled,async t=>{
 const h=await fixture(t),plain=await open(h,{cache:false});let closed=once(plain.ws,'close');plain.send(plain.offer([]));assert.equal((await closed)[0],1008);
 const n=await open(h);n.send(n.offer([]));await until(()=>n.packets.some(m=>m.type==='FrameCommit'));closed=once(n.ws,'close');n.send(n.offer([]));assert.equal((await closed)[0],1008);
 const grant=await h.issue(),early=await h.connect(grant,{sendHello:false});closed=once(early.ws,'close');early.ws.send(JSON.stringify({type:'ResourceCacheOffer'}));assert.equal((await closed)[0],1008);
});

test('RequestKeyframe clears omission and resends the exact original resource through the real proxy',enabled,async t=>{
 const h=await fixture(t);h.source.latest=snapshot();const n=await open(h);n.send(n.offer([{kind:'skp',id:hash}]));await until(()=>n.packets.some(m=>m.type==='FrameCommit'));assert.equal(n.packets.some(m=>m.binary),false);n.send({type:'RequestKeyframe'});await until(()=>n.packets.some(m=>m.binary));const resource=n.packets.find(m=>m.binary);assert.equal(resource.id,hash);assert.equal(resource.bytes,payload.length+44);
});

test('revoking an awaiting or accepted cache grant retires the actual public/private link',enabled,async t=>{
 const h=await fixture(t);h.source.latest=snapshot();
 for(const accepted of [false,true]){
  const n=await open(h);if(accepted){n.send(n.offer([{kind:'skp',id:hash}]));await until(()=>n.packets.some(m=>m.type==='FrameCommit'));}
  const closed=once(n.ws,'close');assert.equal((await h.api(h.tickets+'/'+n.grant.grantId,{method:'DELETE'})).status,200);assert.equal((await closed)[0],1008);await until(()=>h.transport.peers.size===0);assert.equal(n.packets.some(m=>m.binary),false);
 }
});

test('the omission index is charged against existing per-link/global limits',enabled,async t=>{
 const h=await fixture(t,{accessOptions:{maxBufferedBytes:32*1024}}),n=await open(h),closed=once(n.ws,'close');n.send(n.offer(Array.from({length:128},(_,i)=>({kind:'skp',id:i.toString(16).padStart(64,'0')}))));assert.equal((await closed)[0],1008);
});

test('typed chunk omission does not suppress the same hash sent as an SKP',enabled,async t=>{
 const h=await fixture(t),n=await open(h);n.send(n.offer([{kind:'chunk',id:hash}]));await until(()=>n.packets.some(m=>m.type==='FrameCommit'));const peer=[...h.transport.peers][0],chunk=encodeResource(hash,payload);chunk[5]=2;peer.ws.send(chunk,{binary:true});peer.ws.send(encodeResource(hash,payload),{binary:true});await until(()=>n.packets.some(m=>m.binary));assert.deepEqual(n.packets.filter(m=>m.binary).map(m=>m.kind),['skp']);
});
