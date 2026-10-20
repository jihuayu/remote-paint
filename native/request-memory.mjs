const MiB=1024*1024;
export const REQUEST_LIMITS={dataBytes:512*MiB,controlBytes:4*MiB,owners:64,dataOwners:48};
export const CONTROL_OPS=new Set(['listen','listenViz','expectViz','cancelViz','publish','send','reset','resetScene','stop','mapperStats','inputBudget','resourceBudget','consumerTicket','registerNative','nativePolicy','cancelNative','nativeState']);
export function requestLimit(name,fallback,min,max){const value=process.env[name];if(value===undefined)return fallback;if(!/^[1-9]\d*$/.test(value))throw new Error(`Invalid ${name}`);const bytes=Number(value);if(!Number.isSafeInteger(bytes)||bytes<min||bytes>max)throw new Error(`Invalid ${name}`);return bytes;}
function pressure(phase){return Object.assign(new Error('Native Broker request budget exceeded'),{code:'INPUT_BUDGET_PRESSURE',budget:'node-request',phase});}

// Exact private packet backing lengths; conservative retained-graph and
// serialization estimates. Logical owner release does not certify VM/RSS GC.
export class RequestMemory {
 constructor(limits={}){
  this.limits={...REQUEST_LIMITS,...limits};for(const key of Object.keys(REQUEST_LIMITS))if(!Number.isSafeInteger(this.limits[key])||this.limits[key]<1)throw new Error('Invalid Broker request limits');
  if(this.limits.dataOwners>this.limits.owners)throw new Error('Invalid Broker request slots');
  this.owners=new Set();this.used={data:0,control:0};this.peak={data:0,control:0};this.denied=0;this.dataOwners=0;this.closing=false;this.waiters=[];
 }
 begin(op){
  const lane=CONTROL_OPS.has(op)?'control':'data';
  if(this.closing||this.owners.size>=this.limits.owners||lane==='data'&&this.dataOwners>=this.limits.dataOwners){this.denied++;throw pressure('slots');}
  const owner={lane,retained:0,transient:0,packet:0,scheduled:false,retire:0};this.grow(owner,4096,0);this.owners.add(owner);if(lane==='data')this.dataOwners++;return owner;
 }
 grow(owner,retained,transient){
  const bytes=retained+transient,limit=this.limits[`${owner.lane}Bytes`];
  if(!Number.isSafeInteger(bytes)||bytes<0||this.used[owner.lane]+bytes>limit){this.denied++;throw pressure('serialization');}
  this.used[owner.lane]+=bytes;this.peak[owner.lane]=Math.max(this.peak[owner.lane],this.used[owner.lane]);owner.retained+=retained;owner.transient+=transient;
 }
 node(owner){this.grow(owner,192,192);}
 text(owner,units){this.grow(owner,units*2,units*2);}
 packet(owner,bytes){this.grow(owner,0,bytes);owner.transient-=bytes;owner.packet+=bytes;}
 schedule(owner,mask){
  owner.retire|=mask;if(owner.scheduled)return;owner.scheduled=true;
  setImmediate(()=>{
   owner.scheduled=false;let bytes=0;
   if(owner.retire&1){bytes+=owner.transient;owner.transient=0;}
   if(owner.retire&2){bytes+=owner.packet;owner.packet=0;}
   if(owner.retire&4){bytes+=owner.retained;owner.retained=0;}
   owner.retire=0;this.used[owner.lane]-=bytes;
   if(owner.retained+owner.transient+owner.packet===0&&this.owners.delete(owner)){if(owner.lane==='data')this.dataOwners--;}
   if(this.owners.size===0){for(const resolve of this.waiters.splice(0))resolve();}
  });
 }
 encoded(owner){this.schedule(owner,1);}
 written(owner){this.schedule(owner,2);}
 responded(owner){this.schedule(owner,4);}
 abort(owner){this.schedule(owner,7);}
 beginClose(){this.closing=true;}
 async afterClose(){for(const owner of this.owners)this.abort(owner);if(this.owners.size)await new Promise(resolve=>this.waiters.push(resolve));}
 ready(){return !this.closing&&this.used.data<=this.limits.dataBytes/2&&this.dataOwners<this.limits.dataOwners&&this.owners.size<this.limits.owners;}
 stats(){
  const phases={retainedEstimate:0,serializationEstimate:0,packetBackingBytes:0};for(const owner of this.owners){phases.retainedEstimate+=owner.retained;phases.serializationEstimate+=owner.transient;phases.packetBackingBytes+=owner.packet;}
  return {scope:'node-broker-requests',dataBytes:this.used.data,controlBytes:this.used.control,dataLimit:this.limits.dataBytes,controlLimit:this.limits.controlBytes,peakDataBytes:this.peak.data,peakControlBytes:this.peak.control,owners:this.owners.size,dataOwners:this.dataOwners,ownerLimit:this.limits.owners,dataOwnerLimit:this.limits.dataOwners,denied:this.denied,ready:this.ready(),...phases};
 }
}
