import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {inspect} from 'node:util';
import {AgentWebhookAuthError,createAgentWebhookAuthenticator} from '../service/agent-webhook-auth.mjs';

const endpointId='awh_00000000-0000-0000-0000-000000000001',eventId='aevt_00000000-0000-0000-0000-000000000002';
const secret=()=>Buffer.from(Array.from({length:32},(_,i)=>i)),body=()=>Buffer.from('{"message":"雪","n":1}');
const config=(patch={})=>({endpointId,activeKeyId:'key_A',keys:[{keyId:'key_A',secret:secret()}],clock:()=>1700000000,...patch});
const factory=(patch={})=>createAgentWebhookAuthenticator(config(patch));
const signed=(auth,input={eventId,body:body()})=>auth.sign(input);
const input=packet=>({eventId:packet.headers['remote-paint-event-id'],signature:packet.headers['remote-paint-signature'],body:packet.body});
const rejects=(fn,code='AGENT_WEBHOOK_AUTH_FAILED')=>assert.throws(fn,error=>error instanceof AgentWebhookAuthError&&error.code===code&&!/PRIVATE/.test(String(error)+JSON.stringify(error)));

test('webhook signer emits bounded frozen metadata and captures original key and body bytes',()=>{
 const value=config(),original=body(),key=Buffer.from(value.keys[0].secret),auth=createAgentWebhookAuthenticator(value),packet=signed(auth,{eventId,body:original});
 value.keys[0].secret.fill(9);value.activeKeyId='other';value.keys[0].keyId='changed';original.fill(0);
 assert.equal(packet.headers['content-type'],'application/json');assert.equal(packet.headers['remote-paint-event-id'],eventId);assert.ok(Object.isFrozen(packet)&&Object.isFrozen(packet.headers));assert.deepEqual(packet.body,body());assert.deepEqual(auth.verify(input(packet)).body,body());assert.notDeepEqual(value.keys[0].secret,key);
});
test('webhook verifier returns frozen endpoint event key and time metadata with owned raw bytes',()=>{
 const auth=factory(),packet=signed(auth),result=auth.verify(input(packet));assert.ok(Object.isFrozen(result));assert.equal(result.endpointId,endpointId);assert.equal(result.eventId,eventId);assert.equal(result.keyId,'key_A');assert.equal(result.signedAtSeconds,1700000000);assert.notEqual(result.body,packet.body);result.body.fill(0);assert.deepEqual(packet.body,body());assert.deepEqual(auth.verify(input(packet)).body,body());
});
test('webhook SHA256 signature matches an independently computed Python UTF8 golden vector',()=>{
 const packet=signed(factory());assert.equal(packet.body.length,23);assert.equal(packet.headers['remote-paint-signature'],'t=1700000000,kid=key_A,v1=5644c81def5e022306d96a6eee216e071c5c7c81518c3d99e2d818d8d1e4dbab');
});
test('webhook authentication rejects altered raw bytes and semantically equivalent JSON serialization',()=>{
 const auth=factory(),packet=signed(auth);for(const value of [Buffer.from('{"message":"雪","n":2}'),Buffer.from('{ "message":"雪","n":1}'),Buffer.from('{"n":1,"message":"雪"}')])rejects(()=>auth.verify({...input(packet),body:value}));
});
test('webhook signature is bound to the exact endpoint even when secret bytes are shared',()=>{
 const auth=factory(),packet=signed(auth),other=factory({endpointId:'awh_00000000-0000-0000-0000-000000000003'});rejects(()=>other.verify(input(packet)));rejects(()=>factory({keys:[{keyId:'key_A',secret:Buffer.alloc(32,9)}]}).verify(input(packet)));
});
test('webhook original event ID cannot be substituted after signing',()=>{
 const auth=factory(),packet=signed(auth);rejects(()=>auth.verify({...input(packet),eventId:'aevt_00000000-0000-0000-0000-000000000003'}));
});
test('webhook authenticated timestamp and key selector cannot be rewritten',()=>{
 const auth=factory({keys:[{keyId:'key_A',secret:secret()},{keyId:'key_B',secret:secret()}]}),packet=signed(auth);rejects(()=>auth.verify({...input(packet),signature:input(packet).signature.replace('1700000000','1700000001')}));rejects(()=>auth.verify({...input(packet),signature:input(packet).signature.replace('key_A','key_B')}));
});
test('webhook signature grammar rejects duplicate fields controls unknown versions and noncanonical values',()=>{
 const auth=factory(),packet=signed(auth),s=input(packet).signature;
 for(const value of [s+',t=1700000000',' '+s,s+'\r\n',s.replace('t=170','t=0170'),s.replace('v1=','v2='),s.replace('kid=key_A','kid=PRIVATE\nkey'),s.toUpperCase(),s.replace(/.$/,'z'),s.slice(0,-1),s+','+s,s.replace('1700000000','9007199254740992'),['a'],{},null])rejects(()=>auth.verify({...input(packet),signature:value}));
});
test('webhook event ID grammar rejects coercion wrong domains and line injection without echoing data',()=>{
 const auth=factory(),packet=signed(auth);let coerced=0;
 for(const value of ['PRIVATE',eventId+'\n','arun_'+eventId.slice(5),eventId.toUpperCase(),{toString(){coerced++;return eventId;}},null,1]){rejects(()=>auth.sign({eventId:value,body:body()}),'AGENT_WEBHOOK_INVALID');rejects(()=>auth.verify({...input(packet),eventId:value}));}assert.equal(coerced,0);
});
test('webhook age and future skew limits use inclusive exact boundaries and one trusted clock read',()=>{
 let time=1000,calls=0;const auth=factory({clock:()=>{calls++;return time;}}),packet=signed(auth);assert.equal(calls,1);
 for(const value of [1000,1300,970]){time=value;assert.equal(auth.verify(input(packet)).signedAtSeconds,1000);}assert.equal(calls,4);
 for(const value of [1301,969]){time=value;rejects(()=>auth.verify(input(packet)));}assert.equal(calls,6);
});
test('webhook two-key rotation accepts the retained key and rejects its removal',()=>{
 const first=factory(),old=signed(first),rotated=factory({activeKeyId:'key_B',keys:[{keyId:'key_A',secret:secret()},{keyId:'key_B',secret:Buffer.alloc(32,7)}]}),next=signed(rotated);assert.equal(rotated.verify(input(old)).keyId,'key_A');assert.equal(rotated.verify(input(next)).keyId,'key_B');assert.notEqual(old.headers['remote-paint-signature'],next.headers['remote-paint-signature']);rejects(()=>factory({activeKeyId:'key_B',keys:[{keyId:'key_B',secret:Buffer.alloc(32,7)}]}).verify(input(old)));
});
test('webhook key configuration rejects missing duplicate excess undersized and coerced secrets',()=>{
 for(const keys of [[],[{keyId:'key_A',secret:Buffer.alloc(31)}],[{keyId:'key_A',secret:Buffer.alloc(65)}],[{keyId:'key_A',secret:'PRIVATE'.repeat(8)}],[{keyId:'key_A',secret:secret()},{keyId:'key_A',secret:secret()}],Array.from({length:3},(_,i)=>({keyId:'key_'+i,secret:secret()})),[{keyId:'unknown',secret:secret()}]])rejects(()=>factory({keys}),'AGENT_WEBHOOK_INVALID');
 assert.ok(factory({keys:[{keyId:'key_A',secret:Buffer.alloc(64,1)}]}));
});
test('webhook constructor rejects accessor proxy sparse symbol and invalid policy configuration before callbacks',()=>{
 let called=0;const getter=config();Object.defineProperty(getter,'clock',{get(){called++;throw Error('PRIVATE');}});const proxy=new Proxy(config(),{get(){called++;throw Error('PRIVATE');}});const array=[{keyId:'key_A',secret:secret()}];Object.defineProperty(array,'0',{get(){called++;throw Error('PRIVATE');}});
 for(const value of [getter,proxy,config({keys:array}),config({keys:new Array(1)}),config({[Symbol('PRIVATE')]:1}),config({maxAgeSeconds:0}),config({maxAgeSeconds:3601}),config({maxAgeSeconds:null}),config({futureSkewSeconds:-1}),config({futureSkewSeconds:61}),config({clock:null}),config({maxBodyBytes:4097}),config({maxBodyBytes:true})])rejects(()=>createAgentWebhookAuthenticator(value),'AGENT_WEBHOOK_INVALID');assert.equal(called,0);
});
test('webhook byte capture honors subarray bounds without invoking shadowed accessors',()=>{
 let called=0;const raw=Buffer.concat([Buffer.from('x'),body(),Buffer.from('y')]),view=new Uint8Array(raw.buffer,raw.byteOffset+1,body().length);Object.defineProperty(view,'byteLength',{get(){called++;throw Error('PRIVATE');}});Object.defineProperty(view,'buffer',{get(){called++;throw Error('PRIVATE');}});const packet=signed(factory(),{eventId,body:view});assert.deepEqual(packet.body,body());assert.equal(called,0);
});
test('webhook body and secret byte ownership rejects shared backing proxy views and unsupported types',()=>{
 const auth=factory(),packet=signed(auth),shared=new Uint8Array(new SharedArrayBuffer(32));
 for(const value of [shared,new Proxy(body(),{}),new DataView(new ArrayBuffer(32)),new Uint16Array(32),body().buffer,'PRIVATE',null]){rejects(()=>auth.sign({eventId,body:value}),'AGENT_WEBHOOK_INVALID');rejects(()=>auth.verify({...input(packet),body:value}));}
 rejects(()=>factory({keys:[{keyId:'key_A',secret:shared}]}),'AGENT_WEBHOOK_INVALID');
});
test('webhook body budgets count raw UTF8 bytes and enforce exact configured and hard maxima',()=>{
 const auth=factory({maxBodyBytes:3}),packet=signed(auth,{eventId,body:Buffer.from('雪')});assert.equal(auth.verify(input(packet)).body.length,3);rejects(()=>auth.sign({eventId,body:Buffer.from('雪x')}),'AGENT_WEBHOOK_INVALID');rejects(()=>auth.sign({eventId,body:Buffer.alloc(0)}),'AGENT_WEBHOOK_INVALID');const maximum=factory(),full=signed(maximum,{eventId,body:Buffer.alloc(4096,1)});assert.equal(maximum.verify(input(full)).body.length,4096);rejects(()=>maximum.sign({eventId,body:Buffer.alloc(4097)}),'AGENT_WEBHOOK_INVALID');rejects(()=>maximum.verify({...input(full),body:Buffer.alloc(4097)}));
});
test('webhook clocks fail closed without coercion and remain safe at the maximum timestamp',async()=>{
 const packet=signed(factory());let called=0;for(const value of [NaN,Infinity,-1,1.1,Number.MAX_SAFE_INTEGER+1,'1700000000',{valueOf(){called++;return 1700000000;}}]){const auth=factory({clock:()=>value});rejects(()=>signed(auth),'AGENT_WEBHOOK_INVALID');rejects(()=>auth.verify(input(packet)));}assert.equal(called,0);rejects(()=>signed(factory({clock:()=>{throw Error('PRIVATE');}})),'AGENT_WEBHOOK_INVALID');const maximum=factory({clock:()=>Number.MAX_SAFE_INTEGER}),last=signed(maximum);assert.equal(maximum.verify(input(last)).signedAtSeconds,Number.MAX_SAFE_INTEGER);assert.ok(factory({clock:()=>Number.MAX_SAFE_INTEGER}).verify(input(signed(factory({clock:()=>Number.MAX_SAFE_INTEGER-300})))));
 rejects(()=>factory({clock:async()=>1700000000}),'AGENT_WEBHOOK_INVALID');rejects(()=>factory({clock:function*(){yield 1700000000;}}),'AGENT_WEBHOOK_INVALID');const mistaken=factory({clock:()=>Promise.reject(Error('PRIVATE_CLOCK_FIXTURE'))});rejects(()=>signed(mistaken),'AGENT_WEBHOOK_INVALID');rejects(()=>mistaken.verify(input(packet)));await new Promise(resolve=>setImmediate(resolve));
});
test('webhook close is idempotent fences both operations and does not mutate caller secret copies',()=>{
 const original=secret(),auth=factory({keys:[{keyId:'key_A',secret:original}]}),packet=signed(auth);assert.ok(Object.isFrozen(auth));assert.doesNotMatch(inspect(auth),/00010203|PRIVATE/);auth.close();auth.close();rejects(()=>signed(auth),'AGENT_WEBHOOK_CLOSED');rejects(()=>auth.verify(input(packet)),'AGENT_WEBHOOK_CLOSED');assert.deepEqual(original,secret());assert.deepEqual(Object.keys(auth),['sign','verify','close']);
});
test('webhook inputs reject getters extras and reentrant close without issuing a signature',()=>{
 const auth=factory(),packet=signed(auth);let called=0;const value={eventId};Object.defineProperty(value,'body',{get(){called++;throw Error('PRIVATE');}});rejects(()=>auth.sign(value),'AGENT_WEBHOOK_INVALID');rejects(()=>auth.verify({...input(packet),extra:1}));rejects(()=>auth.sign({eventId,body:body(),extra:1}),'AGENT_WEBHOOK_INVALID');assert.equal(called,0);let closing;closing=factory({clock:()=>{closing.close();return 1700000000;}});rejects(()=>signed(closing),'AGENT_WEBHOOK_CLOSED');
});
test('actual HTTP raw-byte authentication preserves duplicate original IDs and rejects reserialization and duplicate headers',async()=>{
 let time=1000;const auth=factory({clock:()=>time}),receipts=[];const server=createServer(async(req,res)=>{
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096){res.writeHead(413).end();return;}chunks.push(chunk);}
  try{const result=auth.verify({eventId:req.headers['remote-paint-event-id'],signature:req.headers['remote-paint-signature'],body:Buffer.concat(chunks)});receipts.push(result);res.writeHead(202,{'content-type':'application/json'}).end(JSON.stringify({authenticated:true,eventId:result.eventId}));}
  catch{res.writeHead(401).end('Webhook authentication failed');}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const url='http://127.0.0.1:'+server.address().port,first=signed(auth);time=1001;const second=signed(auth);assert.notEqual(first.headers['remote-paint-signature'],second.headers['remote-paint-signature']);
  for(const packet of [first,first,second]){const response=await fetch(url,{method:'POST',headers:packet.headers,body:packet.body});assert.equal(response.status,202);assert.deepEqual(await response.json(),{authenticated:true,eventId});}
  const changed=await fetch(url,{method:'POST',headers:first.headers,body:Buffer.from('{ "message":"雪","n":1}')});assert.equal(changed.status,401);await changed.text();const headers=new Headers(first.headers);headers.append('remote-paint-signature',first.headers['remote-paint-signature']);const duplicated=await fetch(url,{method:'POST',headers,body:first.body});assert.equal(duplicated.status,401);await duplicated.text();assert.equal(receipts.length,3);assert.ok(receipts.every(r=>r.eventId===eventId&&r.body.equals(body())));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));auth.close();}
});
