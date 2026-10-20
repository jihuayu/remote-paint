import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {adaptCanvasKitGlue} from '../live/canvaskit-glue.mjs';
const path=new URL('../node_modules/canvaskit-wasm/bin/full/canvaskit.js',import.meta.url),bytes=await readFile(path);
test('CanvasKit adapter refuses a different upstream build',()=>{
 assert.throws(()=>adaptCanvasKitGlue(Buffer.concat([bytes,Buffer.from('\n')])),/Unsupported CanvasKit/);
});
test('actual pinned glue forwards the exact provided buffer before any file or HTTP load',async()=>{
 const calls=[],provided=Uint8Array.of(0,1,2,3),wasm=Object.create(WebAssembly);
 wasm.instantiate=(binary,imports)=>{calls.push({binary,imports});return new Promise(()=>{});};
 const context={process,require:createRequire(path),module:{exports:{}},__filename:path.pathname,__dirname:new URL('.',path).pathname,
  console,WebAssembly:wasm,fetch(){throw Error('Unexpected HTTP load');},TextDecoder,TextEncoder};
 vm.runInNewContext(adaptCanvasKitGlue(bytes).toString('utf8'),context,{timeout:1000});
 // Keep instantiation pending so no fake CanvasKit exports can stand in for
 // the real engine. This verifies the actual upstream glue's loading branch.
 void context.CanvasKitInit({wasmBinary:provided,locateFile(){return new URL('canvaskit.wasm',path).pathname;}});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);assert.equal(calls[0].binary,provided);assert.equal(typeof calls[0].imports,'object');
});
