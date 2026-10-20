import {createManagedAgentRun} from '../live/managed-agent-run.mjs';
import {AgentRpcError,captureAgentRequest} from './agent-rpc.mjs';
// Own the asynchronous start result before starting it. This wrapper is used
// only inside a runtime that independently owns the whole Native process set.
export class NativeSessionResource {
 #startLive;#request;#signal;#transportKey;#live=null;#starting=null;#closing=null;#stopping=false;#startupFailed=false;#startInvoked=false;
 #unavailable=false;#subscriber=null;#bindings=[];
 #sessionId;#tenantId;#initialized=false;#version=null;#agentRun=null;#agentBinding=null;#agentEnding=null;#agentActivity=null;
 constructor({request,signal,startLive,transportKey,sessionId=null,tenantId=null}={}){
  if(typeof startLive!=='function'||!(signal instanceof AbortSignal)||!request||typeof request.url!=='string')throw new TypeError('Configure an explicit Native Source factory and request');
  if(transportKey!==undefined&&(typeof transportKey!=='string'||!/^[a-f0-9]{64}$/.test(transportKey)))throw new TypeError('Invalid private Native transport key');
  if((sessionId!==null||tenantId!==null)&&(typeof sessionId!=='string'||!/^ses_[A-Za-z0-9_-]{1,124}$/.test(sessionId)||typeof tenantId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(tenantId)))throw new TypeError('Configure the fixed Native Agent identity');
  this.#sessionId=sessionId;this.#tenantId=tenantId;
  this.#startLive=startLive;this.#request=structuredClone(request);this.#signal=signal;this.#transportKey=transportKey;
 }
 subscribeUnavailable(callback){
  if(typeof callback!=='function'||this.#subscriber!==null)throw new TypeError('Configure one trusted Native health subscriber');
  if(this.#stopping)throw new Error('Native Source is unavailable');
  this.#subscriber=callback;if(this.#unavailable)this.#notify();
  return()=>{if(this.#subscriber===callback)this.#subscriber=null;};
 }
 #notify(){try{const value=this.#subscriber?.();if(value?.then)void Promise.resolve(value).catch(()=>{});}catch{}}
 #lose(){if(this.#stopping||this.#unavailable)return;this.#unavailable=true;this.#transportKey=null;const activity=this.#agentActivity;this.#agentActivity=null;try{activity?.();}finally{this.#notify();}}
 #healthy(source){return source.closed!==true&&source.targetCrashed!==true&&source.browser.isConnected()===true&&source.page.isClosed()===false&&source.broker.closed===false&&source.broker.exited===false;}
 #bind(source){
  for(const [target,event]of [[source.browser,'disconnected'],[source.broker,'failure'],[source.page,'crash'],[source.page,'close']]){if(this.#stopping||this.#signal.aborted||this.#unavailable)break;const callback=()=>this.#lose();this.#bindings.push({target,event,callback});target.on(event,callback);}
 }
 #detach(){let detached=true;const bindings=this.#bindings;this.#bindings=[];for(const {target,event,callback}of bindings)try{target.off(event,callback);}catch{detached=false;}return detached;}
 initialize(){
  if(this.#unavailable)return Promise.reject(new Error('Native Source is unavailable'));
  if(this.#stopping||this.#signal.aborted)return Promise.reject(new Error('Native startup cancelled'));
  if(this.#starting)return this.#starting;
  this.#starting=Promise.resolve().then(async()=>{
   if(this.#stopping||this.#signal.aborted)throw new Error('Native startup cancelled');
   this.#startInvoked=true;this.#live=await this.#startLive({url:this.#request.url,...(this.#transportKey===undefined?{}:{transportKey:this.#transportKey})});
   if(this.#stopping||this.#signal.aborted)throw new Error('Native startup cancelled');
   const live=this.#live,source=live?.source;
   if(source?.nativeAutopublish!==true||!source.broker||!source.control||typeof source.browser?.isConnected!=='function'||typeof source.browser.version!=='function'||typeof source.page?.isClosed!=='function'||[source.browser,source.broker,source.page].some(target=>typeof target?.on!=='function'||typeof target?.off!=='function')||typeof live.close!=='function'||!/^[a-f0-9]{64}$/.test(live.renderer?.wasmSha256??'')||this.#transportKey!==undefined&&live.key!==this.#transportKey)throw new Error('Native Source was not ready');
   this.#bind(source);
   if(!this.#healthy(source)){this.#lose();throw new Error('Native Source is unavailable');}
   const version=`chromium:${source.browser.version()};wasm:${live.renderer.wasmSha256}`;
   if(!version.length||version.length>256)throw new Error('Invalid Native version');
   if(this.#unavailable)throw new Error('Native Source is unavailable');
   if(this.#stopping||this.#signal.aborted)throw new Error('Native startup cancelled');
   if(!this.#healthy(source)){this.#lose();throw new Error('Native Source is unavailable');}
   this.#version=version;this.#initialized=true;return {version};
  }).catch(error=>{this.#startupFailed=true;throw error;});
  return this.#starting;
 }
 #agentAvailable(){return typeof this.#sessionId==='string'&&/^ses_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(this.#sessionId)&&this.#initialized&&!this.#stopping&&!this.#unavailable&&!this.#signal.aborted&&this.#live&&this.#healthy(this.#live.source);}
 get agentObservationVersion(){return 1;}
 agent(value){
  if(!this.#agentAvailable())throw new AgentRpcError('AGENT_UNAVAILABLE','not-dispatched');
  const request=captureAgentRequest(value);
  if(request.op==='begin'){
   if(this.#agentRun||this.#agentEnding)throw new AgentRpcError('AGENT_RPC_BUSY','not-dispatched');
   // A run waits for page postconditions between calls. Own clock demand for
   // that lifetime without starting display/observation/recording encoding.
   const activity=this.#live.source.acquirePageRun?.({signal:this.#signal});if(typeof activity!=='function')throw new AgentRpcError('AGENT_UNAVAILABLE','not-dispatched');
   try{const run=createManagedAgentRun(this.#live.source.control,{sessionId:this.#sessionId,tenantId:this.#tenantId,version:this.#version,authorize:({binding})=>this.#agentAvailable()&&binding.sessionId===this.#sessionId&&binding.tenantId===this.#tenantId});this.#agentRun=run;const context=run.context();this.#agentBinding=context.binding;this.#agentActivity=activity;return context;}catch(error){activity();throw error;}
  }
  const run=this.#agentRun;if(!run||request.runId!==undefined&&request.runId!==this.#agentBinding?.runId)throw new AgentRpcError('AGENT_RUN_NOT_FOUND','not-dispatched');
  if(request.op==='end'){
   if(this.#agentEnding)return this.#agentEnding;
   this.#agentEnding=run.close().then(result=>{if(this.#agentRun===run){this.#agentActivity?.();this.#agentActivity=null;this.#agentRun=null;this.#agentBinding=null;}this.#agentEnding=null;return result;});return this.#agentEnding;
  }
  if(this.#agentEnding)throw new AgentRpcError('AGENT_RPC_BUSY','not-dispatched');
  if(request.op==='context')return run.context();
  if(request.op==='observation-context')return run.observationContext();
  if(request.op==='observe')return run.observe(request.query,request.context,request.limits);
  return run.perform(request.tool,request.params,request.context);
 }
 close(){
  if(this.#closing)return this.#closing;
  this.#stopping=true;this.#subscriber=null;this.#transportKey=null;
  const run=this.#agentRun,activity=this.#agentActivity;this.#agentRun=null;this.#agentBinding=null;this.#agentActivity=null;
  let agentClose;try{agentClose=run?.close()??Promise.resolve();}catch{agentClose=Promise.reject(new Error('Native Agent close unavailable'));}void agentClose.catch(()=>{});
  this.#closing=Promise.resolve().then(async()=>{
   try{await this.#starting;}catch{}
   // A synchronous event-registration callback may have reentered close.
   // Own that registration until initialize settles, then detach before any
   // intentional process shutdown can emit terminal events.
   const detached=this.#detach();
   const live=this.#live;
   if(!live){
    // A rejected startLive may have failed its own cleanup. The worker lacks
    // kernel ownership proof; only its outer runtime can confirm retirement.
    return {status:this.#startInvoked&&this.#startupFailed?'unconfirmed':'closed'};
   }
   try{
    await Promise.all([live.close(),agentClose]);activity?.();const source=live.source;
    const closed=source.closed===true&&source.latest===null&&source.producer===null&&source.demand===0&&source.encodeDemand===0&&source.activityDemand===0&&source.browser.isConnected()===false&&source.broker.exited===true&&source.broker.pending.size===0&&live.peers.size===0&&source.capture.binding===null;
    return {status:closed&&detached?'closed':'unconfirmed'};
   }catch{activity?.();return {status:'unconfirmed'};}
  });
  return this.#closing;
 }
}
