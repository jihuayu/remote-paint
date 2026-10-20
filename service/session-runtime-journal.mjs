// Internal extension of the same private SQLite Session ledger. Acknowledged
// intents describe ownership; they do not attest Docker or kernel effects.
export const runtimeSchemaSql=`
 CREATE TABLE runtime_providers(region TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192)) STRICT;
 CREATE TABLE runtimes(session_id TEXT PRIMARY KEY,tenant TEXT NOT NULL,region TEXT NOT NULL,container_name TEXT NOT NULL UNIQUE,container_id TEXT UNIQUE,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=8192),FOREIGN KEY(session_id,tenant) REFERENCES sessions(session_id,tenant),FOREIGN KEY(region) REFERENCES runtime_providers(region)) STRICT;`;
const plain=(v,keys)=>v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const date=v=>typeof v==='string'&&v.length<=32&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const region=v=>typeof v==='string'&&v.length>0&&v.length<=64;
const providerKeys=['region','deploymentId','daemonId','createdAt'];
const keys=['sessionId','tenant','region','deploymentId','daemonId','ownerKeyHash','specDigest','imageId','containerName','containerId','state','requestStarted','version','closeReason','retirement','createdAt','updatedAt'];
const immutable=['sessionId','tenant','region','deploymentId','daemonId','ownerKeyHash','specDigest','imageId','containerName','createdAt'];
const transitions={intent:['intent','requested','closing','retired'],requested:['requested','created','closing'],created:['created','ready','closing'],ready:['ready','closing'],closing:['closing','retired'],retired:['retired']};
const reasons=new Set(['released','ttl-expired','registry-shutdown','registry-recovery','registry-storage-fault','startup-failed','startup-cancelled','worker-unavailable']);
export function createSessionRuntimeJournal(db,{fail,isStoreError,validateSession,maxSessions}){
 const owners=new Map(),regions=new Map(),recovery=new Map();
 const reject=(code,message)=>fail('STATE_RUNTIME_'+code,message);
 const encode=row=>{const s=JSON.stringify(row);if(Buffer.byteLength(s)>8192)reject('LIMIT','Runtime metadata exceeds8192bytes');return s;};
 function provider(row){
  if(!plain(row,providerKeys)||!region(row.region)||!id(row.deploymentId)||!id(row.daemonId)||!date(row.createdAt))reject('INVALID','Invalid runtime provider identity');return {...row};
 }
 function record(row){
  if(!plain(row,keys)||!id(row.sessionId)||typeof row.tenant!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.tenant)||!region(row.region)||!id(row.deploymentId)||!id(row.daemonId)||!hash(row.ownerKeyHash)||!hash(row.specDigest)||typeof row.imageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(row.imageId)||typeof row.containerName!=='string'||!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(row.containerName)||!(row.containerId===null||hash(row.containerId))||typeof row.state!=='string'||!Object.hasOwn(transitions,row.state)||typeof row.requestStarted!=='boolean'||!(row.version===null||typeof row.version==='string'&&row.version.length>0&&row.version.length<=256)||!(row.closeReason===null||reasons.has(row.closeReason))||!date(row.createdAt)||!date(row.updatedAt)||row.updatedAt<row.createdAt)reject('INVALID','Invalid runtime ownership record');
  if(row.state==='intent'&&(row.requestStarted||row.containerId!==null)||row.state==='requested'&&(!row.requestStarted||row.containerId!==null)||['created','ready'].includes(row.state)&&(!row.requestStarted||row.containerId===null)||row.containerId!==null&&!row.requestStarted||row.state==='ready'&&row.version===null||['intent','requested','created'].includes(row.state)&&row.version!==null)reject('INVALID','Runtime phase and identity disagree');
  if(['closing','retired'].includes(row.state)!==(row.closeReason!==null))reject('INVALID','Runtime closure lacks its fixed reason');
  if(row.state==='retired'){
   if(!plain(row.retirement,['kind','evidenceSha256'])||!hash(row.retirement.evidenceSha256)||!['not-dispatched','container-removed'].includes(row.retirement.kind))reject('INVALID','Runtime retirement requires explicit evidence identity');
   if(row.retirement.kind==='not-dispatched'&&(row.requestStarted||row.containerId!==null)||row.retirement.kind==='container-removed'&&(!row.requestStarted||row.containerId===null))reject('INVALID','Unknown allocation cannot be attested retired');
  }else if(row.retirement!==null)reject('INVALID','Live runtime cannot carry retirement evidence');
  const copy=Object.fromEntries(keys.map(k=>[k,row[k]]));if(copy.retirement)copy.retirement={...copy.retirement};encode(copy);return copy;
 }
 function decode(body,validate){try{if(typeof body!=='string'||Buffer.byteLength(body)>8192)throw new Error('Invalid record size');return validate(JSON.parse(body));}catch(error){fail('STATE_CORRUPT','Invalid stored runtime ownership metadata',error);}}
 function revision(){const v=db.prepare("SELECT value FROM metadata WHERE name='runtime_revision'").get()?.value,n=Number(v);if(typeof v!=='string'||!/^(0|[1-9][0-9]*)$/.test(v)||!Number.isSafeInteger(n))fail('STATE_CORRUPT','Invalid runtime ledger revision');return n;}
 function counts(){if(db.prepare('SELECT count(*) AS n FROM runtime_providers').get().n>64||db.prepare('SELECT count(*) AS n FROM runtimes').get().n>maxSessions)reject('LIMIT','Runtime ledger retention capacity exceeded');}
 function binding(key){const row=db.prepare('SELECT body FROM runtime_providers WHERE region=?').get(key);return row?decode(row.body,provider):null;}
 function runtime(key){const row=db.prepare('SELECT session_id,tenant,region,container_name,container_id,body FROM runtimes WHERE session_id=?').get(key);if(!row)return null;const value=decode(row.body,record);if(value.sessionId!==row.session_id||value.tenant!==row.tenant||value.region!==row.region||value.containerName!==row.container_name||value.containerId!==row.container_id)fail('STATE_CORRUPT','Runtime identity disagrees with its stored index');return value;}
 function session(key){const row=db.prepare('SELECT body FROM sessions WHERE session_id=?').get(key);return row?decode(row.body,validateSession):null;}
 function reference(row){const parent=session(row.sessionId),p=binding(row.region);if(!parent||parent.tenant!==row.tenant||parent.region!==row.region||!p||p.deploymentId!==row.deploymentId||p.daemonId!==row.daemonId||!parent.reserved&&row.state!=='retired')reject('REFERENCE','Runtime ownership disagrees with its Session or provider');return parent;}
 function authorize(owner){if(typeof owner!=='symbol'||!owners.has(owner))reject('OWNER','Runtime provider owner is missing or stale');return owners.get(owner);}
 function transaction(action){
  try{db.exec('BEGIN IMMEDIATE');const value=action();counts();const next=revision()+1;if(!Number.isSafeInteger(next))reject('LIMIT','Runtime revision exhausted');db.prepare("UPDATE metadata SET value=? WHERE name='runtime_revision'").run(String(next));db.exec('COMMIT');return {revision:next,...value};}
  catch(error){try{db.exec('ROLLBACK');}catch{}if(isStoreError(error))throw error;fail('STATE_RUNTIME_WRITE','Runtime ownership transaction failed',error);}
 }
 function validate(){
  counts();revision();for(const row of db.prepare('SELECT region,body FROM runtime_providers').iterate()){const value=decode(row.body,provider);if(value.region!==row.region)fail('STATE_CORRUPT','Runtime provider index disagrees with its identity');}
  for(const row of db.prepare('SELECT session_id FROM runtimes').iterate())reference(runtime(row.session_id));
  for(const row of db.prepare('SELECT body FROM sessions').iterate()){
   const value=decode(row.body,validateSession);if(!binding(value.region))continue;const owned=runtime(value.sessionId);if(value.state==='ready'&&(!owned||owned.version!==value.version))fail('STATE_CORRUPT','Ready Native Session lacks its recorded runtime identity');
  }
 }
 return {
  get claimed(){return owners.size>0;},
  validate,
  claim(owner,value){
   if(typeof owner!=='symbol')throw new TypeError('Expected an opaque runtime provider owner');const row=provider(value);if(owners.has(owner)&&owners.get(owner)!==row.region||regions.has(row.region)&&regions.get(row.region)!==owner)reject('OWNER','Runtime region already has another owner');
   const previous=binding(row.region);
   if(previous&&['region','deploymentId','daemonId'].some(k=>previous[k]!==row[k]))reject('CONFLICT','Runtime deployment or daemon cannot be rebound');
   if(!previous){for(const stored of db.prepare('SELECT body FROM sessions').iterate()){const s=decode(stored.body,validateSession);if(s.region===row.region&&s.reserved)reject('LEGACY_LIVE','Existing live Sessions have no trustworthy Native runtime binding');}}
   validate();const result=previous?{revision:revision(),provider:previous}:transaction(()=>{db.prepare('INSERT INTO runtime_providers VALUES(?,?)').run(row.region,encode(row));return {provider:row};});if(!owners.has(owner))recovery.set(owner,new Set(db.prepare('SELECT session_id FROM runtimes WHERE region=?').all(row.region).map(x=>x.session_id)));owners.set(owner,row.region);regions.set(row.region,owner);return structuredClone({...result,recoveryRequired:[...recovery.get(owner)].sort()});
  },
  release(owner){const key=authorize(owner);owners.delete(owner);regions.delete(key);recovery.delete(owner);},
  snapshot(owner){const key=authorize(owner);validate();const allocations=[];for(const row of db.prepare('SELECT session_id FROM runtimes WHERE region=? ORDER BY session_id').iterate(key))allocations.push(runtime(row.session_id));return {revision:revision(),provider:binding(key),allocations,recoveryRequired:[...recovery.get(owner)].sort()};},
  commit(value,owner){
   const key=authorize(owner),row=record(value);if(row.region!==key)reject('OWNER','Runtime provider cannot write another region');
   return transaction(()=>{
    const parent=reference(row),old=runtime(row.sessionId);
    if(recovery.get(owner).has(row.sessionId)&&!['closing','retired'].includes(row.state))reject('RECOVERY_REQUIRED','Recovered allocations can only be closed,never dispatched or made Ready again');
    if(old?.state==='requested'&&row.state==='requested')reject('CONFLICT','Dispatch intent is one-use and cannot authorize a repeated allocation');
    if(!old){if(row.state!=='intent'||row.requestStarted||row.containerId!==null||parent.state!=='creating'||!parent.reserved)reject('CONFLICT','A new runtime requires a reserved creating Session and an undispatched intent');}
    else{
     if(immutable.some(k=>old[k]!==row[k])||row.updatedAt<old.updatedAt||!transitions[old.state].includes(row.state)||old.containerId!==null&&old.containerId!==row.containerId||old.version!==null&&old.version!==row.version||old.closeReason!==null&&old.closeReason!==row.closeReason||old.state==='retired'&&encode(old)!==encode(row))reject('CONFLICT','Runtime ownership or terminal history cannot be rewritten');
     if(!old.requestStarted&&row.requestStarted&&(old.state!=='intent'||row.state!=='requested')||old.requestStarted&&!row.requestStarted)reject('CONFLICT','Runtime dispatch must be durably recorded before allocation and cannot begin after closure');
     if(old.containerId===null&&row.containerId!==null&&(!old.requestStarted||!['created','closing'].includes(row.state)))reject('CONFLICT','Runtime container identity requires an earlier dispatch intent');
     if(old.version===null&&row.version!==null&&(old.state!=='created'||row.state!=='ready'))reject('CONFLICT','A closing runtime cannot publish a late Ready');
    }
    if(row.state==='ready'&&parent.version!==null&&parent.version!==row.version)reject('REFERENCE','Runtime version disagrees with its Session');
    db.prepare('INSERT INTO runtimes VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET body=excluded.body,container_id=excluded.container_id').run(row.sessionId,row.tenant,row.region,row.containerName,row.containerId,encode(row));return {allocation:row};
   });
  },
  checkSession(row){
   if(!binding(row.region))return;const value=runtime(row.sessionId);
   if(row.state==='ready'&&(!value||value.state!=='ready'||value.version!==row.version))fail('STATE_REFERENCE','Native Session Ready requires its confirmed runtime Ready record');
   if(!row.reserved&&value?.state!=='retired'&&value!==null)fail('STATE_REFERENCE','Session quota cannot be released before runtime retirement');
  }
 };
}
