import {mkdirSync,lstatSync,openSync,fstatSync,writeFileSync,readSync,fsyncSync,closeSync,linkSync,unlinkSync,constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {SqliteSessionStore} from './session-store.mjs';
import {DockerMetadataClient} from './docker-metadata-client.mjs';
import {planDockerRuntime} from './docker-runtime-spec.mjs';
export const RUNTIME_DEPLOYMENT_BINDING_MAX_BYTES=8192;
export class RuntimeDeploymentBindingError extends Error {constructor(code){super('Runtime deployment binding is unavailable');this.name='RuntimeDeploymentBindingError';this.code=code;}}
const fail=code=>new RuntimeDeploymentBindingError(code),sha=v=>createHash('sha256').update(v).digest('hex');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const canonical=v=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a<b?-1:a>b?1:0)):x),same=(a,b)=>canonical(a)===canonical(b);
const freeze=v=>{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;};
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const configKeys=['region','deploymentId','daemonId','imageId','projectPath','browserPath','projectManifestSha256','browserManifestSha256','imageEnvironment','workerEntry'];
function configuration(value){
 if(!exact(value,Object.hasOwn(value??{},'workerEntry')?configKeys:configKeys.filter(k=>k!=='workerEntry')))throw new TypeError('Expected fixed runtime deployment configuration');
 const env=value.imageEnvironment;if(!Array.isArray(env)||Object.getPrototypeOf(env)!==Array.prototype||env.length>128||Reflect.ownKeys(env).length!==env.length+1||!Array.from({length:env.length},(_x,n)=>Object.getOwnPropertyDescriptor(env,String(n))).every(x=>x&&Object.hasOwn(x,'value')))throw new TypeError('Expected fixed image environment values');
 const result={...value,imageEnvironment:[...env],workerEntry:Object.hasOwn(value,'workerEntry')?value.workerEntry:'service/native-session-worker.mjs'};if(typeof result.region!=='string'||/[\x00-\x1f\x7f]/.test(result.region)||typeof result.workerEntry!=='string')throw new TypeError('Invalid deployment configuration');
 planDockerRuntime({sessionId:'ses_deployment_binding',tenantId:'deployment-bootstrap',region:result.region,ownerKeyHash:'0'.repeat(64)},result);return freeze(result);
}
function binding(store,config){
 if(!(store instanceof SqliteSessionStore))throw new TypeError('Expected the actual private Session ledger');
 return {region:config.region,deploymentId:config.deploymentId,daemonId:config.daemonId,imageId:config.imageId,projectManifestSha256:config.projectManifestSha256,browserManifestSha256:config.browserManifestSha256,configurationSha256:sha(canonical(config)),ledger:store.identity()};
}
const fingerprint=s=>[s.dev,s.ino,s.size,s.mode,s.uid,s.mtimeNs,s.ctimeNs].map(String);
const privateDirectory=s=>s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o777n)===0o700n&&(typeof process.getuid!=='function'||s.uid===BigInt(process.getuid()));
function path(directory){if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>2048||/[\x00-\x1f\x7f]/.test(directory))throw new TypeError('Expected a private absolute deployment directory');}
// Bootstrap is an explicit trusted initialization step for a NEW deployment.
// Service resume must only open the existing binding, never retry bootstrap
// because a journal/binding is absent or current inventory happens to be empty.
export class RuntimeDeploymentBindingStore {
 #directory;#identity;
 constructor({directory}={}){
  path(directory);this.#directory=directory;
  try{const s=lstatSync(directory,{bigint:true});if(!privateDirectory(s))throw fail('DEPLOYMENT_DIRECTORY');this.#identity=[s.dev,s.ino].map(String);}catch{throw fail('DEPLOYMENT_DIRECTORY');}Object.freeze(this);
 }
 #check(s){if(!privateDirectory(s)||!same([s.dev,s.ino].map(String),this.#identity))throw fail('DEPLOYMENT_DIRECTORY');}
 #sync(){let fd;try{this.#check(lstatSync(this.#directory,{bigint:true}));fd=openSync(this.#directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);this.#check(fstatSync(fd,{bigint:true}));fsyncSync(fd);this.#check(lstatSync(this.#directory,{bigint:true}));}finally{if(fd!==undefined)closeSync(fd);}}
 #path(config){return join(this.#directory,sha(config.region)+'.deployment.json');}
 #absent(config){this.#check(lstatSync(this.#directory,{bigint:true}));try{lstatSync(this.#path(config));}catch(e){if(e.code==='ENOENT')return;throw e;}throw fail('DEPLOYMENT_EXISTS');}
 static async bootstrap({directory,store,metadata,configuration:input,signal}={}){
  path(directory);const config=configuration(input),expected=binding(store,config);if(!(metadata instanceof DockerMetadataClient)||signal!==undefined&&!(signal instanceof AbortSignal))throw new TypeError('Expected a pinned Engine client and optional AbortSignal');
  let created=false;try{mkdirSync(directory,{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw fail('DEPLOYMENT_DIRECTORY');}
  const files=new RuntimeDeploymentBindingStore({directory});if(created){let fd;try{fd=openSync(dirname(directory),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(fd);}catch{throw fail('DEPLOYMENT_DIRECTORY');}finally{if(fd!==undefined)closeSync(fd);}}
  files.#absent(config);const owner=Symbol('deployment-bootstrap');let claimed=false;
  const empty=()=>{const snapshot=store.loadRuntime({owner});if(snapshot.allocations.length||snapshot.recoveryRequired.length||store.load().sessions.some(row=>row.region===config.region))throw fail('DEPLOYMENT_NOT_EMPTY');};
  try{
   if(store.load().sessions.some(row=>row.region===config.region))throw fail('DEPLOYMENT_NOT_EMPTY');store.claimRuntimeProvider(owner,{region:config.region,deploymentId:config.deploymentId,daemonId:config.daemonId,createdAt:new Date().toISOString()});claimed=true;empty();
   const inventory=await metadata.listRuntimeCandidates({deploymentId:config.deploymentId,region:config.region,signal});if(inventory.daemon.id!==config.daemonId)throw fail('DEPLOYMENT_ENGINE_CHANGED');if(inventory.containerIds.length)throw fail('DEPLOYMENT_ORPHANS');empty();
   if(signal?.aborted)throw fail('DEPLOYMENT_ABORTED');if(!same(binding(store,config),expected))throw fail('DEPLOYMENT_LEDGER_CHANGED');files.#absent(config);files.#publish(expected);const opened=files.open({store,configuration:config});if(signal?.aborted)throw fail('DEPLOYMENT_ABORTED');return opened;
  }catch(e){throw e instanceof RuntimeDeploymentBindingError?e:fail('DEPLOYMENT_BOOTSTRAP');}finally{if(claimed)store.releaseRuntimeProvider(owner);}
 }
 #publish(value){
  const record={schema:'session-runtime-deployment-v1',createdAt:new Date().toISOString(),binding:value,bindingSha256:sha(canonical(value))},bytes=Buffer.from(JSON.stringify(record)+'\n');if(bytes.length>RUNTIME_DEPLOYMENT_BINDING_MAX_BYTES)throw fail('DEPLOYMENT_LIMIT');const config={region:value.region},temp=join(this.#directory,'.pending-'+randomUUID());let fd;
  try{this.#sync();fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);const s=fstatSync(fd,{bigint:true});if(!s.isFile()||(s.mode&0o777n)!==0o600n||typeof process.getuid==='function'&&s.uid!==BigInt(process.getuid()))throw fail('DEPLOYMENT_FILE');writeFileSync(fd,bytes);fsyncSync(fd);closeSync(fd);fd=undefined;linkSync(temp,this.#path(config));this.#sync();unlinkSync(temp);this.#sync();}
  catch(e){throw e instanceof RuntimeDeploymentBindingError?e:fail(e.code==='EEXIST'?'DEPLOYMENT_EXISTS':'DEPLOYMENT_WRITE');}finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);try{unlinkSync(temp);}catch{}}
 }
 open({store,configuration:input}={}){
  const config=configuration(input),expected=binding(store,config),bytes=Buffer.alloc(RUNTIME_DEPLOYMENT_BINDING_MAX_BYTES+1);let fd;
  try{this.#check(lstatSync(this.#directory,{bigint:true}));fd=openSync(this.#path(config),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const before=fstatSync(fd,{bigint:true});if(!before.isFile()||(before.mode&0o777n)!==0o600n||before.size<1n||before.size>BigInt(RUNTIME_DEPLOYMENT_BINDING_MAX_BYTES)||typeof process.getuid==='function'&&before.uid!==BigInt(process.getuid()))throw fail('DEPLOYMENT_FILE');let used=0;
   while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,null);if(!n)break;used+=n;}if(used!==Number(before.size)||!same(fingerprint(before),fingerprint(fstatSync(fd,{bigint:true}))))throw fail('DEPLOYMENT_CHANGED');const record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,used)));
   if(!exact(record,['schema','createdAt','binding','bindingSha256'])||record.schema!=='session-runtime-deployment-v1'||!date(record.createdAt)||!same(record.binding,expected)||record.bindingSha256!==sha(canonical(record.binding)))throw fail('DEPLOYMENT_BINDING');this.#sync();if(!same(binding(store,config),expected))throw fail('DEPLOYMENT_LEDGER_CHANGED');
   return freeze({record,receipt:{region:expected.region,deploymentId:expected.deploymentId,daemonId:expected.daemonId,ledger:expected.ledger,configurationSha256:expected.configurationSha256,bindingSha256:record.bindingSha256,fileSha256:sha(bytes.subarray(0,used)),scope:'Immutable configuration/ledger continuity only;not allocation admission,Engine effect authorization or namespace retirement proof.'}});
  }catch(e){throw e instanceof RuntimeDeploymentBindingError?e:fail(e.code==='ENOENT'?'DEPLOYMENT_MISSING':'DEPLOYMENT_READ');}finally{bytes.fill(0);if(fd!==undefined)closeSync(fd);}
 }
}
