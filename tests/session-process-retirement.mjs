// A lifecycle fence for the known previous crosssite producer. A zombie is
// still present: only disappearance of its pinned stat record proves reaping.
// This module never reads PSS, selects a memory cohort or changes its gates.
import {setTimeout as delay} from 'node:timers/promises';
import {LinuxProcessProbe,readLinuxMemoryText,parseLinuxStat} from '../native/process-memory-linux.mjs';

export const SESSION_PROCESS_RETIREMENT_LIMITS=Object.freeze({phaseMs:5000,pollMs:10,observations:512});
const failure=(code,message,receipt)=>Object.assign(new Error(message),{code,retirementEvidence:receipt});
function ownedIdentity(value){
 const keys=['pid','ppid','provider','startTicks','uids'];
 if(!value||Object.keys(value).sort().join()!==keys.join()||value.provider!=='linux-proc-start-v1'||!Number.isInteger(value.pid)||value.pid<1||value.pid>2147483647||!Number.isInteger(value.ppid)||value.ppid<0||value.ppid>2147483647||!Number.isSafeInteger(value.startTicks)||value.startTicks<1||!Array.isArray(value.uids)||value.uids.length!==4||!value.uids.every(n=>Number.isInteger(n)&&n>=0&&n<=4294967295))throw new TypeError('A complete pinned Linux birth identity is required');
 return Object.freeze({...value,uids:Object.freeze([...value.uids])});
}
class ProcessRetirementFence{
 #probe;#identity;#controller;#waiting;#closePromise;#used=false;#closed=false;
 constructor(probe,identity,controller){this.#probe=probe;this.#identity=identity;this.#controller=controller;}
 wait(){
  if(this.#closed)return Promise.reject(failure('SESSION_RETIREMENT_CLOSED','Retirement fence is closed'));
  if(this.#used)return Promise.reject(failure('SESSION_RETIREMENT_USED','Retirement fence is one use'));
  this.#used=true;return this.#waiting=this.#observe();
 }
 async #observe(){
  const start=performance.now(),signal=this.#controller.signal,limits=SESSION_PROCESS_RETIREMENT_LIMITS;let observations=0,zombieObservations=0,lastState=null;
  const evidence=()=>Object.freeze({identity:this.#identity,observations,zombieObservations,lastState,elapsedMs:performance.now()-start,deadlineMs:limits.phaseMs});
  const timeout=()=>failure('SESSION_RETIREMENT_TIMEOUT','Pinned previous producer did not retire within5000ms',evidence());
  const timer=setTimeout(()=>this.#controller.abort(timeout()),limits.phaseMs);
  const check=()=>{if(signal.aborted)throw signal.reason;if(performance.now()-start>=limits.phaseMs)throw timeout();};
  try{
   for(;;){
    check();if(observations>=limits.observations)throw failure('SESSION_RETIREMENT_LIMIT','Retirement observations exceeded512',evidence());observations++;
    let text;try{text=await readLinuxMemoryText(this.#probe.path+'/stat',signal);}
    catch(error){check();if(!['ESRCH','ENOENT'].includes(error.code))throw error;return Object.freeze({...evidence(),status:'retired',retirement:error.code,scope:'Validated old producer birth held by a proc-directory FD before navigation;its stat record is now absent. No PSS read or zero inference.'});}
    check();const row=parseLinuxStat(text,this.#identity.pid);if(row.startTicks!==this.#identity.startTicks||row.ppid!==this.#identity.ppid)throw failure('SESSION_RETIREMENT_IDENTITY','Pinned previous producer birth/parent changed',evidence());lastState=row.state;if(row.state==='Z')zombieObservations++;
    await delay(limits.pollMs,undefined,{signal});
   }
  }catch(error){if(signal.aborted)throw signal.reason;throw error;}
  finally{clearTimeout(timer);}
 }
 close(){
  if(this.#closePromise)return this.#closePromise;this.#closed=true;
  this.#closePromise=(async()=>{await this.#waiting?.catch(()=>{});await this.#probe.close();})();
  this.#controller.abort(failure('SESSION_RETIREMENT_CLOSED','Retirement fence was closed'));return this.#closePromise;
 }
}
export async function pinSessionProcessRetirement(value){
 const identity=ownedIdentity(value);if(process.platform!=='linux')throw failure('SESSION_RETIREMENT_PLATFORM','Retirement fence requires Linux');
 const controller=new AbortController(),start=performance.now();let probe;
 const timer=setTimeout(()=>controller.abort(failure('SESSION_RETIREMENT_TIMEOUT','Producer identity pin exceeded5000ms')),SESSION_PROCESS_RETIREMENT_LIMITS.phaseMs);
 try{probe=await LinuxProcessProbe.open(identity.pid,{signal:controller.signal});await probe.sample({details:false,children:false,expectedIdentity:identity});if(controller.signal.aborted)throw controller.signal.reason;if(performance.now()-start>=SESSION_PROCESS_RETIREMENT_LIMITS.phaseMs)throw failure('SESSION_RETIREMENT_TIMEOUT','Producer identity pin exceeded5000ms');return new ProcessRetirementFence(probe,identity,controller);}
 catch(error){controller.abort(error);await probe?.close();throw error;}
 finally{clearTimeout(timer);}
}
