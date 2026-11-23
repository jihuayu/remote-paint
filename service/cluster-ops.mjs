import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {openSync,writeFileSync,fsyncSync,closeSync,readFileSync,lstatSync} from 'node:fs';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {ClusterPlacementStore} from './cluster-placement.mjs';
import {ClusterRpcClient} from './cluster-rpc.mjs';
import {ClusterSessionProvider} from './cluster-session-provider.mjs';

export class ClusterOpsError extends Error {
 constructor(code,message='Cluster operations request rejected'){super(message);this.name='ClusterOpsError';this.code=code;}
}

const fail=(code,message)=>{throw new ClusterOpsError(code,message);};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const version=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const sha256Hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v,keys)=>v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const freeze=v=>Object.freeze({...v});
const digestJson=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digestBytes=v=>createHash('sha256').update(v).digest('hex');
const recordKeys=['sessionId','tenantId','region','arch','version','nodeId','generation','epoch','state','retirementSha256'];
const workerSpecKeys=['nodeId','incarnation','endpoint','serverName','serverSha256','capacity','validateSource'];

function checkPrivateDir(dir){
 if(typeof dir!=='string'||!isAbsolute(dir))fail('CLUSTER_ARCHIVE_DIR','Archive directory must be an absolute path');
 let stat;try{stat=lstatSync(dir);}catch{fail('CLUSTER_ARCHIVE_DIR','Archive directory does not exist');}
 const uid=process.getuid?.();
 if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||(uid!==undefined&&stat.uid!==uid))fail('CLUSTER_ARCHIVE_DIR','Archive directory must be a private 0700 directory owned by the current user');
}

function checkPrivateFile(filePath){
 if(typeof filePath!=='string'||!isAbsolute(filePath))fail('CLUSTER_ARCHIVE_FILE','Archive file must be an absolute path');
 let stat;try{stat=lstatSync(filePath);}catch{fail('CLUSTER_ARCHIVE_FILE','Archive file does not exist');}
 const uid=process.getuid?.();
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o600||(uid!==undefined&&stat.uid!==uid))fail('CLUSTER_ARCHIVE_FILE','Archive file must be a private 0600 regular file owned by the current user');
}

function writePrivateExclusive(filePath,content){
 const fd=openSync(filePath,'wx',0o600);
 try{
  writeFileSync(fd,content,'utf8');
  fsyncSync(fd);
 }finally{
  closeSync(fd);
 }
}

function validateRecord(record){
 if(!exact(record,recordKeys))fail('CLUSTER_ARCHIVE_CORRUPT','Unexpected archive record shape');
 if(!id(record.sessionId)||!id(record.tenantId)||!id(record.region)||!['arm64','x64'].includes(record.arch)||!version(record.version)||!id(record.nodeId)||!integer(record.generation,1,Number.MAX_SAFE_INTEGER)||!integer(record.epoch,1,Number.MAX_SAFE_INTEGER)||record.state!=='closed'||!sha256Hex(record.retirementSha256)){
  fail('CLUSTER_ARCHIVE_CORRUPT','Invalid archived closed-session record');
 }
 return freeze(record);
}

export function writeClusterArchiveBatch({archiveDir,batch}={}){
 checkPrivateDir(archiveDir);
 if(!batch||batch.format!==1||!Array.isArray(batch.records)||batch.records.length<1||batch.archived!==batch.records.length||!sha256Hex(batch.sha256))fail('CLUSTER_ARCHIVE_INVALID','Expected a non-empty verified archive batch');
 const normalized=batch.records.map(validateRecord);
 const computedBatchSha=digestJson(normalized);
 if(computedBatchSha!==batch.sha256||normalized[0].epoch!==batch.minEpoch||normalized[normalized.length-1].epoch!==batch.maxEpoch){
  fail('CLUSTER_ARCHIVE_CORRUPT','Archive batch digest or epoch bounds mismatch');
 }
 const stem=`cluster-archive-e${batch.minEpoch}-e${batch.maxEpoch}-${batch.sha256.slice(0,12)}`;
 const archiveName=`${stem}.ndjson`;
 const manifestName=`${stem}.manifest.json`;
 const archiveFile=join(archiveDir,archiveName);
 const manifestFile=join(archiveDir,manifestName);
 const ndjson=normalized.map(r=>JSON.stringify(r)).join('\n')+'\n';
 const fileSha256=digestBytes(ndjson);
 const manifest=freeze({format:1,file:archiveName,archived:normalized.length,minEpoch:batch.minEpoch,maxEpoch:batch.maxEpoch,batchSha256:batch.sha256,fileSha256});
 writePrivateExclusive(archiveFile,ndjson);
 writePrivateExclusive(manifestFile,JSON.stringify(manifest,null,2)+'\n');
 return freeze({archiveFile,manifestFile,batchSha256:batch.sha256,fileSha256,archived:normalized.length,minEpoch:batch.minEpoch,maxEpoch:batch.maxEpoch});
}

export function verifyClusterArchive({manifestPath}={}){
 checkPrivateFile(manifestPath);
 const dir=dirname(manifestPath);
 checkPrivateDir(dir);
 let manifest;
 try{manifest=JSON.parse(readFileSync(manifestPath,'utf8'));}catch{fail('CLUSTER_ARCHIVE_CORRUPT','Malformed archive manifest JSON');}
 if(!exact(manifest,['format','file','archived','minEpoch','maxEpoch','batchSha256','fileSha256'])||manifest.format!==1||typeof manifest.file!=='string'||basename(manifest.file)!==manifest.file||!/^[A-Za-z0-9_.-]+\.ndjson$/.test(manifest.file)||!integer(manifest.archived,1,1000)||!integer(manifest.minEpoch,1,Number.MAX_SAFE_INTEGER)||!integer(manifest.maxEpoch,manifest.minEpoch,Number.MAX_SAFE_INTEGER)||!sha256Hex(manifest.batchSha256)||!sha256Hex(manifest.fileSha256)){
  fail('CLUSTER_ARCHIVE_CORRUPT','Invalid archive manifest fields');
 }
 const archiveFile=join(dir,manifest.file);
 checkPrivateFile(archiveFile);
 const raw=readFileSync(archiveFile,'utf8');
 const actualFileSha=digestBytes(raw);
 if(actualFileSha!==manifest.fileSha256)fail('CLUSTER_ARCHIVE_CORRUPT','Archive NDJSON file SHA-256 mismatch');
 const lines=raw.endsWith('\n')?raw.slice(0,-1).split('\n'):raw.split('\n');
 if(lines.length!==manifest.archived)fail('CLUSTER_ARCHIVE_CORRUPT','Archive record count mismatch');
 const records=[];
 let lastEpoch=0;
 for(const line of lines){
  let parsed;try{parsed=JSON.parse(line);}catch{fail('CLUSTER_ARCHIVE_CORRUPT','Malformed NDJSON archive line');}
  const rec=validateRecord(parsed);
  if(rec.epoch<=lastEpoch)fail('CLUSTER_ARCHIVE_CORRUPT','Archive epochs must be strictly increasing');
  lastEpoch=rec.epoch;
  records.push(rec);
 }
 if(records[0].epoch!==manifest.minEpoch||records[records.length-1].epoch!==manifest.maxEpoch)fail('CLUSTER_ARCHIVE_CORRUPT','Archive epoch bounds mismatch');
 const actualBatchSha=digestJson(records);
 if(actualBatchSha!==manifest.batchSha256)fail('CLUSTER_ARCHIVE_CORRUPT','Archive batch SHA-256 mismatch');
 return freeze({valid:true,archived:records.length,minEpoch:manifest.minEpoch,maxEpoch:manifest.maxEpoch,batchSha256:actualBatchSha,fileSha256:actualFileSha,records:Object.freeze(records)});
}

export class ClusterOperations {
 #store;#provider;
 constructor({store,provider=null}={}){
  if(!(store instanceof ClusterPlacementStore)||(provider!==null&&!(provider instanceof ClusterSessionProvider)))throw new TypeError('Configure a ClusterPlacementStore and optional ClusterSessionProvider');
  this.#store=store;this.#provider=provider;
 }
 snapshot(){
  const placement=this.#store.metrics();
  const provider=this.#provider?this.#provider.metrics():null;
  return freeze({placement,provider});
 }
 drainNode(nodeId){
  if(this.#provider){
   try{return this.#provider.drainWorker(nodeId,true);}catch(error){if(error?.code!=='CLUSTER_NODE_NOT_FOUND')throw error;}
  }
  return this.#store.drainNode(nodeId,true);
 }
 undrainNode(nodeId){
  if(this.#provider){
   try{return this.#provider.drainWorker(nodeId,false);}catch(error){if(error?.code!=='CLUSTER_NODE_NOT_FOUND')throw error;}
  }
  return this.#store.drainNode(nodeId,false);
 }
 planRollingUpgrade({region,arch,targetVersion,minTargetCapacity=1}={}){
  if(!id(region)||!['arm64','x64'].includes(arch)||!version(targetVersion)||!integer(minTargetCapacity,1,65536))throw new TypeError('Expected valid rolling upgrade target parameters');
  const {nodes}=this.#store.metrics();
  const scoped=nodes.filter(n=>n.region===region&&n.arch===arch);
  const targetVersionNodes=Object.freeze(scoped.filter(n=>n.version===targetVersion));
  const oldVersionNodes=Object.freeze(scoped.filter(n=>n.version!==targetVersion));
  const activeTargetCapacity=targetVersionNodes.filter(n=>n.mode==='active').reduce((sum,n)=>sum+n.capacity,0);
  const availableTargetSlots=targetVersionNodes.reduce((sum,n)=>sum+n.freeSlots,0);
  const canDrainOld=activeTargetCapacity>=minTargetCapacity;
  const readyToDrain=Object.freeze(canDrainOld?oldVersionNodes.filter(n=>n.mode==='active').map(n=>n.nodeId):[]);
  const draining=Object.freeze(oldVersionNodes.filter(n=>n.mode==='draining'&&n.heldSlots>0).map(n=>n.nodeId));
  const blockedByQuarantine=Object.freeze(oldVersionNodes.filter(n=>n.sessions.quarantined>0).map(n=>n.nodeId));
  const safeToArchiveAndRemove=Object.freeze(oldVersionNodes.filter(n=>n.safeToStop&&n.sessions.closed>0).map(n=>n.nodeId));
  const safeToRemove=Object.freeze(oldVersionNodes.filter(n=>n.removable).map(n=>n.nodeId));
  return freeze({region,arch,targetVersion,minTargetCapacity,activeTargetCapacity,availableTargetSlots,canDrainOld,targetVersionNodes,oldVersionNodes,readyToDrain,draining,blockedByQuarantine,safeToArchiveAndRemove,safeToRemove,complete:oldVersionNodes.length===0&&canDrainOld});
 }
 archiveClosedSessions({archiveDir,limit=100,beforeEpoch=null,nodeId=null}={}){
  checkPrivateDir(archiveDir);
  let written=null;
  const batch=this.#store.archiveClosedSessions({
   limit,beforeEpoch,nodeId,
   onArchive(candidate){
    written=writeClusterArchiveBatch({archiveDir,batch:candidate});
    const verified=verifyClusterArchive({manifestPath:written.manifestFile});
    return verified.valid===true&&verified.batchSha256===candidate.sha256;
   }
  });
  if(batch.archived===0)return freeze({archived:0,minEpoch:null,maxEpoch:null,batchSha256:null,fileSha256:null,archiveFile:null,manifestFile:null});
  return freeze({archived:batch.archived,minEpoch:batch.minEpoch,maxEpoch:batch.maxEpoch,batchSha256:written.batchSha256,fileSha256:written.fileSha256,archiveFile:written.archiveFile,manifestFile:written.manifestFile});
 }
 removeNode(nodeId){return this.#store.removeNode(nodeId);}
}

// Validates an explicit private cluster deployment configuration and wires
// placement SQLite, mTLS RPC clients, ClusterSessionProvider and ClusterOperations.
// Never creates credentials, discovers addresses, or relaxes TLS/pin checks.
export function assemblePrivateCluster({placementPath,region,arch,version:dataVersion,leaseMs=15000,heartbeatMs=4000,maxNodes=64,maxSessions=10000,controllerTls,workers,now}={}){
 if(!id(region)||!['arm64','x64'].includes(arch)||!version(dataVersion)||!Array.isArray(workers)||workers.length<1||workers.length>64||!controllerTls||!controllerTls.ca||!controllerTls.cert||!controllerTls.key){
  throw new TypeError('Configure explicit private placement path, controller mTLS identity and 1..64 Worker specifications');
 }
 checkPrivateFile(placementPath);
 checkPrivateDir(dirname(placementPath));
 const seen=new Set(),clients=new Map();
 let db=null,placement=null,provider=null;
 try{
  for(const spec of workers){
   if(!exact(spec,workerSpecKeys)||!id(spec.nodeId)||!id(spec.incarnation)||!sha256Hex(spec.serverSha256)||!integer(spec.capacity,1,1024)||typeof spec.validateSource!=='function'||seen.has(spec.nodeId)){
    throw new TypeError('Expected unique exact Worker deployment specifications with pinned SHA-256 and Source validator');
   }
   seen.add(spec.nodeId);
   const client=new ClusterRpcClient({endpoint:spec.endpoint,serverName:spec.serverName,serverSha256:spec.serverSha256,tls:controllerTls});
   clients.set(spec.nodeId,{client,descriptor:{nodeId:spec.nodeId,incarnation:spec.incarnation,region,arch,version:dataVersion,capacity:spec.capacity},validateSource:spec.validateSource});
  }
  db=new DatabaseSync(placementPath);
  const storeOptions={database:db,leaseMs,maxNodes,maxSessions,verifyRetirement:(...args)=>provider?provider.verifyRetirement(...args):false};
  if(now!==undefined)storeOptions.now=now;
  placement=new ClusterPlacementStore(storeOptions);
  provider=new ClusterSessionProvider({store:placement,region,arch,version:dataVersion,workers:clients,leaseMs,heartbeatMs});
  const operations=new ClusterOperations({store:placement,provider});
  return Object.freeze({
   placement,provider,operations,
   initialize:()=>provider.initialize(),
   async shutdown(){
    const result=await provider.shutdown();
    placement.close();
    return result;
   }
  });
 }catch(error){
  for(const {client}of clients.values())try{client.close();}catch{}
  if(placement)try{placement.close();}catch{}else if(db)try{db.close();}catch{}
  throw error;
 }
}
