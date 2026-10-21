// Frozen v1 validator for atomic upgrade only; no live API uses this journal.
import {createHash,randomUUID} from 'node:crypto';

const AGENT_WEBHOOK_FORMAT='remote-paint-agent-webhooks-v1';
const AGENT_WEBHOOK_LIMITS=Object.freeze({subscriptions:64,perRun:4,pending:64,bodyBytes:4096,page:4});
export const legacyAgentWebhookSchemaSql=`
 CREATE TABLE agent_webhooks(subscription_id TEXT PRIMARY KEY,agent_run_id TEXT NOT NULL,tenant TEXT NOT NULL,session_id TEXT NOT NULL,endpoint_id TEXT NOT NULL,start_after INTEGER NOT NULL,queued_through INTEGER NOT NULL,observed_latest INTEGER NOT NULL,missing_from INTEGER,UNIQUE(agent_run_id,endpoint_id),UNIQUE(subscription_id,agent_run_id,tenant,session_id),FOREIGN KEY(agent_run_id,tenant,session_id) REFERENCES agent_runs(agent_run_id,tenant,session_id)) STRICT;
 CREATE TABLE agent_webhook_deliveries(subscription_id TEXT NOT NULL,agent_run_id TEXT NOT NULL,tenant TEXT NOT NULL,session_id TEXT NOT NULL,sequence INTEGER NOT NULL,event_id TEXT NOT NULL,body TEXT NOT NULL CHECK(length(CAST(body AS BLOB))<=4096),body_sha256 TEXT NOT NULL,PRIMARY KEY(subscription_id,sequence),UNIQUE(subscription_id,event_id),FOREIGN KEY(subscription_id,agent_run_id,tenant,session_id) REFERENCES agent_webhooks(subscription_id,agent_run_id,tenant,session_id)) STRICT;`;
const integer=(v,min=0)=>Number.isSafeInteger(v)&&v>=min;
const id=(v,prefix)=>typeof v==='string'&&new RegExp('^'+prefix+'_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$').test(v);
const digest=body=>createHash('sha256').update(body).digest('hex');
const plain=(v,keys)=>!!v&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&Object.hasOwn(Object.getOwnPropertyDescriptor(v,k),'value'));

// Private capture journal. Delivery/acknowledgment belongs to a later extension;
// no operation here can claim acceptance, release a Source, or skip a gap.
export function createLegacyAgentWebhookJournal(db,{fail,isStoreError,events}){
 const corrupt=()=>fail('STATE_CORRUPT','Invalid stored Agent webhook capture');
 const reject=(code,message)=>fail('STATE_WEBHOOK_'+code,message);
 function revision(){const value=db.prepare("SELECT value FROM metadata WHERE name='agent_webhook_revision'").get()?.value,n=Number(value);if(typeof value!=='string'||!/^(0|[1-9][0-9]*)$/.test(value)||!integer(n))corrupt();return n;}
 function bump(){const next=revision()+1;if(!integer(next))reject('LIMIT','Webhook revision exhausted');db.prepare("UPDATE metadata SET value=? WHERE name='agent_webhook_revision'").run(String(next));}
 function transaction(action){try{db.exec('BEGIN IMMEDIATE');const value=action();db.exec('COMMIT');return structuredClone(value);}catch(error){try{db.exec('ROLLBACK');}catch{}if(isStoreError(error))throw error;fail('STATE_WEBHOOK_WRITE','Webhook capture transaction failed',error);}}
 function parent(s){const r=db.prepare('SELECT body FROM agent_runs WHERE agent_run_id=? AND tenant=? AND session_id=?').get(s.agent_run_id,s.tenant,s.session_id);if(!r)corrupt();return JSON.parse(r.body);}
 function rows(s){return db.prepare('SELECT * FROM agent_webhook_deliveries WHERE subscription_id=? ORDER BY sequence LIMIT 65').all(s.subscription_id);}
 function body(s,e){const text=JSON.stringify({schema:'agent-webhook-v1',endpointId:s.endpoint_id,subscriptionId:s.subscription_id,event:e});if(Buffer.byteLength(text)>AGENT_WEBHOOK_LIMITS.bodyBytes)reject('LIMIT','Webhook body exceeds its byte limit');return text;}
 function validate(s){
  if(!id(s.subscription_id,'awsub')||!id(s.endpoint_id,'awh')||!integer(s.start_after)||!integer(s.queued_through,s.start_after)||!integer(s.observed_latest,s.queued_through)||s.queued_through-s.start_after>AGENT_WEBHOOK_LIMITS.pending||!(s.missing_from===null?s.observed_latest===s.queued_through:s.missing_from===s.queued_through+1&&s.observed_latest>=s.missing_from&&s.queued_through-s.start_after===AGENT_WEBHOOK_LIMITS.pending))corrupt();
  const run=parent(s),head=events.captureWindow(run);if(s.observed_latest!==head.latestSequence)corrupt();
  const pending=rows(s);if(pending.length!==s.queued_through-s.start_after)corrupt();
  for(const [i,r]of pending.entries()){
   if(r.sequence!==s.start_after+i+1||r.agent_run_id!==s.agent_run_id||r.tenant!==s.tenant||r.session_id!==s.session_id||typeof r.body!=='string'||Buffer.byteLength(r.body)>AGENT_WEBHOOK_LIMITS.bodyBytes||r.body_sha256!==digest(r.body))corrupt();
   let value;try{value=JSON.parse(r.body);}catch{corrupt();}
   if(!plain(value,['schema','endpointId','subscriptionId','event'])||value.schema!=='agent-webhook-v1'||value.endpointId!==s.endpoint_id||value.subscriptionId!==s.subscription_id||value.event?.eventId!==r.event_id||value.event?.sequence!==r.sequence||body(s,value.event)!==r.body)corrupt();
   events.validateCaptured(run,value.event);
   const retained=head.events.find(e=>e.sequence===r.sequence);if(retained&&JSON.stringify(retained)!==JSON.stringify(value.event))corrupt();
  }
  return pending;
 }
 function info(s){return {schema:'agent-webhook-capture-v1',subscriptionId:s.subscription_id,agentRunId:s.agent_run_id,sessionId:s.session_id,endpointId:s.endpoint_id,after:s.start_after,queuedThrough:s.queued_through,observedLatest:s.observed_latest,pending:s.queued_through-s.start_after,reconciliationRequired:s.missing_from!==null,missingFrom:s.missing_from,missingThrough:s.missing_from===null?null:s.observed_latest};}
 function enqueue(s,e){const text=body(s,e);db.prepare('INSERT INTO agent_webhook_deliveries VALUES(?,?,?,?,?,?,?,?)').run(s.subscription_id,s.agent_run_id,s.tenant,s.session_id,e.sequence,e.eventId,text,digest(text));s.queued_through=e.sequence;}
 return {
  validate(){revision();const all=db.prepare('SELECT * FROM agent_webhooks ORDER BY subscription_id LIMIT 65').all();if(all.length>AGENT_WEBHOOK_LIMITS.subscriptions)corrupt();const counts=new Map();for(const s of all){const n=(counts.get(s.agent_run_id)??0)+1;counts.set(s.agent_run_id,n);if(n>AGENT_WEBHOOK_LIMITS.perRun)corrupt();validate(s);}if(db.prepare('SELECT 1 FROM agent_webhook_deliveries d LEFT JOIN agent_webhooks s USING(subscription_id) WHERE s.subscription_id IS NULL LIMIT 1').get())corrupt();}
 };
}
