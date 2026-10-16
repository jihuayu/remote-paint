import {EventEmitter} from 'node:events';

// One external clock per target. An ACK must arrive before another BeginFrame
// is issued; neither source screenshots nor Viewer decode drive this clock.
export class BeginFrameDriver extends EventEmitter {
 constructor(cdp,{interval=1000/60,idleInterval=100,quietFrames=12,timeout=10000}={}){
  super();
  if(!Number.isFinite(interval)||interval<=0||interval>1000)throw new Error('Invalid BeginFrame interval');
  if(!Number.isFinite(idleInterval)||idleInterval<interval||idleInterval>1000||!Number.isInteger(quietFrames)||quietFrames<1)throw new Error('Invalid idle clock settings');
  this.cdp=cdp;this.interval=interval;this.idleInterval=idleInterval;this.quietFrames=quietFrames;this.quiet=0;this.timeout=timeout;this.running=false;this.closed=false;
  this.stats={mode:'begin-frame',cadence:'active',issued:0,acked:0,damaged:0,errors:0,lastError:null};
 }
 step(){
  if(this.failure)return Promise.reject(this.failure);
  if(this.closed)return Promise.reject(new Error('BeginFrame driver is closed'));
  if(this.pending)return this.pending;
  this.stats.issued++;
  const work=(async()=>{
   let timer;
   try{
    const result=await Promise.race([
     this.cdp.send('HeadlessExperimental.beginFrame',{interval:this.interval,noDisplayUpdates:false}),
     new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('BeginFrame ACK timeout')),this.timeout);}),
    ]);
    this.stats.acked++;if(result.hasDamage){this.stats.damaged++;this.quiet=0;}else this.quiet++;
    this.stats.cadence=this.quiet>=this.quietFrames?'idle':'active';this.stats.lastError=null;
    this.emit('frame',result);return result;
   }catch(error){this.failure=error;this.stats.errors++;this.stats.lastError=error.message;throw error;}
   finally{clearTimeout(timer);}
  })();
  this.pending=work.finally(()=>{this.pending=null;});return this.pending;
 }
 requestNow(){
  this.quiet=0;this.stats.cadence='active';clearTimeout(this.timer);
  const work=this.step();
  // A wake during an ACK coalesces with that frame; a wake while idle
  // cancels the poll timer. The single pump schedules the next ACK safely.
  if(this.running&&!this.pumping)void this.pump();
  return work;
 }
 start(){
  if(this.closed)throw new Error('BeginFrame driver is closed');
  if(this.running)return;this.running=true;void this.pump();
 }
 async pump(){
  if(!this.running||this.closed||this.pumping)return;
  this.pumping=true;
  const start=performance.now();
  try{await this.step();}
  catch(error){this.running=false;this.emit('frameError',error);return;}
  finally{this.pumping=false;}
  const cadence=this.stats.cadence==='idle'?this.idleInterval:this.interval;
  if(this.running&&!this.closed)this.timer=setTimeout(()=>void this.pump(),Math.max(0,cadence-(performance.now()-start)));
 }
 async stop(){this.running=false;clearTimeout(this.timer);await this.pending?.catch(()=>{});}
 async close(){await this.stop();this.closed=true;await this.cdp.detach();}
}

export async function startBeginFrames(page,options={}){
 const {autoStart=true,...driverOptions}=options;
 const cdp=await page.context().newCDPSession(page),driver=new BeginFrameDriver(cdp,driverOptions);
 try{await driver.step();if(autoStart)driver.start();return driver;}
 catch(error){await driver.close();throw new Error(`BeginFrame control unavailable: ${error.message}`,{cause:error});}
}
