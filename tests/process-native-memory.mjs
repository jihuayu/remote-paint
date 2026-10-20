// Test-only Darwin observer. RSS, virtual address space and OS physical
// footprint remain distinct; physical footprint is not Linux PSS.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeMemoryStartupTrace} from './native-memory-startup.mjs';
export const NATIVE_MEMORY_LIMITS=Object.freeze({requestMs:2000,reapMs:250,phaseMs:5000,stdoutBytes:65536,stderrBytes:8192,processes:1024,headerBytes:32,rowBytes:56});
const fail=(code,message,fields={})=>Object.assign(new Error(message),{code,...fields});
const safe64=(bytes,offset)=>{const n=bytes.readBigUInt64BE(offset);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw fail('NATIVE_MEMORY_PRECISION','Unsafe native memory integer');return Number(n);};
function inventory(rows){
 if(!Array.isArray(rows)||!rows.length||rows.length>NATIVE_MEMORY_LIMITS.processes)throw fail('NATIVE_MEMORY_INVENTORY','Invalid native memory inventory');
 const map=new Map();for(const row of rows){const pid=Number(row.id);if(!Number.isInteger(pid)||pid<=0||pid>2147483647||map.has(pid)||typeof row.type!=='string'||row.type.length>64)throw fail('NATIVE_MEMORY_INVENTORY','Invalid native memory process identity');
  if(row.identity&&(!Number.isSafeInteger(row.identity.startSeconds)||row.identity.startSeconds<=0||!Number.isInteger(row.identity.startMicroseconds)||row.identity.startMicroseconds<0||row.identity.startMicroseconds>=1000000))throw fail('NATIVE_MEMORY_INVENTORY','Invalid expected process start identity');map.set(pid,{id:pid,type:row.type,...(row.identity?{identity:{...row.identity}}:{})});
 }return map;
}
export function decodeNativeMemoryReply(bytes,rows,requestId){
 const requested=inventory(rows);if(!Buffer.isBuffer(bytes)||bytes.length<32||bytes.toString('ascii',0,4)!=='RPM1'||bytes.readUInt32BE(4)!==1||safe64(bytes,8)!==requestId)throw fail('NATIVE_MEMORY_PROTOCOL','Invalid native memory response header');
 const count=bytes.readUInt32BE(16),status=bytes.readUInt32BE(20),detail=bytes.readUInt32BE(24),pid=bytes.readUInt32BE(28);
 if(status){if(count!==0||bytes.length!==32||status>6||!requested.has(pid))throw fail('NATIVE_MEMORY_PROTOCOL','Invalid native memory failure response');throw fail('NATIVE_MEMORY_OS_READ','Native process memory batch could not be sampled',{nativeBatch:true,nativeStatus:status,errno:detail,failedPid:pid});}
 if(count!==requested.size||bytes.length!==32+count*56||detail!==0||pid!==0)throw fail('NATIVE_MEMORY_PROTOCOL','Incomplete native memory response');
 const seen=new Set(),processes=[];
 for(let n=0;n<count;n++){
  const p=32+n*56,id=bytes.readUInt32BE(p),row=requested.get(id),flags=bytes.readUInt32BE(p+12),startSeconds=safe64(bytes,p+16),startMicroseconds=bytes.readUInt32BE(p+24);
  if(!row||seen.has(id)||flags!==7||bytes.readUInt32BE(p+28)!==0||startSeconds<=0||startMicroseconds>=1000000)throw fail('NATIVE_MEMORY_PROTOCOL','Unexpected native process row');seen.add(id);
  const identity={provider:'darwin-bsd-start-v1',startSeconds,startMicroseconds,ppid:bytes.readUInt32BE(p+4),uid:bytes.readUInt32BE(p+8)};
  if(row.identity&&(row.identity.startSeconds!==startSeconds||row.identity.startMicroseconds!==startMicroseconds||row.identity.ppid!==undefined&&row.identity.ppid!==identity.ppid||row.identity.uid!==undefined&&row.identity.uid!==identity.uid))throw fail('NATIVE_MEMORY_IDENTITY_CHANGED','Process start identity changed',{failedPid:id});
  processes.push({pid:id,kind:row.type,identity,bytes:safe64(bytes,p+32),rssBytes:safe64(bytes,p+32),virtualBytes:safe64(bytes,p+40),physicalFootprintBytes:safe64(bytes,p+48)});
 }return processes;
}
export class NativeProcessMemorySampler{
 constructor({executable=fileURLToPath(new URL(`../native/bin/process-memory-sampler-${process.arch}-darwin`,import.meta.url)),spawnProcess=spawn}={}){
  if(process.platform!=='darwin'&&spawnProcess===spawn)throw fail('NATIVE_MEMORY_PLATFORM','Darwin libproc sampler requires macOS');
  this.executable=executable;this.buffer=Buffer.allocUnsafeSlow(NATIVE_MEMORY_LIMITS.stdoutBytes);this.buffered=0;this.stderrBytes=0;this.sequence=0;this.pending=null;this.stopped=false;this.readyDone=false;this.exit=null;
  this.startupTrace=new NativeMemoryStartupTrace();
  this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});this.ready.catch(()=>{});
  this.exited=new Promise(resolve=>{this.exitedResolve=resolve;});
  this.startupTrace.event('spawn-call');
  try{this.child=spawnProcess(executable,[],{stdio:['pipe','pipe','pipe']});this.startupTrace.event('spawn-return',{pid:this.child.pid});}
  catch(error){this.startupTrace.event('spawn-error');this.startupTrace.settle();this.readyReject(fail('NATIVE_MEMORY_SPAWN','Native memory helper did not start'));this.stopped=true;this.exit={code:null,signal:null};this.exitedResolve(this.exit);return;}
  this.child.once('spawn',()=>this.startupTrace.event('spawn-event',{pid:this.child.pid}));
  this.child.once('exit',(code,signal)=>this.startupTrace.event('helper-exit',{code,signal}));
  this.child.once('close',(code,signal)=>{this.startupTrace.event('helper-close',{code,signal});this.exit={code,signal};this.exitedResolve(this.exit);if(!this.stopped)this._fail(fail('NATIVE_MEMORY_EXIT','Native memory helper exited unexpectedly'));});
  this.child.once('error',()=>{this.startupTrace.event('spawn-error');void this._fail(fail('NATIVE_MEMORY_SPAWN','Native memory helper did not start'));});this.child.stdin.on('error',()=>{this.startupTrace.event('pipe-error');void this._fail(fail('NATIVE_MEMORY_PIPE','Native memory helper input failed'));});
  this.child.stderr.on('data',bytes=>{this.stderrBytes+=bytes.length;if(this.stderrBytes>NATIVE_MEMORY_LIMITS.stderrBytes)void this._fail(fail('NATIVE_MEMORY_OUTPUT_LIMIT','Native memory helper stderr budget exceeded'));});
  this.child.stdout.on('data',bytes=>this._data(bytes));
  this.startupTimerScheduledMs=this.startupTrace.elapsedMs();this.readyTimer=setTimeout(()=>{this.startupTrace.event('ready-timeout');void this._fail(fail('NATIVE_MEMORY_READY_TIMEOUT','Native memory helper startup exceeded2s'));},NATIVE_MEMORY_LIMITS.requestMs);
 }
 startupSnapshot(error=this.failure??null,cleanupFailureCode=null){return this.startupTrace.snapshot({helperPid:this.child?.pid,childCreated:!!this.child,readyDone:this.readyDone,timerScheduledMs:this.startupTimerScheduledMs,exit:this.exit,error,provenance:this.provenance,binaryFile:this.startupBinaryFile,factoryElapsedMs:this.factoryElapsedMs,stderrBytes:this.stderrBytes,cleanupFailureCode});}
 async _waitExit(ms){if(this.exit)return true;let timer;try{return await Promise.race([this.exited.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}finally{clearTimeout(timer);}}
 _stop(force=false){
  if(this.stopPromise)return this.stopPromise;this.startupTrace.event('stop',{force});this.startupTrace.settle();this.stopped=true;clearTimeout(this.readyTimer);if(this.pending)clearTimeout(this.pending.timer);
  this.stopPromise=(async()=>{
   if(this.child&&!this.exit){if(force){try{this.startupTrace.event('sigkill');this.child.kill('SIGKILL');}catch{}}else this.child.stdin.end();
    if(!await this._waitExit(NATIVE_MEMORY_LIMITS.reapMs)){if(!force){try{this.startupTrace.event('sigkill');this.child.kill('SIGKILL');}catch{}await this._waitExit(NATIVE_MEMORY_LIMITS.reapMs);}}
   }
   this.child?.stdin?.destroy();this.child?.stdout?.destroy();this.child?.stderr?.destroy();if(!this.exit)this.child?.unref();this.buffer=null;this.buffered=0;
   return {pid:this.child?.pid??null,exited:!!this.exit,exitCode:this.exit?.code??null,signal:this.exit?.signal??null};
  })();return this.stopPromise;
 }
 async _fail(error){
  if(this.failure)return;this.failure=error;this.startupTrace.settle();const pending=this.pending;this.pending=null;clearTimeout(pending?.timer);const owner=await this._stop(true);
  if(!owner.exited)error=fail('NATIVE_MEMORY_NOT_REAPED','Native memory helper did not close after SIGKILL',{cause:error});error.owner=owner;
  Object.defineProperty(error,'nativeStartup',{value:this.startupSnapshot(error),configurable:true});
  this.readyReject(error);pending?.reject(error);
 }
 _data(bytes){
  if(!this.readyDone)this.startupTrace.output(bytes);if(this.stopped)return;
  if(this.buffered+bytes.length>NATIVE_MEMORY_LIMITS.stdoutBytes){void this._fail(fail('NATIVE_MEMORY_OUTPUT_LIMIT','Native memory response budget exceeded'));return;}
  bytes.copy(this.buffer,this.buffered);this.buffered+=bytes.length;
  try{
   while(this.buffered>=32){
    if(this.buffer.toString('ascii',0,4)!=='RPM1'||this.buffer.readUInt32BE(4)!==1)throw fail('NATIVE_MEMORY_PROTOCOL','Native memory response framing changed');
    const id=safe64(this.buffer,8),count=this.buffer.readUInt32BE(16);if(count>NATIVE_MEMORY_LIMITS.processes)throw fail('NATIVE_MEMORY_OUTPUT_LIMIT','Native memory response process limit');const size=32+56*count;if(this.buffered<size)return;
    if(!this.readyDone){
     if(id!==0||count!==0||this.buffer.readUInt32BE(20)!==0||this.buffer.readUInt32BE(24)!==this.child.pid||this.buffer.readUInt32BE(28)!==NATIVE_MEMORY_LIMITS.processes)throw fail('NATIVE_MEMORY_PROTOCOL','Native memory helper handshake identity mismatch');
     this.startupTrace.event('handshake',{pid:this.child.pid});this.startupTrace.settle();this.readyDone=true;clearTimeout(this.readyTimer);this.readyResolve({provider:'darwin-libproc-v1',pid:this.child.pid,maxProcesses:NATIVE_MEMORY_LIMITS.processes});
    }else{
     const pending=this.pending;if(!pending||pending.id!==id)throw fail('NATIVE_MEMORY_PROTOCOL','Unsolicited native memory response');let value,error;
     try{value=decodeNativeMemoryReply(this.buffer.subarray(0,size),pending.rows,id);}catch(e){if(!e.nativeBatch&&e.code!=='NATIVE_MEMORY_IDENTITY_CHANGED')throw e;error=e;}
     clearTimeout(pending.timer);this.pending=null;error?pending.reject(error):pending.resolve(value);
    }
    this.buffer.copy(this.buffer,0,size,this.buffered);this.buffered-=size;
    if(this.readyDone&&!this.pending&&this.buffered)throw fail('NATIVE_MEMORY_PROTOCOL','Trailing unsolicited native memory bytes');
   }
  }catch(error){void this._fail(error);}
 }
 async sample(rows,{onAttempt=async()=>{}}={}){
  const requested=inventory(rows),started=performance.now();await this.ready;
  if(this.stopped||this.failure)throw this.failure??fail('NATIVE_MEMORY_CLOSED','Native memory sampler is closed');if(this.pending)throw fail('NATIVE_MEMORY_BUSY','Native memory sampler already has a request');
  const id=++this.sequence;if(!Number.isSafeInteger(id))throw fail('NATIVE_MEMORY_SEQUENCE','Native memory request ID exhausted');const packet=Buffer.alloc(16+requested.size*4);packet.write('RPQ1');packet.writeBigUInt64BE(BigInt(id),4);packet.writeUInt32BE(requested.size,12);let offset=16;for(const pid of requested.keys()){packet.writeUInt32BE(pid,offset);offset+=4;}
  let processes,error;
  try{processes=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>void this._fail(fail('NATIVE_MEMORY_REQUEST_TIMEOUT','Native process memory request exceeded2s')),NATIVE_MEMORY_LIMITS.requestMs);this.pending={id,rows:[...requested].map(([pid,row])=>({id:pid,type:row.type,...(row.identity?{identity:{...row.identity}}:{})})),resolve,reject,timer};try{this.child.stdin.write(packet);}catch{void this._fail(fail('NATIVE_MEMORY_PIPE','Native memory helper input failed'));}});}catch(e){error=e;}
  const receipt={provider:'darwin-libproc-v1',requestId:id,helperPid:this.child.pid,status:error?.code??'passed',elapsedMs:performance.now()-started,requestedPids:[...requested.keys()],requestDeadlineMs:NATIVE_MEMORY_LIMITS.requestMs,phaseDeadlineMs:NATIVE_MEMORY_LIMITS.phaseMs,...(error?{nativeStatus:error.nativeStatus,errno:error.errno,failedPid:error.failedPid,owner:error.owner}:{})};await onAttempt(receipt);
  if(performance.now()-started>NATIVE_MEMORY_LIMITS.phaseMs)throw fail('NATIVE_MEMORY_PHASE_TIMEOUT','Native process memory sample exceeded5s',{receipt});if(error){error.receipt=receipt;throw error;}
  return {processes,sampling:{...receipt,elapsedMs:performance.now()-started},scope:'Darwinlibprocbytes/RSS/virtual/physicalfootprintwithbefore-afterPIDstart/UID/parentidentity. PhysicalfootprintisnotLinuxPSSandRSSsumsincludesharedpages;notanatomiccohort snapshot.'};
 }
 async close(){const pending=this.pending;this.pending=null;clearTimeout(pending?.timer);pending?.reject(fail('NATIVE_MEMORY_CLOSED','Native memory sampler closed'));const owner=await this._stop();this.readyReject(fail('NATIVE_MEMORY_CLOSED','Native memory sampler closed'));if(!owner.exited)throw fail('NATIVE_MEMORY_NOT_REAPED','Native memory helper cleanup did not reap',{owner});return owner;}
}
export async function createNativeProcessMemorySampler(options){
 const factoryStarted=performance.now(),beforeSpawn=new NativeMemoryStartupTrace(),native=!options?.spawnProcess||options.spawnProcess===spawn;let provenance,sampler,binaryFile;
 try{
 if(native){
  if(process.platform!=='darwin')throw fail('NATIVE_MEMORY_PLATFORM','Darwin libproc sampler requires macOS');
  const executable=options?.executable??fileURLToPath(new URL(`../native/bin/process-memory-sampler-${process.arch}-darwin`,import.meta.url)),receipt=JSON.parse(await readFile(executable+'.json','utf8')),hash=b=>createHash('sha256').update(b).digest('hex');
  const binarySha256=hash(await readFile(executable)),sourceSha256=hash(await readFile(new URL('../native/process-memory-darwin.c',import.meta.url)));
  if(receipt.binarySha256!==binarySha256||receipt.sourceSha256!==sourceSha256||receipt.platform!=='darwin'||receipt.arch!==process.arch)throw fail('NATIVE_MEMORY_PROVENANCE','Native memory helper source/build receipt mismatch');
  provenance={executable,binarySha256,sourceSha256,buildReceipt:receipt};
  binaryFile=await stat(executable).catch(()=>null);
 }
 sampler=new NativeProcessMemorySampler(options);sampler.provenance=provenance;sampler.startupBinaryFile=binaryFile;await sampler.ready;sampler.factoryElapsedMs=performance.now()-factoryStarted;return sampler;
 }catch(error){let cleanup,cleanupError;try{cleanup=await sampler?.close();}catch(e){cleanupError=e;cleanup=e.owner;}if(!error.owner&&cleanup)error.owner=cleanup;
  if(sampler)sampler.factoryElapsedMs=performance.now()-factoryStarted;else beforeSpawn.settle();
  const snapshot=sampler?sampler.startupSnapshot(error,cleanupError?.code):beforeSpawn.snapshot({error,provenance,binaryFile,factoryElapsedMs:performance.now()-factoryStarted,cleanupFailureCode:cleanupError?.code});Object.defineProperty(error,'nativeStartup',{value:snapshot,configurable:true});throw error;
 }
}
