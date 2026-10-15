import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir} from 'node:fs/promises';
import {fileHash,verifyLinuxReceipt} from '../native/linux-receipt.mjs';

test('runtime refuses stale native sources even when binary, arguments and patch receipts match',async()=>{
 const nativeSources={};
 for(const name of (await readdir(new URL('../native/chromium/',import.meta.url))).sort())nativeSources[name]=await fileHash(new URL(`../native/chromium/${name}`,import.meta.url));
 // Unit-level receipt data only; real acceptance independently checks ARM64 ELF.
 const expected={browserSha256:'a'.repeat(64),serializerSha256:'b'.repeat(64),argsSha256:'c'.repeat(64),patches:{}};
 const receipt={format:1,target:{os:'linux',cpu:'arm64'},chromiumRevision:'a49e2e3d4addfd84e765b52afe230bedb81096db',skiaRevision:'29ed1e87a0a50f3d8347e988842d9d59e7573efa',nativeSources,patches:{},argsSha256:expected.argsSha256,binaries:{headless_shell:expected.browserSha256,serializer_tests:expected.serializerSha256},incrementalGraphUpToDate:true};
 await verifyLinuxReceipt(receipt,expected);
 await assert.rejects(verifyLinuxReceipt({...receipt,nativeSources:{...nativeSources,'viz_capture.cc':'0'.repeat(64)}},expected),/Native build sources differ/);
 await assert.rejects(verifyLinuxReceipt({...receipt,binaries:{...receipt.binaries,headless_shell:'0'.repeat(64)}},expected));
});
