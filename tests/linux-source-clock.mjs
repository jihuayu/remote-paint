// Tests only. Verify the real renderer's scheduler clock against this Linux
// controller's monotonic interval and its pinned process/time namespace.
import assert from 'node:assert/strict';
import {readlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {LinuxProcessProbe,readLinuxMemoryText} from '../native/process-memory-linux.mjs';
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
  const started=performance.now(),signal=AbortSignal.timeout(5000);
  try{
   const source=getSource(),binding=source.capture.binding?.config.id,epoch=source.pageEpoch,version=source.viewportVersion,document=source.nativeDocumentToken,pid=Number(source.producer?.split(':')[0]);assert.ok(binding&&Number.isInteger(pid)&&pid>0);
   processProbe=await LinuxProcessProbe.open(pid,{signal});const before=await processProbe.sample({details:false,children:false});assert.ok(before.row.isChromium);
   const namespace=await readlink(processProbe.path+'/ns/time'),controllerNamespace=await readlink('/proc/self/ns/time');assert.match(namespace,/^time:\[\d+\]$/);assert.equal(namespace,controllerNamespace);
   const bootId=(await readLinuxMemoryText('/proc/sys/kernel/random/boot_id',signal)).trim();assert.match(bootId,/^[a-f0-9-]{36}$/);
   const beforeNs=process.hrtime.bigint(),reply=await source.capture.command('scheduler',binding),afterNs=process.hrtime.bigint(),interval=verifyLinuxClockInterval(reply,beforeNs,afterNs);
   assert.equal(reply.ok,true);assert.equal(reply.rendererProcessId,pid);assert.equal(source.capture.binding?.config.id,binding);assert.equal(source.pageEpoch,epoch);assert.equal(source.viewportVersion,version);assert.equal(source.nativeDocumentToken,document);assert.equal(Number(source.producer?.split(':')[0]),pid);
   const after=await processProbe.sample({details:false,children:false,expectedIdentity:before.row.identity});assert.deepEqual(after.row.identity,before.row.identity);assert.equal(await readlink(processProbe.path+'/ns/time'),namespace);assert.equal(await readlink('/proc/self/ns/time'),controllerNamespace);assert.ok(performance.now()-started<=5000);
   const domainId=createHash('sha256').update(bootId+'\0'+namespace).digest('hex');
   return {reply,pageEpoch:epoch,viewportVersion:version,provenance:{kind:'actual-current-Source-private-scheduler',bindingId:binding,documentToken:document,producer:source.producer,linuxMonotonic:{schema:'linux-native-monotonic-probe-v1',domainId,timeNamespace:namespace,rendererIdentity:before.row.identity,interval,scope:'Actual current native scheduler stamp lies inside Linux controller hrtime request/response interval;renderer proc FD identity and same time namespace verified before/after. Shared-domain interpretation additionally depends on the pinned Chromium Linux TimeTicks implementation;not an assertion about other platforms or arbitrary clock overrides.'}}};
  }finally{try{await processProbe?.close();}finally{pending=false;}}
 };
}
