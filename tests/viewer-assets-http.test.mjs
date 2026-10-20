import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {gunzipSync} from 'node:zlib';
import {WebSocket} from 'ws';
import {prepareViewerAssets} from '../live/viewer-assets.mjs';
import {createPublicViewerServer} from '../service/viewer-assets-http.mjs';
import {loadPublicViewerConfig,PublicViewerConfigError} from '../viewer/public-config.mjs';
import {fixture,audience,pending} from './fixtures/viewer-access-harness.mjs';
import {sessionStoreSupported} from '../service/session-store.mjs';
const [assets,local]=await Promise.all([prepareViewerAssets({mode:'public'}),prepareViewerAssets()]);
const config={gatewayOrigin:'https://gateway.example',allowedParentOrigins:[audience,'https://another.example'],preparedAssets:assets};
async function listen(t,server){t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise(r=>server.close(r));});server.listen(0,'127.0.0.1');await once(server,'listening');return 'http://127.0.0.1:'+server.address().port;}
async function server(t,options={}){return listen(t,await createPublicViewerServer({...config,...options}));}
function raw(base,path='/',options={}){return new Promise((resolve,reject)=>{const req=request(base+path,{agent:false,...options},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,bytes:Buffer.concat(chunks)}));res.on('error',reject);});req.on('error',reject);req.end(options.body);});}
const metadata=()=>({schema:'public-viewer-v1',gatewayOrigin:config.gatewayOrigin,allowedParentOrigins:config.allowedParentOrigins,viewerBuild:assets.build});
const response=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('public no-store entry keeps the exact private gateway module/Wasm build and adds only the public boot marker',()=>{
 assert.equal(assets.build,local.build);assert.equal(assets.prefix,local.prefix);assert.equal(assets.wasmSha256,local.wasmSha256);
 assert.ok(assets.get('/').bytes.includes(Buffer.from('<meta name="remote-paint-mode" content="public">')));assert.ok(!local.get('/').bytes.includes(Buffer.from('name="remote-paint-mode"')));assert.notEqual(assets.get('/').etag,local.get('/').etag);assert.equal(assets.get('/').gzip,null);
 for(const path of ['/live.mjs','/stream-worker.mjs','/connection.mjs','/public-config.mjs','/vendor/canvaskit.wasm'])assert.deepEqual(assets.get(assets.prefix+path).bytes,local.get(local.prefix+path).bytes);
 assert.ok(assets.get('/live.mjs').bytes.includes(Buffer.from(assets.prefix+'/public-config.mjs')));
});

test('public module dependency graph resolves every static import to one canonical hashed HTTP module',async t=>{
 const base=await server(t),queue=[assets.prefix+'/live.mjs',assets.prefix+'/stream-worker.mjs'],visited=new Map();
 while(queue.length){const path=queue.shift();if(visited.has(path))continue;assert.ok(path.startsWith(assets.prefix+'/'),path);assert.ok(visited.size<64);const result=await raw(base,path);assert.equal(result.status,200,path);assert.match(result.headers['content-type'],/javascript/);const source=result.bytes.toString('utf8'),dependencies=[];
  for(const match of source.matchAll(/(?:import|export)[^;\n]*?\bfrom\s*(['"])([^'"]+)\1/g)){const url=new URL(match[2],base+path);assert.equal(url.origin,base);assert.ok(url.pathname.startsWith(assets.prefix+'/'),url.pathname);assert.equal(url.search,'');assert.equal(url.hash,'');dependencies.push(url.pathname);queue.push(url.pathname);}
  visited.set(path,dependencies);
 }
 assert.ok(visited.has(assets.prefix+'/embed-bridge.mjs'));assert.ok(visited.has(assets.prefix+'/viewer-control.mjs'));assert.ok(visited.has(assets.prefix+'/viewer-channel.mjs'));assert.ok(visited.get(assets.prefix+'/embed-bridge.mjs').includes(assets.prefix+'/viewer-control.mjs'));assert.ok(visited.get(assets.prefix+'/viewer-control.mjs').every(path=>path===assets.prefix+'/viewer-channel.mjs'));
 assert.ok(visited.get(assets.prefix+'/live.mjs').includes(assets.prefix+'/viewer-telemetry.mjs'));assert.deepEqual(visited.get(assets.prefix+'/viewer-telemetry.mjs'),[assets.prefix+'/viewer-channel.mjs']);
 assert.ok(visited.get(assets.prefix+'/embed-bridge.mjs').includes(assets.prefix+'/viewer-telemetry.mjs'));
});

test('public factory requires exact bounded Origins and public prepared assets',async()=>{
 for(const options of [{gatewayOrigin:'*'},{gatewayOrigin:'https://gateway.example/path'},{gatewayOrigin:'http://public.example'},{allowedParentOrigins:['*']},{allowedParentOrigins:['https://user:password@example.test']},{allowedParentOrigins:[audience,audience]},{allowedParentOrigins:Array(33).fill(audience)},{allowedParentOrigins:undefined},{preparedAssets:local},{requestTimeoutMs:0},{maxConnections:0}])await assert.rejects(createPublicViewerServer({...config,...options}),TypeError);
 await assert.rejects(prepareViewerAssets({mode:'unknown'}),TypeError);
});

test('actual HTTP config/entry emit configured CSP, distinct parent/gateway boundaries and no private credentials',async t=>{
 const parents=[audience],base=await server(t,{allowedParentOrigins:parents});parents.push('https://must-not-be-added.example');
 for(const path of ['/','/viewer-config']){
  const result=await raw(base,path);assert.equal(result.status,200);assert.equal(result.headers['cache-control'],'no-store');assert.equal(result.headers['referrer-policy'],'no-referrer');assert.equal(result.headers['x-content-type-options'],'nosniff');assert.equal(result.headers['cross-origin-resource-policy'],'same-origin');assert.equal(result.headers['access-control-allow-origin'],undefined);assert.equal(result.headers['x-frame-options'],undefined);
  const csp=result.headers['content-security-policy'];assert.ok(csp.includes("frame-ancestors "+audience));assert.ok(csp.includes("connect-src 'self' wss://gateway.example"));assert.ok(!csp.includes('must-not-be-added'));assert.ok(!csp.includes('127.0.0.1:*'));assert.ok(!csp.includes("'unsafe-inline'"));
 }
 const result=await raw(base,'/viewer-config'),value=JSON.parse(result.bytes);assert.deepEqual(Object.keys(value).sort(),['allowedParentOrigins','gatewayOrigin','schema','viewerBuild'].sort());assert.deepEqual(value.allowedParentOrigins,[audience]);assert.equal(value.viewerBuild,assets.build);assert.doesNotMatch(result.bytes.toString(),/apiKey|nativePort|streamOrigin|ticket|sessionId|sourceKey/);
 const loaded=await loadPublicViewerConfig({origin:base});assert.equal(loaded.gatewayOrigin,config.gatewayOrigin);assert.ok(Object.isFrozen(loaded));assert.ok(Object.isFrozen(loaded.allowedParentOrigins));
});

test('an empty parent allowlist denies all framing and loopback gateway development is explicit',async t=>{
 const base=await server(t,{allowedParentOrigins:[],gatewayOrigin:'http://127.0.0.1:4555'}),result=await raw(base);assert.ok(result.headers['content-security-policy'].includes("frame-ancestors 'none'"));assert.ok(result.headers['content-security-policy'].includes("connect-src 'self' ws://127.0.0.1:4555"));assert.deepEqual((await loadPublicViewerConfig({origin:base})).allowedParentOrigins,[]);
});

test('actual HTTP hashed assets retain gzip, ETags, HEAD, 304 and stale-build 410 semantics',async t=>{
 const base=await server(t),path=assets.prefix+'/live.mjs',compressed=await raw(base,path,{headers:{'accept-encoding':'gzip'}}),plain=await raw(base,path,{headers:{'accept-encoding':'gzip;q=0'}});
 assert.equal(compressed.status,200);assert.equal(compressed.headers['content-encoding'],'gzip');assert.deepEqual(gunzipSync(compressed.bytes),plain.bytes);assert.equal(plain.headers['content-encoding'],undefined);assert.equal(plain.headers['cache-control'],'public, max-age=31536000, immutable');assert.notEqual(compressed.headers.etag,plain.headers.etag);
 const head=await raw(base,path,{method:'HEAD',headers:{'accept-encoding':'gzip'}});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers['content-length']),compressed.bytes.length);
 assert.equal((await raw(base,path,{headers:{'if-none-match':plain.headers.etag}})).status,304);assert.equal((await raw(base,path,{headers:{'if-none-match':'W/'+plain.headers.etag}})).status,304);assert.equal((await raw(base,'/',{headers:{'if-none-match':'*'}})).status,200);
 assert.equal((await raw(base,'/assets/'+'f'.repeat(64)+'/live.mjs')).status,410);assert.equal((await raw(base,'/live.mjs')).headers['cache-control'],'no-cache');
 assert.equal((await raw(base,'/viewer-config',{method:'HEAD'})).bytes.length,0);
});

test('asset server exposes no private session-config, filesystem, management, key query or WebSocket upgrade',async t=>{
 const base=await server(t);
 for(const path of ['/session-config','/v1/sessions','/v1/viewer/stream','/viewer-config?key=private','/?key=private','/../package.json','/package.json','/%2e%2e/README.md'])assert.equal((await raw(base,path)).status,404,path);
 assert.equal((await raw(base,'/',{method:'POST'})).status,405);assert.equal((await raw(base,'/',{method:'GET',headers:{'content-length':'1'},body:'x'})).status,404);
 await new Promise((resolve,reject)=>{const ws=new WebSocket(base.replace('http:','ws:')+'/stream?key=private',{origin:audience});ws.once('open',()=>{ws.terminate();reject(new Error('Asset server accepted a data connection'));});ws.once('error',()=>resolve());});
});

test('same public/private Viewer build passes the actual Node Source strict Hello check', {skip:!sessionStoreSupported},async t=>{
 const h=await fixture(t,{wasmSha256:local.wasmSha256,viewerBuild:local.build}),grant=await h.issue(),client=await h.connect(grant,{hello:{renderer:{canvaskit:'0.42.0',wasmSha256:assets.wasmSha256},viewerBuild:assets.build}});assert.equal((await client.wait(m=>m.type==='Welcome')).viewerSessionId,h.sessionId);await client.wait(m=>m.type==='FrameCommit');
});

test('config loader uses one fixed same-origin request without credentials or redirects',async()=>{
 let captured;const value=await loadPublicViewerConfig({origin:'https://viewer.example',fetch:async(url,options)=>{captured={url,options};return response(metadata());}});assert.equal(captured.url,'https://viewer.example/viewer-config');assert.equal(captured.options.credentials,'omit');assert.equal(captured.options.redirect,'error');assert.equal(captured.options.cache,'no-store');assert.equal(captured.options.headers,undefined);assert.equal(value.viewerBuild,assets.build);
});

test('config loader rejects wrong schema, fields, builds, Origins, bytes, UTF-8 and HTTP representations',async()=>{
 for(const value of [{...metadata(),schema:'other'},{...metadata(),apiKey:'private'},{...metadata(),viewerBuild:'bad'},{...metadata(),gatewayOrigin:'https://gateway.example/path'},{...metadata(),allowedParentOrigins:[audience,audience]},{...metadata(),allowedParentOrigins:['*']},null])await assert.rejects(loadPublicViewerConfig({origin:'https://viewer.example',fetch:async()=>response(value)}),e=>e.code==='VIEWER_CONFIG_INVALID');
 for(const result of [new Response('redirect',{status:302}),new Response('{}',{headers:{'content-type':'text/plain'}}),new Response('x',{headers:{'content-type':'application/json','content-length':'16385'}}),new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}})])await assert.rejects(loadPublicViewerConfig({origin:'https://viewer.example',fetch:async()=>result}),e=>e.code==='VIEWER_CONFIG_INVALID');
});

test('config loader deadline/abort cancels the body and never retries or retains late responses',async()=>{
 let cancelled=0,calls=0;const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;}});
 await assert.rejects(loadPublicViewerConfig({origin:'https://viewer.example',timeoutMs:50,fetch:async()=>{calls++;return new Response(body,{headers:{'content-type':'application/json'}});}}),e=>e.code==='VIEWER_CONFIG_TIMEOUT');assert.equal(calls,1);assert.equal(cancelled,1);
 const gate=pending(),started=pending(),controller=new AbortController(),loading=loadPublicViewerConfig({origin:'https://viewer.example',signal:controller.signal,fetch:async()=>{started.resolve();return gate.promise;}});await started.promise;controller.abort();await assert.rejects(loading,e=>e.code==='VIEWER_CONFIG_ABORTED');gate.resolve(response(metadata()));
 assert.equal(new PublicViewerConfigError('private-url').code,'VIEWER_CONFIG_INVALID');
});

test('a real redirect is refused before contacting the alternate configuration endpoint',async t=>{
 let targetCalls=0;const target=await listen(t,createServer((_req,res)=>{targetCalls++;res.end('{}');})),base=await listen(t,createServer((_req,res)=>{res.writeHead(302,{location:target+'/viewer-config'});res.end();}));
 await assert.rejects(loadPublicViewerConfig({origin:base}),e=>e.code==='VIEWER_CONFIG_INVALID');assert.equal(targetCalls,0);
});
