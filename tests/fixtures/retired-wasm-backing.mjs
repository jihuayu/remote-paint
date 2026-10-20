// Isolated GC lifetime contract. Never used by a memory soak or acceptance run.
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ClientMemory,memoryPolicy} from '../../protocol/client-memory.mjs';
assert.equal(typeof globalThis.gc,'function','Run this isolated fixture with --expose-gc');
const memory=new ClientMemory(memoryPolicy({profile:'compact'})),bytes=16*1024*1024;
let wrapperCollected=false,heldView,failure,heldSnapshot;
const wrapperRegistry=new FinalizationRegistry(()=>{wrapperCollected=true;});
function makeRetired(){
 const module={HEAPU8:new Uint8Array(new WebAssembly.Memory({initial:bytes/65536}).buffer)};
 module.HEAPU8[0]=197;memory.retire(module);wrapperRegistry.register(module,'module-wrapper');
 return module.HEAPU8;
}
heldView=makeRetired();
async function collectUntil(predicate,label){
 for(let n=0;n<200;n++){globalThis.gc();await delay(10);if(predicate())return;}
 throw new Error('Isolated lifetime test did not reach '+label);
}
try{
 await collectUntil(()=>wrapperCollected,'module wrapper collection');
 assert.equal(heldView[0],197);assert.equal(heldView.buffer.byteLength,bytes);
 heldSnapshot=memory.snapshot();assert.equal(heldSnapshot.retiredWasmBytes,bytes,'Live retired Wasm backing was uncharged when only its module wrapper was collected');
 heldView=null;await collectUntil(()=>memory.snapshot().retiredWasmBytes===0,'released Wasm backing collection');
 assert.equal(memory.snapshot().stats.collectedArenas,1);
}catch(error){failure=error;}
const report={status:failure?'failed':'passed',scope:'Isolated --expose-gc lifetime contract only;not real memory growth/soak/physical footprint evidence. Actual WebAssembly backing remains readable after module wrapper GC;charge persists until backing released.',bytes,wrapperCollected,heldSnapshot,after:memory.snapshot(),error:failure?.stack};
process.stdout.write(JSON.stringify(report)+'\n');if(failure)process.exitCode=1;
