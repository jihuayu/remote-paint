// Trusted automatic endpoint owner. The dispatcher remains the authority for
// original DNS/I/O, consumed attempts and uncertain persistence reservations.
import {types} from 'node:util';
import {createAgentWebhookDispatcher,AgentWebhookDispatchError} from './agent-webhook-dispatcher.mjs';
export class AgentWebhookDriverError extends Error {
 constructor(code){super('Agent Webhook automatic delivery is unavailable');this.name='AgentWebhookDriverError';this.code='AGENT_WEBHOOK_DRIVER_'+code;}
}
const fail=code=>{throw new AgentWebhookDriverError(code);};
function record(v,required,optional=[]){
 if(!v||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('INVALID');const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(ds);
 if(required.some(k=>!Object.hasOwn(ds,k))||ks.some(k=>typeof k!=='string'||![...required,...optional].includes(k)||!Object.hasOwn(ds[k],'value')))fail('INVALID');return Object.fromEntries(ks.map(k=>[k,ds[k].value]));
}
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get,add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
function signalOption(input){const v=record(input,[],['signal']);if(!Object.hasOwn(v,'signal'))return null;try{if(types.isProxy(v.signal))throw Error();aborted.call(v.signal);return v.signal;}catch{fail('INVALID');}}
function observe(promise,signal){if(!signal)return promise;return new Promise((resolve,reject)=>{let done=false;const finish=(fn,v)=>{if(done)return;done=true;remove.call(signal,'abort',cancel);fn(v);},cancel=()=>finish(reject,new AgentWebhookDriverError('ABORTED'));add.call(signal,'abort',cancel,{once:true});promise.then(v=>finish(resolve,v),e=>finish(reject,e));if(aborted.call(signal))cancel();});}

export function createAgentWebhookDriver(config){
 let v=record(config,['store','owner','tenantId','endpointId','url','keys','activeKeyId'],['ca','maxConcurrent','timeoutMs','retryBaseMs','lookup','dnsServers','pollIntervalMs']);
 const pollIntervalMs=Object.hasOwn(v,'pollIntervalMs')?v.pollIntervalMs:250;if(!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<10||pollIntervalMs>1000)fail('INVALID');
 let worker;
 try{const {pollIntervalMs:ignored,...fields}=v;try{worker=createAgentWebhookDispatcher(fields);worker.revision();}finally{fields.keys=null;fields.owner=null;}}catch{worker?.close().catch(()=>{});fail('INVALID');}v=null;config=null;
 const jobs=new Map();let stopping=false,closed=false,scanFault=false,lastError=null,cursor='',lastRevision=-1,sweepRevision=-1,needsScan=true,wake=null,closeDone;
 const notify=()=>wake?.();
 function pause(){return new Promise(resolve=>{const finish=()=>{clearTimeout(timer);if(wake===finish)wake=null;resolve();},timer=setTimeout(finish,pollIntervalMs);timer.unref();wake=finish;if(stopping)finish();});}
 function start(sub){
  const result=worker.deliver(sub);
  const done=result.then(()=>{needsScan=true;lastError=worker.status().faulted?'AGENT_WEBHOOK_STATE_UNCONFIRMED':scanFault?'AGENT_WEBHOOK_STATE_UNAVAILABLE':null;},error=>{needsScan=true;lastError=error instanceof AgentWebhookDispatchError?error.code:'AGENT_WEBHOOK_STATE_UNAVAILABLE';}).finally(()=>{jobs.delete(sub);notify();});jobs.set(sub,done);done.catch(()=>{});
 }
 function scan(){
  let status=worker.status();if(status.faulted||status.inFlight>=status.capacity)return;
  const revision=worker.revision();if(!needsScan&&cursor===''&&revision===lastRevision)return;if(cursor==='')sweepRevision=revision;
  let budget=64;
  while(!stopping&&budget>0){
   const page=worker.list({after:cursor,limit:4});
   if(page.subscriptions.length===0){cursor='';lastRevision=sweepRevision;needsScan=false;return;}
   for(const sub of page.subscriptions){
    cursor=sub.subscriptionId;budget--;
    const head=sub.head;
    if(head&&head.attempts<8&&head.lastOutcome!=='requested'&&!jobs.has(sub.subscriptionId))start(sub.subscriptionId);
    status=worker.status();if(status.faulted||status.inFlight>=status.capacity){needsScan=true;return;}
   }
   if(!page.hasMore){cursor='';lastRevision=sweepRevision;needsScan=false;return;}
  }
  needsScan=true;
 }
 const loop=Promise.resolve().then(async()=>{while(!stopping){if(!scanFault)try{scan();}catch{scanFault=true;lastError='AGENT_WEBHOOK_STATE_UNAVAILABLE';}if(!stopping)await pause();}}).catch(()=>{scanFault=true;lastError='AGENT_WEBHOOK_STATE_UNAVAILABLE';});
 return Object.freeze({
  subscribe(input){if(stopping)fail('CLOSED');if(scanFault||worker.status().faulted)fail('STATE_UNCONFIRMED');const result=worker.subscribe(input);needsScan=true;notify();return result;},
  list(options={}){return worker.list(options);},
  read(subscriptionId,options={}){return worker.read(subscriptionId,options);},
  reconcile(subscriptionId){const result=worker.reconcile(subscriptionId);needsScan=true;lastError=null;notify();return result;},
  status(){const status=worker.status();return Object.freeze({schema:'agent-webhook-driver-status-v1',closed,stopping,faulted:scanFault||status.faulted,inFlight:status.inFlight,active:jobs.size,capacity:status.capacity,pollIntervalMs,lastError});},
  close(options={}){
   const signal=signalOption(options);
   if(!closeDone){stopping=true;const transport=worker.close();notify();closeDone=Promise.all([transport,loop]).then(()=>Promise.all([...jobs.values()])).then(()=>{closed=true;return Object.freeze({status:'closed'});});closeDone.catch(()=>{});}
   return observe(closeDone,signal);
  }
 });
}
