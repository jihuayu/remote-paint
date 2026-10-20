import {mkdirSync,lstatSync,openSync,fstatSync,writeFileSync,readSync,fsyncSync,closeSync,linkSync,unlinkSync,constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {validateLinuxRuntimeWitness,runtimeWitnessSha256} from './linux-runtime-witness.mjs';
import {verifyDockerRuntime,dockerRuntimeCreateBody} from './docker-runtime-spec.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const plain=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const started=value=>typeof value==='string'&&/^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
export class RuntimeWitnessStoreError extends Error {constructor(code){super('Persisted runtime witness is unavailable');this.name='RuntimeWitnessStoreError';this.code=code;}}
const fail=code=>new RuntimeWitnessStoreError(code);
function identity(plan,inspection){dockerRuntimeCreateBody(plan);const runtime=verifyDockerRuntime(plan,inspection);const engineStartedAt=inspection.document.State.StartedAt;if(!started(engineStartedAt))throw fail('WITNESS_BINDING');return {sessionId:plan.sessionId,tenantId:plan.tenantId,region:plan.region,deploymentId:plan.deploymentId,daemonId:plan.daemonId,containerId:runtime.containerId,specDigest:plan.specDigest,imageId:plan.imageId,ownerKeyHash:plan.ownerKeyHash,projectManifestSha256:plan.projectManifestSha256,browserManifestSha256:plan.browserManifestSha256,engineStartedAt};}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export class RuntimeWitnessStore {
 #directory;
 constructor({directory}={}){
  if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>2048||/[\x00-\x1f\x7f]/.test(directory))throw new TypeError('Configure a private absolute witness directory');let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw fail('WITNESS_DIRECTORY');}
  let stat;try{stat=lstatSync(directory);}catch{throw fail('WITNESS_DIRECTORY');}if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('WITNESS_DIRECTORY');if(created){let parent;try{parent=openSync(dirname(directory),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(parent);}catch{throw fail('WITNESS_DIRECTORY');}finally{if(parent!==undefined)closeSync(parent);}}this.#directory=directory;Object.freeze(this);
 }
 #path(binding){return join(this.#directory,binding.sessionId+'-'+binding.containerId+'.namespace.json');}
 #sync(){const fd=openSync(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
 persist({plan,inspection,witness}={}){
  const binding=identity(plan,inspection);if(inspection.document.State.Running!==true||inspection.document.State.Pid<=0)throw fail('WITNESS_NOT_RUNNING');const proof=validateLinuxRuntimeWitness(witness),witnessSha256=runtimeWitnessSha256(proof),record={schema:'session-runtime-witness-v1',identity:binding,witness:proof,witnessSha256};const bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>8192)throw fail('WITNESS_LIMIT');const path=this.#path(binding),temp=join(this.#directory,'.pending-'+randomUUID());let fd;
  try{fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;linkSync(temp,path);this.#sync();unlinkSync(temp);this.#sync();return Object.freeze({sessionId:binding.sessionId,containerId:binding.containerId,daemonId:binding.daemonId,specDigest:binding.specDigest,witnessSha256,evidenceSha256:sha(bytes)});}
  catch(error){throw error instanceof RuntimeWitnessStoreError?error:fail(error.code==='EEXIST'?'WITNESS_EXISTS':'WITNESS_WRITE');}
  finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 read({plan,inspection}={}){
  const expected=identity(plan,inspection),bytes=Buffer.alloc(8193);let fd;
  try{fd=openSync(this.#path(expected),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||(stat.mode&0o777)!==0o600||stat.size>8192||typeof process.getuid==='function'&&stat.uid!==process.getuid())throw fail('WITNESS_FILE');let used=0;while(used<bytes.length){const count=readSync(fd,bytes,used,bytes.length-used,null);if(!count)break;used+=count;}if(used>8192)throw fail('WITNESS_LIMIT');const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));if(!plain(record,['schema','identity','witness','witnessSha256'])||record.schema!=='session-runtime-witness-v1'||!equal(record.identity,expected))throw fail('WITNESS_BINDING');const witness=validateLinuxRuntimeWitness(record.witness);if(runtimeWitnessSha256(witness)!==record.witnessSha256)throw fail('WITNESS_DIGEST');return Object.freeze({record:Object.freeze({...record,identity:Object.freeze({...record.identity}),witness}),receipt:Object.freeze({sessionId:expected.sessionId,containerId:expected.containerId,daemonId:expected.daemonId,specDigest:expected.specDigest,witnessSha256:record.witnessSha256,evidenceSha256:sha(bytes.subarray(0,used))})});}
  catch(error){throw error instanceof RuntimeWitnessStoreError?error:fail(error.code==='ENOENT'?'WITNESS_MISSING':'WITNESS_READ');}
  finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);}
 }
}
