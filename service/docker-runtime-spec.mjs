import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const stable=value=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0)):v);
const sha=value=>createHash('sha256').update(stable(value)).digest('hex');
const list=value=>value??[];
const empty=value=>Array.isArray(list(value))&&list(value).length===0;
const same=(a,b)=>stable(a)===stable(b);
const prefix='org.remote-paint.runtime.';
export class DockerRuntimeSpecError extends Error{constructor(){super('Docker container ownership or isolation does not match');this.name='DockerRuntimeSpecError';this.code='RUNTIME_SPEC_MISMATCH';}}
const reject=()=>{throw new DockerRuntimeSpecError();};
const path=value=>typeof value==='string'&&isAbsolute(value)&&value.length<=2048&&!/[\x00-\x1f\x7f]/.test(value);
function plain(v,keys){return v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));}
// Trusted service configuration, never a create request supplied by a tenant.
// No URL or owner secret enters the plan, environment or Docker labels.
export function planDockerRuntime({sessionId,tenantId,region,ownerKeyHash},{deploymentId,daemonId,imageId,projectPath,browserPath,projectManifestSha256,browserManifestSha256,imageEnvironment,workerEntry='service/native-session-worker.mjs'}={}){
 if(!id(sessionId)||!id(tenantId)||typeof region!=='string'||!region.length||region.length>64||!hash(ownerKeyHash)||!id(deploymentId)||!id(daemonId)||typeof imageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(imageId)||!path(projectPath)||!path(browserPath)||projectPath===browserPath||!hash(projectManifestSha256)||!hash(browserManifestSha256)||typeof workerEntry!=='string'||workerEntry.length>256||!/^[A-Za-z0-9_./-]+\.mjs$/.test(workerEntry)||workerEntry.startsWith('/')||workerEntry.split('/').some(p=>p==='.'||p==='..'||!p))throw new TypeError('Expected fixed runtime identity,immutable image and frozen read-only sources');
 const inherited={};if(!Array.isArray(imageEnvironment)||imageEnvironment.length>128)throw new TypeError('Pinned image environment is required');
 for(const value of imageEnvironment){if(typeof value!=='string'||Buffer.byteLength(value)>8192)throw new TypeError('Invalid image environment');const n=value.indexOf('='),key=value.slice(0,n);if(n<1||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||Object.hasOwn(inherited,key)||['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','PYTHONPATH'].includes(key))throw new TypeError('Unsupported image environment');inherited[key]=value.slice(n+1);}
 if(Buffer.byteLength(stable(inherited))>65536)throw new TypeError('Image environment exceeds its budget');
 const labels={[prefix+'schema']:'session-runtime-v1',[prefix+'deployment']:deploymentId,[prefix+'daemon']:daemonId,[prefix+'session']:sessionId,[prefix+'tenant']:tenantId,[prefix+'region']:region,[prefix+'owner-hash']:ownerKeyHash,[prefix+'project']:projectManifestSha256,[prefix+'browser']:browserManifestSha256};
 const env={REMOTE_PAINT_DATA_PLANE:'native',REMOTE_PAINT_WORKER_BOUNDARY:'owned-container-v1',REMOTE_PAINT_WORKER_SESSION:sessionId,REMOTE_PAINT_WORKER_TENANT:tenantId,REMOTE_PAINT_WORKER_REGION:region,REMOTE_PAINT_WORKER_OWNER_HASH:ownerKeyHash,REMOTE_PAINT_CHROMIUM:'/browser/headless_shell',CHROME_EXECUTABLE_PATH:'/browser/headless_shell',REMOTE_PAINT_BROKER:'/project/native/bin/aarch64-unknown-linux-gnu/remote-paint-broker'};
 const create={Image:imageId,Entrypoint:['node'],Cmd:['/project/'+workerEntry],WorkingDir:'/project',User:'0:0',Env:Object.entries({...inherited,...env}).map(([k,v])=>k+'='+v),Labels:labels,OpenStdin:true,StdinOnce:true,AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:false,Healthcheck:{Test:['NONE']},HostConfig:{Init:true,Runtime:'runc',CgroupParent:'',PidMode:'',IpcMode:'private',UTSMode:'',UsernsMode:'',CgroupnsMode:'private',ReadonlyRootfs:true,Privileged:false,AutoRemove:false,CapAdd:[],CapDrop:['ALL'],SecurityOpt:['no-new-privileges'],RestartPolicy:{Name:'no',MaximumRetryCount:0},LogConfig:{Type:'local',Config:{'max-size':'1m','max-file':'1',compress:'false'}},NetworkMode:'bridge',PortBindings:{},PublishAllPorts:false,Mounts:[{Type:'bind',Source:projectPath,Target:'/project',ReadOnly:true,BindOptions:{Propagation:'rprivate'}},{Type:'bind',Source:browserPath,Target:'/browser',ReadOnly:true,BindOptions:{Propagation:'rprivate'}}],Tmpfs:{'/tmp':'rw,nosuid,nodev,noexec,size=268435456,mode=1777'},Memory:2147483648,MemorySwap:2147483648,ShmSize:1073741824,NanoCpus:2000000000,PidsLimit:512}};
 const specDigest=sha(create);create.Labels[prefix+'spec']=specDigest;const containerName='remote-paint-'+sha({deploymentId,region,sessionId,tenantId,ownerKeyHash}).slice(0,40);
 return {containerName,specDigest,imageId,daemonId,deploymentId,sessionId,tenantId,region,ownerKeyHash,projectManifestSha256,browserManifestSha256,imageEnvironment:[...imageEnvironment],create};
}
function validatePlan(plan){
 if(!plain(plan,['containerName','specDigest','imageId','daemonId','deploymentId','sessionId','tenantId','region','ownerKeyHash','projectManifestSha256','browserManifestSha256','imageEnvironment','create']))reject();
 const c=plan.create;if(!c||!c.HostConfig||!c.Labels||!Array.isArray(c.HostConfig.Mounts)||c.HostConfig.Mounts.length!==2||!Array.isArray(c.Cmd)||c.Cmd.length!==1||typeof c.Cmd[0]!=='string'||!c.Cmd[0].startsWith('/project/'))reject();
 let fresh;try{fresh=planDockerRuntime(plan,{...plan,projectPath:c.HostConfig.Mounts[0].Source,browserPath:c.HostConfig.Mounts[1].Source,workerEntry:c.Cmd[0].slice('/project/'.length)});}catch{reject();}
 if(!same(plan,fresh))reject();return c;
}
export function dockerRuntimeCreateBody(plan){return structuredClone(validatePlan(plan));}
export function verifyDockerRuntimeOwnership(plan,inspection,{containerId=null}={}){
 validatePlan(plan);if(!inspection||inspection.daemon?.id!==plan.daemonId||inspection.found!==true)reject();const d=inspection.document,c=d?.Config;
 if(!d||!hash(d.Id)||containerId!==null&&d.Id!==containerId||d.Name!=='/'+plan.containerName||d.Image!==plan.imageId||!c||c.Image!==plan.imageId)reject();
 const actualLabels=Object.fromEntries(Object.entries(c.Labels??{}).filter(([k])=>k.startsWith(prefix)));if(!same(actualLabels,plan.create.Labels))reject();
 return Object.freeze({containerId:d.Id,daemonId:plan.daemonId,name:plan.containerName,specDigest:plan.specDigest,scope:'Ownership metadata only;isolation and namespace retirement must be independently proved.'});
}
export function verifyDockerRuntime(plan,inspection,{containerId=null}={}){
 const expected=validatePlan(plan);verifyDockerRuntimeOwnership(plan,inspection,{containerId});const d=inspection.document,h=d.HostConfig,c=d.Config;
 if(!h||!same(c.Entrypoint,expected.Entrypoint)||!same(c.Cmd,expected.Cmd)||c.WorkingDir!=='/project'||c.User!=='0:0'||c.Tty!==false||c.OpenStdin!==true||c.StdinOnce!==true||!same(c.Healthcheck?.Test,['NONE']))reject();
 if(!Array.isArray(c.Env))reject();const selected={};for(const value of c.Env){if(typeof value!=='string')reject();const n=value.indexOf('='),key=value.slice(0,n);if(n<=0||Object.hasOwn(selected,key))reject();selected[key]=value.slice(n+1);}
 const wanted=Object.fromEntries(expected.Env.map(v=>{const n=v.indexOf('=');return[v.slice(0,n),v.slice(n+1)];}));if(!same(Object.fromEntries(Object.entries(selected).sort()),Object.fromEntries(Object.entries(wanted).sort())))reject();
 for(const key of ['Init','Runtime','CgroupParent','PidMode','IpcMode','UTSMode','UsernsMode','CgroupnsMode','ReadonlyRootfs','Privileged','AutoRemove','NetworkMode','PublishAllPorts','Memory','MemorySwap','ShmSize','NanoCpus','PidsLimit'])if(h[key]!==expected.HostConfig[key])reject();
 if(!same(h.LogConfig,expected.HostConfig.LogConfig))reject();
 if(!empty(h.CapAdd)||!same(h.CapDrop,['ALL'])||!same(h.SecurityOpt,['no-new-privileges'])||!same(h.RestartPolicy,expected.HostConfig.RestartPolicy)||!empty(h.Devices)||!empty(h.DeviceRequests)||!empty(h.DeviceCgroupRules)||!empty(h.GroupAdd)||!empty(h.VolumesFrom)||!empty(h.Binds)||!empty(h.Links)||!empty(h.ExtraHosts)||!same(h.Tmpfs,expected.HostConfig.Tmpfs)||!same(h.PortBindings??{},{}))reject();
 if(!same(h.Mounts,expected.HostConfig.Mounts)||!Array.isArray(d.Mounts)||d.Mounts.length!==2)reject();
 for(const mount of expected.HostConfig.Mounts){const found=d.Mounts.filter(v=>v.Destination===mount.Target);if(found.length!==1||found[0].Type!=='bind'||found[0].Source!==mount.Source||found[0].RW!==false||found[0].Propagation!=='rprivate')reject();}
 if(d.NetworkSettings?.Ports&&Object.values(d.NetworkSettings.Ports).some(v=>v!==null))reject();
 const state=d.State;if(!state||typeof state.Running!=='boolean'||!Number.isSafeInteger(state.Pid)||state.Pid<0||state.Running&&state.Pid===0||!state.Running&&state.Pid!==0||typeof state.Status!=='string'||!['created','running','exited','dead'].includes(state.Status))reject();
 return Object.freeze({containerId:d.Id,daemonId:plan.daemonId,name:plan.containerName,specDigest:plan.specDigest,state:state.Status,running:state.Running,pid:state.Pid,scope:'Bounded Engine metadata identity/config witness only;not process or namespace retirement proof.'});
}
