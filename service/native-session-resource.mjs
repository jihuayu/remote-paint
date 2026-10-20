// Own the asynchronous start result before starting it. This wrapper is used
// only inside a runtime that independently owns the whole Native process set.
export class NativeSessionResource {
 #startLive;#request;#signal;#transportKey;#live=null;#starting=null;#closing=null;#stopping=false;#startupFailed=false;#startInvoked=false;
 constructor({request,signal,startLive,transportKey}={}){
  if(typeof startLive!=='function'||!(signal instanceof AbortSignal)||!request||typeof request.url!=='string')throw new TypeError('Configure an explicit Native Source factory and request');
  if(transportKey!==undefined&&(typeof transportKey!=='string'||!/^[a-f0-9]{64}$/.test(transportKey)))throw new TypeError('Invalid private Native transport key');
  this.#startLive=startLive;this.#request=structuredClone(request);this.#signal=signal;this.#transportKey=transportKey;
 }
 initialize(){
  if(this.#starting)return this.#starting;
  if(this.#stopping||this.#signal.aborted)return Promise.reject(new Error('Native startup cancelled'));
  this.#starting=Promise.resolve().then(async()=>{
   if(this.#stopping||this.#signal.aborted)throw new Error('Native startup cancelled');
   this.#startInvoked=true;this.#live=await this.#startLive({url:this.#request.url,...(this.#transportKey===undefined?{}:{transportKey:this.#transportKey})});
   const live=this.#live,source=live?.source;
   if(source?.nativeAutopublish!==true||!source.broker||!source.control||!source.browser?.isConnected()||typeof source.browser.version!=='function'||typeof live.close!=='function'||!/^[a-f0-9]{64}$/.test(live.renderer?.wasmSha256??'')||this.#transportKey!==undefined&&live.key!==this.#transportKey)throw new Error('Native Source was not ready');
   const version=`chromium:${source.browser.version()};wasm:${live.renderer.wasmSha256}`;
   if(!version.length||version.length>256)throw new Error('Invalid Native version');
   if(this.#stopping||this.#signal.aborted)throw new Error('Native startup cancelled');
   return {version};
  }).catch(error=>{this.#startupFailed=true;throw error;});
  return this.#starting;
 }
 close(){
  if(this.#closing)return this.#closing;
  this.#stopping=true;
  this.#closing=Promise.resolve().then(async()=>{
   try{await this.#starting;}catch{}
   this.#transportKey=null;
   const live=this.#live;
   if(!live){
    // A rejected startLive may have failed its own cleanup. The worker lacks
    // kernel ownership proof; only its outer runtime can confirm retirement.
    return {status:this.#startInvoked&&this.#startupFailed?'unconfirmed':'closed'};
   }
   try{
    await live.close();const source=live.source;
    const closed=source.closed===true&&source.latest===null&&source.producer===null&&source.demand===0&&source.encodeDemand===0&&source.activityDemand===0&&source.browser.isConnected()===false&&source.broker.exited===true&&source.broker.pending.size===0&&live.peers.size===0&&source.capture.binding===null;
    return {status:closed?'closed':'unconfirmed'};
   }catch{return {status:'unconfirmed'};}
  });
  return this.#closing;
 }
}
