import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {makeStaticAssets,acceptsGzip} from '../live/static-assets.mjs';
function fixture(){return new Map([
 ['/',{type:'text/html',bytes:Buffer.from('<script type="module" src="/live.mjs"></script>')}],
 ['/live.mjs',{type:'text/javascript',bytes:Buffer.from("import '/protocol/wire.mjs';export {version} from '../protocol/wire.mjs';new Worker('/stream-worker.mjs');fetch('/session-config');const build='__REMOTE_PAINT_VIEWER_BUILD__',wasm='__REMOTE_PAINT_WASM_SHA__';")}],
 ['/stream-worker.mjs',{type:'text/javascript',bytes:Buffer.from("fetch('/vendor/canvaskit.wasm');const locate=file=>`/vendor/${file}`;")}],
 ['/protocol/wire.mjs',{type:'text/javascript',bytes:Buffer.from('export const version=4;')}],
 ['/vendor/canvaskit.wasm',{type:'application/wasm',bytes:Buffer.alloc(4096,17)}],
 ]);}
test('asset namespace changes with source bytes and rewrites only static paths',async()=>{
 const inputs=fixture(),assets=await makeStaticAssets(inputs),source=assets.get(`${assets.prefix}/live.mjs`);
 assert.ok(source.immutable);assert.match(source.bytes.toString(),new RegExp(assets.build));assert.ok(source.bytes.includes(Buffer.from(`import '${assets.prefix}/protocol/wire.mjs'`)));
 assert.ok(source.bytes.includes(Buffer.from("fetch('/session-config')")));
 assert.ok(source.bytes.includes(Buffer.from(`from '${assets.prefix}/protocol/wire.mjs'`)),'Flattened Viewer module must keep protocol imports inside the immutable namespace');
 assert.ok(assets.get('/').bytes.includes(Buffer.from(`${assets.prefix}/live.mjs`)));
 assert.ok(assets.get('/stream-worker.mjs').bytes.includes(Buffer.from(`\`${assets.prefix}/vendor/`)));
 const expected=createHash('sha256').update(inputs.get('/vendor/canvaskit.wasm').bytes).digest('hex');assert.ok(source.bytes.includes(Buffer.from(expected)));
 assert.deepEqual(gunzipSync(assets.get('/vendor/canvaskit.wasm').gzip),inputs.get('/vendor/canvaskit.wasm').bytes);
 inputs.get('/live.mjs').bytes=Buffer.from('export const changed=true');const upgraded=await makeStaticAssets(inputs);
 assert.notEqual(upgraded.build,assets.build);assert.equal(upgraded.get(`${assets.prefix}/live.mjs`).expired,true);assert.equal(upgraded.get('/session-config'),null);
});
test('compression negotiation respects explicit exclusion before wildcard',()=>{
 for(const [header,expected]of [['gzip, deflate',true],['br, *;q=.5',true],['gzip;q=0, *;q=1',false],['gzip;q=.2',true],['gzip;q=broken',false],['br',false],['',false]])assert.equal(acceptsGzip(header),expected,header);
});

test('child SDK-relative imports resolve to the same canonical connection and channel modules',async()=>{
 const inputs=fixture();inputs.set('/connection.mjs',{type:'text/javascript',bytes:Buffer.from('export class ViewerConnectionError extends Error{}')});inputs.set('/viewer-channel.mjs',{type:'text/javascript',bytes:Buffer.from('export class ViewerPort{}')});inputs.set('/embed-bridge.mjs',{type:'text/javascript',bytes:Buffer.from("import {ViewerConnectionError} from '../sdk/viewer-connection.mjs';import {ViewerPort} from '../sdk/viewer-channel.mjs';fetch('/viewer-config');")});const assets=await makeStaticAssets(inputs),text=assets.get('/embed-bridge.mjs').bytes.toString();
 assert.ok(text.includes("from '"+assets.prefix+"/connection.mjs'"));assert.ok(text.includes("from '"+assets.prefix+"/viewer-channel.mjs'"));assert.ok(text.includes("fetch('/viewer-config')"));assert.ok(!text.includes('../sdk/'));
});
test('asset compression yields the event loop and concurrent identical builds share work',async()=>{
 const inputs=fixture();inputs.get('/vendor/canvaskit.wasm').bytes=Buffer.alloc(4*1024*1024,29);
 let timerAdvanced=false;const timer=setTimeout(()=>{timerAdvanced=true;},0);
 try{const [first,second]=await Promise.all([makeStaticAssets(inputs),makeStaticAssets(inputs)]);assert.equal(first,second);assert.equal(timerAdvanced,true,'Compression cannot stall active-session control on the Node event loop');}
 finally{clearTimeout(timer);}
});
