// Actual Mac Chromium/libproc diagnostic. Close only this test's secondary
// context after a real process census, then query the obsolete complete batch.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {launchCaptureBrowser} from '../capture/browser.mjs';
import {createNativeProcessMemorySampler} from './process-native-memory.mjs';
import {sampleBrowserNativeMemory} from './browser-native-memory.mjs';

assert.equal(process.platform,'darwin');
const output=process.env.REMOTE_PAINT_BROWSER_CENSUS_OUTPUT??'artifacts/browser-native-memory-census';await mkdir(output,{recursive:true});
const fixture=createServer((_request,response)=>response.end('<!doctype html><body>Owned census lifetime<script>window.censusNonce=crypto.randomUUID();if(location.pathname==="/primary"){const worker=new Worker(URL.createObjectURL(new Blob(["postMessage(crypto.randomUUID());onmessage=()=>{}"],{type:"text/javascript"})));worker.onmessage=e=>window.censusWorkerNonce=e.data;}</script>'));
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const attempts=[],checks=[],tracked=new Map(),batches=[],cohorts=[];let browser,root,sampler,primary,secondary,browserVersion,provenance,failure,cleanup,reproduction,corrected;
const gone=error=>error.code==='NATIVE_MEMORY_IDENTITY_CHANGED'||error.code==='NATIVE_MEMORY_OS_READ'&&[2,4,5].includes(error.nativeStatus)&&error.errno===3;
const remember=batch=>{for(const row of batch.processes)tracked.set([row.pid,row.identity.startSeconds,row.identity.startMicroseconds].join(':'),row);batches.push(batch);return batch;};
const onAttempt=async receipt=>attempts.push(receipt);
async function until(predicate,label){const end=performance.now()+5000;while(!await predicate()){assert.ok(performance.now()<end,label);await delay(10);}}
async function census(){return (await root.send('SystemInfo.getProcessInfo')).processInfo;}
async function lifetime(){const page=await primary.evaluate(()=>({nonce:window.censusNonce,workerNonce:window.censusWorkerNonce})),{targetInfos}=await root.send('Target.getTargets');return {page,workers:targetInfos.filter(t=>t.type==='worker').map(t=>t.targetId).sort()};}
try{
 sampler=await createNativeProcessMemorySampler();provenance=sampler.provenance;browser=await launchCaptureBrowser();browserVersion=browser.version();root=await browser.newBrowserCDPSession();
 primary=await browser.newPage();await primary.goto(`http://127.0.0.1:${fixture.address().port}/primary`);await primary.waitForFunction(()=>window.censusWorkerNonce);
 const initialLifetime=await lifetime();assert.equal(initialLifetime.workers.length,1);const initial=await census();remember(await sampler.sample(initial,{onAttempt}));
 secondary=await browser.newPage();await secondary.goto(`http://127.0.0.1:${fixture.address().port}/secondary`);await secondary.waitForFunction(()=>window.censusNonce);
 const before=await census(),positive=remember(await sampler.sample(before,{onAttempt}));await secondary.close();secondary=null;let after,retired;
 await until(async()=>{after=await census();const live=new Set(after.map(p=>Number(p.id)));retired=before.filter(p=>p.type==='renderer'&&!live.has(Number(p.id)));return retired.length>0;},'actual secondary renderer leaves the census');
 assert.ok(retired.some(p=>!initial.some(old=>old.id===p.id)));const retiredIds=retired.map(p=>Number(p.id));
 // The whole obsolete batch is sent unchanged, with identities measured by
 // libproc immediately before close. No missing row is removed or zero-filled.
 const obsolete=before.map(p=>({...p,identity:positive.processes.find(row=>row.pid===Number(p.id)).identity}));let errorRecord;
 await assert.rejects(sampler.sample(obsolete,{onAttempt}),error=>{errorRecord={code:error.code,nativeStatus:error.nativeStatus,errno:error.errno,failedPid:error.failedPid,receipt:error.receipt};return gone(error)&&retiredIds.includes(error.failedPid);});
 assert.equal(errorRecord.code,'NATIVE_MEMORY_OS_READ');assert.equal(errorRecord.errno,3);checks.push('A real positive full census becomes an ESRCH batch after this test closes its secondary context; legacy direct sampling rejects the entire unchanged batch');
 const fresh=remember(await sampler.sample(await census(),{onAttempt}));assert.ok(fresh.processes.length>0);assert.equal(fresh.sampling.helperPid,attempts[0].helperPid);assert.ok(fresh.processes.every(p=>!retiredIds.includes(p.pid)));assert.deepEqual(await lifetime(),initialLifetime);checks.push('The same persistent helper can measure a complete fresh census and original primary page/Worker identity remains unchanged; not a fixed production integration');
 reproduction={initialPids:initial.map(p=>Number(p.id)),before:before.map(p=>({id:Number(p.id),type:p.type})),after:after.map(p=>({id:Number(p.id),type:p.type})),retiredIds,error:errorRecord,initialLifetime,finalLifetime:await lifetime()};
 // A second real context reproduces the same interval inside the actual
 // acquisition callback. Native replies, OS rows and subsequent CDP censuses
 // remain real; the explicit barrier is this test's own context close.
 secondary=await browser.newPage();await secondary.goto(`http://127.0.0.1:${fixture.address().port}/secondary`);await secondary.waitForFunction(()=>window.censusNonce);let injectClose=true,correctedRetired=[];
 const value=remember(await sampleBrowserNativeMemory({sampler,onAttempt,onCohort:async row=>cohorts.push(row),readLifetime:async()=>{const value=await lifetime();return {pages:[{id:'primary',nonce:JSON.stringify(value.page)}],workers:value.workers};},getInventory:async()=>{
  const rows=await census();if(injectClose){injectClose=false;remember(await sampler.sample(rows,{onAttempt}));await secondary.close();secondary=null;await until(async()=>{const live=new Set((await census()).map(p=>Number(p.id)));correctedRetired=rows.filter(p=>p.type==='renderer'&&!live.has(Number(p.id))).map(p=>Number(p.id));return correctedRetired.length>0;},'actual corrected retirement barrier');}return rows;
 }}));
 assert.deepEqual(value.sampling.cohort.attempts.map(a=>a.status),['retired-process-confirmed','passed']);assert.ok(correctedRetired.includes(value.sampling.cohort.attempts[0].error.failedPid));assert.ok(value.processes.every(p=>!correctedRetired.includes(p.pid)));assert.deepEqual(value.processes.map(p=>p.pid).sort((a,b)=>a-b),(await census()).map(p=>Number(p.id)).sort((a,b)=>a-b));assert.deepEqual(await lifetime(),initialLifetime);assert.equal(value.sampling.helperPid,attempts[0].helperPid);assert.ok(value.sampling.cohort.elapsedMs<=5000);
 const rejected=value.sampling.cohort.attempts[0].error;assert.ok(attempts.some(a=>a.requestId===rejected.requestId&&a.status===rejected.code&&a.failedPid===rejected.failedPid));assert.equal(value.sampling.requestId,rejected.requestId+1);
 corrected={retiredIds:correctedRetired,result:value};checks.push('Integrated acquisition retains and joins the ESRCH request receipt,confirms absence in fresh complete CDP census,and remeasures every remaining process with same helper,primary page/Worker and original5s budget');
}catch(error){failure=error.stack;}
finally{
 const errors=[];try{await secondary?.close();}catch(error){errors.push(error.message);}try{await browser?.close();}catch(error){errors.push(error.message);}
 const remaining=new Map(tracked);try{if(sampler)await until(async()=>{for(const[key,row]of remaining){try{await sampler.sample([{id:row.pid,type:row.kind,identity:{startSeconds:row.identity.startSeconds,startMicroseconds:row.identity.startMicroseconds}}],{onAttempt});}catch(error){if(!gone(error))throw error;remaining.delete(key);}}return remaining.size===0;},'owned browser process start identities retire');}catch(error){errors.push(error.message);}
 let helper;try{helper=await sampler?.close();}catch(error){errors.push(error.message);}await new Promise(resolve=>fixture.close(resolve));
 cleanup={errors,trackedProcessIdentities:tracked.size,unconfirmedProcessIdentities:remaining.size,helper,fixtureListening:fixture.listening};try{assert.deepEqual(errors,[]);assert.equal(remaining.size,0);assert.ok(tracked.size>=5);assert.equal(helper?.exited,true);assert.equal(helper?.exitCode,0);}catch(error){failure??=error.stack;}
}
const report={at:new Date().toISOString(),status:failure?'failed':'passed',scope:'Controlled actual Mac Chromium process-census retirement reproduces a fresh libproc ESRCH batch with a known previously positive renderer identity. Integrated bounded complete-census acquisition preserves original page/Worker and every failed attempt,then performs a fresh complete kernel batch with same helper inside original5s. Not exact original failedPID cause,600s/physical/8h/all41 acceptance.',checks,browserVersion,provenance,reproduction,corrected,batches,cohorts,attempts,cleanup,...(failure?{error:failure}:{})};
await writeFile(output+'/census.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:report.status,checks:checks.length,retiredIds:reproduction?.retiredIds,cleanup,error:failure}));if(failure)throw new Error(failure);
