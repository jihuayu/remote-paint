// Window lifecycle controller. A canceled start finishes before the next
// initialization begins, while stop releases live sockets/Workers immediately.
export class ViewerLifecycle {
 constructor({start,stop,onState,onError,hidden=false,gapMs=15000}){
  Object.assign(this,{start,stop,onState,onError,gapMs});this.hidden=hidden;this.frozen=false;this.version=0;this.state='idle';this.starts=0;this.restarts=0;this.lastTick=null;
 }
 publish(state,reason){this.state=state;this.reason=reason;this.onState?.({state,reason,version:this.version,starts:this.starts,restarts:this.restarts});}
 get runnable(){return !this.hidden&&!this.frozen&&!this.closed;}
 current(version){return this.runnable&&version===this.version;}
 suspend(reason='hidden'){
  if(this.state==='suspended'||this.closed)return;
  this.version++;this.lastTick=null;this.stop();this.publish('suspended',reason);
 }
 visibility(hidden){this.hidden=hidden;if(hidden)this.suspend('hidden');else void this.run();}
 freeze(){this.frozen=true;this.suspend('frozen');}
 resume(){this.frozen=false;this.lastTick=null;void this.run();}
 restart(reason='reconnect'){
  if(this.closed)return;this.restarts++;this.version++;this.lastTick=null;this.stop();this.publish(this.runnable?'idle':'suspended',reason);void this.run();
 }
 async run(){
  if(!this.runnable||this.starting||this.state==='running')return;
  const version=this.version;this.starting=true;this.starts++;this.publish('starting',this.reason??'initial');
  try{await this.start(version);if(this.current(version))this.publish('running',this.reason);}
  catch(error){if(this.current(version)){this.stop();this.publish('failed',error.message);this.onError?.(error);}}
  finally{this.starting=false;if(this.runnable&&version!==this.version)void this.run();}
 }
 tick(now){
  if(!this.runnable||this.state!=='running'){this.lastTick=null;return false;}
  const gap=this.lastTick===null?0:now-this.lastTick;this.lastTick=now;
  if(gap>this.gapMs||gap<0){this.restart('wake');return true;}return false;
 }
 close(){if(this.closed)return;this.version++;this.closed=true;this.lastTick=null;this.stop();this.publish('closed','closed');}
}
