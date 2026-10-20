// Own the asynchronous start result before starting it. This wrapper is used
// only inside a runtime that independently owns the whole Native process set.
export class NativeSessionResource {
 #startLive;#request;#signal;#transportKey;#live=null;#starting=null;#closing=null;#stopping=false;#startupFailed=false;#startInvoked=false;
 #unavailable=false;#subscriber=null;#bindings=[];
 constructor({request,signal,startLive,transportKey}={}){
  if(typeof startLive!=='function'||!(signal instanceof AbortSignal)||!request||typeof request.url!=='string')throw new TypeError('Configure an explicit Native Source factory and request');
  if(transportKey!==undefined&&(typeof transportKey!=='string'||!/^[a-f0-9]{64}$/.test(transportKey)))throw new TypeError('Invalid private Native transport key');
  this.#startLive=startLive;this.#request=structuredClone(request);this.#signal=signal;this.#transportKey=transportKey;
 }
 subscribeUnavailable(callback){
  if(typeof callback!=='function'||this.#subscriber!==null)throw new TypeError('Configure one trusted Native health subscriber');
  if(this.#stopping)throw new Error('Native Source is unavailable');
  this.#subscriber=callback;if(this.#unavailable)this.#notify();
  return()=>{if(this.#subscriber===callback)this.#subscriber=null;};
 }
 #notify(){try{const value=this.#subscriber?.();if(value?.then)void Promise.resolve(value).catch(()=>{});}catch{}}
 #lose(){if(this.#stopping||this.#unavailable)return;this.#unavailable=true;this.#transportKey=null;this.#notify();}
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
   return {version};
  }).catch(error=>{this.#startupFailed=true;throw error;});
  return this.#starting;
 }
 close(){
  if(this.#closing)return this.#closing;
  this.#stopping=true;this.#subscriber=null;this.#transportKey=null;
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
    await live.close();const source=live.source;
    const closed=source.closed===true&&source.latest===null&&source.producer===null&&source.demand===0&&source.encodeDemand===0&&source.activityDemand===0&&source.browser.isConnected()===false&&source.broker.exited===true&&source.broker.pending.size===0&&live.peers.size===0&&source.capture.binding===null;
    return {status:closed&&detached?'closed':'unconfirmed'};
   }catch{return {status:'unconfirmed'};}
  });
  return this.#closing;
 }
}
