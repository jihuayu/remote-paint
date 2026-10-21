// Private authenticated receiver storage. Acceptance is durable inbox storage,
// never application execution, Source closure or proof of a remote side effect.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,fstatSync,fsyncSync,closeSync,constants} from 'node:fs';
import {isAbsolute,join,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {createAgentWebhookAuthenticator} from './agent-webhook-auth.mjs';
import {parseAgentEventBody} from './agent-event-schema.mjs';

export class AgentWebhookInboxError extends Error {
 constructor(code){super('Agent Webhook inbox operation failed');this.name='AgentWebhookInboxError';this.code=code;}
}
const fail=code=>{throw new AgentWebhookInboxError('AGENT_WEBHOOK_INBOX_'+code);};
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const id=(v,p)=>typeof v==='string'&&new RegExp('^'+p+'_'+uuid+'$').test(v);
const tenant=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const digest=b=>createHash('sha256').update(b).digest('hex');
const identity=s=>[s.dev,s.ino];
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function record(v,required,optional=[]){
 if(!v||types.isProxy(v)||![Object.prototype,null].includes(Object.getPrototypeOf(v)))fail('INVALID');
 const ds=Object.getOwnPropertyDescriptors(v),ks=Reflect.ownKeys(ds);
 if(required.some(k=>!Object.hasOwn(ds,k))||ks.some(k=>typeof k!=='string'||![...required,...optional].includes(k)||!Object.hasOwn(ds[k],'value')))fail('INVALID');
 return Object.fromEntries(ks.map(k=>[k,ds[k].value]));
}
const metadataSql='CREATE TABLE metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT';
const inboxSql='CREATE TABLE inbox(position INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,agent_run_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence>=1 AND sequence<=9007199254740991),body BLOB NOT NULL CHECK(length(body)>=1 AND length(body)<=4096),body_sha256 TEXT NOT NULL,UNIQUE(agent_run_id,sequence)) STRICT';
function envelope(bytes,endpointId,eventId){
 let value,text;
 try{
  text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);value=record(JSON.parse(text),['schema','endpointId','subscriptionId','event']);
  if(value.schema!=='agent-webhook-v1'||value.endpointId!==endpointId||!id(value.subscriptionId,'awsub')||JSON.stringify(value)!==text)throw Error();
  const event=parseAgentEventBody(JSON.stringify(value.event));if(event.eventId!==eventId)throw Error();return value;
 }catch{fail('BODY');}
}

export function createAgentWebhookInbox(config){
 const v=record(config,['directory','tenantId','endpointId','keys','activeKeyId'],['maxEvents','maxDatabaseBytes']);
 const {directory,tenantId,endpointId}=v,maxEvents=Object.hasOwn(v,'maxEvents')?v.maxEvents:1024,maxDatabaseBytes=Object.hasOwn(v,'maxDatabaseBytes')?v.maxDatabaseBytes:16*1024*1024;
 if(typeof directory!=='string'||!isAbsolute(directory)||directory.length>2048||/[\x00-\x1f\x7f]/.test(directory)||!tenant(tenantId)||!id(endpointId,'awh')||!integer(maxEvents,1,10000)||!integer(maxDatabaseBytes,1024*1024,64*1024*1024))fail('INVALID');
 let auth,db,dirFd,dirIdentity,fileIdentity,closed=false,faulted=false,instanceId;
 const path=join(directory,'inbox.sqlite'),owned=s=>!process.getuid||s.uid===process.getuid();
 function directoryStat(s){if(!s.isDirectory()||s.isSymbolicLink?.()||(s.mode&0o777)!==0o700||!owned(s)||dirIdentity&&!same(identity(s),dirIdentity))fail('IDENTITY');}
 function fileStat(s){if(!s.isFile()||s.isSymbolicLink?.()||s.nlink!==1||(s.mode&0o777)!==0o600||!owned(s)||s.size>maxDatabaseBytes||fileIdentity&&!same(identity(s),fileIdentity))fail('IDENTITY');}
 function check(){
  if(closed)fail('CLOSED');if(faulted)fail('FAULTED');
  try{directoryStat(lstatSync(directory));directoryStat(fstatSync(dirFd));fileStat(lstatSync(path));}catch{faulted=true;fail('IDENTITY');}
 }
 function syncDirectory(){check();fsyncSync(dirFd);check();}
 function count(){const n=db.prepare('SELECT count(*) AS n FROM inbox').get().n;if(!integer(n,0,maxEvents))fail('CORRUPT');return n;}
 function decode(row){
  if(!row||!integer(row.position,1,maxEvents)||!id(row.event_id,'aevt')||!id(row.agent_run_id,'arun')||!integer(row.sequence,1,Number.MAX_SAFE_INTEGER)||!types.isUint8Array(row.body)||row.body.length>4096||typeof row.body_sha256!=='string'||digest(row.body)!==row.body_sha256)fail('CORRUPT');
  let value;try{value=envelope(row.body,endpointId,row.event_id);}catch{fail('CORRUPT');}
  if(value.event.agentRunId!==row.agent_run_id||value.event.sequence!==row.sequence)fail('CORRUPT');return value;
 }
 function checkRun(value){
  const row=db.prepare('SELECT * FROM inbox WHERE agent_run_id=? ORDER BY sequence LIMIT 1').get(value.event.agentRunId);if(!row)return;
  const first=decode(row);if(value.subscriptionId!==first.subscriptionId||['sessionId','region','version'].some(k=>value.event[k]!==first.event[k]))fail('CONFLICT');
 }
 function cleanup(){let error;for(const fn of [()=>auth?.close(),()=>db?.close(),()=>{if(dirFd!==undefined)closeSync(dirFd);}])try{fn();}catch(e){error??=e;}return error;}
 try{
  auth=createAgentWebhookAuthenticator({endpointId,keys:v.keys,activeKeyId:v.activeKeyId});
  let createdDirectory=false;try{mkdirSync(directory,{mode:0o700});createdDirectory=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  directoryStat(lstatSync(directory));dirFd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);directoryStat(fstatSync(dirFd));dirIdentity=identity(fstatSync(dirFd));
  if(createdDirectory){let parentFd;try{parentFd=openSync(dirname(directory),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);fsyncSync(parentFd);}finally{if(parentFd!==undefined)closeSync(parentFd);}}
  let created=false;
  try{const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);closeSync(fd);created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
  // Never open/close a raw descriptor for an existing SQLite ledger: POSIX
  // close() could release another connection's process-owned advisory locks.
  fileStat(lstatSync(path));fileIdentity=identity(lstatSync(path));check();db=new DatabaseSync(path);check();
  db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
  const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  if(!created&&(tables.length!==2||tables[0].name!=='inbox'||tables[0].sql!==inboxSql||tables[1].name!=='metadata'||tables[1].sql!==metadataSql))fail('SCHEMA');
  if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type NOT IN ('table','index') OR type='index' AND sql IS NOT NULL LIMIT 1").get())fail('SCHEMA');
  if(created&&tables.length)fail('SCHEMA');
  db.exec('COMMIT; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL');
  const pageSize=db.prepare('PRAGMA page_size').get().page_size,allowedPages=Math.floor(maxDatabaseBytes/pageSize);
  if(db.prepare('PRAGMA max_page_count='+allowedPages).get().max_page_count>allowedPages)fail('CAPACITY');
  if(db.prepare('PRAGMA journal_mode').get().journal_mode!=='delete'||db.prepare('PRAGMA synchronous').get().synchronous!==2||db.prepare('PRAGMA locking_mode').get().locking_mode!=='exclusive')fail('CONFIGURATION');
  if(created){
   instanceId=randomUUID();db.exec('BEGIN IMMEDIATE');db.exec(metadataSql);db.exec(inboxSql);
   const insert=db.prepare('INSERT INTO metadata VALUES(?,?)');for(const [k,value] of Object.entries({format:'remote-paint-webhook-inbox-v1',instance_id:instanceId,tenant:tenantId,endpoint:endpointId,max_events:String(maxEvents),max_database_bytes:String(maxDatabaseBytes)}))insert.run(k,value);
   db.exec('PRAGMA user_version=1');db.exec('COMMIT');syncDirectory();
  }
  const meta=Object.fromEntries(db.prepare('SELECT name,value FROM metadata').all().map(x=>[x.name,x.value]));
  if(Reflect.ownKeys(meta).length!==6||meta.format!=='remote-paint-webhook-inbox-v1'||typeof meta.instance_id!=='string'||!new RegExp('^'+uuid+'$').test(meta.instance_id)||meta.tenant!==tenantId||meta.endpoint!==endpointId||meta.max_events!==String(maxEvents)||meta.max_database_bytes!==String(maxDatabaseBytes)||db.prepare('PRAGMA user_version').get().user_version!==1)fail('BINDING');
  instanceId=meta.instance_id;if(db.prepare('PRAGMA quick_check(1)').get().quick_check!=='ok')fail('CORRUPT');
  const n=count();let seen=0;for(const row of db.prepare('SELECT * FROM inbox ORDER BY position').iterate()){seen++;if(row.position!==seen)fail('CORRUPT');const value=decode(row);try{checkRun(value);}catch{fail('CORRUPT');}}if(seen!==n)fail('CORRUPT');syncDirectory();
 }catch(error){try{db?.exec('ROLLBACK');}catch{}cleanup();closed=true;if(error instanceof AgentWebhookInboxError)throw error;fail('OPEN');}
 // Do not retain caller-owned keys/config. The authenticator owns private copies.
 v.keys=null;config=null;
 return Object.freeze({
  accept(input){
   check();const request=record(input,['eventId','signature','body']);let verified;
   try{verified=auth.verify(request);}catch{fail('AUTH');}
   const value=envelope(verified.body,endpointId,verified.eventId),hash=digest(verified.body);check();
   let result;
   try{
    db.exec('BEGIN IMMEDIATE');check();
    const existing=db.prepare('SELECT * FROM inbox WHERE event_id=?').get(verified.eventId);
    if(existing){decode(existing);if(existing.body_sha256!==hash||!Buffer.from(existing.body).equals(verified.body))fail('CONFLICT');result={status:200,duplicate:true,ack:{schema:'agent-webhook-ack-v1',eventId:verified.eventId,bodySha256:hash}};}
    else{
     checkRun(value);if(db.prepare('SELECT 1 FROM inbox WHERE agent_run_id=? AND sequence=?').get(value.event.agentRunId,value.event.sequence))fail('CONFLICT');const n=count();if(n===maxEvents)fail('CAPACITY');
     db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?)').run(n+1,verified.eventId,value.event.agentRunId,value.event.sequence,verified.body,hash);result={status:202,duplicate:false,ack:{schema:'agent-webhook-ack-v1',eventId:verified.eventId,bodySha256:hash}};
    }
    check();db.exec('COMMIT');syncDirectory();
   }catch(error){try{db.exec('ROLLBACK');}catch{faulted=true;}if(error instanceof AgentWebhookInboxError)throw error;faulted=true;fail('WRITE_UNKNOWN');}
   return Object.freeze({...result,ack:Object.freeze(result.ack)});
  },
  read(options={}){
   check();const v=record(options,[],['after','limit']),after=Object.hasOwn(v,'after')?v.after:0,limit=Object.hasOwn(v,'limit')?v.limit:4;if(!integer(after,0,maxEvents)||!integer(limit,1,4))fail('INVALID');
   const n=count();if(after>n)fail('CURSOR');const rows=db.prepare('SELECT * FROM inbox WHERE position>? ORDER BY position LIMIT ?').all(after,limit);
   const events=rows.map(row=>({position:row.position,bodySha256:row.body_sha256,envelope:decode(row)}));check();return {after,nextCursor:rows.at(-1)?.position??after,hasMore:(rows.at(-1)?.position??after)<n,events};
  },
  identity(){check();return Object.freeze({instanceId,tenantId,endpointId,device:String(fileIdentity[0]),inode:String(fileIdentity[1]),maxEvents,maxDatabaseBytes});},
  close(){if(closed)return;closed=true;const error=cleanup();if(error)fail('CLOSE');}
 });
}
