export class ClusterWorkerFenceError extends Error {
 constructor(code,outcome='not-dispatched'){super('Worker lease or placement is unavailable');this.name='ClusterWorkerFenceError';this.code=code;this.outcome=outcome;}
}
const fail=code=>{throw new ClusterWorkerFenceError(code);};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v,keys)=>v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const keys=['tenantId','sessionId','nodeId','generation','epoch'];
const frozen=v=>Object.freeze({...v});

// Worker-local half of placement fencing. Only a trusted, authenticated
// coordinator adapter may deliver lease/placement receipts. These integers
// are not bearer credentials. Expiry aborts the resource owner's signal;
// independent runtime retirement evidence is still required by the ledger.
export class ClusterWorkerFence {
 #nodeId;#incarnation;#now;#last=-1;#generation=null;#deadline=0;#pending=null;#timer=null;
 #state='unregistered';#controller=new AbortController();#onExpired;#terminal=null;#sessions=new Map();#max;
 constructor({nodeId,incarnation,now=()=>Math.floor(performance.now()),onExpired,maxSessions=10000}={}){
  if(!id(nodeId)||!id(incarnation)||typeof now!=='function'||typeof onExpired!=='function'||!integer(maxSessions,1,100000))throw new TypeError('Configure a trusted Worker identity, clock, owner cleanup and finite retention');
  this.#nodeId=nodeId;this.#incarnation=incarnation;this.#now=now;this.#onExpired=onExpired;this.#max=maxSessions;
 }
 get signal(){return this.#controller.signal;}
 get terminal(){return this.#terminal;}
 #end(reason){
  if(this.#terminal)return this.#terminal;
  clearTimeout(this.#timer);this.#timer=null;this.#state='expired';this.#pending=null;
  // Assign before either AbortSignal listeners or cleanup can reenter.
  this.#terminal=Promise.resolve().then(()=>this.#onExpired(frozen({reason,nodeId:this.#nodeId,incarnation:this.#incarnation,generation:this.#generation})));
  this.#controller.abort(new ClusterWorkerFenceError(reason));
  void this.#terminal.catch(()=>{});return this.#terminal;
 }
 #clock(){
  const at=this.#now();if(!integer(at,0,Number.MAX_SAFE_INTEGER)||at<this.#last){this.#end('CLUSTER_WORKER_CLOCK');fail('CLUSTER_WORKER_CLOCK');}
  this.#last=at;return at;
 }
 #live(){const at=this.#clock();if(this.#state==='active'&&at>=this.#deadline)this.#end('CLUSTER_WORKER_LEASE_EXPIRED');if(this.#state!=='active')fail('CLUSTER_WORKER_LEASE');return at;}
 beginHeartbeat(){
  const at=this.#clock();if(this.#state==='expired')fail('CLUSTER_WORKER_LEASE');if(this.#state==='active')this.#live();if(this.#pending)fail('CLUSTER_WORKER_HEARTBEAT_BUSY');
  return this.#pending=Object.freeze({startedAt:at});
 }
 rejectHeartbeat(observation){if(observation!==this.#pending||!observation)fail('CLUSTER_WORKER_HEARTBEAT');this.#pending=null;if(this.#state==='active')this.#live();}
 acceptLease(observation,lease,{leaseMs}={}){
  const at=this.#clock();if(this.#state==='active')this.#live();
  if(this.#state==='expired'||observation!==this.#pending||!observation)fail('CLUSTER_WORKER_HEARTBEAT');this.#pending=null;
  if(!exact(lease,['nodeId','incarnation','generation'])||lease.nodeId!==this.#nodeId||lease.incarnation!==this.#incarnation||!integer(lease.generation,1,Number.MAX_SAFE_INTEGER)||!integer(leaseMs,100,60000))fail('CLUSTER_WORKER_LEASE');
  if(this.#generation!==null&&this.#generation!==lease.generation){this.#end('CLUSTER_WORKER_GENERATION_CHANGED');fail('CLUSTER_WORKER_LEASE');}
  // Start the local deadline before the request, never at receipt time. A
  // slow response therefore consumes its own lease budget without clock sync.
  const deadline=observation.startedAt+leaseMs;
  if(!Number.isSafeInteger(deadline)||deadline<=at){this.#end('CLUSTER_WORKER_LEASE_EXPIRED');fail('CLUSTER_WORKER_LEASE');}
  this.#generation=lease.generation;this.#deadline=deadline;this.#state='active';clearTimeout(this.#timer);
  const expire=()=>{try{const remaining=this.#deadline-this.#clock();if(remaining<=0)this.#end('CLUSTER_WORKER_LEASE_EXPIRED');else{this.#timer=setTimeout(expire,remaining);this.#timer.unref();}}catch{this.#end('CLUSTER_WORKER_CLOCK');}};
  this.#timer=setTimeout(expire,deadline-at);this.#timer.unref();return this.status();
 }
 #capture(binding){
  if(!exact(binding,keys)||!id(binding.tenantId)||!id(binding.sessionId)||binding.nodeId!==this.#nodeId||binding.generation!==this.#generation||!integer(binding.epoch,1,Number.MAX_SAFE_INTEGER))fail('CLUSTER_WORKER_FENCE');
  return Object.freeze(Object.fromEntries(keys.map(k=>[k,binding[k]])));
 }
 admit(binding){
  this.#live();const captured=this.#capture(binding),old=this.#sessions.get(captured.sessionId);
  if(old){if(keys.some(k=>old[k]!==captured[k]))fail('CLUSTER_WORKER_FENCE');return old;}
  if(this.#sessions.size>=this.#max)fail('CLUSTER_WORKER_RETENTION_LIMIT');this.#sessions.set(captured.sessionId,captured);return captured;
 }
 check(binding){this.#live();const captured=this.#capture(binding),old=this.#sessions.get(captured.sessionId);if(!old||keys.some(k=>old[k]!==captured[k]))fail('CLUSTER_WORKER_FENCE');return old;}
 async run(binding,effect){
  this.check(binding);if(typeof effect!=='function')throw new TypeError('Expected a trusted effect callback');
  let result;try{result=await effect(this.#controller.signal);}catch{throw new ClusterWorkerFenceError('CLUSTER_WORKER_EFFECT_FAILED','unknown');}
  try{this.check(binding);}catch{throw new ClusterWorkerFenceError('CLUSTER_WORKER_FENCE_LOST','unknown');}return result;
 }
 status(){
  const at=this.#clock();if(this.#state==='active'&&at>=this.#deadline)this.#end('CLUSTER_WORKER_LEASE_EXPIRED');
  return frozen({state:this.#state,generation:this.#generation,retainedSessions:this.#sessions.size,remainingMs:this.#state==='active'?Math.max(0,this.#deadline-at):0});
 }
 close(){return this.#end('CLUSTER_WORKER_CLOSED');}
}
