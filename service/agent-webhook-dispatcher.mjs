import {Agent,request} from 'node:https';
import {Resolver} from 'node:dns';
import {isIP} from 'node:net';
import {createSecureContext} from 'node:tls';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {SqliteSessionStore} from './session-store.mjs';
import {createAgentWebhookAuthenticator} from './agent-webhook-auth.mjs';

export const AGENT_WEBHOOK_TRANSPORT_LIMITS=Object.freeze({concurrent:8,responseBytes:1024,headerBytes:8192,headers:32,information:4,addresses:8,timeoutMs:60000,backoffMs:60000});
export class AgentWebhookDispatchError extends Error {
 constructor(code){super('Agent Webhook delivery is unavailable');this.name='AgentWebhookDispatchError';Object.defineProperty(this,'code',{value:code,enumerable:true});}
}
const error=code=>new AgentWebhookDispatchError(code),fail=code=>{throw error(code);};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$').test(v);
const digest=body=>createHash('sha256').update(body).digest('hex');
function record(v,required,optional=[]){
 if(!v||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))throw Error();const ds=Object.getOwnPropertyDescriptors(v),keys=Reflect.ownKeys(ds);
 if(required.some(k=>!Object.hasOwn(ds,k))||keys.some(k=>typeof k!=='string'||![...required,...optional].includes(k)||!Object.hasOwn(ds[k],'value')))throw Error();return Object.fromEntries(keys.map(k=>[k,ds[k].value]));
}
const aborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted').get;
const add=EventTarget.prototype.addEventListener,remove=EventTarget.prototype.removeEventListener;
function observe(promise,signal){
 if(signal===undefined)return promise;
 return new Promise((resolve,reject)=>{
  let done=false;const finish=(fn,value)=>{if(done)return;done=true;remove.call(signal,'abort',cancel);fn(value);},cancel=()=>finish(reject,error('AGENT_WEBHOOK_ABORTED'));
  add.call(signal,'abort',cancel,{once:true});promise.then(v=>finish(resolve,v),e=>finish(reject,e));if(aborted.call(signal))cancel();
 });
}
function signalOption(value){try{const v=record(value,[],['signal']);if(v.signal!==undefined&&(types.isProxy(v.signal)||typeof aborted.call(v.signal)!=='boolean'))throw Error();return v.signal;}catch{fail('AGENT_WEBHOOK_INVALID');}}

// The caller supplies private backend configuration, never a public request URL.
// Each entry owns its original DNS callback and actual I/O until all settle.
export function createAgentWebhookDispatcher(config){
 let v,url,auth,agent,resolver,read,begin,settle,tenantId,endpointId,maxConcurrent,timeoutMs,retryBaseMs,lookup;
 try{
  v=record(config,['store','owner','tenantId','endpointId','url','keys','activeKeyId'],['ca','maxConcurrent','timeoutMs','retryBaseMs','lookup','dnsServers']);
  ({tenantId,endpointId}=v);maxConcurrent=Object.hasOwn(v,'maxConcurrent')?v.maxConcurrent:2;timeoutMs=Object.hasOwn(v,'timeoutMs')?v.timeoutMs:30000;retryBaseMs=Object.hasOwn(v,'retryBaseMs')?v.retryBaseMs:1000;lookup=null;
  if(types.isProxy(v.store)||Object.getPrototypeOf(v.store)!==SqliteSessionStore.prototype||typeof v.owner!=='symbol'||typeof tenantId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantId)||!id(endpointId,'awh')||typeof v.url!=='string'||v.url.length>2048||!integer(maxConcurrent,1,8)||!integer(timeoutMs,50,60000)||!integer(retryBaseMs,10,10000))throw Error();
  if(Object.hasOwn(v,'lookup')){lookup=v.lookup;if(typeof lookup!=='function'||types.isProxy(lookup)||types.isAsyncFunction(lookup)||types.isGeneratorFunction(lookup)||Object.hasOwn(v,'dnsServers'))throw Error();}
  url=new URL(v.url);if(url.protocol!=='https:'||url.username||url.password||url.hash||url.port==='0'||!url.hostname)throw Error();
  if(Object.hasOwn(v,'ca')&&(typeof v.ca!=='string'||v.ca.length===0||Buffer.byteLength(v.ca)>32768))throw Error();
  createSecureContext(Object.hasOwn(v,'ca')?{ca:v.ca}:{});
  resolver=new Resolver({timeout:Math.min(timeoutMs,10000),tries:1});
  if(Object.hasOwn(v,'dnsServers')){const servers=v.dnsServers;if(types.isProxy(servers)||!Array.isArray(servers)||Object.getPrototypeOf(servers)!==Array.prototype)throw Error();const ds=Object.getOwnPropertyDescriptors(servers),count=ds.length.value;if(!integer(count,1,4)||Reflect.ownKeys(ds).length!==count+1)throw Error();const captured=Array.from({length:count},(_,i)=>{const d=ds[i];if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||d.value.length>128)throw Error();return d.value;});resolver.setServers(captured);}
  SqliteSessionStore.prototype.agentHead.call(v.store,{owner:v.owner});
  read=(sub,options={})=>SqliteSessionStore.prototype.readAgentWebhookCapture.call(v.store,sub,tenantId,options,{owner:v.owner});
  begin=sub=>SqliteSessionStore.prototype.beginAgentWebhookAttempt.call(v.store,sub,tenantId,{owner:v.owner});
  settle=(sub,a,outcome)=>SqliteSessionStore.prototype.settleAgentWebhookAttempt.call(v.store,sub,tenantId,{deliveryId:a.deliveryId,attemptId:a.attemptId,bodySha256:a.bodySha256,outcome,transportSettled:true},{owner:v.owner});
  auth=createAgentWebhookAuthenticator({endpointId,keys:v.keys,activeKeyId:v.activeKeyId});
  agent=new Agent({keepAlive:false,maxSockets:maxConcurrent,maxTotalSockets:maxConcurrent,maxFreeSockets:0,maxCachedSessions:0,...(v.ca===undefined?{}:{ca:v.ca})});
  v={store:v.store,owner:v.owner};config=null;
 }catch{auth?.close();agent?.destroy();resolver?.cancel();fail('AGENT_WEBHOOK_INVALID');}
 const entries=new Map();let closed=false,closeDone=null,resolveClose=null;
 const drained=()=>{if(closed&&entries.size===0)resolveClose?.(Object.freeze({status:'closed'}));};
 const retire=e=>{if(entries.get(e.sub)===e)entries.delete(e.sub);drained();};
 const faulted=()=>[...entries.values()].some(e=>e.persistenceFault);
 function capture(sub){const c=read(sub);if(c.endpointId!==endpointId)fail('AGENT_WEBHOOK_REFERENCE');return c;}
 function view(e,status,c){return Object.freeze({schema:'agent-webhook-delivery-v1',subscriptionId:e.sub,status,eventId:e.attempt?.eventId??null,deliveryId:e.attempt?.deliveryId??null,sequence:e.attempt?.sequence??null,attempts:e.attempt?.attempts??0,transportOutcome:e.outcome??null,acceptedThrough:c.acceptedThrough,reconciliationRequired:c.reconciliationRequired});}
 function resolvedLookup(host,opts,callback){
  const families=opts.family===4?[4]:opts.family===6?[6]:[4,6],answers=[];let left=families.length;
  for(const family of families){let done=false;const finish=(err,addresses)=>{if(done)return;done=true;if(!err)for(const address of addresses)answers.push({address,family});if(--left)return;answers.sort((a,b)=>a.family-b.family);if(answers.length===0||answers.length>8){callback(Error('Webhook lookup unavailable'));return;}if(opts.all)callback(null,answers);else callback(null,answers[0].address,answers[0].family);};try{resolver[family===4?'resolve4':'resolve6'](host,finish);}catch{finish(Error());}}
 }
 function backoff(e,ms){return new Promise(resolve=>{const finish=()=>{clearTimeout(timer);if(e.stop===finish)e.stop=null;resolve();},timer=setTimeout(finish,ms);e.stop=finish;if(closed)finish();});}
 function transport(e,signed){
  return new Promise(resolve=>{
   if(closed||performance.now()-e.startedAt>=timeoutMs){e.ioSettled=true;resolve('unknown');return;}
   let req,reqClosed=false,constructing=true,pendingLookup=0,openSockets=0,openResponses=0,interrupted=false,finished=false,information=0,outcome='unknown';const sockets=new Set(),responses=new Set();
   const finish=()=>{if(finished||constructing||!reqClosed||pendingLookup||openSockets||openResponses)return;finished=true;clearTimeout(timer);if(e.stop===stop)e.stop=null;e.ioSettled=true;resolve(outcome);};
   const stop=()=>{if(outcome!=='accepted')interrupted=true;req?.destroy();for(const res of responses)res.destroy();for(const socket of sockets)socket.destroy();};
   const interrupt=()=>{interrupted=true;outcome='unknown';stop();};
   const timer=setTimeout(interrupt,Math.max(1,timeoutMs-(performance.now()-e.startedAt)));e.stop=stop;e.ioSettled=false;
   const ownSocket=socket=>{if(sockets.has(socket))return;sockets.add(socket);openSockets++;socket.on('error',()=>{});socket.once('close',()=>{sockets.delete(socket);openSockets--;finish();});if(closed||interrupted)socket.destroy();};
   const ownResponse=res=>{if(responses.has(res))return;responses.add(res);openResponses++;res.on('error',interrupt);res.once('close',()=>{responses.delete(res);openResponses--;finish();});};
   function ownedLookup(host,opts,callback){
    pendingLookup++;let called=false;
    const completed=(err,address,family)=>{
     if(called)return;called=true;
     try{
      if(!err){if(opts.all){if(!Array.isArray(address)||address.length<1||address.length>8||address.some(x=>!x||typeof x.address!=='string'||![4,6].includes(x.family)||isIP(x.address)!==x.family))err=Error();}else if(typeof address!=='string'||![4,6].includes(family)||isIP(address)!==family)err=Error();}
      callback(err?Error('Webhook lookup unavailable'):null,address,family);
     }catch{interrupt();}finally{pendingLookup--;finish();}
    };
    try{const result=(lookup??resolvedLookup)(host,opts,completed);if(types.isPromise(result))Promise.prototype.then.call(result,()=>{},()=>{});}catch{interrupt();}
    // A thrown/returned lower-level operation is not evidence its DNS work
    // stopped. The original callback alone retires this ownership token.
   }
   try{
    req=request(url,{method:'POST',agent,rejectUnauthorized:true,maxHeaderSize:8192,highWaterMark:1024,lookup:ownedLookup,headers:{...signed.headers,'content-length':String(signed.body.byteLength),connection:'close',accept:'application/json','user-agent':'remote-paint-webhook/1'}});
    // Retain one sentinel header so truncation cannot hide an over-limit set.
    req.maxHeadersCount=33;req.on('socket',ownSocket);req.on('error',interrupt);req.once('close',()=>{reqClosed=true;finish();});
    req.on('information',info=>{if(++information>4||info.rawHeaders.length>64)interrupt();});
    const upgrade=(res,socket)=>{ownResponse(res);ownSocket(socket);interrupt();};req.on('upgrade',upgrade);req.on('connect',upgrade);
    req.on('response',res=>{
     ownResponse(res);let used=0;const bytes=Buffer.alloc(1024),names=new Set();
     if(res.rawHeaders.length>64||res.rawHeaders.some((name,i)=>i%2===0&&(names.has(name.toLowerCase())||!names.add(name.toLowerCase()))))interrupt();
     res.on('data',chunk=>{if(interrupted)return;if(!Buffer.isBuffer(chunk)||used+chunk.length>1024){interrupt();return;}chunk.copy(bytes,used);used+=chunk.length;});
     res.once('end',()=>{
      if(interrupted||!res.complete||res.rawTrailers.length)return;
      if(![200,202].includes(res.statusCode)){outcome='not-accepted';return;}
      try{if(!/^application\/json(?:;\s*charset=utf-8)?$/i.test(res.headers['content-type']??''))throw Error();const ack=record(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used))),['schema','eventId','bodySha256']);if(ack.schema!=='agent-webhook-ack-v1'||ack.eventId!==e.attempt.eventId||ack.bodySha256!==e.attempt.bodySha256)throw Error();outcome='accepted';}catch{outcome='unknown';}
     });
    });
    if(closed||interrupted||performance.now()-e.startedAt>=timeoutMs)interrupt();else req.end(signed.body);
   }catch{reqClosed=true;interrupt();}
   constructing=false;finish();
  });
 }
 async function run(e){
  for(;;){
   e.stage='read';let c=capture(e.sub),head=c.deliveries[0];if(!head){if(e.expected)fail('AGENT_WEBHOOK_REFERENCE');return view(e,c.reconciliationRequired?'reconciliation-required':'idle',c);}if(e.expected&&head.deliveryId!==e.expected.deliveryId)fail('AGENT_WEBHOOK_REFERENCE');
   e.expected=head;
   if(closed)return view(e,'interrupted',c);if(head.attempts>=8&&head.lastOutcome!=='requested')return view({...e,attempt:head},'exhausted',c);
   if(head.lastOutcome==='requested')fail('AGENT_WEBHOOK_IN_FLIGHT');
   if(head.attempts){await backoff(e,Math.min(60000,retryBaseMs*2**(head.attempts-1)));if(closed)return view(e,'interrupted',capture(e.sub));c=capture(e.sub);head=c.deliveries[0];if(!head||head.deliveryId!==e.expected.deliveryId)fail('AGENT_WEBHOOK_REFERENCE');}
   e.expected=head;e.stage='begin';e.ioSettled=true;e.startedAt=performance.now();e.attempt=begin(e.sub).attempt;if(!e.attempt)return view(e,'idle',capture(e.sub));
   e.outcome='not-accepted';e.stage='transport';
   try{const raw=Buffer.from(e.attempt.body,'utf8');if(digest(raw)!==e.attempt.bodySha256)throw Error();const signed=auth.sign({eventId:e.attempt.eventId,body:raw});e.outcome=await transport(e,signed);}catch{e.outcome='unknown';if(!e.ioSettled)throw error('AGENT_WEBHOOK_STATE_UNCONFIRMED');}
   e.stage='settle';const result=settle(e.sub,e.attempt,e.outcome);e.stage='settled';
   if(e.outcome==='accepted')return view(e,'accepted',result.capture);if(closed)return view(e,'interrupted',result.capture);if(e.attempt.attempts>=8)return view(e,'exhausted',result.capture);
  }
 }
 const dispatcher=Object.freeze({
  subscribe(input){try{if(closed)fail('AGENT_WEBHOOK_CLOSED');if(faulted())fail('AGENT_WEBHOOK_STATE_UNCONFIRMED');const {agentRunId,after}=record(input,['agentRunId','after']);if(!id(agentRunId,'arun')||!integer(after,0,Number.MAX_SAFE_INTEGER))throw Error();return SqliteSessionStore.prototype.subscribeAgentWebhook.call(v.store,agentRunId,tenantId,{endpointId,after},{owner:v.owner});}catch(e){if(e instanceof AgentWebhookDispatchError)throw e;fail('AGENT_WEBHOOK_STATE_UNAVAILABLE');}},
  read(sub,options={}){try{const c=capture(sub);if(Reflect.ownKeys(options).length===0)return c;const page=read(sub,options);if(page.endpointId!==endpointId)throw Error();return page;}catch(e){if(e instanceof AgentWebhookDispatchError)throw e;fail('AGENT_WEBHOOK_STATE_UNAVAILABLE');}},
  revision(){try{return SqliteSessionStore.prototype.agentWebhookHead.call(v.store,{owner:v.owner}).revision;}catch{fail('AGENT_WEBHOOK_STATE_UNAVAILABLE');}},
  list(options={}){try{const fields=record(options,[],['after','limit']);return SqliteSessionStore.prototype.listAgentWebhookSubscriptions.call(v.store,tenantId,{...fields,endpointId},{owner:v.owner});}catch{fail('AGENT_WEBHOOK_STATE_UNAVAILABLE');}},
  deliver(sub,options={}){
   try{const signal=signalOption(options);if(signal!==undefined&&aborted.call(signal))fail('AGENT_WEBHOOK_ABORTED');if(closed)fail('AGENT_WEBHOOK_CLOSED');if(faulted())fail('AGENT_WEBHOOK_STATE_UNCONFIRMED');if(!id(sub,'awsub'))fail('AGENT_WEBHOOK_INVALID');if(entries.has(sub))fail('AGENT_WEBHOOK_IN_FLIGHT');if(entries.size>=maxConcurrent)fail('AGENT_WEBHOOK_CAPACITY');
    const e={sub,stage:'admitted',attempt:null,expected:null,outcome:null,ioSettled:true,persistenceFault:false,stop:null,done:null};entries.set(sub,e);
    e.done=Promise.resolve().then(()=>run(e)).then(result=>{retire(e);return result;},failure=>{if(['begin','settle'].includes(e.stage)||!e.ioSettled){e.persistenceFault=true;throw error('AGENT_WEBHOOK_STATE_UNCONFIRMED');}retire(e);if(failure instanceof AgentWebhookDispatchError)throw failure;throw error('AGENT_WEBHOOK_STATE_UNAVAILABLE');});e.done.catch(()=>{});return observe(e.done,signal);
   }catch(e){return Promise.reject(e instanceof AgentWebhookDispatchError?e:error('AGENT_WEBHOOK_INVALID'));}
  },
  reconcile(sub){
   const e=entries.get(sub);if(!e||!e.persistenceFault||!e.ioSettled)fail('AGENT_WEBHOOK_STATE_UNCONFIRMED');
   try{let result;if(e.stage==='begin'){const c=capture(sub),head=c.deliveries[0];if(!head||head.deliveryId!==e.expected.deliveryId||head.eventId!==e.expected.eventId||head.bodySha256!==e.expected.bodySha256)throw Error();if(head.attempts===e.expected.attempts&&head.lastOutcome===e.expected.lastOutcome){retire(e);return Object.freeze({reconciled:true});}if(head.lastOutcome!=='requested'||head.attempts!==e.expected.attempts+1)throw Error();e.attempt=head;e.outcome='unknown';}result=settle(sub,e.attempt,e.outcome);retire(e);return Object.freeze({reconciled:true,capture:result.capture});}catch{fail('AGENT_WEBHOOK_STATE_UNCONFIRMED');}
  },
  status(){return Object.freeze({schema:'agent-webhook-dispatcher-status-v1',closed,faulted:faulted(),inFlight:entries.size,capacity:maxConcurrent});},
  close(options={}){
   try{const signal=signalOption(options);closed=true;if(!closeDone)closeDone=new Promise(resolve=>{resolveClose=resolve;});auth.close();for(const e of entries.values())e.stop?.();agent.destroy();resolver.cancel();drained();return observe(closeDone,signal);}catch(e){return Promise.reject(e instanceof AgentWebhookDispatchError?e:error('AGENT_WEBHOOK_INVALID'));}
  }
 });return dispatcher;
}
