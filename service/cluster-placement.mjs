import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstatSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';

export class ClusterPlacementError extends Error {
 constructor(code){super('Cluster placement is unavailable');this.name='ClusterPlacementError';this.code=code;}
}
const fail=code=>{throw new ClusterPlacementError(code);};
const owners=new WeakSet(),id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const version=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\x00-\x1f\x7f]/.test(v);
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const exact=(v,keys)=>v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const freeze=v=>Object.freeze({...v});
const nodeKeys=['nodeId','incarnation','region','arch','version','capacity'];
const requestKeys=['tenantId','sessionId','region','arch','version'];
const leaseKeys=['nodeId','incarnation','generation'];
const bindingKeys=['tenantId','sessionId','nodeId','generation','epoch'];
const validBinding=v=>exact(v,bindingKeys)&&id(v.tenantId)&&id(v.sessionId)&&id(v.nodeId)&&integer(v.generation,1,Number.MAX_SAFE_INTEGER)&&integer(v.epoch,1,Number.MAX_SAFE_INTEGER);
const digest=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const applicationId=0x52504331;
function fileIdentity(path){
 if(typeof path!=='string'||!isAbsolute(path))fail('CLUSTER_DATABASE_FILE');
 const file=lstatSync(path),directory=lstatSync(dirname(path)),uid=process.getuid?.();
 if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o777)!==0o600||!directory.isDirectory()||directory.isSymbolicLink()||(directory.mode&0o777)!==0o700||uid!==undefined&&(file.uid!==uid||directory.uid!==uid))fail('CLUSTER_DATABASE_FILE');
 return [file.dev,file.ino,directory.dev,directory.ino].join(':');
}

// Trusted control-plane foundation. One exclusive local SQLite owner, several
// explicitly configured worker adapters; not a replicated/HA controller.
// Fence numbers are identities, never credentials. Workers must independently
// reject stale fences before effects; this ledger alone cannot stop a partition.
export class ClusterPlacementStore {
 #db;#now;#last=-1;#ttl;#maxNodes;#maxSessions;#verify;#closed=false;#failed=false;#path;#identity;
 constructor({database,now=()=>Math.floor(performance.now()),leaseMs=15000,maxNodes=64,maxSessions=10000,verifyRetirement}={}){
  if(!(database instanceof DatabaseSync)||owners.has(database)||typeof now!=='function'||typeof verifyRetirement!=='function'||!integer(leaseMs,100,60000)||!integer(maxNodes,1,1024)||!integer(maxSessions,1,100000))throw new TypeError('Configure an exclusive private cluster database, finite bounds and trusted retirement verifier');
  this.#db=database;this.#now=now;this.#ttl=leaseMs;this.#maxNodes=maxNodes;this.#maxSessions=maxSessions;this.#verify=verifyRetirement;
  try{
   this.#path=database.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;this.#identity=fileIdentity(this.#path);
   const app=database.prepare('PRAGMA application_id').get().application_id;
   if(app!==0&&app!==applicationId)fail('CLUSTER_DATABASE_FORMAT');
   if(app===0&&database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length)fail('CLUSTER_DATABASE_FORMAT');
   database.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA max_page_count=16384;');
   database.exec(`BEGIN EXCLUSIVE;
    CREATE TABLE IF NOT EXISTS cluster_meta(id INTEGER PRIMARY KEY CHECK(id=1), format INTEGER NOT NULL CHECK(format=1), epoch INTEGER NOT NULL CHECK(epoch>=0)) STRICT;
    INSERT OR IGNORE INTO cluster_meta VALUES(1,1,0);
    CREATE TABLE IF NOT EXISTS cluster_nodes(nodeId TEXT PRIMARY KEY, incarnation TEXT NOT NULL, generation INTEGER NOT NULL, region TEXT NOT NULL, arch TEXT NOT NULL, version TEXT NOT NULL, capacity INTEGER NOT NULL, mode TEXT NOT NULL, deadline INTEGER NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS cluster_sessions(sessionId TEXT PRIMARY KEY, tenantId TEXT NOT NULL, region TEXT NOT NULL, arch TEXT NOT NULL, version TEXT NOT NULL, fingerprint TEXT NOT NULL, nodeId TEXT NOT NULL REFERENCES cluster_nodes(nodeId), generation INTEGER NOT NULL, epoch INTEGER NOT NULL UNIQUE, state TEXT NOT NULL, retirementSha256 TEXT) STRICT;
    UPDATE cluster_nodes SET deadline=0,mode='expired';
    UPDATE cluster_sessions SET state='quarantined' WHERE state!='closed';
    PRAGMA application_id=${applicationId}; COMMIT;`);
   owners.add(database);
  }catch(error){try{database.exec('ROLLBACK');}catch{}throw error instanceof ClusterPlacementError?error:new ClusterPlacementError('CLUSTER_STORAGE');}
 }
 #clock(){const at=this.#now();if(!integer(at,0,Number.MAX_SAFE_INTEGER-this.#ttl)||at<this.#last)fail('CLUSTER_CLOCK');this.#last=at;return at;}
 #transaction(callback){
  if(this.#closed||this.#failed)fail('CLUSTER_CLOSED');
  try{this.#checkFile();this.#db.exec('BEGIN IMMEDIATE');const value=callback(this.#clock());this.#checkFile();this.#db.exec('COMMIT');this.#checkFile();return value;}
  catch(error){try{this.#db.exec('ROLLBACK');}catch{}if(error instanceof ClusterPlacementError)throw error;this.#failed=true;throw new ClusterPlacementError('CLUSTER_STORAGE');}
 }
 #checkFile(){try{if(fileIdentity(this.#path)!==this.#identity)throw new Error('Identity changed');}catch{this.#failed=true;fail('CLUSTER_STORAGE');}}
 #sweep(at){
  this.#db.prepare("UPDATE cluster_sessions SET state='quarantined' WHERE state!='closed' AND nodeId IN(SELECT nodeId FROM cluster_nodes WHERE deadline<=?)").run(at);
  this.#db.prepare("UPDATE cluster_nodes SET mode='expired' WHERE deadline<=?").run(at);
 }
 #lease(value,at){
  if(!exact(value,leaseKeys)||!id(value.nodeId)||!id(value.incarnation)||!integer(value.generation,1,Number.MAX_SAFE_INTEGER))fail('CLUSTER_LEASE');
  const node=this.#db.prepare('SELECT * FROM cluster_nodes WHERE nodeId=?').get(value.nodeId);
  if(!node||node.incarnation!==value.incarnation||node.generation!==value.generation||node.deadline<=at)fail('CLUSTER_LEASE');return node;
 }
 #binding(value,at){
  if(!validBinding(value))fail('CLUSTER_FENCE');
  const row=this.#db.prepare('SELECT * FROM cluster_sessions WHERE sessionId=? AND tenantId=?').get(value.sessionId,value.tenantId);
  const node=this.#db.prepare('SELECT * FROM cluster_nodes WHERE nodeId=?').get(value.nodeId);
  if(!row||!node||row.nodeId!==value.nodeId||row.generation!==value.generation||row.epoch!==value.epoch||node.generation!==value.generation||node.deadline<=at||['quarantined','closed','closing'].includes(row.state))fail('CLUSTER_FENCE');return row;
 }
 #receipt(row){return freeze({tenantId:row.tenantId,sessionId:row.sessionId,nodeId:row.nodeId,generation:row.generation,epoch:row.epoch});}
 registerNode(value){
  if(!exact(value,nodeKeys)||!nodeKeys.filter(k=>!['capacity','version'].includes(k)).every(k=>id(value[k]))||!version(value.version)||!['arm64','x64'].includes(value.arch)||!integer(value.capacity,1,1024))throw new TypeError('Expected an exact bounded worker descriptor');
  return this.#transaction(at=>{
   this.#sweep(at);const old=this.#db.prepare('SELECT * FROM cluster_nodes WHERE nodeId=?').get(value.nodeId);
   if(old&&old.deadline>at)fail('CLUSTER_NODE_OWNED');
   if(!old&&this.#db.prepare('SELECT count(*) AS n FROM cluster_nodes').get().n>=this.#maxNodes)fail('CLUSTER_NODE_LIMIT');
   const generation=(old?.generation??0)+1;if(!Number.isSafeInteger(generation))fail('CLUSTER_FENCE_LIMIT');
   const unresolved=this.#db.prepare("SELECT count(*) AS n FROM cluster_sessions WHERE nodeId=? AND state!='closed'").get(value.nodeId).n;
   this.#db.prepare('INSERT INTO cluster_nodes VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(nodeId) DO UPDATE SET incarnation=excluded.incarnation,generation=excluded.generation,region=excluded.region,arch=excluded.arch,version=excluded.version,capacity=excluded.capacity,mode=excluded.mode,deadline=excluded.deadline').run(value.nodeId,value.incarnation,generation,value.region,value.arch,value.version,value.capacity,unresolved?'recovering':'active',at+this.#ttl);
   return freeze({nodeId:value.nodeId,incarnation:value.incarnation,generation});
  });
 }
 heartbeat(lease){return this.#transaction(at=>{this.#lease(lease,at);this.#db.prepare('UPDATE cluster_nodes SET deadline=? WHERE nodeId=?').run(at+this.#ttl,lease.nodeId);return freeze(lease);});}
 drain(lease,enabled=true){if(typeof enabled!=='boolean')throw new TypeError('Expected a drain boolean');return this.#transaction(at=>{const node=this.#lease(lease,at);if(node.mode==='recovering')fail('CLUSTER_RECOVERY_REQUIRED');this.#db.prepare('UPDATE cluster_nodes SET mode=? WHERE nodeId=?').run(enabled?'draining':'active',lease.nodeId);return freeze({nodeId:lease.nodeId,draining:enabled});});}
 reserve(value){
  if(!exact(value,requestKeys)||!requestKeys.filter(k=>k!=='version').every(k=>id(value[k]))||!version(value.version)||!['arm64','x64'].includes(value.arch))throw new TypeError('Expected a captured Session placement request');
  const fingerprint=digest(requestKeys.map(k=>value[k]));
  return this.#transaction(at=>{
   this.#sweep(at);const old=this.#db.prepare('SELECT * FROM cluster_sessions WHERE sessionId=?').get(value.sessionId);
   if(old){if(old.tenantId!==value.tenantId)fail('CLUSTER_SESSION_NOT_FOUND');if(old.fingerprint!==fingerprint)fail('CLUSTER_IDEMPOTENCY_CONFLICT');return freeze({...this.#receipt(old),state:old.state});}
   if(this.#db.prepare('SELECT count(*) AS n FROM cluster_sessions').get().n>=this.#maxSessions)fail('CLUSTER_RETENTION_LIMIT');
   const nodes=this.#db.prepare("SELECT n.*,count(s.sessionId) AS used FROM cluster_nodes n LEFT JOIN cluster_sessions s ON n.nodeId=s.nodeId AND s.state!='closed' WHERE n.region=? AND n.arch=? AND n.version=? AND n.mode='active' AND n.deadline>? GROUP BY n.nodeId").all(value.region,value.arch,value.version,at).filter(n=>n.used<n.capacity);
   nodes.sort((a,b)=>a.used*b.capacity-b.used*a.capacity||a.nodeId.localeCompare(b.nodeId));const node=nodes[0];if(!node)fail('CLUSTER_CAPACITY');
   const epoch=this.#db.prepare('SELECT epoch FROM cluster_meta WHERE id=1').get().epoch+1;if(!Number.isSafeInteger(epoch))fail('CLUSTER_FENCE_LIMIT');
   this.#db.prepare('UPDATE cluster_meta SET epoch=? WHERE id=1').run(epoch);
   this.#db.prepare("INSERT INTO cluster_sessions VALUES(?,?,?,?,?,?,?,?,?,'reserved',NULL)").run(value.sessionId,value.tenantId,value.region,value.arch,value.version,fingerprint,node.nodeId,node.generation,epoch);
   return freeze({...this.#receipt({...value,nodeId:node.nodeId,generation:node.generation,epoch}),state:'reserved'});
  });
 }
 ready(binding){return this.#transaction(at=>{const row=this.#binding(binding,at);if(!['reserved','ready'].includes(row.state))fail('CLUSTER_FENCE');this.#db.prepare("UPDATE cluster_sessions SET state='ready' WHERE sessionId=?").run(row.sessionId);return freeze({...this.#receipt(row),version:row.version,state:'ready'});});}
 route({tenantId,sessionId,version}={}){
  if(!id(tenantId)||!id(sessionId)||typeof version!=='string'||version.length<1||version.length>256||/[\x00-\x1f\x7f]/.test(version))throw new TypeError('Expected a trusted Session lookup');
  return this.#transaction(at=>{this.#sweep(at);const row=this.#db.prepare('SELECT * FROM cluster_sessions WHERE sessionId=? AND tenantId=?').get(sessionId,tenantId);if(!row)fail('CLUSTER_SESSION_NOT_FOUND');if(row.state!=='ready'||row.version!==version)fail('CLUSTER_SESSION_UNAVAILABLE');this.#binding(this.#receipt(row),at);return freeze({...this.#receipt(row),region:row.region,arch:row.arch,version:row.version});});
 }
 beginRelease({tenantId,sessionId}={}){
  if(!id(tenantId)||!id(sessionId))throw new TypeError('Expected a trusted Session identity');
  return this.#transaction(at=>{this.#sweep(at);const row=this.#db.prepare('SELECT * FROM cluster_sessions WHERE sessionId=? AND tenantId=?').get(sessionId,tenantId);if(!row)fail('CLUSTER_SESSION_NOT_FOUND');if(row.state!=='closed'&&row.state!=='quarantined')this.#db.prepare("UPDATE cluster_sessions SET state='closing' WHERE sessionId=?").run(sessionId);return this.#receipt(row);});
 }
 confirmRetired(binding,receipt){
  if(!validBinding(binding))throw new TypeError('Expected the original placement fence');
  return this.#transaction(()=>{
   const row=this.#db.prepare('SELECT * FROM cluster_sessions WHERE sessionId=? AND tenantId=?').get(binding.sessionId,binding.tenantId);
   if(!row||JSON.stringify(this.#receipt(row))!==JSON.stringify(Object.fromEntries(bindingKeys.map(k=>[k,binding[k]]))))fail('CLUSTER_FENCE');
   if(row.state==='closed')return freeze({status:'closed'});if(!['closing','quarantined'].includes(row.state))fail('CLUSTER_RETIREMENT_REQUIRED');
   if(!exact(receipt,['sha256'])||typeof receipt.sha256!=='string'||!/^[a-f0-9]{64}$/.test(receipt.sha256))fail('CLUSTER_RETIREMENT_UNCONFIRMED');
   let verified;try{verified=this.#verify(freeze({...this.#receipt(row),state:row.state}),freeze(receipt));if(verified?.then)void Promise.resolve(verified).catch(()=>{});}catch{fail('CLUSTER_RETIREMENT_UNCONFIRMED');}
   if(verified!==true)fail('CLUSTER_RETIREMENT_UNCONFIRMED');
   this.#db.prepare("UPDATE cluster_sessions SET state='closed',retirementSha256=? WHERE sessionId=?").run(receipt.sha256,row.sessionId);
   const remaining=this.#db.prepare("SELECT count(*) AS n FROM cluster_sessions WHERE nodeId=? AND state!='closed'").get(row.nodeId).n;
   if(!remaining)this.#db.prepare("UPDATE cluster_nodes SET mode='active' WHERE nodeId=? AND mode='recovering'").run(row.nodeId);
   return freeze({status:'closed'});
  });
 }
 status(){return this.#transaction(at=>{this.#sweep(at);return freeze({nodes:this.#db.prepare('SELECT count(*) AS n FROM cluster_nodes').get().n,retainedSessions:this.#db.prepare('SELECT count(*) AS n FROM cluster_sessions').get().n,heldSlots:this.#db.prepare("SELECT count(*) AS n FROM cluster_sessions WHERE state!='closed'").get().n,quarantined:this.#db.prepare("SELECT count(*) AS n FROM cluster_sessions WHERE state='quarantined'").get().n});});}
 close(){if(this.#closed)return;this.#closed=true;owners.delete(this.#db);this.#db.close();}
}
