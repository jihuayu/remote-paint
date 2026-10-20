// Tests only. Verify the real renderer's scheduler clock against this Linux
// controller's monotonic interval and its pinned process/time namespace.
import assert from 'node:assert/strict';
import {readlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {LinuxProcessProbe,readLinuxMemoryText} from '../native/process-memory-linux.mjs';
export const LINUX_SOURCE_CLOCK_DEADLINE_MS=5000;
export function linuxSourceClockContext(source){
 const capture=source?.capture,binding=capture?.binding,config=binding?.config,pid=Number(source?.producer?.split(':')[0]);
 const context={bindingId:config?.id??null,producer:source?.producer??null,pid:Number.isSafeInteger(pid)&&pid>0&&pid<=2147483647?pid:null,pageEpoch:source?.pageEpoch??null,viewportVersion:source?.viewportVersion??null,documentToken:source?.nativeDocumentToken??null,revision:capture?.revision??null,bindingRevision:binding?.revision??null,world:capture?.world??null,bindingWorld:binding?.world??null,registered:binding?.registered===true,transitioning:source?.transitioning!==false||capture?.transitioning!==false,needsDocument:capture?.needsDocument!==false,terminal:!!(source?.closed||source?.targetCrashed||capture?.stopped||capture?.failure||source?.broker?.closed||source?.broker?.exited||source?.browser?.isConnected()===false)};
 context.ready=!!(source&&capture&&!context.terminal&&!context.transitioning&&!context.needsDocument&&context.registered&&typeof context.bindingId==='string'&&context.bindingId.length>0&&context.pid&&typeof context.producer==='string'&&/^\d+:\d+$/.test(context.producer)&&Number.isSafeInteger(context.pageEpoch)&&context.pageEpoch>0&&Number.isSafeInteger(context.viewportVersion)&&context.viewportVersion>0&&typeof context.documentToken==='string'&&context.documentToken.length>0&&Number.isSafeInteger(context.revision)&&context.revision===context.bindingRevision&&context.world&&context.world===context.bindingWorld&&config.pageEpoch===context.pageEpoch&&capture.pageEpoch===context.pageEpoch&&config.viewportVersion===context.viewportVersion&&capture.viewportVersion===context.viewportVersion&&config.documentToken===context.documentToken&&capture.documentToken===context.documentToken);
 return context;
}
export async function acquireLinuxSourceClockContext(getSource,{signal=AbortSignal.timeout(LINUX_SOURCE_CLOCK_DEADLINE_MS)}={}){
 const started=performance.now();let attempts=0,initial=null,last=null;
 try{
  for(;;){
   signal?.throwIfAborted();const source=getSource(),context=linuxSourceClockContext(source);attempts++;initial??=context;last=context;
   if(context.terminal)throw new Error('Source clock owner is terminal');
   if(context.ready)return {source,context,acquisition:{attempts,waitedMs:performance.now()-started,initial,last}};
   await delay(10,undefined,{signal});
  }
 }catch(cause){const acquisition={attempts,waitedMs:performance.now()-started,initial,last},error=new Error('Linux Source clock readiness failed: '+JSON.stringify(acquisition),{cause});error.clockProbe={stage:'acquiring-context',acquisition};throw error;}
}
export function verifyLinuxClockInterval(reply,beforeNs,afterNs){
 assert.equal(reply.clock,'chromium-time-ticks-v1');assert.ok(Number.isSafeInteger(reply.nowMicros)&&reply.nowMicros>0);
 assert.ok(typeof beforeNs==='bigint'&&typeof afterNs==='bigint'&&beforeNs>=0n&&afterNs>=beforeNs);
 const stamp=BigInt(reply.nowMicros)*1000n;
 assert.ok(stamp>=beforeNs-1000n&&stamp<=afterNs+1000n,'Native TimeTicks is outside the actual Linux hrtime interval');
 return {beforeNs:beforeNs.toString(),afterNs:afterNs.toString(),nativeMicros:reply.nowMicros,integerStampAllowanceNs:1000};
}
export function createLinuxSourceClockProbe(getSource){
 assert.equal(process.platform,'linux');assert.equal(typeof getSource,'function');let pending=false;
 return async()=>{
  assert.equal(pending,false,'One Linux Source clock identity probe at a time');pending=true;let processProbe;
  const started=performance.now(),signal=AbortSignal.timeout(LINUX_SOURCE_CLOCK_DEADLINE_MS);let acquisition,source,context,stage='acquiring-context';
  try{
   ({source,context,acquisition}=await acquireLinuxSourceClockContext(getSource,{signal}));const {bindingId:binding,pageEpoch:epoch,viewportVersion:version,documentToken:document,pid}=context;stage='pinning-renderer';
   const sameContext=()=>{signal.throwIfAborted();assert.equal(getSource(),source,'Source clock owner changed');assert.deepEqual(linuxSourceClockContext(source),context,'Source clock context changed during identity probe');};
   processProbe=await LinuxProcessProbe.open(pid,{signal});const before=await processProbe.sample({details:false,children:false});assert.ok(before.row.isChromium);
   const namespace=await readlink(processProbe.path+'/ns/time'),controllerNamespace=await readlink('/proc/self/ns/time');assert.match(namespace,/^time:\[\d+\]$/);assert.equal(namespace,controllerNamespace);
   const bootId=(await readLinuxMemoryText('/proc/sys/kernel/random/boot_id',signal)).trim();assert.match(bootId,/^[a-f0-9-]{36}$/);
   sameContext();stage='native-scheduler';const beforeNs=process.hrtime.bigint(),reply=await source.capture.command('scheduler',binding),afterNs=process.hrtime.bigint(),interval=verifyLinuxClockInterval(reply,beforeNs,afterNs);
   assert.equal(reply.ok,true);assert.equal(reply.rendererProcessId,pid);sameContext();stage='verifying-renderer';
   const after=await processProbe.sample({details:false,children:false,expectedIdentity:before.row.identity});assert.deepEqual(after.row.identity,before.row.identity);assert.equal(await readlink(processProbe.path+'/ns/time'),namespace);assert.equal(await readlink('/proc/self/ns/time'),controllerNamespace);sameContext();assert.ok(performance.now()-started<=LINUX_SOURCE_CLOCK_DEADLINE_MS);
   const domainId=createHash('sha256').update(bootId+'\0'+namespace).digest('hex');
   return {reply,pageEpoch:epoch,viewportVersion:version,provenance:{kind:'actual-current-Source-private-scheduler',bindingId:binding,documentToken:document,producer:context.producer,acquisition,linuxMonotonic:{schema:'linux-native-monotonic-probe-v1',domainId,timeNamespace:namespace,rendererIdentity:before.row.identity,interval,scope:'Actual current native scheduler stamp lies inside Linux controller hrtime request/response interval;renderer proc FD identity and same time namespace verified before/after. Shared-domain interpretation additionally depends on the pinned Chromium Linux TimeTicks implementation;not an assertion about other platforms or arbitrary clock overrides.'}}};
  }catch(error){error.clockProbe??={stage,elapsedMs:performance.now()-started,acquisition:acquisition??null,current:linuxSourceClockContext(source??getSource())};throw error;
  }finally{try{await processProbe?.close();}finally{pending=false;}}
 };
}
