import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureDockerAttachSettings,captureDockerAttachConfig,DockerAttachError} from './docker-attach-config.mjs';
export {DockerAttachError} from './docker-attach-config.mjs';
const sink=()=>{},fail=code=>new DockerAttachError(code);
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});void promise.catch(sink);return {promise,resolve,reject};}
const waitClose=(done,ms)=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);void done.then(()=>{clearTimeout(timer);resolve();});});
class OwnedAttachProxy {
 constructor(config,signal,onClose){
  const bytes=Buffer.from(JSON.stringify(config)),control=Buffer.alloc(2048),ready=deferred(),done=deferred();
  let used=0,accepted=false,closed=false,exit=null,failure=null,timer,stopPromise,abort,diagnosticBytes=0;
  const deadline=performance.now()+config.connectTimeoutMs;
  const child=spawn(process.execPath,[fileURLToPath(new URL('./docker-attach-proxy.mjs',import.meta.url))],{env:{PATH:process.env.PATH??'/usr/bin:/bin',...(process.platform==='win32'?{SystemRoot:process.env.SystemRoot}:{})},stdio:['pipe','pipe','pipe','pipe','pipe']});
  const stop=()=>{
   if(stopPromise)return stopPromise;let resolve;stopPromise=new Promise(r=>resolve=r);
   void(async()=>{
    if(!closed){for(const stream of child.stdio)stream?.destroy();try{child.kill('SIGTERM');}catch{}await waitClose(done.promise,250);}
    if(!closed){try{child.kill('SIGKILL');}catch{}await waitClose(done.promise,250);}
    resolve(Object.freeze({status:closed?'closed':'unconfirmed',transportExit:exit,scope:'Owned host proxy transport only;not worker or runtime retirement.'}));
   })();return stopPromise;
  };
  const fault=code=>{failure??=code;ready.reject(fail(code));void stop();};
  const onDeadline=()=>{if(accepted||closed)return;if(performance.now()<deadline)timer=setTimeout(onDeadline,Math.max(1,Math.ceil(deadline-performance.now())));else fault('ATTACH_DEADLINE');};
  timer=setTimeout(onDeadline,Math.max(1,Math.ceil(deadline-performance.now())));
  child.on('error',()=>fault('ATTACH_PROXY_SPAWN'));
  child.once('close',(code,signal)=>{closed=true;exit=Object.freeze({code,signal});clearTimeout(timer);if(abort)signalOwner?.removeEventListener('abort',abort);bytes.fill(0);control.fill(0);if(!accepted)ready.reject(fail(failure??'ATTACH_PROXY_EXITED'));done.resolve(exit);onClose(this);});
  const signalOwner=signal;
  for(const stream of [child.stdin,child.stdout,child.stdio[3],child.stdio[4]])stream?.on('error',sink);
  child.stderr.on('data',b=>{diagnosticBytes+=b.length;if(diagnosticBytes>4096)fault('ATTACH_PROXY_DIAGNOSTIC_LIMIT');});child.stderr.on('error',sink);
  child.stdio[4].on('data',chunk=>{
   if(accepted||used+chunk.length>control.length){fault('ATTACH_CONTROL_INVALID');return;}chunk.copy(control,used);used+=chunk.length;const newline=control.indexOf(10,0);
   if(newline<0||newline>=used)return;if(newline!==used-1){fault('ATTACH_CONTROL_INVALID');return;}
   try{const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(control.subarray(0,newline)));control.fill(0);used=0;
    if(v.type==='Failed'&&v.protocol==='docker-attach-v1'&&Object.keys(v).sort().join(',')==='code,protocol,type'&&/^ATTACH_[A-Z_]{1,64}$/.test(v.code)){fault(v.code);return;}
    if(Object.keys(v).sort().join(',')!=='connectionId,containerId,daemonId,protocol,type'||v.type!=='Attached'||v.protocol!=='docker-attach-v1'||v.containerId!==config.containerId||v.daemonId!==config.daemonId||typeof v.connectionId!=='string'||!/^[a-f0-9-]{36}$/.test(v.connectionId))throw fail('ATTACH_CONTROL_INVALID');
    if(performance.now()>=deadline)throw fail('ATTACH_DEADLINE');accepted=true;clearTimeout(timer);ready.resolve(Object.freeze({containerId:v.containerId,daemonId:v.daemonId,connectionId:v.connectionId}));
   }catch(error){fault(error instanceof DockerAttachError&&error.code==='ATTACH_DEADLINE'?'ATTACH_DEADLINE':'ATTACH_CONTROL_INVALID');}
  });
  child.stdio[4].on('end',()=>{if(!accepted&&!closed)fault('ATTACH_CONTROL_INCOMPLETE');});
  if(signal){abort=()=>fault('ATTACH_ABORTED');signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}
  try{child.stdio[3].end(bytes,()=>bytes.fill(0));}catch{bytes.fill(0);fault('ATTACH_CONFIGURATION');}
  this.facade=Object.freeze({input:child.stdin,output:child.stdout,attached:ready.promise,clientDone:done.promise,stop,status:()=>Object.freeze({pid:child.pid??null,attached:accepted,transportExited:closed,transportExit:exit,failure,diagnosticBytes})});
 }
}
export class DockerAttachClient {
 #settings;#limit;#active=new Set();#closed=false;#closePromise;
 constructor({maxConcurrent=4,...settings}={}){if(!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>16)throw new TypeError('Invalid attach capacity');this.#settings=captureDockerAttachSettings(settings);this.#limit=maxConcurrent;Object.freeze(this);}
 status(){return Object.freeze({closed:this.#closed,activeProxies:this.#active.size,maxConcurrent:this.#limit});}
 open({plan,containerId,signal}={}){
  if(this.#closed)throw fail('ATTACH_CLIENT_CLOSED');if(signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Invalid attach signal');if(signal?.aborted)throw fail('ATTACH_ABORTED');const config=captureDockerAttachConfig({schema:'docker-attach-v1',...this.#settings,plan,containerId});if(this.#active.size>=this.#limit)throw fail('ATTACH_BUSY');const proxy=new OwnedAttachProxy(config,signal,closed=>this.#active.delete(closed));this.#active.add(proxy);return proxy.facade;
 }
 close(){if(this.#closePromise)return this.#closePromise;this.#closed=true;return this.#closePromise=Promise.all([...this.#active].map(p=>p.facade.stop())).then(rows=>Object.freeze({status:rows.every(x=>x.status==='closed')?'closed':'unconfirmed',activeProxies:this.#active.size,scope:'Owned host proxy transports only;not runtime retirement.'}));}
}
