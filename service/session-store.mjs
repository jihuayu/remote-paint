import {createRequire} from 'node:module';
import {openSync,closeSync,lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';

let DatabaseSync;
try{({DatabaseSync}=createRequire(import.meta.url)('node:sqlite'));}catch{}
const [nodeMajor,nodeMinor]=process.versions.node.split('.').map(Number);
export const sessionStoreSupported=['linux','darwin'].includes(process.platform)&&!!DatabaseSync&&(nodeMajor>22||nodeMajor===22&&nodeMinor>=13);
export class SessionStoreError extends Error {
 constructor(code,message,{cause}={}){super(message,{cause});this.name='SessionStoreError';this.code=code;}
}
const fail=(code,message,cause)=>{throw new SessionStoreError(code,message,{cause});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const tenant=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const bounded=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max;
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const date=value=>typeof value==='string'&&value.length<=32&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const nullable=(value,predicate)=>value===null||predicate(value);
function plain(value,keys){
 if(!value||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('STATE_INVALID','Expected plain record metadata');
 const names=Reflect.ownKeys(value);
 if(names.length!==keys.length||names.some(key=>!keys.includes(key)||!Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')))fail('STATE_INVALID','Unexpected record fields');
}
const SESSION_KEYS=['sessionId','tenant','region','state','createdAt','version','reserved','operationId','ttlSeconds','readyAt','expiresAt','closeReason','closeAttempts','releaseOperationId'];
const OP_KEYS=['operationId','sessionId','kind','status','createdAt','updatedAt','error'];
function sessionRecord(row){
 plain(row,SESSION_KEYS);
 if(!id(row.sessionId)||!tenant(row.tenant)||!bounded(row.region,64)||!['creating','ready','closing','closed','expired','failed','cleanup-failed','recovery-required'].includes(row.state)||!date(row.createdAt)||!nullable(row.version,v=>bounded(v,256))||typeof row.reserved!=='boolean'||!id(row.operationId)||!integer(row.ttlSeconds,1,86400)||!nullable(row.readyAt,date)||!nullable(row.expiresAt,date)||!nullable(row.closeReason,v=>['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault'].includes(v))||!integer(row.closeAttempts,0,16)||!nullable(row.releaseOperationId,id))fail('STATE_INVALID','Invalid Session metadata');
 if(['creating','ready','cleanup-failed','recovery-required'].includes(row.state)&&!row.reserved)fail('STATE_INVALID','Live or uncertain Session must reserve ownership');
 if(['closed','expired','failed'].includes(row.state)&&row.reserved)fail('STATE_INVALID','Terminal Session cannot reserve ownership');
 if(row.state==='ready'&&(!row.version||!row.readyAt||!row.expiresAt))fail('STATE_INVALID','Ready Session lacks version or lifetime');
 return Object.fromEntries(SESSION_KEYS.map(key=>[key,row[key]]));
}
function operationRecord(row){
 plain(row,['tenant','operation']);const op=row.operation;plain(op,OP_KEYS);
 if(!tenant(row.tenant)||!id(op.operationId)||!id(op.sessionId)||!['create-session','release-session'].includes(op.kind)||!['pending','succeeded','failed'].includes(op.status)||!date(op.createdAt)||!date(op.updatedAt))fail('STATE_INVALID','Invalid operation metadata');
 let error=null;
 if(op.error!==null){plain(op.error,['code','message']);if(!bounded(op.error.code,64)||!bounded(op.error.message,512))fail('STATE_INVALID','Invalid operation error');error={code:op.error.code,message:op.error.message};}
 if((op.status==='failed')!==(error!==null))fail('STATE_INVALID','Operation outcome and error disagree');
 return {tenant:row.tenant,operation:{...Object.fromEntries(OP_KEYS.map(key=>[key,op[key]])),error}};
}
function bindingRecord(row){
 plain(row,['tenant','keyHash','fingerprint','defaults','operationId']);plain(row.defaults,['region','ttlSeconds']);
 if(!tenant(row.tenant)||!hash(row.keyHash)||!hash(row.fingerprint)||!id(row.operationId)||!bounded(row.defaults.region,64)||!integer(row.defaults.ttlSeconds,1,86400))fail('STATE_INVALID','Invalid idempotency binding');
 return {tenant:row.tenant,keyHash:row.keyHash,fingerprint:row.fingerprint,defaults:{region:row.defaults.region,ttlSeconds:row.defaults.ttlSeconds},operationId:row.operationId};
}
function sessionLinks(row,lookup){
 const create=lookup(row.operationId),release=row.releaseOperationId===null?null:lookup(row.releaseOperationId);
 const matches=(value,kind)=>value?.tenant===row.tenant&&value.operation.sessionId===row.sessionId&&value.operation.kind===kind;
 if(!matches(create,'create-session')||row.releaseOperationId!==null&&!matches(release,'release-session'))fail('STATE_REFERENCE','Session operation references disagree');
 if(row.state==='creating'&&create.operation.status!=='pending'||row.state==='ready'&&create.operation.status!=='succeeded'||['closed','expired','failed'].includes(row.state)&&create.operation.status==='pending')fail('STATE_REFERENCE','Session and creation outcome disagree');
}
function bindingLinks(row,operation,session){
 if(!operation||!session||operation.tenant!==row.tenant||operation.operation.kind!=='create-session'||session.tenant!==row.tenant||row.defaults.region!==session.region||row.defaults.ttlSeconds!==session.ttlSeconds)fail('STATE_REFERENCE','Idempotency binding disagrees with its Session');
}
const encode=row=>{const body=JSON.stringify(row);if(Buffer.byteLength(body)>8192)fail('STATE_RECORD_LIMIT','Record metadata limit exceeded');return body;};
const format='remote-paint-session-ledger-v1';

// Single-owner ledger for control-plane transitions, not rendering data.
// EXCLUSIVE locking persists between committed DELETE-journal transactions:
// https://www.sqlite.org/pragma.html#pragma_locking_mode
// https://nodejs.org/download/release/latest-v22.x/docs/api/sqlite.html
export class SqliteSessionStore {
 #db;#maxSessions;#maxOperations;#maxBindings;#revision=0;#registryOwner=null;
 constructor({path,maxSessions=10000,maxOperations=maxSessions*18,maxBindings=maxSessions,maxDatabaseBytes=256*1024*1024}={}){
  if(!sessionStoreSupported)fail('STATE_RUNTIME_UNSUPPORTED','Session persistence requires Node.js22.13 or newer with node:sqlite on Linux/macOS');
  if(typeof path!=='string'||!isAbsolute(path)||!integer(maxSessions,1,100000)||!integer(maxOperations,1,1800000)||!integer(maxBindings,1,100000)||!integer(maxDatabaseBytes,1024*1024,1024*1024*1024))throw new TypeError('Invalid Session store configuration');
  this.#maxSessions=maxSessions;this.#maxOperations=maxOperations;this.#maxBindings=maxBindings;
  try{
   let created=false;
   try{const fd=openSync(path,'ax',0o600);closeSync(fd);created=true;}catch(error){if(error.code!=='EEXIST')throw error;}
   const stat=lstatSync(path);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||(stat.mode&0o077)!==0||process.getuid&&stat.uid!==process.getuid())fail('STATE_PERMISSIONS','Session ledger must be a private owned regular file');
   if(stat.size>maxDatabaseBytes)fail('STATE_DATABASE_LIMIT','Session ledger exceeds the configured database limit');
   const db=this.#db=new DatabaseSync(path);
   db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
   const names=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 5").all().map(x=>x.name);
   const empty=names.length===0;
   if(empty&&!created)fail('STATE_SCHEMA','Existing ledger has no valid Session schema');
   if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type IN ('trigger','view') LIMIT 1").get())fail('STATE_SCHEMA','Unexpected Session ledger schema objects');
   if(!empty){
    if(JSON.stringify(names)!==JSON.stringify(['bindings','metadata','operations','sessions'])||db.prepare('PRAGMA user_version').get().user_version!==1||db.prepare("SELECT value FROM metadata WHERE name='format'").get()?.value!==format)fail('STATE_SCHEMA','Unsupported Session ledger schema');
   }
   db.exec('COMMIT; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
   const pageSize=db.prepare('PRAGMA page_size').get().page_size;
   db.exec(`PRAGMA max_page_count=${Math.floor(maxDatabaseBytes/pageSize)}`);
   if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete'||db.prepare('PRAGMA synchronous').get().synchronous!==2||db.prepare('PRAGMA locking_mode').get().locking_mode!=='exclusive'||db.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)fail('STATE_CONFIGURATION','Session ledger durability configuration was not applied');
   if(empty){
    db.exec(`BEGIN EXCLUSIVE;
     CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
     CREATE TABLE sessions(session_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),UNIQUE(session_id,tenant)) STRICT;
     CREATE TABLE operations(operation_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,tenant TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),UNIQUE(operation_id,tenant),FOREIGN KEY(session_id,tenant) REFERENCES sessions(session_id,tenant)) STRICT;
     CREATE TABLE bindings(tenant TEXT NOT NULL,key_hash TEXT NOT NULL,operation_id TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),PRIMARY KEY(tenant,key_hash),FOREIGN KEY(operation_id,tenant) REFERENCES operations(operation_id,tenant)) STRICT;
     INSERT INTO metadata VALUES('format','${format}'),('revision','0');PRAGMA user_version=1;COMMIT;`);
   }
   const rawRevision=db.prepare("SELECT value FROM metadata WHERE name='revision'").get()?.value,revision=Number(rawRevision);
   if(typeof rawRevision!=='string'||!/^(0|[1-9][0-9]*)$/.test(rawRevision)||!Number.isSafeInteger(revision)||revision<0)fail('STATE_CORRUPT','Invalid Session ledger revision');
   this.#revision=revision;this.#counts();
  }catch(error){
   try{this.#db?.exec('ROLLBACK');}catch{}
   try{this.#db?.close();}catch{}
   this.#db=null;
   if(error instanceof SessionStoreError)throw error;
   fail([5,6].includes(error.errcode&255)?'STATE_IN_USE':'STATE_OPEN','Session ledger could not be opened',error);
  }
 }
 #open(){if(!this.#db)fail('STATE_CLOSED','Session ledger is closed');return this.#db;}
 claimRegistry(owner){
  this.#open();if(typeof owner!=='symbol')throw new TypeError('Expected an opaque registry owner');
  if(this.#registryOwner!==null&&this.#registryOwner!==owner)fail('STATE_IN_USE','Session ledger already has a Registry owner');
  this.#registryOwner=owner;
 }
 releaseRegistry(owner){if(this.#registryOwner!==owner)fail('STATE_IN_USE','Session ledger owner does not match');this.#registryOwner=null;}
 #owner(owner){if(this.#registryOwner!==owner&&!(this.#registryOwner===null&&owner===undefined))fail('STATE_IN_USE','Session ledger owner does not match');}

 #counts(){
  const db=this.#open(),out={sessions:db.prepare('SELECT count(*) AS count FROM sessions').get().count,operations:db.prepare('SELECT count(*) AS count FROM operations').get().count,bindings:db.prepare('SELECT count(*) AS count FROM bindings').get().count};
  if(out.sessions>this.#maxSessions||out.operations>this.#maxOperations||out.bindings>this.#maxBindings)fail('STATE_CAPACITY','Session ledger retention capacity exceeded');return out;
 }
 #decode(body,validate){
  if(typeof body!=='string'||Buffer.byteLength(body)>8192)fail('STATE_CORRUPT','Invalid stored record size');
  try{return validate(JSON.parse(body));}catch(error){fail('STATE_CORRUPT','Invalid stored Session metadata',error);}
 }
 load({owner}={}){
  this.#owner(owner);const db=this.#open();this.#counts();const sessions=[],operations=[],bindings=[];
  for(const row of db.prepare('SELECT session_id,tenant,CASE WHEN length(CAST(body AS BLOB))<=8192 THEN body ELSE NULL END AS body FROM sessions ORDER BY session_id').iterate()){
   const value=this.#decode(row.body,sessionRecord);if(value.sessionId!==row.session_id||value.tenant!==row.tenant)fail('STATE_CORRUPT','Session identity disagrees with stored index');sessions.push(value);
  }
  for(const row of db.prepare('SELECT operation_id,session_id,tenant,CASE WHEN length(CAST(body AS BLOB))<=8192 THEN body ELSE NULL END AS body FROM operations ORDER BY operation_id').iterate()){
   const value=this.#decode(row.body,operationRecord);if(value.tenant!==row.tenant||value.operation.operationId!==row.operation_id||value.operation.sessionId!==row.session_id)fail('STATE_CORRUPT','Operation identity disagrees with stored index');operations.push(value);
  }
  for(const row of db.prepare('SELECT tenant,key_hash,operation_id,CASE WHEN length(CAST(body AS BLOB))<=8192 THEN body ELSE NULL END AS body FROM bindings ORDER BY tenant,key_hash').iterate()){
   const value=this.#decode(row.body,bindingRecord);if(value.tenant!==row.tenant||value.keyHash!==row.key_hash||value.operationId!==row.operation_id)fail('STATE_CORRUPT','Binding identity disagrees with stored index');bindings.push(value);
  }
  if(db.prepare('PRAGMA foreign_key_check').get())fail('STATE_CORRUPT','Session ledger contains orphaned references');
  try{
   const byOperation=new Map(operations.map(row=>[row.operation.operationId,row])),bySession=new Map(sessions.map(row=>[row.sessionId,row]));
   const bound=new Map();for(const binding of bindings){const list=bound.get(binding.operationId)??[];list.push(binding);bound.set(binding.operationId,list);}
   for(const row of sessions){sessionLinks(row,id=>byOperation.get(id));if(bound.get(row.operationId)?.length!==1)fail('STATE_REFERENCE','Each Session requires its original unique creation binding');}
   for(const row of bindings){const operation=byOperation.get(row.operationId);bindingLinks(row,operation,bySession.get(operation?.operation.sessionId));}
  }catch(error){fail('STATE_CORRUPT','Session ledger references are inconsistent',error);}
  return {revision:this.#revision,sessions,operations,bindings};
 }
 commit({sessions=[],operations=[],bindings=[]}={}, {owner}={}){
  this.#owner(owner);const db=this.#open();
  if(!Array.isArray(sessions)||!Array.isArray(operations)||!Array.isArray(bindings)||sessions.length+operations.length+bindings.length>1000)fail('STATE_BATCH_LIMIT','Session ledger batch limit exceeded');
  const batch={sessions:sessions.map(sessionRecord),operations:operations.map(operationRecord),bindings:bindings.map(bindingRecord)};
  for(const list of Object.values(batch))for(const value of list)encode(value);
  try{
   db.exec('BEGIN IMMEDIATE');
   for(const row of batch.sessions){
    const prior=db.prepare('SELECT body FROM sessions WHERE session_id=?').get(row.sessionId);
    if(prior){
     const old=this.#decode(prior.body,sessionRecord);
     if(old.sessionId!==row.sessionId)fail('STATE_CORRUPT','Session index and metadata disagree');
     if(['tenant','region','createdAt','operationId'].some(key=>old[key]!==row[key])||!old.reserved&&row.reserved||old.closeAttempts>row.closeAttempts||old.version!==null&&row.version!==old.version||row.state==='creating'&&old.state!=='creating'||row.state==='ready'&&!['creating','ready'].includes(old.state)||['closed','expired'].includes(old.state)&&encode(old)!==encode(row))fail('STATE_CONFLICT','Session identity or closed state cannot be rebound');
    }
    db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET body=excluded.body').run(row.sessionId,row.tenant,encode(row));
   }
   for(const row of batch.operations){
    const op=row.operation,prior=db.prepare('SELECT body FROM operations WHERE operation_id=?').get(op.operationId);
    if(prior){const old=this.#decode(prior.body,operationRecord);if(old.operation.operationId!==op.operationId)fail('STATE_CORRUPT','Operation index and metadata disagree');if(old.tenant!==row.tenant||['sessionId','kind','createdAt'].some(key=>old.operation[key]!==op[key])||old.operation.status!=='pending'&&encode(old)!==encode(row))fail('STATE_CONFLICT','Operation identity or terminal outcome cannot be rewritten');}
    db.prepare('INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET body=excluded.body').run(op.operationId,op.sessionId,row.tenant,encode(row));
   }
   for(const row of batch.bindings){
    const prior=db.prepare('SELECT body FROM bindings WHERE tenant=? AND key_hash=?').get(row.tenant,row.keyHash);
    if(prior&&encode(this.#decode(prior.body,bindingRecord))!==encode(row))fail('STATE_CONFLICT','Idempotency binding cannot be rewritten');
    if(!prior)db.prepare('INSERT INTO bindings VALUES(?,?,?,?)').run(row.tenant,row.keyHash,row.operationId,encode(row));
   }
   this.#counts();
   const operation=id=>{const row=db.prepare('SELECT body FROM operations WHERE operation_id=?').get(id);return row?this.#decode(row.body,operationRecord):undefined;};
   const session=id=>{const row=db.prepare('SELECT body FROM sessions WHERE session_id=?').get(id);return row?this.#decode(row.body,sessionRecord):undefined;};
   const touched=new Set([...batch.sessions.map(row=>row.sessionId),...batch.operations.map(row=>row.operation.sessionId)]);
   for(const row of batch.bindings){const target=operation(row.operationId),parent=session(target?.operation.sessionId??'');bindingLinks(row,target,parent);touched.add(parent.sessionId);}
   for(const id of touched){const row=session(id);sessionLinks(row,operation);const bound=db.prepare('SELECT body FROM bindings WHERE operation_id=? LIMIT 2').all(row.operationId);if(bound.length!==1)fail('STATE_REFERENCE','Each Session requires its original unique creation binding');bindingLinks(this.#decode(bound[0].body,bindingRecord),operation(row.operationId),row);}
   const next=this.#revision+1;if(!Number.isSafeInteger(next))fail('STATE_CAPACITY','Session ledger revision exhausted');
   db.prepare("UPDATE metadata SET value=? WHERE name='revision'").run(String(next));db.exec('COMMIT');this.#revision=next;return {revision:next};
  }catch(error){
   try{db.exec('ROLLBACK');}catch{}
   if(error instanceof SessionStoreError)throw error;
   fail('STATE_WRITE','Session ledger transaction failed',error);
  }
 }
 close(){if(!this.#db)return;if(this.#registryOwner!==null)fail('STATE_IN_USE','Registry must finish shutdown before closing its ledger');this.#db.close();this.#db=null;}
}
