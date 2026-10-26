import {createHash,randomUUID} from 'node:crypto';

export class SessionApiError extends Error {
 constructor(code,message,status=400){super(message);this.name='SessionApiError';this.code=code;this.status=status;}
}
const refuse=(code,message,status)=>{throw new SessionApiError(code,message,status);};
const clone=value=>structuredClone(value);
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const tenantKey=value=>{
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))refuse('INVALID_TENANT','Invalid tenant identity');
 return value;
};
function normalize(input,regions,defaultRegion,defaultTtl,maxTtl){
 if(!input||Object.getPrototypeOf(input)!==Object.prototype)refuse('INVALID_REQUEST','Expected a plain request object');
 const keys=Reflect.ownKeys(input);
 if(keys.length>3||keys.some(key=>typeof key!=='string'||!['url','region','ttlSeconds'].includes(key)))refuse('INVALID_REQUEST','Unknown request field');
 const descriptors=Object.getOwnPropertyDescriptors(input);
 if(keys.some(key=>!Object.hasOwn(descriptors[key],'value')))refuse('INVALID_REQUEST','Unknown or non-data request field');
 const url=descriptors.url?.value===undefined?'about:blank':descriptors.url.value,region=descriptors.region?.value??defaultRegion;
 if(typeof url!=='string'||url.length>8192)refuse('INVALID_URL','Expected an HTTP(S) page URL or exact about:blank');
 let parsed;try{parsed=new URL(url);}catch{refuse('INVALID_URL','Expected an HTTP(S) page URL');}
 if(url!=='about:blank'&&(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password))refuse('INVALID_URL','Expected an HTTP(S) page URL without embedded credentials or exact about:blank');
 if(typeof region!=='string'||!regions.has(region))refuse('UNSUPPORTED_REGION','Requested region is unavailable');
 const ttlSeconds=descriptors.ttlSeconds?.value??defaultTtl;
 if(!integer(ttlSeconds,1,maxTtl))refuse('INVALID_TTL','TTL is outside the configured range');
 return {url:parsed.href,region,ttlSeconds};
}

// Internal service core. Providers own resources by Session ID before async
// initialization; close() must attest {status:'closed'}. TTL begins when ready.
// An optional trusted synchronous ledger makes accepted intents durable. Prior
// active records are quarantined on recovery; create() is never replayed.
// HTTP/authentication/Native integration remain separate K1 requirements.
export class SessionRegistry {
 #providers;#defaultRegion;#tenantQuota;#globalQuota;#maxRecords;
 #sessions=new Map();#operations=new Map();#keys=new Map();#reserved=new Map();#active=0;
 #owned=new Set();#clock;#defaultTtl;#maxTtl;#maxCloseAttempts;
 #timer=null;#scheduleQueued=false;#stopping=false;#shutdownPromise;
 #store;#storeOwner=Symbol('session-registry');#storageError=false;#writing=false;#initializing=true;#detached=false;#storeRevision=0;#sessionIdFactory;
 #tasks=new Set();#recovered=new Set();#recoveryPromise=null;#providerSubscriptions=[];
 constructor({providers,defaultRegion,tenantQuota=4,globalQuota=16,maxRecords=10000,
  defaultTtlSeconds=900,maxTtlSeconds=86400,maxCloseAttempts=4,clock,store=null,sessionIdFactory=()=> 'ses_'+randomUUID()}={}){
  if(!(providers instanceof Map)||!providers.size||!providers.has(defaultRegion))throw new TypeError('Configure explicit region providers and a default region');
  for(const [region,provider] of providers){
   if(typeof region!=='string'||!region.length||region.length>64||typeof provider?.create!=='function'||typeof provider?.close!=='function')throw new TypeError('Invalid region provider');
  }
  if(!integer(tenantQuota,1,10000)||!integer(globalQuota,1,10000)||tenantQuota>globalQuota||!integer(maxRecords,1,100000))throw new TypeError('Invalid registry bounds');
  if(!integer(maxTtlSeconds,1,86400)||!integer(defaultTtlSeconds,1,maxTtlSeconds)||!integer(maxCloseAttempts,1,16))throw new TypeError('Invalid lifecycle bounds');
  this.#clock=clock??{now:()=>performance.now(),wallNow:()=>Date.now(),setTimer:(fn,ms)=>setTimeout(fn,ms),clearTimer:handle=>clearTimeout(handle)};
  for(const key of ['now','wallNow','setTimer','clearTimer'])if(typeof this.#clock[key]!=='function')throw new TypeError('Invalid lifecycle clock');
  if(!Number.isFinite(this.#clock.now())||!Number.isFinite(this.#clock.wallNow()))throw new TypeError('Invalid lifecycle clock values');
  if(typeof sessionIdFactory!=='function')throw new TypeError('Expected a trusted synchronous Session identity factory');this.#sessionIdFactory=sessionIdFactory;
  this.#providers=new Map(providers);this.#defaultRegion=defaultRegion;this.#tenantQuota=tenantQuota;this.#globalQuota=globalQuota;this.#maxRecords=maxRecords;
  this.#defaultTtl=defaultTtlSeconds;this.#maxTtl=maxTtlSeconds;this.#maxCloseAttempts=maxCloseAttempts;
  this.#store=store;
  if(store!==null){
   for(const key of ['load','commit','claimRegistry','releaseRegistry'])if(typeof store[key]!=='function')throw new TypeError('Expected a validated synchronous Session ledger');
   let claimed=false;
   try{const claim=store.claimRegistry(this.#storeOwner);claimed=true;if(claim&&typeof claim.then==='function'){void Promise.resolve(claim).catch(()=>{});throw new TypeError('Asynchronous ledger is unsupported');}const snapshot=store.load({owner:this.#storeOwner});if(snapshot&&typeof snapshot.then==='function'){void Promise.resolve(snapshot).catch(()=>{});throw new TypeError('Asynchronous ledger is unsupported');}this.#hydrate(snapshot);}
   catch{if(claimed)store.releaseRegistry(this.#storeOwner);this.#stopping=true;refuse('REGISTRY_STORAGE_UNAVAILABLE','Session state could not be loaded or fenced',503);}
  }
  try{
   for(const [region,provider]of this.#providers)if(provider.subscribeUnavailable!==undefined){
    if(typeof provider.subscribeUnavailable!=='function')throw new TypeError('Invalid provider subscription');
    const unsubscribe=provider.subscribeUnavailable(event=>this.#providerUnavailable(region,event));
    if(typeof unsubscribe!=='function'){if(unsubscribe?.then)void Promise.resolve(unsubscribe).catch(()=>{});throw new TypeError('Provider must return an unsubscribe function');}
    this.#providerSubscriptions.push(unsubscribe);
   }
  }catch{
   this.#unsubscribeProviders();this.#stopping=true;this.#detached=true;
   if(this.#store!==null)this.#store.releaseRegistry(this.#storeOwner);
   refuse('REGISTRY_PROVIDER_UNAVAILABLE','Provider event subscription could not be established',503);
  }
  this.#initializing=false;
 }
 #unsubscribeProviders(){for(const unsubscribe of this.#providerSubscriptions.splice(0)){try{unsubscribe();}catch{}}}
 #providerUnavailable(region,event){
  if(this.#initializing||this.#stopping||this.#detached||!event||event.region!==region)return;
  const row=this.#sessions.get(event.sessionId);
  if(!row||row.tenant!==event.tenantId||row.region!==region||!row.reserved)return;
  try{this.#beginRelease(row,'worker-unavailable');}catch{
   row.closeRequested=true;row.closeReason??='worker-unavailable';row.deadline=null;row.state='cleanup-failed';
   this.#persist([row]);row.controller.abort(row.closeReason);this.#schedule();
  }
 }
 #guard(){
  if(this.#detached)refuse('REGISTRY_CLOSED','Registry has released its ledger ownership',503);
  if(this.#storageError)refuse('REGISTRY_STORAGE_UNAVAILABLE','Session state confirmation is unavailable',503);
  if(this.#writing)refuse('REGISTRY_WRITE_IN_PROGRESS','Session state is being committed',503);
 }
 #track(promise){this.#tasks.add(promise);void promise.then(()=>this.#tasks.delete(promise),()=>this.#tasks.delete(promise));return promise;}
 #record(row){
  const {sessionId,tenant,region,state,createdAt,version,reserved,operationId,ttlSeconds,readyAt,expiresAt,closeReason,closeAttempts}=row;
  return {sessionId,tenant,region,state,createdAt,version,reserved,operationId,ttlSeconds,readyAt,expiresAt,closeReason,closeAttempts,releaseOperationId:row.releaseOperation?.operationId??null};
 }
 #fault(){
  if(this.#storageError)return;this.#storageError=true;
  if(this.#timer!==null){this.#clock.clearTimer(this.#timer);this.#timer=null;}
  if(!this.#initializing)queueMicrotask(()=>{for(const row of this.#owned){try{this.#beginRelease(row,'registry-storage-fault');}catch{}}});
 }
 #persist(rows=[],operations=[],bindings=[]){
  if(this.#store===null)return true;
  if(this.#storageError||this.#detached)return false;
  this.#writing=true;
  try{
   const value=this.#store.commit({sessions:rows.map(row=>this.#record(row)),operations:operations.map(operation=>({tenant:this.#sessions.get(operation.sessionId).tenant,operation:clone(operation)})),bindings:clone(bindings)},{owner:this.#storeOwner});
   if(value&&typeof value.then==='function'){void Promise.resolve(value).catch(()=>{});throw new TypeError('Asynchronous ledger is unsupported');}
   if(!value||value.revision!==this.#storeRevision+1||!Number.isSafeInteger(value.revision))throw new TypeError('Ledger did not acknowledge the expected commit');
   this.#storeRevision=value.revision;return true;
  }catch{this.#fault();return false;}finally{this.#writing=false;}
 }
 #hydrate(snapshot){
  if(!snapshot||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||!Array.isArray(snapshot.sessions)||!Array.isArray(snapshot.operations)||!Array.isArray(snapshot.bindings)||snapshot.sessions.length>this.#maxRecords||snapshot.operations.length>this.#maxRecords*18||snapshot.bindings.length>this.#maxRecords)throw new TypeError('Invalid or over-capacity ledger snapshot');
  this.#storeRevision=snapshot.revision;
  for(const row of snapshot.operations)this.#operations.set(row.operation.operationId,clone(row));
  for(const binding of snapshot.bindings)this.#keys.set(binding.tenant+'\0'+binding.keyHash,clone(binding));
  const recovered=[];
  for(const value of snapshot.sessions){
   const row={...clone(value),deadline:null,closeInFlight:null,releaseOperation:value.releaseOperationId===null?null:this.#operations.get(value.releaseOperationId)?.operation,releaseDone:null,startDone:Promise.resolve(),resolveStart:null,controller:new AbortController(),closeRequested:value.reserved,recovered:value.reserved};
   delete row.releaseOperationId;
   if(value.reserved){row.state='recovery-required';this.#owned.add(row);this.#recovered.add(row);recovered.push(row);this.#active++;this.#reserved.set(row.tenant,(this.#reserved.get(row.tenant)??0)+1);}
   this.#sessions.set(row.sessionId,row);
  }
  for(let n=0;n<recovered.length;n+=500)if(!this.#persist(recovered.slice(n,n+500)))throw new Error('Recovery fencing could not be committed');
 }
 persistence(){return {mode:this.#store===null?'memory':'durable',confirmation:this.#detached?'detached':this.#storageError?'unavailable':'confirmed',recoveryRequired:[...this.#recovered].filter(row=>row.reserved).length};}

 #stamp(){return new Date(this.#clock.wallNow()).toISOString();}
 #row(tenant,sessionId){
  tenant=tenantKey(tenant);const row=this.#sessions.get(sessionId);
  if(!row||row.tenant!==tenant)refuse('SESSION_NOT_FOUND','Session not found',404);
  return row;
 }
 create(tenant,input,{idempotencyKey}={}){
  this.#guard();tenant=tenantKey(tenant);
  if(typeof idempotencyKey!=='string'||!/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))refuse('INVALID_IDEMPOTENCY_KEY','Expected a bounded printable idempotency key');
  const keyHash=createHash('sha256').update(idempotencyKey).digest('hex'),key=tenant+'\0'+keyHash,prior=this.#keys.get(key);
  const request=normalize(input,prior?{has:value=>typeof value==='string'&&value.length>0&&value.length<=64}:this.#providers,prior?.defaults.region??this.#defaultRegion,prior?.defaults.ttlSeconds??this.#defaultTtl,prior?86400:this.#maxTtl),fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  if(prior){if(prior.fingerprint!==fingerprint)refuse('IDEMPOTENCY_CONFLICT','Idempotency key is already bound to another request',409);return this.getOperation(tenant,prior.operationId);}
  if(this.#stopping)refuse('REGISTRY_CLOSED','Registry is shutting down',503);
  if(this.#sessions.size>=this.#maxRecords)refuse('REGISTRY_CAPACITY','Operation retention capacity reached',503);
  if(this.#active>=this.#globalQuota||(this.#reserved.get(tenant)??0)>=this.#tenantQuota)refuse('SESSION_QUOTA','Concurrent Session quota reached',429);
  let sessionId;try{sessionId=this.#sessionIdFactory(Object.freeze({tenantId:tenant,request:Object.freeze(clone(request)),idempotencyKey}));}catch{refuse('SESSION_ID_UNAVAILABLE','Session identity could not be reserved',503);}
  if(sessionId?.then)void Promise.resolve(sessionId).catch(()=>{});
  if(typeof sessionId!=='string'||!/^ses_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId)||this.#sessions.has(sessionId))refuse('SESSION_ID_UNAVAILABLE','Session identity could not be reserved',503);
  const operationId='op_'+randomUUID(),at=this.#stamp();
  let resolveStart;const startDone=new Promise(resolve=>{resolveStart=resolve;});
  const session={sessionId,tenant,region:request.region,state:'creating',createdAt:at,version:null,reserved:true,operationId,
   ttlSeconds:request.ttlSeconds,readyAt:null,expiresAt:null,deadline:null,closeReason:null,closeRequested:false,
   closeAttempts:0,closeInFlight:null,releaseOperation:null,releaseDone:null,startDone,resolveStart,controller:new AbortController()};
  const operation={operationId,sessionId,kind:'create-session',status:'pending',createdAt:at,updatedAt:at,error:null};
  this.#sessions.set(sessionId,session);this.#operations.set(operationId,{tenant,operation});this.#keys.set(key,{tenant,keyHash,fingerprint,operationId,defaults:{region:request.region,ttlSeconds:request.ttlSeconds}});this.#active++;this.#owned.add(session);this.#reserved.set(tenant,(this.#reserved.get(tenant)??0)+1);
  // Acknowledged write-ahead intent precedes every provider effect.
  if(!this.#persist([session],[operation],[this.#keys.get(key)])){
   this.#unreserve(session);this.#sessions.delete(sessionId);this.#operations.delete(operationId);this.#keys.delete(key);resolveStart();session.resolveStart=null;this.#guard();
  }
  this.#track(startDone);
  void this.#start(session,operation,request);
  return this.getOperation(tenant,operationId);
 }
 #unreserve(session){
  if(!session.reserved)return;
  session.reserved=false;this.#active--;this.#owned.delete(session);const left=this.#reserved.get(session.tenant)-1;if(left)this.#reserved.set(session.tenant,left);else this.#reserved.delete(session.tenant);
 }
 #closeSource(session){
  if(!session.reserved)return Promise.resolve(true);
  if(session.closeInFlight)return session.closeInFlight;
  if(session.closeAttempts>=this.#maxCloseAttempts)return Promise.resolve(false);
  session.closeAttempts++;this.#persist([session]);
  const provider=this.#providers.get(session.region);
  // Assign the shared promise before invoking a potentially reentrant provider.
  session.closeInFlight=Promise.resolve().then(async()=>{
   try{
    const close=session.closeAttempts>1&&typeof provider.retryClose==='function'?provider.retryClose:provider.close;
    const closed=(await close.call(provider,{sessionId:session.sessionId,tenantId:session.tenant,region:session.region,reason:session.closeReason??'startup-failed'}))?.status==='closed';
    if(closed)this.#unreserve(session);
    return closed;
   }catch{return false;}
  }).finally(()=>{session.closeInFlight=null;this.#schedule();});
  return session.closeInFlight;
 }
 async #start(session,operation,request){
  const provider=this.#providers.get(session.region);
  try{
   const result=await provider.create({sessionId:session.sessionId,tenantId:session.tenant,...clone(request),signal:session.controller.signal});
   const version=result&&typeof result==='object'?Object.getOwnPropertyDescriptor(result,'version')?.value:undefined;
   if(typeof version!=='string'||!version.length||version.length>256)throw new TypeError('Provider did not supply a data version');
   if(session.closeRequested){operation.status='failed';operation.error={code:'SESSION_CREATE_CANCELLED',message:'Session creation was cancelled'};}
   else{
    session.version=version;session.state='ready';session.readyAt=this.#stamp();
    session.expiresAt=new Date(this.#clock.wallNow()+session.ttlSeconds*1000).toISOString();session.deadline=this.#clock.now()+session.ttlSeconds*1000;operation.status='succeeded';this.#schedule();
   }
  }catch{
   if(session.closeRequested){operation.status='failed';operation.error={code:'SESSION_CREATE_CANCELLED',message:'Session creation was cancelled'};}
   else{
    const closed=await this.#closeSource(session);
    if(!session.closeRequested)session.state=closed?'failed':'cleanup-failed';
    operation.status='failed';operation.error={code:closed?'SESSION_START_FAILED':'SESSION_CLEANUP_INCOMPLETE',message:closed?'Session startup failed':'Session startup failed and resource cleanup is unconfirmed'};
   }
  }finally{
   operation.updatedAt=this.#stamp();this.#persist([session],[operation]);session.resolveStart();session.resolveStart=null;
  }
 }
 #schedule(){
  if(this.#scheduleQueued)return;this.#scheduleQueued=true;
  queueMicrotask(()=>{
   this.#scheduleQueued=false;
   if(this.#timer!==null){this.#clock.clearTimer(this.#timer);this.#timer=null;}
   if(this.#stopping||this.#storageError)return;
   let deadline=Infinity;
   for(const row of this.#owned)if(row.state==='ready'&&row.deadline!==null)deadline=Math.min(deadline,row.deadline);
   if(!Number.isFinite(deadline))return;
   this.#timer=this.#clock.setTimer(()=>{
    this.#timer=null;
    for(const row of this.#owned)this.#expire(row);
    this.#schedule();
   },Math.max(0,deadline-this.#clock.now()));
   this.#timer?.unref?.();
  });
 }
 #expire(session){
  if(session.state==='ready'&&session.deadline!==null&&this.#clock.now()>=session.deadline)this.#beginRelease(session,'ttl-expired');
 }
 #beginRelease(session,reason){
  if(session.releaseOperation?.status==='succeeded'||session.releaseOperation?.status==='pending'&&session.releaseDone!==null)return session.releaseOperation;
  if(session.reserved&&session.closeAttempts>=this.#maxCloseAttempts)refuse('SESSION_CLEANUP_LIMIT','Cleanup attempt limit reached; resource ownership remains reserved',503);
  const at=this.#stamp(),operation=session.releaseOperation?.status==='pending'?session.releaseOperation:{operationId:'op_'+randomUUID(),sessionId:session.sessionId,kind:'release-session',status:'pending',createdAt:at,updatedAt:at,error:null};
  session.releaseOperation=operation;session.closeRequested=true;session.closeReason??=reason;session.deadline=null;session.state='closing';
  this.#operations.set(operation.operationId,{tenant:session.tenant,operation});
  const changed=[operation],creation=this.#operations.get(session.operationId).operation;
  if(session.recovered&&creation.status==='pending'){creation.status='failed';creation.error={code:'SESSION_CREATION_UNCONFIRMED',message:'Creation availability could not be confirmed after restart; it was not replayed'};creation.updatedAt=at;changed.push(creation);}
  let resolveRelease;session.releaseDone=this.#track(new Promise(resolve=>{resolveRelease=resolve;}));
  this.#persist([session],changed);
  // Install the completion fence before abort listeners can reenter shutdown.
  session.controller.abort(session.closeReason);this.#schedule();
  void this.#finishRelease(session,operation).then(resolveRelease);
  return operation;
 }
 async #finishRelease(session,operation){
  await session.startDone;
  const closed=await this.#closeSource(session);
  session.state=closed?(session.closeReason==='ttl-expired'?'expired':'closed'):'cleanup-failed';
  operation.status=closed?'succeeded':'failed';operation.error=closed?null:{code:'SESSION_CLEANUP_INCOMPLETE',message:'Session resource cleanup is unconfirmed'};operation.updatedAt=this.#stamp();this.#persist([session],[operation]);
 }
 release(tenant,sessionId){
  this.#guard();const session=this.#row(tenant,sessionId);this.#expire(session);
  if(this.#stopping&&session.releaseOperation?.status!=='pending'&&session.releaseOperation?.status!=='succeeded')refuse('REGISTRY_CLOSED','Registry is shutting down',503);
  const result=clone(this.#beginRelease(session,'released'));this.#guard();return result;
 }
 getOperation(tenant,operationId){
  this.#guard();tenant=tenantKey(tenant);const row=this.#operations.get(operationId);
  if(!row||row.tenant!==tenant)refuse('OPERATION_NOT_FOUND','Operation not found',404);
  return clone(row.operation);
 }
 getSession(tenant,sessionId){
  this.#guard();const row=this.#row(tenant,sessionId);this.#expire(row);this.#guard();
  const {sessionId:id,region,state,createdAt,version,ttlSeconds,readyAt,expiresAt,closeReason,reserved}=row;
  return {sessionId:id,region,state,createdAt,version,ttlSeconds,readyAt,expiresAt,closeReason,holdsQuota:reserved};
 }
 requireReady(tenant,sessionId){
  const session=this.getSession(tenant,sessionId);
  if(session.closeReason==='ttl-expired')refuse('SESSION_EXPIRED','Session has expired',410);
  if(session.state!=='ready')refuse('SESSION_NOT_READY','Session is not available',409);
  return session;
 }
 recover(){
  this.#guard();if(this.#stopping)refuse('REGISTRY_CLOSED','Registry is shutting down',503);
  if(this.#recoveryPromise)return this.#recoveryPromise;
  let resolve;const pending=this.#recoveryPromise=new Promise(done=>{resolve=done;}),waits=[];
  for(const row of this.#recovered)if(row.reserved){try{this.#beginRelease(row,'registry-recovery');waits.push(row.releaseDone);}catch{}}
  void Promise.all(waits).then(()=>{const remainingSessions=[...this.#recovered].filter(row=>row.reserved).map(row=>row.sessionId);this.#recoveryPromise=null;resolve({status:remainingSessions.length?'cleanup-incomplete':'closed',remainingSessions});});
  return pending;
 }
 shutdown(){
  if(this.#shutdownPromise)return this.#shutdownPromise;
  let resolveShutdown;this.#shutdownPromise=new Promise(resolve=>{resolveShutdown=resolve;});
  this.#stopping=true;this.#unsubscribeProviders();
  if(this.#timer!==null){this.#clock.clearTimer(this.#timer);this.#timer=null;}
  for(const row of this.#owned){try{this.#beginRelease(row,'registry-shutdown');}catch{}}
  void (async()=>{
   await Promise.resolve();while(this.#tasks.size)await Promise.all([...this.#tasks]);
   const result={status:this.#active?'cleanup-incomplete':'closed',remainingSessions:[...this.#owned].map(row=>row.sessionId)};
   if(this.#store!==null){result.persistence=this.#storageError?'unconfirmed':'confirmed';this.#store.releaseRegistry(this.#storeOwner);this.#detached=true;}
   resolveShutdown(result);
  })();
  return this.#shutdownPromise;
 }
 stats(){return {records:this.#sessions.size,operations:this.#operations.size,idempotencyBindings:this.#keys.size,reservedSessions:this.#active,maxRecords:this.#maxRecords,globalQuota:this.#globalQuota};}
}
