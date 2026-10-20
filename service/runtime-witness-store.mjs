import {mkdirSync,lstatSync,openSync,fstatSync,writeFileSync,readSync,fsyncSync,closeSync,linkSync,unlinkSync,constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateLinuxRuntimeWitness,runtimeWitnessSha256} from './linux-runtime-witness.mjs';
import {copyRuntimeWitnessBinding} from './runtime-witness-binding.mjs';
import {verifyDockerRuntime,dockerRuntimeCreateBody} from './docker-runtime-spec.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
export const RUNTIME_WITNESS_MAX_BYTES=8192;
const started=value=>typeof value==='string'&&/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
export class RuntimeWitnessStoreError extends Error {constructor(code){super('Persisted runtime witness is unavailable');this.name='RuntimeWitnessStoreError';this.code=code;}}
const fail=code=>new RuntimeWitnessStoreError(code);
function baseIdentity(plan,containerId){dockerRuntimeCreateBody(plan);if(typeof containerId!=='string'||!/^[a-f0-9]{64}$/.test(containerId))throw fail('WITNESS_BINDING');return {sessionId:plan.sessionId,tenantId:plan.tenantId,region:plan.region,deploymentId:plan.deploymentId,daemonId:plan.daemonId,containerId,specDigest:plan.specDigest,imageId:plan.imageId,ownerKeyHash:plan.ownerKeyHash,projectManifestSha256:plan.projectManifestSha256,browserManifestSha256:plan.browserManifestSha256};}
function identity(plan,inspection){const runtime=verifyDockerRuntime(plan,inspection),engineStartedAt=inspection.document.State.StartedAt;if(!started(engineStartedAt))throw fail('WITNESS_BINDING');return {...baseIdentity(plan,runtime.containerId),engineStartedAt};}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class RuntimeWitnessStore {
 #directory;#directoryIdentity;
 constructor({directory}={}){
  if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>2048||/[\x00-\x1f\x7f]/.test(directory))throw new TypeError('Configure a private absolute witness directory');let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw fail('WITNESS_DIRECTORY');}
  let stat;try{stat=lstatSync(directory);}catch{throw fail('WITNESS_DIRECTORY');}if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('WITNESS_DIRECTORY');if(created){let parent;try{parent=openSync(dirname(directory),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(parent);}catch{throw fail('WITNESS_DIRECTORY');}finally{if(parent!==undefined)closeSync(parent);}}this.#directory=directory;this.#directoryIdentity=[stat.dev,stat.ino];try{this.#sync();}catch{throw fail('WITNESS_DIRECTORY');}Object.freeze(this);
 }
 #path(binding){return join(this.#directory,binding.sessionId+'-'+binding.containerId+'.namespace.json');}
 #check(s){if(!s.isDirectory()||s.isSymbolicLink?.()||(s.mode&0o777)!==0o700||typeof process.getuid==='function'&&s.uid!==process.getuid()||!equal([s.dev,s.ino],this.#directoryIdentity))throw fail('WITNESS_DIRECTORY');}
 #sync(){let fd;try{this.#check(lstatSync(this.#directory));fd=openSync(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);this.#check(fstatSync(fd));fsyncSync(fd);this.#check(lstatSync(this.#directory));}finally{if(fd!==undefined)closeSync(fd);}}
 persist({plan,inspection,witness}={}){
  const binding=identity(plan,inspection);if(inspection.document.State.Running!==true||inspection.document.State.Pid<=0)throw fail('WITNESS_NOT_RUNNING');const proof=validateLinuxRuntimeWitness(witness),witnessSha256=runtimeWitnessSha256(proof),record={schema:'session-runtime-witness-v1',identity:binding,witness:proof,witnessSha256};const bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>8192)throw fail('WITNESS_LIMIT');const path=this.#path(binding),temp=join(this.#directory,'.pending-'+randomUUID());let fd;
  try{this.#sync();fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o777)!==0o600||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('WITNESS_FILE');writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;this.#sync();linkSync(temp,path);this.#sync();unlinkSync(temp);this.#sync();return Object.freeze({sessionId:binding.sessionId,containerId:binding.containerId,daemonId:binding.daemonId,specDigest:binding.specDigest,witnessSha256,evidenceSha256:sha(bytes)});}
  catch(error){throw error instanceof RuntimeWitnessStoreError?error:fail(error.code==='EEXIST'?'WITNESS_EXISTS':'WITNESS_WRITE');}
  finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 // Inspection-bound reads remain mandatory for a live Start/Ready gate.
 read({plan,inspection}={}){return this.#read(identity(plan,inspection));}
 // A durable controller binding is required; the file cannot assert its own
 // expected generation/hash. This historical read never attests live Ready.
 readHistorical({plan,containerId,startWitness}={}){
  let saved;try{saved=copyRuntimeWitnessBinding(startWitness);}catch{throw fail('WITNESS_BINDING');}
  return this.#read({...baseIdentity(plan,containerId),engineStartedAt:saved.engineStartedAt},saved);
 }
 #read(expected,saved=null){
  const bytes=Buffer.alloc(RUNTIME_WITNESS_MAX_BYTES+1),path=this.#path(expected);let fd;
  const fingerprint=s=>[s.dev,s.ino,s.size,s.mode,s.uid,s.mtimeMs,s.ctimeMs];
  try{this.#sync();fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.size<1||stat.size>RUNTIME_WITNESS_MAX_BYTES||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('WITNESS_FILE');let used=0;
   while(used<bytes.length){const count=readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}if(used!==stat.size||!equal(fingerprint(stat),fingerprint(fstatSync(fd)))||!equal(fingerprint(stat),fingerprint(lstatSync(path))))throw fail('WITNESS_CHANGED');const digest=sha(bytes.subarray(0,used));if(saved&&saved.evidenceSha256!==digest)throw fail('WITNESS_DIGEST');
   const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));if(!plain(record,['schema','identity','witness','witnessSha256'])||record.schema!=='session-runtime-witness-v1'||!equal(record.identity,expected))throw fail('WITNESS_BINDING');const witness=validateLinuxRuntimeWitness(record.witness);if(runtimeWitnessSha256(witness)!==record.witnessSha256||saved&&saved.witnessSha256!==record.witnessSha256)throw fail('WITNESS_DIGEST');this.#sync();return Object.freeze({record:Object.freeze({...record,identity:Object.freeze({...record.identity}),witness}),receipt:Object.freeze({sessionId:expected.sessionId,containerId:expected.containerId,daemonId:expected.daemonId,specDigest:expected.specDigest,witnessSha256:record.witnessSha256,evidenceSha256:digest})});
  }catch(error){throw error instanceof RuntimeWitnessStoreError?error:fail(error.code==='ENOENT'?'WITNESS_MISSING':'WITNESS_READ');}finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);}
 }
}
