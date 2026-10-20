import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readLinuxMemoryDescriptor,readLinuxMountinfoText,LINUX_MEMORY_LIMITS} from '../native/process-memory-linux.mjs';
function descriptor(bytes,chunks,{onRead}={}){
 let position=0,reads=0;return {get reads(){return reads;},get consumed(){return position;},async read(buffer,offset,length){reads++;onRead?.(reads);const size=Math.min(chunks[reads-1]??length,length,bytes.length-position);bytes.copy(buffer,offset,position,position+size);position+=size;return {bytesRead:size};}};
}
test('legal4053+316byte mount-table chunks are complete at EOF while default single-read process records reject them',async()=>{
 const bytes=Buffer.from('x'.repeat(4369)),continued=descriptor(bytes,[4053,316,0]);assert.equal(await readLinuxMemoryDescriptor(continued,undefined,{continuations:true}),bytes.toString());assert.equal(continued.reads,3);
 const strict=descriptor(bytes,[4053,316,0]);await assert.rejects(readLinuxMemoryDescriptor(strict),e=>e.code==='LINUX_MEMORY_FILE_LIMIT'&&/partial continuation/.test(e.message));assert.equal(strict.reads,2);
});
test('bounded descriptor decoding preserves UTF8 split across kernel chunks and empty files',async()=>{
 const bytes=Buffer.from('a中🙂b'),file=descriptor(bytes,[2,2,1,2,2,0]);assert.equal(await readLinuxMemoryDescriptor(file,undefined,{continuations:true}),bytes.toString());assert.equal(await readLinuxMemoryDescriptor(descriptor(Buffer.alloc(0),[0])), '');
});
test('continuations retain exact64KiB cap and reject the first excess byte without reading the remainder',async()=>{
 const max=LINUX_MEMORY_LIMITS.fileBytes,bytes=Buffer.alloc(max,65);assert.equal(Buffer.byteLength(await readLinuxMemoryDescriptor(descriptor(bytes,Array(16).fill(4096)),undefined,{continuations:true})),max);
 const tooLarge=descriptor(Buffer.alloc(max+1000),Array(20).fill(4096));await assert.rejects(readLinuxMemoryDescriptor(tooLarge,undefined,{continuations:true}),e=>e.code==='LINUX_MEMORY_FILE_LIMIT'&&/exceeded64KiB/.test(e.message));assert.equal(tooLarge.consumed,max+1);assert.equal(tooLarge.reads,17);
 const single=descriptor(Buffer.alloc(max+1),[]);await assert.rejects(readLinuxMemoryDescriptor(single),e=>e.code==='LINUX_MEMORY_FILE_LIMIT');assert.equal(single.reads,1);
});
test('an abort during a continuation stops further reads and returns no partial text',async()=>{
 const controller=new AbortController(),reason=new Error('original phase deadline'),file=descriptor(Buffer.from('abcdef'),[2,2,2],{onRead:n=>{if(n===2)controller.abort(reason);}});
 await assert.rejects(readLinuxMemoryDescriptor(file,controller.signal,{continuations:true}),e=>e===reason);assert.equal(file.reads,2);const before=descriptor(Buffer.from('x'),[]);await assert.rejects(readLinuxMemoryDescriptor(before,controller.signal,{continuations:true}),e=>e===reason);assert.equal(before.reads,0);
});
test('read failure never returns earlier chunks or retries the descriptor',async()=>{
 const error=Object.assign(new Error('read failed'),{code:'EIO'}),file=descriptor(Buffer.from('abcdef'),[2],{onRead:n=>{if(n===2)throw error;}});await assert.rejects(readLinuxMemoryDescriptor(file,undefined,{continuations:true}),e=>e===error);assert.equal(file.reads,2);
});
test('actual complete mountinfo uses the bounded wrapper and retains the original64KiB/5s observer limits',{skip:process.platform!=='linux'},async()=>{
 const before=await readFile('/proc/self/mountinfo','utf8'),actual=await readLinuxMountinfoText(),after=await readFile('/proc/self/mountinfo','utf8');assert.equal(before,after);assert.equal(actual,before);assert.ok(Buffer.byteLength(actual)<=65536);assert.equal(LINUX_MEMORY_LIMITS.fileBytes,65536);assert.equal(LINUX_MEMORY_LIMITS.phaseMs,5000);
});
