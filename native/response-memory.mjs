// A valid32KiB gateway input can contain about16k scalar nodes. Keep the
// conservative parser price and enough default control headroom for it.
export const RESPONSE_LIMITS={dataBytes:768*1024*1024,controlBytes:8*1024*1024,ingressBytes:2*1024*1024};
export function responsePressure(phase){return Object.assign(new Error('Native Broker response budget exceeded'),{code:'INPUT_BUDGET_PRESSURE',budget:'node-response',phase});}
function retireOwner(memory,owner){if(!memory.owners.delete(owner))return;memory.used[owner.lane]-=owner.total;memory.settle();}
function retireIngress(memory,owner){if(!memory.ingress.delete(owner))return;memory.ingressBytes-=owner.bytes;memory.settle();}

// These are explicit receive-buffer and parse/delivery transient owners. The
// application graph after delivery, native Readable internals/GC/VM/RSS are
// separate scopes. Retirement waits until callback stacks/microtasks unwind.
export class ResponseMemory {
 constructor(limits={}){
  this.limits={...RESPONSE_LIMITS,...limits};for(const value of Object.values(this.limits))if(!Number.isSafeInteger(value)||value<1)throw new Error('Invalid Broker response limits');
  if(this.limits.ingressBytes<8192)throw new Error('Invalid Broker response ingress limit');
  this.used={data:0,control:0};this.peak={data:0,control:0};this.owners=new Set();this.ingress=new Set();this.ingressBytes=8192;this.ingressPeak=8192;this.denied=0;this.waiters=[];this.closed=false;
 }
 grow(owner,bytes){const next=this.used[owner.lane]+bytes;if(!Number.isSafeInteger(bytes)||bytes<0||next>this.limits[owner.lane+'Bytes']){this.denied++;throw responsePressure('admission');}this.used[owner.lane]=next;this.peak[owner.lane]=Math.max(this.peak[owner.lane],next);owner.total+=bytes;}
 begin(lane,bytes){const owner={lane,total:0,packetReserved:bytes,packetBacking:0,parse:0,scheduled:false};this.grow(owner,bytes+1024);this.owners.add(owner);return owner;}
 allocated(owner,bytes){owner.packetBacking=bytes;}
 transfer(owner,lane){
  if(owner.lane===lane)return;const next=this.used[lane]+owner.total;if(next>this.limits[lane+'Bytes']){this.denied++;throw responsePressure('packet-transfer');}
  this.used[lane]=next;this.peak[lane]=Math.max(this.peak[lane],next);this.used[owner.lane]-=owner.total;owner.lane=lane;
 }
 parse(owner,bytes){this.grow(owner,bytes);owner.parse=bytes;}
 takeIngress(bytes){if(this.ingressBytes+bytes+256>this.limits.ingressBytes)throw new Error('Native Broker output ingress limit');const owner={bytes:bytes+256,scheduled:false};this.ingress.add(owner);this.ingressBytes+=owner.bytes;this.ingressPeak=Math.max(this.ingressPeak,this.ingressBytes);return owner;}
 retire(owner){if(!owner||owner.scheduled)return;owner.scheduled=true;setImmediate(retireOwner,this,owner);}
 releaseIngress(owner){if(!owner||owner.scheduled)return;owner.scheduled=true;setImmediate(retireIngress,this,owner);}
 settle(){if(!this.owners.size&&!this.ingress.size){for(const resolve of this.waiters.splice(0))resolve();}}
 ready(){return !this.closed&&this.used.data<=this.limits.dataBytes/2;}
 async close(){this.closed=true;for(const owner of this.owners)this.retire(owner);for(const owner of this.ingress)this.releaseIngress(owner);if(this.owners.size||this.ingress.size)await new Promise(resolve=>this.waiters.push(resolve));this.ingressBytes=0;}
 stats(){let packetReserved=0,packetBacking=0,parse=0;for(const owner of this.owners){packetReserved+=owner.packetReserved;packetBacking+=owner.packetBacking;parse+=owner.parse;}return {scope:'node-broker-response-transients',dataBytes:this.used.data,controlBytes:this.used.control,dataLimit:this.limits.dataBytes,controlLimit:this.limits.controlBytes,peakDataBytes:this.peak.data,peakControlBytes:this.peak.control,owners:this.owners.size,packetReservedBytes:packetReserved,privatePacketBackingBytes:packetBacking,parseDeliveryEstimate:parse,receivedBackingBytes:this.ingressBytes,peakReceivedBackingBytes:this.ingressPeak,receivedBackingLimit:this.limits.ingressBytes,denied:this.denied,ready:this.ready(),applicationGraph:'outside this transient owner after delivery',nativeStreamAndVm:'not covered'};}
}
