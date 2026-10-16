import {EventEmitter} from 'node:events';

// One external clock per target. An ACK must arrive before another BeginFrame
// is issued; neither source screenshots nor Viewer decode drive this clock.
export class BeginFrameDriver extends EventEmitter {
 constructor(cdp,{interval=1000/60,timeout=10000}={}){
  super();
  if(!Number.isFinite(interval)||interval<=0||interval>1000)throw new Error('Invalid BeginFrame interval');
  this.cdp=cdp;this.interval=interval;this.timeout=timeout;this.running=false;this.closed=false;
  this.stats={mode:'begin-frame',issued:0,acked:0,damaged:0,errors:0,lastError:null};
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
    this.stats.acked++;if(result.hasDamage)this.stats.damaged++;this.stats.lastError=null;
    this.emit('frame',result);return result;
   }catch(error){this.failure=error;this.stats.errors++;this.stats.lastError=error.message;throw error;}
   finally{clearTimeout(timer);}
  })();
  this.pending=work.finally(()=>{this.pending=null;});return this.pending;
 }
 requestNow(){return this.step();}
 start(){
  if(this.closed)throw new Error('BeginFrame driver is closed');
  if(this.running)return;this.running=true;void this.pump();
 }
 async pump(){
  if(!this.running||this.closed)return;
  const start=performance.now();
  try{await this.step();}
  catch(error){this.running=false;this.emit('frameError',error);return;}
  if(this.running&&!this.closed)this.timer=setTimeout(()=>void this.pump(),Math.max(0,this.interval-(performance.now()-start)));
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
