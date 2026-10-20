// Test-only complete browser cohort measurement. A failed libproc batch never
// contributes rows; only confirmed process retirement permits one fresh batch.
import {isDeepStrictEqual} from 'node:util';
import {NATIVE_MEMORY_LIMITS} from './process-native-memory.mjs';
export const BROWSER_NATIVE_MEMORY_LIMITS=Object.freeze({attempts:2,phaseMs:NATIVE_MEMORY_LIMITS.phaseMs,processes:NATIVE_MEMORY_LIMITS.processes});
const fail=(code,message)=>Object.assign(new Error(message),{code});
function inventory(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>BROWSER_NATIVE_MEMORY_LIMITS.processes)throw fail('BROWSER_MEMORY_INVENTORY','Invalid browser process census');
 const seen=new Set();return rows.map(row=>{const id=Number(row.id);if(!Number.isInteger(id)||id<1||id>2147483647||seen.has(id)||typeof row.type!=='string'||!row.type.length||row.type.length>64)throw fail('BROWSER_MEMORY_INVENTORY','Invalid browser process identity');seen.add(id);return {id,type:row.type};}).sort((a,b)=>a.id-b.id);
}
function lifetime(value){
 if(!value||!Array.isArray(value.pages)||!value.pages.length||value.pages.length>16||!Array.isArray(value.workers)||value.workers.length>32)throw fail('BROWSER_MEMORY_LIFETIME','Invalid browser lifetime witness');
 const pages=value.pages.map(page=>{if(typeof page.id!=='string'||!page.id.length||page.id.length>64||typeof page.nonce!=='string'||!page.nonce.length||page.nonce.length>512)throw fail('BROWSER_MEMORY_LIFETIME','Invalid page lifetime witness');return {id:page.id,nonce:page.nonce};}).sort((a,b)=>a.id.localeCompare(b.id));
 const workers=[...value.workers].sort();if(new Set(pages.map(p=>p.id)).size!==pages.length||new Set(workers).size!==workers.length||workers.some(id=>typeof id!=='string'||!id.length||id.length>128))throw fail('BROWSER_MEMORY_LIFETIME','Invalid Worker lifetime witness');return {pages,workers};
}
export async function sampleBrowserNativeMemory({getInventory,readLifetime,sampler,onAttempt=async()=>{},onCohort=async()=>{}}={}){
 if(typeof getInventory!=='function'||typeof readLifetime!=='function'||typeof sampler?.sample!=='function'||typeof onAttempt!=='function'||typeof onCohort!=='function')throw new TypeError('Configure actual browser census, lifetime witness and native sampler');
 const started=performance.now(),attempts=[];let initialLifetime,evidenceFailed=false;
 const budget=()=>{if(performance.now()-started>=BROWSER_NATIVE_MEMORY_LIMITS.phaseMs)throw fail('BROWSER_MEMORY_PHASE_DEADLINE','Complete browser memory measurement exceeded original5s');};
 const step=async work=>{
  budget();let timer;try{const value=await Promise.race([Promise.resolve().then(()=>{budget();return work();}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('BROWSER_MEMORY_PHASE_DEADLINE','Complete browser memory measurement exceeded original5s')),BROWSER_NATIVE_MEMORY_LIMITS.phaseMs-(performance.now()-started));})]);budget();return value;}finally{clearTimeout(timer);}
 };
 const sameLifetime=async()=>{const current=lifetime(await step(readLifetime));if(!isDeepStrictEqual(current,initialLifetime))throw fail('BROWSER_MEMORY_LIFETIME_CHANGED','Persistent browser page or Worker changed during memory measurement');};
 const emit=async row=>{try{await step(()=>onCohort(structuredClone(row)));}catch(error){evidenceFailed=true;throw error;}};
 try{
  initialLifetime=lifetime(await step(readLifetime));let before=inventory(await step(getInventory));
  for(let attempt=1;attempt<=BROWSER_NATIVE_MEMORY_LIMITS.attempts;attempt++){
   const row={attempt,status:'started',before};attempts.push(row);await emit(row);let measured;
   try{measured=await step(()=>sampler.sample(before,{onAttempt}));}
   catch(error){
    row.error={code:error.code??null,nativeStatus:error.nativeStatus??null,errno:error.errno??null,failedPid:error.failedPid??null,requestId:error.receipt?.requestId??null};
    const retryable=error.code==='NATIVE_MEMORY_OS_READ'&&error.nativeBatch===true&&[2,4,5].includes(error.nativeStatus)&&error.errno===3&&before.some(p=>p.id===error.failedPid)&&attempt<BROWSER_NATIVE_MEMORY_LIMITS.attempts;
    if(!retryable){row.status='failed';await emit(row);throw error;}
    await sameLifetime();const after=inventory(await step(getInventory));row.after=after;
    if(after.some(p=>p.id===error.failedPid)){row.status='failed-process-still-listed';await emit(row);throw error;}
    row.status='retired-process-confirmed';await emit(row);before=after;continue;
   }
   // Preserve a positive native batch even when the subsequent census or VM
   // witness changes. Such a batch fails; it cannot hide a cap breach behind
   // a later lower measurement or a cached/subset inventory.
   row.measured=measured;row.after=inventory(await step(getInventory));
   if(!isDeepStrictEqual(before,row.after)){row.status='failed-census-changed';await emit(row);throw fail('BROWSER_MEMORY_COHORT_CHANGED','Browser process census changed around a positive native batch');}
   await sameLifetime();row.status='passed';await emit(row);
   return {...measured,sampling:{...measured.sampling,cohort:{schema:'browser-native-memory-cohort-v1',attempts,elapsedMs:performance.now()-started,phaseDeadlineMs:BROWSER_NATIVE_MEMORY_LIMITS.phaseMs,lifetime:initialLifetime}},scope:measured.scope+' Complete identical before/after browser census and persistent page/Worker witness;at most one entirely fresh retry after kernel ESRCH plus confirmed census absence,within original5s. Not an atomic process snapshot.'};
  }
  throw fail('BROWSER_MEMORY_ATTEMPT_LIMIT','Browser process cohort did not stabilize');
 }catch(error){
  // Lifetime/census read failures also keep the last positive raw batch.
  const last=attempts.at(-1);if(last?.status==='started'){
   last.status='failed';last.error??={code:error.code??null};
   if(!evidenceFailed&&performance.now()-started<BROWSER_NATIVE_MEMORY_LIMITS.phaseMs)try{await emit(last);}catch(diagnostic){error.evidenceFailure=diagnostic.code??'BROWSER_MEMORY_EVIDENCE_FAILED';}
  }
  error.cohort={schema:'browser-native-memory-cohort-v1',attempts,elapsedMs:performance.now()-started,phaseDeadlineMs:BROWSER_NATIVE_MEMORY_LIMITS.phaseMs,lifetime:initialLifetime??null};throw error;
 }
}
