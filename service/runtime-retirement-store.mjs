import {mkdirSync,lstatSync,openSync,fstatSync,writeFileSync,readSync,fsyncSync,closeSync,linkSync,unlinkSync,constants} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {dockerRuntimeCreateBody,verifyDockerRuntime} from './docker-runtime-spec.mjs';
import {RuntimeWitnessStore} from './runtime-witness-store.mjs';
import {validateLinuxRuntimeWitness,runtimeWitnessSha256} from './linux-runtime-witness.mjs';
export const RUNTIME_RETIREMENT_MAX_BYTES=16384;
export class RuntimeRetirementStoreError extends Error {constructor(code){super('Persisted runtime retirement evidence is unavailable');this.name='RuntimeRetirementStoreError';this.code=code;}}
const fail=code=>new RuntimeRetirementStoreError(code),hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),sha=v=>createHash('sha256').update(v).digest('hex');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const stable=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x),same=(a,b)=>stable(a)===stable(b);
const frozen=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))frozen(x);Object.freeze(v);}return v;};
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const started=v=>typeof v==='string'&&/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(v)&&Number.isFinite(Date.parse(v));
const keys=['sessionId','tenantId','region','deploymentId','daemonId','containerId','specDigest','imageId','ownerKeyHash','projectManifestSha256','browserManifestSha256','containerName'];
const allocationKeys=['sessionId','tenant','region','deploymentId','daemonId','ownerKeyHash','specDigest','imageId','containerName','containerId','state','requestStarted','version','closeReason','retirement','createdAt','updatedAt'];
const reasons=['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault','startup-failed','startup-cancelled','worker-unavailable'];
function identity(plan,containerId){dockerRuntimeCreateBody(plan);if(containerId!==null&&!hash(containerId))throw fail('RETIREMENT_BINDING');return Object.fromEntries(keys.map(k=>[k,k==='containerId'?containerId:plan[k]]));}
function closingReceipt(plan,receipt,requested){
 const row=receipt?.allocation;if(!Number.isSafeInteger(receipt?.revision)||receipt.revision<1||!exact(row,allocationKeys)||row.state!=='closing'||row.requestStarted!==requested||row.retirement!==null||!reasons.includes(row.closeReason)||!date(row.createdAt)||!date(row.updatedAt)||row.updatedAt<row.createdAt||!(row.version===null||typeof row.version==='string'&&row.version.length>0&&row.version.length<=256))throw fail('RETIREMENT_JOURNAL');
 const binding=identity(plan,row.containerId);if(requested?!hash(row.containerId):row.containerId!==null||row.version!==null)throw fail('RETIREMENT_JOURNAL');
 for(const [key,value]of Object.entries({...binding,tenant:binding.tenantId})){if(key==='tenantId'||key==='projectManifestSha256'||key==='browserManifestSha256')continue;if(row[key]!==value)throw fail('RETIREMENT_JOURNAL');}
 return {binding,revision:receipt.revision,allocationSha256:sha(stable(row))};
}
const proofKeys=['kind','origin','journalRevision','allocationSha256','startDispatched','beforeRemoval','removal','absence','namespace'];
function validateNamespace(value,binding,before){
 if(!exact(value,['record','receipt'])||!exact(value.record,['schema','identity','witness','witnessSha256'])||!exact(value.receipt,['sessionId','containerId','daemonId','specDigest','witnessSha256','evidenceSha256']))throw fail('RETIREMENT_NAMESPACE');
 const expected=Object.fromEntries(keys.filter(k=>k!=='containerName').map(k=>[k,binding[k]]));expected.engineStartedAt=before.startedAt;
 if(value.record.schema!=='session-runtime-witness-v1'||!started(before.startedAt)||!same(value.record.identity,expected))throw fail('RETIREMENT_NAMESPACE');
 validateLinuxRuntimeWitness(value.record.witness);const digest=runtimeWitnessSha256(value.record.witness);if(value.record.witnessSha256!==digest||value.receipt.witnessSha256!==digest||!hash(value.receipt.evidenceSha256))throw fail('RETIREMENT_NAMESPACE');
 for(const key of ['sessionId','containerId','daemonId','specDigest'])if(value.receipt[key]!==binding[key])throw fail('RETIREMENT_NAMESPACE');
}
function validateProof(proof,binding){
 if(!exact(proof,proofKeys)||!Number.isSafeInteger(proof.journalRevision)||proof.journalRevision<1||!hash(proof.allocationSha256))throw fail('RETIREMENT_FORMAT');
 if(proof.kind==='not-dispatched'){
  if(binding.containerId!==null||proof.origin!=='not-dispatched'||proof.startDispatched!==false||[proof.beforeRemoval,proof.removal,proof.absence,proof.namespace].some(v=>v!==null))throw fail('RETIREMENT_FORMAT');return;
 }
 if(proof.kind!=='container-removed'||!hash(binding.containerId)||!exact(proof.beforeRemoval,['status','running','pid','startedAt','inspectionSha256'])||!exact(proof.removal,['kind','containerId','daemonId','connectionId','httpStatus','authorizationRevision','effectAttempted','alreadyAbsent'])||!exact(proof.absence,['found','daemonId','selector']))throw fail('RETIREMENT_FORMAT');
 const before=proof.beforeRemoval,remove=proof.removal,absent=proof.absence;
 if(!['created','running','exited','dead'].includes(before.status)||typeof before.running!=='boolean'||!Number.isSafeInteger(before.pid)||before.pid<0||before.pid>2147483647||before.running!==(before.status==='running')||before.running&&before.pid===0||!before.running&&before.pid!==0||!hash(before.inspectionSha256)||remove.kind!=='remove'||remove.containerId!==binding.containerId||remove.daemonId!==binding.daemonId||typeof remove.connectionId!=='string'||!/^[a-f0-9-]{36}$/.test(remove.connectionId)||remove.httpStatus!==204||remove.authorizationRevision!==proof.journalRevision||remove.effectAttempted!==true||remove.alreadyAbsent!==false||absent.found!==false||absent.daemonId!==binding.daemonId||absent.selector!==binding.containerId)throw fail('RETIREMENT_REMOVAL');
 if(proof.origin==='unstarted'){
  if(proof.startDispatched!==false||before.status!=='created'||before.running||before.pid!==0||before.startedAt!=='0001-01-01T00:00:00Z'||proof.namespace!==null)throw fail('RETIREMENT_UNSTARTED');
 }else if(proof.origin==='namespace'){
  if(proof.startDispatched!==null&&proof.startDispatched!==true)throw fail('RETIREMENT_NAMESPACE');validateNamespace(proof.namespace,binding,before);
 }else throw fail('RETIREMENT_FORMAT');
}
const fingerprint=s=>[s.dev,s.ino,s.size,s.mode,s.uid,s.mtimeMs,s.ctimeMs];
// Internal persistence boundary. The controller must establish the actual
// Engine observations, exclusive dispatch fence and retirement conclusion.
// A record or its hash cannot establish those facts by itself.
export class RuntimeRetirementStore {
 #directory;#directoryIdentity;#witnessStore;
 constructor({directory,witnessStore=null}={}){
  if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>2048||/[\x00-\x1f\x7f]/.test(directory)||witnessStore!==null&&!(witnessStore instanceof RuntimeWitnessStore))throw new TypeError('Configure a private absolute retirement directory and witness store');
  let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw fail('RETIREMENT_DIRECTORY');}this.#directory=directory;this.#witnessStore=witnessStore;
  try{const s=lstatSync(directory);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o777)!==0o700||typeof process.getuid==='function'&&s.uid!==process.getuid())throw fail('RETIREMENT_DIRECTORY');this.#directoryIdentity=[s.dev,s.ino];this.#sync();if(created){let fd;try{fd=openSync(dirname(directory),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(fd);}finally{if(fd!==undefined)closeSync(fd);}}}catch{throw fail('RETIREMENT_DIRECTORY');}Object.freeze(this);
 }
 #check(s){if(!s.isDirectory()||s.isSymbolicLink?.()||(s.mode&0o777)!==0o700||typeof process.getuid==='function'&&s.uid!==process.getuid()||!same([s.dev,s.ino],this.#directoryIdentity))throw fail('RETIREMENT_DIRECTORY');}
 #sync(){let fd;try{this.#check(lstatSync(this.#directory));fd=openSync(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);this.#check(fstatSync(fd));fsyncSync(fd);this.#check(lstatSync(this.#directory));}finally{if(fd!==undefined)closeSync(fd);}}
 #path(binding){return join(this.#directory,binding.sessionId+'-'+(binding.containerId??'not-dispatched')+'.retirement.json');}
 #receipt(record,digest){return Object.freeze({sessionId:record.identity.sessionId,containerId:record.identity.containerId,daemonId:record.identity.daemonId,specDigest:record.identity.specDigest,kind:record.proof.kind,evidenceSha256:digest});}
 #publish(binding,proof){
  validateProof(proof,binding);const record={schema:'session-runtime-retirement-v1',at:new Date().toISOString(),identity:binding,proof,proofSha256:sha(stable(proof))},bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>RUNTIME_RETIREMENT_MAX_BYTES)throw fail('RETIREMENT_LIMIT');const temp=join(this.#directory,'.pending-'+randomUUID());let fd;
  try{this.#sync();fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o777)!==0o600||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('RETIREMENT_FILE');writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;this.#sync();linkSync(temp,this.#path(binding));this.#sync();unlinkSync(temp);this.#sync();return this.#receipt(record,sha(bytes));}
  catch(e){throw e instanceof RuntimeRetirementStoreError?e:fail(e.code==='EEXIST'?'RETIREMENT_EXISTS':'RETIREMENT_WRITE');}finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 persistNotDispatched({plan,closing}={}){
  const value=closingReceipt(plan,closing,false);return this.#publish(value.binding,{kind:'not-dispatched',origin:'not-dispatched',journalRevision:value.revision,allocationSha256:value.allocationSha256,startDispatched:false,beforeRemoval:null,removal:null,absence:null,namespace:null});
 }
 persistRemoved({plan,closing,inspection,removal,absence,startDispatched=null}={}){
  const value=closingReceipt(plan,closing,true),runtime=verifyDockerRuntime(plan,inspection,{containerId:value.binding.containerId});if(![null,true,false].includes(startDispatched))throw fail('RETIREMENT_FORMAT');const state=inspection.document.State;
  const beforeRemoval={status:runtime.state,running:runtime.running,pid:runtime.pid,startedAt:state.StartedAt,inspectionSha256:sha(stable(inspection))},origin=startDispatched===false?'unstarted':'namespace';
  // false is usable only by a current controller that has fenced every Start
  // dispatch; an unknown recovered Start must use the namespace branch.
  const namespace=origin==='namespace'?this.#witnessStore?.read({plan,inspection}):null;if(origin==='namespace'&&!namespace)throw fail('RETIREMENT_NAMESPACE');
  const remove=removal&&Object.fromEntries(['kind','containerId','daemonId','connectionId','httpStatus','authorizationRevision','effectAttempted','alreadyAbsent'].map(k=>[k,removal[k]]));
  return this.#publish(value.binding,{kind:'container-removed',origin,journalRevision:value.revision,allocationSha256:value.allocationSha256,startDispatched,beforeRemoval,removal:remove,absence:{found:absence?.found,daemonId:absence?.daemon?.id,selector:absence?.selector},namespace});
 }
 read({plan,containerId=null,expectedSha256=null}={}){
  const binding=identity(plan,containerId);if(expectedSha256!==null&&!hash(expectedSha256))throw fail('RETIREMENT_DIGEST');const bytes=Buffer.alloc(RUNTIME_RETIREMENT_MAX_BYTES+1);let fd;
  try{this.#sync();fd=openSync(this.#path(binding),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd);if(!before.isFile()||(before.mode&0o777)!==0o600||before.size<1||before.size>RUNTIME_RETIREMENT_MAX_BYTES||typeof process.getuid==='function'&&before.uid!==process.getuid())throw fail('RETIREMENT_FILE');let used=0;
   while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}if(used!==before.size||!same(fingerprint(before),fingerprint(fstatSync(fd))))throw fail('RETIREMENT_CHANGED');const digest=sha(bytes.subarray(0,used));if(expectedSha256!==null&&digest!==expectedSha256)throw fail('RETIREMENT_DIGEST');
   const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));if(!exact(record,['schema','at','identity','proof','proofSha256'])||record.schema!=='session-runtime-retirement-v1'||!date(record.at)||!same(record.identity,binding))throw fail('RETIREMENT_BINDING');validateProof(record.proof,binding);if(record.proofSha256!==sha(stable(record.proof)))throw fail('RETIREMENT_DIGEST');this.#sync();return Object.freeze({record:frozen(record),receipt:this.#receipt(record,digest)});
  }catch(e){throw e instanceof RuntimeRetirementStoreError?e:fail(e.code==='ENOENT'?'RETIREMENT_MISSING':'RETIREMENT_READ');}finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);}
 }
}
