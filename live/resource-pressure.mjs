// Resource leases may be held by a slow peer after cache/history retirement.
// Pause display capture while those owners drain; the page clock stays alive.
export class ResourcePressure {
 constructor({broker,onChange,onStats=()=>{},onError,pollMs=100,retryMs=1000}){
  Object.assign(this,{broker,onChange,onStats,onError,pollMs,retryMs,active:false,paused:false,closed:false});
 }
 enter(){
  if(this.closed||this.paused)return;
  this.attempts=Math.min((this.attempts??0)+1,10);this.paused=true;this.since=performance.now();this.notBefore=this.since+Math.min(this.retryMs,this.pollMs*2**(this.attempts-1));this.onChange(true);this.schedule();
 }
 recovered(){this.attempts=0;}
 setActive(active){this.active=active;clearTimeout(this.timer);this.timer=null;this.schedule();}
 schedule(){
  if(this.closed||!this.active||!this.paused||this.pending||this.timer)return;
  this.timer=setTimeout(()=>{this.timer=null;void this.check();},this.pollMs);this.timer.unref();
 }
 async check(){
  if(this.closed||!this.active||!this.paused||this.pending)return;
  this.pending=true;
  try{
   const stats=await this.broker.request('resourceBudget');if(this.closed)return;
   this.onStats(stats);
   // A conservative headroom estimate must not strand a smaller next frame
   // behind the latest valid snapshot. One bounded trial per second still
   // goes through hard admission; it cannot exceed the resource pool limit.
   const now=performance.now();if(stats.ready&&now>=this.notBefore||now-this.since>=this.retryMs){this.paused=false;this.onChange(false);}
  }catch(error){if(!this.closed&&!['INPUT_BUDGET_PRESSURE','RESOURCE_BUDGET_PRESSURE'].includes(error.code)){this.active=false;this.onError(error);}}
  finally{this.pending=false;this.schedule();}
 }
 close(){this.closed=true;this.active=false;clearTimeout(this.timer);this.timer=null;}
}
