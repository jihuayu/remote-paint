import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
test('retired Wasm bytes follow a live backing store beyond the module wrapper lifetime',async()=>{
 const {stdout}=await promisify(execFile)(process.execPath,['--expose-gc',fileURLToPath(new URL('./fixtures/retired-wasm-backing.mjs',import.meta.url))],{timeout:10000,maxBuffer:65536});
 const report=JSON.parse(stdout);assert.equal(report.status,'passed');assert.equal(report.wrapperCollected,true);assert.equal(report.heldSnapshot.retiredWasmBytes,report.bytes);assert.equal(report.after.retiredWasmBytes,0);
});
