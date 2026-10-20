// Bounded observer telemetry. This class never starts, retries, times out or
// accepts a helper; the existing sampler alone makes those decisions.
import {performance} from 'node:perf_hooks';
import {isAbsolute} from 'node:path';
export const NATIVE_STARTUP_LIMITS=Object.freeze({events:16,prefixBytes:32,encodedBytes:8192});
const finite=n=>Number.isFinite(n)&&n>=0?n:null;
const pid=n=>Number.isInteger(n)&&n>0&&n<=2147483647?n:null;
const code=s=>typeof s==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(s)?s:null;
const digest=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)?s:null;
const executable=s=>typeof s==='string'&&s.length<=1024&&isAbsolute(s)&&!/[\0\r\n?#]|:\/\//.test(s)?s:null;
const owner=v=>v?{pid:pid(v.pid),exited:v.exited===true,exitCode:Number.isInteger(v.exitCode)?v.exitCode:null,signal:typeof v.signal==='string'&&/^SIG[A-Z0-9]{1,16}$/.test(v.signal)?v.signal:null}:null;
const freeze=value=>{if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
const eventNames=new Set(['spawn-call','spawn-return','spawn-event','spawn-error','first-stdout','handshake','ready-timeout','pipe-error','helper-exit','helper-close','stop','sigkill']);
export class NativeMemoryStartupTrace{
 #started=performance.now();#wall=new Date().toISOString();#elu=performance.eventLoopUtilization();#events=[];#prefix=Buffer.alloc(NATIVE_STARTUP_LIMITS.prefixBytes);#prefixBytes=0;#stdoutBytes=0;#truncated=false;#settled=null;
 event(name,fields={}){
  if(!eventNames.has(name))return;if(this.#events.length>=NATIVE_STARTUP_LIMITS.events){this.#truncated=true;return;}
  const value={event:name,elapsedMs:performance.now()-this.#started};
  if(fields.pid!==undefined)value.pid=pid(fields.pid);if(fields.code!==undefined)value.code=Number.isInteger(fields.code)?fields.code:code(fields.code);if(fields.signal!==undefined)value.signal=owner({signal:fields.signal}).signal;if(typeof fields.force==='boolean')value.force=fields.force;
  this.#events.push(value);
 }
 output(bytes){
  if(!Buffer.isBuffer(bytes)||!bytes.length)return;if(this.#stdoutBytes===0)this.event('first-stdout');this.#stdoutBytes+=bytes.length;
  const take=Math.min(bytes.length,this.#prefix.length-this.#prefixBytes);if(take){bytes.copy(this.#prefix,this.#prefixBytes,0,take);this.#prefixBytes+=take;}
 }
 settle(){if(!this.#settled)this.#settled={elapsedMs:performance.now()-this.#started,elu:performance.eventLoopUtilization(this.#elu)};}
 elapsedMs(){return performance.now()-this.#started;}
 snapshot({helperPid,readyDone=false,childCreated=false,timerScheduledMs=null,exit=null,error=null,provenance=null,binaryFile=null,factoryElapsedMs=null,stderrBytes=0,cleanupFailureCode=null}={}){
  const elu=this.#settled?.elu??performance.eventLoopUtilization(this.#elu),events=this.#events.map(e=>({...e})),eventTime=name=>events.find(e=>e.event===name)?.elapsedMs??null,closeObserved=events.some(e=>e.event==='helper-close');
  const value={schema:'native-memory-startup-v1',at:this.#wall,scope:'Observed JS spawn/stdout/handshake and actual ChildProcess exit/close events;does not observe pre-main OS admission or prove startup cause',captureStatus:this.#truncated?'event-limit':'complete',elapsedMs:this.#settled?.elapsedMs??this.elapsedMs(),factoryElapsedMs:finite(factoryElapsedMs),helperPid:pid(helperPid),childCreated:childCreated===true,ready:readyDone===true,closeObserved,timerScheduledMs:finite(timerScheduledMs),startupDeadlineMs:2000,timerOrigin:'after spawn returned;original sampler timer unchanged',spawnReturnMs:eventTime('spawn-return'),spawnEventMs:eventTime('spawn-event'),firstStdoutMs:eventTime('first-stdout'),handshakeMs:eventTime('handshake'),stdoutBytes:this.#stdoutBytes,stdoutPrefixHex:this.#prefix.subarray(0,this.#prefixBytes).toString('hex'),stderrBytes:finite(stderrBytes),events,eventLoop:{idleMs:finite(elu.idle),activeMs:finite(elu.active),utilization:finite(elu.utilization),scope:'constructor to first handshake/failure/close;frozen after startup'},observedExit:closeObserved&&exit?owner({pid:helperPid,exited:true,exitCode:exit.code,signal:exit.signal}):null,failure:error?{code:code(error.code),causeCode:code(error.cause?.code),owner:owner(error.owner),cleanupFailureCode:code(cleanupFailureCode)}:null,provenance:provenance?{executable:executable(provenance.executable),binarySha256:digest(provenance.binarySha256),sourceSha256:digest(provenance.sourceSha256)}:null,binaryFile:binaryFile?{dev:finite(binaryFile.dev),ino:finite(binaryFile.ino),size:finite(binaryFile.size),mode:finite(binaryFile.mode),mtimeMs:finite(binaryFile.mtimeMs),birthtimeMs:finite(binaryFile.birthtimeMs)}:null};
  if(Buffer.byteLength(JSON.stringify(value))>NATIVE_STARTUP_LIMITS.encodedBytes)return freeze({schema:value.schema,at:value.at,captureStatus:'oversized',helperPid:value.helperPid,failure:value.failure,ready:value.ready,closeObserved:value.closeObserved});return freeze(value);
 }
}
